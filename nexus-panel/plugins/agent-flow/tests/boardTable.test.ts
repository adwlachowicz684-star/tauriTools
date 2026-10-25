import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type BoardRow, type BoardColumnId, type BoardQuery,
  BOARD_COLUMNS, buildBoardRows, applyBoardQuery, boardActiveFilters,
  boardFilterActive, emptyBoardFilter, emptyBoardQuery, nextBoardSort,
  boardColumnOf, priorityLabel, distinctOptionsOf, GROUP_SEP,
} from '../engine/boardTable';
import {
  emptyBoard, addNode, isGroup, type BoardTask, type TaskBoard,
} from '../engine/taskBoard';

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
  ids.表单 = mk('表单', ids.登录, task('表单', { priority: 1, assignee: '张三', session: 'w_1_aaaaaa' }));
  ids.校验 = mk('校验', ids.登录, task('校验', { priority: 3, tags: ['t1'] }));
  ids.支付 = mk('支付', ids.容器, task('支付', { desc: '收款流程', note: '待确认' }));
  return { b, ids };
}

const rowsOf = (b: TaskBoard): BoardRow[] => buildBoardRows(b);
const titles = (rs: BoardRow[]) => rs.map((r) => r.task.title);

function queryWith(id: BoardColumnId, patch: Partial<ReturnType<typeof emptyBoardFilter>>): BoardQuery {
  const q = emptyBoardQuery();
  q.filters[id] = { ...emptyBoardFilter(), ...patch };
  return q;
}

/* ---------- 摊平 ---------- */

test('组不占行，只有任务是行', () => {
  const { b, ids } = deep();
  const rows = rowsOf(b);
  assert.equal(rows.length, 3, '三个任务，两个组都不占行');
  assert.ok(!rows.some((r) => r.id === ids.登录));
});

test('先序遍历：顺序与树上的上下顺序一致', () => {
  const { b } = deep();
  assert.deepEqual(titles(rowsOf(b)), ['表单', '校验', '支付']);
});

test('所属组路径与深度随嵌套带出来', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  const byTitle = new Map(rows.map((r) => [r.task.title, r]));
  assert.equal(byTitle.get('表单')?.groupPath, `容器${GROUP_SEP}登录`);
  assert.equal(byTitle.get('支付')?.groupPath, '容器');
  assert.equal(byTitle.get('表单')?.depth, 2);
  assert.equal(byTitle.get('支付')?.depth, 1);
});

/* ---------- 每一列都要能筛能排 ---------- */

test('每一列都有 kind（新加列不能有"看着能点却没反应"的）', () => {
  const ok = new Set(['enum', 'text', 'number', 'time']);
  for (const c of BOARD_COLUMNS) {
    assert.ok(ok.has(c.kind), `${c.id} 的 kind 不在支持范围内`);
  }
  // 撤掉的那些列确实都回来了
  const ids = BOARD_COLUMNS.map((c) => c.id);
  for (const need of ['status', 'priority', 'assignee', 'session', 'tags', 'desc', 'note', 'created', 'updated', 'attach', 'group']) {
    assert.ok(ids.indexOf(need as BoardColumnId) >= 0, `缺少列 ${need}`);
  }
});

test('优先级：按下拉档位筛，按 rank 排（不是字典序）', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  const hit = applyBoardQuery(rows, queryWith('priority', { values: ['1', '3'] }), {});
  assert.deepEqual(titles(hit).sort(), ['表单', '校验'].sort());

  const asc = applyBoardQuery(rows, { filters: {}, sortKey: 'priority', sortDir: 'asc' }, {});
  // 表单 P1 最前，支付未设(0)排最后
  assert.equal(asc[0].task.title, '表单');
  assert.equal(asc[asc.length - 1].task.title, '支付');
});

test('优先级：筛选用数字字符串，拿显示文案去筛不该命中', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  assert.equal(applyBoardQuery(rows, queryWith('priority', { values: ['P1 最高'] }), {}).length, 0);
  assert.equal(applyBoardQuery(rows, queryWith('priority', { values: ['1'] }), {}).length, 1);
  assert.equal(priorityLabel(1), 'P1 最高');
  assert.equal(priorityLabel(0), '未设');
});

test('认领：空串是有效筛选值（能筛出没人认领的）', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  const un = applyBoardQuery(rows, queryWith('assignee', { values: [''] }), {});
  assert.deepEqual(titles(un).sort(), ['校验', '支付'].sort());
  const named = applyBoardQuery(rows, queryWith('assignee', { values: ['张三'] }), {});
  assert.deepEqual(titles(named), ['表单']);
});

test('窗口：能筛出"我的"，也能筛出"没人认领的"', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  assert.deepEqual(titles(applyBoardQuery(rows, queryWith('session', { values: ['w_1_aaaaaa'] }), {})), ['表单']);
  assert.equal(applyBoardQuery(rows, queryWith('session', { values: [''] }), {}).length, 2);
});

test('标签：多值命中任一即可（不是要全部命中）', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  const hit = applyBoardQuery(rows, queryWith('tags', { values: ['t1'] }), {});
  assert.deepEqual(titles(hit), ['校验']);
  // 没挂标签的不该命中任何选项
  assert.equal(applyBoardQuery(rows, queryWith('tags', { values: ['t2'] }), {}).length, 0);
});

test('文本列：关键词包含，不区分大小写', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  assert.deepEqual(titles(applyBoardQuery(rows, queryWith('desc', { text: '收款' }), {})), ['支付']);
  assert.deepEqual(titles(applyBoardQuery(rows, queryWith('note', { text: '确认' }), {})), ['支付']);
});

test('所属组：能按路径关键词筛（同组的一起出来）', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  const hit = applyBoardQuery(rows, queryWith('group', { text: '登录' }), {});
  assert.equal(hit.length, 2);
  assert.ok(hit.every((r) => r.groupPath.includes('登录')));
});

test('所属组：排序后同组的相邻，不是按任务名打散', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  const sorted = applyBoardQuery(rows, { filters: {}, sortKey: 'group', sortDir: 'asc' }, {});
  const login = sorted.filter((r) => r.groupPath.includes('登录'));
  assert.equal(login.length, 2);
  assert.equal(Math.abs(sorted.indexOf(login[0]) - sorted.indexOf(login[1])), 1, '同组要相邻');
});

test('附件：按区间筛', () => {
  const { b, ids } = deep();
  const rows = rowsOf(b);
  const attach = { [ids.表单]: 3, [ids.支付]: 1 };
  const hit = applyBoardQuery(rows, queryWith('attach', { min: '2' }), attach);
  assert.deepEqual(titles(hit), ['表单']);
});

test('时间列：0（没记录）不参与区间筛选', () => {
  const { b, ids } = deep();
  const rows = rowsOf(b);
  // 给表单一个创建时间
  const withTime = rows.map((r) => (
    r.id === ids.表单 ? { ...r, task: { ...r.task, createdAt: Date.parse('2026-01-15T10:00:00') } } : r
  ));
  const hit = applyBoardQuery(withTime, queryWith('created', { min: '2026-01-01', max: '2026-12-31' }), {});
  assert.deepEqual(titles(hit), ['表单'], '没时间戳的不该被区间带出来');
});

test('组合筛选是"且"（收窄而不是变宽）', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  const q = emptyBoardQuery();
  q.filters.priority = { ...emptyBoardFilter(), values: ['1'] };
  q.filters.assignee = { ...emptyBoardFilter(), values: ['张三'] };
  assert.deepEqual(titles(applyBoardQuery(rows, q, {})), ['表单']);
});

/* ---------- 排序三态与生效判定 ---------- */

test('nextBoardSort：无序 → 降序 → 升序 → 无序', () => {
  const neutral = { sortKey: '' as BoardColumnId | '', sortDir: 'desc' as const };
  const p = nextBoardSort(neutral, 'priority');
  assert.equal(p.sortKey, 'priority');
  assert.equal(p.sortDir, 'desc');
  assert.equal(nextBoardSort(p, 'priority').sortDir, 'asc');
  assert.equal(nextBoardSort(nextBoardSort(p, 'priority'), 'priority').sortKey, '');
});

test('boardFilterActive：各类型只认自己那几个字段', () => {
  assert.equal(boardFilterActive(boardColumnOf('priority'), emptyBoardFilter()), false);
  assert.equal(boardFilterActive(boardColumnOf('priority'), { ...emptyBoardFilter(), values: ['1'] }), true);
  assert.equal(boardFilterActive(boardColumnOf('desc'), { ...emptyBoardFilter(), text: '收款' }), true);
  assert.equal(boardFilterActive(boardColumnOf('attach'), { ...emptyBoardFilter(), min: '1' }), true);
  assert.equal(boardFilterActive(boardColumnOf('created'), { ...emptyBoardFilter(), min: '2026-01-01' }), true);
});

test('boardActiveFilters：只数真正生效的列（建了但全空的不算）', () => {
  const q = emptyBoardQuery();
  q.filters.priority = { ...emptyBoardFilter(), values: ['1'] };
  q.filters.desc = emptyBoardFilter();
  assert.deepEqual(boardActiveFilters(q), ['priority']);
});

test('空的 filter 对象不会让整表变空（最难自查的那类 bug）', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  const q = emptyBoardQuery();
  // 建了对象但全空 —— 若照样拿去匹配，enum 列 values 是空数组会全部不匹配
  q.filters.status = emptyBoardFilter();
  assert.equal(applyBoardQuery(rows, q, {}).length, rows.length);
});

/* ---------- 动态选项 ---------- */

test('动态选项从数据去重得到，空值排最后', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  const a = distinctOptionsOf(rows, 'assignee');
  assert.deepEqual(a.map((o) => o.v), ['张三', '']);
  assert.equal(a.find((o) => o.v === '')?.label, '未认领');

  const s = distinctOptionsOf(rows, 'session');
  assert.deepEqual(s.map((o) => o.v), ['w_1_aaaaaa', '']);
  assert.equal(s.find((o) => o.v === '')?.label, '未知');
});

test('动态选项从**过滤后**的行算（不含已被筛掉的人）', () => {
  const { b } = deep();
  const rows = rowsOf(b);
  // 先筛出"登录"组下的两条，其中只有张三有人认领
  const filtered = applyBoardQuery(rows, queryWith('group', { text: '登录' }), {});
  const opts = distinctOptionsOf(filtered, 'assignee');
  assert.deepEqual(opts.map((o) => o.v), ['张三', '']);
});
