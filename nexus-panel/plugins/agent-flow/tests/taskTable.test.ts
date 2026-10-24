import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTableRows, parseRowKey, cellValue, filterActive, filterRows, sortRows,
  applyTable, nextSort, tableSlice, emptyFilter, emptyQuery, activeFilterColumns,
  columnOf, TABLE_COLUMNS, TABLE_ROW_HEIGHT, formatEndedAt,
  type TableQuery, type TableRow,
} from '../engine/taskTable';
import { makeTask, finishTask, type TaskRecord } from '../engine/tasks';

const T0 = 1700000000000;       // 2023-11-14 22:13 UTC
const MIN = 60000;
const HOUR = 3600000;

function rec(o: {
  id: string; name: string; status?: TaskRecord['status']; source?: TaskRecord['source'];
  startedAt?: number; endedAt?: number; total?: number;
}): TaskRecord {
  const t = makeTask({
    id: o.id,
    canvasId: 'c1',
    canvasName: o.name,
    source: o.source ?? 'manual',
    total: o.total ?? 2,
    now: o.startedAt ?? T0,
  });
  if (o.status === 'cancelled') {
    // finishTask 出不了 cancelled（它只认成功/失败），取消是另一条路径
    return { ...t, status: 'cancelled' as const, endedAt: o.endedAt ?? T0 + MIN };
  }
  if (o.status && o.status !== 'running') return finishTask(t, o.status === 'success', o.endedAt ?? T0 + MIN);
  return t;
}

const liveA = rec({ id: 'a', name: '日报', status: 'running' });
// 刻意放在**前一天**：时间区间筛选那条用例要能区分"当天开始"与"不是当天"
const liveB = rec({
  id: 'b', name: '周报', status: 'failed', source: 'cron',
  startedAt: T0 - 25 * HOUR, endedAt: T0 - 25 * HOUR + MIN,
});
const archA = rec({ id: 'a', name: '日报', status: 'success', startedAt: T0 - 2 * HOUR, endedAt: T0 - 2 * HOUR + MIN });
const archC = rec({ id: 'c', name: '月报', status: 'cancelled', source: 'webhook', startedAt: T0 - 3 * HOUR, endedAt: T0 - 3 * HOUR + MIN });

/* ---------- 合并 ---------- */

test('buildTableRows: 两路数据都进表', () => {
  const rows = buildTableRows([liveA], [archA, archC]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.origin), ['live', 'archived', 'archived']);
});

test('buildTableRows: id 相同也各自成行（key 带前缀，不会互相顶掉）', () => {
  const rows = buildTableRows([liveA], [archA]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.key), ['live:a', 'archived:a']);
  assert.equal(new Set(rows.map((r) => r.key)).size, 2);
});

test('parseRowKey: 反解出归属与 id', () => {
  assert.deepEqual(parseRowKey('live:x1'), { origin: 'live', id: 'x1' });
  assert.deepEqual(parseRowKey('archived:x1'), { origin: 'archived', id: 'x1' });
});

test('parseRowKey: 认不出就返回 null，不猜', () => {
  assert.equal(parseRowKey('x1'), null);
  assert.equal(parseRowKey('other:x1'), null);
  assert.equal(parseRowKey(''), null);
});

/* ---------- 取值 ---------- */

test('cellValue: 未结束的记录 endedAt 取 0（排序稳定，不跟着 now 漂）', () => {
  const row: TableRow = { key: 'live:a', origin: 'live', record: liveA };
  assert.equal(cellValue(row, 'ended', T0), 0);
  assert.equal(cellValue(row, 'started', T0), T0);
});

test('cellValue: 进度与节点数取得到', () => {
  const row: TableRow = { key: 'live:a', origin: 'live', record: liveA };
  assert.equal(cellValue(row, 'progress', T0), 0);
  assert.equal(cellValue(row, 'nodes', T0), 2);
});

test('formatEndedAt: 没有结束时间显示占位符，不编一个时间', () => {
  assert.equal(formatEndedAt(undefined), '—');
  assert.equal(formatEndedAt(0), '—');
});

/* ---------- 筛选判空 ---------- */

test('filterActive: 空筛选不算生效（否则 enum 列会把整表筛空）', () => {
  const f = emptyFilter();
  for (const c of TABLE_COLUMNS) assert.equal(filterActive(c, f), false, `列 ${c.id} 空筛选不该生效`);
});

test('filterActive: 各类型填了才算生效', () => {
  assert.equal(filterActive(columnOf('status'), { ...emptyFilter(), values: ['failed'] }), true);
  assert.equal(filterActive(columnOf('name'), { ...emptyFilter(), text: '日' }), true);
  assert.equal(filterActive(columnOf('name'), { ...emptyFilter(), text: '   ' }), false, '纯空格不算关键词');
  assert.equal(filterActive(columnOf('elapsed'), { ...emptyFilter(), min: '10' }), true);
  assert.equal(filterActive(columnOf('elapsed'), { ...emptyFilter(), max: 'x' }), false, '非数字不算生效');
  assert.equal(filterActive(columnOf('started'), { ...emptyFilter(), min: '2023-11-01' }), true);
  assert.equal(filterActive(columnOf('started'), { ...emptyFilter(), min: '不是日期' }), false, '解析不出的日期不算生效');
});

/* ---------- 筛选 ---------- */

const allRows = () => buildTableRows([liveA, liveB], [archA, archC]);

function q(patch: Partial<TableQuery>): TableQuery {
  return { ...emptyQuery(), ...patch };
}

test('筛选: 无筛选时原样返回', () => {
  assert.equal(filterRows(allRows(), q({}), T0).length, 4);
});

test('筛选: 状态多选（失败 + 已取消）', () => {
  const out = filterRows(allRows(), q({
    filters: { status: { ...emptyFilter(), values: ['failed', 'cancelled'] } },
  }), T0);
  assert.deepEqual(out.map((r) => r.record.id), ['b', 'c']);
});

test('筛选: 流程名关键词不分大小写', () => {
  const out = filterRows(allRows(), q({ filters: { name: { ...emptyFilter(), text: '日报' } } }), T0);
  assert.equal(out.length, 2, 'live 与归档里的两条日报都该命中');
});

test('筛选: 归属筛选能分开当前会话与归档', () => {
  const out = filterRows(allRows(), q({
    filters: { origin: { ...emptyFilter(), values: ['live'] } },
  }), T0);
  assert.deepEqual(out.map((r) => r.origin), ['live', 'live']);
});

test('筛选: 多列是与关系', () => {
  const out = filterRows(allRows(), q({
    filters: {
      origin: { ...emptyFilter(), values: ['archived'] },
      status: { ...emptyFilter(), values: ['success'] },
    },
  }), T0);
  assert.deepEqual(out.map((r) => r.key), ['archived:a']);
});

test('筛选: 数值区间（耗时 ≥ 60 秒）', () => {
  const out = filterRows(allRows(), q({
    filters: { elapsed: { ...emptyFilter(), min: '60' } },
  }), T0);
  // liveA 从 T0 起跑了 0 秒，其余都是 60 秒
  assert.equal(out.length, 3);
  assert.equal(out.some((r) => r.key === 'live:a'), false);
});

test('筛选: 时间区间按天闭合，选"到今天"要含当天', () => {
  const day = new Date(T0);
  const p = (x: number) => String(x).padStart(2, '0');
  const dayStr = `${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())}`;
  const out = filterRows(allRows(), q({
    filters: { started: { ...emptyFilter(), min: dayStr, max: dayStr } },
  }), T0);
  assert.deepEqual(out.map((r) => r.record.id), ['a', 'a', 'c'], '当天开始的三条都该在（上界含当天 23:59），25 小时前那条不该在');
});

test('筛选: 未结束的记录不参与"结束时间"区间筛选', () => {
  const out = filterRows(allRows(), q({
    filters: { ended: { ...emptyFilter(), min: '2000-01-01' } },
  }), T0);
  assert.equal(out.some((r) => r.key === 'live:a'), false, '还没结束的不该出现在"找某日以后结束的"里');
  assert.equal(out.length, 3);
});

/* ---------- 排序 ---------- */

test('排序: 状态按严重度而不是字典序（运行中在最前）', () => {
  const out = sortRows(allRows(), q({ sortKey: 'status', sortDir: 'asc' }), T0);
  assert.deepEqual(out.map((r) => r.record.status), ['running', 'failed', 'cancelled', 'success']);
});

test('排序: 升序降序相反', () => {
  const asc = sortRows(allRows(), q({ sortKey: 'started', sortDir: 'asc' }), T0);
  const desc = sortRows(allRows(), q({ sortKey: 'started', sortDir: 'desc' }), T0);
  assert.deepEqual(asc.map((r) => r.record.startedAt), [...asc.map((r) => r.record.startedAt)].sort((a, b) => a - b));
  assert.equal(asc[0].record.id, 'b', '最早的是 25 小时前那条');
  assert.equal(desc[0].record.id, 'a');
});

test('排序: 不排序时保持原顺序（live 在前）', () => {
  const out = sortRows(allRows(), q({}), T0);
  assert.deepEqual(out.map((r) => r.origin), ['live', 'live', 'archived', 'archived']);
});

test('排序: 同值时用 key 兜底，顺序完全确定（表不会自己抖）', () => {
  const rows = buildTableRows(
    [rec({ id: 'z', name: '同', status: 'success', startedAt: T0, endedAt: T0 + MIN }),
     rec({ id: 'y', name: '同', status: 'success', startedAt: T0, endedAt: T0 + MIN })],
    [],
  );
  const a = sortRows(rows, q({ sortKey: 'name', sortDir: 'asc' }), T0).map((r) => r.record.id);
  const b = sortRows(rows, q({ sortKey: 'name', sortDir: 'asc' }), T0 + 5000).map((r) => r.record.id);
  assert.deepEqual(a, b, 'now 变了顺序也不该变');
});

test('applyTable: 先筛后排', () => {
  const out = applyTable(allRows(), q({
    filters: { status: { ...emptyFilter(), values: ['failed', 'cancelled', 'success'] } },
    sortKey: 'started', sortDir: 'desc',
  }), T0);
  assert.deepEqual(out.map((r) => r.record.id), ['a', 'c', 'b']);
});

test('nextSort: 三态循环（无序 → 降 → 升 → 无序）', () => {
  const s0 = { sortKey: '' as const, sortDir: 'desc' as const };
  const s1 = nextSort(s0, 'progress');
  assert.deepEqual(s1, { sortKey: 'progress', sortDir: 'desc' });
  const s2 = nextSort(s1, 'progress');
  assert.deepEqual(s2, { sortKey: 'progress', sortDir: 'asc' });
  const s3 = nextSort(s2, 'progress');
  assert.deepEqual(s3, { sortKey: '', sortDir: 'desc' }, '第三下要能回到不排序，否则只能刷新页面');
});

test('nextSort: 换一列时从头开始', () => {
  const s = nextSort({ sortKey: 'progress', sortDir: 'asc' }, 'elapsed');
  assert.deepEqual(s, { sortKey: 'elapsed', sortDir: 'desc' });
});

test('activeFilterColumns: 只算生效的列', () => {
  const cols = activeFilterColumns(q({
    filters: { status: { ...emptyFilter(), values: ['failed'] }, name: emptyFilter() },
  }));
  assert.deepEqual(cols, ['status']);
});

/* ---------- 虚拟滚动 ---------- */

test('tableSlice: 空表不给高度', () => {
  const s = tableSlice(0, 0, 300);
  assert.deepEqual(s, { start: 0, end: 0, padTop: 0, totalHeight: 0 });
});

test('tableSlice: 顶部多留 overscan，且不会越界', () => {
  const s = tableSlice(500, 0, 300);
  assert.equal(s.start, 0, '滚到顶时起始不能是负数');
  assert.ok(s.end > 0);
  assert.equal(s.totalHeight, 500 * TABLE_ROW_HEIGHT);
});

test('tableSlice: 中部切片带 overscan', () => {
  const s = tableSlice(500, 100 * TABLE_ROW_HEIGHT, 300);
  assert.ok(s.start < 100, '上方要多渲染几行，快速滚动才不露白');
  assert.ok(s.end > 100);
  assert.equal(s.padTop, s.start * TABLE_ROW_HEIGHT);
});

test('tableSlice: 滚到底不越界', () => {
  const s = tableSlice(10, 99999, 300);
  assert.equal(s.end, 10);
  assert.ok(s.start <= 10);
});
