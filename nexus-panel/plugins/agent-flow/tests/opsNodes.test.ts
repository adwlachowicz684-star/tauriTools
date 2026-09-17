import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph, type RunSummary, type RunEvent } from '../engine/runner';
import type { Graph } from '../types';

/**
 * 运算 / 变量 / 停止 / 人工输入的集成测试。
 *
 * 走 runGraph 而不是只测纯函数 —— 停止的价值全在"能不能真拦住下游"，
 * 变量的价值全在"跨节点能不能取到"，这些都只有跑起来才验证得了。
 */

const node = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  data: { kind, label: id, status: 'idle', output: '', error: '', ...extra },
});
const edge = (s: string, t: string) => ({ id: `${s}->${t}`, source: s, target: t });

const noopExecutor = async () => ({ output: '', ok: true });

async function run(
  nodes: unknown[], edges: unknown[] = [],
  opts: { input?: string; askHuman?: (p: string, d?: string) => Promise<string | null> } = {},
): Promise<{ summary: RunSummary; events: RunEvent[]; order: string[] }> {
  const events: RunEvent[] = [];
  const summary = await runGraph(
    { nodes, edges } as unknown as Graph,
    {
      concurrency: 1, executor: noopExecutor,
      input: opts.input ?? '',
      askHuman: opts.askHuman,
      onEvent: (e) => events.push(e),
    },
  );
  const order = events.filter((e) => e.type === 'node-done').map((e) => String(e.id));
  return { summary, events, order };
}

/* ================= 运算 ================= */

test('数学：模板取上游值再相加（模板本身不算数）', async () => {
  const { summary } = await run(
    [node('a', 'const', { value: '7' }), node('m', 'math', { op: 'add', a: '{{a.output}}', b: '5' })],
    [edge('a', 'm')],
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.outputs.m, '12');
});

test('文本：拼接上游内容', async () => {
  const { summary } = await run(
    [node('a', 'const', { value: 'hi' }), node('t', 'text', { op: 'concat', a: '{{a.output}}', b: '!' })],
    [edge('a', 't')],
  );
  assert.equal(summary.outputs.t, 'hi!');
});

test('比较：输出 true/false，下游条件节点能用', async () => {
  const { summary } = await run(
    [node('c', 'compare', { op: 'gt', a: '10', b: '9' })],
  );
  assert.equal(summary.outputs.c, 'true');
});

test('随机：整数落在范围内', async () => {
  const { summary } = await run([node('r', 'random', { op: 'int', a: '5', b: '5' })]);
  assert.equal(summary.outputs.r, '5');
});

/* ================= 变量 ================= */

test('变量：写入后再读取', async () => {
  const { summary } = await run(
    [
      node('w', 'var', { mode: 'set', name: '总数', value: '42' }),
      node('r', 'var', { mode: 'get', name: '总数' }),
    ],
    [edge('w', 'r')],
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.outputs.r, '42');
  assert.equal(summary.vars['总数'], '42');
});

test('变量：写入时留空则取上游输出', async () => {
  const { summary } = await run(
    [
      node('a', 'const', { value: '来自上游' }),
      node('w', 'var', { mode: 'set', name: 'x' }),
    ],
    [edge('a', 'w')],
  );
  assert.equal(summary.vars.x, '来自上游');
});

/**
 * 读没赋过值的变量要**失败**而不是给空串 ——
 * 空串会让下游以为"查到了，是空的"，而实际是"根本没赋值"。
 */
test('变量：读未赋值的变量会失败，不给空串', async () => {
  const { summary } = await run([node('r', 'var', { mode: 'get', name: '不存在' })]);
  assert.equal(summary.ok, false);
  assert.ok(summary.failed.includes('r'));
});

test('变量：{{var.名字}} 在模板里也能取到', async () => {
  const { summary } = await run(
    [
      node('w', 'var', { mode: 'set', name: 'n', value: '99' }),
      node('c', 'const', { value: '结果是 {{var.n}}' }),
    ],
    [edge('w', 'c')],
  );
  assert.equal(summary.outputs.c, '结果是 99');
});

test('变量：没赋值时 {{var.x}} 保留原样提示', async () => {
  const { summary } = await run([node('c', 'const', { value: '结果是 {{var.nope}}' })]);
  assert.equal(summary.outputs.c, '结果是 {{var.nope}}');
});

/* ================= 停止 ================= */

test('停止 · 整个流程：下游不再执行', async () => {
  const { summary, order } = await run(
    [node('a', 'const', { value: 'x' }), node('s', 'stop', { mode: 'all' }), node('d', 'const', { value: 'D' })],
    [edge('a', 's'), edge('s', 'd')],
  );
  assert.ok(order.includes('s'));
  assert.ok(!order.includes('d'), '停止后下游不该执行');
  assert.equal(summary.ok, true, '停止不算失败');
  assert.equal(summary.failed.length, 0);
});

test('停止 · 这条分支：别的分支照跑', async () => {
  const { order } = await run(
    [
      node('a', 'const', { value: 'A' }),
      node('s', 'stop', { mode: 'branch' }),
      node('d', 'const', { value: 'D' }),
      node('b', 'const', { value: 'B' }),
      node('e', 'const', { value: 'E' }),
    ],
    [edge('a', 's'), edge('s', 'd'), edge('a', 'b'), edge('b', 'e')],
  );
  assert.ok(!order.includes('d'), '被停的分支不该继续');
  assert.ok(order.includes('e'), '别的分支该照跑');
});

test('停止：上游数据仍透传给下游节点本身', async () => {
  const { summary } = await run(
    [node('a', 'const', { value: '透传我' }), node('s', 'stop', { mode: 'all' })],
    [edge('a', 's')],
  );
  assert.equal(summary.outputs.s, '透传我');
});

/* ================= 人工输入 ================= */

test('人工输入：拿到人填的内容', async () => {
  const { summary } = await run(
    [node('q', 'ask', { prompt: '标题?' })],
    [],
    { askHuman: async () => '我填的标题' },
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.outputs.q, '我填的标题');
});

test('人工输入：提示语支持模板（能把上游内容显示给人看）', async () => {
  let seen = '';
  await run(
    [node('a', 'const', { value: '上游内容' }), node('q', 'ask', { prompt: '确认：{{a.output}}' })],
    [edge('a', 'q')],
    { askHuman: async (p) => { seen = p; return 'ok'; } },
  );
  assert.equal(seen, '确认：上游内容');
});

/**
 * 界面没接这个能力时必须**明确失败** ——
 * 静默返回空串会让下游拿着空值继续跑，那比报错难查得多。
 */
test('人工输入：环境不支持会失败，不静默给空', async () => {
  const { summary } = await run([node('q', 'ask', { prompt: '填点什么' })]);
  assert.equal(summary.ok, false);
  assert.ok(summary.failed.includes('q'));
});

test('人工输入：取消（返回 null）也算失败', async () => {
  const { summary } = await run(
    [node('q', 'ask', { prompt: 'x' })],
    [], { askHuman: async () => null },
  );
  assert.equal(summary.ok, false);
});

test('人工输入：必填但没填会失败', async () => {
  const { summary } = await run(
    [node('q', 'ask', { prompt: 'x', required: true })],
    [], { askHuman: async () => '   ' },
  );
  assert.equal(summary.ok, false);
});

test('人工输入：非必填时空着也能过', async () => {
  const { summary } = await run(
    [node('q', 'ask', { prompt: 'x', required: false })],
    [], { askHuman: async () => '' },
  );
  assert.equal(summary.ok, true);
});
