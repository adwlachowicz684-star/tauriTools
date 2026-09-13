import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAtom, parseLsRemote, httpHint, runWithFallback,
  fetchUpdate, pushFiles, b64Encode, verifyToken,
  type Fetcher, type FetchResp, type Attempt,
} from '../engine/github';

/* ---------- 桩 ---------- */

function resp(status: number, text: string, headers: Record<string, string> = {}): FetchResp {
  return { status, ok: status >= 200 && status < 300, text, headers };
}

function route(map: Record<string, FetchResp>): Fetcher {
  return async (url: string) => {
    for (const k of Object.keys(map)) {
      if (url.indexOf(k) >= 0) return map[k];
    }
    return resp(404, '{"message":"Not Found"}');
  };
}

const commitJson = (sha: string, msg: string) =>
  JSON.stringify([{
    sha,
    commit: { message: msg, author: { name: 'octo', date: '2026-01-02T03:04:05Z' } },
  }]);

/* ---------- 解析 ---------- */

test('parseAtom: 能抓出 sha / 标题 / 作者 / 时间', () => {
  const xml = `<?xml version="1.0"?><feed><entry>
    <id>tag:github.com,2008:Grit::Commit/abc1234def</id>
    <title>修复登录</title>
    <updated>2026-05-01T10:00:00Z</updated>
    <author><name>octocat</name></author>
  </entry></feed>`;
  const r = parseAtom(xml);
  assert.ok(r);
  assert.equal(r!.sha, 'abc1234def');
  assert.equal(r!.message, '修复登录');
  assert.equal(r!.author, 'octocat');
  assert.equal(r!.date, '2026-05-01T10:00:00Z');
});

test('parseAtom: 实体解码（&amp; 不能残留）', () => {
  const xml = `<feed><entry><id>tag:x:Grit::Commit/deadbeef</id><title>A &amp; B</title></entry></feed>`;
  assert.equal(parseAtom(xml)!.message, 'A & B');
});

test('parseAtom: 无 sha 时返回 null（宁可失败也不要误判有更新）', () => {
  assert.equal(parseAtom('<feed><entry><title>x</title></entry></feed>'), null);
});

test('parseAtom: 空输入返回 null', () => {
  assert.equal(parseAtom(''), null);
});

test('parseLsRemote: 匹配指定分支', () => {
  const out = 'abc1111\trefs/heads/main\nbbb2222\trefs/heads/dev\n';
  assert.equal(parseLsRemote(out, 'dev'), 'bbb2222');
});

test('parseLsRemote: 分支不存在返回 null', () => {
  assert.equal(parseLsRemote('abc1111\trefs/heads/main\n', 'nope'), null);
});

test('httpHint: 401/403/404 有针对性提示', () => {
  assert.ok(httpHint(401).indexOf('过期') >= 0);
  assert.ok(httpHint(403).indexOf('权限') >= 0);
  assert.ok(httpHint(404).indexOf('私有库') >= 0);
});

/* ---------- 兜底执行器 ---------- */

test('兜底: 第一个成功就用第一个', async () => {
  const r = await runWithFallback([
    { name: 'a', run: async () => ({ ok: true, value: 1 }) },
    { name: 'b', run: async () => ({ ok: true, value: 2 }) },
  ]);
  assert.equal(r.ok, true);
  assert.equal((r as { via: string }).via, 'a');
});

test('兜底: 前一个失败自动换下一个', async () => {
  const r = await runWithFallback([
    { name: 'a', run: async () => ({ ok: false, error: '炸了' }) },
    { name: 'b', run: async () => ({ ok: true, value: 2 }) },
  ]);
  assert.equal(r.ok, true);
  assert.equal((r as { via: string }).via, 'b');
});

test('兜底: 全失败时汇总所有原因（不只报最后一条）', async () => {
  const r = await runWithFallback([
    { name: 'api', run: async () => ({ ok: false, error: '401' }) },
    { name: 'cli', run: async () => ({ ok: false, error: '没装 git' }) },
  ]);
  assert.equal(r.ok, false);
  const e = (r as { error: string }).error;
  assert.ok(e.indexOf('api') >= 0 && e.indexOf('cli') >= 0, '应列出全部方案');
  assert.ok(e.indexOf('401') >= 0 && e.indexOf('git') >= 0);
});

test('兜底: 抛异常的策略被捕获，不中断整体', async () => {
  const r = await runWithFallback([
    { name: 'boom', run: async () => { throw new Error('unexpected'); } },
    { name: 'ok', run: async () => ({ ok: true, value: 9 }) },
  ]);
  assert.equal(r.ok, true);
  assert.equal((r as { via: string }).via, 'ok');
});

/* ---------- 拉取 ---------- */

test('拉取: api 方案成功', async () => {
  const f = route({
    'api.github.com/repos/o/r/commits': resp(200, commitJson('aaa111222', '首次提交')),
    'api.github.com/repos/o/r': resp(200, '{"default_branch":"main"}'),
  });
  const r = await fetchUpdate(f, { owner: 'o', repo: 'r' }, { token: 't' });
  assert.equal(r.ok, true);
  const v = (r as { value: { sha: string; branch: string; message: string } }).value;
  assert.equal(v.sha, 'aaa111222');
  assert.equal(v.branch, 'main');
  assert.equal(v.message, '首次提交');
  assert.equal((r as { via: string }).via, 'api');
});

test('拉取: base 与最新 sha 不同 → updated 为 true', async () => {
  const f = route({
    'api.github.com/repos/o/r/commits': resp(200, commitJson('newsha999', 'x')),
    'api.github.com/repos/o/r': resp(200, '{"default_branch":"main"}'),
  });
  const r = await fetchUpdate(f, { owner: 'o', repo: 'r' }, { token: 't', base: 'oldsha111' });
  assert.equal((r as { value: { updated: boolean } }).value.updated, true);
});

test('拉取: base 是最新 sha 的前缀 → 视为无更新', async () => {
  const f = route({
    'api.github.com/repos/o/r/commits': resp(200, commitJson('abc123def456', 'x')),
    'api.github.com/repos/o/r': resp(200, '{"default_branch":"main"}'),
  });
  const r = await fetchUpdate(f, { owner: 'o', repo: 'r' }, { token: 't', base: 'abc123' });
  assert.equal((r as { value: { updated: boolean } }).value.updated, false);
});

test('拉取: api 403 时自动切 atom', async () => {
  const f = route({
    'api.github.com/': resp(403, '{"message":"rate limited"}'),
    'github.com/o/r/commits': resp(200, `<feed><entry><id>tag:x:Grit::Commit/feed999</id><title>via atom</title></entry></feed>`),
  });
  const r = await fetchUpdate(f, { owner: 'o', repo: 'r' }, { token: '' });
  assert.equal(r.ok, true);
  assert.equal((r as { via: string }).via, 'atom');
  assert.equal((r as { value: { sha: string } }).value.sha, 'feed999');
});

test('拉取: api 与 atom 都失败时切 cli', async () => {
  const f = route({
    'api.github.com/': resp(401, '{}'),
    'github.com/o/r/commits': resp(404, '{}'),
  });
  const r = await fetchUpdate(f, { owner: 'o', repo: 'r' }, {
    token: '',
    cli: async () => 'abc1234\tHEAD\n',
  });
  assert.equal(r.ok, true);
  assert.equal((r as { via: string }).via, 'cli');
});

test('拉取: 三条路全断时报错且列出原因', async () => {
  const f = route({ 'api.github.com/': resp(401, '{}'), 'github.com/': resp(404, '{}') });
  const r = await fetchUpdate(f, { owner: 'o', repo: 'r' }, { token: '' });
  assert.equal(r.ok, false);
  assert.ok((r as { error: string }).error.indexOf('所有方案都失败') >= 0);
});

test('拉取: 缺 owner/repo 时直接报错，不浪费网络请求', async () => {
  let called = 0;
  const f: Fetcher = async () => { called += 1; return resp(200, '{}'); };
  const r = await fetchUpdate(f, { owner: '', repo: 'r' }, { token: '' });
  assert.equal(r.ok, false);
  assert.equal(called, 0, '参数不合法时不应发起请求');
});

test('拉取: 可指定策略顺序（order 生效）', async () => {
  const f = route({
    'api.github.com/repos/o/r/commits': resp(200, commitJson('apisha11', 'x')),
    'api.github.com/repos/o/r': resp(200, '{"default_branch":"main"}'),
  });
  // atom 优先，但 atom 挂了 → 落回 api
  const r = await fetchUpdate(f, { owner: 'o', repo: 'r' }, { token: 't', order: ['atom', 'api'] });
  assert.equal((r as { via: string }).via, 'api');
});

/* ---------- 推送 ---------- */

test('推送: api 方案写入新文件（无 sha）', async () => {
  let body = '';
  const f: Fetcher = async (url, init) => {
    if (init && init.method === 'PUT') { body = init.body || ''; return resp(201, '{"commit":{"sha":"newsha111"}}'); }
    return resp(404, '{}');
  };
  const r = await pushFiles(f, { owner: 'o', repo: 'r' }, {
    token: 't', branch: 'main', message: 'add readme',
    files: [{ path: 'README.md', content: '# hi' }],
  });
  assert.equal(r.ok, true);
  assert.equal((r as { via: string }).via, 'api');
  assert.equal(body.indexOf('"sha"') < 0, true, '新文件不该带 sha 字段');
});

test('推送: 已存在的文件会先取 sha 再提交', async () => {
  const f = route({
    'contents/README.md': resp(200, '{"sha":"existingsha"}'),
  });
  let body = '';
  const g: Fetcher = async (url, init) => {
    if (init && init.method === 'PUT') { body = init.body || ''; return resp(200, '{"commit":{"sha":"upd222"}}'); }
    return f(url, init);
  };
  const r = await pushFiles(g, { owner: 'o', repo: 'r' }, {
    token: 't', branch: 'main', message: 'update',
    files: [{ path: 'README.md', content: 'new' }],
  });
  assert.equal(r.ok, true);
  assert.ok(body.indexOf('existingsha') >= 0, '应带上文件当前 sha');
});

test('推送: 无令牌时 api 方案跳过，转 cli', async () => {
  const calls: string[] = [];
  const f: Fetcher = async () => resp(200, '{}');
  const r = await pushFiles(f, { owner: 'o', repo: 'r' }, {
    token: '', branch: 'main', message: 'm',
    files: [{ path: 'a.txt', content: 'x' }],
    workdir: '/tmp/repo',
    cli: async (args) => { calls.push(args.join(' ')); return 'cli999'; },
  });
  assert.equal((r as { via: string }).via, 'cli');
  assert.ok(calls.some((c) => c.indexOf('push') >= 0), '应执行 git push');
});

test('推送: cli 方案缺 workdir 时报错', async () => {
  const f: Fetcher = async () => resp(200, '{}');
  const r = await pushFiles(f, { owner: 'o', repo: 'r' }, {
    token: '', message: 'm', files: [{ path: 'a', content: 'x' }],
    cli: async () => 'x',
  });
  assert.equal(r.ok, false);
});

test('推送: 提交信息为空时直接拒绝', async () => {
  const f: Fetcher = async () => resp(200, '{}');
  const r = await pushFiles(f, { owner: 'o', repo: 'r' }, {
    token: 't', message: '   ', files: [{ path: 'a', content: 'x' }],
  });
  assert.equal(r.ok, false);
});

test('推送: 没有文件时报错', async () => {
  const f: Fetcher = async () => resp(200, '{}');
  const r = await pushFiles(f, { owner: 'o', repo: 'r' }, { token: 't', message: 'm', files: [] });
  assert.equal(r.ok, false);
});

test('推送: 中文内容 base64 编码正确（不能因 btoa 抛异常）', async () => {
  let body = '';
  const f: Fetcher = async (url, init) => {
    if (init && init.method === 'PUT') { body = init.body || ''; return resp(201, '{"commit":{"sha":"c"}}'); }
    return resp(404, '{}');
  };
  const r = await pushFiles(f, { owner: 'o', repo: 'r' }, {
    token: 't', branch: 'main', message: '更新',
    files: [{ path: '说明.md', content: '你好，世界' }],
  });
  assert.equal(r.ok, true);
  assert.ok(body.length > 0);
});

/* ---------- base64 ---------- */

test('b64Encode: 与标准实现一致（ASCII）', () => {
  assert.equal(b64Encode('hello'), 'aGVsbG8=');
});

test('b64Encode: 中文不抛异常且能还原', () => {
  const s = '你好 hello';
  const b = b64Encode(s);
  assert.ok(b.length > 0);
  const back = Buffer.from(b, 'base64').toString('utf-8');
  assert.equal(back, s);
});

test('b64Encode: 空串', () => {
  assert.equal(b64Encode(''), '');
});

/* ---------- 令牌校验 ---------- */

test('verifyToken: 成功时返回 login 与 scopes', async () => {
  const f: Fetcher = async () =>
    resp(200, '{"login":"octocat"}', { 'X-OAuth-Scopes': 'repo, workflow' });
  const r = await verifyToken(f, 'ghp_x');
  assert.equal(r.ok, true);
  assert.equal(r.login, 'octocat');
  assert.equal(r.scopes, 'repo, workflow');
});

test('verifyToken: 失败时给出人话提示', async () => {
  const f: Fetcher = async () => resp(401, '{"message":"Bad credentials"}');
  const r = await verifyToken(f, 'bad');
  assert.equal(r.ok, false);
  assert.ok(r.message.indexOf('401') >= 0);
});

test('verifyToken: 响应头大小写不敏感', async () => {
  const f: Fetcher = async () => resp(200, '{"login":"a"}', { 'x-oauth-scopes': 'repo' });
  assert.equal((await verifyToken(f, 't')).scopes, 'repo');
});
