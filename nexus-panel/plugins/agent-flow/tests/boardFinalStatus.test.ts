import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBoard, addNode, lockOf, statusOf, tallyOf,
  type TaskBoard, type BoardNode,
} from '../engine/taskBoard';
import { emptyMeta, type BoardMeta } from '../engine/boardMeta';
import { readSrc } from './srcScan';

/**
 * 状态集是用户在 boardMeta 里配的（见 engine/boardMeta.ts 开头），
 * 完成态可以叫 's3'、'完工'…… 而不是只有 'done'。
 *
 * 这一组测试盯的是：**终态不能写死**。
 * 写死 'done' 的后果不是显示错，是**前置永远解锁不了**（锁打不开），
 * 界面只说"被前置卡住"，而那个前置明明已经做完了。
 */

const task = (title: string, patch: Record<string, unknown> = {}): BoardNode => ({
  kind: 'task', title, status: 'todo', deps: [], assignee: '', note: '',
  desc: '', tags: [], createdAt: 0, updatedAt: 0, due: 0, priority: 0,
  session: '', prevSession: '', tookAt: 0,
  ...patch,
} as BoardNode);

/** 自定义流程：待办 s1 → 进行中 s2 → 完工 s3（终态） */
function customMeta(): BoardMeta {
  return {
    ...emptyMeta('p1', '项目甲'),
    statuses: [
      { id: 's1', name: '待办', color: '#8b93a7', final: false, next: ['s2'] },
      { id: 's2', name: '进行中', color: '#3b82f6', final: false, next: ['s3'] },
      { id: 's3', name: '完工', color: '#22c55e', final: true, next: [] },
    ],
  };
}

/** g1[t1, t2]，t2 依赖 t1 */
function board(): { b: TaskBoard; g1: string; t1: string; t2: string } {
  let b = emptyBoard('p1', '项目甲');
  const r1 = addNode(b, null, { kind: 'group', title: '登录', children: [] });
  const r2 = addNode(r1.board, r1.id, task('设计表'));
  const r3 = addNode(r2.board, r1.id, task('写接口'));
  b = r3.board;
  const t1 = r2.id, t2 = r3.id;
  b.nodes[t2] = { ...b.nodes[t2], deps: [t1] } as BoardNode;
  return { b, g1: r1.id, t1, t2 };
}

const withStatus = (b: TaskBoard, id: string, st: string): TaskBoard => ({
  ...b, nodes: { ...b.nodes, [id]: { ...b.nodes[id], status: st } as BoardNode },
});

/* ---------- 锁：自定义终态必须解锁 ---------- */

test('lockOf: 自定义流程的前置到了终态就解锁（写死 done 会永远解不开）', () => {
  const { b, t1, t2 } = board();
  const done = withStatus(b, t1, 's3');
  assert.equal(lockOf(done, t2).locked, true, '不给 meta 时退回默认那套，s3 不算完成');
  assert.equal(lockOf(done, t2, customMeta()).locked, false, '给了 meta：s3 是终态，该解锁');
});

test('lockOf: 自定义流程的非终态照样锁住（别一律解锁）', () => {
  const { b, t1, t2 } = board();
  const doing = withStatus(b, t1, 's2');
  assert.equal(lockOf(doing, t2, customMeta()).locked, true, 's2 不是终态 → 还锁着');
});

test('lockOf: 没配流程时行为不变（默认 done / cancelled 仍算完成）', () => {
  const { b, t1, t2 } = board();
  assert.equal(lockOf(withStatus(b, t1, 'done'), t2).locked, false);
  assert.equal(lockOf(withStatus(b, t1, 'cancelled'), t2).locked, false);
  assert.equal(lockOf(withStatus(b, t1, 'doing'), t2).locked, true);
});

/* ---------- 聚合：组头与计数 ---------- */

test('statusOf: 自定义终态下组头要显示完成，而不是永远待办', () => {
  const { b, g1, t1, t2 } = board();
  let x = withStatus(b, t1, 's3');
  x = withStatus(x, t2, 's3');
  assert.equal(statusOf(x, g1), 'todo', '不给 meta：s3 不被认成完成 → 组头停在待办');
  assert.equal(statusOf(x, g1, customMeta()), 'done', '给了 meta：全部终态 → 完成');
});

test('statusOf: 部分到终态 = 进行中', () => {
  const { b, g1, t1 } = board();
  const x = withStatus(b, t1, 's3');
  assert.equal(statusOf(x, g1, customMeta()), 'doing');
});

test('tallyOf: 自定义终态计入已完成数', () => {
  const { b, g1, t1, t2 } = board();
  let x = withStatus(b, t1, 's3');
  x = withStatus(x, t2, 's3');
  const t = tallyOf(x, g1, customMeta());
  assert.equal(t.done, 2, '两个都到终态');
  assert.equal(t.total, 2);
});

test('tallyOf: 没配流程时行为不变', () => {
  const { b, g1, t1 } = board();
  const x = withStatus(b, t1, 'done');
  assert.equal(tallyOf(x, g1).done, 1);
});

/* ---------- 判据只有一份 ---------- */

test('终态判据收在 boardMeta 一处（taskBoard 不许自己写死 done）', () => {
  // ⛔ 用 readSrc：它会剥掉注释。不剥的话这条守卫会把我自己那句
  //    "⛔ 不能写死 status !== 'done'" 当成真代码，恒红且理由错。
  const src = readSrc('engine/taskBoard.ts');
  assert.ok(src.length > 0, 'AF_SRC 未指向仓库时读不到源码 —— 这条守卫会假绿');
  for (const bad of ["=== 'done'", "!== 'done'", "'done' ===", "'done' !=="]) {
    assert.equal(src.indexOf(bad), -1, `taskBoard.ts 里不该再写死 ${bad}`);
  }
  assert.ok(src.indexOf('isFinalStatus') > 0, '终态判据要走 boardMeta.isFinalStatus');
});
