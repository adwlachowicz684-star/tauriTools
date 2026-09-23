import test from 'node:test';
import assert from 'node:assert/strict';
import type { Graph, GraphNode } from '../types';
import { runGraph } from '../engine/runner';
import {
  timeoutMsOf, nodeTimeoutMsOf, timeoutMessageOf, TIMEOUT_FIELD, NO_TIMEOUT,
} from '../engine/nodeTimeout';

/**
 * 单节点执行超时。
 *
 * 动机：以前只有整条流程的 AbortSignal。一个节点卡住时整条流程悬停，
 * 而界面上**看不出是哪一个卡住** —— 没开跑的都是"等待"，
 * 正在跑的那个也还是"进行中"。
 *
 * 本文件的重点是超时之后**不留下矛盾状态**：
 * 底层操作没有被杀掉（Promise 无法外部取消），它跑完还会写回状态。
 * 不处理就是"先报失败、过会儿又变成功"，而下游此时已经按失败跳过了。
 */

/*
 * 选值上有个坑，记在这里免得再踩：
 *
 * task 节点跑完还要 `await sleep(50)`（见 engine/runners/task.ts），
 * 所以**它最快也要 50ms 才 resolve**。凡是要验证"正常跑完"的用例，
 * 超时必须给到 0.1s 以上，否则会在它 sleep 期间误判成超时 ——
 * 表现为"明明跑完了却报超时"，极易被误读成引擎有 bug。
 *
 * 因此下面凡是要正常完成的用例一律用 text 节点（不带 sleep，立即返回）；
 * 只有需要"卡住"的用例才用 task 节点配一个永不 resolve 的 executor。
 */

const N = (id: string, kind: string, data: Record<string, unknown> = {}): GraphNode =>
  ({ id, data: { kind, ...data } }) as unknown as GraphNode;

/** 收集一次运行里每个节点的最终状态 */
async function run(
  g: Graph,
  opts: { nodeTimeoutSec?: number; executor?: (n: GraphNode) => Promise<string> } = {},
) {
  const done = new Map<string, { ok: boolean; error?: string }>();
  const r = await runGraph(g, {
    onEvent: (e) => {
      if (e.type === 'node-done') done.set(e.id, { ok: e.ok, error: e.error });
    },
    nodeTimeoutSec: opts.nodeTimeoutSec,
    executor: (opts.executor ?? (async () => 'ok')) as never,
  });
  return { r, done };
}

/** 永不返回的 executor —— 模拟卡住的那一步 */
const hang = () => new Promise<string>(() => { /* 故意不 resolve */ });

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

test('非法超时值按"不限时"，而不是让流程跑不起来', () => {
  /*
   * 节点数据是手填的。填个 "abc" 就让整条流程报错太粗暴：
   * 按不限时只损失这一个节点的保护，行为与加这个功能之前一致。
   */
  assert.equal(timeoutMsOf('abc'), NO_TIMEOUT);
  assert.equal(timeoutMsOf(-5), NO_TIMEOUT);
  assert.equal(timeoutMsOf(undefined), NO_TIMEOUT);
  assert.equal(timeoutMsOf(0), NO_TIMEOUT);
  assert.equal(timeoutMsOf(1.5), 1500);
});

test('节点级能覆盖全局，且能覆盖成"不限时"', () => {
  /*
   * 只认 > 0 的覆盖值的话，"全局 60 秒、这个节点就是要等 10 分钟"
   * 就表达不出来 —— 用户只能把全局调大，等于全局保护失效。
   */
  assert.equal(nodeTimeoutMsOf({ [TIMEOUT_FIELD]: 30 }, 60), 30_000, '节点级优先');
  assert.equal(nodeTimeoutMsOf({ [TIMEOUT_FIELD]: 0 }, 60), NO_TIMEOUT, '能覆盖成不限时');
  assert.equal(nodeTimeoutMsOf({}, 60), 60_000, '没配就用全局');
  assert.equal(nodeTimeoutMsOf({ [TIMEOUT_FIELD]: 'x' }, 60), 60_000, '非法值回落全局');
});

test('超时文案带秒数 —— 否则用户不知道该去调哪个值', () => {
  assert.match(timeoutMessageOf(30_000), /30s/);
});

/* ------------------------------------------------------------------ */
/* 行为                                                                */
/* ------------------------------------------------------------------ */

test('卡住的节点到点判失败，并写明是超时', async () => {
  const g: Graph = {
    nodes: [N('a', 'task', { prompt: 'x', [TIMEOUT_FIELD]: 0.02 })],
    edges: [],
  };
  const { r, done } = await run(g, { executor: hang });
  assert.equal(r.ok, false, '整条流程算失败');
  assert.deepEqual([...r.failed], ['a']);
  const a = done.get('a');
  assert.equal(a?.ok, false);
  assert.match(a?.error ?? '', /执行超时/, '要写明是超时，不然和别的失败分不开');
});

test('默认不限时 —— 加这个功能不能改变既有流程的行为', async () => {
  /*
   * 这是最重要的一条：没配 timeoutSec 就完全不该有定时器参与。
   * 否则所有老流程都可能在某些慢节点上被误杀。
   */
  const g: Graph = { nodes: [N('a', 'task', { prompt: 'x' })], edges: [] };
  const { r, done } = await run(g, { nodeTimeoutSec: 0.02, executor: () => hang() });
  assert.equal(r.ok, false, '全局 0.02 秒生效，这个节点确实超时了');

  const g2: Graph = { nodes: [N('a', 'task', { prompt: 'x' })], edges: [] };
  const r2 = await run(g2, { executor: async () => 'ok' });
  assert.equal(r2.r.ok, true, '不设全局超时时照常跑完');
  assert.equal(r2.done.get('a')?.ok, true);
});

test('超时会传播：下游跳过，不会拿空值继续跑', async () => {
  /*
   * 只标红而不传播的话，下游会拿着空值继续跑，
   * 于是超时那一步的错误被冲淡成一堆看不懂的空结果 ——
   * 排查时根本看不出根因是超时。
   */
  const g: Graph = {
    nodes: [
      N('a', 'task', { prompt: 'x', [TIMEOUT_FIELD]: 0.02 }),
      N('b', 'text', { op: 'upper', a: 'zz', b: '' }),
    ],
    edges: [{ id: 'a->b', source: 'a', target: 'b' }],
  };
  const { r } = await run(g, { executor: hang });
  assert.ok(r.skipped.includes('b'), '下游要被跳过');
  assert.ok(!r.failed.includes('b'), '跳过不是失败，不该记两遍');
});

test('超时后底层跑完也不能把状态改回成功', async () => {
  /*
   * 这是软超时最关键的一条。
   *
   * 底层操作**没有被杀掉**。它在这条用例里会在超时之后才 resolve，
   * 然后照常 emit node-done(ok:true) —— 不拦住就会出现
   * "日志里先是失败、过一会儿又变成功"，而下游此时已经跳过了。
   */
  let release: (v: string) => void = () => {};
  const late = new Promise<string>((res) => { release = res; });

  const g: Graph = {
    nodes: [N('a', 'task', { prompt: 'x', [TIMEOUT_FIELD]: 0.02 })],
    edges: [],
  };
  const seen: boolean[] = [];
  const r = await runGraph(g, {
    onEvent: (e) => { if (e.type === 'node-done') seen.push(e.ok); },
    executor: (() => late) as never,
  });

  assert.equal(seen.length, 1, '超时那一刻已经上报过一次');
  assert.equal(seen[0], false);

  /* 底层这才跑完 —— 它的回写必须被作废 */
  release('终于跑完了');
  /* 要盖过 task 节点自带的 sleep(50)，30ms 不够 */
  await new Promise((res) => setTimeout(res, 150));

  assert.equal(seen.length, 1, '迟到的成功不得再上报一次');
  assert.equal(r.ok, false);
});

test('超时后底层抛异常不会变成 unhandled rejection', async () => {
  /*
   * race 之后我们不再 await 那个 promise。它若在此后 reject 而没人接，
   * 就是 unhandled rejection —— 在 Node 里会直接把测试进程搞挂。
   * 这条用例能跑完本身就说明挂上了 catch。
   */
  let rejectLater: (e: Error) => void = () => {};
  const bad = new Promise<string>((_, rej) => { rejectLater = rej; });

  const g: Graph = {
    nodes: [N('a', 'task', { prompt: 'x', [TIMEOUT_FIELD]: 0.02 })],
    edges: [],
  };
  const r = await runGraph(g, { onEvent: () => {}, executor: (() => bad) as never });
  assert.equal(r.ok, false);

  rejectLater(new Error('迟到很久的失败'));
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(r.ok, false, '迟到的失败不得改变已判定的结果');
});

/*
 * 定时器清理这条**测不到行为**，只能守住代码不退化。
 *
 * 为什么测不到：race 一旦被 work 抢先，超时分支那几行根本不会执行 ——
 * 定时器到点只是 resolve 了一个没人再监听的 promise，不会产生额外事件。
 * 所以"不清定时器"在这里的后果只有"进程退出被拖住"，
 * 而那在单元测试里既不可观测、也不该靠 sleep 去猜。
 *
 * 于是改成源码守卫：至少保证将来有人动这段代码时，
 * 那行 clearTimeout 不会无声消失。
 */
import { readSrc, stripComments } from './srcScan';

test('守卫：超时定时器必须被清掉（源码级）', () => {
  const src = stripComments(readSrc('engine/runner.ts'));
  assert.match(src, /clearTimeout\s*\(\s*timer\s*\)/, 'finally 里要有 clearTimeout(timer)');
});

test('跑得快的节点不受超时影响', async () => {
  const g: Graph = {
    nodes: [N('a', 'text', { op: 'upper', a: 'zz', b: '', [TIMEOUT_FIELD]: 5 })],
    edges: [],
  };
  const { r, done } = await run(g);
  assert.equal(r.ok, true);
  assert.equal(done.get('a')?.ok, true);
});
