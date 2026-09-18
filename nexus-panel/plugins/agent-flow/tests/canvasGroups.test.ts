import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextGroupName, groupOfCanvas, addToGroup, removeFromGroup,
  pruneGroups, buildSidebar, type CanvasGroup,
} from '../engine/canvasGroups';

const G = (id: string, name: string, members: string[] = []): CanvasGroup =>
  ({ id, name, members });

/* ================= 组名 ================= */

test('第一个组不带序号', () => {
  assert.equal(nextGroupName([]), '画布组');
});

test('重名时加序号', () => {
  assert.equal(nextGroupName([G('1', '画布组')]), '画布组 2');
  assert.equal(nextGroupName([G('1', '画布组'), G('2', '画布组 2')]), '画布组 3');
});

/* ================= 归属 ================= */

test('找到画布所属的组', () => {
  const gs = [G('g1', 'A', ['c1', 'c2'])];
  assert.equal(groupOfCanvas(gs, 'c2')?.id, 'g1');
  assert.equal(groupOfCanvas(gs, 'c9'), null);
});

/** 一张画布只属于一个组 —— 同时属于多个会让界面出现重复条目 */
test('加入新组时自动从旧组移除', () => {
  const gs = [G('g1', 'A', ['c1']), G('g2', 'B', [])];
  const out = addToGroup(gs, 'g2', 'c1');
  assert.deepEqual(out[0].members, []);
  assert.deepEqual(out[1].members, ['c1']);
});

test('重复加入不会重复', () => {
  const gs = [G('g1', 'A', ['c1'])];
  assert.deepEqual(addToGroup(gs, 'g1', 'c1')[0].members, ['c1']);
});

test('移出组', () => {
  const gs = [G('g1', 'A', ['c1', 'c2'])];
  assert.deepEqual(removeFromGroup(gs, 'c1')[0].members, ['c2']);
});

/* ================= 清理 ================= */

/** 删画布后必须清理，否则组里留着孤儿，点它什么也不发生 */
test('清理指向已删画布的成员', () => {
  const gs = [G('g1', 'A', ['c1', 'c2'])];
  const out = pruneGroups(gs, ['c1']);
  assert.deepEqual(out[0].members, ['c1']);
});

test('成员全没了则整个组消失', () => {
  const gs = [G('g1', 'A', ['c1'])];
  assert.equal(pruneGroups(gs, []).length, 0);
});

/* ================= 侧栏 ================= */

test('组内画布排在组下，未分组的平铺在后面', () => {
  const cs = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
  const out = buildSidebar(cs, [G('g1', 'A', ['c1', 'c2'])]);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'group');
  assert.deepEqual((out[0] as { canvases: string[] }).canvases, ['c1', 'c2']);
  assert.deepEqual((out[1] as { canvasId: string }).canvasId, 'c3');
});

test('组里指向不存在画布的成员被跳过', () => {
  const cs = [{ id: 'c1' }];
  const out = buildSidebar(cs, [G('g1', 'A', ['c1', '已删'])]);
  assert.deepEqual((out[0] as { canvases: string[] }).canvases, ['c1']);
});

test('没有组时全是平铺条目', () => {
  const out = buildSidebar([{ id: 'c1' }, { id: 'c2' }], []);
  assert.equal(out.length, 2);
  assert.ok(out.every((e) => e.kind === 'canvas'));
});
