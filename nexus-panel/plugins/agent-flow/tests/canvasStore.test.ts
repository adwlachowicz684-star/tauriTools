import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCanvas, nextCanvasName, renameCanvas, removeCanvas, nextActiveId,
  updateCanvasContent, sortForDisplay, serialize, deserialize, toMeta,
} from '../engine/canvasStore';

const C = (id: string, name: string, nodes: number = 0, updatedAt: number = 0) => ({
  ...makeCanvas(name, { id, nodes: new Array(nodes).fill({}), updatedAt }),
});

/* ---------- 命名 ---------- */

test('命名: 首个为 "工作流 1"', () => {
  assert.equal(nextCanvasName([]), '工作流 1');
});

test('命名: 跳过已存在的名字', () => {
  const list = [C('a', '工作流 1'), C('b', '工作流 2')];
  assert.equal(nextCanvasName(list), '工作流 3');
});

test('命名: 支持自定义前缀', () => {
  assert.equal(nextCanvasName([], '管道'), '管道 1');
});

/* ---------- 改名 ---------- */

test('改名: 正常改名', () => {
  const list = [C('a', '旧名')];
  const r = renameCanvas(list, 'a', '新名');
  assert.equal(r.name, '新名');
  assert.equal(r.list[0].name, '新名');
});

test('改名: 首尾空白被去掉', () => {
  const r = renameCanvas([C('a', 'x')], 'a', '  带空格  ');
  assert.equal(r.name, '带空格');
});

test('改名: 空名回退到原名', () => {
  const r = renameCanvas([C('a', '原名')], 'a', '   ');
  assert.equal(r.name, '原名');
});

test('改名: 与自身同名不算冲突', () => {
  const r = renameCanvas([C('a', '同名')], 'a', '同名');
  assert.equal(r.name, '同名');
});

test('改名: 重名自动加后缀 (2)', () => {
  const list = [C('a', 'A'), C('b', 'B')];
  const r = renameCanvas(list, 'a', 'B');
  assert.equal(r.name, 'B (2)');
});

test('改名: 重名后缀递增', () => {
  const list = [C('a', 'A'), C('b', 'X'), C('c', 'X (2)')];
  const r = renameCanvas(list, 'a', 'X');
  assert.equal(r.name, 'X (3)');
});

test('改名: 目标不存在则原样返回', () => {
  const list = [C('a', 'A')];
  const r = renameCanvas(list, 'ghost', 'Z');
  assert.equal(r.list, list);
});

/* ---------- 删除 ---------- */

test('删除: 移除指定画布', () => {
  const list = [C('a', 'A'), C('b', 'B')];
  const r = removeCanvas(list, 'a');
  assert.deepEqual(r.list.map((c) => c.id), ['b']);
  assert.equal(r.removed?.id, 'a');
});

test('删除: 不存在的返回 null', () => {
  const r = removeCanvas([C('a', 'A')], 'ghost');
  assert.equal(r.removed, null);
  assert.equal(r.list.length, 1);
});

test('删除: 删中间项 → 激活后一项', () => {
  const list = [C('a', 'A'), C('b', 'B'), C('c', 'C')];
  const after = removeCanvas(list, 'b').list;
  assert.equal(nextActiveId(after, 'b', 1), 'c');
});

test('删除: 删末项 → 激活前一项', () => {
  const list = [C('a', 'A'), C('b', 'B')];
  const after = removeCanvas(list, 'b').list;
  assert.equal(nextActiveId(after, 'b', 1), 'a');
});

test('删除: 删光了 → null', () => {
  assert.equal(nextActiveId([], 'a', 0), null);
});

test('删除: 索引越界时退到第一项', () => {
  const list = [C('a', 'A')];
  assert.equal(nextActiveId(list, 'x', -1), 'a');
});

/* ---------- 内容更新 ---------- */

test('更新: 写入节点与连线', () => {
  const list = [C('a', 'A')];
  const r = updateCanvasContent(list, 'a', { nodes: [{ id: 1 }], edges: [{ id: 'e' }] });
  assert.equal(r[0].nodes.length, 1);
  assert.equal(r[0].edges.length, 1);
});

test('更新: 只给 nodes 时保留 edges', () => {
  const list = [C('a', 'A', 0)];
  const withEdges = updateCanvasContent(list, 'a', { edges: [{ id: 'e' }] });
  const r = updateCanvasContent(withEdges, 'a', { nodes: [{ id: 1 }] });
  assert.equal(r[0].edges.length, 1, 'edges 应保留');
});

/* ---------- 展示 ---------- */

test('toMeta: 汇总节点与连线数', () => {
  const m = toMeta(C('a', 'A', 3));
  assert.equal(m.id, 'a');
  assert.equal(m.name, 'A');
  assert.equal(m.nodeCount, 3);
});

test('排序: 最近更新的在前', () => {
  const list = [C('a', 'A', 0, 100), C('b', 'B', 0, 300), C('c', 'C', 0, 200)];
  assert.deepEqual(sortForDisplay(list).map((c) => c.id), ['b', 'c', 'a']);
});

test('排序: 不修改原数组', () => {
  const list = [C('a', 'A', 0, 100), C('b', 'B', 0, 300)];
  sortForDisplay(list);
  assert.equal(list[0].id, 'a');
});

/* ---------- 持久化 ---------- */

test('持久化: 序列化后能还原', () => {
  const state = { canvases: [C('a', 'A', 2)], activeId: 'a' };
  const back = deserialize(serialize(state));
  assert.equal(back.canvases.length, 1);
  assert.equal(back.canvases[0].name, 'A');
  assert.equal(back.activeId, 'a');
});

test('持久化: 空输入返回空状态', () => {
  assert.deepEqual(deserialize(null), { canvases: [], activeId: null });
});

test('持久化: 非法 JSON 不抛异常', () => {
  const r = deserialize('{ 这不是 json');
  assert.deepEqual(r.canvases, []);
});

test('持久化: 非对象输入不崩', () => {
  assert.deepEqual(deserialize('"just a string"').canvases, []);
  assert.deepEqual(deserialize('123').canvases, []);
});

test('持久化: 缺失字段自动补齐', () => {
  const raw = JSON.stringify({ canvases: [{ id: 'a' }] });
  const r = deserialize(raw);
  assert.equal(r.canvases[0].name, '工作流 1', '缺 name 应补默认名');
  assert.deepEqual(r.canvases[0].nodes, []);
  assert.deepEqual(r.canvases[0].edges, []);
});

test('持久化: 重复 id 自动去重（避免 React key 冲突）', () => {
  const raw = JSON.stringify({
    canvases: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }],
  });
  const r = deserialize(raw);
  assert.notEqual(r.canvases[0].id, r.canvases[1].id);
});

test('持久化: activeId 指向已删除画布时退到第一项', () => {
  const raw = JSON.stringify({
    canvases: [{ id: 'a', name: 'A' }],
    activeId: 'deleted',
  });
  const r = deserialize(raw);
  assert.equal(r.activeId, 'a');
});

test('持久化: 无画布时 activeId 为 null', () => {
  const raw = JSON.stringify({ canvases: [], activeId: 'x' });
  assert.equal(deserialize(raw).activeId, null);
});
