import test from 'node:test';
import assert from 'node:assert/strict';

import type { Graph, GraphEdge, GraphNode } from '../types';
import { makeNode, makeLoopNode, makeFsNode, makeConditionNode } from '../types';
import { runGraph, type Executor, type RunEvent } from '../engine/runner';
import { resolveLoopItems, loopBodyOf, collectLoops, unescapeSeparator, clampIterations } from '../engine/loop';
import { renderTemplate } from '../engine/template';
import { templateTextOf, deleteElements } from '../engine/canvasOps';

/* ---------------- 工具 ---------------- */

function edge(source: string, target: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return { id: `${source}->${target}${extra.branch ? ':' + extra.branch : ''}`, source, target, ...extra };
}

/** 记录每个任务节点被调用的次数与收到的提示词 */
function recordingExecutor(log: { id: string; prompt: string }[]): Executor {
  return async (node, prompt) => {
    log.push({ id: node.id, prompt });
    return `out:${node.id}`;
  };
}

async function run(graph: Graph, opts: {
  log?: { id: string; prompt: string }[];
  input?: string;
  fs?: string[];
} = {}) {
  const log = opts.log ?? [];
  const events: RunEvent[] = [];
  const summary = await runGraph(graph, {
    concurrency: 1,
    executor: recordingExecutor(log),
    fsExecutor: async (node, args) => {
      const d = (node.data as { op?: string }).op ?? '?';
      const line = `${d} ${args.path}`;
      if (opts.fs) opts.fs.push(line);
      return `fs:${line}`;
    },
    input: opts.input,
    onEvent: (e) => events.push(e),
  });
  return { summary, log, events };
}

/* ================================================================== */
/* 迭代项解析                                                          */
/* ================================================================== */

test('固定次数：生成 1..N', () => {
  const r = resolveLoopItems(
    makeLoopNode('l', { mode: 'times', times: 3 }).data as never,
    { outputs: {} },
  );
  assert.deepEqual(r.items, ['1', '2', '3']);
  assert.equal(r.error, null);
});

test('固定次数为 0 或负数 → 报错', () => {
  const r = resolveLoopItems(
    makeLoopNode('l', { mode: 'times', times: 0 }).data as never,
    { outputs: {} },
  );
  assert.ok(r.error);
  assert.equal(r.items.length, 0);
});

test('列表：按换行切分并去掉空项', () => {
  const r = resolveLoopItems(
    makeLoopNode('l', { mode: 'list', separator: '\\n', source: 'a' }).data as never,
    { outputs: { a: 'x\ny\n\n  z  \n' } },
  );
  assert.deepEqual(r.items, ['x', 'y', 'z']);
});

test('列表：按逗号切分', () => {
  const r = resolveLoopItems(
    makeLoopNode('l', { mode: 'list', separator: ',', source: 'a' }).data as never,
    { outputs: { a: 'a, b ,c' } },
  );
  assert.deepEqual(r.items, ['a', 'b', 'c']);
});

test('列表：来源为空 → 报错而非静默跑 0 轮', () => {
  const r = resolveLoopItems(
    makeLoopNode('l', { mode: 'list', source: 'a' }).data as never,
    { outputs: { a: '   \n  \n' } },
  );
  assert.ok(r.error, '空列表应报错，否则用户会以为循环跑了');
});

test('列表：未指定来源时拼接全部上游输出', () => {
  const r = resolveLoopItems(
    makeLoopNode('l', { mode: 'list', separator: '\\n', source: '' }).data as never,
    { outputs: { a: 'p', b: 'q' } },
  );
  assert.deepEqual(r.items, ['p', 'q']);
});

test('上限截断并给出警告', () => {
  const r = resolveLoopItems(
    makeLoopNode('l', { mode: 'times', times: 10, maxIterations: 4 }).data as never,
    { outputs: {} },
  );
  assert.equal(r.items.length, 4);
  assert.ok(r.warnings.length > 0, '被截断应产生警告');
});

test('上限不超过全局硬上限', () => {
  assert.equal(clampIterations(99999, 99999), 1000);
});

test('分隔符转义还原', () => {
  assert.equal(unescapeSeparator('\\n'), '\n');
  assert.equal(unescapeSeparator(','), ',');
  assert.equal(unescapeSeparator(''), '\n');
});

test('glob 模式：按行读取上游给出的文件清单', () => {
  const r = resolveLoopItems(
    makeLoopNode('l', { mode: 'glob', source: 'g' }).data as never,
    { outputs: { g: '/a/x.ts\n/b/y.ts\n' } },
  );
  assert.deepEqual(r.items, ['/a/x.ts', '/b/y.ts']);
});

test('glob 模式：无匹配 → 报错', () => {
  const r = resolveLoopItems(
    makeLoopNode('l', { mode: 'glob', source: 'g' }).data as never,
    { outputs: { g: '' } },
  );
  assert.ok(r.error);
});

/* ================================================================== */
/* 循环体识别                                                          */
/* ================================================================== */

test('循环体：只含 body 出口可达的节点', () => {
  const graph: Graph = {
    nodes: [
      makeLoopNode('l'),
      makeNode('b1'),
      makeNode('d1'),
    ],
    edges: [
      edge('l', 'b1', { loopRole: 'body' }),
      edge('l', 'd1', { loopRole: 'done' }),
    ],
  };
  const body = loopBodyOf('l', graph);
  assert.ok(body.has('b1'));
  assert.ok(!body.has('d1'), 'done 出口的节点不属于循环体');
});

test('循环体：多层级联全部纳入', () => {
  const graph: Graph = {
    nodes: [makeLoopNode('l'), makeNode('b1'), makeNode('b2'), makeNode('b3')],
    edges: [
      edge('l', 'b1', { loopRole: 'body' }),
      edge('b1', 'b2'),
      edge('b2', 'b3'),
    ],
  };
  const body = loopBodyOf('l', graph);
  assert.deepEqual([...body].sort(), ['b1', 'b2', 'b3']);
});

test('循环体：未标注 loopRole 默认按 body 处理', () => {
  const graph: Graph = {
    nodes: [makeLoopNode('l'), makeNode('b1')],
    edges: [edge('l', 'b1')],
  };
  assert.ok(loopBodyOf('l', graph).has('b1'));
});

test('collectLoops 覆盖图中所有循环节点', () => {
  const graph: Graph = {
    nodes: [makeLoopNode('l1'), makeLoopNode('l2'), makeNode('x')],
    edges: [edge('l1', 'x', { loopRole: 'body' })],
  };
  const map = collectLoops(graph);
  assert.equal(map.size, 2);
  assert.ok(map.get('l1')!.has('x'));
  assert.equal(map.get('l2')!.size, 0);
});

/* ================================================================== */
/* 循环执行                                                            */
/* ================================================================== */

test('固定次数循环：循环体执行 N 次', async () => {
  const graph: Graph = {
    nodes: [
      makeLoopNode('l', { mode: 'times', times: 3 }),
      makeNode('b1', { prompt: 'task' }),
    ],
    edges: [edge('l', 'b1', { loopRole: 'body' })],
  };
  const log: { id: string; prompt: string }[] = [];
  const { summary } = await run(graph, { log });

  assert.equal(log.length, 3, '循环体应执行 3 次');
  assert.ok(log.every((l) => l.id === 'b1'));
  assert.equal(summary.loops.length, 1);
  assert.equal(summary.loops[0].rounds, 3);
  assert.equal(summary.loops[0].failed, 0);
  assert.equal(summary.ok, true);
});

test('遍历列表：每项执行一次并注入 {{loop.item}}', async () => {
  const graph: Graph = {
    nodes: [
      makeNode('src', { prompt: 'make list' }),
      makeLoopNode('l', { mode: 'list', separator: '\\n', source: 'src' }),
      makeNode('b1', { prompt: '处理 {{loop.item}}' }),
    ],
    edges: [edge('src', 'l'), edge('l', 'b1', { loopRole: 'body' })],
  };
  const log: { id: string; prompt: string }[] = [];
  const events: RunEvent[] = [];
  const summary = await runGraph(graph, {
    concurrency: 1,
    // src 产出三行列表，其它节点返回固定文本
    executor: async (node, prompt) => {
      log.push({ id: node.id, prompt });
      return node.id === 'src' ? 'a\nb\nc' : 'x';
    },
    onEvent: (e) => events.push(e),
  });

  const body = log.filter((l) => l.id === 'b1');
  assert.equal(body.length, 3, '三项应各执行一次');
  assert.deepEqual(body.map((l) => l.prompt), ['处理 a', '处理 b', '处理 c']);
  assert.ok(events.some((e) => e.type === 'loop-resolved'));
  assert.equal(events.filter((e) => e.type === 'loop-iteration').length, 3);
  assert.equal(summary.loops[0].rounds, 3);
});

test('循环体可拿到 {{loop.index}} 与 {{loop.count}}', async () => {
  const graph: Graph = {
    nodes: [
      makeNode('src', { prompt: 'x' }),
      makeLoopNode('l', { mode: 'times', times: 2 }),
      makeNode('b1', { prompt: 'i={{loop.index}}/{{loop.count}}' }),
    ],
    edges: [edge('src', 'l'), edge('l', 'b1', { loopRole: 'body' })],
  };
  const log: { id: string; prompt: string }[] = [];
  await run(graph, { log });
  const body = log.filter((l) => l.id === 'b1');
  assert.equal(body[0].prompt, 'i=0/2');
  assert.equal(body[1].prompt, 'i=1/2');
});

test('done 出口在全部迭代完成后只执行一次', async () => {
  const graph: Graph = {
    nodes: [
      makeLoopNode('l', { mode: 'times', times: 3 }),
      makeNode('b1'),
      makeNode('d1'),
    ],
    edges: [
      edge('l', 'b1', { loopRole: 'body' }),
      edge('l', 'd1', { loopRole: 'done' }),
    ],
  };
  const log: { id: string; prompt: string }[] = [];
  await run(graph, { log });
  assert.equal(log.filter((l) => l.id === 'b1').length, 3);
  assert.equal(log.filter((l) => l.id === 'd1').length, 1);
  // done 在最后
  assert.equal(log[log.length - 1].id, 'd1');
});

test('循环体失败：onError=continue 时继续跑完', async () => {
  const graph: Graph = {
    nodes: [
      makeLoopNode('l', { mode: 'times', times: 3, onError: 'continue' }),
      makeNode('b1'),
    ],
    edges: [edge('l', 'b1', { loopRole: 'body' })],
  };
  let n = 0;
  const events: RunEvent[] = [];
  const summary = await runGraph(graph, {
    concurrency: 1,
    executor: async (node) => {
      n += 1;
      // 第 2 轮失败
      if (n === 2) throw new Error('boom');
      return 'ok';
    },
    onEvent: (e) => events.push(e),
  });
  assert.equal(n, 3, 'continue 应跑满 3 轮');
  assert.equal(summary.loops[0].failed, 1);
});

test('循环体失败：onError=stop 时立即停止', async () => {
  const graph: Graph = {
    nodes: [
      makeLoopNode('l', { mode: 'times', times: 5, onError: 'stop' }),
      makeNode('b1'),
    ],
    edges: [edge('l', 'b1', { loopRole: 'body' })],
  };
  let n = 0;
  const summary = await runGraph(graph, {
    concurrency: 1,
    executor: async () => {
      n += 1;
      if (n === 2) throw new Error('boom');
      return 'ok';
    },
    onEvent: () => {},
  });
  assert.equal(n, 2, 'stop 应在第 2 轮失败后停止');
  assert.equal(summary.loops[0].rounds, 5);
  assert.equal(summary.loops[0].failed, 1);
});

test('循环节点解析失败 → 循环体与 done 都不执行', async () => {
  const graph: Graph = {
    nodes: [
      makeLoopNode('l', { mode: 'list', source: 'src' }),
      makeNode('src'),
      makeNode('b1'),
      makeNode('d1'),
    ],
    edges: [
      edge('src', 'l'),
      edge('l', 'b1', { loopRole: 'body' }),
      edge('l', 'd1', { loopRole: 'done' }),
    ],
  };
  const log: { id: string; prompt: string }[] = [];
  // src 产出空文本 → 列表为空 → 循环解析失败
  const summary = await runGraph(graph, {
    concurrency: 1,
    executor: async (node, prompt) => {
      log.push({ id: node.id, prompt });
      return node.id === 'src' ? '' : 'x';
    },
    onEvent: () => {},
  });

  assert.ok(log.every((l) => l.id === 'src'), '循环体与 done 都不该执行');
  assert.deepEqual(summary.failed, ['l']);
  assert.equal(summary.ok, false);
});

test('循环体内条件分支：每轮独立判定，不互相污染', async () => {
  const graph: Graph = {
    nodes: [
      makeLoopNode('l', { mode: 'times', times: 3 }),
      makeNode('b0', { prompt: 'seed' }),
      makeConditionNode('c', {
        rules: [{ id: 'r1', label: '是', op: 'contains', value: 'yes', source: 'b0' }],
        defaultBranch: false,
      }),
      makeNode('yes1'),
      makeNode('no1'),
    ],
    edges: [
      edge('l', 'b0', { loopRole: 'body' }),
      edge('b0', 'c'),
      edge('c', 'yes1', { branch: 'r1' }),
      edge('c', 'no1', { branch: '__default__' }),
    ],
  };
  let calls = 0;
  const summary = await runGraph(graph, {
    concurrency: 1,
    executor: async () => {
      calls += 1;
      return 'yes';
    },
    onEvent: () => {},
  });
  // b0 每轮执行；命中 r1 后 yes1 每轮都跑，no1 都不跑
  assert.equal(calls, 6, 'b0 3 轮 + yes1 3 轮 = 6');
  assert.equal(summary.loops[0].rounds, 3);
});

test('循环节点收集输出', async () => {
  const graph: Graph = {
    nodes: [
      makeLoopNode('l', { mode: 'times', times: 2, collect: true }),
      makeNode('b1'),
    ],
    edges: [edge('l', 'b1', { loopRole: 'body' })],
  };
  const { summary } = await run(graph);
  assert.ok(summary.outputs['l'].includes('#1'), '应包含轮次标记');
  assert.ok(summary.outputs['l'].includes('#2'));
});

test('嵌套：循环体内的节点不会在主流程重复执行', async () => {
  const graph: Graph = {
    nodes: [
      makeLoopNode('l', { mode: 'times', times: 2 }),
      makeNode('b1'),
    ],
    edges: [edge('l', 'b1', { loopRole: 'body' })],
  };
  const log: { id: string; prompt: string }[] = [];
  await run(graph, { log });
  assert.equal(log.length, 2, 'b1 只应因循环执行 2 次，不多不少');
});

/* ================================================================== */
/* 文件操作节点                                                        */
/* ================================================================== */

test('文件节点：调用执行器并写入 outputs', async () => {
  const graph: Graph = {
    nodes: [makeFsNode('f', { op: 'read', path: '/tmp/a.txt' })],
    edges: [],
  };
  const seen: string[] = [];
  const { summary } = await run(graph, { fs: seen });
  assert.deepEqual(seen, ['read /tmp/a.txt']);
  assert.equal(summary.outputs['f'], 'fs:read /tmp/a.txt');
  assert.equal(summary.ok, true);
});

test('文件节点：路径支持模板变量', async () => {
  const graph: Graph = {
    nodes: [
      makeNode('a', { prompt: 'x' }),
      makeFsNode('f', { op: 'write', path: '/tmp/{{a.output}}.txt', content: 'hello' }),
    ],
    edges: [edge('a', 'f')],
  };
  const seen: string[] = [];
  await run(graph, { fs: seen });
  assert.equal(seen[0], 'write /tmp/out:a.txt');
});

test('文件节点：执行器抛错 → 节点失败', async () => {
  const graph: Graph = {
    nodes: [makeFsNode('f', { op: 'delete', path: '/etc' })],
    edges: [],
  };
  const summary = await runGraph(graph, {
    concurrency: 1,
    executor: async () => 'x',
    fsExecutor: async () => { throw new Error('拒绝删除'); },
    onEvent: () => {},
  });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failed, ['f']);
});

test('文件节点：未提供执行器时明确报错而非静默成功', async () => {
  const graph: Graph = {
    nodes: [makeFsNode('f', { op: 'read', path: '/x' })],
    edges: [],
  };
  const summary = await runGraph(graph, {
    concurrency: 1,
    executor: async () => 'x',
    onEvent: () => {},
  });
  assert.equal(summary.ok, false, '缺少 fsExecutor 应失败，不能假装成功');
});

test('文件节点：失败后下游跳过', async () => {
  const nodes: GraphNode[] = [
    makeFsNode('f', { op: 'read', path: '/nope' }),
    makeNode('next', { prompt: 'after' }),
  ];
  const graph: Graph = { nodes, edges: [edge('f', 'next')] };
  const summary = await runGraph(graph, {
    concurrency: 1,
    executor: async () => 'x',
    fsExecutor: async () => { throw new Error('不存在'); },
    onEvent: () => {},
  });
  // 上游失败 → 下游"跳过"而非"失败"。
  // 这是既有语义：失败的只有真正出错的那个节点，
  // 被牵连的记在 skipped 里（否则一次失败会滚雪球式放大失败数）
  assert.deepEqual(summary.failed, ['f']);
  assert.ok(summary.skipped.includes('next'), '下游应记入 skipped');
});

/* ================================================================== */
/* 模板：循环变量                                                      */
/* ================================================================== */

test('模板：loop 变量在循环外保留原样', () => {
  const r = renderTemplate('v={{loop.item}}', { outputs: {}, loop: null });
  assert.equal(r.text, 'v={{loop.item}}');
  assert.ok(r.missing.includes('loop.item'));
});

test('模板：loop 简写等价 item', () => {
  const r = renderTemplate('{{loop}}', {
    outputs: {}, loop: { item: 'abc', index: 2, count: 9 },
  });
  assert.equal(r.text, 'abc');
});

test('模板：index 与 count 可用', () => {
  const r = renderTemplate('{{loop.index}}/{{loop.count}}', {
    outputs: {}, loop: { item: 'x', index: 1, count: 7 },
  });
  assert.equal(r.text, '1/7');
});

/* ================================================================== */
/* 删除时的悬空引用检测：新节点的模板字段也要覆盖                        */
/* ================================================================== */

test('templateTextOf 覆盖文件节点的路径与内容', () => {
  const t = templateTextOf({
    kind: 'fs', path: '/tmp/{{a.output}}', target: '/out/{{b.output}}',
    content: 'x {{c.output}}',
  });
  assert.ok(t.includes('{{a.output}}'));
  assert.ok(t.includes('{{b.output}}'));
  assert.ok(t.includes('{{c.output}}'));
});

test('templateTextOf 覆盖循环节点的通配符', () => {
  const t = templateTextOf({ kind: 'loop', mode: 'glob', pattern: '/d/{{a.output}}/*.ts' });
  assert.ok(t.includes('{{a.output}}'));
});

test('删除上游时，引用它的文件节点被报告为悬空', () => {
  const nodes = [
    { id: 'a', type: 'task', position: { x: 0, y: 0 }, data: makeNode('a', { prompt: 'p' }).data },
    { id: 'f', type: 'fs', position: { x: 0, y: 0 },
      data: makeFsNode('f', { path: '/tmp/{{a.output}}.txt' }).data },
  ];
  const edges = [{ id: 'a->f', source: 'a', target: 'f' }];
  const res = deleteElements(nodes, edges, { nodeIds: ['a'] });
  assert.equal(res.removedNodeIds.length, 1);
  assert.ok(
    res.danglingRefs.some((d) => d.ref === 'a.output' && d.usedBy.includes('f')),
    '文件节点的 path 引用断了应被检出',
  );
});
