import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from './srcScan';
import {
  expandCapability, satisfiesOne, missingCapabilities, satisfies, pickFor,
  needsOf, NODE_NEEDS, kindForNeed, detectGithubCapabilities, scopeHintFor,
  makeCredential, redactCredential, redactCredentials, findCredential,
  resolveSecret, danglingCredentialId, type Capability,
} from '../engine/credentials';

/* ---------- 能力蕴含 ---------- */

test('蕴含: github:write 展开含 github:read', () => {
  const ex = expandCapability('github:write');
  assert.ok(ex.indexOf('github:write') >= 0);
  assert.ok(ex.indexOf('github:read') >= 0);
});

test('蕴含: github:read 不展开出 write', () => {
  assert.deepEqual(expandCapability('github:read'), ['github:read']);
});

test('蕴含: llm:vision 与 llm:chat 互不蕴含', () => {
  assert.ok(expandCapability('llm:vision').indexOf('llm:chat') < 0);
  assert.ok(expandCapability('llm:chat').indexOf('llm:vision') < 0);
});

test('satisfiesOne: 有 write 即满足 read', () => {
  assert.equal(satisfiesOne(['github:write'], 'github:read'), true);
});

test('satisfiesOne: 只有 read 不满足 write', () => {
  assert.equal(satisfiesOne(['github:read'], 'github:write'), false);
});

test('missingCapabilities: 返回缺失项', () => {
  assert.deepEqual(missingCapabilities(['github:read'], ['github:read', 'github:write']), ['github:write']);
});

test('missingCapabilities: 全满足时为空', () => {
  assert.deepEqual(missingCapabilities(['github:write'], ['github:read', 'github:write']), []);
});

/* ---------- 节点需求 ---------- */

test('需求: 推送节点要 github:write', () => {
  assert.deepEqual(needsOf('github-push'), ['github:write']);
});

test('需求: 更新节点只要 github:read', () => {
  assert.deepEqual(needsOf('github-update'), ['github:read']);
});

test('需求: OCR 要视觉能力，翻译要对话能力', () => {
  assert.deepEqual(needsOf('ocr'), ['llm:vision']);
  assert.deepEqual(needsOf('translate'), ['llm:chat']);
});

test('需求: 未知节点不报错，返回空', () => {
  assert.deepEqual(needsOf('task'), []);
});

test('需求: 凭据类型推导', () => {
  assert.equal(kindForNeed(['github:write']), 'github');
  assert.equal(kindForNeed(['llm:chat']), 'llm');
  assert.equal(kindForNeed([]), null);
});

/* ---------- 按需求筛选凭据 ---------- */

const C = (id: string, caps: Capability[]) =>
  makeCredential({ id, name: id, kind: 'github', secret: 'k-' + id, capabilities: caps });

test('pickFor: 只读凭据不满足推送节点', () => {
  const list = [C('a', ['github:read']), C('b', ['github:write'])];
  assert.deepEqual(pickFor(list, needsOf('github-push')).map((c) => c.id), ['b']);
});

test('pickFor: 读写凭据能同时满足两个节点（共享一把 key）', () => {
  const list = [C('full', ['github:write'])];
  assert.deepEqual(pickFor(list, needsOf('github-update')).map((c) => c.id), ['full']);
  assert.deepEqual(pickFor(list, needsOf('github-push')).map((c) => c.id), ['full']);
});

test('pickFor: 能力为空的凭据谁都不满足', () => {
  assert.deepEqual(pickFor([C('none', [])], needsOf('github-update')), []);
});

test('satisfies: 跨类型不匹配（llm 凭据不能推送）', () => {
  const llm = makeCredential({ id: 'l', kind: 'llm', secret: 'sk', capabilities: ['llm:chat'] });
  assert.equal(satisfies(llm, needsOf('github-push')), false);
});

/* ---------- GitHub 能力推导 ---------- */

test('推导: repo scope 同时给读写', () => {
  const r = detectGithubCapabilities('repo, workflow', true);
  assert.deepEqual(r.capabilities, ['github:read', 'github:write']);
  assert.equal(r.ambiguous, false);
});

test('推导: public_repo 也给读写', () => {
  const r = detectGithubCapabilities('public_repo', true);
  assert.deepEqual(r.capabilities, ['github:read', 'github:write']);
});

test('推导: 无关 scope 只给读', () => {
  const r = detectGithubCapabilities('read:org, gist', true);
  assert.deepEqual(r.capabilities, ['github:read']);
});

test('推导: 无 scope 头视为 fine-grained，保守只读并标 ambiguous', () => {
  const r = detectGithubCapabilities(null, true);
  assert.deepEqual(r.capabilities, ['github:read']);
  assert.equal(r.ambiguous, true, '应标记为无法自动判定');
});

test('推导: header 存在但为空同样标 ambiguous', () => {
  const r = detectGithubCapabilities('', true);
  assert.equal(r.ambiguous, true);
});

test('推导: 请求失败时不给任何能力', () => {
  const r = detectGithubCapabilities('repo', false);
  assert.deepEqual(r.capabilities, []);
});

test('推导: 无 scope 头 + 请求失败 → 无能力（不能因为 fine-grained 就放行）', () => {
  const r = detectGithubCapabilities(null, false);
  assert.deepEqual(r.capabilities, []);
});

test('提示: 写权限不足时给出具体 scope 建议', () => {
  assert.ok(scopeHintFor(['github:write']).indexOf('repo') >= 0);
});

/* ---------- 脱敏 ---------- */

test('脱敏: 密钥被清空', () => {
  const c = C('a', ['github:read']);
  assert.equal(redactCredential(c).secret, '');
});

test('脱敏: 能力明细与身份也不外泄', () => {
  const c = makeCredential({
    id: 'a', name: 'A', kind: 'github', secret: 'ghp_x',
    capabilities: ['github:write'], identity: 'octocat', note: '我的',
  });
  const r = redactCredential(c);
  assert.deepEqual(r.capabilities, []);
  assert.equal(r.identity, undefined);
  assert.equal(r.note, undefined);
});

test('脱敏: 保留 id 与 name（导出后仍能看出引用了哪条）', () => {
  const c = C('keep', ['github:read']);
  const r = redactCredential(c);
  assert.equal(r.id, 'keep');
  assert.equal(r.name, 'keep');
});

test('脱敏: 批量处理', () => {
  const rs = redactCredentials([C('a', []), C('b', [])]);
  assert.equal(rs.length, 2);
  assert.ok(rs.every((c) => c.secret === ''));
});

/* ---------- 查找与解析 ---------- */

test('findCredential: 找到返回凭据', () => {
  const l = [C('a', []), C('b', [])];
  assert.equal((findCredential(l, 'b') as { id: string }).id, 'b');
});

test('findCredential: 找不到返回 null（不是抛异常）', () => {
  assert.equal(findCredential([C('a', [])], 'zzz'), null);
});

test('findCredential: id 为空返回 null', () => {
  assert.equal(findCredential([C('a', [])], undefined), null);
});

test('resolveSecret: 优先用凭据里的密钥（多个节点共享）', () => {
  const l = [C('shared', ['github:read'])];
  assert.equal(resolveSecret(l, 'shared', 'inline-old'), 'k-shared');
});

test('resolveSecret: 凭据不存在时退回内联值（兼容旧画布）', () => {
  assert.equal(resolveSecret([], 'gone', 'inline-old'), 'inline-old');
});

test('resolveSecret: 都没配时空串', () => {
  assert.equal(resolveSecret([], undefined, undefined), '');
});

test('makeCredential: 未指定 id 时自动生成且不重复', () => {
  const a = makeCredential({ name: 'x' });
  const b = makeCredential({ name: 'y' });
  assert.notEqual(a.id, b.id);
});

test('注册表: 每个登记的能力都是合法 Capability', () => {
  const all: Capability[] = ['github:read', 'github:write', 'llm:chat', 'llm:vision'];
  for (const k of Object.keys(NODE_NEEDS)) {
    for (const c of NODE_NEEDS[k]) {
      assert.ok(all.indexOf(c) >= 0, `${k} 登记了未知能力 ${c}`);
    }
  }
});

/* ---------- 密钥的 trim ---------- */

/*
 * ⛔ 密钥是复制粘贴来的，尾巴带换行太常见。
 * 不 trim 会原样进 Authorization 头 —— 带换行的头让请求在网络层直接失败，
 * 报错跟"多复制了一个换行"差了十万八千里。
 */
test('密钥: 带首尾空白要 trim（否则 Authorization 头里带换行）', () => {
  const c = makeCredential({ name: 'x', secret: '  sk-real\n' });
  assert.equal(resolveSecret([c], c.id, ''), 'sk-real');
  assert.ok(!/[\r\n]/.test(resolveSecret([c], c.id, '')));
});

test('密钥: 全空白算"没填"（否则设出 `Bearer ` 加三个空格）', () => {
  const c = makeCredential({ name: 'x', secret: '   ' });
  assert.equal(resolveSecret([c], c.id, ''), '', '三个空格是 truthy —— 不 trim 会设出假 Authorization 头');
});

test('密钥: 内联值也要 trim（反例，别只 trim 连接那一份）', () => {
  assert.equal(resolveSecret([], undefined, ' sk-old\n'), 'sk-old');
});

test('密钥: 悬空 id + 有内联 → 用内联（反例，别把兜底弄丢）', () => {
  assert.equal(resolveSecret([], 'gone', 'sk-inline'), 'sk-inline');
});

/* ---------- 连接没了 ---------- */

test('连接没了: 填了 id 却找不到 → 判为悬空', () => {
  const c = makeCredential({ name: 'x', secret: 'sk' });
  assert.equal(danglingCredentialId([], 'gone'), true);
  assert.equal(danglingCredentialId([c], c.id), false, '找得到就不算');
});

/*
 * 反例：压根没选连接是**合法**的 —— 公开接口不需要令牌。
 * 把这种也算成悬空，会让所有公开接口节点跑不了。
 */
test('连接没了: 没选连接不算悬空（公开接口不需要令牌）', () => {
  assert.equal(danglingCredentialId([], undefined), false);
  assert.equal(danglingCredentialId([], ''), false);
  assert.equal(danglingCredentialId([], '   '), false, '纯空白的 id 等于没填');
});

/* ---------- 源码守卫 ---------- */

/*
 * 通用 HTTP 节点的连接没了 → 令牌为空 → 请求不带凭据照发 → 401。
 * 而 401 的排查方向是"令牌对不对"，跟"连接被删了"差了十万八千里。
 */
test('源码守卫: genericHttp 必须拦悬空连接', () => {
  const src = readSrc('engine/runners/genericHttp.ts');
  assert.ok(/danglingCredentialId\s*\(/.test(src),
    'genericHttp 没拦悬空连接 —— 会不带凭据发请求，报 401');
});
