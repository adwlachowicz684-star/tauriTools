import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScopeKey, scopeKeyOf, normalizeScope, scopeOptions, buildProjectIndex,
  scopeMatches, filterByScope, scopeLabel,
  ALL_SCOPE, UNGROUPED_SCOPE, type ProjectScope, type CanvasGroup,
} from '../engine/projectScope';

const g = (id: string, name: string, members: string[]): CanvasGroup => ({ id, name, members });

const groups = [g('p1', '项目甲', ['c1', 'c2']), g('p2', '项目乙', ['c3'])];
// c4 存在但没归组；c9 是已删画布（不在这份列表里）
const canvasIds = ['c1', 'c2', 'c3', 'c4'];
const idx = () => buildProjectIndex(groups, canvasIds);

const recs = [
  { id: 'r1', canvasId: 'c1' },
  { id: 'r2', canvasId: 'c3' },
  { id: 'r3', canvasId: 'c4' },
  { id: 'r4', canvasId: 'c9' },   // 画布已被删
];

/* ---------- key 往返 ---------- */

test('scopeKey / parse: 三档都能往返', () => {
  for (const s of [ALL_SCOPE, UNGROUPED_SCOPE, { kind: 'group', groupId: 'p1' } as ProjectScope]) {
    assert.deepEqual(parseScopeKey(scopeKeyOf(s)), s, `往返失败：${JSON.stringify(s)}`);
  }
});

test('parseScopeKey: 认不出的一律回全部，不给空白范围', () => {
  assert.deepEqual(parseScopeKey(null), ALL_SCOPE);
  assert.deepEqual(parseScopeKey(''), ALL_SCOPE);
  assert.deepEqual(parseScopeKey('g:'), ALL_SCOPE, '空 id 的分组指向不到任何东西');
  assert.deepEqual(parseScopeKey('不存在的东西'), ALL_SCOPE);
});

test('scopeKeyOf: 分组带 g: 前缀，不会和另两档撞', () => {
  assert.equal(scopeKeyOf({ kind: 'group', groupId: 'x' }), 'g:x');
  assert.equal(scopeKeyOf(UNGROUPED_SCOPE), 'ungrouped');
  assert.equal(scopeKeyOf(ALL_SCOPE), 'all');
});

test('normalizeScope: 分组被删后回落全部（否则切过去一条都没有）', () => {
  assert.deepEqual(normalizeScope({ kind: 'group', groupId: '没了' }, groups), ALL_SCOPE);
  assert.deepEqual(normalizeScope({ kind: 'group', groupId: 'p1' }, groups), { kind: 'group', groupId: 'p1' });
  assert.deepEqual(normalizeScope(UNGROUPED_SCOPE, []), UNGROUPED_SCOPE, '未分组不受分组增删影响');
});

/* ---------- 归属 ---------- */

test('scopeMatches: 全部项目什么都收，包括已删画布的记录', () => {
  for (const r of recs) assert.equal(scopeMatches(ALL_SCOPE, r.canvasId, idx()), true);
});

test('scopeMatches: 分组只收自己成员的', () => {
  const i = idx();
  assert.equal(scopeMatches({ kind: 'group', groupId: 'p1' }, 'c1', i), true);
  assert.equal(scopeMatches({ kind: 'group', groupId: 'p1' }, 'c2', i), true);
  assert.equal(scopeMatches({ kind: 'group', groupId: 'p1' }, 'c3', i), false);
  assert.equal(scopeMatches({ kind: 'group', groupId: 'p1' }, 'c4', i), false, '未归组的不属于任何项目');
});

test('scopeMatches: 未分组收"存在但没归组"的画布', () => {
  const i = idx();
  assert.equal(scopeMatches(UNGROUPED_SCOPE, 'c4', i), true);
  assert.equal(scopeMatches(UNGROUPED_SCOPE, 'c1', i), false);
});

test('scopeMatches: 已删画布的记录只在全部项目下可见', () => {
  const i = idx();
  assert.equal(scopeMatches({ kind: 'group', groupId: 'p1' }, 'c9', i), false);
  assert.equal(scopeMatches(UNGROUPED_SCOPE, 'c9', i), false, '不该算"未分组"——它连画布都没了');
  assert.equal(scopeMatches(ALL_SCOPE, 'c9', i), true);
});

test('buildProjectIndex: 同一画布被放进两组时取第一个（一条记录不出现在两个项目）', () => {
  const i = buildProjectIndex([g('a', 'A', ['c1']), g('b', 'B', ['c1'])], ['c1']);
  assert.equal(i.groupOf.get('c1'), 'a');
  assert.equal(scopeMatches({ kind: 'group', groupId: 'b' }, 'c1', i), false);
});

/* ---------- 过滤 ---------- */

test('filterByScope: 全部项目原样返回', () => {
  assert.equal(filterByScope(recs, ALL_SCOPE, idx()).length, 4);
});

test('filterByScope: 项目甲只看得到自己的两条', () => {
  const out = filterByScope(recs, { kind: 'group', groupId: 'p1' }, idx());
  assert.deepEqual(out.map((r) => r.id), ['r1'], 'c1 在项目甲，c2 没有记录');
});

test('filterByScope: 未分组只看得到 c4', () => {
  assert.deepEqual(filterByScope(recs, UNGROUPED_SCOPE, idx()).map((r) => r.id), ['r3']);
});

/* ---------- 选项 ---------- */

test('scopeOptions: 一个分组都没有时不给选项（调用方据此隐藏切换器）', () => {
  assert.deepEqual(scopeOptions([], canvasIds), []);
});

test('scopeOptions: 全部 / 各分组 / 未分组，计数按当前存在的画布', () => {
  const opts = scopeOptions(groups, canvasIds);
  assert.deepEqual(opts.map((o) => o.key), ['all', 'g:p1', 'g:p2', 'ungrouped']);
  assert.deepEqual(opts.map((o) => o.count), [4, 2, 1, 1]);
});

test('scopeOptions: 空项目也要列出来（否则看不出它存在）', () => {
  const opts = scopeOptions([...groups, g('p3', '空项目', [])], canvasIds);
  const p3 = opts.find((o) => o.key === 'g:p3');
  assert.ok(p3);
  assert.equal(p3.count, 0);
});

test('scopeOptions: key 就是 kv 形态，选中即存', () => {
  for (const o of scopeOptions(groups, canvasIds)) {
    assert.equal(scopeKeyOf(parseScopeKey(o.key)), o.key);
  }
});

/* ---------- 显示名 ---------- */

test('scopeLabel: 分组名取当前分组表里的', () => {
  assert.equal(scopeLabel({ kind: 'group', groupId: 'p2' }, groups), '项目乙');
  assert.equal(scopeLabel(UNGROUPED_SCOPE, groups), '未分组');
  assert.equal(scopeLabel(ALL_SCOPE, groups), '全部项目');
  // 分组已删：不显示一个空名字，退回"全部项目"
  assert.equal(scopeLabel({ kind: 'group', groupId: '没了' }, groups), '全部项目');
});
