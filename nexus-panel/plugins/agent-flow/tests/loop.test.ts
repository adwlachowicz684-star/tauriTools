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
  /*
    这里原本断言 rounds === 5，那是 B3 描述的虚报行为：
    用 res.items.length（解析出的项数）当轮数，
    第 2 轮就 stop 了却报告"共 5 轮"。
    修复后 rounds 是实际执行轮数，应为 2。
  */
  assert.equal(summary.loops[0].rounds, 2, '实际只跑了 2 轮，不是解析出的 5 项');
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

/* ================================================================== */
/* 回归：审查清单 B1 / B2                                              */
/*                                                                     */
/* 这两处原本在 169 项测试里都没覆盖 —— 测试全绿不代表没问题。          */
/* ================================================================== */

test('B1: maxIterations 为 undefined 时不静默变 0 轮', () => {
  // maxIterations 是后加的字段，老画布从 localStorage 读出来没有这个属性
  const legacy = { mode: 'times', times: 5 } as never;
  const r = resolveLoopItems(legacy, { outputs: {} });
  assert.equal(r.error, null, '不应报错');
  assert.equal(r.items.length, 5, '必须跑满 5 轮，而不是静默变成 0 轮');
});

test('B1: clampIterations 对非法 max 有防御', () => {
  assert.equal(clampIterations(5, 50), 5);
  // undefined / null / NaN / 负数 都应退回硬上限，而不是产出 NaN
  assert.equal(clampIterations(5, undefined as never), 5);
  assert.equal(clampIterations(5, null as never), 5);
  assert.equal(clampIterations(5, NaN), 5);
  assert.equal(clampIterations(5, -1), 5);
});

test('B1: 轮数被截成 0 时报错而非显示成功', () => {
  // 用户显式配 0 次已被 want<1 拦下；这里是被坏上限截成 0
  const r = resolveLoopItems(
    { mode: 'times', times: 5, maxIterations: 0 } as never,
    { outputs: {} },
  );
  assert.ok(r.error, '必须报错，不能静默跑 0 轮还显示成功');
  assert.equal(r.items.length, 0);
});

test('B1: list 模式遇到坏上限同样报错', () => {
  const r = resolveLoopItems(
    { mode: 'list', source: 'a', separator: '', maxIterations: 0 } as never,
    { outputs: { a: 'x\ny\nz' } },
  );
  assert.ok(r.error);
});

test('B2: 节点缺 data 时 collectLoops 不崩溃', () => {
  const bad = { nodes: [{ id: 'a' }, { id: 'b', data: { kind: 'loop' } }], edges: [] } as never;
  const m = collectLoops(bad);
  assert.equal(m.size, 1, '只应收集到那个真正的循环节点');
  assert.ok(m.has('b'));
});

test('B2: data 为 null / undefined 都不崩溃', () => {
  assert.doesNotThrow(() => collectLoops({ nodes: [{ id: 'x', data: null }], edges: [] } as never));
  assert.doesNotThrow(() => collectLoops({ nodes: [{ id: 'x' }], edges: [] } as never));
});

test('B2: 空 nodes 也不崩溃', () => {
  assert.doesNotThrow(() => collectLoops({ nodes: [], edges: [] } as never));
  assert.equal(collectLoops({ nodes: [], edges: [] } as never).size, 0);
});

/* ================================================================== */
/* 回归：审查清单 B3 / B4                                              */
/* ================================================================== */

/** 跑一个固定次数的循环，返回 summary 与每轮记录 */
async function runTimesLoop(times: number, opts: {
  failAt?: number;        // 第几轮抛错（1 起）
  onError?: 'continue' | 'stop';
  abortAfter?: number;    // 执行几轮后取消
} = {}) {
  const graph: Graph = {
    nodes: [
      makeLoopNode('l', {
        mode: 'times', times,
        onError: opts.onError ?? 'continue',
      }),
      makeNode('b1'),
    ],
    edges: [edge('l', 'b1', { loopRole: 'body' })],
  };
  let n = 0;
  let ac: AbortController | null = null;
  const events: RunEvent[] = [];
  const summary = await runGraph(graph, {
    concurrency: 1,
    executor: async () => {
      n += 1;
      if (ac && n >= (opts.abortAfter ?? 0)) ac.abort();
      if (opts.failAt && n === opts.failAt) throw new Error('boom');
      return 'ok';
    },
    onEvent: (e) => { events.push(e); },
    signal: (ac = new AbortController()).signal,
  });
  return { summary, n, events };
}

test('B3: 用户中途取消时轮数不虚报', async () => {
  const { summary, n } = await runTimesLoop(1000, { abortAfter: 2 });
  assert.ok(n < 1000, '确实被取消了');
  assert.equal(
    summary.loops[0].rounds, n,
    `取消后应报告实际执行的 ${n} 轮，而不是解析出的 1000 项`,
  );
  assert.notEqual(summary.loops[0].rounds, 1000);
});

test('B3: onError=stop 提前结束时轮数不虚报', async () => {
  const { summary, n } = await runTimesLoop(1000, { failAt: 1, onError: 'stop' });
  assert.equal(n, 1);
  assert.equal(summary.loops[0].rounds, 1);
});

test('B3: loop-done 事件的 rounds 与实际一致', async () => {
  const { n, events } = await runTimesLoop(1000, { abortAfter: 3 });
  const done = events.filter((e) => e.type === 'loop-done');
  assert.equal(done.length, 1);
  const e = done[0] as Extract<RunEvent, { type: 'loop-done' }>;
  assert.equal(e.rounds, n);
});

test('B4: 嵌套循环中内层结束后外层上下文不丢失', async () => {
  /*
    l1(外层, 3 轮) → l2(内层, 2 轮) → body2
                   → after（内层之后，仍在外层体内）

    after 节点在外层循环体内、内层循环之外。
    内层循环结束时会 pop 自己的 ctx，
    改回栈之后应回落到外层 ctx —— after 仍能拿到正确的 {{loop.item}}。
  */
  const graph: Graph = {
    nodes: [
      makeLoopNode('l1', { mode: 'times', times: 2 }),
      makeLoopNode('l2', { mode: 'times', times: 2 }),
      makeNode('after', { prompt: 'OUTER={{loop.item}}' }),
    ],
    edges: [
      edge('l1', 'l2', { loopRole: 'body' }),
      edge('l2', 'after', { loopRole: 'done' }),
    ],
  };

  const seen: string[] = [];
  await runGraph(graph, {
    concurrency: 1,
    executor: async (node, prompt) => {
      if (node.id === 'after') seen.push(prompt);
      return 'ok';
    },
    onEvent: () => {},
  });

  assert.ok(seen.length > 0, 'after 应被执行到');
  // 关键：不能出现未解析的 {{loop.item}}
  for (const p of seen) {
    assert.ok(!p.includes('{{loop.item}}'), `上下文丢失，渲染结果: ${p}`);
    assert.ok(/^OUTER=[12]$/.test(p), `外层 loop.item 应为 1 或 2，实际: ${p}`);
  }
});

test('B4: 循环结束后 loop 变量不再可用（不残留）', async () => {
  // 循环 done 出口之后的节点，若还引用 {{loop.item}} 应保留原样提示用户
  const graph: Graph = {
    nodes: [
      makeLoopNode('l', { mode: 'times', times: 2 }),
      makeNode('b1'),
      makeNode('after', { prompt: 'X={{loop.item}}' }),
    ],
    edges: [
      edge('l', 'b1', { loopRole: 'body' }),
      edge('l', 'after', { loopRole: 'done' }),
    ],
  };
  let seen = '';
  await runGraph(graph, {
    concurrency: 1,
    executor: async (node, prompt) => {
      if (node.id === 'after') seen = prompt;
      return 'ok';
    },
    onEvent: () => {},
  });
  assert.equal(seen, 'X={{loop.item}}', '循环外应是未解析状态，而不是残留上一轮的值');
});
