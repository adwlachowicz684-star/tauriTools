import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectGlobalTriggers, splitByScope, activeTriggers, backgroundOf,
  defaultBackground, triggerKindsOf, dedupeWatchDirs, describeRegistry,
} from '../engine/triggerRegistry';

const CFG = {} as never;

const trig = (label: string, extra: Record<string, unknown> = {}) => ({
  id: label, data: { kind: 'trigger', label, enabled: true, triggers: ['interval'], config: {}, ...extra },
});

const canvas = (id: string, nodes: unknown[], name = id) => ({ id, name, nodes: nodes as never });

/* ================= 默认开关 ================= */

test('后台监听默认是开着的', () => {
  assert.equal(defaultBackground(), true);
  assert.equal(backgroundOf({}), true);
});

test('显式关掉就是关', () => {
  assert.equal(backgroundOf({ background: false }), false);
});

/** 表单件可能传字符串过来 */
test('字符串 false 也算关', () => {
  assert.equal(backgroundOf({ background: 'false' }), false);
  assert.equal(backgroundOf({ background: 'true' }), true);
});

/* ================= 兼容旧字段 ================= */

test('旧的单值 trigger 字段也能读出来', () => {
  assert.deepEqual(triggerKindsOf({ trigger: 'cron' }), ['cron']);
});

test('多选字段优先', () => {
  assert.deepEqual(triggerKindsOf({ trigger: 'cron', triggers: ['interval', 'watch'] }), ['interval', 'watch']);
});

test('都没有时返回空', () => {
  assert.deepEqual(triggerKindsOf({}), []);
});

/* ================= 收集 ================= */

test('扫描所有画布的触发器', () => {
  const out = collectGlobalTriggers([
    canvas('c1', [trig('t1')]),
    canvas('c2', [trig('t2')]),
  ], CFG);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((t) => t.canvasId), ['c1', 'c2']);
});

/**
 * id 必须带画布 id ——
 * 两张画布里各有一个同名节点，只用 nodeId 会撞车，
 * 表现为"触发了但跑的是另一张画布"。
 */
test('id 带画布前缀，跨画布不撞车', () => {
  const out = collectGlobalTriggers([
    canvas('c1', [{ id: 't1', data: { kind: 'trigger', label: 'a', triggers: ['interval'], config: {} } }]),
    canvas('c2', [{ id: 't1', data: { kind: 'trigger', label: 'b', triggers: ['interval'], config: {} } }]),
  ], CFG);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].id, out[1].id);
  assert.ok(out[0].id.startsWith('c1::'));
});

test('节点被禁用时不收集', () => {
  const out = collectGlobalTriggers([canvas('c1', [trig('t1', { enabled: false })])], CFG);
  assert.equal(out.length, 0);
});

test('一个节点挂多种触发方式会展开成多条', () => {
  const out = collectGlobalTriggers([
    canvas('c1', [{ id: 't', data: { kind: 'trigger', label: 'x', triggers: ['interval', 'cron', 'watch'], config: {} } }]),
  ], CFG);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((t) => t.kind).sort(), ['cron', 'interval', 'watch']);
});

test('非触发节点不收集', () => {
  const out = collectGlobalTriggers([canvas('c1', [{ id: 'a', data: { kind: 'task' } }])], CFG);
  assert.equal(out.length, 0);
});

/* ================= 后台 / 前台 ================= */

test('后台的始终接管，不管画布打没打开', () => {
  const all = collectGlobalTriggers([canvas('c1', [trig('t1')])], CFG);
  const s = splitByScope(all, 'c9'); // 激活的是别的画布
  assert.equal(s.background.length, 1);
  assert.equal(s.foreground.length, 0);
});

test('关掉后台后，只有画布激活时才接管', () => {
  const all = collectGlobalTriggers([canvas('c1', [trig('t1', { background: false })])], CFG);
  assert.equal(splitByScope(all, 'c9').foreground.length, 0, '没激活时不该接管');
  assert.equal(splitByScope(all, 'c1').foreground.length, 1, '激活了才接管');
});

test('activeTriggers = 后台 + 激活画布的前台', () => {
  const all = collectGlobalTriggers([
    canvas('c1', [trig('a'), trig('b', { background: false })]),
    canvas('c2', [trig('c', { background: false })]),
  ], CFG);
  const act = activeTriggers(all, 'c1');
  assert.equal(act.length, 2, 'c1 的后台 a + 前台 b');
  assert.equal(activeTriggers(all, 'c2').length, 2, 'c1 的后台 a + c2 的前台 c');
});

/* ================= 去重 ================= */

test('两张画布监听同一目录时只留一个', () => {
  const all = collectGlobalTriggers([
    canvas('c1', [trig('t1', { triggers: ['watch'], config: { watchDir: '/same' } })]),
    canvas('c2', [trig('t2', { triggers: ['watch'], config: { watchDir: '/same' } })]),
  ], CFG);
  assert.equal(all.length, 2);
  assert.equal(dedupeWatchDirs(all).length, 1, '不该改一次文件触发两遍');
});

test('不同目录不去重', () => {
  const all = collectGlobalTriggers([
    canvas('c1', [trig('t1', { triggers: ['watch'], config: { watchDir: '/a' } })]),
    canvas('c2', [trig('t2', { triggers: ['watch'], config: { watchDir: '/b' } })]),
  ], CFG);
  assert.equal(dedupeWatchDirs(all).length, 2);
});

test('非监听类型不参与去重', () => {
  const all = collectGlobalTriggers([
    canvas('c1', [trig('t1', { triggers: ['interval'], config: { intervalSec: 60 } })]),
    canvas('c2', [trig('t2', { triggers: ['interval'], config: { intervalSec: 60 } })]),
  ], CFG);
  assert.equal(dedupeWatchDirs(all).length, 2);
});

/* ================= 摘要 ================= */

test('摘要说清分布与代管数量', () => {
  const all = collectGlobalTriggers([
    canvas('c1', [trig('a')]),
    canvas('c2', [trig('b', { background: false })]),
  ], CFG);
  const s = describeRegistry(all, 'c2');
  assert.ok(s.includes('2 个触发器'));
  assert.ok(s.includes('2 张画布'));
  assert.ok(s.includes('全局代管 1'));
});

test('没有触发器时的文案', () => {
  assert.equal(describeRegistry([], 'c1'), '没有启用的触发器');
});
