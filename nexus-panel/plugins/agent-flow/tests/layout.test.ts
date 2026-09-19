import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEFT_TABS, LEFT_TAB_LABEL,
  normalizeLeftTab, normalizeLogHeight,
  LOG_H_MIN, LOG_H_MAX, LOG_H_DEFAULT,
  leftPaneVisible, leftPaneEditable, coerceForView,

  RIGHT_TABS, RIGHT_TAB_LABEL, normalizeRightTab,} from '../engine/layout';

/* ================= 标签清单 ================= */

test('左边两个标签', () => {
  assert.equal(LEFT_TABS.length, 2);
  assert.deepEqual(LEFT_TABS, ['library', 'canvas']);
});

test('每个标签都有中文名', () => {
  for (const t of LEFT_TABS) assert.ok(LEFT_TAB_LABEL[t], `${t} 缺名字`);
});

/* ================= 归一 ================= */

test('合法值原样通过', () => {
  assert.equal(normalizeLeftTab('canvas'), 'canvas');
  assert.equal(normalizeLeftTab('library'), 'library');
});

/** 存档里的脏值不能渲染出一个点不动的面板 */
test('未知值退回默认', () => {
  assert.equal(normalizeLeftTab('xxx'), 'library');
  assert.equal(normalizeLeftTab(null), 'library');
  assert.equal(normalizeLeftTab(undefined), 'library');
  assert.equal(normalizeLeftTab(123), 'library');
  assert.equal(normalizeLeftTab({}), 'library');
});

test('空串退回默认', () => {
  assert.equal(normalizeLeftTab(''), 'library');
});

/* ================= 右栏日志高度 ================= */

/** 直接拿脏值当 style.height 会渲染出 NaNpx —— 面板凭空消失 */
test('脏值退回默认高度', () => {
  assert.equal(normalizeLogHeight(null), LOG_H_DEFAULT);
  assert.equal(normalizeLogHeight(undefined), LOG_H_DEFAULT);
  assert.equal(normalizeLogHeight('abc'), LOG_H_DEFAULT);
  assert.equal(normalizeLogHeight(NaN), LOG_H_DEFAULT);
  assert.equal(normalizeLogHeight({}), LOG_H_DEFAULT);
  assert.equal(normalizeLogHeight(Infinity), LOG_H_DEFAULT);
});

test('超出范围的被夹住', () => {
  assert.equal(normalizeLogHeight(1), LOG_H_MIN);
  assert.equal(normalizeLogHeight(99999), LOG_H_MAX);
});

test('范围内的原样通过', () => {
  assert.equal(normalizeLogHeight(300), 300);
});

/** 小数会产生亚像素高度，拖动时看着抖 */
test('小数取整', () => {
  assert.equal(normalizeLogHeight(200.7), 201);
});

test('数字字符串也能用', () => {
  assert.equal(normalizeLogHeight('250'), 250);
});

/** 默认值本身必须在范围内 —— 否则一上来就是被夹过的 */
test('默认值在合法范围内', () => {
  assert.ok(LOG_H_DEFAULT >= LOG_H_MIN && LOG_H_DEFAULT <= LOG_H_MAX);
});

/* ================= 可见性 ================= */

test('流程视图下左边栏可见', () => {
  assert.equal(leftPaneVisible('flow'), true);
});

/** 任务/历史是查看态，画布藏起来了，节点拖不出去 —— 留着是死栏 */
test('任务视图下左边栏隐藏', () => {
  assert.equal(leftPaneVisible('tasks'), false);
});

test('历史视图下左边栏隐藏', () => {
  assert.equal(leftPaneVisible('history'), false);
});

test('未知视图按不可见处理', () => {
  assert.equal(leftPaneVisible('zzz' as never), false);
  assert.equal(leftPaneVisible(null as never), false);
});

test('只有流程视图能编辑', () => {
  assert.equal(leftPaneEditable('flow'), true);
  assert.equal(leftPaneEditable('tasks'), false);
  assert.equal(leftPaneEditable('history'), false);
});

/** 编辑性必须与画布可见性一致，否则"左边能改、中间看不见" */
test('可编辑一定可见', () => {
  for (const v of ['flow', 'tasks', 'history'] as const) {
    if (leftPaneEditable(v)) assert.equal(leftPaneVisible(v), true, `${v} 可编辑却不可见`);
  }
});

/* ================= 切视图时纠正 ================= */

test('流程视图保持当前标签', () => {
  const r = coerceForView('flow', 'canvas');
  assert.equal(r.left, 'canvas');
  assert.equal(r.visible, true);
});

test('非流程视图标记不可见', () => {
  const r = coerceForView('history', 'library');
  assert.equal(r.visible, false);
});

/**
 * null 不能走"夹取"那条路 ——
 * Number(null) 是 0，会被夹成最小值，日志区缩成一条缝。
 * 那是"看起来像设过、其实是脏值"，比直接给默认值更难发现。
 */
test('null 给默认高度而不是最小值', () => {
  assert.equal(normalizeLogHeight(null), LOG_H_DEFAULT);
  assert.notEqual(normalizeLogHeight(null), LOG_H_MIN);
});

/* ================= 右栏标签 ================= */

test('右栏有两个标签：设置 / 日志', () => {
  assert.deepEqual(RIGHT_TABS, ['inspector', 'log']);
  assert.equal(RIGHT_TAB_LABEL.inspector, '设置');
  assert.equal(RIGHT_TAB_LABEL.log, '日志');
});

/** 未知值退回默认 —— 老存档 / 手改的值不能渲染出点不动的空面板 */
test('未知右栏标签退回设置', () => {
  assert.equal(normalizeRightTab('log'), 'log');
  assert.equal(normalizeRightTab('inspector'), 'inspector');
  assert.equal(normalizeRightTab('nonsense'), 'inspector');
  assert.equal(normalizeRightTab(undefined), 'inspector');
  assert.equal(normalizeRightTab(null), 'inspector');
  assert.equal(normalizeRightTab({}), 'inspector');
  assert.equal(normalizeRightTab(123), 'inspector');
});
