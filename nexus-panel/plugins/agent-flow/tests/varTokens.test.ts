import test from 'node:test';
import assert from 'node:assert/strict';

import type { Graph, GraphEdge, GraphNode } from '../types';
import { makeNode, makeLoopNode } from '../types';
import { isInLoopBody, LOOP_TOKENS, loopBodyOf, loopTokensOf } from '../engine/loop';
import { renderTemplate } from '../engine/template';
import { TEMPLATE_VARS } from '../engine/nodeSpec';
import { readSrc } from './srcScan';

/* ---------------- 工具 ---------------- */

function edge(source: string, target: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return { id: `${source}->${target}`, source, target, ...extra };
}

/**
 * 循环体：l -body-> b1 -> b2，另有一条 done 出口到 after。
 *
 * 只有 b1 / b2 能拿到 {{loop.item}}，after 拿不到 ——
 * 给 after 也摆一排按钮的话，插进去渲染不出来（未解析、原样留下）。
 */
function loopGraph(): Graph {
  const nodes: GraphNode[] = [
    makeLoopNode('l', { mode: 'list', separator: '\n' }),
    makeNode('b1', { prompt: 'x' }),
    makeNode('b2', { prompt: 'y' }),
    makeNode('after', { prompt: 'z' }),
  ];
  return {
    nodes,
    edges: [
      edge('l', 'b1', { loopRole: 'body' }),
      edge('b1', 'b2'),
      edge('l', 'after', { loopRole: 'done' }),
    ],
  };
}

/* ---------------- 循环体判定 ---------------- */

test('isInLoopBody：循环体内的节点为真，done 出口之后的为假', () => {
  const g = loopGraph();
  assert.equal(isInLoopBody('b1', g.nodes, g.edges), true, '循环体首节点应在体内');
  assert.equal(isInLoopBody('b2', g.nodes, g.edges), true, '循环体二级节点应在体内');
  assert.equal(isInLoopBody('after', g.nodes, g.edges), false, 'done 出口之后不该在体内');
  assert.equal(isInLoopBody('l', g.nodes, g.edges), false, '循环节点自身不在自己的体内');
});

test('isInLoopBody：没有循环节点时一律为假（不会把全局当循环体）', () => {
  const g: Graph = {
    nodes: [makeNode('a', { prompt: 'x' }), makeNode('b', { prompt: 'y' })],
    edges: [edge('a', 'b')],
  };
  assert.equal(isInLoopBody('b', g.nodes, g.edges), false);
});

test('isInLoopBody：与执行期用的是同一套循环体（不另写一份可达性）', () => {
  /*
   * ================= 这条守卫的来历 =================
   *
   * 插入按钮由界面自己判"在不在循环体里"才给不给 {{loop.item}}。
   * 若这里另写一份 BFS，两份算法的边界情况迟早分岔 ——
   * 而分岔的表现是"按钮给了、插进去渲染不出结果"，
   * 未解析的变量只进 console，值原样留下，全程不报错。
   *
   * 所以让它和执行期共用 loopBodyOf，这里断言两者结果一致。
   * ==================================================================
   */
  const g = loopGraph();
  const body = loopBodyOf('l', g);
  for (const n of g.nodes) {
    assert.equal(
      isInLoopBody(n.id, g.nodes, g.edges),
      body.has(n.id),
      `${n.id}：按钮判定与执行期循环体不一致`,
    );
  }
});

test('loopTokensOf：体内给足三个，体外一个都不给', () => {
  /*
   * 这是**跑出来**的断言，不是看源码里有没有那一行。
   *
   * 为什么非得能真跑：把 return 改成 `[]` 之后，界面上什么变化都没有 ——
   * 按钮只是安静地少一排，而"少一排"没人会注意到。
   * 源码级检查（"文件里有 LOOP_TOKENS 这几个字"）对这种改法一律放行，
   * 实测过：改成 [] 之后全量测试照绿。
   */
  const g = loopGraph();
  assert.deepEqual(loopTokensOf('b1', g.nodes, g.edges), [...LOOP_TOKENS]);
  assert.deepEqual(loopTokensOf('b2', g.nodes, g.edges), [...LOOP_TOKENS]);
  assert.deepEqual(loopTokensOf('after', g.nodes, g.edges), []);
  assert.deepEqual(loopTokensOf('l', g.nodes, g.edges), []);
  assert.ok(LOOP_TOKENS.length === 3, `循环变量数量变了（${LOOP_TOKENS.length}），同步更新这里`);
});

/* ---------------- 变量本身真的能用 ---------------- */

test('LOOP_TOKENS 里的每个变量在循环体内都渲染得出值', () => {
  /*
   * 按钮给了却渲染不出来的话，就是一枚"点了不生效"的废按钮 ——
   * 所以这里跑真实的 renderTemplate，而不是只比对字符串。
   */
  const r = renderTemplate(LOOP_TOKENS.join('|'), {
    outputs: {},
    loop: { item: '第一行', index: 2, count: 5 },
  });
  assert.equal(r.text, '第一行|2|5');
  assert.deepEqual(r.missing, []);
});

test('循环体外引用这些变量要保留原样提示（不能悄悄给空串）', () => {
  const r = renderTemplate('v={{loop.item}}', { outputs: {}, loop: null });
  assert.equal(r.text, 'v={{loop.item}}');
  assert.ok(r.missing.includes('loop.item'));
});

test('LOOP_TOKENS 与给拼装方的契约一致（加变量不能只改一处）', () => {
  const syntax = new Set(TEMPLATE_VARS.map((s) => s.syntax));
  const missing = LOOP_TOKENS.filter((t) => !syntax.has(t));
  assert.deepEqual(
    missing,
    [],
    `engine/nodeSpec.ts 的 TEMPLATE_VARS 里没有这些循环变量 —— `
    + `界面给了按钮、拼装方却不知道有这个变量：${missing.join(', ')}`,
  );
});

/* ---------------- 界面接线 ---------------- */

test('插入按钮统一走一处，且循环变量与全局输入都在里面', () => {
  /*
   * ================= 这条守卫的来历 =================
   *
   * 以前任务 / 大模型 / 翻译 / 识图四处各写一遍
   * `upstreamTokens(p.upstream, ['{{input}}'])` —— 有的带 {{input}}、
   * 有的不带，没人带循环变量。于是"支持模板"这件事
   * 在不同节点上的可用程度不一样，而界面看着完全正常。
   *
   * 所以：所有调用点都必须把**整个上下文**传进去（p），
   * 而不是只传 upstream 字符串数组 —— 传数组就永远拿不到循环信息。
   * ==================================================================
   */
  const src = readSrc(
    'components/inspectors/fields.tsx',
    'nodes/defs/task.tsx',
    'nodes/defs/llmChat.tsx',
    'nodes/defs/translate.tsx',
    'nodes/imageCards.tsx',
    'nodes/defs/ocr.tsx',
  );

  const stale = [...src.matchAll(/upstreamTokens\(\s*([\w.]+)\.upstream\b/g)]
    .map((m) => m[0]);
  assert.deepEqual(
    stale,
    [],
    `这里还在只传 upstream —— 拿不到循环变量，按钮会少一排：${stale.join(' ; ')}`,
  );

  const calls = [...src.matchAll(/upstreamTokens\(/g)].length;
  assert.ok(calls >= 5, `upstreamTokens 调用点少了很多（${calls}），是不是有面板改回手写了？`);

  // 那一处必须真的带上循环变量与全局输入
  const fields = readSrc('components/inspectors/fields.tsx');
  assert.ok(
    /loopTokensOf\s*\(/.test(fields),
    'fields.tsx 没有接上 engine/loop 的循环变量 —— 循环体里仍然一个按钮都没有',
  );
  assert.ok(
    /\{\{\s*input\s*\}\}/.test(fields),
    'upstreamTokens 不再给出 {{input}} —— 全局输入又没有入口了',
  );
});
