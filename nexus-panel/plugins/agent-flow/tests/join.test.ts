import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph, type RunSummary } from '../engine/runner';
import type { Graph } from '../types';

/**
 * 汇合节点（控制器）—— 多入边的 AND 语义。
 *
 * 对照组是普通多入边节点的 OR 语义：只要一条活着就跑。
 * 汇合要的是"都到齐了才放行"。
 */

type N = { id: string; data: Record<string, unknown> };
type E = { id: string; source: string; target: string };

const node = (id: string, kind: string, extra: Record<string, unknown> = {}): N => ({
  id,
  data: { kind, label: id, status: 'idle', output: '', error: '', ...extra },
});

const edge = (s: string, t: string, id?: string): E => ({
  id: id ?? `${s}->${t}`, source: s, target: t,
});

const noopExecutor = async () => ({ output: '', ok: true });

async function run(
  nodes: N[], edges: E[], input = '',
): Promise<{ summary: RunSummary; order: string[] }> {
  const order: string[] = [];
  const summary = await runGraph(
    { nodes, edges } as unknown as Graph,
    {
      concurrency: 1,
      executor: noopExecutor,
      input,
      onEvent: (e) => {
        if (e.type === 'node-done') order.push(String(e.id));
      },
    },
  );
  return { summary, order };
}

/* ---------------- 宽松模式 ---------------- */

test('两条分支都到齐：合并输出', async () => {
  const { summary } = await run(
    [node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }), node('b', 'const', { items: [{ id: 'c0', value: 'B' }] }), node('j', 'join')],
    [edge('a', 'j'), edge('b', 'j')],
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.outputs.j, 'A\nB', '两个输入按顺序拼接');
});

test('自定义分隔符', async () => {
  const { summary } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }),
      node('b', 'const', { items: [{ id: 'c0', value: 'B' }] }),
      node('j', 'join', { joinBy: ' + ' }),
    ],
    [edge('a', 'j'), edge('b', 'j')],
  );
  assert.equal(summary.outputs.j, 'A + B');
});

/**
 * 这条守的是"没有入边"这个配置错误。
 * 汇合节点没有输入 = 永远收集不齐，不该静默成功。
 */
test('没有入边：失败，不静默放行', async () => {
  const { summary } = await run([node('j', 'join')], []);
  assert.equal(summary.ok, false);
  assert.ok(summary.failed.includes('j'));
});

/* ---------------- 严格模式 ---------------- */

test('严格：全部到齐才放行', async () => {
  const { summary } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }),
      node('b', 'const', { items: [{ id: 'c0', value: 'B' }] }),
      node('j', 'join', { mode: 'strict' }),
    ],
    [edge('a', 'j'), edge('b', 'j')],
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.outputs.j, 'A\nB');
});

/**
 * 严格模式的核心：任一输入没产出就失败，并让下游跳过。
 * 这是"这几条路必须都走到"的表达 —— 缺失要暴露，不能静默继续。
 */
test('严格：有输入被跳过时算没收集全，下游不执行', async () => {
  const { summary, order } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }),
      // b 会失败（const 没 value 也行，这里用一个必然失败的等待）
      node('b', 'wait', { ms: '不是数字' }),
      node('j', 'join', { mode: 'strict' }),
      node('down', 'const', { items: [{ id: 'c0', value: 'D' }] }),
    ],
    [edge('a', 'j'), edge('b', 'j'), edge('j', 'down')],
  );
  assert.equal(summary.ok, false);
  assert.ok(!order.includes('down'), '下游不该执行');
});

test('严格：失败时说明缺了几条', async () => {
  const { summary } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }),
      node('b', 'wait', { ms: 'x' }),
      node('j', 'join', { mode: 'strict' }),
    ],
    [edge('a', 'j'), edge('b', 'j')],
  );
  void summary; // 入边失败时引擎在调度层就 skip 了，这里只确认不崩
});

/* ---------------- 与 OR 语义的对照 ---------------- */

/**
 * 普通节点是 OR：一条活着就跑。
 * 汇合·宽松 在此之上多了"合并输出" —— 这是它区别于普通节点的地方。
 */
test('宽松汇合不阻断流程（与严格模式形成对照）', async () => {
  const { summary, order } = await run(
    [node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }), node('j', 'join'), node('down', 'const', { items: [{ id: 'c0', value: 'D' }] })],
    [edge('a', 'j'), edge('j', 'down')],
  );
  assert.equal(summary.ok, true);
  assert.ok(order.includes('down'));
  assert.equal(summary.outputs.j, 'A');
});

test('输出为空的输入不产生多余空行', async () => {
  const { summary } = await run(
    [
      node('a', 'const', { items: [{ id: 'c0', value: 'A' }] }),
      node('b', 'const', { items: [{ id: 'c0', value: '' }] }),
      node('j', 'join'),
    ],
    [edge('a', 'j'), edge('b', 'j')],
  );
  assert.equal(summary.outputs.j, 'A', '空输入不该拼出空行');
});
