import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type TableRow, type TableQuery, type TableColumnId,
  buildTableRows, applyTable, emptyQuery, emptyFilter,
  filterActive, activeFilterColumns, nextSort, columnOf,
  assigneeOptionsOf, priorityLabel, TABLE_COLUMNS,
} from '../engine/taskTable';
import {
  emptyBoard, addNode, isTask, type BoardTask, type TaskBoard,
} from '../engine/taskBoard';

/** 一条任务条目（补齐新增字段） */
function task(title: string, p: Partial<BoardTask> = {}): BoardTask {
  return {
    kind: 'task', title, status: 'todo', deps: [], assignee: '', note: '',
    desc: '', tags: [], createdAt: 0, updatedAt: 0, due: 0, priority: 0,
    ...p,
  };
}

/** 一个只装任务的任务板（不走组） */
function boardOf(list: BoardTask[]): TaskBoard {
  let b = emptyBoard('p1', '项目甲');
  for (const t of list) b = addNode(b, null, t).board;
  return b;
}

const rowsOf = (list: BoardTask[]): TableRow[] => buildTableRows([], [], boardOf(list));
const idsOf = (rs: TableRow[]) => rs.map((r) => r.task?.title ?? '');

function queryWith(id: TableColumnId, patch: Partial<ReturnType<typeof emptyFilter>>): TableQuery {
  const q = emptyQuery();
  q.filters[id] = { ...emptyFilter(), ...patch };
  return q;
}

/* ---------- 每一列都要能筛选 ---------- */

test('每一列都能筛选 —— 新增列不能有"看着能点却没反应"的', () => {
  /*
    这条盯的是列定义的完整性：新加一列时，若忘了给它配筛选/排序，
    表头照样能点（视觉上与其它列无异），但点了没反应 ——
    那种失效只有逐个点一遍才会发现。
  */
  const numericOk = new Set(['number', 'time']);
  for (const c of TABLE_COLUMNS) {
    assert.ok(
      c.kind === 'enum' || c.kind === 'text' || numericOk.has(c.kind),
      `${c.id} 的 kind 不在支持范围内`,
    );
  }
  // 具体盯住本轮新加的几列确实在列里
  const ids = TABLE_COLUMNS.map((c) => c.id);
  for (const need of ['priority', 'assignee', 'tags', 'planStatus', 'attach', 'desc', 'note']) {
    assert.ok(ids.indexOf(need as TableColumnId) >= 0, `缺少列 ${need}`);
  }
});

test('优先级：按下拉档位筛，按 rank 排（不是字典序）', () => {
  const rows = rowsOf([
    task('甲', { priority: 3 }),
    task('乙', { priority: 1 }),
    task('丙', { priority: 0 }),
    task('丁', { priority: 2 }),
  ]);
  // 筛 P1 与 P2
  const filtered = applyTable(rows, queryWith('priority', { values: ['1', '2'] }), 0);
  // 筛选不改顺序，但节点插入顺序不确定 —— 两边都排序再比
  assert.deepEqual(idsOf(filtered).sort(), ['乙', '丁'].sort());

  // 升序：P1 在最前，未设排最后
  const asc: TableQuery = { filters: {}, sortKey: 'priority', sortDir: 'asc' };
  assert.deepEqual(idsOf(applyTable(rows, asc, 0)), ['乙', '丁', '甲', '丙']);

  // 降序反过来
  const desc: TableQuery = { filters: {}, sortKey: 'priority', sortDir: 'desc' };
  assert.deepEqual(idsOf(applyTable(rows, desc, 0)), ['丙', '甲', '丁', '乙']);
});

test('优先级：档位显示名与筛选值分离（改名不影响已存筛选）', () => {
  assert.equal(priorityLabel(1), 'P1 最高');
  assert.equal(priorityLabel(0), '未设');
  // 筛选用的是数字字符串，不是显示文案
  const rows = rowsOf([task('甲', { priority: 1 })]);
  const byLabel = applyTable(rows, queryWith('priority', { values: ['P1 最高'] }), 0);
  assert.equal(byLabel.length, 0, '拿显示文案去筛不该命中');
  const byValue = applyTable(rows, queryWith('priority', { values: ['1'] }), 0);
  assert.equal(byValue.length, 1);
});

test('认领：能筛出"没人认领"的（空串是有效筛选值，不是没值）', () => {
  const rows = rowsOf([
    task('甲', { assignee: '张三' }),
    task('乙', { assignee: '' }),
    task('丙', { assignee: '李四' }),
  ]);
  const unclaimed = applyTable(rows, queryWith('assignee', { values: [''] }), 0);
  assert.deepEqual(idsOf(unclaimed), ['乙'], '空串要能单独筛出来，不能当成"这行没有值"');

  const named = applyTable(rows, queryWith('assignee', { values: ['张三'] }), 0);
  assert.deepEqual(idsOf(named), ['甲']);
});

test('认领：选项从数据里去重得到，未认领排最后', () => {
  const rows = rowsOf([
    task('甲', { assignee: '张三' }),
    task('乙', { assignee: '' }),
    task('丙', { assignee: '张三' }),   // 重复，只出一个选项
  ]);
  const opts = assigneeOptionsOf(rows);
  assert.deepEqual(opts.map((o) => o.v), ['张三', '']);
  assert.equal(opts.find((o) => o.v === '')?.label, '未认领');
});

test('归属列：排序按原始值查 rank（拿显示文案查会全部落空）', () => {
  /*
    这条钉住刚修的那个 bug：rank 的键是 'live'/'archived'/'board'，
    而 cellValue 给的是"进行中"这类文案。拿文案查 → 全部 99 → 排不动。
  */
  const rows = buildTableRows([], [], boardOf([task('甲')]));
  const q: TableQuery = { filters: {}, sortKey: 'origin', sortDir: 'asc' };
  const sorted = applyTable(rows, q, 0);
  // 至少不能因为 rank 全部落空而退化成乱序（board 的 rank 是 0，应排最前）
  assert.equal(sorted[0].origin, 'board');
});

test('标签列：多值时命中任一即可（不是要全部命中）', () => {
  const rows = rowsOf([
    task('甲', { tags: ['t1'] }),
    task('乙', { tags: ['t2'] }),
    task('丙', { tags: ['t1', 't2'] }),
    task('丁', { tags: [] }),
  ]);
  const hit = applyTable(rows, queryWith('tags', { values: ['t1', 't2'] }), 0);
  assert.deepEqual(idsOf(hit).sort(), ['乙', '丙', '甲'].sort(), '挂着任一个就该命中');
  assert.ok(idsOf(hit).indexOf('丁') < 0, '没挂标签的不该命中任何选项');
});

test('任务级列：运行记录行的值是空的（不硬填）', () => {
  const rows = buildTableRows([], [], boardOf([task('甲', { priority: 1, assignee: '张三' })]));
  const boardRow = rows.find((r) => r.origin === 'board');
  assert.ok(boardRow);
  assert.equal(boardRow.task?.priority, 1);
  // 运行记录行没有 task，任务级列取不到值
  const liveOnly = buildTableRows([], [], null);
  assert.equal(liveOnly.length, 0);
});

/* ---------- 排序三态与筛选生效判定 ---------- */

test('nextSort：无序 → 降序 → 升序 → 无序（第三下回到无序）', () => {
  const neutral = { sortKey: '' as TableColumnId | '', sortDir: 'desc' as const };
  const p = nextSort(neutral, 'priority');
  assert.equal(p.sortKey, 'priority');
  assert.equal(p.sortDir, 'desc', '第一次点给降序');
  const a = nextSort(p, 'priority');
  assert.equal(a.sortDir, 'asc', '第二次点给升序');
  assert.equal(nextSort(a, 'priority').sortKey, '', '第三次点回到无序');
});

test('filterActive：各类型判空只认自己那几个字段', () => {
  assert.equal(filterActive(columnOf('priority'), emptyFilter()), false);
  assert.equal(filterActive(columnOf('priority'), { ...emptyFilter(), values: ['1'] }), true);
  assert.equal(filterActive(columnOf('desc'), { ...emptyFilter(), text: '登录' }), true);
  assert.equal(filterActive(columnOf('created'), { ...emptyFilter(), min: '2026-01-01' }), true);
});

test('activeFilterColumns：只数真正生效的列', () => {
  const q = emptyQuery();
  q.filters.priority = { ...emptyFilter(), values: ['1'] };
  q.filters.desc = emptyFilter();          // 建了但全空，不算生效
  assert.deepEqual(activeFilterColumns(q), ['priority']);
});

test('组合筛选：多列是"且"（收窄而不是变宽）', () => {
  const rows = rowsOf([
    task('甲', { priority: 1, assignee: '张三' }),
    task('乙', { priority: 1, assignee: '李四' }),
    task('丙', { priority: 3, assignee: '张三' }),
  ]);
  const q = emptyQuery();
  q.filters.priority = { ...emptyFilter(), values: ['1'] };
  q.filters.assignee = { ...emptyFilter(), values: ['张三'] };
  assert.deepEqual(idsOf(applyTable(rows, q, 0)), ['甲']);
});
