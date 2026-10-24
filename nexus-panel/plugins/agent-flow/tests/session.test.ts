import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newSessionId, looksLikeSessionId, shortId,
  loadSession, saveSession, resetSession, sessionName,
  type Session,
} from '../engine/session';
import {
  emptyBoard, addNode, claimTask, takeOver, releaseTask,
  isClaimedBy, takeOverNote, isTask,
  type BoardTask, type TaskBoard,
} from '../engine/taskBoard';
import { buildTableRows, sessionOptionsOf, applyTable, emptyQuery, emptyFilter } from '../engine/taskTable';

/** 内存版 KV —— 不碰 localStorage，测试可重复 */
function memKV(init: Record<string, string> = {}): { get: (k: string) => string | null; set: (k: string, v: string) => void; store: Record<string, string> } {
  const store: Record<string, string> = { ...init };
  return {
    store,
    get: (k) => (k in store ? store[k] : null),
    set: (k, v) => { store[k] = v; },
  };
}

function task(title: string, p: Partial<BoardTask> = {}): BoardTask {
  return {
    kind: 'task', title, status: 'todo', deps: [], assignee: '', note: '',
    desc: '', tags: [], createdAt: 0, updatedAt: 0, due: 0, priority: 0,
    session: '', prevSession: '', tookAt: 0,
    ...p,
  };
}

function boardOf(list: BoardTask[]): TaskBoard {
  let b = emptyBoard('p1', '项目甲');
  for (const t of list) b = addNode(b, null, t).board;
  return b;
}

/* ---------- 生成与持久化 ---------- */

test('生成的号能自己认出来（解析外部数据时要能判断）', () => {
  const id = newSessionId();
  assert.ok(looksLikeSessionId(id), `${id} 应被认成本模块生成的号`);
  // 手填的名字不该被当成窗口号
  assert.equal(looksLikeSessionId('张三'), false);
  assert.equal(looksLikeSessionId('codebuddy'), false);
  assert.equal(looksLikeSessionId(''), false);
});

test('短号用于窄列显示（去掉前缀只留随机段）', () => {
  assert.equal(shortId('w_mabc_3f2a91'), '3f2a91');
});

test('首次读取会生成并**立刻存下**（不存则两次调用会拿到不同的号）', () => {
  const kv = memKV();
  const a = loadSession(kv);
  assert.ok(a.id);
  assert.ok(kv.get('agent-flow:session'), '必须已落盘');
  const b = loadSession(kv);
  assert.equal(a.id, b.id, '同一存储下必须稳定');
});

test('坏掉的存储内容退回重新生成，而不是抛出', () => {
  const kv = memKV({ 'agent-flow:session': '{不是 json' });
  const s = loadSession(kv);
  assert.ok(s.id, '解析失败也要能给出可用身份');
});

test('换号后旧号不残留（但任务上的旧记录本来就不受影响）', () => {
  const kv = memKV();
  const a = loadSession(kv);
  const b = resetSession(kv);
  assert.notEqual(a.id, b.id);
  assert.equal(loadSession(kv).id, b.id);
});

test('label 只影响显示，不影响 id', () => {
  const kv = memKV();
  const s: Session = { id: newSessionId(), label: '窗口 甲', createdAt: 1 };
  saveSession(s, kv);
  assert.equal(sessionName(loadSession(kv)), '窗口 甲');
  // 没 label 时退回短号，不显示空白
  assert.equal(sessionName({ id: 'w_a_3f2a91', label: '  ', createdAt: 0 }), '3f2a91');
});

/* ---------- 认领 / 接手 ---------- */

test('认领写入窗口号', () => {
  const b = boardOf([task('甲')]);
  const id = Object.keys(b.nodes)[0];
  const r = claimTask(b, id, '张三', 'w_1_aaaaaa');
  const t = r.board.nodes[id];
  assert.ok(isTask(t));
  assert.equal((t as BoardTask).session, 'w_1_aaaaaa');
  assert.equal((t as BoardTask).assignee, '张三');
});

test('不传窗口号时只改名字，不动窗口身份', () => {
  const b = boardOf([task('甲', { session: 'w_1_aaaaaa' })]);
  const id = Object.keys(b.nodes)[0];
  const r = claimTask(b, id, '李四');
  assert.equal((r.board.nodes[id] as BoardTask).session, 'w_1_aaaaaa', '不该被清空');
  assert.equal((r.board.nodes[id] as BoardTask).assignee, '李四');
});

test('接手：换人时留痕，记下原来是谁', () => {
  const b = boardOf([task('甲', { session: 'w_1_aaaaaa', assignee: '张三' })]);
  const id = Object.keys(b.nodes)[0];
  const r = takeOver(b, id, '李四', 'w_2_bbbbbb');
  const t = r.board.nodes[id] as BoardTask;
  assert.equal(t.session, 'w_2_bbbbbb', '现在是新窗口的');
  assert.equal(t.prevSession, 'w_1_aaaaaa', '原认领者必须留下');
  assert.ok(t.tookAt > 0, '接手时间要记');
});

test('同一个窗口重复认领不覆盖 prevSession（不把自己记成原认领者）', () => {
  let b = boardOf([task('甲', { session: 'w_1_aaaaaa' })]);
  const id = Object.keys(b.nodes)[0];
  b = takeOver(b, id, '李四', 'w_2_bbbbbb').board;
  // 窗口乙再来一次
  const again = claimTask(b, id, '李四', 'w_2_bbbbbb').board;
  const t = again.nodes[id] as BoardTask;
  assert.equal(t.prevSession, 'w_1_aaaaaa', '重复认领不该冲掉原来的痕迹');
});

test('认领别人已领的会警告（按窗口号判，不按名字）', () => {
  /*
    名字是手填的，两个窗口可以填同一个名字。
    按名字判的话，窗口甲自己再点一次认领会误报"抢别人的"。
  */
  const b = boardOf([task('甲', { session: 'w_1_aaaaaa', assignee: '同名' })]);
  const id = Object.keys(b.nodes)[0];
  const mine = claimTask(b, id, '同名', 'w_1_aaaaaa');
  assert.ok(!mine.warnings.some((w) => w.includes('另一个窗口')), '自己重复认领不该告警');
  const other = claimTask(b, id, '同名', 'w_2_bbbbbb');
  assert.ok(other.warnings.some((w) => w.includes('另一个窗口')), '别人来认领要告警');
});

test('放回：清名字与窗口号，但保留接手痕迹供追溯', () => {
  let b = boardOf([task('甲', { session: 'w_1_aaaaaa' })]);
  const id = Object.keys(b.nodes)[0];
  b = takeOver(b, id, '李四', 'w_2_bbbbbb').board;
  const r = releaseTask(b, id);
  const t = r.board.nodes[id] as BoardTask;
  assert.equal(t.session, '');
  assert.equal(t.assignee, '');
  assert.equal(t.prevSession, 'w_1_aaaaaa', '接过手这件事本身不该被抹掉');
});

test('isClaimedBy 直接判归属；takeOverNote 给出人话说明', () => {
  const b = boardOf([task('甲', { session: 'w_1_aaaaaa' })]);
  const id = Object.keys(b.nodes)[0];
  assert.equal(isClaimedBy(b.nodes[id], 'w_1_aaaaaa'), true);
  assert.equal(isClaimedBy(b.nodes[id], 'w_2_bbbbbb'), false);
  assert.equal(isClaimedBy(b.nodes[id], ''), false, '有人认领时不该匹配"没人认领"');
  const noOne = boardOf([task('乙')]);
  assert.equal(isClaimedBy(noOne.nodes[Object.keys(noOne.nodes)[0]], ''), true);

  const taken = takeOver(b, id, '李四', 'w_2_bbbbbb').board;
  const note = takeOverNote(taken.nodes[id]);
  assert.ok(note.includes('w_1_aaaaaa'), note);
  assert.ok(note.includes('接手自'), note);
});

/* ---------- 表格：窗口列 ---------- */

test('窗口列：任务行取"谁负责"，运行行取"谁跑的"', () => {
  const rows = buildTableRows([], [], boardOf([
    task('甲', { session: 'w_1_aaaaaa' }),
    task('乙', { session: 'w_2_bbbbbb' }),
  ]));
  assert.equal(rows.length, 2);
  // 选项从数据去重，未知单独一项
  const opts = sessionOptionsOf(rows);
  assert.deepEqual(opts.map((o) => o.v).sort(), ['w_1_aaaaaa', 'w_2_bbbbbb']);
});

test('窗口列能筛出"我的"（这是加这个字段的主要用途）', () => {
  const rows = buildTableRows([], [], boardOf([
    task('甲', { session: 'w_1_aaaaaa' }),
    task('乙', { session: 'w_2_bbbbbb' }),
    task('丙', { session: '' }),
  ]));
  const q = emptyQuery();
  q.filters.session = { ...emptyFilter(), values: ['w_1_aaaaaa'] };
  const hit = applyTable(rows, q, 0);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].task?.title, '甲');
});

test('窗口列能筛出没归属的（空串是有效选项，不是"没值"）', () => {
  const rows = buildTableRows([], [], boardOf([
    task('甲', { session: 'w_1_aaaaaa' }),
    task('丙', { session: '' }),
  ]));
  const q = emptyQuery();
  q.filters.session = { ...emptyFilter(), values: [''] };
  const hit = applyTable(rows, q, 0);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].task?.title, '丙');
});
