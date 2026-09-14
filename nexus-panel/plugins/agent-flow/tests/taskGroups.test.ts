import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByCanvas, flattenRows, rowOffsets, windowSlice, defaultExpanded,
  rowHeightOf, GROUP_ROW_HEIGHT, TASK_ROW_HEIGHT,
  makeTask, applyEvent, finishTask, type TaskRecord,
} from '../engine/tasks';

const T0 = 1700000000000;
const mk = (canvasId: string, name: string, i: number, status?: 'running' | 'success' | 'failed') => {
  let t = makeTask({ canvasId, canvasName: name, now: T0 + i });
  if (status === 'success') t = finishTask(t, true, T0 + i + 100);
  else if (status === 'failed') t = finishTask(t, false, T0 + i + 100);
  return t;
};

/* ---------- 分组 ---------- */

test('分组: 空列表', () => {
  assert.deepEqual(groupByCanvas([]), []);
});

test('分组: 同一流程的任务聚在一起', () => {
  const g = groupByCanvas([mk('c1', 'A', 1), mk('c1', 'A', 2), mk('c2', 'B', 3)]);
  assert.equal(g.length, 2);
  assert.equal(g.find((x) => x.canvasId === 'c1')?.total, 2);
  assert.equal(g.find((x) => x.canvasId === 'c2')?.total, 1);
});

test('分组: 组内按开始时间倒序（最新在上）', () => {
  const g = groupByCanvas([mk('c1', 'A', 1), mk('c1', 'A', 5), mk('c1', 'A', 3)]);
  assert.equal(g[0].tasks[0].startedAt, T0 + 5);
  assert.equal(g[0].tasks[2].startedAt, T0 + 1);
});

test('分组: 统计运行中数量', () => {
  const g = groupByCanvas([mk('c1', 'A', 1, 'success'), mk('c1', 'A', 2), mk('c1', 'A', 3)]);
  assert.equal(g[0].runningCount, 2);
});

test('分组: 统计失败数量', () => {
  const g = groupByCanvas([mk('c1', 'A', 1, 'failed'), mk('c1', 'A', 2, 'success')]);
  assert.equal(g[0].failedCount, 1);
});

test('分组: 有任务在跑的组排最前', () => {
  const g = groupByCanvas([
    mk('cIdle', '闲', 1, 'success'),
    mk('cBusy', '忙', 2),
  ]);
  assert.equal(g[0].canvasId, 'cBusy');
});

test('分组: 都空闲时按最新开始时间排', () => {
  const g = groupByCanvas([mk('cOld', '旧', 1, 'success'), mk('cNew', '新', 9, 'success')]);
  assert.equal(g[0].canvasId, 'cNew');
});

test('分组: canvasId 为空时归入 unknown 而不是散成多组', () => {
  const g = groupByCanvas([mk('', 'x', 1), mk('', 'y', 2)]);
  assert.equal(g.length, 1);
});

test('分组: 流程改过名时用最新一条的名字', () => {
  const g = groupByCanvas([mk('c1', '旧名', 1), mk('c1', '新名', 9)]);
  assert.equal(g[0].canvasName, '新名');
});

test('分组: 名字为空时回退到未命名', () => {
  const g = groupByCanvas([mk('c1', '', 1)]);
  assert.equal(g[0].canvasName, '未命名流程');
});

/* ---------- 拉平 ---------- */

test('拉平: 折叠的组只贡献一个头', () => {
  const g = groupByCanvas([mk('c1', 'A', 1), mk('c1', 'A', 2), mk('c2', 'B', 3)]);
  const rows = flattenRows(g, new Set());
  assert.equal(rows.length, 2, '两个组各一个头');
  assert.ok(rows.every((r) => r.kind === 'group'));
});

test('拉平: 展开的组贡献头 + 全部任务行', () => {
  const g = groupByCanvas([mk('c1', 'A', 1), mk('c1', 'A', 2)]);
  const rows = flattenRows(g, new Set(['c1']));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'group');
  assert.equal(rows[1].kind, 'task');
});

test('拉平: index 连续且与位置一致（虚拟滚动靠它定位）', () => {
  const g = groupByCanvas([mk('c1', 'A', 1), mk('c1', 'A', 2), mk('c2', 'B', 3)]);
  const rows = flattenRows(g, new Set(['c1', 'c2']));
  rows.forEach((r, i) => assert.equal(r.index, i, `第 ${i} 行`));
  assert.equal(rows.length, 5, '2 头 + 2 任务 + 1 头 + 1 任务');
});

test('拉平: 部分展开', () => {
  const g = groupByCanvas([mk('c1', 'A', 1), mk('c1', 'A', 2), mk('c2', 'B', 3)]);
  const rows = flattenRows(g, new Set(['c1']));
  assert.equal(rows.length, 4, 'c1 展开(1+2) + c2 折叠(1)');
});

/* ---------- 行高与偏移 ---------- */

test('行高: 分组头与任务行不同', () => {
  assert.equal(rowHeightOf({ kind: 'group', key: 'g', group: {} as never, index: 0 }), GROUP_ROW_HEIGHT);
  assert.equal(rowHeightOf({ kind: 'task', key: 't', task: {} as never, index: 0 }), TASK_ROW_HEIGHT);
});

test('偏移: 首行为 0', () => {
  const g = groupByCanvas([mk('c1', 'A', 1)]);
  const rows = flattenRows(g, new Set(['c1']));
  assert.equal(rowOffsets(rows)[0], 0);
});

test('偏移: 累加正确', () => {
  const g = groupByCanvas([mk('c1', 'A', 1), mk('c1', 'A', 2)]);
  const rows = flattenRows(g, new Set(['c1']));
  const o = rowOffsets(rows);
  assert.deepEqual(o, [0, GROUP_ROW_HEIGHT, GROUP_ROW_HEIGHT + TASK_ROW_HEIGHT]);
});

test('偏移: 空数组', () => {
  assert.deepEqual(rowOffsets([]), []);
});

/* ---------- 虚拟滚动 ---------- */

const bigRows = (n: number) => {
  const tasks: TaskRecord[] = [];
  for (let i = 0; i < n; i += 1) tasks.push(mk('c1', 'A', i));
  const rows = flattenRows(groupByCanvas(tasks), new Set(['c1']));
  return { rows, offsets: rowOffsets(rows) };
};

test('虚拟滚动: 空数据不炸', () => {
  const w = windowSlice([], [], 0, 400);
  assert.equal(w.totalHeight, 0);
  assert.equal(w.start, 0);
  assert.equal(w.end, 0);
});

test('虚拟滚动: 只渲染视口内的行（1500 条时不全画）', () => {
  const { rows, offsets } = bigRows(1500);
  const w = windowSlice(rows, offsets, 0, 800);
  const visible = w.end - w.start;
  assert.ok(visible < 30, `只应渲染视口内的行，实际 ${visible}`);
  assert.ok(rows.length > 1500, `总行数应远超视口，实际 ${rows.length}`);
});

test('虚拟滚动: 滚动到中部时起始行正确', () => {
  const { rows, offsets } = bigRows(500);
  const w = windowSlice(rows, offsets, 10000, 800);
  // 10000px 大约落在第 130 行（40 + 128*76 ≈ 9768）
  assert.ok(w.start > 100 && w.start < 145, `起始行应在 100~145，实际 ${w.start}`);
});

test('虚拟滚动: 起始行不超过总行数', () => {
  const { rows, offsets } = bigRows(100);
  const w = windowSlice(rows, offsets, 999999, 800);
  assert.ok(w.start < rows.length);
  assert.ok(w.end <= rows.length);
});

test('虚拟滚动: padTop 等于起始行的偏移', () => {
  const { rows, offsets } = bigRows(300);
  const w = windowSlice(rows, offsets, 5000, 600);
  assert.equal(w.padTop, offsets[w.start]);
});

test('虚拟滚动: 总高度等于所有行高之和', () => {
  const { rows, offsets } = bigRows(200);
  const w = windowSlice(rows, offsets, 0, 600);
  const expect = offsets[rows.length - 1] + rowHeightOf(rows[rows.length - 1]);
  assert.equal(w.totalHeight, expect);
});

test('虚拟滚动: 视口很大时也不会越界', () => {
  const { rows, offsets } = bigRows(10);
  const w = windowSlice(rows, offsets, 0, 100000);
  assert.equal(w.start, 0);
  assert.equal(w.end, rows.length);
});

test('虚拟滚动: overscan 会多渲染几行（快速滚动不露白）', () => {
  const { rows, offsets } = bigRows(500);
  const a = windowSlice(rows, offsets, 5000, 600, 0);
  const b = windowSlice(rows, offsets, 5000, 600, 5);
  assert.ok((b.end - b.start) > (a.end - a.start), 'overscan 大应渲染更多行');
});

test('虚拟滚动: padTop + padBottom + 可见高度 = 总高度', () => {
  const { rows, offsets } = bigRows(400);
  const w = windowSlice(rows, offsets, 8000, 700);
  const visibleH = offsets[w.end - 1] + rowHeightOf(rows[w.end - 1]) - offsets[w.start];
  assert.equal(w.padTop + visibleH + w.padBottom, w.totalHeight);
});

/* ---------- 默认展开 ---------- */

test('默认展开: 有任务在跑的组自动展开', () => {
  const g = groupByCanvas([mk('c1', 'A', 1), mk('c2', 'B', 2, 'success')]);
  const e = defaultExpanded(g);
  assert.equal(e.has('c1'), true);
  assert.equal(e.has('c2'), false);
});

test('默认展开: 全空闲且多组时全部折叠', () => {
  const g = groupByCanvas([mk('c1', 'A', 1, 'success'), mk('c2', 'B', 2, 'success')]);
  const e = defaultExpanded(g);
  assert.equal(e.size, 0);
});

test('默认展开: 只有一个组时自动展开（没必要折叠）', () => {
  const g = groupByCanvas([mk('c1', 'A', 1, 'success')]);
  assert.equal(defaultExpanded(g).has('c1'), true);
});

test('默认展开: 空列表', () => {
  assert.equal(defaultExpanded([]).size, 0);
});
