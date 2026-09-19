import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  headerOf, hookEventOf, isPing, parseSignature, timingSafeEqual,
  verifyGithubHook, summarizeHook,
} from '../engine/githubHook';

/** 真 HMAC —— 只有"格式对不对"这类用例才用假实现 */
const realHmac = (key: string, msg: string) =>
  createHmac('sha256', key).update(msg, 'utf8').digest('hex');

const sign = (body: string, secret: string) =>
  `sha256=${realHmac(secret, body)}`;

/* ================= 头解析 ================= */

test('头名大小写不敏感', () => {
  assert.equal(headerOf({ 'X-GitHub-Event': 'push' }, 'x-github-event'), 'push');
  assert.equal(headerOf({ 'x-github-event': 'push' }, 'X-GitHub-Event'), 'push');
});

test('取不到的头给空串', () => {
  assert.equal(headerOf({}, 'X-GitHub-Event'), '');
});

/* ================= 事件类型 ================= */

test('认得常见事件', () => {
  assert.equal(hookEventOf({ 'X-GitHub-Event': 'push' }), 'push');
  assert.equal(hookEventOf({ 'X-GitHub-Event': 'pull_request' }), 'pull_request');
  assert.equal(hookEventOf({ 'X-GitHub-Event': 'release' }), 'release');
});

test('不认得的归为 unknown', () => {
  assert.equal(hookEventOf({ 'X-GitHub-Event': 'whatever' }), 'unknown');
  assert.equal(hookEventOf({}), 'unknown');
});

/** ping 是建 webhook 时的测试包，当成 push 会莫名跑一次流程 */
test('ping 要能单独认出来', () => {
  assert.equal(isPing({ 'X-GitHub-Event': 'ping' }), true);
  assert.equal(isPing({ 'X-GitHub-Event': 'push' }), false);
});

/* ================= 签名格式 ================= */

test('解析 sha256=<hex>', () => {
  const p = parseSignature('sha256=abc123');
  assert.ok(p);
  assert.equal(p.hex, 'abc123');
});

test('大小写 hex 归一', () => {
  assert.equal(parseSignature('sha256=ABCDEF')?.hex, 'abcdef');
});

/** sha1 已被 GitHub 弃用 —— 接受它等于接受弱校验 */
test('不接受 sha1', () => {
  assert.equal(parseSignature('sha1=abc'), null);
});

test('格式不对返回 null', () => {
  assert.equal(parseSignature('abc'), null);
  assert.equal(parseSignature('sha256='), null);
  assert.equal(parseSignature(''), null);
});

test('hex 里有非法字符时返回 null', () => {
  assert.equal(parseSignature('sha256=zzz'), null);
});

/* ================= 恒定时间比较 ================= */

test('相同字符串相等', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
});

test('不同字符串不等', () => {
  assert.equal(timingSafeEqual('abc', 'abd'), false);
});

/** 长度不同绝不能判等 —— 这是最容易写错的一条 */
test('前缀相同但长度不同时不相等', () => {
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', 'a'), false);
});

test('两个空串相等', () => {
  assert.equal(timingSafeEqual('', ''), true);
});

/* ================= 校验 ================= */

test('正确签名通过', async () => {
  const body = '{"a":1}';
  const r = await verifyGithubHook({
    body,
    headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sign(body, 'sec') },
    secret: 'sec',
    hmacHex: realHmac,
  });
  assert.equal(r.ok, true);
  assert.equal(r.event, 'push');
});

test('secret 不对时失败', async () => {
  const body = '{"a":1}';
  const r = await verifyGithubHook({
    body,
    headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sign(body, 'sec') },
    secret: 'wrong',
    hmacHex: realHmac,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('secret'));
});

/** body 被中间环节改写就会验不过 —— 这条能解释"明明配对却一直失败" */
test('body 被改时失败', async () => {
  const r = await verifyGithubHook({
    body: '{"a":2}',
    headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sign('{"a":1}', 'sec') },
    secret: 'sec',
    hmacHex: realHmac,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('body'));
});

/** 没配 secret 又暴露在公网 = 敞开 */
test('没配 secret 时拒绝', async () => {
  const r = await verifyGithubHook({
    body: '{}',
    headers: { 'X-Hub-Signature-256': sign('{}', 'sec') },
    secret: '',
    hmacHex: realHmac,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('secret'));
});

test('没有签名头时拒绝', async () => {
  const r = await verifyGithubHook({
    body: '{}', headers: { 'X-GitHub-Event': 'push' }, secret: 'sec', hmacHex: realHmac,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('X-Hub-Signature-256'));
});

test('签名格式错误时拒绝', async () => {
  const r = await verifyGithubHook({
    body: '{}',
    headers: { 'X-Hub-Signature-256': 'sha1=abc' },
    secret: 'sec', hmacHex: realHmac,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('格式'));
});

test('算签名抛错时不炸', async () => {
  const r = await verifyGithubHook({
    body: '{}',
    headers: { 'X-Hub-Signature-256': 'sha256=aa' },
    secret: 'sec',
    hmacHex: () => { throw new Error('boom'); },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('boom'));
});

/* ================= 摘要 ================= */

test('push 摘要含分支与提交数', () => {
  const s = summarizeHook('push', {
    ref: 'refs/heads/main',
    commits: [{ message: '第一行\n第二行' }],
    sender: { login: 'zhangsan' },
    compare: 'https://x',
  });
  assert.ok(s.title.includes('main'));
  assert.ok(s.title.includes('1'));
  assert.ok(s.title.includes('第一行'));
  assert.equal(s.actor, 'zhangsan');
});

test('push 没有 commits 时不炸', () => {
  const s = summarizeHook('push', { ref: 'refs/heads/main' });
  assert.ok(s.title.includes('0'));
});

test('PR 摘要含编号与动作', () => {
  const s = summarizeHook('pull_request', {
    action: 'opened', number: 12,
    pull_request: { number: 12, title: '加个功能', html_url: 'https://pr' },
    sender: { login: 'lisi' },
  });
  assert.ok(s.title.includes('#12'));
  assert.ok(s.title.includes('opened'));
});

test('Issue 摘要', () => {
  const s = summarizeHook('issues', {
    action: 'opened', issue: { number: 3, title: '报个错', html_url: 'https://i' },
  });
  assert.ok(s.title.includes('#3'));
});

test('release 摘要含 tag', () => {
  const s = summarizeHook('release', {
    action: 'published', release: { tag_name: 'v2', html_url: 'https://r' },
  });
  assert.ok(s.title.includes('v2'));
});

/** ping 要说清楚它不是真实事件，否则用户以为流程被触发了 */
test('ping 摘要说明是测试', () => {
  const s = summarizeHook('ping', {});
  assert.ok(s.title.includes('测试'));
});

test('未知事件不炸', () => {
  assert.equal(summarizeHook('unknown', null).event, 'unknown');
  assert.equal(summarizeHook('unknown' as never, undefined).label, '未知事件');
});
