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

/** 内存版 KV —— 不碰 localStorage，测试可重复 */
function memKV(init: Record<string, string> = {}): { get: (k: string) => string | null; set: (k: string, v: string) => void; store: Record<string, string> } {
  const store: Record<string, string> = { ...init };
  return {
    store,
    get: (k) => (k in store ? store[k] : null),
    set: (k, v) => { store[k] = v; },
  };
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

/*
  ⛔ 认领 / 接手那 8 条已随任务板一起删掉。

  engine/taskBoard.ts 在 #399 被整块移除（claimTask / takeOver / releaseTask /
  isClaimedBy / takeOverNote 都在里面），而这些用例测的正是它们 —— 留着会让
  整个文件 Cannot find module 崩掉，连带上面那 6 条正常的 session 用例一起红。

  保留的是 session 本身的：生成、认号、持久化、坏内容退回、换号、label。
  这些不依赖任务板。
*/
