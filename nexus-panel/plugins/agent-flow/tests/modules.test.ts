import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addModule, loadModules, saveModules, removeModule, renameModule, findModule,
  modulePorts, stripRuntimeNodes, expandModules, innerId,
  packSelection, rewireCrossing, canPack,
  moduleEdgesToFlow, flowEdgesToModule,
  exportModules, importModules, MODULES_KEY,
  type ModuleDef, type ModuleEdge, type KV,
} from '../engine/modules';
import { readSrc } from './srcScan';
import { runGraph } from '../engine/runner';
import { stackEdges } from '../engine/stack';

function memKV() {
  const map = new Map<string, string>();
  return { map, get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) };
}

const E = (id: string, s: string, t: string): ModuleEdge => ({ id, source: s, target: t });

/** 造一个 A → B → C 的链 */
function chain() {
  return {
    nodes: [
      { id: 'A', data: { kind: 'const', label: 'A', items: [{ id: 'c0', value: 'a' }] } },
      { id: 'B', data: { kind: 'const', label: 'B', items: [{ id: 'c0', value: '{{A.output}}' }] } },
      { id: 'C', data: { kind: 'const', label: 'C', items: [{ id: 'c0', value: 'c' }] } },
    ],
    edges: [E('e1', 'A', 'B'), E('e2', 'B', 'C')],
  };
}

/* ---------------- 基础 CRUD ---------------- */

test('新增后能读回来', () => {
  const kv = memKV();
  const m = addModule({ name: '备份三步', ...chain() }, kv);
  assert.equal(m.name, '备份三步');
  assert.equal(m.nodes.length, 3);
  assert.equal(loadModules(kv).length, 1);
});

test('删除只删指定那条', () => {
  const kv = memKV();
  const a = addModule({ name: 'A', nodes: [], edges: [] }, kv);
  addModule({ name: 'B', nodes: [], edges: [] }, kv);
  removeModule(a.id, kv);
  assert.equal(loadModules(kv).length, 1);
  assert.equal(loadModules(kv)[0].name, 'B');
});

test('改名：空名不生效', () => {
  const kv = memKV();
  const a = addModule({ name: 'A', nodes: [], edges: [] }, kv);
  renameModule(a.id, '  ', kv);
  assert.equal(loadModules(kv)[0].name, 'A');
  renameModule(a.id, '  B  ', kv);
  assert.equal(loadModules(kv)[0].name, 'B');
});

test('坏 JSON 读出空列表，不抛异常', () => {
  const kv = memKV();
  kv.map.set('agent-flow.modules.v1', '{坏掉的');
  assert.deepEqual(loadModules(kv), []);
});

test('残缺条目被过滤', () => {
  const kv = memKV();
  saveModules([
    { id: 'x', name: 'X', color: '#fff', nodes: [], edges: [], createdAt: 1 },
    { id: '', name: '缺 id', nodes: [], edges: [] } as unknown as ModuleDef,
  ], kv);
  assert.equal(loadModules(kv).length, 1);
});

test('存进模块时是深拷贝：调用方之后改了不影响模块', () => {
  const kv = memKV();
  const input = chain();
  const m = addModule({ name: 'M', ...input }, kv);
  (input.nodes[0] as Record<string, unknown>).id = '改过了';
  assert.equal((m.nodes[0] as Record<string, unknown>).id, 'A');
});

/* ---------------- 接口推导 ---------------- */

test('入口 = 没有上游的内部节点；出口 = 没有下游的', () => {
  const kv = memKV();
  const m = addModule({ name: 'M', ...chain() }, kv);
  const p = modulePorts(m);
  assert.deepEqual(p.entries, ['A']);
  assert.deepEqual(p.exits, ['C']);
});

test('多个入口 / 多个出口都能推导出来', () => {
  const m: ModuleDef = {
    id: 'm', name: 'M', color: '', createdAt: 0,
    nodes: [
      { id: 'A', data: {} }, { id: 'B', data: {} },
      { id: 'C', data: {} }, { id: 'D', data: {} },
    ],
    edges: [E('e1', 'A', 'C'), E('e2', 'B', 'D')],
  };
  const p = modulePorts(m);
  assert.deepEqual(p.entries, ['A', 'B'], 'A 和 B 都没有上游');
  assert.deepEqual(p.exits, ['C', 'D'], 'C 和 D 都没有下游');
});

test('孤立节点既是入口也是出口', () => {
  const m: ModuleDef = {
    id: 'm', name: 'M', color: '', createdAt: 0,
    nodes: [{ id: 'A', data: {} }], edges: [],
  };
  const p = modulePorts(m);
  assert.deepEqual(p.entries, ['A']);
  assert.deepEqual(p.exits, ['A']);
});

test('空模块没有出入口', () => {
  const m: ModuleDef = { id: 'm', name: 'M', color: '', createdAt: 0, nodes: [], edges: [] };
  const p = modulePorts(m);
  assert.deepEqual(p.entries, []);
  assert.deepEqual(p.exits, []);
});

/* ---------------- 运行时字段清理 ---------------- */

test('存模块前剥掉 status / output / error', () => {
  const cleaned = stripRuntimeNodes([
    { id: 'A', data: { kind: 'const', status: 'success', output: '旧输出', error: '', items: [{ id: 'c0', value: 'x' }] } },
  ]);
  const d = (cleaned[0] as { data: Record<string, unknown> }).data;
  assert.equal(d.status, undefined);
  assert.equal(d.output, undefined);
  assert.deepEqual(d.items, [{ id: 'c0', value: 'x' }], '配置字段要保留');
});

test('剥掉 last* 前缀的运行时字段', () => {
  const cleaned = stripRuntimeNodes([
    { id: 'A', data: { kind: 'x', lastSha: 'abc', lastCommit: 'c1', label: 'L' } },
  ]);
  const d = (cleaned[0] as { data: Record<string, unknown> }).data;
  assert.equal(d.lastSha, undefined);
  assert.equal(d.lastCommit, undefined);
  assert.equal(d.label, 'L');
});

/**
 * 这条守一个很隐蔽的问题：不剥运行时字段的话，
 * 拖出来的新实例会带着 status='success' 和旧 output ——
 * 看起来"已经跑完了"，实际一次都没跑。
 */
test('不清理会导致实例看起来已经跑过（反面用例）', () => {
  const raw = [{ id: 'A', data: { kind: 'const', status: 'success', output: '旧' } }];
  const cleaned = stripRuntimeNodes(raw);
  assert.equal((cleaned[0] as { data: Record<string, unknown> }).data.status, undefined);
  assert.notEqual((raw[0] as { data: Record<string, unknown> }).data.status, undefined);
});

/* ---------------- 展开 ---------------- */

type N = { id: string; data?: Record<string, unknown> };

function modNode(id: string, moduleId: string, inner: unknown = null) {
  return { id, data: { kind: 'module', label: 'M', moduleId, inner, status: 'idle', output: '', error: '' } };
}

test('展开：内部节点带上实例前缀', () => {
  const def = { ...chain(), id: 'md1', name: 'M', color: '', createdAt: 0 };
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')] as N[], edges: [] },
    () => def,
  );
  const ids = g.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['inst__A', 'inst__B', 'inst__C']);
});

test('展开：内部边两端都改写', () => {
  const def = { ...chain(), id: 'md1', name: 'M', color: '', createdAt: 0 };
  const g = expandModules({ nodes: [modNode('inst', 'md1')] as N[], edges: [] }, () => def);
  const e = g.edges.find((x) => x.source === 'inst__A');
  assert.ok(e, 'A→B 的边应被改写');
  assert.equal(e!.target, 'inst__B');
});

/**
 * 这条守一个不报错但功能失效的坑：
 * 内部节点互相引用 {{A.output}}，展开后 A 变成了 inst__A，
 * 不重写模板就取不到值 —— 而失效不报错，只是渲染成空串。
 */
test('展开：内部模板引用要改写成新 id', () => {
  const def = { ...chain(), id: 'md1', name: 'M', color: '', createdAt: 0 };
  const g = expandModules({ nodes: [modNode('inst', 'md1')] as N[], edges: [] }, () => def);
  const b = g.nodes.find((n) => n.id === 'inst__B') as N;
  /*
   * 常量只有 items 一组数据 —— 模板引用在**卡里**，
   * 展开时 rewriteData 递归改写了数组，所以这里读 items[0].value。
   * 只读顶层 value 的话，漏改的表现是模板渲染成空串，不报错。
   */
  assert.deepEqual(b.data?.items, [{ id: 'c0', value: '{{inst__A.output}}' }]);
});

test('展开：外部 → 模块 接到每个入口', () => {
  const def = { ...chain(), id: 'md1', name: 'M', color: '', createdAt: 0 };
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')] as N[], edges: [{ id: 'x1', source: 'up', target: 'inst' }] },
    () => def,
  );
  const inEdge = g.edges.find((e) => e.source === 'up');
  assert.equal(inEdge?.target, 'inst__A');
});

test('展开：模块 → 外部 从每个出口连出', () => {
  const def = { ...chain(), id: 'md1', name: 'M', color: '', createdAt: 0 };
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')] as N[], edges: [{ id: 'x1', source: 'inst', target: 'down' }] },
    () => def,
  );
  const outEdge = g.edges.find((e) => e.target === 'down');
  assert.equal(outEdge?.source, 'inst__C');
});

test('展开：多入口时外部输入接到每个入口', () => {
  const def: ModuleDef = {
    id: 'md1', name: 'M', color: '', createdAt: 0,
    nodes: [{ id: 'A', data: {} }, { id: 'B', data: {} }],
    edges: [],
  };
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')] as N[], edges: [{ id: 'x1', source: 'up', target: 'inst' }] },
    () => def,
  );
  const toModule = g.edges.filter((e) => e.source === 'up').map((e) => e.target).sort();
  assert.deepEqual(toModule, ['inst__A', 'inst__B']);
});

test('展开：模块 → 模块 是笛卡尔积', () => {
  const def: ModuleDef = {
    id: 'md1', name: 'M', color: '', createdAt: 0,
    nodes: [{ id: 'A', data: {} }, { id: 'B', data: {} }],
    edges: [E('i', 'A', 'B')],
  };
  const g = expandModules(
    {
      nodes: [modNode('m1', 'md1'), modNode('m2', 'md1')] as N[],
      edges: [{ id: 'x1', source: 'm1', target: 'm2' }],
    },
    () => def,
  );
  // m1 出口 = B，m2 入口 = A → 一条边
  const between = g.edges.filter((e) => e.source === 'm1__B' && e.target === 'm2__A');
  assert.equal(between.length, 1);
});

test('展开：脱钩的实例用自己的 inner，不查模块库', () => {
  const ownInner = { nodes: [{ id: 'Z', data: { kind: 'const', items: [{ id: 'c0', value: 'z' }] } }], edges: [] };
  const g = expandModules(
    { nodes: [modNode('inst', 'md1', ownInner)] as N[], edges: [] },
    () => null,   // 模块库里查不到
  );
  assert.deepEqual(g.nodes.map((n) => n.id), ['inst__Z']);
});

test('展开：模块被删了留下占位节点，不崩', () => {
  const g = expandModules({ nodes: [modNode('inst', 'gone')] as N[], edges: [] }, () => null);
  assert.equal(g.nodes.length, 1);
  assert.equal((g.nodes[0] as N).data?.error, '模块已删除');
});

test('展开：非模块节点原样保留', () => {
  const g = expandModules(
    { nodes: [{ id: 'p', data: { kind: 'const', items: [{ id: 'c0', value: 'x' }] } }] as N[], edges: [] },
    () => null,
  );
  assert.deepEqual(g.nodes, [{ id: 'p', data: { kind: 'const', items: [{ id: 'c0', value: 'x' }] } }]);
});

test('展开：内部节点重置为待运行（不带旧结果）', () => {
  const def: ModuleDef = {
    id: 'md1', name: 'M', color: '', createdAt: 0,
    nodes: [{ id: 'A', data: { kind: 'const', status: 'success', output: '旧' } }],
    edges: [],
  };
  const g = expandModules({ nodes: [modNode('inst', 'md1')] as N[], edges: [] }, () => def);
  assert.equal((g.nodes[0] as N).data?.status, 'idle');
  assert.equal((g.nodes[0] as N).data?.output, '');
});

test('innerId 用双下划线分隔', () => {
  assert.equal(innerId('m1', 'A'), 'm1__A');
});

/* ---------------- 导入导出 ---------------- */

test('导出再导入能还原', () => {
  const from = memKV();
  addModule({ name: '备份三步', ...chain() }, from);
  const to = memKV();
  const r = importModules(exportModules(from), undefined, to);
  assert.equal(r.added, 1);
  assert.equal(loadModules(to)[0].name, '备份三步');
  assert.equal(loadModules(to)[0].nodes.length, 3);
});

test('重复导入按 id 更新，不堆副本', () => {
  const from = memKV();
  const a = addModule({ name: 'v1', nodes: [], edges: [] }, from);
  const json = exportModules(from);
  const to = memKV();
  importModules(json, undefined, to);
  saveModules([{ ...findModule(a.id, from)!, name: 'v2' }], from);
  const r2 = importModules(exportModules(from), undefined, to);
  assert.equal(r2.updated, 1);
  assert.equal(loadModules(to).length, 1);
  assert.equal(loadModules(to)[0].name, 'v2');
});

test('replace 模式清掉本机原有的', () => {
  const to = memKV();
  addModule({ name: '本机旧的', nodes: [], edges: [] }, to);
  const from = memKV();
  addModule({ name: '导入的', nodes: [], edges: [] }, from);
  importModules(exportModules(from), { mode: 'replace' }, to);
  assert.equal(loadModules(to).length, 1);
  assert.equal(loadModules(to)[0].name, '导入的');
});

/*
 * 【破坏性】replace 模式：文件全是坏条目时，不能顺带清空本机原有的。
 *
 * 与自定义预设、变量是同一份结构（engine/impExp.ts 里共用一条防线）。
 */
test('replace 模式：文件里一条都没通过校验时，原有的模块必须保住', () => {
  const to = memKV();
  addModule({ name: '我原有的', nodes: [], edges: [] }, to);
  const bad = JSON.stringify({
    version: 1,
    modules: [
      { id: 'x', name: 'nodes 不是数组', nodes: 'nope', edges: [] },
      { id: 'y', name: 'edges 不是数组', nodes: [], edges: 'nope' },
    ],
  });
  assert.throws(
    () => importModules(bad, { mode: 'replace' }, to),
    /已保留/,
    '要把"原有的没动"说出口，不能只报跳过',
  );
  assert.equal(loadModules(to).length, 1, '原有的一个都不能少');
  assert.equal(loadModules(to)[0].name, '我原有的');
});

/* 上面那条的反面：列表本身是空的，那是明确要清空，不能拦 */
test('replace 模式：列表本身为空时照常清空（明确意图，不是文件坏了）', () => {
  const to = memKV();
  addModule({ name: '我原有的', nodes: [], edges: [] }, to);
  const r = importModules(JSON.stringify({ version: 1, modules: [] }), { mode: 'replace' }, to);
  assert.equal(r.added + r.updated, 0);
  assert.equal(loadModules(to).length, 0);
});

test('导入非 JSON / 没有模块列表都要给出可读错误', () => {
  assert.throws(() => importModules('不是JSON', undefined, memKV()), /JSON/);
  assert.throws(() => importModules('{"foo":1}', undefined, memKV()), /模块列表/);
});

/* ================= 打包（把选中节点合成模块） ================= */

const PN = (id: string, x: number, y: number, data: Record<string, unknown> = { kind: 'task' }) =>
  ({ id, position: { x, y }, data });

test('canPack：空集合不行', () => {
  assert.equal(canPack([]).ok, false);
  assert.ok(canPack([]).reason?.includes('还没选'));
});

test('canPack：有节点就行', () => {
  assert.equal(canPack([PN('a', 0, 0)]).ok, true);
});

test('内部边两端都在集合里才保留', () => {
  const r = packSelection(
    [PN('a', 0, 0), PN('b', 100, 0), PN('c', 200, 0)],
    [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
      { id: 'e3', source: 'a', target: 'c' },
    ],
  );
  assert.equal(r.edges.length, 3);
  assert.equal(r.crossing.length, 0);
});

/** 跨边界的边必须摘出来 —— 丢掉会让外部接线静默断掉 */
test('跨边界的边被摘成 crossing', () => {
  const r = packSelection(
    [PN('a', 0, 0), PN('b', 100, 0)],
    [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'outer1', target: 'a' },
      { id: 'e3', source: 'b', target: 'outer2' },
    ],
  );
  assert.equal(r.edges.length, 1, '只剩内部那条');
  assert.equal(r.crossing.length, 2);
  assert.deepEqual(r.crossing.map((c) => c.kind).sort(), ['in', 'out']);
});

test('crossing 分清里外端', () => {
  const r = packSelection(
    [PN('a', 0, 0)],
    [
      { id: 'e1', source: 'outer1', target: 'a' },
      { id: 'e2', source: 'a', target: 'outer2' },
    ],
  );
  const inc = r.crossing.find((c) => c.kind === 'in');
  const outc = r.crossing.find((c) => c.kind === 'out');
  assert.equal(inc?.outer, 'outer1');
  assert.equal(inc?.inner, 'a');
  assert.equal(outc?.outer, 'outer2');
  assert.equal(outc?.inner, 'a');
});

/** 不减原点的后果：模块拖到别处时内部布局全挤在左上角 */
test('内部坐标减去原点', () => {
  const r = packSelection(
    [PN('a', 500, 300), PN('b', 700, 300)],
    [],
  );
  const a = r.nodes[0] as { position: { x: number; y: number } };
  assert.equal(a.position.x, 0);
  assert.equal(a.position.y, 0);
  const b = r.nodes[1] as { position: { x: number; y: number } };
  assert.equal(b.position.x, 200, '相对距离要保留');
});

test('模块节点放在选中区域中心，不跳位', () => {
  const r = packSelection([PN('a', 0, 0), PN('b', 200, 100)], []);
  assert.equal(r.at.x, 100);
  assert.equal(r.at.y, 50);
});

/** stackParent 不剥的话，内部节点还"嵌合"在外部节点上，展开时指向不存在的地方 */
test('剥掉显示状态：stackParent / stackCollapsed（但保留配置 size）', () => {
  const r = packSelection(
    [PN('a', 0, 0, { kind: 'task', stackParent: '外面的节点', size: 'tall', stackCollapsed: true })],
    [],
  );
  const d = (r.nodes[0] as { data: Record<string, unknown> }).data;
  assert.equal(d.stackParent, undefined);
  /*
   * size 要留着 —— 它是用户设的卡片高度。以前也在这份清单里被一起剥掉，
   * 表现为"存成模块后卡片高度回到默认"，且不报错。
   */
  assert.equal(d.size, 'tall', '显示高度是配置，存模块要带走');
  assert.equal(d.stackCollapsed, undefined);
  assert.equal(d.kind, 'task', '配置字段得留着');
});

test('剥掉运行时字段', () => {
  const r = packSelection(
    [PN('a', 0, 0, { kind: 'task', status: 'success', output: '旧输出', lastSha: 'x' })],
    [],
  );
  const d = (r.nodes[0] as { data: Record<string, unknown> }).data;
  assert.equal(d.status, undefined);
  assert.equal(d.output, undefined);
  assert.equal(d.lastSha, undefined);
});

/* ================= 跨边界边重新接线 ================= */

test('进来的边改挂到实例上', () => {
  const out = rewireCrossing('m1', [{ kind: 'in', outer: 'x', inner: 'a' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'x');
  assert.equal(out[0].target, 'm1');
});

test('出去的边改挂到实例上', () => {
  const out = rewireCrossing('m1', [{ kind: 'out', outer: 'y', inner: 'a' }]);
  assert.equal(out[0].source, 'm1');
  assert.equal(out[0].target, 'y');
});

/** 不去重会叠出多条一样的边，删的时候要删好几次 */
test('多条内部节点连到同一个外部节点时要去重', () => {
  const out = rewireCrossing('m1', [
    { kind: 'out', outer: 'y', inner: 'a' },
    { kind: 'out', outer: 'y', inner: 'b' },
    { kind: 'out', outer: 'y', inner: 'c' },
  ]);
  assert.equal(out.length, 1, '三条应合成一条');
});

test('不同目标不去重', () => {
  const out = rewireCrossing('m1', [
    { kind: 'out', outer: 'y', inner: 'a' },
    { kind: 'out', outer: 'z', inner: 'a' },
  ]);
  assert.equal(out.length, 2);
});

/** 条件分支用的 branch 必须带过去，否则分支信息丢失 */
test('branch / loopRole 跟着边一起迁移', () => {
  const out = rewireCrossing('m1', [
    { kind: 'out', outer: 'y', inner: 'a', branch: 'yes' },
    { kind: 'out', outer: 'y', inner: 'b', branch: 'no' },
  ]);
  assert.equal(out.length, 2, 'branch 不同就该是两条边');
  assert.deepEqual(out.map((e) => e.branch).sort(), ['no', 'yes']);
});

test('空输入不炸', () => {
  assert.deepEqual(rewireCrossing('m1', []), []);
  const r = packSelection([], []);
  assert.equal(r.nodes.length, 0);
  assert.equal(r.crossing.length, 0);
});


/* ---------------- 嵌合的串存成模块不能丢连接 ---------------- */

/*
 * 嵌合关系存在 stackParent 上，而打包时它被当作显示状态剥掉。
 * 不把隐式边补成真实边的话：存进模块的几个节点彼此不再相连，
 * 拖出来表现为"莫名其妙跑不起来"，而存的时候没有任何提示。
 */

test('嵌合成串的节点存成模块后仍有连接', () => {
  const ns = [
    { id: 'A', position: { x: 0, y: 0 }, data: { kind: 'a' } },
    { id: 'B', position: { x: 0, y: 90 }, data: { kind: 'b', stackParent: 'A' } },
    { id: 'C', position: { x: 0, y: 180 }, data: { kind: 'c', stackParent: 'B' } },
  ];
  const r = packSelection(ns as never, [] as never, ns as never);
  const pairs = r.edges.map((e) => `${e.source}->${e.target}`).sort();
  assert.deepEqual(pairs, ['A->B', 'B->C']);
});

test('已经拉过线就不再补嵌合边（避免重复触发）', () => {
  const ns = [
    { id: 'A', position: { x: 0, y: 0 }, data: {} },
    { id: 'B', position: { x: 0, y: 90 }, data: { stackParent: 'A' } },
  ];
  // A→B 既嵌合又拉了线：只保留显式那条（它可能带 branch 信息）
  const r = packSelection(ns as never, [{ id: 'e1', source: 'A', target: 'B' }] as never, ns as never);
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].id, 'e1');
});

test('嵌合的跨边界连接要变成 crossing', () => {
  const ns = [
    { id: 'A', position: { x: 0, y: 0 }, data: {} },
    { id: 'B', position: { x: 0, y: 90 }, data: { stackParent: 'A' } },
  ];
  // 只选中 A：B 在外面，"A → B" 该算模块的出边
  const r = packSelection([ns[0]] as never, [] as never, ns as never);
  const outs = r.crossing.filter((c) => c.kind === 'out');
  assert.equal(outs.length, 1);
  assert.equal(outs[0].inner, 'A');
  assert.equal(outs[0].outer, 'B');
});

test('不传全图节点时，跨边界的嵌合边算不出来（退化为只补内部）', () => {
  const ns = [
    { id: 'A', position: { x: 0, y: 0 }, data: {} },
    { id: 'B', position: { x: 0, y: 90 }, data: { stackParent: 'A' } },
  ];
  // 只选中 A，且不传 allNodes —— 子上才存着 stackParent，而 B 不在集合里
  const r = packSelection([ns[0]] as never, [] as never);
  assert.deepEqual(r.crossing, []);
  assert.deepEqual(r.edges, []);
});

test('存进模块的节点不带运行时状态', () => {
  const ns = [
    { id: 'A', position: { x: 0, y: 0 }, data: { status: 'success', output: '旧输出' } },
  ];
  const r = packSelection(ns as never, [] as never, ns as never);
  const d = r.nodes[0] as { data: Record<string, unknown> };
  // 带着"已跑完"存进去，拖出来会看起来像执行过了
  assert.equal('status' in d.data, false);
  assert.equal('output' in d.data, false);
});

test('存进模块的节点不带 stackParent（否则展开时指向不存在的父）', () => {
  const ns = [
    { id: 'A', position: { x: 0, y: 0 }, data: {} },
    { id: 'B', position: { x: 0, y: 90 }, data: { stackParent: 'A' } },
  ];
  const r = packSelection(ns as never, [] as never, ns as never);
  const d = r.nodes[1] as { data: Record<string, unknown> };
  assert.equal('stackParent' in d.data, false);
});

test('内部坐标要减原点（否则拖出来跑到画布左上角）', () => {
  const ns = [
    { id: 'A', position: { x: 500, y: 300 }, data: {} },
    { id: 'B', position: { x: 500, y: 390 }, data: { stackParent: 'A' } },
  ];
  const r = packSelection(ns as never, [] as never, ns as never);
  assert.equal((r.nodes[0] as { position: { x: number } }).position.x, 0);
  assert.equal((r.nodes[0] as { position: { y: number } }).position.y, 0);
  assert.equal((r.nodes[1] as { position: { y: number } }).position.y, 90);
});

/* ------------------------------------------------------------------ */
/* 参数连线进出模块                                                    */
/* ------------------------------------------------------------------ */

/*
 * 存为模块时，参数连线必须**还是参数连线**。
 *
 * 丢掉 targetArg 的后果不是"少显示一点"：
 * 重建出来的边没有 data.kind='param'，于是被当成流程边 ——
 * "我只是想取个值"变成"多一条执行路径"，目标节点会多跑一次。
 * 而界面上只是线变了个颜色，没有任何提示。
 */

const PE = (id: string, s: string, t: string, arg: string) => ({
  id, source: s, target: t,
  data: { kind: 'param', targetArg: arg },
} as never);

test('模块内部的参数连线存下来还是参数连线', () => {
  const r = packSelection(
    [PN('src', 0, 0), PN('dst', 100, 0)],
    [PE('p1', 'src', 'dst', 'a') as never],
  );
  assert.equal(r.crossing.length, 0, '两端都在里面，不算跨边界');
  assert.equal(r.edges.length, 1);
  assert.equal(
    (r.edges[0] as { targetArg?: string }).targetArg, 'a',
    'targetArg 必须跟着进模块定义，否则展开后变流程边',
  );
});

test('跨进模块的参数连线，重挂后仍是参数连线', () => {
  const r = packSelection(
    [PN('dst', 100, 0)],
    [PE('p1', 'outer1', 'dst', 'a') as never],
  );
  assert.equal(r.crossing.length, 1);
  assert.equal(r.crossing[0].kind, 'in');
  assert.equal(r.crossing[0].targetArg, 'a', '跨边界时 targetArg 不能丢');

  const rewired = rewireCrossing('m1', r.crossing) as { targetArg?: string }[];
  assert.equal(rewired.length, 1);
  assert.equal(rewired[0].targetArg, 'a', '重挂到模块实例上后仍是参数连线');
});

test('同一外部节点给两个不同参数供值，去重不能吃掉其中一条', () => {
  /*
   * 去重键若不含 targetArg，这两条会被当成同一条 ——
   * 表现为存完模块莫名少一条参数连线，而看不出少的是哪条。
   */
  const crossing = [
    { kind: 'in' as const, outer: 'x', inner: 'a', targetArg: 'a' },
    { kind: 'in' as const, outer: 'x', inner: 'a', targetArg: 'b' },
  ];
  const out = rewireCrossing('m1', crossing) as { targetArg?: string }[];
  assert.equal(out.length, 2, '两个不同参数要各自保留');
  assert.deepEqual(out.map((e) => e.targetArg).sort(), ['a', 'b']);
});

test('展开模块时参数连线还原成完整边形状（data.kind 在）', () => {
  /*
   * 存档里只存 targetArg，而 isParamEdge 看的是 data.kind。
   * 展开时不还原就会变成普通流程线。
   */
  const def: ModuleDef = {
    id: 'md1', name: 'm', at: '', nodes: [PN('dst', 0, 0) as never],
    edges: [{ id: 'e1', source: 'src', target: 'dst', targetArg: 'a' }],
  } as unknown as ModuleDef;
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')], edges: [] } as never,
    () => def,
  );
  const e = (g.edges as { data?: { kind?: string } }[]).find((x) => (x as { id?: string }).id?.includes('e1'));
  assert.ok(e, '边要展开出来');
  assert.equal(e?.data?.kind, 'param', '展开后必须还是参数连线');
});

test('普通流程边展开时不带多余字段（不制造 targetArg）', () => {
  const def: ModuleDef = {
    id: 'md1', name: 'm', at: '', nodes: [],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  } as unknown as ModuleDef;
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')], edges: [] } as never,
    () => def,
  );
  const e = (g.edges as { data?: unknown }[])[0];
  assert.equal(e?.data, undefined, '流程边不该被塞上 data');
});

/* ---------------- 密钥脱敏（模块是导出分享的，不能带明文） ---------------- */

/** 带内联密钥的一批节点：GitHub 令牌、大模型密钥、请求头里的 Authorization */
function secretPicked() {
  return [
    { id: 'a1', position: { x: 0, y: 0 }, data: { kind: 'github-push', token: 'ghp_SUPERSECRET', owner: 'o', repo: 'r' } },
    { id: 'a2', position: { x: 100, y: 0 }, data: { kind: 'llm', llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-live-XXXX' } } },
    { id: 'a3', position: { x: 200, y: 0 }, data: { kind: 'generic-http', headersText: 'Authorization: Bearer sk-live-YYYY\nX-A: 1' } },
  ] as never[];
}

const SECRETS = ['ghp_SUPERSECRET', 'sk-live-XXXX', 'Bearer sk-live-YYYY'];

test('打包进模块的节点不带明文密钥', () => {
  /*
   * 画布存档走 redactNodes（空串），而模块以前**完全不脱敏** ——
   * 同一个节点"存在画布里是空串、存成模块是明文"，且不报错。
   * 模块是要导出给别人用的，明文等于把令牌贴出去。
   */
  const packed = packSelection(secretPicked(), []);
  const s = JSON.stringify(packed.nodes);
  for (const sec of SECRETS) {
    assert.ok(!s.includes(sec), `打包结果里不该有明文 ${sec}`);
  }
  // 非密钥的业务字段要原样留下，不能连带剥掉
  assert.ok(s.includes('gpt-4o'), '模型名不是密钥，要保留');
  assert.ok(s.includes('"owner":"o"'), '仓库名不是密钥，要保留');
});

test('模块落库后 localStorage 里没有明文密钥', () => {
  const kv = memKV();
  addModule({ name: '含密钥', nodes: secretPicked() as never, edges: [] }, kv);
  const raw = kv.get(MODULES_KEY) ?? '';
  for (const sec of SECRETS) {
    assert.ok(!raw.includes(sec), `localStorage 里不该有明文 ${sec}`);
  }
});

test('导出模块文件时没有明文密钥（含修复前已存下的旧数据）', () => {
  /*
   * 存时脱敏只保证"以后不再新写明文"。
   * 老用户的 localStorage 里已经躺着脱敏之前写进去的那批 ——
   * 只在存时脱，导出照样把旧明文带走。所以导出必须再脱一遍。
   */
  const kv = memKV();
  saveModules([{
    id: 'md-old', name: '旧模块', color: '#f59e0b', createdAt: 0,
    nodes: secretPicked() as Record<string, unknown>[],
    edges: [],
  }] as ModuleDef[], kv);
  const json = exportModules(kv);
  for (const sec of SECRETS) {
    assert.ok(!json.includes(sec), `导出的模块文件里不该有明文 ${sec}`);
  }
});

test('导入含明文密钥的模块文件，落库时不带明文', () => {
  /* 导入的文件可能来自别人的机器 —— 不能把对方的密钥写进自己的存储 */
  const kv = memKV();
  const file = JSON.stringify({
    version: 1,
    modules: [{
      id: 'md-x', name: '别人的模块', color: '#f59e0b', createdAt: 0,
      nodes: secretPicked(), edges: [],
    }],
  });
  importModules(file, undefined, kv);
  const raw = kv.get(MODULES_KEY) ?? '';
  for (const sec of SECRETS) {
    assert.ok(!raw.includes(sec), `导入后不该有明文 ${sec}`);
  }
});

/* ---------------- 源码守卫：出口都要过同一份判定 ---------------- */

test('源码守卫：模块的三个出口都调用 redactNodes（不各写一份）', () => {
  /*
   * 只盯"有没有脱敏"不够 —— 各写一份判定也能通过，
   * 而抄一份必然漂移（webhook token 那次就是这样）。
   * 所以盯的是：都调用 ./sanitize 的同一个 redactNodes。
   */
  const src = readSrc('engine/modules.ts');
  const bodies = ['addModule', 'exportModules', 'importModules', 'packSelection'];
  for (const fn of bodies) {
    const at = src.indexOf(`function ${fn}`);
    assert.ok(at >= 0, `源码里要有 ${fn}`);
    /*
     * 只截到本函数结束（顶层收尾的 `}` 在行首）。
     *
     * 截到文件末尾的话，去掉 addModule 里的调用照样能过 ——
     * 因为后面的 exportModules 里还有一处。那种"过了"是假的：
     * 它证明的是"文件里某处有调用"，不是"每个出口都调用了"。
     * 这正是本轮要防的那类失效，守卫自己不能踩。
     */
    const end = src.indexOf('\n}', at);
    const body = end > 0 ? src.slice(at, end) : src.slice(at, at + 2000);
    assert.ok(/redactNodes\s*\(/.test(body), `${fn} 必须调用 redactNodes（共用一份判定）`);
  }
});

/*
 * 脱敏收在 saveModules（唯一写入口），而不是各调用点各写一份。
 *
 * 以前是"谁要存谁自己记得脱敏"，结果漏了一条：
 *   · addModule（从选区打包）—— 记得了
 *   · App 的 exitModuleEdit（编辑模块库里的模块再保存）—— 忘了，
 *     只调了 stripRuntimeNodes。于是同一个节点"存在画布里是空串、
 *     存到模块里是明文"，且不报错：导出时 exportModules 还会再脱一层，
 *     所以表面看不出问题，明文只是静静躺在本地。
 *
 * 各调用点各写一份，正是漏一条的成因 —— 所以收在写入口统一兜住。
 * 这条是**行为**测试：扫源码的守卫会漏掉"新增一个调用点但忘了脱敏"
 * （那行代码本身没毛病），只有跑一遍才看得出。
 */
test('存模块：任何写入路径都脱敏（编辑模块库再保存也算）', () => {
  const kv = memKV();
  const dirty = [{
    id: 'n1',
    data: { kind: 'genericHttp', url: 'https://x/api', token: 'ghp_PLAIN', headersText: 'Authorization: Bearer sk-live-x' },
  }];

  /* 模拟 App 的 exitModuleEdit：绕过 addModule，直接 saveModules */
  saveModules(
    [{ id: 'm1', name: 'x', color: '#fff', nodes: dirty, edges: [], createdAt: 0, paramRefs: [] }] as unknown as ModuleDef[],
    kv,
  );

  const back = loadModules(kv)[0].nodes[0].data as Record<string, unknown>;
  assert.equal(back.token, '', 'token 必须挖空 —— 明文落在 localStorage 与"密钥一律不落盘"冲突');
  assert.equal(back.headersText, 'Authorization:', '请求头里的 Bearer 也要挖掉（值里的凭据）');
});

test('存模块：只挖密钥，业务字段要留着（挖过了就是"存完配置没了"）', () => {
  const kv = memKV();
  saveModules(
    [{
      id: 'm1', name: 'x', color: '#fff', createdAt: 0, paramRefs: [],
      nodes: [{ id: 'n1', data: { kind: 'genericHttp', url: 'https://x/api', method: 'POST', token: 'ghp_x' } }],
      edges: [],
    }] as unknown as ModuleDef[],
    kv,
  );
  const back = loadModules(kv)[0].nodes[0].data as Record<string, unknown>;
  assert.equal(back.url, 'https://x/api', '普通配置要保留');
  assert.equal(back.method, 'POST', '普通配置要保留');
  assert.equal(back.token, '', '密钥要挖空');
});

/*
 * 不为脱敏把整条写坏。
 *
 * 断言只写"不抛"是刻意的：没有 nodes 的条目本来就过不了 isDef，
 * loadModules 会把它滤掉 —— 那是**既有的**读取行为，与本轮无关。
 * 若断言成"读回来还有一条"，测的就不是脱敏，而是去改了校验口径。
 */
test('存模块：条目没有 nodes 数组时不炸（不能为了脱敏把整条写坏）', () => {
  const kv = memKV();
  assert.doesNotThrow(() => {
    saveModules([{ id: 'm1', name: 'x' }] as unknown as ModuleDef[], kv);
  }, '没有 nodes 的条目不能让写入崩掉');
});

/* ------------------------------------------------------------------ */
/* 模块编辑：边进出模块库                                              */
/* ------------------------------------------------------------------ */

/*
 * 编辑模块内部时借用主画布，于是模块的边要"搬"到画布上、改完再搬回去。
 *
 * 而**两边存的形状不一样**：
 *   · 模块边（ModuleEdge）：branch / loopRole / targetArg 在**顶层**
 *   · 画布边（FlowEdge）：这些东西全在 **data** 里
 *
 * 以前 App 里进和出各写了一份内联映射，而它们合起来是坏的：
 * 进去时 `{...e}` 原样搬（字段落到顶层），出来时读 `e.data?.branch`。
 *
 * 净结果：**进入模块编辑、什么都没改、点「完成」** ——
 * 模块内部的条件分支（branch）、循环出口（loopRole）、
 * 参数连线（targetArg）**全部静默丢失**。用户什么都没做，模块就坏了。
 *
 * 所以收成 moduleEdgesToFlow / flowEdgesToModule 这一对，
 * 下面盯的是"往返之后一个字段都不少"。
 */

test('模块边 → 画布边：参数连线还原成完整边形状', () => {
  const out = moduleEdgesToFlow([
    { id: 'p1', source: 'src', target: 'dst', targetArg: 'a' },
  ]) as { id?: string; type?: string; data?: Record<string, unknown> }[];
  assert.equal(out.length, 1);
  assert.equal(out[0].data?.kind, 'param', '没有 data.kind 就会被当成流程边');
  assert.equal(out[0].data?.targetArg, 'a');
  assert.equal(out[0].type, 'param', '不设 type 会画成普通流程线');
  assert.equal(out[0].id, 'p1', 'id 要沿用，编辑期间靠它认边');
});

test('模块边 → 画布边：branch / loopRole 放进 data（画布就是这么读的）', () => {
  const out = moduleEdgesToFlow([
    { id: 'e1', source: 'c', target: 'y', branch: 'yes' },
    { id: 'e2', source: 'lp', target: 'b', loopRole: 'body' },
  ]) as { data?: Record<string, unknown> }[];
  assert.equal(out[0].data?.branch, 'yes');
  assert.equal(out[1].data?.loopRole, 'body');
});

test('编辑模块往返：什么都没改，字段也不许少', () => {
  /*
   * 这条是整个模块编辑路径的回归测试。
   *
   * 以前"进去再出来"就会把 branch / loopRole / targetArg 全抹掉，
   * 而用户看到的只是"我打开看了一眼，模块好像坏了"。
   */
  const stored: ModuleEdge[] = [
    { id: 'e1', source: 'c', target: 'y', branch: 'yes' },
    { id: 'e2', source: 'c', target: 'n', branch: 'no' },
    { id: 'e3', source: 'lp', target: 'b', loopRole: 'body' },
    { id: 'e4', source: 'lp', target: 'd', loopRole: 'done' },
    { id: 'p1', source: 'src', target: 'dst', targetArg: 'a', sourceArg: 'title' },
  ];
  const round = flowEdgesToModule(moduleEdgesToFlow(stored));
  assert.deepEqual(round, stored, '往返之后必须与原来逐字段一致');
});

test('画布边 → 模块边：参数连线带住 targetArg（保存时不能丢）', () => {
  /*
   * 以前保存模块时只搬 branch / loopRole，targetArg 整条丢掉 ——
   * 模块里"我只是想取个值"的线，编辑保存后消失，界面上只是少一根线。
   */
  const out = flowEdgesToModule([
    { id: 'p1', source: 'src', target: 'dst', data: { kind: 'param', targetArg: 'a', sourceArg: 'title' } },
  ]);
  assert.equal(out[0].targetArg, 'a');
  assert.equal(out[0].sourceArg, 'title', '副输出也要带住，否则展开后取到主输出');
});

/* ------------------------------------------------------------------ */
/* 多输出节点：参数连线取的是哪个输出                                   */
/* ------------------------------------------------------------------ */

/*
 * 参数连线不只是"谁连谁"，还有"取上游的哪个输出"。
 *
 * 更新检测这类节点有多个输出（「结论」和「标题」），
 * 只存 targetArg 的话，打包进模块再展开会退回默认主输出 ——
 * 取到的是另一个值，而界面上这根线看起来完全一样。
 */

const PE2 = (id: string, s: string, t: string, arg: string, srcArg: string) => ({
  id, source: s, target: t,
  data: { kind: 'param', targetArg: arg, sourceArg: srcArg },
} as never);

test('打包成模块时，参数连线取的是哪个输出也要存下来', () => {
  const r = packSelection(
    [PN('src', 0, 0), PN('dst', 100, 0)],
    [PE2('p1', 'src', 'dst', 'a', 'title') as never],
  );
  assert.equal(
    (r.edges[0] as { targetArg?: string; sourceArg?: string }).sourceArg, 'title',
    '只存 targetArg 的话，展开后会退回主输出 —— 值取错了却不报错',
  );
});

test('展开模块时按存下来的输出口还原（不是一律主输出）', () => {
  /*
   * nodes 必须非空：空模块的 expandModules 会走"占位"分支直接 continue，
   * 一条边都不会展开 —— 那样这条测试永远红，而红的理由是
   * "造的模块里没有节点"，不是"没还原输出口"。
   */
  const def: ModuleDef = {
    id: 'md1', name: 'm', at: '',
    nodes: [
      { id: 'src', data: { kind: 'task' } },
      { id: 'dst', data: { kind: 'task' } },
    ],
    edges: [{ id: 'e1', source: 'src', target: 'dst', targetArg: 'a', sourceArg: 'title' }],
  } as unknown as ModuleDef;
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')], edges: [] } as never,
    () => def,
  );
  const e = (g.edges as { data?: Record<string, unknown> }[])[0];
  assert.equal(e?.data?.sourceArg, 'title', '展开后要接回原来那个输出口');
});

/* ------------------------------------------------------------------ */
/* 模块里的嵌合与窗格：存的是节点 id，展开时必须重指向                */
/* ------------------------------------------------------------------ */

/*
 * 打包时会把嵌合转成显式边、并剥掉 stackParent；
 * 但**编辑模块再保存**那条路不剥，于是模块里可以带着 stackParent。
 *
 * 而展开时 rewriteData 只改 {{模板}}，改不到这个字段 ——
 * 结果它仍指向模块内的原始 id，展开后那个 id 不存在，
 * stackEdges 判"父不在集合里"就把这条关系丢了：
 * 嵌合等价于一条隐式边，丢了就是"没连上"，且不报错。
 */
test('展开模块时，嵌合关系要重指向（否则静默丢失）', () => {
  const def: ModuleDef = {
    id: 'md1', name: 'm', at: '',
    nodes: [
      { id: 'A', data: { kind: 'task' } },
      { id: 'B', data: { kind: 'task', stackParent: 'A' } },
    ],
    edges: [],
  } as unknown as ModuleDef;
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')], edges: [] } as never,
    () => def,
  );
  const b = (g.nodes as { id: string; data: Record<string, unknown> }[])
    .find((n) => n.id === 'inst__B');
  assert.equal(
    b?.data.stackParent, 'inst__A',
    '要指向展开后的父 id —— 仍指向 A 的话 stackEdges 找不到父，嵌合等于没连',
  );
  assert.deepEqual(
    stackEdges(g.nodes as never).map((e) => `${e.source}->${e.target}`),
    ['inst__A->inst__B'],
    '运行时要能算出这条隐式边',
  );
});

test('展开模块时，嵌合的父不在模块内就断开（不留指向不存在的 id）', () => {
  const def: ModuleDef = {
    id: 'md1', name: 'm', at: '',
    nodes: [{ id: 'B', data: { kind: 'task', stackParent: 'outer' } }],
    edges: [],
  } as unknown as ModuleDef;
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')], edges: [] } as never,
    () => def,
  );
  const b = (g.nodes as { id: string; data: Record<string, unknown> }[])
    .find((n) => n.id === 'inst__B');
  assert.equal(
    b?.data.stackParent, undefined,
    '父不在模块内：留着就是指向一个不存在的 id（与 duplicate 的断开规则一致）',
  );
});

test('展开模块时，窗格归属要重指向（否则拿不到共享配置）', () => {
  const def: ModuleDef = {
    id: 'md1', name: 'm', at: '',
    nodes: [
      { id: 'P', data: { kind: 'taskPane' } },
      { id: 'B', data: { kind: 'task', paneId: 'P' } },
    ],
    edges: [],
  } as unknown as ModuleDef;
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')], edges: [] } as never,
    () => def,
  );
  const b = (g.nodes as { id: string; data: Record<string, unknown> }[])
    .find((n) => n.id === 'inst__B');
  assert.equal(b?.data.paneId, 'inst__P', '窗格 id 也要跟着重指向');
});

test('展开模块时，窗格不在模块内就保留（多对一，指外面那份是对的）', () => {
  const def: ModuleDef = {
    id: 'md1', name: 'm', at: '',
    nodes: [{ id: 'B', data: { kind: 'task', paneId: 'outerPane' } }],
    edges: [],
  } as unknown as ModuleDef;
  const g = expandModules(
    { nodes: [modNode('inst', 'md1')], edges: [] } as never,
    () => def,
  );
  const b = (g.nodes as { id: string; data: Record<string, unknown> }[])
    .find((n) => n.id === 'inst__B');
  assert.equal(
    b?.data.paneId, 'outerPane',
    '与 stackParent 相反：窗格是多对一，指外面那份才对（清掉会丢配置继承）',
  );
});

/* ------------------------------------------------------------------ */
/* 源码守卫：进出模块编辑必须走转换函数                                */
/* ------------------------------------------------------------------ */

test('源码守卫：模块编辑的进和出都走转换函数（不各写一份映射）', () => {
  /*
   * 形状转换写两遍，两边必然对不上 —— 这次就是对不上了：
   * 进写顶层、出读 data，合起来把分支和参数连线全抹了。
   *
   * 所以盯的是"App 里有没有走 engine 那一对函数"。
   */
  const src = readSrc('App.tsx');
  const calls = (name: string) => src.split(`${name}(`).length - 1;
  assert.ok(calls('moduleEdgesToFlow') >= 3, '进入模块编辑的三条路都要转换');
  assert.ok(calls('flowEdgesToModule') >= 1, '保存模块时要转换');

  /*
   * 打包那条路要连 data 一起传。
   *
   * 以前这里盯的是 `branch: e.data?.branch` 这个形状，
   * 但它**也匹配运行图那段**完全正当的转换（runGraph 把画布边
   * 拍平成引擎边，本来就该读 data）—— 于是守卫恒红，
   * 而红的理由是"守卫写宽了"。照着它去改，会把刚接上的判定拆掉。
   *
   * 真正要防的是"传给 packSelection 的边里没有 data"：
   * 参数连线的信息全在 data 上，缺了它就退化成普通流程线。
   */
  const packCall = src.match(/packSelection\(([\s\S]{0,600}?)\n\s*nodes as never/);
  assert.ok(packCall, '找得到 packSelection 调用');
  assert.ok(
    /data:\s*e\.data/.test(packCall[1]),
    '打包时要连 data 一起传 —— 参数连线的 targetArg / sourceArg 只在 data 里，只搬 branch / loopRole 会把它退化成普通流程线',
  );
});

test('源码守卫：编辑模块期间，画布页签与画布列表都要锁住', () => {
  /*
   * 编辑模块时画布上装的是**模块的内容**。这时切换画布，
   * 再点「完成」写回模块库的就是**另一张画布** ——
   * 模块里原来的东西彻底没了，且没有任何提示。
   *
   * 上面那段"必须锁住画布切换"的注释早就写了，
   * 但此前只有模块库那一栏加了锁，页签和列表都开着。
   */
  const src = readSrc('App.tsx');
  for (const tag of ['<CanvasTabs', '<CanvasLibrary']) {
    const at = src.indexOf(tag);
    assert.ok(at >= 0, `源码里要有 ${tag}`);
    const end = src.indexOf('/>', at);
    const block = src.slice(at, end > 0 ? end : at + 800);
    assert.ok(
      /disabled=\{running \|\| editingModule !== null\}/.test(block),
      `${tag} 必须在编辑模块时锁住（否则模块会被另一张画布覆盖）`,
    );
  }
});

/* ================================================================ */
/* 模块里套模块                                                       */
/* ================================================================ */

/*
 * 选中一个模块实例再打包一次，就得到了"模块里套模块"。
 * 以前 expandModules 只展开一层：内层那个模块节点原样留在运行时图里，
 * 而模块**没有执行器**（runner 对没有执行器的节点是直通），于是：
 *   绿着 success、output 空串、里面的活一件没干、整条流程 ok:true。
 * 用户看到的是"流程跑通了"，而内层模块里的写文件 / 命令行 / 接口
 * 一次都没执行 —— 全程不报错。
 */
test('模块里套模块：内层也要展开（展开后不许还有 module 节点）', () => {
  const B: ModuleDef = {
    id: 'B', name: 'B', color: '', createdAt: 0,
    nodes: [{ id: 'X', data: { kind: 'const', value: 'v' } }] as never,
    edges: [],
  } as ModuleDef;
  const A: ModuleDef = {
    id: 'A', name: 'A', color: '', createdAt: 0,
    nodes: [{ id: 'M', data: { kind: 'module', moduleId: 'B' } }] as never,
    edges: [],
  } as ModuleDef;
  const g = {
    nodes: [{ id: 'inst', data: { kind: 'module', moduleId: 'A' } }] as never,
    edges: [] as never[],
  };
  const r = expandModules(g as never, (id: string) => (id === 'A' ? A : id === 'B' ? B : null));
  const kinds = r.nodes.map((n) => String((n.data as Record<string, unknown>)?.kind ?? ''));
  assert.deepEqual(
    kinds.filter((k) => k === 'module'), [],
    '展开后还留着 module 节点 —— 它没有执行器，会静默直通（绿着成功、什么都没做）',
  );
  /*
   * 两层前缀：外层实例是 inst，内层模块节点是 M，B 里的节点是 X
   * —— 所以是 inst__M__X。只展开一层的话这里会是 'inst__M'。
   */
  assert.deepEqual(r.nodes.map((n) => n.id), ['inst__M__X'], '内层节点要按实例前缀展开出来');
});

/* 端口要在**展开之后**算，否则外部边会连到一个已经不存在的 id 上 */
test('模块里套模块：出口取的是展开后的内部节点', () => {
  const B: ModuleDef = {
    id: 'B', name: 'B', color: '', createdAt: 0,
    nodes: [{ id: 'X', data: { kind: 'const', value: 'v' } }] as never,
    edges: [],
  } as ModuleDef;
  const A: ModuleDef = {
    id: 'A', name: 'A', color: '', createdAt: 0,
    nodes: [{ id: 'M', data: { kind: 'module', moduleId: 'B' } }] as never,
    edges: [],
  } as ModuleDef;
  const g = {
    nodes: [
      { id: 'inst', data: { kind: 'module', moduleId: 'A' } },
      { id: 'out', data: { kind: 'text', template: 'x' } },
    ] as never,
    edges: [{ id: 'e1', source: 'inst', target: 'out' }] as never[],
  };
  const r = expandModules(g as never, (id: string) => (id === 'A' ? A : id === 'B' ? B : null));
  const e = r.edges.find((x) => x.target === 'out');
  assert.ok(e, '模块出口要接到外面的节点上');
  assert.equal(e!.source, 'inst__M__X', '出口该是展开后的内层节点，而不是已经不存在的 inst__M');
});

/* 环：不挡住就是无限递归，而表现在界面上是卡死或爆栈 */
test('模块循环引用：挡住并留下原因（不是无限展开）', () => {
  const A: ModuleDef = {
    id: 'A', name: 'A', color: '', createdAt: 0,
    nodes: [{ id: 'M', data: { kind: 'module', moduleId: 'A' } }] as never,
    edges: [],
  } as ModuleDef;
  const g = {
    nodes: [{ id: 'inst', data: { kind: 'module', moduleId: 'A' } }] as never,
    edges: [] as never[],
  };
  const r = expandModules(g as never, () => A);
  assert.equal(r.nodes.length, 1, '环要挡住，不能一层层展开下去');
  assert.match(
    String((r.nodes[0].data as Record<string, unknown>)?.error ?? ''),
    /循环引用/, '占位节点要写明是循环引用，否则用户无从知道为什么没展开',
  );
});

/*
 * 反向测试：只盯"展开后没有 module 节点"会放过"整张图被清空"。
 * 环里那一层仍要留下节点（带着原因），不能什么都不剩。
 */
test('模块循环引用：节点要留下来（不能整层消失）', () => {
  const A: ModuleDef = {
    id: 'A', name: 'A', color: '', createdAt: 0,
    nodes: [{ id: 'M', data: { kind: 'module', moduleId: 'A' } }] as never,
    edges: [],
  } as ModuleDef;
  const g = {
    nodes: [{ id: 'inst', data: { kind: 'module', moduleId: 'A' } }] as never,
    edges: [] as never[],
  };
  const r = expandModules(g as never, () => A);
  assert.equal(r.nodes[0].id, 'inst__M', '环挡住后仍要留下带原因的占位节点');
});

/* ================================================================ */
/* 展开失败的残留：不许再静默直通                                      */
/* ================================================================ */

/*
 * 旧行为实测：模块被删掉的图跑完是 `ok:true, failed:[]`，
 * 模块节点绿着 success、output 空串，下游读 {{模块.output}} 拿到空串。
 * 用户看到的是"流程跑通了"，而这个模块里的活一件没干。
 */
test('模块被删了：跑起来要失败并说清原因（旧行为是 ok:true 的静默空转）', async () => {
  const g = {
    nodes: [{ id: 'inst', data: { kind: 'module', moduleId: 'GONE' } }] as never,
    edges: [] as never[],
  };
  const r = expandModules(g as never, () => null);
  const events: { type?: string; id?: string; ok?: boolean; error?: string }[] = [];
  const out = await runGraph(r as never, {
    concurrency: 1,
    executor: async () => ({ output: '', ok: true }),
    llmCaller: async () => ({ ok: true, text: '' }),
    onEvent: (e: { type?: string; id?: string; ok?: boolean; error?: string }) => void events.push(e),
  } as never);
  assert.equal(out.ok, false, '模块没展开却 ok:true —— 那正是"看着跑通了其实没做"');
  assert.ok(out.failed.includes('inst'), 'inst 要在失败集合里，否则下游照跑');
  const done = events.find((x) => x.type === 'node-done' && x.id === 'inst');
  assert.equal(done?.ok, false, 'node-done 不能是 ok:true');
  assert.match(String(done?.error ?? ''), /模块已删除/, '失败原因要把展开阶段的原因带出来');
});

/*
 * 反向：正常模块**不能**因为挂了 runModule 就失败。
 * 只盯"残留会失败"的话，把展开整个摘掉也是红的 —— 那不是本轮要防的。
 */
test('正常模块：展开后跑得起来（runModule 不该误伤）', async () => {
  const A: ModuleDef = {
    id: 'A', name: 'A', color: '', createdAt: 0,
    nodes: [{ id: 'X', data: { kind: 'const', value: 'OK-VALUE' } }] as never,
    edges: [],
  } as ModuleDef;
  const g = {
    nodes: [{ id: 'inst', data: { kind: 'module', moduleId: 'A' } }] as never,
    edges: [] as never[],
  };
  const r = expandModules(g as never, () => A);
  const out = await runGraph(r as never, {
    concurrency: 1,
    executor: async () => ({ output: '', ok: true }),
    llmCaller: async () => ({ ok: true, text: '' }),
    onEvent: () => {},
  } as never);
  assert.equal(out.ok, true, '正常的模块不该失败');
  assert.deepEqual(out.failed, [], '正常模块不该进失败集合 —— runModule 误伤了展开好的节点');
});
