import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph, type RunEvent, type RunSummary } from '../engine/runner';
import type { Graph } from '../types';

/**
 * 工具节点（等待 / 日志 / 常量 / 时间）的集成测试。
 *
 * 走 runGraph 而不是只测纯函数：这几个节点的价值在"串进流程里能用"，
 * 单测验证不了执行器分发、输出传递、事件发送这些接缝。
 *
 * 提示音与播放音频依赖 AudioContext，沙盒里没有，
 * 只验证"环境不支持时不让流程失败"这一条降级路径。
 */

function mk(kind: string, id: string, extra: Record<string, unknown> = {}) {
  return { id, data: { kind, label: id, status: 'idle', output: '', error: '', ...extra } };
}

/** 造一个最小执行器；这些节点其实用不到它，但 withNodeRun 会校验能力 */
const noopExecutor = async () => ({ output: '', ok: true });

type RunResult = { summary: RunSummary; events: RunEvent[] };

async function run(nodes: unknown[], edges: unknown[] = [], input = ''): Promise<RunResult> {
  const events: RunEvent[] = [];
  const summary = await runGraph(
    { nodes, edges } as unknown as Graph,
    {
      concurrency: 1,
      executor: noopExecutor,
      input,
      onEvent: (e) => events.push(e),
    },
  );
  return { summary, events };
}

test('等待节点：按毫秒延时后继续', async () => {
  const t0 = Date.now();
  const { summary, events } = await run([mk('wait', 'w1', { ms: 120 })], []);
  const dt = Date.now() - t0;
  assert.equal(summary.ok, true);
  assert.ok(dt >= 100, `应至少等 100ms，实际 ${dt}ms`);
  /*
   * 状态改走日志了 —— output 现在是透传，不再承载「已等待 Nms」。
   * 见 engine/runners/wait.ts 里关于"控制流不该改写数据流"的说明。
   */
  const logs = events.filter((e) => e.type === 'log').map((e) => String(e.message ?? ''));
  assert.ok(logs.some((m) => /已等待 120ms/.test(m)), `日志里应有等待记录：${logs.join('|')}`);
});

test('等待节点：ms 支持模板', async () => {
  const { summary, events } = await run([mk('wait', 'w1', { ms: '{{input}}' })], [], '50');
  assert.equal(summary.ok, true);
  const logs = events.filter((e) => e.type === 'log').map((e) => String(e.message ?? ''));
  assert.ok(logs.some((m) => /已等待 50ms/.test(m)), `日志里应有等待记录：${logs.join('|')}`);
});

test('等待节点：不是数字要失败，而不是干等', async () => {
  const { summary } = await run([mk('wait', 'w1', { ms: 'abc' })], []);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failed, ['w1']);
});

test('等待节点：负数要失败', async () => {
  const { summary } = await run([mk('wait', 'w1', { ms: -1 })], []);
  assert.equal(summary.ok, false);
});

test('常量节点：原样输出', async () => {
  const { summary } = await run([mk('const', 'c1', { value: '固定内容' })], []);
  assert.equal(summary.outputs.c1, '固定内容');
});

test('常量节点：支持模板', async () => {
  const { summary } = await run([mk('const', 'c1', { value: '前缀-{{input}}' })], [], 'X');
  assert.equal(summary.outputs.c1, '前缀-X');
});

test('当前时间：按格式输出', async () => {
  const { summary } = await run([mk('clock', 'k1', { format: 'YYYY' })], []);
  assert.equal(summary.outputs.k1, String(new Date().getFullYear()));
});

test('当前时间：没填格式要失败（而非输出空）', async () => {
  const { summary } = await run([mk('clock', 'k1', { format: '  ' })], []);
  assert.equal(summary.ok, false);
});

test('日志节点：不改变数据流，上游内容原样透传', async () => {
  const { summary } = await run(
    [mk('const', 'c1', { value: '原文' }), mk('log', 'l1', { text: '到这了' })],
    [{ id: 'e1', source: 'c1', target: 'l1' }],
  );
  assert.equal(summary.outputs.l1, '原文', '日志节点必须原样透传');
});

test('日志节点：会发出 log 事件', async () => {
  const { events } = await run([mk('log', 'l1', { text: '记号A' })], []);
  const logs = events.filter((e) => e.type === 'log');
  assert.equal(logs.length, 1);
  assert.match(String((logs[0] as { message: string }).message), /记号A/);
});

test('日志节点：留空则记上游内容', async () => {
  const { events } = await run(
    [mk('const', 'c1', { value: '上游来的' }), mk('log', 'l1', { text: '' })],
    [{ id: 'e1', source: 'c1', target: 'l1' }],
  );
  const logs = events.filter((e) => e.type === 'log');
  assert.match(String((logs[0] as { message: string }).message), /上游来的/);
});

/**
 * 这条很关键：warn / error 只是日志标记，绝不能让流程失败 ——
 * 否则"记一条警告"会连带把下游全跳过，那不是这个节点该干的事。
 */
test('日志节点：error 级别也不让流程失败', async () => {
  const { summary } = await run(
    [
      mk('log', 'l1', { text: '出问题了', level: 'error' }),
      mk('const', 'c2', { value: '仍应执行' }),
    ],
    [{ id: 'e1', source: 'l1', target: 'c2' }],
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.outputs.c2, '仍应执行', '下游不该被跳过');
});

/**
 * 提示音在沙盒里没有 AudioContext。
 * 关键行为是：播不出来只告警，不能把流程打断 ——
 * 静音环境、无音频设备、浏览器自动播放策略都会挡住它。
 */
test('提示音：环境不支持时告警但不失败', async () => {
  const { summary } = await run([mk('beep', 'b1', { preset: 'success' })], []);
  assert.equal(summary.ok, true, '播不出声音不该让流程失败');
});

test('播放音频：缺读取能力时明确失败（不静默）', async () => {
  const { summary } = await run([mk('play-audio', 'p1', { path: '/x/a.mp3' })], []);
  assert.equal(summary.ok, false, '没有读取能力就该失败');
});
