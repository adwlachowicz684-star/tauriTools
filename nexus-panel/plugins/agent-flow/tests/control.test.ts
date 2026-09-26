import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph, type RunSummary, type RunEvent } from '../engine/runner';
import type { Graph } from '../types';

/**
 * 控制器（闸门 / 限流 / 超时熔断 / 重试）的集成测试。
 *
 * 走 runGraph 而不是只测纯函数 —— 控制器的价值全在"串进流程里
 * 能不能拦住/放行"，单测验证不了失败传播与下游跳过这些接缝。
 */

const node = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  data: { kind, label: id, status: 'idle', output: '', error: '', ...extra },
});
const edge = (s: string, t: string) => ({ id: `${s}->${t}`, source: s, target: t });

const noopExecutor = async () => ({ output: '', ok: true });

async function run(
  nodes: unknown[], edges: unknown[] = [], input = '',
): Promise<{ summary: RunSummary; events: RunEvent[]; order: string[] }> {
  const events: RunEvent[] = [];
  const summary = await runGraph(
    { nodes, edges } as unknown as Graph,
    { concurrency: 1, executor: noopExecutor, input, onEvent: (e) => events.push(e) },
  );
  const order = events.filter((e) => e.type === 'node-done').map((e) => String(e.id));
  return { summary, events, order };
}

/* ================= 闸门 ================= */

test('闸门 · 立即模式：满足条件则透传', async () => {
  const { summary, order } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'hello' }] }),
      node('g', 'gate', { mode: 'now', check: 'contains', value: 'ell' }),
      node('d', 'const', { items: [{ id: 'c0', value: 'D' }] }),
    ],
    [edge('a', 'g'), edge('g', 'd')],
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.outputs.g, 'hello', '输出应原样透传');
  assert.ok(order.includes('d'));
});

test('闸门 · 立即模式：不满足则失败且下游跳过', async () => {
  const { summary, order } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'hello' }] }),
      node('g', 'gate', { mode: 'now', check: 'contains', value: 'zzz' }),
      node('d', 'const', { items: [{ id: 'c0', value: 'D' }] }),
    ],
    [edge('a', 'g'), edge('g', 'd')],
  );
  assert.equal(summary.ok, false);
  assert.ok(summary.failed.includes('g'));
  assert.ok(!order.includes('d'), '下游不该执行');
});

test('闸门 · 比对值没填时报错，而不是一律放行', async () => {
  const { summary } = await run(
    [node('a', 'const', { items: [{ id: 'c0', value: 'x' }] }), node('g', 'gate', { mode: 'now', check: 'contains' })],
    [edge('a', 'g')],
  );
  assert.equal(summary.ok, false, '选了 contains 却没填比对值应失败');
});

test('闸门 · 等待超时后按配置照样放行（带 warn）', async () => {
  const { summary } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'hello' }] }),
      node('g', 'gate', {
        mode: 'wait', check: 'contains', value: 'zzz',
        timeoutMs: 60, pollMs: 50, onTimeout: 'pass',
      }),
    ],
    [edge('a', 'g')],
  );
  assert.equal(summary.ok, true, 'onTimeout=pass 时不应让流程失败');
  assert.equal(summary.outputs.g, 'hello');
});

test('闸门 · 等待超时后按配置中断', async () => {
  const { summary } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'hello' }] }),
      node('g', 'gate', {
        mode: 'wait', check: 'contains', value: 'zzz',
        timeoutMs: 60, pollMs: 50, onTimeout: 'fail',
      }),
    ],
    [edge('a', 'g')],
  );
  assert.equal(summary.ok, false);
});

/* ================= 限流 ================= */

test('限流 · 间隔为 0 时直接放行并透传', async () => {
  const { summary, order } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }),
      node('t', 'throttle', { minIntervalMs: 0 }),
      node('d', 'const', { items: [{ id: 'c0', value: 'D' }] }),
    ],
    [edge('a', 't'), edge('t', 'd')],
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.outputs.t, 'A', '控制器不应改写数据流');
  assert.ok(order.includes('d'));
});

/**
 * 放行上限是**每个限流节点各自计数**，不是全图共享 ——
 * 两个各自上限 1 的节点都能放行一次。
 *
 * 要触发"超限"，得让同一个节点在同一次运行里被进入多次
 * （典型场景：它在循环体里）。这里只确认语义是"按节点计数"。
 */
test('限流 · 放行上限按节点各自计数', async () => {
  const { summary } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }),
      node('t1', 'throttle', { minIntervalMs: 0, maxPerRun: 1 }),
      node('t2', 'throttle', { minIntervalMs: 0, maxPerRun: 1 }),
    ],
    [edge('a', 't1'), edge('a', 't2')],
  );
  assert.equal(summary.ok, true, '各自计数时两个都能放行一次');
  assert.equal(summary.outputs.t1, 'A');
  assert.equal(summary.outputs.t2, 'A');
});

test('限流 · 上限为 1 且只有一个节点时放行', async () => {
  const { summary } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }),
      node('t', 'throttle', { minIntervalMs: 0, maxPerRun: 1 }),
    ],
    [edge('a', 't')],
  );
  assert.equal(summary.ok, true);
});

/* ================= 超时熔断 ================= */

test('超时熔断 · 预算充足则放行并透传', async () => {
  const { summary, order } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }),
      node('t', 'timeout', { budgetMs: 60000 }),
      node('d', 'const', { items: [{ id: 'c0', value: 'D' }] }),
    ],
    [edge('a', 't'), edge('t', 'd')],
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.outputs.t, 'A');
  assert.ok(order.includes('d'));
});

test('超时熔断 · 超预算即中断', async () => {
  /*
   * 前面先等 80ms，保证"已耗时"确定超过预算 ——
   * 直接把预算设为 1ms 会与计时精度赛跑（elapsed 可能是 0 或 1）。
   */
  const { summary, order } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }),
      node('w', 'wait', { ms: 80 }),
      node('t', 'timeout', { budgetMs: 10 }),
      node('d', 'const', { items: [{ id: 'c0', value: 'D' }] }),
    ],
    [edge('a', 'w'), edge('w', 't'), edge('t', 'd')],
  );
  assert.equal(summary.ok, false);
  assert.ok(!order.includes('d'), '超预算时下游不该执行');
});

test('超时熔断 · 预算无效要报错（静默放行等于没配）', async () => {
  const { summary } = await run(
    [node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }), node('t', 'timeout', { budgetMs: 0 })],
    [edge('a', 't')],
  );
  assert.equal(summary.ok, false);
});

/* ================= 重试 ================= */

test('重试 · 内容合格就不重跑', async () => {
  const { summary, order } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'ok' }] }),
      node('r', 'retry', { target: 'a', times: 3, check: 'nonempty', intervalMs: 0 }),
    ],
    [edge('a', 'r')],
  );
  assert.equal(summary.ok, true);
  assert.equal(order.filter((x) => x === 'a').length, 1, '合格时不该重跑');
  assert.equal(summary.outputs.r, 'ok');
});

/**
 * 这条验证"重跑真的发生了"。
 * 目标节点是常量且值为空，所以永远不合格 ——
 * 于是看它一共被跑了几次（首次 1 + 重试 N）。
 */
test('重试 · 不合格会真的重跑目标节点', async () => {
  const { summary, order } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: '' }] }),
      node('r', 'retry', { target: 'a', times: 2, check: 'nonempty', intervalMs: 0 }),
    ],
    [edge('a', 'r')],
  );
  assert.equal(summary.ok, false, '用完次数仍不合格应失败');
  assert.equal(order.filter((x) => x === 'a').length, 3, '应跑 1 次 + 重试 2 次');
});

test('重试 · 用完次数仍不合格要失败，不静默放行', async () => {
  const { summary, order } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: '' }] }),
      node('r', 'retry', { target: 'a', times: 1, check: 'nonempty', intervalMs: 0 }),
      node('d', 'const', { items: [{ id: 'c0', value: 'D' }] }),
    ],
    [edge('a', 'r'), edge('r', 'd')],
  );
  assert.equal(summary.ok, false);
  assert.ok(!order.includes('d'), '重试失败时下游不该执行');
});

test('重试 · 目标不存在要报清楚', async () => {
  const { summary } = await run(
    [node('a', 'const', { items: [{ id: 'c0', value: 'x' }] }), node('r', 'retry', { target: '不存在的节点', times: 1 })],
    [edge('a', 'r')],
  );
  assert.equal(summary.ok, false);
});

test('重试 · 没填目标要报错', async () => {
  const { summary } = await run(
    [node('a', 'const', { items: [{ id: 'c0', value: 'x' }] }), node('r', 'retry', { times: 1 })],
    [edge('a', 'r')],
  );
  assert.equal(summary.ok, false);
});

/* ================= 共同约定 ================= */

/**
 * 控制器是控制流，不该改写数据流 —— 这条对所有控制器都成立。
 * 与上一轮把 wait / beep / playAudio 改成透传是同一个道理。
 */
test('控制器一律透传上游，不改写数据', async () => {
  const kinds = [
    { kind: 'gate', extra: { mode: 'now', check: 'nonempty' } },
    { kind: 'throttle', extra: { minIntervalMs: 0 } },
    { kind: 'timeout', extra: { budgetMs: 60000 } },
  ];
  for (const k of kinds) {
    const { summary } = await run(
      [node('a', 'const', { items: [{ id: 'c0', value: 'PAYLOAD' }] }), node('c', k.kind, k.extra)],
      [edge('a', 'c')],
    );
    assert.equal(summary.outputs.c, 'PAYLOAD', `${k.kind} 应原样透传`);
  }
});
