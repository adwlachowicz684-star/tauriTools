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
