import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBoard, addNode, moveNode, mergeIntoGroup, splitTask,
  isGroup, isTask, childrenOf, parentOf, pathOf, descendantIds,
  boardRows, leafTaskIds, type TaskBoard, type BoardTask,
} from '../engine/taskBoard';
import {
  buildTableRows, applyTable, emptyQuery, emptyFilter, GROUP_SEP,
} from '../engine/taskTable';

function task(title: string, p: Partial<BoardTask> = {}): BoardTask {
  return {
    kind: 'task', title, status: 'todo', deps: [], assignee: '', note: '',
    desc: '', tags: [], createdAt: 0, updatedAt: 0, due: 0, priority: 0,
    session: '', prevSession: '', tookAt: 0,
    ...p,
  };
}
const group = (title: string) => ({ kind: 'group' as const, title, children: [] as string[] });

/** 三层：容器[ 登录[ 表单, 校验 ], 支付 ] */
function deep(): { b: TaskBoard; ids: Record<string, string> } {
  let b = emptyBoard('p1', '甲');
  const ids: Record<string, string> = {};
  const mk = (title: string, parent: string | null, node: BoardTask | ReturnType<typeof group>) => {
    const r = addNode(b, parent, node);
    b = r.board;
    return r.id;
  };
  ids.容器 = mk('容器', null, group('容器'));
  ids.登录 = mk('登录', ids.容器, group('登录'));
  ids.表单 = mk('表单', ids.登录, task('表单'));
  ids.校验 = mk('校验', ids.登录, task('校验'));
  ids.支付 = mk('支付', ids.容器, task('支付'));
  return { b, ids };
}

/* ---------- 递归嵌套本身 ---------- */

test('组下可以再加组（递归不靠"只允许两层"的特判实现）', () => {
  const { b, ids } = deep();
  assert.ok(isGroup(b.nodes[ids.登录]), '第二层是组');
  assert.equal(parentOf(b, ids.登录), ids.容器, '它的父也是一个组');
  // 三层深度
  assert.equal(pathOf(b, ids.表单).length, 3);
});

test('祖先链与后代集合在深层嵌套下正确', () => {
  const { b, ids } = deep();
  assert.deepEqual(pathOf(b, ids.表单), [ids.容器, ids.登录, ids.表单]);
  const all = descendantIds(b, ids.容器);
  assert.ok(all.includes(ids.登录) && all.includes(ids.表单) && all.includes(ids.支付));
  assert.equal(leafTaskIds(b, ids.容器).length, 3, '三个叶子任务');
});

test('把组整个挪到另一个组下（组套组）', () => {
  let { b, ids } = deep();
  // 把"登录"组挪进一个新组"鉴权"里
  const r = addNode(b, ids.容器, group('鉴权'));
  b = r.board;
  b = moveNode(b, ids.登录, r.id);
  assert.equal(parentOf(b, ids.登录), r.id);
  assert.equal(pathOf(b, ids.表单).length, 4, '深度变成四层');
});

test('不能把组挪进自己的子树（否则整块从树上消失）', () => {
  const { b, ids } = deep();
  const bad = moveNode(b, ids.登录, ids.表单);   // 表单在登录里面
  assert.equal(bad, b, '这种移动必须被拒绝');
  assert.equal(parentOf(bad, ids.登录), ids.容器, '原结构不受影响');
});

/* ---------- 合并：多个任务合为组，且组里可以有组 ---------- */

test('同一组里的多个任务合并成一个组（合并后仍在原父下）', () => {
  let { b, ids } = deep();
  const r = mergeIntoGroup(b, [ids.表单, ids.校验], '表单相关');
  b = r.board;
  assert.ok(isGroup(b.nodes[r.id]));
  assert.equal(parentOf(b, r.id), ids.登录, '新组落在原来那个父组下');
  assert.deepEqual(childrenOf(b, r.id), [ids.表单, ids.校验], '两个任务都进去了');
  assert.equal(childrenOf(b, ids.登录).length, 1, '父组下现在只剩这个新组');
});

test('合并时可以带上组 —— 结果与组层级共存（组里套组）', () => {
  let { b, ids } = deep();
  // 把"登录"这个组 和 "支付"任务 合成一个组
  const r = mergeIntoGroup(b, [ids.登录, ids.支付], '主流程');
  b = r.board;
  assert.ok(isGroup(b.nodes[r.id]));
  const kids = childrenOf(b, r.id);
  assert.ok(kids.includes(ids.登录), '组被收进来了');
  assert.ok(kids.includes(ids.支付), '任务也进来了');
  // 收进来的组内部结构完好
  assert.deepEqual(childrenOf(b, ids.登录), [ids.表单, ids.校验]);
  assert.equal(pathOf(b, ids.表单).length, 4, '表单现在在第四层');
});

test('合并时跳过"是别人祖先"的节点（否则会造出自己套自己）', () => {
  const { b: orig, ids } = deep();
  const r = mergeIntoGroup(orig, [ids.登录, ids.表单], 'X');   // 表单在登录里面
  const b = r.board;
  assert.ok(r.warnings.some((w) => w.includes('父级')), '要给警告说明跳过了');
  // 结果不能出现环：表单的祖先里不该有表单自己
  const chain = pathOf(b, ids.表单);
  assert.equal(new Set(chain).size, chain.length, '祖先链不能有重复（无环）');
});

test('跨层级合并也成立（本来就是把它们搬到一起）', () => {
  let { b, ids } = deep();
  const r = mergeIntoGroup(b, [ids.支付, ids.表单], '跨层');
  b = r.board;
  assert.deepEqual(childrenOf(b, r.id).sort(), [ids.表单, ids.支付].sort());
  assert.ok(r.warnings.some((w) => w.includes('不同层级')), '要说明搬动了');
});

/* ---------- 拆分后原节点变成组（可以继续往里加）---------- */

test('拆出的子任务之上是组，该组还能再加一层组', () => {
  let { b, ids } = deep();
  b = splitTask(b, ids.支付, ['收款', '对账']).board;
  assert.ok(isGroup(b.nodes[ids.支付]), '原 id 变成组');
  assert.equal(leafTaskIds(b, ids.支付).length, 2);
  // 继续往这个新组里加一个子组
  const r = addNode(b, ids.支付, group('子步骤'));
  b = r.board;
  assert.equal(parentOf(b, r.id), ids.支付);
});

/* ---------- 表格：嵌套结构要看得见 ---------- */

test('表格每行带上所属组路径（顶层为空）', () => {
  const { b } = deep();
  const rows = buildTableRows([], [], b);
  const byTitle = new Map(rows.map((r) => [r.task?.title ?? '', r]));
  assert.equal(byTitle.get('表单')?.groupPath, `容器${GROUP_SEP}登录`);
  assert.equal(byTitle.get('支付')?.groupPath, '容器');
  // 深度
  assert.equal(byTitle.get('表单')?.depth, 2);
  assert.equal(byTitle.get('支付')?.depth, 1);
});

test('所属组列能筛（按关键词包含，同组的一起出来）', () => {
  const { b } = deep();
  const rows = buildTableRows([], [], b);
  const q = emptyQuery();
  q.filters.group = { ...emptyFilter(), text: '登录' };
  const hit = applyTable(rows, q, 0);
  assert.equal(hit.length, 2, '登录组下的两条');
  assert.ok(hit.every((r) => r.groupPath.includes('登录')));
});

test('所属组列能排序（同组的相邻，不是按任务名打散）', () => {
  const { b } = deep();
  const rows = buildTableRows([], [], b);
  const q: typeof emptyQuery.prototype = { ...emptyQuery(), sortKey: 'group', sortDir: 'asc' };
  const sorted = applyTable(rows, q, 0);
  // "容器 › 登录" 开头的两条必须挨在一起
  const login = sorted.filter((r) => r.groupPath.includes('登录'));
  assert.equal(login.length, 2);
  const i1 = sorted.indexOf(login[0]);
  const i2 = sorted.indexOf(login[1]);
  assert.equal(Math.abs(i1 - i2), 1, '同组的要相邻');
});

test('组本身不占行（它的状态由下面决定，单独成行会显示成待办误导人）', () => {
  const { b, ids } = deep();
  const rows = buildTableRows([], [], b);
  assert.equal(rows.length, 3, '只有三个任务，组不占行');
  assert.ok(!rows.some((r) => r.ownerId === ids.登录));
});

test('深层嵌套下 boardRows 逐层展开不漏', () => {
  const { b, ids } = deep();
  const expanded = new Set([ids.容器, ids.登录]);
  const rows = boardRows(b, expanded);
  const titles = rows.map((r) => r.node.title);
  assert.deepEqual(titles, ['容器', '登录', '表单', '校验', '支付']);
  // 折叠最内层时只剩组与另一个任务
  const partial = boardRows(b, new Set([ids.容器]));
  assert.deepEqual(partial.map((r) => r.node.title), ['容器', '登录', '支付']);
});
