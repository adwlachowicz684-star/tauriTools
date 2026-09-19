import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerKindsOf, makeTriggerNode, TRIGGER_META } from '../types';

/**
 * triggerKindsOf 必须**逐项校验**。
 *
 * 起因：把触发器拖进画布后，画布整个消失了。
 *
 * 链条：
 *   nodes/defs/trigger.ts 的 create 写成 makeTriggerNode(id, partial)，
 *   而 makeTriggerNode 的签名是 (id, **triggers**, partial) ——
 *   第二个参数是触发方式，不是数据补丁。
 *   调用方一律是 create(id)，于是 triggers = [undefined]，
 *   落盘后变成 [null]。
 *
 *   而 triggerKindsOf 只判 `Array.isArray(raw) && raw.length > 0`
 *   就原样返回 —— 于是 selected = [null]。
 *   属性面板第 105 行 `TRIGGER_META[selected[0]].hint`
 *   当场抛 TypeError，整棵 React 树崩掉。
 */

const LEGIT = Object.keys(TRIGGER_META);

test('正常的多选', () => {
  assert.deepEqual(triggerKindsOf({ triggers: ['manual', 'cron'] }), ['manual', 'cron']);
});

test('triggers 里是 undefined → 退回 manual（不是原样返回）', () => {
  const r = triggerKindsOf({ triggers: [undefined] } as never);
  assert.deepEqual(r, ['manual']);
});

test('triggers 里是 null（落盘后的形态）→ 退回 manual', () => {
  const r = triggerKindsOf({ triggers: [null] } as never);
  assert.deepEqual(r, ['manual']);
});

test('triggers 里是整个数据对象 → 退回 manual', () => {
  const r = triggerKindsOf({ triggers: [{ label: 'x' }] } as never);
  assert.deepEqual(r, ['manual']);
});

test('混杂时保留认识的那几项', () => {
  const r = triggerKindsOf({ triggers: [undefined, 'cron', '瞎写'] } as never);
  assert.deepEqual(r, ['cron']);
});

test('认识的项全在 TRIGGER_META 里（不然过滤会误杀）', () => {
  assert.ok(LEGIT.length > 0);
  for (const k of LEGIT) {
    assert.deepEqual(triggerKindsOf({ triggers: [k] } as never), [k]);
  }
});

test('空数组 → manual', () => {
  assert.deepEqual(triggerKindsOf({ triggers: [] }), ['manual']);
});

test('旧的单值字段仍兼容', () => {
  assert.deepEqual(triggerKindsOf({ trigger: 'watch' } as never), ['watch']);
});

test('旧单值是非法值 → manual，不外泄', () => {
  assert.deepEqual(triggerKindsOf({ trigger: '瞎写' } as never), ['manual']);
  assert.deepEqual(triggerKindsOf({ trigger: null } as never), ['manual']);
});

test('什么都没有 → manual', () => {
  assert.deepEqual(triggerKindsOf({}), ['manual']);
});

/* ---------------- create 的入口 ---------------- */

test('create(id) 建出来的节点触发方式是 manual（不是 [undefined]）', () => {
  /*
   * 这是"拖入触发器就崩"的直接入口 ——
   * 不传补丁时也必须得到合法的 triggers。
   */
  const n = makeTriggerNode('t1', ['manual']);
  const kinds = triggerKindsOf(n.data as never);
  assert.deepEqual(kinds, ['manual']);
  assert.ok(
    kinds.every((k) => typeof k === 'string' && k in TRIGGER_META),
    'triggers 里不能有非字符串',
  );
});

test('面板取 hint 的那条路径不会抛错', () => {
  /*
   * 复现崩溃现场：TRIGGER_META[selected[0]].hint
   * selected[0] 必须是合法 key，否则 TypeError。
   */
  const d = makeTriggerNode('t1', ['manual']).data as never;
  const selected = triggerKindsOf(d);
  assert.doesNotThrow(() => TRIGGER_META[selected[0]].hint);
});
