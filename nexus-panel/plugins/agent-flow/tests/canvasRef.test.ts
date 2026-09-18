import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasPorts, checkPorts, expandCanvasRefs, findCanvasCycles,
  referencedCanvases, rewriteDataTemplates, canvasInnerId,
  KIND_CANVAS_IN, KIND_CANVAS_OUT, KIND_CANVAS_REF,
} from '../engine/canvasRef';

const N = (id: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ id, data: { kind, label: id, ...extra } });
const E = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });

/** 普通子画布：a → b */
const SUB = {
  id: 'c2', name: '子画布',
  nodes: [N('a', 'task'), N('b', 'log')],
  edges: [E('a', 'b')],
};

/* ================= 接口推导 ================= */

test('自动推导：入口是无上游的，出口是无下游的', () => {
  const p = canvasPorts(SUB);
  assert.deepEqual(p.entries, ['a']);
  assert.deepEqual(p.exits, ['b']);
});

test('放了画布输入/输出节点时以它为准', () => {
  const v = {
    id: 'c', name: 'C',
    nodes: [N('x', 'task'), N('in1', KIND_CANVAS_IN), N('y', 'task'), N('out1', KIND_CANVAS_OUT)],
    edges: [E('x', 'in1'), E('in1', 'y'), E('y', 'out1')],
  };
  const p = canvasPorts(v);
  assert.deepEqual(p.entries, ['in1']);
  assert.deepEqual(p.exits, ['out1']);
  assert.deepEqual(p.explicitIn, ['in1']);
  assert.deepEqual(p.explicitOut, ['out1']);
});

/**
 * 画布引用节点不算接口 ——
 * 展开后它会被内部节点替换掉，把它当入口会指向一个不存在的 id。
 */
test('画布引用节点不被当成接口', () => {
  const v = {
    id: 'c', name: 'C',
    nodes: [N('r', KIND_CANVAS_REF, { canvasId: 'other' })],
    edges: [],
  };
  assert.equal(canvasPorts(v).entries.length, 0);
});

/** 纯转发的画布要给出有用的提示，而不是只说"没有入口" */
test('只调用别的画布时，提示接口由被调用方决定', () => {
  const v = {
    id: 'c', name: '转发画布',
    nodes: [N('r', KIND_CANVAS_REF, { canvasId: 'other' })],
    edges: [],
  };
  const issues = checkPorts(v);
  assert.ok(issues.some((i) => i.message.includes('接口由被调用的那张决定')), JSON.stringify(issues));
});

test('接口不完整会被 checkPorts 报出来', () => {
  const issues = checkPorts({ id: 'c', name: '空画布', nodes: [], edges: [] });
  assert.ok(issues.some((i) => i.level === 'block' && i.message.includes('没有入口')));
  assert.ok(issues.some((i) => i.level === 'block' && i.message.includes('没有出口')));
});

test('正常的画布没有接口问题', () => {
  assert.equal(checkPorts(SUB).length, 0);
});

/* ================= 展开 ================= */

test('画布引用被展开成内部节点', () => {
  const r = expandCanvasRefs(
    { nodes: [N('ref', KIND_CANVAS_REF, { canvasId: 'c2' })], edges: [] },
    (id) => (id === 'c2' ? SUB : null),
  );
  assert.deepEqual(r.nodes.map((n) => n.id).sort(), ['ref__a', 'ref__b']);
  assert.equal(r.problems.length, 0);
});

test('外部下游接到内部出口', () => {
  const r = expandCanvasRefs(
    { nodes: [N('ref', KIND_CANVAS_REF, { canvasId: 'c2' }), N('after', 'log')], edges: [E('ref', 'after')] },
    (id) => (id === 'c2' ? SUB : null),
  );
  const e = r.edges.find((x) => x.target === 'after');
  assert.equal(e?.source, 'ref__b', '应接到内部出口');
});

test('外部上游接到内部入口', () => {
  const r = expandCanvasRefs(
    { nodes: [N('before', 'task'), N('ref', KIND_CANVAS_REF, { canvasId: 'c2' })], edges: [E('before', 'ref')] },
    (id) => (id === 'c2' ? SUB : null),
  );
  const e = r.edges.find((x) => x.source === 'before');
  assert.equal(e?.target, 'ref__a', '应接到内部入口');
});

/** 多入口时每个入口都要接上，否则数据传不进去 */
test('多个入口时外部上游接到每个入口', () => {
  const multi = {
    id: 'm', name: 'M',
    nodes: [N('p', 'task'), N('q', 'task'), N('z', 'log')],
    edges: [E('p', 'z'), E('q', 'z')],
  };
  const r = expandCanvasRefs(
    { nodes: [N('before', 'task'), N('ref', KIND_CANVAS_REF, { canvasId: 'm' })], edges: [E('before', 'ref')] },
    (id) => (id === 'm' ? multi : null),
  );
  const ins = r.edges.filter((x) => x.source === 'before');
  assert.equal(ins.length, 2);
});

/** 模板引用必须重写 —— 不重写取不到值，而且不报错（只渲染成空串） */
test('内部模板引用被重写成展开后的 id', () => {
  const sub = {
    id: 'c', name: 'C',
    nodes: [N('a', 'task'), N('b', 'task', { t: '{{a.output}} 结果' })],
    edges: [E('a', 'b')],
  };
  const r = expandCanvasRefs(
    { nodes: [N('ref', KIND_CANVAS_REF, { canvasId: 'c' })], edges: [] },
    (id) => (id === 'c' ? sub : null),
  );
  const b = r.nodes.find((n) => n.id === 'ref__b');
  assert.equal((b?.data as Record<string, unknown>).t, '{{ref__a.output}} 结果');
});

/** 外部节点的引用不能被误改 —— 改了就指向不存在的 id */
test('指向外部节点的模板引用不被改动', () => {
  const sub = {
    id: 'c', name: 'C',
    nodes: [N('a', 'task', { t: '{{outer.output}}' })],
    edges: [],
  };
  const r = expandCanvasRefs(
    { nodes: [N('ref', KIND_CANVAS_REF, { canvasId: 'c' })], edges: [] },
    (id) => (id === 'c' ? sub : null),
  );
  assert.equal((r.nodes[0].data as Record<string, unknown>).t, '{{outer.output}}');
});

test('嵌套调用：子画布里还有画布引用', () => {
  const inner = { id: 'i', name: '内层', nodes: [N('x', 'task')], edges: [] };
  const mid = {
    id: 'm', name: '中层',
    nodes: [N('r2', KIND_CANVAS_REF, { canvasId: 'i' }), N('y', 'log')],
    edges: [E('r2', 'y')],
  };
  const r = expandCanvasRefs(
    { nodes: [N('r1', KIND_CANVAS_REF, { canvasId: 'm' })], edges: [] },
    (id) => (id === 'm' ? mid : id === 'i' ? inner : null),
  );
  assert.ok(r.nodes.some((n) => n.id === 'r1__r2__x'), `应有两层前缀，实际 ${r.nodes.map((n) => n.id)}`);
});

/* ================= 循环与错误 ================= */

test('循环引用被挡住并说清楚路径', () => {
  const a = { id: 'A', name: 'A', nodes: [N('r', KIND_CANVAS_REF, { canvasId: 'B' })], edges: [] };
  const b = { id: 'B', name: 'B', nodes: [N('r', KIND_CANVAS_REF, { canvasId: 'A' })], edges: [] };
  const r = expandCanvasRefs(
    { nodes: a.nodes, edges: [] },
    (id) => (id === 'A' ? a : id === 'B' ? b : null),
  );
  assert.ok(r.problems.length > 0);
  assert.ok(r.problems[0].reason.includes('循环调用'), r.problems[0].reason);
});

test('找不到画布时不静默', () => {
  const r = expandCanvasRefs(
    { nodes: [N('ref', KIND_CANVAS_REF, { canvasId: '不存在' })], edges: [] },
    () => null,
  );
  assert.equal(r.problems.length, 1);
  assert.ok(r.problems[0].reason.includes('找不到画布'));
});

test('没填画布 id 时报错', () => {
  const r = expandCanvasRefs(
    { nodes: [N('ref', KIND_CANVAS_REF, {})], edges: [] },
    () => null,
  );
  assert.ok(r.problems[0].reason.includes('没有指定'));
});

test('层数过深被挡住', () => {
  // 造一条 A→B→C→… 足够深的链
  const chain: Record<string, { id: string; name: string; nodes: unknown[]; edges: unknown[] }> = {};
  const names = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11'];
  names.forEach((n, i) => {
    const nextName = names[i + 1];
    chain[n] = {
      id: n, name: n,
      nodes: nextName ? [N('r', KIND_CANVAS_REF, { canvasId: nextName })] : [N('leaf', 'task')],
      edges: [],
    };
  });
  const r = expandCanvasRefs(
    { nodes: chain.c0.nodes as never, edges: [] },
    (id) => chain[id] as never,
    { maxDepth: 4 },
  );
  assert.ok(r.problems.some((p) => p.reason.includes('层数')), JSON.stringify(r.problems));
});

/* ================= 循环检测 ================= */

test('findCanvasCycles 找出环', () => {
  const a = { id: 'A', name: 'A', nodes: [N('r', KIND_CANVAS_REF, { canvasId: 'B' })], edges: [] };
  const b = { id: 'B', name: 'B', nodes: [N('r', KIND_CANVAS_REF, { canvasId: 'A' })], edges: [] };
  const c = findCanvasCycles([a, b]);
  assert.ok(c.length > 0);
  assert.ok(c[0].includes('A') && c[0].includes('B'));
});

test('无环时返回空', () => {
  const a = { id: 'A', name: 'A', nodes: [N('r', KIND_CANVAS_REF, { canvasId: 'B' })], edges: [] };
  const b = { id: 'B', name: 'B', nodes: [N('leaf', 'task')], edges: [] };
  assert.equal(findCanvasCycles([a, b]).length, 0);
});

test('自引用也算环', () => {
  const a = { id: 'A', name: 'A', nodes: [N('r', KIND_CANVAS_REF, { canvasId: 'A' })], edges: [] };
  assert.ok(findCanvasCycles([a]).length > 0);
});

/* ================= 收集 ================= */

test('referencedCanvases 去重', () => {
  const out = referencedCanvases([
    N('r1', KIND_CANVAS_REF, { canvasId: 'X' }),
    N('r2', KIND_CANVAS_REF, { canvasId: 'X' }),
    N('r3', KIND_CANVAS_REF, { canvasId: 'Y' }),
    N('t', 'task'),
  ]);
  assert.deepEqual(out.sort(), ['X', 'Y']);
});

/* ================= 模板重写 ================= */

test('嵌套对象里的模板也被重写', () => {
  const m = new Map([['a', 'ref__a']]);
  const out = rewriteDataTemplates({ d: { deep: '{{a.output}}' } }, m) as Record<string, unknown>;
  assert.equal((out.d as Record<string, unknown>).deep, '{{ref__a.output}}');
});

test('数组里的模板也被重写', () => {
  const m = new Map([['a', 'ref__a']]);
  const out = rewriteDataTemplates({ list: ['{{a.output}}', 1] }, m) as Record<string, unknown>;
  assert.equal((out.list as string[])[0], '{{ref__a.output}}');
});

test('id 前缀分隔符稳定', () => {
  assert.equal(canvasInnerId('r', 'a'), 'r__a');
});
