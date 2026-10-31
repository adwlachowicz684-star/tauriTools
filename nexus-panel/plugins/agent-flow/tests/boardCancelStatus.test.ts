import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyBoard, addNode, statusOf, type TaskBoard, type BoardNode } from '../engine/taskBoard';
import {
  emptyMeta, isCancelStatus, statusName, updateStatus, type BoardMeta,
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

const task = (title: string, patch: Record<string, unknown> = {}): BoardNode => ({
  kind: 'task', title, status: 's1', deps: [], assignee: '', note: '',
  desc: '', tags: [], createdAt: 0, updatedAt: 0, due: 0, priority: 0,
  session: '', prevSession: '', tookAt: 0,
  ...patch,
} as BoardNode);

/** 自定义流程：待办 s1 → 进行中 s2 → 完工 s3 / 放弃 s4（两个终态） */
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

function board(): { b: TaskBoard; g1: string; t1: string; t2: string } {
  const r1 = addNode(emptyBoard('p1', '项目甲'), null, { kind: 'group', title: '登录', children: [] });
  const r2 = addNode(r1.board, r1.id, task('设计表'));
  const r3 = addNode(r2.board, r1.id, task('写接口'));
  return { b: r3.board, g1: r1.id, t1: r2.id, t2: r3.id };
}

const withStatus = (b: TaskBoard, id: string, st: string): TaskBoard => ({
  ...b, nodes: { ...b.nodes, [id]: { ...b.nodes[id], status: st } as BoardNode },
});

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

/* ---------- 组头聚合 ---------- */

test('全组都在自定义取消态 → 组头是 cancelled，不是 done', () => {
  const { b, g1, t1, t2 } = board();
  const x = withStatus(withStatus(b, t1, 's4'), t2, 's4');
  assert.equal(statusOf(x, g1, customMeta()), 'cancelled', '放弃不能记成产出');
});

test('全组都在自定义完成态 → 组头是 done', () => {
  const { b, g1, t1, t2 } = board();
  const x = withStatus(withStatus(b, t1, 's3'), t2, 's3');
  assert.equal(statusOf(x, g1, customMeta()), 'done');
});

test('没勾 cancel 时全组在 s4 → 仍算完成（猜错比不猜更糟）', () => {
  const { b, g1, t1, t2 } = board();
  const x = withStatus(withStatus(b, t1, 's4'), t2, 's4');
  assert.equal(statusOf(x, g1, noCancelMeta()), 'done');
});

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

test('组件显示状态名必须走 statusName（写死 LABEL 表在自定义流程下是空白）', () => {
  const src = readSrc('components/TaskBoard.tsx', 'components/TaskBoardDetail.tsx');
  assert.ok(!/BOARD_STATUS_LABEL\s*\[/.test(src), 'BOARD_STATUS_LABEL 查表认不了自定义 id');
  assert.ok(/statusName\(/.test(src), '改用 statusName：它认 meta 里的名字');
});
