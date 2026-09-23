import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addModule, loadModules, saveModules, removeModule, renameModule, findModule,
  modulePorts, stripRuntimeNodes, expandModules, innerId,
  packSelection, rewireCrossing, canPack,
  exportModules, importModules, type ModuleDef, type ModuleEdge, type KV,
} from '../engine/modules';

function memKV() {
  const map = new Map<string, string>();
  return { map, get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) };
}

const E = (id: string, s: string, t: string): ModuleEdge => ({ id, source: s, target: t });

/** 造一个 A → B → C 的链 */
function chain() {
  return {
    nodes: [
      { id: 'A', data: { kind: 'const', label: 'A', value: 'a' } },
      { id: 'B', data: { kind: 'const', label: 'B', value: '{{A.output}}' } },
      { id: 'C', data: { kind: 'const', label: 'C', value: 'c' } },
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
    { id: 'A', data: { kind: 'const', status: 'success', output: '旧输出', error: '', value: 'x' } },
  ]);
  const d = (cleaned[0] as { data: Record<string, unknown> }).data;
  assert.equal(d.status, undefined);
  assert.equal(d.output, undefined);
  assert.equal(d.value, 'x', '配置字段要保留');
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
  assert.equal(b.data?.value, '{{inst__A.output}}');
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
  const ownInner = { nodes: [{ id: 'Z', data: { kind: 'const', value: 'z' } }], edges: [] };
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
    { nodes: [{ id: 'p', data: { kind: 'const', value: 'x' } }] as N[], edges: [] },
    () => null,
  );
  assert.deepEqual(g.nodes, [{ id: 'p', data: { kind: 'const', value: 'x' } }]);
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
test('剥掉显示状态：stackParent / size / stackCollapsed', () => {
  const r = packSelection(
    [PN('a', 0, 0, { kind: 'task', stackParent: '外面的节点', size: 'tall', stackCollapsed: true })],
    [],
  );
  const d = (r.nodes[0] as { data: Record<string, unknown> }).data;
  assert.equal(d.stackParent, undefined);
  assert.equal(d.size, undefined);
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
