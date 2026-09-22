import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEFT_TABS, LEFT_TAB_LABEL,
  TASK_TABS, TASK_TAB_LABEL,
  normalizeLeftTab, normalizeTaskTab, normalizeLogHeight,
  LOG_H_MIN, LOG_H_MAX, LOG_H_DEFAULT,
  leftPaneEditable, leftTabsFor,

} from '../engine/layout';

/* ================= 标签清单 ================= */

test('左栏三个标签：节点库 / 模块库 / 画布库', () => {
  assert.equal(LEFT_TABS.length, 3);
  assert.deepEqual(LEFT_TABS, ['node', 'module', 'canvas']);
});

/** 节点库与模块库并列，不再把模块库嵌在节点库里用二级 tab 切 */
test('节点库与模块库是两个独立标签', () => {
  assert.ok(LEFT_TABS.includes('node'));
  assert.ok(LEFT_TABS.includes('module'));
  assert.notEqual(normalizeLeftTab('node'), normalizeLeftTab('module'));
});

test('每个标签都有中文名', () => {
  for (const t of LEFT_TABS) assert.ok(LEFT_TAB_LABEL[t], `${t} 缺名字`);
  assert.equal(LEFT_TAB_LABEL.node, '节点库');
  assert.equal(LEFT_TAB_LABEL.module, '模块库');
  assert.equal(LEFT_TAB_LABEL.canvas, '画布');
});

/* ================= 归一 ================= */

test('合法值原样通过', () => {
  assert.equal(normalizeLeftTab('node'), 'node');
  assert.equal(normalizeLeftTab('module'), 'module');
  assert.equal(normalizeLeftTab('canvas'), 'canvas');
});

/** 存档里的脏值不能渲染出一个点不动的面板 */
test('未知值退回默认', () => {
  assert.equal(normalizeLeftTab('xxx'), 'node');
  assert.equal(normalizeLeftTab(null), 'node');
  assert.equal(normalizeLeftTab(undefined), 'node');
  assert.equal(normalizeLeftTab(123), 'node');
  assert.equal(normalizeLeftTab({}), 'node');
  assert.equal(normalizeLeftTab([]), 'node');
});

/** 老存档里存的是 'library'（两标签时期），必须能落到一个存在的标签上 */
test('老存档的 library 退回 node', () => {
  assert.equal(normalizeLeftTab('library'), 'node');
});

test('空串退回默认', () => {
  assert.equal(normalizeLeftTab(''), 'node');
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

/* ================= 任务视图的子标签 ================= */

test('任务视图两个子标签：进行中 / 已完成', () => {
  assert.deepEqual(TASK_TABS, ['running', 'done']);
  assert.equal(TASK_TAB_LABEL.running, '进行中');
  assert.equal(TASK_TAB_LABEL.done, '已完成');
});

/** 历史不再是一个顶层入口，它只是"已完成"这个子标签 */
test('顶层视图只剩流程与任务两个', () => {
  assert.equal(typeof leftPaneEditable('flow'), 'boolean');
  assert.equal(leftPaneEditable('tasks'), false);
});

test('任务标签脏值退回进行中', () => {
  assert.equal(normalizeTaskTab('done'), 'done');
  assert.equal(normalizeTaskTab('running'), 'running');
  assert.equal(normalizeTaskTab('xxx'), 'running');
  assert.equal(normalizeTaskTab(null), 'running');
  assert.equal(normalizeTaskTab(undefined), 'running');
  assert.equal(normalizeTaskTab(123), 'running');
});

/** 老存档里存的是主视图名，不再是合法子标签 —— 必须落在存在的标签上 */
test('老存档的 history 落在已完成', () => {
  assert.equal(normalizeTaskTab('history'), 'done');
});

/* ================= 左栏始终有标签 ================= */

/**
 * 两个视图**都显示左栏**，只是标签组不同。
 *
 * 以前任务 / 历史下整条隐去 —— 同一条栏时有时无，
 * 切过去整个界面宽度变一次。
 */
test('两个视图下左栏都有标签', () => {
  assert.equal(leftTabsFor('flow').length, 3);
  assert.equal(leftTabsFor('tasks').length, 2);
});

test('流程视图用三个库，任务视图用两个状态', () => {
  assert.deepEqual(leftTabsFor('flow'), ['node', 'module', 'canvas']);
  assert.deepEqual(leftTabsFor('tasks'), ['running', 'done']);
});

test('未知视图按流程处理', () => {
  assert.deepEqual(leftTabsFor('zzz' as never), ['node', 'module', 'canvas']);
  assert.deepEqual(leftTabsFor(null as never), ['node', 'module', 'canvas']);
});

/* ================= 可编辑性 ================= */

test('只有流程视图能编辑', () => {
  assert.equal(leftPaneEditable('flow'), true);
  assert.equal(leftPaneEditable('tasks'), false);
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
