import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteElements, extractRefs, nextSelection, hasAnythingToDelete,
  makeSnapshot, describeDelete,
} from '../engine/canvasOps';

type N = { id: string; data?: { prompt?: string } };
type E = { id: string; source: string; target: string };

const n = (id: string, prompt = ''): N => ({ id, data: { prompt } });
const e = (s: string, t: string, id?: string): E => ({ id: id ?? `${s}->${t}`, source: s, target: t });

const nodes0: N[] = [n('a'), n('b', '审 {{a.output}}'), n('c')];
const edges0: E[] = [e('a', 'b'), e('b', 'c'), e('a', 'c')];

/* ---------- 引用提取 ---------- */

test('refs: 提取 .output 引用', () => {
  assert.deepEqual(extractRefs('审查 {{a.output}} 和 {{b.output}}'), ['a', 'b']);
});

test('refs: 支持简写 {{a}}', () => {
  assert.deepEqual(extractRefs('看 {{a}}'), ['a']);
});

test('refs: 忽略 {{input}}', () => {
  assert.deepEqual(extractRefs('{{input}} + {{a.output}}'), ['a']);
});

test('refs: 去重', () => {
  assert.deepEqual(extractRefs('{{a.output}} {{a.output}}'), ['a']);
});

test('refs: 空提示词返回空', () => {
  assert.deepEqual(extractRefs(''), []);
  assert.deepEqual(extractRefs('没有变量'), []);
});

/* ---------- 删除节点 ---------- */

test('删除: 删节点同时删掉相连的边', () => {
  const r = deleteElements(nodes0, edges0, { nodeIds: ['b'] });
  assert.deepEqual(r.removedNodeIds, ['b']);
  // a->b 和 b->c 都该消失，a->c 保留
  assert.deepEqual(r.edges.map((x) => x.id).sort(), ['a->c']);
  assert.deepEqual(r.nodes.map((x) => x.id), ['a', 'c']);
});

test('删除: 删多个节点', () => {
  const r = deleteElements(nodes0, edges0, { nodeIds: ['a', 'c'] });
  assert.deepEqual(r.removedNodeIds, ['a', 'c']);
  assert.deepEqual(r.edges, [], '所有边都连着 a 或 c，应全部删除');
  assert.deepEqual(r.nodes.map((x) => x.id), ['b']);
});

test('删除: 删不存在的节点不报错', () => {
  const r = deleteElements(nodes0, edges0, { nodeIds: ['ghost'] });
  assert.deepEqual(r.removedNodeIds, []);
  assert.equal(r.nodes.length, 3);
  assert.equal(r.edges.length, 3);
});

test('删除: 删除全部', () => {
  const r = deleteElements(nodes0, edges0, { nodeIds: ['a', 'b', 'c'] });
  assert.deepEqual(r.nodes, []);
  assert.deepEqual(r.edges, []);
});

/* ---------- 删除边 ---------- */

test('删除: 只删边不影响节点', () => {
  const r = deleteElements(nodes0, edges0, { edgeIds: ['a->c'] });
  assert.deepEqual(r.removedEdgeIds, ['a->c']);
  assert.equal(r.nodes.length, 3);
  assert.deepEqual(r.edges.map((x) => x.id).sort(), ['a->b', 'b->c']);
});

test('删除: 同时删节点和边', () => {
  const r = deleteElements(nodes0, edges0, { nodeIds: ['c'], edgeIds: ['a->b'] });
  assert.deepEqual(r.nodes.map((x) => x.id), ['a', 'b']);
  assert.deepEqual(r.edges, [], 'a->b 显式删，b->c 与 a->c 因 c 被删');
});

/* ---------- 悬空引用 ---------- */

test('悬空: 下游仍引用被删节点时给出提示', () => {
  // b 的 prompt 引用了 a
  const r = deleteElements(nodes0, edges0, { nodeIds: ['a'] });
  assert.equal(r.danglingRefs.length, 1);
  assert.equal(r.danglingRefs[0].nodeId, 'a');
  assert.deepEqual(r.danglingRefs[0].usedBy, ['b']);
});

test('悬空: 无人引用则不提示', () => {
  const r = deleteElements(nodes0, edges0, { nodeIds: ['c'] });
  assert.deepEqual(r.danglingRefs, []);
});

test('悬空: 引用者本身也被删则不算悬空', () => {
  const r = deleteElements(nodes0, edges0, { nodeIds: ['a', 'b'] });
  assert.deepEqual(r.danglingRefs, [], 'b 引用了 a，但 b 也被删了');
});

test('悬空: 多个下游引用同一个节点', () => {
  const ns: N[] = [n('a'), n('b', '{{a.output}}'), n('c', '{{a.output}}')];
  const r = deleteElements(ns, [e('a', 'b'), e('a', 'c')], { nodeIds: ['a'] });
  assert.deepEqual(r.danglingRefs[0].usedBy.sort(), ['b', 'c']);
});

/* ---------- 选中态 ---------- */

test('选中: 删掉当前选中节点 → 清空选中', () => {
  assert.equal(nextSelection('b', ['b']), null);
});

test('选中: 删的是别的节点 → 保持选中', () => {
  assert.equal(nextSelection('b', ['a']), 'b');
});

test('选中: 原本就没选中 → 保持 null', () => {
  assert.equal(nextSelection(null, ['a']), null);
});

/* ---------- 有无可删 ---------- */

test('hasAnythingToDelete: 节点存在', () => {
  assert.equal(hasAnythingToDelete(nodes0, edges0, { nodeIds: ['a'] }), true);
});

test('hasAnythingToDelete: 边存在', () => {
  assert.equal(hasAnythingToDelete(nodes0, edges0, { edgeIds: ['a->b'] }), true);
});

test('hasAnythingToDelete: 都不存在 → false', () => {
  assert.equal(hasAnythingToDelete(nodes0, edges0, { nodeIds: ['x'], edgeIds: ['y'] }), false);
});

test('hasAnythingToDelete: 空请求 → false', () => {
  assert.equal(hasAnythingToDelete(nodes0, edges0, {}), false);
});

/* ---------- 快照 ---------- */

test('快照: 深拷贝，后续修改不影响快照', () => {
  const ns: N[] = [n('a', '原始')];
  const snap = makeSnapshot(ns, [e('a', 'b')], 'a', '删除');
  ns[0].data!.prompt = '改过了';
  assert.equal(snap.nodes[0].data?.prompt, '原始', '快照不应被后续修改影响');
  assert.equal(snap.selectedId, 'a');
  assert.equal(snap.label, '删除');
});

test('快照: 边也深拷贝', () => {
  const es: E[] = [e('a', 'b')];
  const snap = makeSnapshot([n('a')], es, null, 'x');
  es[0].target = 'z';
  assert.equal(snap.edges[0].target, 'b');
});

/* ---------- 文案 ---------- */

test('文案: 描述删除内容', () => {
  assert.equal(describeDelete(['a', 'b'], []), '2 个节点');
  assert.equal(describeDelete([], ['x']), '1 条连线');
  assert.equal(describeDelete(['a'], ['x', 'y']), '1 个节点 + 2 条连线');
  assert.equal(describeDelete([], []), '0 个元素');
});

/* ---------- 删窗格：清掉成员的 paneId ---------- */

type PN = { id: string; data?: { kind?: string; paneId?: string; prompt?: string } };
const pn = (id: string, data: PN['data']): PN => ({ id, data });

/**
 * 窗格被删后，挂在它下面的节点必须把 paneId 清掉。
 *
 * 留着悬空 id 的话：运行时按"没挂窗格"处理，面板上下拉框显示的
 * 也正好是"不挂窗格" —— 界面与实际恰好一致，于是继承失效这件事
 * 没有任何提示。用户改窗格、节点不再跟着变，却看不出原因。
 */
test('删除: 删掉窗格时清空挂在它下面的 paneId', () => {
  const ns: PN[] = [
    pn('p1', { kind: 'taskPane' }),
    pn('t1', { paneId: 'p1', prompt: 'x' }),
    pn('t2', { paneId: 'p1' }),
    pn('t3', { paneId: 'p2' }), // 别的窗格，不能被误清
  ];
  const res = deleteElements(ns, [], { nodeIds: ['p1'] });
  const byId = new Map(res.nodes.map((x) => [x.id, x.data]));
  assert.equal(byId.has('p1'), false);
  assert.equal(byId.get('t1')?.paneId, undefined);
  assert.equal(byId.get('t2')?.paneId, undefined);
  assert.equal(byId.get('t3')?.paneId, 'p2', '别的窗格的引用不能被误清');
});

/** 删普通节点不该动 paneId（只认窗格） */
test('删除: 删普通节点不清 paneId', () => {
  const ns: PN[] = [pn('p1', { kind: 'taskPane' }), pn('t1', { paneId: 'p1' })];
  const res = deleteElements(ns, [], { nodeIds: ['t1'] });
  assert.equal(res.nodes.find((x) => x.id === 'p1')?.data?.kind, 'taskPane');
  assert.equal(res.nodes.length, 1);
});
