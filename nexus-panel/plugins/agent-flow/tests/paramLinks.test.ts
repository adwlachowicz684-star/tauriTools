import test from 'node:test';
import assert from 'node:assert/strict';
import type { Graph, GraphEdge, GraphNode } from '../types';
import {
  isParamEdge, paramLinksOf, flowEdgesOf, makeParamEdge,
  producesArgOf, paramLinkIssues, applyParamLinks, linksInto,
  argHandleId, parseArgHandle, isParamHandles, OUT_HANDLE,
  outHandleId, parseOutHandle, normalizeParamEdges, OUT_DEFAULT,
  outputsOf, outKindOf, outLabelOf,
} from '../engine/paramLinks';
import { argTypeIssues, argExpectOf } from '../engine/argTypes';
import { topoLayers } from '../engine/topo';
import { runGraph } from '../engine/runner';
import { validateNode, badgeTextOf } from '../engine/nodeValidate';

/**
 * 参数连线。
 *
 * 动机（用户实测）：运算类节点的参数是一个文本框，
 * 值可以手填也可以写模板，于是**看不出这个参数吃的是谁的输出**：
 *
 *   比较节点：a = 「苹果」  b = 「果」   ← 这两个值哪来的？
 *
 * 连一条线能说清，不用再去读参数框里的模板串。
 *
 * 本文件的重点不是"能连上"，而是**连上之后不引入新的静默错误**：
 * 参数连线绝不能被当成流程边（会多跑一次），
 * 也绝不能让取值顺序出错（会拿到 undefined）。
 */

const N = (id: string, kind: string, data: Record<string, unknown> = {}): GraphNode =>
  ({ id, data: { kind, ...data } }) as unknown as GraphNode;

const flowEdge = (a: string, b: string): GraphEdge =>
  ({ id: `${a}->${b}`, source: a, target: b });

/* ------------------------------------------------------------------ */
/* 判定与分离                                                          */
/* ------------------------------------------------------------------ */

test('参数连线与流程连线能分开 —— 混在一起会多跑一次', () => {
  const edges: GraphEdge[] = [
    flowEdge('a', 'b'),
    makeParamEdge('c', 'b', 'a'),
  ];
  assert.equal(flowEdgesOf(edges).length, 1, '流程边只剩 a->b');
  assert.equal(flowEdgesOf(edges)[0].source, 'a');
  assert.equal(paramLinksOf(edges).length, 1);
  assert.deepEqual(
    { source: paramLinksOf(edges)[0].source, targetArg: paramLinksOf(edges)[0].targetArg },
    { source: 'c', targetArg: 'a' },
  );
});

test('没有 targetArg 的参数连线是废线，跳过而不是填进空参数', () => {
  const broken = { id: 'x', source: 'a', target: 'b', data: { kind: 'param' } } as unknown as GraphEdge;
  assert.equal(isParamEdge(broken), true);
  assert.deepEqual(paramLinksOf([broken]), [], '没有 targetArg 不该产生连线');
});

test('handle 约定：输出端口 out:key + 入口 arg:key 才算参数连线', () => {
  assert.equal(isParamHandles(outHandleId(OUT_DEFAULT), argHandleId('a')), true);
  assert.equal(isParamHandles(outHandleId('cnt'), argHandleId('b')), true, '多输出的第二个端口也算');
  assert.equal(isParamHandles(outHandleId('a'), 'x'), false, '目标不是参数入口');
  assert.equal(isParamHandles(null, argHandleId('a')), false, '不是从输出端口出发');
  assert.equal(parseArgHandle(argHandleId('b')), 'b');
  assert.equal(parseArgHandle(null), null);
});

/*
 * 节点右侧那个总出口（OUT_HANDLE）是**流程出口**，不能兼作参数出口。
 *
 * 兼用的话，从它拖到某个参数格会被判成参数连线 ——
 * 一根流程线被画成紫虚线，用户以为只是取个值，
 * 实际下游多了一条执行路径（表现为某个节点跑了两次）。
 */
test('流程出口不再是参数连线的源端', () => {
  assert.equal(isParamHandles(OUT_HANDLE, argHandleId('a')), false,
    '从节点右侧总出口拖到参数格 = 流程连线，不是参数连线');
  assert.equal(parseOutHandle(OUT_HANDLE), null);
  assert.equal(parseOutHandle(outHandleId('cnt')), 'cnt');
});

/*
 * 升级前连好的线 sourceHandle 是裸 'out'，data.kind 仍是 'param'。
 * 判定照旧（靠 data），画线由 normalizeParamEdges 补成 'out:out' ——
 * 两条路分开，老线才不会变成"看不见的线"。
 */
test('老参数连线（裸 out）仍被认成参数连线，渲染时补成输出端口', () => {
  const old = {
    id: 'p', source: 'a', target: 'b', sourceHandle: OUT_HANDLE,
    data: { kind: 'param', targetArg: 'a' },
  } as unknown as GraphEdge;
  assert.equal(isParamEdge(old), true);
  const links = paramLinksOf([old]);
  assert.equal(links.length, 1, '老线不该变成废线');
  assert.equal(links[0].sourceArg, undefined, '没有写明时按默认输出处理');

  const fixed = normalizeParamEdges([old]);
  assert.equal(fixed[0].sourceHandle, outHandleId(OUT_DEFAULT));
  assert.equal(fixed[0].targetHandle, argHandleId('a'), '目标端也要补，否则线画不到参数格');
});

test('常量按种类产出不同的值种类', () => {
  /*
   * 种类在**卡**上，节点上没有顶层 valueType 了 ——
   * 两份数据就得每次写卡都镜像一遍，漏一处是"显示改了、跑出来还是旧的"。
   */
  const one = (vt: string) => ({ items: [{ id: 'a', valueType: vt, value: '1' }] });
  assert.equal(producesArgOf('const', one('num')), 'num');
  assert.equal(producesArgOf('const', one('bool')), 'bool');
  assert.equal(producesArgOf('const', one('text')), 'text');
  /* 没有卡时按 text —— 主输出是空串，空串既不是数字也不是布尔 */
  assert.equal(producesArgOf('const', {}), 'text');
  assert.equal(producesArgOf('const'), 'text');
});

test('数字常量填了文字时报「错参」', () => {
  /*
   * 键是**卡片 id**而不是 'value' —— 常量是多张卡，
   * 报错要能落到具体那一张上（卡片按 key 标红）。
   */
  const one = (vt: string, v: string) => ({ items: [{ id: 'a', name: '阈值', valueType: vt, value: v }] });
  const issues = argTypeIssues('const', one('num', 'abc'));
  assert.equal(issues.length, 1, '数字常量填 abc 要报出来');
  assert.equal(issues[0].key, 'a');
  assert.equal(issues[0].expect, 'num');

  assert.deepEqual(argTypeIssues('const', one('num', '42')), [], '数字不该报');
  assert.deepEqual(argTypeIssues('const', one('text', 'abc')), [], '文本什么都能填');
  assert.deepEqual(argTypeIssues('const', one('bool', 'true')), [], '布尔不校验');
  // 模板放行：编辑时没有值，判成什么都可能是猜
  assert.deepEqual(argTypeIssues('const', one('num', '{{x.output}}')), []);
});

test('多张常量卡：各自按自己的种类校验', () => {
  const d = {
    kind: 'const',
    items: [
      { id: 'a', name: '阈值', valueType: 'num', value: '10' },
      { id: 'b', name: '开关', valueType: 'bool', value: 'true' },
      { id: 'c', name: '备注', valueType: 'num', value: 'abc' },
    ],
  };
  const issues = argTypeIssues('const', d);
  assert.equal(issues.length, 1, '只有「备注」是数字卡却填了文字');
  assert.equal(issues[0].key, 'c', '要指到具体那一张卡');
  assert.equal(issues[0].label, '备注', '文案要写卡名，不写 id');
});

test('多张常量卡：每张各有一个具名输出端口', () => {
  const d = {
    kind: 'const',
    items: [
      { id: 'a', name: '阈值', valueType: 'num', value: '10' },
      { id: 'b', name: '开关', valueType: 'bool', value: 'true' },
    ],
  };
  const ports = outputsOf('const', d);
  assert.deepEqual(ports.map((p) => p.key), [OUT_DEFAULT, 'a', 'b']);
  assert.equal(outLabelOf('const', 'a', d), '阈值', '报错要写卡名');
  /* 种类按**那一张卡**判：阈值是数字、开关是布尔 —— 一律按文本会误报 */
  assert.equal(outKindOf('const', 'a', d), 'num');
  assert.equal(outKindOf('const', 'b', d), 'bool');
});

test('多张常量卡：连线按卡取值，各取各的', async () => {
  const g: Graph = {
    nodes: [
      { id: 'src', data: { kind: 'const', items: [
        { id: 'a', name: '阈值', valueType: 'num', value: '10' },
        { id: 'b', name: '开关', valueType: 'bool', value: 'true' },
      ] } },
      { id: 't1', data: { kind: 'text', op: 'upper', a: '', b: '' } },
      { id: 't2', data: { kind: 'text', op: 'upper', a: '', b: '' } },
    ] as unknown as GraphNode[],
    edges: [
      { id: 'p1', source: 'src', target: 't1', data: { kind: 'param', sourceArg: 'a', targetArg: 'a' } },
      { id: 'p2', source: 'src', target: 't2', data: { kind: 'param', sourceArg: 'b', targetArg: 'a' } },
    ] as unknown as GraphEdge[],
  };
  const r = await runGraph(g, { input: '', onEvent: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.outputs.t1, '10', '第一根取「阈值」');
  assert.equal(r.outputs.t2, 'TRUE', '第二根取「开关」');
});

test('数字常量接到「大于」合法，接到「包含」报错参', () => {
  const nodes = [
    { id: 'c1', data: { kind: 'const', items: [{ id: 'a', valueType: 'num', value: '10' }] } },
    { id: 'm1', data: { kind: 'math', op: 'add' } },
  ] as unknown as GraphNode[];
  const links = [{ id: 'p', source: 'c1', target: 'm1', targetArg: 'a' }];
  assert.deepEqual(paramLinkIssues(nodes, links), {}, '数字 → 加减乘除 合法');

  const toText = [{ id: 'p', source: 'c1', target: 'm1', targetArg: 'a' }];
  void toText;
  // 文本常量接到同样位置也不该报（数学要数字，文本常量是 text → 该报）
  const textNodes = [
    { id: 'c2', data: { kind: 'const', items: [{ id: 'a', valueType: 'text', value: 'x' }] } },
    { id: 'm1', data: { kind: 'math', op: 'add' } },
  ] as unknown as GraphNode[];
  const bad = paramLinkIssues(textNodes, [{ id: 'p', source: 'c2', target: 'm1', targetArg: 'a' }]);
  assert.equal(Object.keys(bad).length, 1, '文本常量接到加减乘除上要报错参');
});

/* ------------------------------------------------------------------ */
/* 产出种类                                                            */
/* ------------------------------------------------------------------ */

test('数学/随机产出数字 —— 即使 PortKind 写的是 text', () => {
  /*
   * 这是最容易判错的一处：nodeSpec 里 math 的 produces 是 'text'
   * （它的输出确实是文本），但它产出的是**数字文本**。
   * 按 PortKind 判会把"数学 → 比较·大于"标红，
   * 而那是最常见也最该支持的接法。误报比漏报更糟。
   */
  assert.equal(producesArgOf('math'), 'num');
  assert.equal(producesArgOf('random'), 'num');
  assert.equal(producesArgOf('compare'), 'bool');
  assert.equal(producesArgOf('text'), 'text');
});

test('状态标记与透传不参与校验 —— 判成任何具体种类都是猜', () => {
  assert.equal(producesArgOf('wait'), 'unknown', '「等待」产出状态标记，不是数据');
  assert.equal(producesArgOf('loop'), 'unknown');
  assert.equal(producesArgOf('nonexistent'), 'unknown');
});

/* ------------------------------------------------------------------ */
/* 类型校验                                                            */
/* ------------------------------------------------------------------ */

test('上游改成数字运算后，接到「包含」上的线立刻报错', () => {
  /*
   * 用户举的那个例子的连线版：
   *   1. 上游比较选「包含」→ 产出文本      → 接到文本参数，合法
   *   2. 上游改成「大于」  → 产出 bool     → 目标期望文本 → 现在不符了
   *
   * 第 2 步界面上连线没动，只有把"上游产出什么"与"这里期望什么"
   * 重新对一遍才发现。所以校验必须跟着上游的**当前配置**走。
   */
  const nodes = [
    N('src', 'compare', { op: 'gt' }),
    N('dst', 'text', { op: 'concat', a: '', b: 'x' }),
  ];
  const links = paramLinksOf([makeParamEdge('src', 'dst', 'a')]);
  const issues = paramLinkIssues(nodes, links);
  assert.equal(issues.dst?.length, 1, '上游产出 bool，这里要文本');
  assert.equal(issues.dst[0].expect, 'text');
  assert.equal(issues.dst[0].actual, 'bool');
  assert.match(issues.dst[0].message, /上游输出/);
});

test('改回文本产出就恢复绿灯 —— 不能一直红着', () => {
  const nodes = [
    N('src', 'compare', { op: 'contains' }), // 产出 bool，仍然不符
    N('dst', 'text', { op: 'concat', a: '', b: 'x' }),
  ];
  assert.ok(paramLinkIssues(nodes, paramLinksOf([makeParamEdge('src', 'dst', 'a')])).dst);

  const fixed = [N('src', 'text', { op: 'upper', a: 'hi' }), nodes[1]];
  assert.deepEqual(
    paramLinkIssues(fixed, paramLinksOf([makeParamEdge('src', 'dst', 'a')])),
    {},
    '上游产文本 → 绿灯',
  );
});

test('数学 → 比较·大于 必须合法（这是最常见的接法）', () => {
  const nodes = [
    N('m', 'math', { op: 'add', a: '1', b: '2' }),
    N('c', 'compare', { op: 'gt', a: '', b: '5' }),
  ];
  assert.deepEqual(
    paramLinkIssues(nodes, paramLinksOf([makeParamEdge('m', 'c', 'a')])),
    {},
    '数字接数字，不能报',
  );
});

test('期望查得到（argExpectOf 读规则表，不靠探针）', () => {
  assert.equal(argExpectOf('compare', { kind: 'compare', op: 'gt' }, 'a'), 'num');
  assert.equal(argExpectOf('compare', { kind: 'compare', op: 'contains' }, 'a'), 'text');
  assert.equal(argExpectOf('compare', { kind: 'compare', op: 'eq' }, 'a'), 'any');
  assert.equal(argExpectOf('compare', { kind: 'compare', op: 'gt' }, 'zzz'), null, '用不到的参数');
  assert.equal(argExpectOf('math', { kind: 'math', op: 'round' }, 'b'), null, '单目运算不用 b');
});

test('连线的类型问题并进节点校验 → 徽章显示「错参」', () => {
  const nodes = [
    N('src', 'compare', { op: 'gt' }),
    N('dst', 'text', { op: 'concat', a: '', b: 'x' }),
  ];
  const issues = paramLinkIssues(nodes, paramLinksOf([makeParamEdge('src', 'dst', 'a')]));
  const v = validateNode(nodes[1], issues.dst);
  assert.equal(v.level, 'error');
  assert.equal(v.typeError, true);
  assert.equal(badgeTextOf(v), '错参', '而不是「缺参」—— 成因不同，改法也不同');
});

/* ------------------------------------------------------------------ */
/* 排序                                                                */
/* ------------------------------------------------------------------ */

test('参数连线让来源排在目标之前', () => {
  /*
   * 不带 extra 的话 src 与 dst 同层，谁先跑不确定。
   * 目标读 outputs[src] 就会拿到 undefined ——
   * 表现为"连了线却拿到空值"，而界面上连线明明画着。
   */
  const g: Graph = { nodes: [N('dst', 'text'), N('src', 'math')], edges: [] };
  const without = topoLayers(g);
  assert.equal(without.layers.length, 1, '没有依赖时同层');

  const withLink = topoLayers(g, [{ source: 'src', target: 'dst' }]);
  assert.equal(withLink.layers.length, 2);
  assert.deepEqual(withLink.layers[0], ['src']);
  assert.deepEqual(withLink.layers[1], ['dst']);
});

test('同一对节点既有流程边又有参数连线 → 入度不去重会排不进去', () => {
  /*
   * A 既在 B 上游（流程边），又给 B 供参数（参数连线）。
   * 若两条都计入度，B 的入度是 2 而 A 只被消费一次，
   * B 永远等不到入度归零 —— 表现为"流程跑到某处停了"。
   */
  const g: Graph = {
    nodes: [N('a', 'text'), N('b', 'text')],
    edges: [flowEdge('a', 'b')],
  };
  const r = topoLayers(g, [{ source: 'a', target: 'b' }]);
  assert.equal(r.cyclic.length, 0);
  assert.deepEqual(r.layers, [['a'], ['b']]);
});

/* ------------------------------------------------------------------ */
/* 填充                                                                */
/* ------------------------------------------------------------------ */

test('填充不改原对象 —— 循环体每轮都要重算', () => {
  /*
   * 直接改图上那份数据是永久生效的，而循环体每轮执行同一个节点，
   * 第一轮填的值会留到第二轮，表现为"第二轮开始值就不对了"。
   */
  const base = { a: 'old', b: 'keep' };
  const out = applyParamLinks(base, { a: 'new' });
  assert.equal(out.a, 'new');
  assert.equal(base.a, 'old', '原对象不能被改');
  assert.equal(out.b, 'keep', '没连线的参数原样保留');
});

test('同一个参数连两条线只认第一条 —— 否则取值取决于存档里的边顺序', () => {
  const links = paramLinksOf([
    makeParamEdge('x', 'dst', 'a'),
    makeParamEdge('y', 'dst', 'a'),
  ]);
  const into = linksInto(links, 'dst');
  assert.equal(into.length, 1);
  assert.equal(into[0].source, 'x');
});

/* ------------------------------------------------------------------ */
/* 端到端                                                              */
/* ------------------------------------------------------------------ */

test('端到端：连了线，目标参数拿到上游输出', async () => {
  const g: Graph = {
    nodes: [
      N('src', 'const', { items: [{ id: 'c0', value: 'hello' }] }),
      N('dst', 'text', { op: 'upper', a: '', b: '' }),
    ],
    edges: [makeParamEdge('src', 'dst', 'a')],
  };
  const r = await runGraph(g, { onEvent: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.outputs.dst, 'HELLO', 'a 被填成上游输出后转大写');
});

test('端到端：参数连线不会让节点多跑一次', async () => {
  const seen: string[] = [];
  const g: Graph = {
    nodes: [
      N('src', 'const', { items: [{ id: 'c0', value: 'v' }] }),
      N('dst', 'text', { op: 'upper', a: '', b: '' }),
    ],
    edges: [makeParamEdge('src', 'dst', 'a')],
  };
  await runGraph(g, {
    onEvent: (e) => { if (e.type === 'node-done') seen.push(e.id); },
  });
  assert.deepEqual(seen.sort(), ['dst', 'src'], '各跑一次');
});

test('端到端：参数连线成环时报的是参数连线，不是"检测到环"', async () => {
  /*
   * 用户会照着提示去流程里找环，而流程上根本没有环。
   * 必须指名是参数连线，解法是拆掉一条线。
   */
  const g: Graph = {
    nodes: [
      N('a', 'text', { op: 'upper', a: '', b: '' }),
      N('b', 'text', { op: 'upper', a: '', b: '' }),
    ],
    edges: [makeParamEdge('a', 'b', 'a'), makeParamEdge('b', 'a', 'a')],
  };
  const errs: string[] = [];
  const r = await runGraph(g, {
    onEvent: (e) => { if (e.type === 'run-error') errs.push(e.message); },
  });
  assert.equal(r.ok, false);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /参数连线成环/);
  assert.doesNotMatch(errs[0], /^检测到环/);
});

test('参数连线不产生流程依赖：来源被关掉，目标照常跑', async () => {
  /*
   * 这是"不剥掉参数连线"最直接的危害：
   * 参数连线混进 g.edges 后，dst 的 inEdges 里多了一条，
   * 而来源被关掉（skipped）会让 dst 判定成"上游没走到"→ 一并跳过。
   *
   * 于是"我只是想拿它的输出填个参数"变成了"它一关我也停了"，
   * 而画布上看不出这两者有关系。
   */
  const g: Graph = {
    nodes: [
      N('src', 'const', { items: [{ id: 'c0', value: 'v' }], disabled: true }),
      N('dst', 'text', { op: 'upper', a: 'zz', b: '' }),
    ],
    edges: [makeParamEdge('src', 'dst', 'a')],
  };
  const done: string[] = [];
  const r = await runGraph(g, {
    onEvent: (e) => { if (e.type === 'node-done') done.push(e.id); },
  });
  assert.ok(done.includes('dst'), '目标不该被参数连线的来源牵连跳过');
  assert.equal(r.outputs.dst, 'ZZ', '来源没跑，参数用节点上自己的值');
});

/* ------------------------------------------------------------------ */
/* 源码守卫                                                            */
/* ------------------------------------------------------------------ */

import { readSrc } from './srcScan';

/*
 * 下面这批查的是**源码本身**而不是行为。
 *
 * 参数连线有相当一部分价值在"看得见"：紫虚线、箭头、卡片上的输出卡。
 * 这些测试跑不出来（不影响执行结果），界面上也只是"有点怪"，
 * 只有扫源码能逮到 —— 尤其是被上游整份覆盖 styles.css 冲掉之后，
 * 那种覆盖不报错，没人会发现。
 */

const SRC = process.env.AF_SRC || '';
const cssSrc = SRC ? readSrc('styles.css') : '';
const shellSrc = readSrc('components/NodeShell.tsx');
const appSrc = readSrc('App.tsx');
const sanSrc = readSrc('engine/sanitize.ts');

test('参数连线带箭头 —— 没有箭头就分不清"谁的值给谁用"', () => {
  if (!SRC) return;
  const m = cssSrc.match(/\.af-param-edge\s*\{[^}]*\}/);
  assert.ok(m, '.af-param-edge 必须有样式定义');
  /*
   * 虚线是**形状**差异：只靠颜色区分的话，色弱用户完全分不出
   * 参数线与流程线，而"这根是供参数还是走流程"看错会导致
   * "上游一直不执行"这种查不出原因的现象。
   */
  assert.ok(m[0].includes('stroke-dasharray'), '参数线必须是虚线（形状差异，不依赖辨色）');
  /*
   * 箭头：参数连线两端的节点看着完全对等，
   * 没有箭头就只能去猜是上游供值还是下游供值。
   */
  const pl = readSrc('engine/paramLinks.ts');
  assert.ok(/markerEnd:/.test(pl), 'makeParamEdge 要带 markerEnd（方向）');
});

test('出口 handle 走 OUT_HANDLE 常量，不写字面量', () => {
  if (!SRC) return;
  const pl = readSrc('engine/paramLinks.ts');
  const m = pl.match(/OUT_HANDLE\s*=\s*'([^']+)'/);
  assert.ok(m, 'paramLinks 里要有 OUT_HANDLE 常量');

  const shell = readSrc('components/NodeShell.tsx');
  /*
   * 为什么要有这条：
   *
   * isParamHandles 靠 sourceHandle === OUT_HANDLE 判定"这是参数连线"。
   * NodeShell 里若写死成 'out'，改常量那天两者就对不上 ——
   * 症状是"我明明从出口拖到参数格，画出来的却是流程线"，
   * 而排查时根本不会想到是两处字符串不同步。
   */
  assert.ok(
    /id=\{OUT_HANDLE\}/.test(shell),
    'NodeShell 的出口 handle 必须引用 OUT_HANDLE，不能写字面量',
  );
  assert.ok(
    !/id="out"/.test(shell),
    'NodeShell 里不该再出现写死的 id="out"',
  );
});

test('箭头色与 CSS 兜底色是同一个值', () => {
  if (!SRC) return;
  const pl = readSrc('engine/paramLinks.ts');
  const constM = pl.match(/PARAM_COLOR\s*=\s*'(#[0-9a-fA-F]{6})'/);
  assert.ok(constM, 'paramLinks 里要有 PARAM_COLOR 常量');
  const cssM = cssSrc.match(/--af-t-param:\s*(#[0-9a-fA-F]{6})/);
  assert.ok(cssM, 'styles.css 里要定义 --af-t-param');
  /*
   * 箭头色烘在建边那一刻、读不到 CSS 变量，
   * 两边不一致就会出现"线是紫的、箭头是别的色"。
   */
  assert.equal(cssM[1].toLowerCase(), constM[1].toLowerCase(), '两处颜色必须一致');
});

test('argLinkIssues 进了 VIEW_KEYS（不落盘、复制时剥掉）', () => {
  if (!SRC) return;
  const m = sanSrc.match(/VIEW_KEYS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, '找不到 VIEW_KEYS');
  /*
   * 落盘的后果：上游改对了，这里还是红的 ——
   * 而连线一根没动，用户只会以为"改了没生效"。
   */
  assert.ok(m[1].includes('argLinkIssues'), 'VIEW_KEYS 缺 argLinkIssues');
});

test('卡片把参数连线的类型错接进校验 —— 否则改上游仍是绿灯', () => {
  if (!SRC) return;
  assert.ok(shellSrc.includes('argLinkIssues'), 'NodeShell 要读 argLinkIssues');
  /*
   * 必须**传给 validateNode**而不只是读出来：
   * validateNode 的第二参数就是为它准备的，不传等于白读，
   * 表现为上游改成「大于」之后这里依然是绿灯。
   */
  const m = shellSrc.match(/validateNode\(\{[^}]*\},\s*linkIssues\)/);
  assert.ok(m, 'validateNode 要带上 linkIssues');
});

test('App 渲染时把 argLinkIssues 塞进 data', () => {
  if (!SRC) return;
  /*
   * 卡片只拿得到自己那一个节点，扫不到全图 ——
   * 这类"上游产出什么"的问题只能由 App 算好传下去。
   */
  assert.ok(/data\.argLinkIssues\s*=/.test(appSrc), 'App 要把 argLinkIssues 写进 data');
  assert.ok(/paramLinkIssues\(/.test(appSrc), 'App 要调用 paramLinkIssues');
});
