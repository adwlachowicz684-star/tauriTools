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
import { getRunner } from '../engine/runnerRegistry';
import { validateNode } from '../engine/nodeValidate';

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

/* ------------------------------------------------------------------ */

/*
 * 漏挂执行器是**静默**的：runner 对没有执行器的节点刻意不报错，
 * 照常发 node-done、输出留空。所以只能靠对账发现 ——
 * 上面那几条"未知 kind 不崩"的测试恰恰说明了它不会报错。
 *
 * 事实依据：AI 三个节点合并成 llmChat 之后，它一直没挂进注册表，
 * 而当时 2200 多项测试全绿。用户看到的是"大模型节点跑完了，
 * 什么也没吐出来"，同用途的老节点（ocr / translate）却正常。
 */
test('每种真实节点都要挂上执行器（合并节点最容易漏）', () => {
  /*
   * 这些不是漏挂：
   *   frame / taskPane / apiPane —— 容器，不参与执行
   *   canvasRef / module         —— 纯编排占位，直通是设计如此
   */
  const BY_DESIGN = new Set(['frame', 'taskPane', 'apiPane', 'canvasRef', 'module']);
  const kinds = [
    'task', 'trigger', 'condition', 'parallel', 'loop', 'fs', 'ocr', 'translate',
    'llmChat', 'update', 'github-update', 'github-push', 'generic-http', 'extract',
    'wait', 'log', 'beep', 'play-audio', 'clock', 'const', 'join', 'gate',
    'throttle', 'timeout', 'retry', 'math', 'text', 'compare', 'random', 'var',
    'stop', 'ask', 'canvasIn', 'canvasOut', 'tableRead', 'derive', 'filter', 'agg',
  ];
  for (const k of kinds) {
    assert.ok(getRunner({ kind: k }), `${k} 没有执行器 —— 会直通：跑完不报错、输出留空`);
  }
  /* 反向：设计上就该没有的，别哪天被误挂上去 */
  for (const k of BY_DESIGN) {
    assert.equal(getRunner({ kind: k }), undefined, `${k} 是纯容器/占位，不该有执行器`);
  }
});

test('大模型节点要有校验（合并后最容易整类漏掉）', () => {
  const v = (d) => validateNode({ data: { kind: 'llmChat', ...d } });
  /*
   * 合并前 ocr / translate 各自都有校验，合并后的 llmChat 一度没有 ——
   * 空提示词、没选连接都显示绿灯，跑起来才失败。
   */
  const noCred = v({ credentialId: '', llm: { apiKey: '' } });
  assert.notEqual(noCred.level, 'ok', '没选连接也没填密钥应当有提示');
  const ocrNoImg = v({ credentialId: 'c', use: 'ocr', imageSource: 'file', path: '' });
  assert.equal(ocrNoImg.level, 'error', '图片识别没填图片路径应当报缺参');
  const transNoLang = v({ credentialId: 'c', use: 'translate', targetLang: '' });
  assert.notEqual(transNoLang.level, 'ok', '翻译没填目标语言应当有提示');
  /* 反向：配齐了就别乱报红（误报比漏报更糟） */
  assert.equal(v({ credentialId: 'c', prompt: '', use: 'chat' }).level, 'ok',
    '提示词空着不判错 —— 它可能靠 {{上游.output}} 取内容');
});
