import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyMeta, isCancelStatus, statusName, statusColor, updateStatus, type BoardMeta,
} from '../engine/boardMeta';
import { readSrc } from './srcScan';

/**
 * 终态里「不做了」的那一种（取消 / 放弃 / 作废）。
 *
 * `final` 只表示"不再流出"，**不区分做完了还是放弃了** —— 而这两者
 * 在复盘时天差地别：一个是产出、一个是沉没成本。
 *
 * 以前 isCancelStatus 只认默认流里那个字面量 'cancelled'，于是自定义流程下
 * 全组都在「放弃」时，组头显示的是**「已完成」** —— 把放弃记成了产出。
 */

function customMeta(): BoardMeta {
  return {
    ...emptyMeta('p1', '项目甲'),
    statuses: [
      { id: 's1', name: '待办', color: '#8b93a7', final: false, next: ['s2'] },
      { id: 's2', name: '进行中', color: '#3b82f6', final: false, next: ['s3', 's4'] },
      { id: 's3', name: '完工', color: '#22c55e', final: true, next: [] },
      { id: 's4', name: '放弃', color: '#ef4444', final: true, next: [], cancel: true },
    ],
  };
}

/** 同一个流程，但「放弃」没有勾 cancel */
function noCancelMeta(): BoardMeta {
  const m = customMeta();
  m.statuses[3] = { ...m.statuses[3], cancel: undefined };
  return m;
}

/* ---------- 判据 ---------- */

test('默认流不回归：cancelled 算取消、done 不算', () => {
  const m = emptyMeta('p', 'P');
  assert.equal(isCancelStatus(m, 'cancelled'), true);
  assert.equal(isCancelStatus(m, 'done'), false, 'done 是产出，不能算放弃');
  assert.equal(isCancelStatus(m, 'doing'), false);
});

test('不给 meta 时退回默认那个 cancelled（老存档行为不变）', () => {
  assert.equal(isCancelStatus(null, 'cancelled'), true);
  assert.equal(isCancelStatus(undefined, 's4'), false);
});

test('自定义流：勾了 cancel 的终态才算，没勾的不算', () => {
  const m = customMeta();
  assert.equal(isCancelStatus(m, 's4'), true, '勾了 cancel 的「放弃」要认');
  assert.equal(isCancelStatus(m, 's3'), false, '没勾的「完工」不能算放弃');
});

test('过度修复防护：没勾 cancel 就是没勾 —— 不按名字猜', () => {
  const m = noCancelMeta();
  assert.equal(isCancelStatus(m, 's4'), false, '名字叫「放弃」但没勾，就按完成算');
});

test('非终态勾了也不算（勾掉终态时一并清掉，避免将来复活）', () => {
  const m = customMeta();
  const m2 = updateStatus(m, 's2', { cancel: true });
  assert.equal(isCancelStatus(m2, 's2'), false, '进行中不是终态，谈不上"不做了"');
  // 勾回终态时不该带着一个用户看不见的旧标记复活
  const m3 = updateStatus(updateStatus(m, 's3', { cancel: true }), 's3', { final: false });
  const m4 = updateStatus(m3, 's3', { final: true });
  assert.equal(isCancelStatus(m4, 's3'), false, '终态被勾掉又勾回来，cancel 不该复活');
});

/*
  ⛔ 组头聚合那 3 条随任务板一起删掉了。

  它们要的是 statusOf(board, groupId, meta) —— 那个函数在 engine/taskBoard.ts，
  而 taskBoard 在 #399 被整块移除。留着会让整个文件 Cannot find module 崩掉，
  连累下面这些纯 boardMeta 的用例一起红。

  取消语义本身（isCancelStatus / statusName / statusColor）不依赖任务板，保留。
*/

/* ---------- 显示名 ---------- */

test('自定义流程下，默认 id 也要有中文名（否则组头显示成裸 id）', () => {
  const m = customMeta();
  assert.equal(statusName(m, 'done'), '已完成');
  assert.equal(statusName(m, 'cancelled'), '已取消');
  assert.equal(statusName(m, 's3'), '完工', '自定义 id 显示自己的名字');
  assert.equal(statusName(m, 's4'), '放弃');
  assert.equal(statusName(m, 's2'), '进行中');
});

/* ---------- 源码守卫 ---------- */

test('isCancelStatus 必须读 meta 上的 cancel 标记（不能退回字面量）', () => {
  const src = readSrc('engine/boardMeta.ts');
  const at = src.indexOf('export function isCancelStatus');
  assert.ok(at >= 0, '要能找到 isCancelStatus');
  const body = src.slice(at, src.indexOf('export function', at + 10));
  assert.ok(/statusOf/.test(body), '必须查 meta 里的状态定义');
  assert.ok(/\.cancel/.test(body), '判据是那个显式的 cancel 标记，不是名字');
});

/*
  ⛔ 这两条原本 readSrc 的是 components/TaskBoard.tsx 与 TaskBoardDetail.tsx ——
  那两个组件在 #399 随 engine/taskBoard.ts 一起移除了，但**漏删**了这两个文件本身，
  于是它们 import 一个不存在的模块，整个插件编译不过（TS2307）。

  守卫对象消失有两种改法：删掉用例，或改守**仍在的定义处**。
  删掉用例就是那种最危险的失明 —— 将来谁重建任务板、又写死查表，没人拦。
  所以改成守 boardMeta.ts：它还在，且是 statusName / statusColor 的定义处，
  守的还是同一件事 —— 自定义 id 必须认得，不能查写死的表。
*/
test('状态名不得查写死的表（自定义流程下会显示空白）', () => {
  const src = readSrc('engine/boardMeta.ts');
  assert.ok(!/BOARD_STATUS_LABEL\s*\[/.test(src), 'BOARD_STATUS_LABEL 查表认不了自定义 id');
  const at = src.indexOf('export function statusName');
  assert.ok(at >= 0, '要能找到 statusName');
  const body = src.slice(at, src.indexOf('export function', at + 10));
  assert.ok(/statusOf\(/.test(body), 'statusName 要走 statusOf 拿 meta 里的名字');
});

/* ---------- 颜色 ---------- */

/** 自定义流程：待办 s1 → 进行中 s2 → 完工 s3 / 放弃 s4（两个终态） */

test('状态色取状态自己的 hex（自定义 id 也要有颜色）', () => {
  const m = customMeta();
  assert.equal(statusColor(m, 's2'), '#3b82f6');
  assert.equal(statusColor(m, 's4'), '#ef4444');
});

test('默认流里「已挂起」也有颜色（CSS 类名 st-held 从来就没有过规则）', () => {
  const m = emptyMeta('p', 'P');
  assert.equal(statusColor(m, 'held'), '#f59e0b', '用户点名要的状态不能和「待办」一样灰');
  assert.notEqual(statusColor(m, 'held'), statusColor(m, 'todo'));
});

test('查不到返回空串 —— 交给 CSS 兜底，不臆造颜色', () => {
  assert.equal(statusColor(customMeta(), '不存在'), '');
  assert.equal(statusColor(null, 's2'), '', '不给 meta 时自定义 id 查不到');
  assert.equal(statusColor(null, 'done'), '#22c55e', '不给 meta 时默认 id 仍认得');
});

test('源码守卫：状态色不能走在恒假分支后面（自定义 id 会全返回空串）', () => {
  const src = readSrc('engine/boardMeta.ts');
  assert.ok(!/if\s*\(\s*false/.test(src), '恒假条件 = 那一行永远不会执行');
  const at = src.indexOf('export function statusColor');
  assert.ok(at >= 0, '要能找到 statusColor');
  const body = src.slice(at, src.indexOf('export function', at + 10));
  assert.ok(/if\s*\(\s*s\s*\)/.test(body), '自定义状态要先取它自己的 hex');
});
