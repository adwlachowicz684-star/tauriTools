import test from 'node:test';
import assert from 'node:assert/strict';
/*
 * 以前这里 import 的是 '../runner.mjs' / '../types.mjs' ——
 * 那是 strip-ts.py 的**生成物**，于是测试与构建脚本耦合死了：
 * 换个编译方式就得回来改路径。现在直接用源码路径，
 * 由 tsc 编译成 .js 后同目录解析。
 */
import { runGraph } from '../engine/runner';
import { makeNode } from '../types';

/**
 * 节点注册表相关的引擎侧行为。
 *
 * 注册表本体（nodes/registry.tsx）带 React，测试环境加载不了，
 * 所以这里测的是它在引擎侧的那半张表（engine/runnerRegistry.ts）暴露出的行为：
 * 未知节点不炸、且不影响其余节点。
 */

/** 一个本机没有注册执行器的节点（模拟被删除的自定义节点） */
function unknownNode(id) {
  return { id, data: { kind: 'my-custom-node', label: '自定义', status: 'idle', output: '', error: '' } };
}

test('未知 kind 的节点不会让整轮运行崩掉', async () => {
  const g = {
    nodes: [makeNode('A', { prompt: 'x' }), unknownNode('X'), makeNode('B', { prompt: 'y' })],
    edges: [
      { id: 'e1', source: 'A', target: 'X' },
      { id: 'e2', source: 'X', target: 'B' },
    ],
  };
  const s = await runGraph(g, {
    concurrency: 1,
    executor: async (node) => `out-${node.id}`,
    onEvent: () => {},
  });
  // 关键：整轮不抛异常，前后节点照常执行
  assert.equal(s.outputs['A'], 'out-A');
  assert.equal(s.outputs['B'], 'out-B');
});

test('未知 kind 的节点判定为成功但不产出内容（不假装跑过）', async () => {
  const g = { nodes: [unknownNode('X')], edges: [] };
  const events = [];
  const s = await runGraph(g, {
    concurrency: 1,
    executor: async () => 'never',
    onEvent: (e) => events.push(e),
  });
  assert.equal(s.ok, true);
  const done = events.find((e) => e.type === 'node-done' && e.id === 'X');
  assert.ok(done, '应产生 node-done 事件');
  assert.equal(done.output, '', '不应凭空产出内容');
});

test('未知 kind 不会污染下游模板（下游拿到空串而非崩溃）', async () => {
  const g = {
    nodes: [unknownNode('X'), makeNode('B', { prompt: 'v={{X.output}}' })],
    edges: [{ id: 'e1', source: 'X', target: 'B' }],
  };
  const seen = [];
  await runGraph(g, {
    concurrency: 1,
    executor: async (node, rendered) => { seen.push(`${node.id}:${rendered}`); return 'ok'; },
    onEvent: () => {},
  });
  assert.deepEqual(seen, ['B:v=']);
});
