import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topoLayers, ancestorsOf } from '../src/engine/topo';
import { renderTemplate } from '../src/engine/template';
import { runGraph } from '../src/engine/runner';
import { makeNode, type Graph, type GraphEdge, type GraphNode } from '../src/types';

const E = (s: string, t: string): GraphEdge => ({ id: `${s}->${t}`, source: s, target: t });
const G = (nodes: GraphNode[], edges: GraphEdge[]): Graph => ({ nodes, edges });

test('topo: 线性链 A→B→C 分为三层', () => {
  const g = G([makeNode('A'), makeNode('B'), makeNode('C')], [E('A','B'), E('B','C')]);
  const { layers, cyclic } = topoLayers(g);
  assert.deepEqual(layers, [['A'], ['B'], ['C']]);
  assert.deepEqual(cyclic, []);
});

test('topo: 分叉+汇合，同层可并行，汇合点最后', () => {
  // A → B, A → C, B → D, C → D
  const g = G(
    [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')],
    [E('A','B'), E('A','C'), E('B','D'), E('C','D')],
  );
  const { layers, cyclic } = topoLayers(g);
  assert.deepEqual(cyclic, []);
  assert.deepEqual(layers[0], ['A']);
  assert.deepEqual(layers[1].slice().sort(), ['B','C']);
  assert.deepEqual(layers[2], ['D']);
});

test('topo: 孤立节点各自独立成层且不报错', () => {
  const g = G([makeNode('X'), makeNode('Y')], []);
  const { layers } = topoLayers(g);
  assert.equal(layers.length, 1);
  assert.deepEqual(layers[0].slice().sort(), ['X','Y']);
});

test('topo: 检测环并原样返回环内节点', () => {
  const g = G([makeNode('A'), makeNode('B'), makeNode('C')], [E('A','B'), E('B','C'), E('C','A')]);
  const { layers, cyclic } = topoLayers(g);
  assert.deepEqual(layers, []);
  assert.deepEqual(cyclic.slice().sort(), ['A','B','C']);
});

test('topo: 忽略悬空边（引用已删除节点）', () => {
  const g = G([makeNode('A')], [E('A','ghost')]);
  const { layers, cyclic } = topoLayers(g);
  assert.deepEqual(layers, [['A']]);
  assert.deepEqual(cyclic, []);
});

test('ancestors: 递归收集全部上游', () => {
  const edges = [E('A','B'), E('B','C'), E('A','C')];
  assert.deepEqual(ancestorsOf('C', edges), new Set(['B','A']));
});

test('template: 替换 output 与 input，支持简写', () => {
  const { text, missing } = renderTemplate(
    '总结: {{n1.output}} / 简写: {{n2}} / 全局: {{input}}',
    { outputs: { n1: 'AAA', n2: 'BBB' }, input: 'IN' },
  );
  assert.equal(text, '总结: AAA / 简写: BBB / 全局: IN');
  assert.deepEqual(missing, []);
});

test('template: 缺失变量保留原样并列出', () => {
  const { text, missing } = renderTemplate('看 {{nope.output}}', { outputs: {} });
  assert.equal(text, '看 {{nope.output}}');
  assert.deepEqual(missing, ['nope.output']);
});

test('runner: 顺序执行并传递上游输出', async () => {
  const g = G(
    [makeNode('A', { prompt: '写个函数' }), makeNode('B', { prompt: '审查: {{A.output}}' })],
    [E('A','B')],
  );
  const seen: string[] = [];
  const summary = await runGraph(g, {
    concurrency: 1,
    executor: async (node, rendered, onChunk) => {
      seen.push(`${node.id}:${rendered}`);
      onChunk(`out-of-${node.id}`);
      return `out-of-${node.id}`;
    },
    onEvent: () => {},
  });
  assert.equal(summary.ok, true);
  assert.deepEqual(seen, ['A:写个函数', 'B:审查: out-of-A']);
  assert.equal(summary.outputs['B'], 'out-of-B');
});

test('runner: 上游失败则下游 skipped，不执行', async () => {
  const g = G(
    [makeNode('A'), makeNode('B'), makeNode('C')],
    [E('A','B'), E('B','C')],
  );
  const executed: string[] = [];
  const summary = await runGraph(g, {
    concurrency: 1,
    executor: async (node) => {
      executed.push(node.id);
      if (node.id === 'A') throw new Error('boom');
      return 'ok';
    },
    onEvent: () => {},
  });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failed, ['A']);
  assert.deepEqual(summary.skipped, ['B','C']);
  assert.deepEqual(executed, ['A'], 'B/C 不应被执行');
});

test('runner: 并行分支受 concurrency 限制', async () => {
  const g = G(
    [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')],
    [E('A','B'), E('A','C'), E('A','D')],
  );
  let inFlight = 0;
  let peak = 0;
  const summary = await runGraph(g, {
    concurrency: 2,
    executor: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return 'x';
    },
    onEvent: () => {},
  });
  assert.equal(summary.ok, true);
  assert.equal(peak <= 2, true, `峰值并发 ${peak} 应 <= 2`);
  assert.equal(peak > 1, true, '应确实发生了并发');
});

test('runner: 检测到环时直接报错不执行任何节点', async () => {
  const g = G([makeNode('A'), makeNode('B')], [E('A','B'), E('B','A')]);
  let executed = 0;
  const errors: string[] = [];
  await runGraph(g, {
    concurrency: 1,
    executor: async () => { executed++; return ''; },
    onEvent: (e) => { if (e.type === 'run-error') errors.push(e.message); },
  });
  assert.equal(executed, 0);
  assert.equal(errors.length, 1);
});
