import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBoard, parseBoard, serializeBoard, isGroup, isTask,
  newBoardId, nextFreeId, childrenOf, parentOf, pathOf, descendantIds,
  leafTaskIds, isAncestor, lockOf, statusOf, tallyOf,
  addNode, removeNode, renameNode, moveNode,
  mergeIntoGroup, splitTask, claimTask, setTaskStatus, setDeps,
  boardRows, defaultExpanded, matchesTask, visibleIds, mergeBoards,
  type TaskBoard, type BoardNode,
} from '../engine/taskBoard';

/** 一条任务节点的完整字段。新字段补不全的话往返测试会对不上 */
const task = (title: string, patch: Record<string, unknown> = {}): BoardNode => ({
  kind: 'task', title, status: 'todo', deps: [], assignee: '', note: '',
  desc: '', tags: [], createdAt: 0, updatedAt: 0, due: 0, priority: 0,
  session: '', prevSession: '', tookAt: 0,
  ...patch,
} as BoardNode);

/** 一棵现成的树：g1[t1, g2[t2, t3]], t4 */
function board(): TaskBoard {
  const b = emptyBoard('p1', '项目甲');
  const r1 = addNode(b, null, { kind: 'group', title: '登录', children: [] });
  const r2 = addNode(r1.board, r1.id, task('设计表'));
  const r3 = addNode(r2.board, r1.id, { kind: 'group', title: '接口', children: [] });
  const r4 = addNode(r3.board, r3.id, task('写接口'));
  const r5 = addNode(r4.board, r3.id, task('补测试'));
  const r6 = addNode(r5.board, null, task('发版'));
  return r6.board;
}

const idsOf = (b: TaskBoard) => Object.keys(b.nodes);
const findTask = (b: TaskBoard, title: string) =>
  idsOf(b).find((id) => b.nodes[id].title === title) as string;

/* ---------- 解析 ---------- */

test('parseBoard: 手改过的坏数据也能开（缺字段补默认，不是整个打不开）', () => {
  const b = parseBoard(JSON.stringify({
    root: ['x'],
    nodes: { x: { kind: 'task', title: '甲' } },
  }));
  const x = b.nodes.x;
  assert.ok(isTask(x));
  assert.equal(x.status, 'todo', '缺 status 默认待办');
  assert.deepEqual(x.deps, []);
});

test('parseBoard: 挂错位置的节点会被补进 root（不然它根本不显示）', () => {
  const b = parseBoard(JSON.stringify({
    root: [],
    nodes: { x: { kind: 'task', title: '孤儿', status: 'todo', deps: [] } },
  }));
  assert.deepEqual(b.root, ['x']);
});

test('parseBoard: 指向不存在节点的 children / deps 被清掉', () => {
  const b = parseBoard(JSON.stringify({
    root: ['g'],
    nodes: {
      g: { kind: 'group', title: 'G', children: ['没有这个'] },
      t: { kind: 'task', title: 'T', status: 'todo', deps: ['也没有'] },
    },
  }));
  assert.deepEqual((b.nodes.g as { children: string[] }).children, []);
  assert.deepEqual((b.nodes.t as { deps: string[] }).deps, []);
});

test('parseBoard: 非 JSON 返回空板，不抛', () => {
  assert.deepEqual(parseBoard('不是 json').nodes, {});
  assert.deepEqual(parseBoard(null).nodes, {});
});

test('序列化后再解析，内容一致（往返）', () => {
  const b = board();
  assert.deepEqual(parseBoard(serializeBoard(b)).nodes, b.nodes);
});

/* ---------- 树 ---------- */

test('parentOf / childrenOf: 嵌套两层', () => {
  const b = board();
  const g1 = findTask(b, '登录');
  const g2 = findTask(b, '接口');
  assert.equal(parentOf(b, g2), g1);
  assert.equal(parentOf(b, g1), null);
  assert.equal(childrenOf(b, g1).length, 2);
});

test('pathOf: 从根到自身的链', () => {
  const b = board();
  const t3 = findTask(b, '补测试');
  assert.equal(pathOf(b, t3).length, 3);
  assert.equal(b.nodes[pathOf(b, t3)[0]].title, '登录');
});

test('leafTaskIds: 组展开成它下面的任务，任务就是自己', () => {
  const b = board();
  assert.equal(leafTaskIds(b, findTask(b, '接口')).length, 2);
  assert.equal(leafTaskIds(b, findTask(b, '写接口')).length, 1);
});

test('isAncestor: 能认出祖孙，用于阻止"挪进自己子树"', () => {
  const b = board();
  assert.equal(isAncestor(b, findTask(b, '登录'), findTask(b, '补测试')), true);
  assert.equal(isAncestor(b, findTask(b, '补测试'), findTask(b, '登录')), false);
});

/* ---------- 依赖与解锁 ---------- */

test('lockOf: 前置未完成 → 锁住', () => {
  let b = board();
  const t1 = findTask(b, '设计表');
  const t2 = findTask(b, '写接口');
  b = setDeps(b, t2, [t1]).board;
  assert.equal(lockOf(b, t2).locked, true);
  assert.deepEqual(lockOf(b, t2).pending, [t1]);
});

test('lockOf: 前置完成后解锁', () => {
  let b = board();
  const t1 = findTask(b, '设计表');
  const t2 = findTask(b, '写接口');
  b = setDeps(b, t2, [t1]).board;
  b = setTaskStatus(b, t1, 'done').board;
  assert.equal(lockOf(b, t2).locked, false, '锁定是算出来的，不该靠手工同步');
});

test('lockOf: 依赖指向组 = 等它下面全部完成', () => {
  let b = board();
  const g2 = findTask(b, '接口');
  const last = findTask(b, '发版');
  b = setDeps(b, last, [g2]).board;
  assert.equal(lockOf(b, last).pending.length, 2, '组里两个任务都没完成');
  b = setTaskStatus(b, findTask(b, '写接口'), 'done').board;
  assert.equal(lockOf(b, last).locked, true, '只完成一个还不够');
  b = setTaskStatus(b, findTask(b, '补测试'), 'done').board;
  assert.equal(lockOf(b, last).locked, false);
});

test('lockOf: 前置被删掉要报出来（否则永远锁着却无从下手）', () => {
  let b = board();
  const t1 = findTask(b, '设计表');
  const t2 = findTask(b, '写接口');
  b = setDeps(b, t2, [t1]).board;
  b = removeNode(b, t1);
  const lock = lockOf(b, t2);
  assert.equal(lock.locked, false, '不因为"前置不存在"而锁死');
  assert.deepEqual(lock.missing, [], 'removeNode 已经把悬空依赖摘掉了');
});

test('lockOf: 互相依赖成环要能识别', () => {
  let b = board();
  const t2 = findTask(b, '写接口');
  const t3 = findTask(b, '补测试');
  b = setDeps(b, t2, [t3]).board;
  b = setDeps(b, t3, [t2]).board;
  assert.equal(lockOf(b, t2).cyclic, true);
  assert.equal(lockOf(b, t2).locked, true);
});

test('lockOf: 组没有锁定概念（它是容器）', () => {
  const b = board();
  assert.equal(lockOf(b, findTask(b, '接口')).locked, false);
});

test('setDeps: 忽略指向自己与不存在的 id', () => {
  const b = board();
  const t1 = findTask(b, '设计表');
  const r = setDeps(b, t1, [t1, '不存在']);
  assert.deepEqual((r.board.nodes[t1] as { deps: string[] }).deps, []);
  assert.equal(r.warnings.length > 0, true);
});

/* ---------- 组的状态是聚合出来的 ---------- */

test('statusOf: 全完成才是完成，有一个在跑就是进行中', () => {
  let b = board();
  const g2 = findTask(b, '接口');
  assert.equal(statusOf(b, g2), 'todo');
  b = setTaskStatus(b, findTask(b, '写接口'), 'doing').board;
  assert.equal(statusOf(b, g2), 'doing');
  b = setTaskStatus(b, findTask(b, '补测试'), 'done').board;
  b = setTaskStatus(b, findTask(b, '写接口'), 'done').board;
  assert.equal(statusOf(b, g2), 'done');
});

test('tallyOf: 统计叶子任务，锁住的数量单独算', () => {
  let b = board();
  const g2 = findTask(b, '接口');
  const t2 = findTask(b, '写接口');
  const t1 = findTask(b, '设计表');
  b = setDeps(b, t2, [t1]).board;
  const t = tallyOf(b, g2);
  assert.equal(t.total, 2);
  assert.equal(t.locked, 1);
});

/* ---------- 拆分 ---------- */

test('splitTask: 任务变组，原 id 保留（别处的依赖不用改）', () => {
  const b = board();
  const t1 = findTask(b, '设计表');
  const r = splitTask(b, t1, ['画 ER 图', '定字段']);
  assert.ok(isGroup(r.board.nodes[t1]), '同一个 id 变成组');
  assert.equal(leafTaskIds(r.board, t1).length, 2);
});

test('splitTask: 子任务继承原任务的前置', () => {
  let b = board();
  const t0 = findTask(b, '设计表');
  const t2 = findTask(b, '写接口');
  b = setDeps(b, t2, [t0]).board;
  // 把"写接口"拆开：两个子任务都还得等"设计表"
  const r = splitTask(b, t2, ['读库', '写库']);
  for (const leaf of leafTaskIds(r.board, t2)) {
    assert.deepEqual((r.board.nodes[leaf] as { deps: string[] }).deps, [t0]);
  }
});

test('splitTask: 依赖它的任务不用改 —— 指向组即"等这组全部完成"', () => {
  let b = board();
  const t1 = findTask(b, '设计表');
  const t2 = findTask(b, '写接口');
  const last = findTask(b, '发版');
  b = setDeps(b, last, [t2]).board;
  const r = splitTask(b, t2, ['读库', '写库']);
  assert.deepEqual((r.board.nodes[last] as { deps: string[] }).deps, [t2]);
  assert.equal(lockOf(r.board, last).pending.length, 2, '两个子任务都算它的前置');
});

test('splitTask: 已经是组就再加一层（多层拆分）', () => {
  const b = board();
  const g2 = findTask(b, '接口');
  const r = splitTask(b, g2, ['第三层']);
  assert.equal(leafTaskIds(r.board, g2).length, 3);
});

test('splitTask: 没填标题不动，并说明原因', () => {
  const b = board();
  const r = splitTask(b, findTask(b, '设计表'), ['  ']);
  assert.equal(r.board, b);
  assert.equal(r.warnings.length > 0, true);
});

/* ---------- 合并 ---------- */

test('mergeIntoGroup: 多个节点进一个组，位置取第一个原来的位置', () => {
  const b = board();
  const t2 = findTask(b, '写接口');
  const t3 = findTask(b, '补测试');
  const before = childrenOf(b, findTask(b, '接口')).length;
  const r = mergeIntoGroup(b, [t2, t3], '新组');
  assert.equal(childrenOf(r.board, r.id).length, 2);
  assert.equal(childrenOf(r.board, findTask(r.board, '接口')).length, before - 2 + 1, '两个搬走、新组补进来');
});

test('mergeIntoGroup: 可以把组也合并进去（多层）', () => {
  const b = board();
  const g2 = findTask(b, '接口');
  const last = findTask(b, '发版');
  const r = mergeIntoGroup(b, [g2, last], '总组');
  assert.equal(childrenOf(r.board, r.id).length, 2);
  assert.ok(isGroup(r.board.nodes[g2]), '合进来后它仍然是组');
});

test('mergeIntoGroup: 祖先与后代一起选时跳过祖先（否则自己套自己）', () => {
  const b = board();
  const g1 = findTask(b, '登录');
  const t2 = findTask(b, '写接口');
  const r = mergeIntoGroup(b, [g1, t2], '新组');
  assert.equal(childrenOf(r.board, r.id).length, 1, '只收了后代');
  assert.equal(r.warnings.length > 0, true);
});

test('mergeIntoGroup: 空选不动', () => {
  const b = board();
  const r = mergeIntoGroup(b, [], 'x');
  assert.equal(r.id, '');
  assert.equal(r.board, b);
});

/* ---------- 移动与删除 ---------- */

test('moveNode: 不能挪进自己的子树（挪了整棵就没了）', () => {
  const b = board();
  const g1 = findTask(b, '登录');
  const g2 = findTask(b, '接口');
  assert.equal(moveNode(b, g1, g2), b);
});

test('removeNode: 连子树一起删，并摘掉别处对它的依赖', () => {
  let b = board();
  const g2 = findTask(b, '接口');
  const last = findTask(b, '发版');
  b = setDeps(b, last, [g2]).board;
  const after = removeNode(b, g2);
  assert.equal(after.nodes[g2], undefined);
  assert.equal(leafTaskIds(after, g2).length, 0);
  assert.deepEqual((after.nodes[last] as { deps: string[] }).deps, [], '悬空的依赖被摘掉了');
});

test('renameNode: 只改标题', () => {
  const b = board();
  const t1 = findTask(b, '设计表');
  assert.equal(renameNode(b, t1, '设计表结构').nodes[t1].title, '设计表结构');
});

/* ---------- 领取与标记 ---------- */

test('claimTask: 正常领取，状态从待办变进行中', () => {
  const b = board();
  const t1 = findTask(b, '设计表');
  const r = claimTask(b, t1, 'ai');
  assert.equal((r.board.nodes[t1] as { assignee: string }).assignee, 'ai');
  assert.equal((r.board.nodes[t1] as { status: string }).status, 'doing');
  assert.deepEqual(r.warnings, []);
});

test('claimTask: 被前置卡住时不硬挡，但返回警告', () => {
  let b = board();
  const t1 = findTask(b, '设计表');
  const t2 = findTask(b, '写接口');
  b = setDeps(b, t2, [t1]).board;
  const r = claimTask(b, t2, 'ai');
  assert.equal((r.board.nodes[t2] as { assignee: string }).assignee, 'ai', '仍然领到了');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /前置任务未完成/);
});

test('claimTask: 被别人领过要提示', () => {
  let b = board();
  const t1 = findTask(b, '设计表');
  b = claimTask(b, t1, '甲').board;
  const r = claimTask(b, t1, '乙');
  assert.equal(r.warnings.some((w) => w.includes('甲')), true);
});

test('claimTask: 任务组不能领取', () => {
  const b = board();
  const r = claimTask(b, findTask(b, '接口'), 'ai');
  assert.equal(r.board, b);
  assert.match(r.warnings[0], /任务组不能领取/);
});

test('setTaskStatus: 锁住时标记完成也给警告，但照样标', () => {
  let b = board();
  const t1 = findTask(b, '设计表');
  const t2 = findTask(b, '写接口');
  b = setDeps(b, t2, [t1]).board;
  const r = setTaskStatus(b, t2, 'done');
  assert.equal((r.board.nodes[t2] as { status: string }).status, 'done');
  assert.equal(r.warnings.length, 1);
});

test('setTaskStatus: 组不能直接标记（它的状态是聚合出来的）', () => {
  const b = board();
  const r = setTaskStatus(b, findTask(b, '接口'), 'done');
  assert.equal(r.board, b);
  assert.match(r.warnings[0], /不能直接标记/);
});

/* ---------- 筛选：组标题不参与 ---------- */

test('matchesTask: 组的标题不参与关键词匹配', () => {
  assert.equal(matchesTask({ kind: 'group', title: '登录', children: [] }, '登录'), false);
  assert.equal(matchesTask({ kind: 'task', title: '写接口', status: 'todo', deps: [], assignee: '', note: '' }, '接口'), true);
});

test('visibleIds: 命中任务时把祖先链带上（不显示孤行）', () => {
  const b = board();
  const keep = visibleIds(b, '补测试');
  assert.ok(keep);
  assert.equal(keep.has(findTask(b, '补测试')), true);
  assert.equal(keep.has(findTask(b, '接口')), true, '父组要在');
  assert.equal(keep.has(findTask(b, '登录')), true, '祖父组也要在');
  assert.equal(keep.has(findTask(b, '发版')), false);
});

test('visibleIds: 搜组名搜不到组下的任务（组只作显示）', () => {
  const b = board();
  const keep = visibleIds(b, '登录');
  assert.equal(keep && keep.size, 0);
});

test('visibleIds: 空关键词返回 null（不做过滤）', () => {
  assert.equal(visibleIds(board(), ''), null);
});

/* ---------- 渲染行 ---------- */

test('boardRows: 折叠的组不展开子级', () => {
  const b = board();
  const g2 = findTask(b, '接口');
  const all = boardRows(b, defaultExpanded(b));
  const closed = boardRows(b, new Set());
  assert.ok(all.length > closed.length);
  assert.equal(closed.some((r) => r.id === g2), false, '父组收起后，嵌套的组不该出现');
  assert.equal(all.find((r) => r.id === g2)?.expanded, true);
});

test('boardRows: depth 反映层级', () => {
  const b = board();
  const rows = boardRows(b, defaultExpanded(b));
  const t3 = rows.find((r) => r.id === findTask(b, '补测试'));
  assert.equal(t3?.depth, 2);
});

/* ---------- 与外部改动合并 ---------- */

function withTitle(b: TaskBoard, id: string, title: string): TaskBoard {
  return { ...b, nodes: { ...b.nodes, [id]: { ...b.nodes[id], title } } };
}

test('mergeBoards: 只有我改 → 用我的', () => {
  const base = board();
  const id = findTask(base, '设计表');
  const mine = withTitle(base, id, '我改的');
  const out = mergeBoards(base, mine, base);
  assert.equal(out.board.nodes[id].title, '我改的');
  assert.deepEqual(out.overwritten, []);
});

test('mergeBoards: 只有外部改 → 用外部的', () => {
  const base = board();
  const id = findTask(base, '设计表');
  const theirs = withTitle(base, id, 'AI 改的');
  const out = mergeBoards(base, base, theirs);
  assert.equal(out.board.nodes[id].title, 'AI 改的');
});

test('mergeBoards: 两边都改 → 外部优先，并记进 overwritten', () => {
  const base = board();
  const id = findTask(base, '设计表');
  const mine = withTitle(base, id, '我改的');
  const theirs = withTitle(base, id, 'AI 改的');
  const out = mergeBoards(base, mine, theirs);
  assert.equal(out.board.nodes[id].title, 'AI 改的', 'AI 改文件是主路径，不能让它无声失效');
  assert.deepEqual(out.overwritten, [id]);
});

test('mergeBoards: 外部新增的节点要进来，并记进 added', () => {
  const base = board();
  const theirs = addNode(base, null, { kind: 'task', title: 'AI 加的', status: 'todo', deps: [], assignee: '', note: '' }).board;
  const out = mergeBoards(base, base, theirs);
  assert.ok(idsOf(out.board).some((id) => out.board.nodes[id].title === 'AI 加的'));
  assert.equal(out.added.length, 1);
});

test('mergeBoards: 我新增的节点要留着', () => {
  const base = board();
  const mine = addNode(base, null, { kind: 'task', title: '我加的', status: 'todo', deps: [], assignee: '', note: '' }).board;
  const out = mergeBoards(base, mine, base);
  assert.ok(idsOf(out.board).some((id) => out.board.nodes[id].title === '我加的'));
});

test('mergeBoards: 两边改成同一份不算冲突', () => {
  const base = board();
  const id = findTask(base, '设计表');
  const same = withTitle(base, id, '一样的');
  const out = mergeBoards(base, same, same);
  assert.deepEqual(out.overwritten, []);
});

/* ---------- id ---------- */

test('newBoardId: 前缀区分任务与组，人（和 AI）看得懂', () => {
  assert.match(newBoardId('task'), /^t_/);
  assert.match(newBoardId('group'), /^g_/);
});

test('nextFreeId: 撞了就加后缀（AI 手写的 id 可能与生成的撞）', () => {
  const b = board();
  const id = idsOf(b)[0];
  assert.equal(nextFreeId(b, id), `${id}_2`);
  assert.equal(nextFreeId(b, '全新的'), '全新的');
});

test('改动都会推进 updatedAt（外部能看出这份是新的）', () => {
  const b = board();
  const before = b.updatedAt;
  const after = renameNode(b, findTask(b, '设计表'), 'x').updatedAt;
  assert.ok(after >= before);
});

/* ---------- 手写文件的结构加固 ---------- */

test('parseBoard: 互相嵌套不把渲染卡死（BFS 认领截断环）', () => {
  const b = parseBoard(JSON.stringify({
    root: ['g1'],
    nodes: {
      g1: { kind: 'group', title: 'A', children: ['g2'] },
      g2: { kind: 'group', title: 'B', children: ['g1'] },
    },
  }));
  const rows = boardRows(b, defaultExpanded(b));
  assert.ok(rows.length < 100, `渲染行数失控：${rows.length}`);
  assert.equal(rows.length, 2, '两个组都还在，只是环被截断');
});

test('parseBoard: 同一节点写进两个组时只挂一处', () => {
  const b = parseBoard(JSON.stringify({
    root: ['g1', 'g2'],
    nodes: {
      g1: { kind: 'group', title: 'A', children: ['t'] },
      g2: { kind: 'group', title: 'B', children: ['t'] },
      t: { kind: 'task', title: 'T', status: 'todo', deps: [] },
    },
  }));
  const rows = boardRows(b, defaultExpanded(b));
  assert.equal(rows.filter((r) => r.id === 't').length, 1, '同一条任务不能显示两次');
  assert.equal(parentOf(b, 't'), 'g1', '先出现的那个父赢');
});

test('parseBoard: 环被截断后每个节点仍恰好有一个父', () => {
  const b = parseBoard(JSON.stringify({
    root: ['a'],
    nodes: {
      a: { kind: 'group', title: 'A', children: ['b', 'c'] },
      b: { kind: 'group', title: 'B', children: ['c', 'a'] },
      c: { kind: 'group', title: 'C', children: ['a'] },
    },
  }));
  for (const id of Object.keys(b.nodes)) {
    let n = 0;
    for (const p of Object.keys(b.nodes)) {
      if (isGroup(b.nodes[p]) && (b.nodes[p] as { children: string[] }).children.indexOf(id) >= 0) n += 1;
    }
    const inRoot = b.root.indexOf(id) >= 0 ? 1 : 0;
    assert.equal(n + inRoot, 1, `${id} 的父数量不对`);
  }
});

test('lockOf: 没有依赖时不跑环检测（也不误判成环）', () => {
  const b = board();
  const lock = lockOf(b, findTask(b, '设计表'));
  assert.equal(lock.cyclic, false);
  assert.equal(lock.locked, false);
});

test('mergeBoards: 两边都改了 root 顺序，不误报 overwritten', () => {
  const base = board();
  const mine = { ...base, root: [...base.root].reverse() };
  const theirs = { ...base, root: [...base.root].reverse() };
  const out = mergeBoards(base, mine, theirs);
  assert.deepEqual(out.overwritten, [], '顺序变化不是"数据被盖掉"');
});
