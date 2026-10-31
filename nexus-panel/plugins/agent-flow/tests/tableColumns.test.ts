import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type TableRow, type TableQuery, type TableColumnId,
  buildTableRows, applyTable, emptyQuery, emptyFilter, cellValue,
  filterActive, activeFilterColumns, nextSort, columnOf,
  TABLE_COLUMNS,
} from '../engine/taskTable';
import { makeTask, type TaskRecord, type TaskStatus, type TaskSource } from '../engine/tasks';

/*
 * 运行记录表格的**列能力**守卫。
 *
 * ================= 这个文件为什么不再是"计划态"那一套 =================
 *
 * 表格曾经把"计划态（要做什么）"和"运行记录（哪次跑怎么样）"合成一张，
 * 于是这里测的 priority / assignee / desc / created 全是计划态的列。
 *
 * 拆成两张表之后，那些列归 engine/boardTable（测试在 tests/boardTable.test.ts），
 * 本文件改测 engine/taskTable 现在真正的列：
 * 归属 / 流程 / 状态 / 来源 / 开始 / 结束 / 耗时 / 进度 / 节点。
 *
 * ⛔ 直接删掉这个文件是错的：它守的不变式是
 *    **"每一列都能筛、都能排"** —— 那件事对新的这张表一样成立，
 *    只是被测对象换了。删了的话新表加一列忘了接筛选，就没人会指出。
 */

const T0 = 1700000000000;
const MIN = 60000;

function rec(o: {
  id: string; name?: string; status?: TaskStatus; source?: TaskSource;
  startedAt?: number; endedAt?: number; total?: number;
}): TaskRecord {
  const t = makeTask({
    id: o.id,
    canvasId: 'c1',
    canvasName: o.name ?? o.id,
    source: o.source ?? 'manual',
    total: o.total ?? 1,
    now: o.startedAt ?? T0,
  });
  if (o.status) t.status = o.status;
  if (o.endedAt !== undefined) t.endedAt = o.endedAt;
  return t;
}

/** live 与 archived 合起来就是表格的全部行 */
const rowsOf = (live: TaskRecord[], archived: TaskRecord[] = []): TableRow[] =>
  buildTableRows(live, archived);

const namesOf = (rs: TableRow[]) => rs.map((r) => r.record.canvasName);
const liveNames = (rs: TableRow[]) =>
  rs.filter((r) => r.origin === 'live').map((r) => r.record.canvasName);

function queryWith(id: TableColumnId, patch: Partial<ReturnType<typeof emptyFilter>>): TableQuery {
  const q = emptyQuery();
  q.filters[id] = { ...emptyFilter(), ...patch };
  return q;
}

/* ---------- 每一列都要能筛选 ---------- */

test('每一列都能筛选 —— 新增列不能有"看着能点却没反应"的', () => {
  for (const c of TABLE_COLUMNS) {
    /*
      ⛔ 这两行必须**每列都有值**。
      原来只给了 id/name，而 `ended` 未结束是 undefined → 该列筛选按设计返回 false
      （见 taskTable 的 time 分支注释），于是筛完 0 行。
      这不是"列筛不了"，是**样行在这列上没值** —— 用没值的行去验"能筛"
      等于把 fixture 的缺口报成产品的缺口。
    */
    const rows = rowsOf([
      rec({ id: 'a', name: '甲', startedAt: T0, endedAt: T0 + MIN }),
      rec({ id: 'b', name: '乙', startedAt: T0 + MIN, endedAt: T0 + 2 * MIN }),
    ]);
    // 每列给一个必然命中的筛选值，筛完不能把行全筛掉
    let q: TableQuery;
    if (c.kind === 'enum') {
      const v = columnOf(c.id).options?.[0]?.v ?? '';
      q = queryWith(c.id, { values: [v] });
    } else if (c.kind === 'text') {
      q = queryWith(c.id, { text: '甲' });
    } else if (c.kind === 'number') {
      q = queryWith(c.id, { min: '0', max: '999999' });
    } else {
      q = queryWith(c.id, { min: '2000-01-01', max: '2100-01-01' });
    }
    assert.ok(
      /*
        ⛔ 原来是 `.length >= 0` —— 恒真，一条都没守：
        注释写的是"筛完不能把行全筛掉"，而 length 永远 >= 0，
        任何列哪怕筛完 0 行也照样绿。按注释的意图必须是 > 0。
      */
      applyTable(rows, q, T0).length > 0,
      `列 ${c.id}（${c.kind}）筛完不该把行全筛掉`,
    );
    assert.ok(c.kind, `列 ${c.id} 必须有 kind —— 没有 kind 就没有对应的筛选控件`);
  }
});

/*
 * 上一条要求"筛完不能把行全筛掉"，这一条是它的**另一面**，
 * 少了它就会出现"为了不红而把样行都改成有值"这种改法 —— 那样
 * 未结束记录被时间区间排除这条设计就没人钉了。
 */
test('结束时间筛选：还没结束的记录不该被带出来', () => {
  const rows = rowsOf([
    rec({ id: 'a', name: '跑完的', startedAt: T0, endedAt: T0 + MIN }),
    rec({ id: 'b', name: '还在跑', startedAt: T0 }),   // 没有 endedAt
  ]);
  /*
    ⛔ 这里**只给 max**：min 为空时 lo 是 null，"n < lo" 根本拦不住 0
    （0 小于任何真实时间戳，只有 lo 存在时才成立）。
    真正把未结束记录排除掉的是 time 分支里那句 `if (n <= 0) return false` ——
    写成两端都给的区间，那句就算删掉这条也照样绿。
  */
  const q = queryWith('ended', { min: '', max: '2100-01-01' });
  const got = liveNames(applyTable(rows, q, T0));
  assert.deepEqual(got, ['跑完的'], '没结束的记录没有结束时间，不该出现在结束时间的区间结果里');
  // 不筛选时两行都还在 —— 证明上面是被筛掉的，不是行本身丢了
  assert.equal(applyTable(rows, emptyQuery(), T0).length, 2);
});

test('每一列都能排序 —— 排完行数不变（排序不能吞行）', () => {
  const rows = rowsOf([
    rec({ id: 'a', name: '甲', status: 'success', startedAt: T0, endedAt: T0 + MIN }),
    rec({ id: 'b', name: '乙', status: 'failed', startedAt: T0 + MIN, endedAt: T0 + 2 * MIN }),
  ]);
  for (const c of TABLE_COLUMNS) {
    const q: TableQuery = { ...emptyQuery(), sortKey: c.id, sortDir: 'asc' };
    assert.equal(applyTable(rows, q, T0).length, rows.length, `列 ${c.id} 排序后行数变了`);
  }
});

/* ---------- 归属：live 与 archived ---------- */

test('归属：能只筛运行中的，也能只筛已归档的', () => {
  const rows = rowsOf([rec({ id: 'a', name: '甲' })], [rec({ id: 'b', name: '乙' })]);
  assert.deepEqual(liveNames(applyTable(rows, queryWith('origin', { values: ['live'] }), T0)), ['甲']);
  assert.deepEqual(
    liveNames(applyTable(rows, queryWith('origin', { values: ['archived'] }), T0)),
    [],
    '筛已归档时不该还剩 live 的行',
  );
});

test('归属：排序按 rank（不是按 live/archived 的字典序）', () => {
  const rows = rowsOf([rec({ id: 'a', name: '甲' })], [rec({ id: 'b', name: '乙' })]);
  const asc = applyTable(rows, { ...emptyQuery(), sortKey: 'origin', sortDir: 'asc' }, T0);
  const desc = applyTable(rows, { ...emptyQuery(), sortKey: 'origin', sortDir: 'desc' }, T0);
  assert.deepEqual(namesOf(asc), ['甲', '乙']);
  assert.deepEqual(namesOf(desc), ['乙', '甲']);
});

/* ---------- 状态：rank 而不是字典序 ---------- */

test('状态：出事的排前面（运行中 > 失败 > 已取消 > 成功）', () => {
  const rows = rowsOf([
    rec({ id: 'a', name: '成功', status: 'success' }),
    rec({ id: 'b', name: '运行中', status: 'running' }),
    rec({ id: 'c', name: '失败', status: 'failed' }),
    rec({ id: 'd', name: '已取消', status: 'cancelled' }),
  ]);
  const asc = applyTable(rows, { ...emptyQuery(), sortKey: 'status', sortDir: 'asc' }, T0);
  assert.deepEqual(namesOf(asc), ['运行中', '失败', '已取消', '成功']);
});

/* ---------- 数字列：区间 ---------- */

/*
 * 区间值按 cellValue 的实际返回值现取，不硬编码单位 ——
 * 这列标着 unit:'秒'，而筛选比的是**原始值**；写死一个单位的话，
 * 哪天换算改了这里就变成"筛不出来"，而报错只说"没匹配"，看不出是单位。
 */
test('耗时：按区间筛，没结束的不该被区间误伤', () => {
  const now = T0 + 30 * MIN;
  const rows = rowsOf([
    rec({ id: 'a', name: '跑完的', startedAt: T0, endedAt: T0 + 10 * MIN, status: 'success' }),
    rec({ id: 'b', name: '还在跑', startedAt: T0, status: 'running' }),
  ]);
  const done = Number(cellValue(rows[0], 'elapsed', now));
  const q = queryWith('elapsed', { min: String(done - 1), max: String(done + 1) });
  assert.deepEqual(namesOf(applyTable(rows, q, now)), ['跑完的']);
});

/* ---------- 文本列 ---------- */

test('流程：关键词包含，不区分大小写', () => {
  const rows = rowsOf([rec({ id: 'a', name: '登录流程' }), rec({ id: 'b', name: '导出' })]);
  assert.deepEqual(namesOf(applyTable(rows, queryWith('name', { text: '登录' }), T0)), ['登录流程']);
});

/* ---------- 排序三态 ---------- */

test('nextSort：无序 → 降序 → 升序 → 无序（第三下回到无序）', () => {
  const neutral = { sortKey: '' as TableColumnId | '', sortDir: 'desc' as const };
  const p = nextSort(neutral, 'elapsed');
  assert.equal(p.sortKey, 'elapsed');
  assert.equal(p.sortDir, 'desc', '第一次点给降序');
  const a = nextSort(p, 'elapsed');
  assert.equal(a.sortDir, 'asc', '第二次点给升序');
  assert.equal(nextSort(a, 'elapsed').sortKey, '', '第三次点回到无序');
});

/* ---------- 判空 ---------- */

test('filterActive：各类型判空只认自己那几个字段', () => {
  assert.equal(filterActive(columnOf('status'), emptyFilter()), false);
  assert.equal(filterActive(columnOf('status'), { ...emptyFilter(), values: ['failed'] }), true);
  assert.equal(filterActive(columnOf('name'), { ...emptyFilter(), text: '登录' }), true);
  assert.equal(filterActive(columnOf('elapsed'), { ...emptyFilter(), min: '1' }), true);
});

test('activeFilterColumns：只数真正生效的列', () => {
  const q = emptyQuery();
  q.filters.status = { ...emptyFilter(), values: ['failed'] };
  q.filters.name = emptyFilter();          // 建了但全空，不算生效
  assert.deepEqual(activeFilterColumns(q), ['status']);
});

test('组合筛选：多列是"且"（收窄而不是变宽）', () => {
  const rows = rowsOf([
    rec({ id: 'a', name: '甲', status: 'failed', source: 'manual' }),
    rec({ id: 'b', name: '乙', status: 'failed', source: 'cron' }),
    rec({ id: 'c', name: '丙', status: 'success', source: 'manual' }),
  ]);
  const q = emptyQuery();
  q.filters.status = { ...emptyFilter(), values: ['failed'] };
  q.filters.source = { ...emptyFilter(), values: ['manual'] };
  assert.deepEqual(namesOf(applyTable(rows, q, T0)), ['甲']);
});
