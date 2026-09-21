import test from 'node:test';
import assert from 'node:assert/strict';
import {
  triggerEntriesOf, addTriggerEntry, removeTriggerEntry,
  patchEntryConfig, patchTriggerEntry, mergeConfig, entryEnabled,
} from '../engine/triggerEntries';
import type { TriggerConfig, TriggerEntry } from '../types';

/**
 * 触发条件卡片。
 *
 * ================= 起因 ====================
 *
 * 老结构是「一份共享 config + 一个 kind 数组」：
 *   1. 改「周期」的秒数会顺带改到别的触发方式也在读的字段
 *   2. 界面上是一组勾选框 + 一堆"选中才显示"的字段，
 *      看不出这个节点到底配了几个条件
 *
 * 现在每种方式是一张独立的卡，各带自己的 config。
 */

const BASE = { intervalSec: 300, cronExpr: '0 9 * * 1-5' } as unknown as TriggerConfig;

test('老存档（只有 triggers）读出来是卡片', () => {
  const es = triggerEntriesOf({ triggers: ['cron', 'watch'], config: BASE });
  assert.deepEqual(es.map((e) => e.kind), ['cron', 'watch']);
  // 迁移不写回 —— 等用户真的改了才落盘，免得打开一次改一遍存档
  assert.ok(es.every((e) => e.enabled === true));
});

test('旧的单值 trigger 字段也认', () => {
  assert.deepEqual(triggerEntriesOf({ trigger: 'manual' }).map((e) => e.kind), ['manual']);
});

test('脏数据不会带出 undefined 的卡', () => {
  /*
   * 老存档里存过 [null]（真 bug，已修）：数组长度是 1 却没有可用项。
   * 不逐项校验的话界面会拿 undefined 去查表然后整棵崩。
   */
  assert.deepEqual(triggerEntriesOf({ triggers: [null] }), []);
  assert.deepEqual(triggerEntriesOf({ triggers: ['nope'] }), []);
  assert.deepEqual(triggerEntriesOf({}), []);
});

test('条目缺 id 的丢弃 —— 否则两张卡的 key 都是空', () => {
  const es = triggerEntriesOf({
    entries: [{ id: '', kind: 'cron' }, { id: 'a', kind: 'watch' }] as never,
  });
  assert.equal(es.length, 1);
  assert.equal(es[0].id, 'a');
});

test('同一 kind 可以配多张卡（id 不同）', () => {
  let es: TriggerEntry[] = [
    { id: 'a', kind: 'webhook', config: { port: 8787 } },
    { id: 'b', kind: 'webhook', config: { port: 9090 } },
  ];
  assert.equal(triggerEntriesOf({ entries: es }).length, 2);
  es = addTriggerEntry(es, 'webhook', 'c');
  assert.equal(es.length, 3, 'id 不同就不该被合并');
});

test('改一张卡不影响另一张', () => {
  let es: TriggerEntry[] = [
    { id: 'a', kind: 'interval', config: {} },
    { id: 'b', kind: 'interval', config: {} },
  ];
  es = patchEntryConfig(es, 'a', { intervalSec: 60 } as Partial<TriggerConfig>);
  assert.equal(es[0].config?.intervalSec, 60);
  assert.equal(es[1].config?.intervalSec, undefined, '另一张不该被带过去');
});

test('卡片配置只覆盖自己关心的字段，其余用节点默认', () => {
  const e: TriggerEntry = { id: 'a', kind: 'cron', config: { cronExpr: '0 3 * * *' } };
  const merged = mergeConfig(BASE, e.config);
  assert.equal(merged.cronExpr, '0 3 * * *', '卡片自己的优先');
  assert.equal(merged.intervalSec, 300, '没覆盖的用默认');
});

test('删除只删指定那张', () => {
  const es: TriggerEntry[] = [
    { id: 'a', kind: 'cron' }, { id: 'b', kind: 'watch' },
  ];
  assert.deepEqual(removeTriggerEntry(es, 'a').map((e) => e.id), ['b']);
});

test('单张卡停用不影响其它卡', () => {
  const es = patchTriggerEntry(
    [{ id: 'a', kind: 'cron' }, { id: 'b', kind: 'watch' }],
    'a',
    { enabled: false },
  );
  assert.equal(entryEnabled(es[0]), false);
  assert.equal(entryEnabled(es[1]), true);
});

test('没有 enabled 字段的老条目一律当开', () => {
  assert.equal(entryEnabled({ id: 'a', kind: 'cron' }), true);
});
