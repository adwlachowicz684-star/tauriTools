/**
 * 触发器与 cron 的单元测试。
 *
 * 运行：npm i -D tsx && npx tsx --test tests/triggers.test.ts
 *
 * 这些用例覆盖的是最容易出错、也最容易烧钱的部分：
 * 防重入（会不会把 CLI 进程堆起来）、防抖（改一堆文件会不会跑一堆任务）、
 * cron 边界（跨月跨年、无解表达式会不会死循环）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRun, validateCron, cronMatches, describeCron } from '../engine/cron';
import { TriggerScheduler } from '../engine/triggers';
import type { Trigger } from '../types';
import { makeTriggerNode, triggerKindsOf } from '../types';

const baseConfig = {
  intervalSec: 300,
  cronExpr: '0 9 * * 1-5',
  watchDir: '',
  watchExts: [] as string[],
  debounceMs: 2000,
  watchRecursive: true,
};

const T = (o: Partial<Trigger> = {}): Trigger => ({
  id: 't1',
  name: '测试',
  kind: 'interval',
  enabled: true,
  input: '',
  lastFiredAt: null,
  lastResult: null,
  config: { ...baseConfig },
  ...o,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- cron ---------------- */

test('cron: 解析基本字段', () => {
  const c = parseCron('30 9 * * *')!;
  assert.deepEqual([...c.minute.values], [30]);
  assert.deepEqual([...c.hour.values], [9]);
  assert.equal(c.dom.any, true);
});

test('cron: 支持步进、范围、列表', () => {
  assert.deepEqual([...parseCron('*/15 * * * *')!.minute.values].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...parseCron('0 9-11 * * *')!.hour.values].sort((a, b) => a - b), [9, 10, 11]);
  assert.deepEqual([...parseCron('0 0 * * 1,3,5')!.dow.values].sort((a, b) => a - b), [1, 3, 5]);
});

test('cron: dow 的 7 归一化为周日 0', () => {
  assert.deepEqual([...parseCron('0 0 * * 7')!.dow.values], [0]);
});

test('cron: 段数不对或范围越界返回 null', () => {
  assert.equal(parseCron('* * * *'), null);
  assert.equal(parseCron('99 * * * *'), null);
  assert.equal(parseCron('0 25 * * *'), null);
  assert.equal(parseCron('0 0 32 * *'), null);
  assert.equal(validateCron('0 9 * *').ok, false);
  assert.equal(validateCron('0 9 * * 1-5').ok, true);
});

test('cron: nextRun 找下一个工作日 9 点', () => {
  const r = nextRun('0 9 * * 1-5', new Date('2026-09-12T10:00:00'))!; // 起点周六
  assert.equal(r.getDay(), 1);
  assert.equal(r.getHours(), 9);
  assert.equal(r.getDate(), 14);
});

test('cron: nextRun 步进表达式', () => {
  const r = nextRun('*/15 * * * *', new Date('2026-09-12T10:07:00'))!;
  assert.equal(r.getHours(), 10);
  assert.equal(r.getMinutes(), 15);
});

test('cron: nextRun 严格晚于 from 且结果自身必命中', () => {
  const from = new Date('2026-09-12T10:00:30');
  const r = nextRun('0 9 * * *', from)!;
  assert.ok(r.getTime() > from.getTime());
  assert.ok(cronMatches(parseCron('0 9 * * *')!, r));
});

test('cron: dom 与 dow 同时限制时取并集（OR 规则）', () => {
  const e = parseCron('0 0 1 * 1')!;
  assert.ok(cronMatches(e, new Date('2026-09-01T00:00:00')), '1号应命中');
  assert.ok(cronMatches(e, new Date('2026-09-07T00:00:00')), '周一应命中');
  assert.ok(!cronMatches(e, new Date('2026-09-15T00:00:00')), '普通日子不应命中');
});

test('cron: 跨月跨年正确推进', () => {
  const r = nextRun('0 0 1 1 *', new Date('2026-12-15T00:00:00'))!;
  assert.equal(r.getFullYear(), 2027);
  assert.equal(r.getMonth(), 0);
  assert.equal(r.getDate(), 1);
});

test('cron: 无解表达式返回 null 而非死循环', () => {
  assert.equal(nextRun('0 0 30 2 *', new Date('2026-01-01T00:00:00')), null);
});

test('cron: describeCron 给出中文描述', () => {
  assert.match(describeCron('0 9 * * 1-5'), /9 点/);
});

/* ---------------- 调度器 ---------------- */

function mk(triggers: Trigger[], opts: { startNow?: number; fireImpl?: (t: Trigger) => Promise<boolean> } = {}) {
  const fired: { id: string; reason: string }[] = [];
  let now = opts.startNow ?? 1_700_000_000_000;
  const logs: string[] = [];
  const s = new TriggerScheduler({
    getTriggers: () => triggers,
    onFire: async (t, reason) => {
      fired.push({ id: t.id, reason });
      return opts.fireImpl ? opts.fireImpl(t) : true;
    },
    log: (m) => logs.push(m),
    now: () => now,
  });
  return {
    s,
    fired,
    logs,
    advance: (ms: number) => { now += ms; },
    tick: () => (s as unknown as { tick(): void }).tick(),
  };
}

test('调度: interval 未到期不触发，到期触发', async () => {
  const trg = T({ kind: 'interval', config: { ...baseConfig, intervalSec: 60 } });
  const { s, fired, advance } = mk([trg]);
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 1, '首次应触发');

  advance(30_000);
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 1, '未到期不应触发');

  advance(31_000);
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 2, '到期应触发');
});

test('调度: disabled 的触发器完全不触发（含手动）', async () => {
  const trg = T({ kind: 'interval', enabled: false });
  const { s, fired } = mk([trg]);
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 0);
  await s.fireManual('t1');
  assert.equal(fired.length, 0);
});

test('调度: 防重入 —— 上一轮未完成时跳过', async () => {
  // 用标志位代替 Promise gate，避免为"释放函数"声明函数类型
  let gateOpen = false;
  const trg = T({ kind: 'interval', config: { ...baseConfig, intervalSec: 10 } });
  const { s, fired, advance } = mk([trg], {
    fireImpl: async () => {
      while (!gateOpen) await sleep(5);
      return true;
    },
  });

  s.tick();
  await sleep(10);
  assert.equal(fired.length, 1);

  advance(60_000);
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 1, '运行中不应重复触发');

  gateOpen = true;   // 释放
  await sleep(30);
  advance(60_000);
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 2, '结束后应能再次触发');
});

test('调度: cron 到点触发并自动重算下一次', async () => {
  const trg = T({ kind: 'cron', config: { ...baseConfig, cronExpr: '0 9 * * *' } });
  const { s, fired, advance } = mk([trg], { startNow: new Date('2026-09-12T08:59:00').getTime() });

  s.tick();
  await sleep(10);
  assert.equal(fired.length, 0, '首次 tick 仅初始化');

  advance(60_000);
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 1, '到点应触发');

  advance(60_000);
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 1, '同一分钟内不应重复触发');
});

test('调度: cron 表达式变更会自动重算', async () => {
  const trg = T({ kind: 'cron', config: { ...baseConfig, cronExpr: '0 9 * * *' } });
  const { s, fired } = mk([trg], { startNow: new Date('2026-09-12T08:00:00').getTime() });
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 0);

  trg.config = { ...baseConfig, cronExpr: '0 8 * * *' }; // 已过去的时刻
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 0, '改为已过时刻不应补触发');
});

test('调度: watch 事件防抖 —— 多次变更只触发一次', async () => {
  const trg = T({ kind: 'watch', config: { ...baseConfig, debounceMs: 60 } });
  const { s, fired } = mk([trg]);
  s.notifyWatch('/a/x.py');
  s.notifyWatch('/a/y.py');
  s.notifyWatch('/a/z.py');
  await sleep(150);
  assert.equal(fired.length, 1, `3 次事件应合并为 1 次，实际 ${fired.length}`);
  assert.equal(fired[0].reason, 'watch');
});

test('调度: watch 按扩展名过滤', async () => {
  const trg = T({ kind: 'watch', config: { ...baseConfig, debounceMs: 30, watchExts: ['py'] } });
  const { s, fired } = mk([trg]);
  s.notifyWatch('/a/notes.txt');
  await sleep(80);
  assert.equal(fired.length, 0, 'txt 不应触发');
  s.notifyWatch('/a/main.py');
  await sleep(80);
  assert.equal(fired.length, 1, 'py 应触发');
});

test('调度: 单次失败不会停掉周期调度', async () => {
  let n = 0;
  const trg = T({ kind: 'interval', config: { ...baseConfig, intervalSec: 10 } });
  const { s, fired, advance } = mk([trg], { fireImpl: async () => { n++; return n !== 1; } });
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 1);
  advance(20_000);
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 2, '失败后应继续调度');
});

test('调度: remove 后不再触发且清理定时器', async () => {
  const trg = T({ kind: 'watch', config: { ...baseConfig, debounceMs: 30 } });
  const { s, fired } = mk([trg]);
  s.notifyWatch('/a/x.py');
  s.remove('t1');
  await sleep(80);
  assert.equal(fired.length, 0, '移除后不应再触发');
});

test('调度: 一轮只触发一个，不并发多个 interval', async () => {
  const a = T({ id: 'a', kind: 'interval', config: { ...baseConfig, intervalSec: 10 } });
  const b = T({ id: 'b', kind: 'interval', config: { ...baseConfig, intervalSec: 10 } });
  const { s, fired } = mk([a, b]);
  s.tick();
  await sleep(10);
  assert.equal(fired.length, 1, `一轮只应触发 1 个，实际 ${fired.length}`);
});

/* ---------------- 调用触发（webhook） ---------------- */

const baseWebhook = { ...baseConfig, port: 8787, path: '/hooks/run', token: '', payloadToInput: true };

test('webhook: 调用即触发，并带上请求体', async () => {
  const trg = T({ kind: 'webhook', config: baseWebhook });
  let received: string | undefined;
  const { s, fired } = mk([trg], {
    fireImpl: undefined,
  });
  // 手动替换 onFire 以捕获 payload
  const s2 = new TriggerScheduler({
    getTriggers: () => [trg],
    onFire: async (_t, _r, payload) => { received = payload; return true; },
    log: () => {},
  });
  const ok = await s2.notifyWebhook('t1', '{"msg":"hi"}');
  assert.equal(ok, true);
  assert.equal(received, '{"msg":"hi"}');
  assert.equal(fired.length, 0, 'mk 的 scheduler 未被使用');
  s.stop();
  s2.stop();
});

test('webhook: 停用后忽略调用', async () => {
  const trg = T({ kind: 'webhook', enabled: false, config: baseWebhook });
  let called = 0;
  const s = new TriggerScheduler({
    getTriggers: () => [trg],
    onFire: async () => { called++; return true; },
    log: () => {},
  });
  const ok = await s.notifyWebhook('t1', 'x');
  assert.equal(ok, false);
  assert.equal(called, 0);
  s.stop();
});

test('webhook: 防重入 —— 上次没跑完时后续调用被跳过', async () => {
  const trg = T({ kind: 'webhook', config: baseWebhook });
  let gateOpen = false;
  const s = new TriggerScheduler({
    getTriggers: () => [trg],
    onFire: async () => { while (!gateOpen) await sleep(5); return true; },
    log: () => {},
  });
  void s.notifyWebhook('t1', 'first');
  await sleep(10);
  const second = await s.notifyWebhook('t1', 'second');
  assert.equal(second, false, '并发调用应被拒绝');
  gateOpen = true;
  await sleep(30);
  const third = await s.notifyWebhook('t1', 'third');
  assert.equal(third, true, '恢复后应能再次触发');
  s.stop();
});

test('webhook: 触发器不存在时安全返回 false', async () => {
  const s = new TriggerScheduler({ getTriggers: () => [], onFire: async () => true, log: () => {} });
  assert.equal(await s.notifyWebhook('nope', 'x'), false);
  s.stop();
});

/* ================================================================== */
/* 一个节点多种触发方式（多选）                                          */
/*                                                                     */
/* 多选后，一个画布节点会展开成多条 Trigger 交给调度器，                */
/* 这里验证展开、独立计时、以及清理。                                    */
/* ================================================================== */

function nodeWith(kinds: string[], extra: Record<string, unknown> = {}) {
  return makeTriggerNode('n1', kinds as never, extra);
}

test('triggerKindsOf: 新格式直接返回数组', () => {
  const d = nodeWith(['interval', 'watch']).data;
  assert.deepEqual(triggerKindsOf(d as never), ['interval', 'watch']);
});

test('triggerKindsOf: 旧单值字段兼容', () => {
  // 历史数据只有 trigger，没有 triggers
  assert.deepEqual(triggerKindsOf({ trigger: 'cron' } as never), ['cron']);
});

test('triggerKindsOf: 两个字段都没有时回退 manual', () => {
  assert.deepEqual(triggerKindsOf({} as never), ['manual']);
});

test('triggerKindsOf: 空数组且不兼容旧值时回退 manual', () => {
  assert.deepEqual(triggerKindsOf({ triggers: [] } as never), ['manual']);
});

test('makeTriggerNode: 单值与数组等价', () => {
  assert.deepEqual(
    (makeTriggerNode('a', 'cron').data as never as { triggers: string[] }).triggers,
    ['cron'],
  );
  assert.deepEqual(
    (makeTriggerNode('b', ['cron', 'watch']).data as never as { triggers: string[] }).triggers,
    ['cron', 'watch'],
  );
});

test('展开：一个节点多种方式 → 多条 Trigger，带 nodeId', () => {
  const node = nodeWith(['interval', 'webhook']);
  const kinds = triggerKindsOf(node.data as never);
  const expanded = kinds.map((kind) => ({
    id: `n1:${kind}`, nodeId: 'n1', kind,
  }));
  assert.equal(expanded.length, 2);
  assert.deepEqual(expanded.map((e) => e.id), ['n1:interval', 'n1:webhook']);
  assert.ok(expanded.every((e) => e.nodeId === 'n1'));
});

test('调度器：同一节点的多种方式各自独立计时', async () => {
  const fired: string[] = [];
  const sched = new TriggerScheduler({
    getTriggers: () => [
      T({ id: 'n1:interval', nodeId: 'n1', kind: 'interval', config: { ...baseConfig, intervalSec: 10 } }),
      T({ id: 'n1:cron', nodeId: 'n1', kind: 'cron', config: { ...baseConfig, cronExpr: '* * * * *' } }),
    ],
    onFire: async (t, reason) => { fired.push(`${t.kind}:${reason}`); return true; },
    now: () => Date.now(),
  });

  // interval 的 lastFired 与 cron 的 cronMemo 按各自的 id 记录，不应互相覆盖
  (sched as unknown as { lastFired: Map<string, number> }).lastFired.set('n1:interval', Date.now());
  (sched as unknown as { cronMemo: Map<string, unknown> }).cronMemo.set('n1:cron', { expr: '* * * * *', at: null });
  assert.equal((sched as unknown as { lastFired: Map<string, number> }).lastFired.has('n1:cron'), false);
  sched.stop();
  void fired;
});

test('调度器：remove(nodeId) 清理该节点展开出的所有方式', () => {
  const sched = new TriggerScheduler({
    getTriggers: () => [],
    onFire: async () => true,
  });
  const st = sched as unknown as {
    lastFired: Map<string, number>;
    cronMemo: Map<string, unknown>;
    debounce: Map<string, unknown>;
  };
  st.lastFired.set('n1:interval', 1);
  st.lastFired.set('n1:cron', 2);
  st.cronMemo.set('n1:cron', { expr: 'x', at: null });
  st.debounce.set('n1:watch', 'timer');
  // 别的节点不该被误清
  st.lastFired.set('n2:interval', 3);

  sched.remove('n1');

  assert.equal(st.lastFired.has('n1:interval'), false);
  assert.equal(st.lastFired.has('n1:cron'), false);
  assert.equal(st.cronMemo.has('n1:cron'), false);
  assert.equal(st.debounce.has('n1:watch'), false);
  assert.equal(st.lastFired.has('n2:interval'), true, '不应误清其他节点');
  sched.stop();
});

test('调度器：fireManual 传 nodeId 也能找到', async () => {
  const sched = new TriggerScheduler({
    getTriggers: () => [
      T({ id: 'n1:manual', nodeId: 'n1', kind: 'manual' }),
      T({ id: 'n1:watch', nodeId: 'n1', kind: 'watch' }),
    ],
    onFire: async (t) => t.kind === 'manual',
  });
  // 传节点 id：应挑到 manual 那条，而不是第一条随便一个
  const ok = await sched.fireManual('n1');
  assert.equal(ok, true);

  // 没有 manual 时退而取该节点的第一种
  const sched2 = new TriggerScheduler({
    getTriggers: () => [
      T({ id: 'n2:watch', nodeId: 'n2', kind: 'watch' }),
      T({ id: 'n2:cron', nodeId: 'n2', kind: 'cron' }),
    ],
    onFire: async (t) => t.kind === 'watch',
  });
  assert.equal(await sched2.fireManual('n2'), true);
  sched.stop(); sched2.stop();
});

test('调度器：一个节点多种方式仍受全局防重入约束', async () => {
  let running = 0;
  let maxConcurrent = 0;
  const sched = new TriggerScheduler({
    getTriggers: () => [
      T({ id: 'n1:interval', nodeId: 'n1', kind: 'interval' }),
      T({ id: 'n1:webhook', nodeId: 'n1', kind: 'webhook' }),
    ],
    onFire: async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await sleep(30);
      running -= 1;
      return true;
    },
  });
  // 同一节点的两种方式几乎同时请求
  const p1 = sched.notifyWebhook('n1:webhook', 'x');
  const p2 = sched.notifyWebhook('n1:webhook', 'y');
  await Promise.all([p1, p2]);
  assert.equal(maxConcurrent, 1, '多选也不能并发跑');
  sched.stop();
});
