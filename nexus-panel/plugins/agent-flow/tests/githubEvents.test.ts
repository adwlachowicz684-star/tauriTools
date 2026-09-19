import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_EVENT_KINDS, eventPath, latestEvent, isNewEvent, rememberEvent,
  emptyPollState, condHeaders, etagOf, handlePollResponse, backoffMs, eventToText,
} from '../engine/githubEvents';

/* ================= 事件类型 ================= */

test('四种事件都有中文名', () => {
  for (const k of GITHUB_EVENT_KINDS) {
    assert.ok(k, `${k} 该有名字`);
  }
});

/** per_page=1 很关键：不限制会把整个提交历史拉回来 */
test('push 只拉最新一条', () => {
  assert.ok(eventPath('push', 'o', 'r').includes('per_page=1'));
});

test('push 带分支', () => {
  const p = eventPath('push', 'o', 'r', 'main');
  assert.ok(p.includes('sha=main'));
});

/** owner/repo 要转义 —— 名字里带特殊字符会拼出错的 URL */
test('owner / repo 转义', () => {
  assert.ok(eventPath('push', 'a b', 'c/d').includes('a%20b'));
  assert.ok(eventPath('push', 'a b', 'c/d').includes('c%2Fd'));
});

test('release 查 latest', () => {
  assert.ok(eventPath('release', 'o', 'r').includes('releases/latest'));
});

test('未知类型不走空串', () => {
  assert.ok(eventPath('xx' as never, 'o', 'r').includes('/repos/o/r'));
});

/* ================= 解析 ================= */

test('解析 push 事件', () => {
  const ev = latestEvent('push', [{
    sha: 'abc1234567',
    html_url: 'https://github.com/o/r/commit/abc',
    commit: { message: '修了个 bug', author: { name: 'zhangsan', date: '2026-01-01T00:00:00Z' } },
    author: { login: 'zhangsan' },
  }]);
  assert.ok(ev);
  assert.equal(ev.id, 'abc1234567');
  assert.ok(ev.title.includes('abc123'));
  assert.equal(ev.body, '修了个 bug');
});

test('空数组解析不出事件', () => {
  assert.equal(latestEvent('push', []), null);
});

/** issues API 会连 PR 一起返回 —— 不过滤会被 PR 刷屏 */
test('issue 列表过滤掉 PR', () => {
  const json = [
    { number: 1, title: '真 issue', pull_request: { url: 'x' } },
    { number: 2, title: '普通 issue' },
  ];
  const ev = latestEvent('issue', json);
  assert.ok(ev);
  assert.ok(ev.title.includes('#2'), '该取到 #2 而不是 #1');
});

test('pr 只取 PR', () => {
  const json = [
    { number: 1, title: '普通 issue' },
    { number: 2, title: '真 PR', pull_request: { url: 'x' } },
  ];
  const ev = latestEvent('pr', json);
  assert.ok(ev);
  assert.ok(ev.title.includes('#2'));
});

test('PR 全列表里没有 PR 时返回 null', () => {
  assert.equal(latestEvent('pr', [{ number: 1, title: 'issue' }]), null);
});

test('解析 release', () => {
  const ev = latestEvent('release', {
    tag_name: 'v1.2.0', html_url: 'https://x', body: '更新说明',
    author: { login: 'lisi' }, published_at: '2026-01-01T00:00:00Z',
  });
  assert.ok(ev);
  assert.equal(ev.id, 'release-v1.2.0');
  assert.ok(ev.title.includes('v1.2.0'));
});

/** 没 tag 的响应不是 release —— 判成有事件会误触发 */
test('release 没 tag 时返回 null', () => {
  assert.equal(latestEvent('release', { body: 'x' }), null);
});

test('垃圾输入不炸', () => {
  assert.equal(latestEvent('push', null), null);
  assert.equal(latestEvent('push', 'not json'), null);
  assert.equal(latestEvent('release', null), null);
});

/* ================= 去重 ================= */

test('没见过的算新事件', () => {
  assert.equal(isNewEvent('a', []), true);
  assert.equal(isNewEvent('a', ['b']), true);
});

test('见过的不是新事件', () => {
  assert.equal(isNewEvent('a', ['a']), false);
});

/** 空 id 不能算新事件 —— 会变成每次都触发 */
test('空 id 不算新事件', () => {
  assert.equal(isNewEvent('', []), false);
});

/** 不封顶会无限增长，撑爆存档 */
test('记忆有上限', () => {
  let seen: string[] = [];
  for (let i = 0; i < 80; i += 1) seen = rememberEvent(`id${i}`, seen, 50);
  assert.equal(seen.length, 50);
});

test('重复记不会重复存', () => {
  let seen = rememberEvent('a', []);
  seen = rememberEvent('a', seen);
  assert.equal(seen.filter((x) => x === 'a').length, 1);
});

test('最新的排最前', () => {
  const seen = rememberEvent('b', ['a']);
  assert.equal(seen[0], 'b');
});

/* ================= 条件请求 ================= */

/** 有 ETag 才带 If-None-Match —— 这是省配额的关键 */
test('有 ETag 时带条件请求头', () => {
  const h = condHeaders('', 'W/"abc"');
  assert.equal(h['If-None-Match'], 'W/"abc"');
});

test('没 ETag 时不带', () => {
  assert.equal(condHeaders('', '')['If-None-Match'], undefined);
});

test('有 token 时带鉴权头', () => {
  assert.ok(condHeaders('ghp_x', '')['Authorization'].includes('ghp_x'));
});

test('没 token 时不带鉴权头', () => {
  assert.equal(condHeaders('', '')['Authorization'], undefined);
});

test('ETag 头大小写都能取到', () => {
  assert.equal(etagOf({ ETag: 'a' }), 'a');
  assert.equal(etagOf({ etag: 'b' }), 'b');
  assert.equal(etagOf({}), '');
});

/* ================= 轮询响应 ================= */

const R = (status: number, body: string, headers: Record<string, string> = {}) =>
  ({ status, ok: status >= 200 && status < 300, text: body, headers });

/** 304 说明真没变化，而且**不消耗配额** */
test('304 = 没变化', () => {
  const r = handlePollResponse('push', emptyPollState(), R(304, ''));
  assert.equal(r.changed, false);
  assert.ok(r.note.includes('304'));
});

/** 撞墙后继续按原频率轮询只会再撞一次 */
test('403/429 = 被限流，要退避', () => {
  for (const s of [403, 429]) {
    const r = handlePollResponse('push', emptyPollState(), R(s, ''));
    assert.equal(r.limited, true, `${s} 该算限流`);
  }
});

test('限流提示里带剩余配额', () => {
  const r = handlePollResponse('push', emptyPollState(), R(403, '', { 'x-ratelimit-remaining': '0' }));
  assert.ok(r.note.includes('0'));
});

test('404 = 仓库不存在或无权访问', () => {
  const r = handlePollResponse('push', emptyPollState(), R(404, ''));
  assert.equal(r.changed, false);
  assert.ok(r.note.includes('不存在'));
});

test('500 = 查询失败', () => {
  assert.ok(handlePollResponse('push', emptyPollState(), R(500, '')).note.includes('500'));
});

test('响应不是 JSON 时不炸', () => {
  const r = handlePollResponse('push', emptyPollState(), R(200, '<html>'));
  assert.equal(r.changed, false);
  assert.ok(r.note.includes('JSON'));
});

/** 拿到了但解析不出事件 ≠ 没变化 —— 静默跳过会让人以为一直在正常监听 */
test('解析不出事件要明说', () => {
  const r = handlePollResponse('push', emptyPollState(), R(200, '[]'));
  assert.ok(r.note.includes('没解析出事件'));
});

test('首次轮询发现新事件', () => {
  const body = JSON.stringify([{
    sha: 'aaa', html_url: 'u', commit: { message: 'm', author: { name: 'n', date: 'd' } },
  }]);
  const r = handlePollResponse('push', emptyPollState(), R(200, body));
  assert.equal(r.changed, true);
  assert.ok(r.event);
});

/** 同一件事第二次不该再触发 */
test('同一事件第二次不算新', () => {
  const body = JSON.stringify([{
    sha: 'aaa', html_url: 'u', commit: { message: 'm', author: { name: 'n', date: 'd' } },
  }]);
  const first = handlePollResponse('push', emptyPollState(), R(200, body));
  assert.equal(first.changed, true);
  const second = handlePollResponse('push', first.next, R(200, body));
  assert.equal(second.changed, false);
  assert.equal(second.event, null);
});

/** ETag 必须存下来，否则下次不带条件请求，白白消耗配额 */
test('ETag 存进状态', () => {
  const body = JSON.stringify([{
    sha: 'aaa', html_url: 'u', commit: { message: 'm', author: { name: 'n', date: 'd' } },
  }]);
  const r = handlePollResponse('push', emptyPollState(), R(200, body, { etag: 'W/"x"' }));
  assert.equal(r.next.etag, 'W/"x"');
});

test('状态为空也能用（老存档没有这个字段）', () => {
  const r = handlePollResponse('push', null as never, R(304, ''));
  assert.equal(r.changed, false);
});

test('seen 不是数组时不炸', () => {
  const r = handlePollResponse('push', { etag: '', seen: 'bad' as never }, R(304, ''));
  assert.equal(r.changed, false);
});

/* ================= 退避 ================= */

test('第一次退避 1 分钟', () => {
  assert.equal(backoffMs(0), 60_000);
});

/** 不封顶的话，长时间限流后间隔会长到像挂了 */
test('退避有上限', () => {
  assert.equal(backoffMs(99), 30 * 60_000);
});

test('退避递增', () => {
  assert.ok(backoffMs(1) > backoffMs(0));
});

test('负数不炸', () => {
  assert.equal(backoffMs(-5), 60_000);
});

/* ================= 给下游的文本 ================= */

/** 给 JSON 而不是纯文本 —— 下游才能用提取节点取字段 */
test('事件文本是 JSON', () => {
  const ev = latestEvent('release', { tag_name: 'v1', html_url: 'u', author: { login: 'a' } });
  const t = eventToText(ev as never);
  const j = JSON.parse(t);
  assert.equal(j.kind, 'release');
  assert.equal(j.id, 'release-v1');
});

test('空事件给空串', () => {
  assert.equal(eventToText(null as never), '');
});
