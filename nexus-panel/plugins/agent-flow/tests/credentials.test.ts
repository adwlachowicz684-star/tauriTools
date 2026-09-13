import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandCapability, satisfiesOne, missingCapabilities, satisfies, pickFor,
  needsOf, NODE_NEEDS, kindForNeed, detectGithubCapabilities, scopeHintFor,
  makeCredential, redactCredential, redactCredentials, findCredential,
  resolveSecret, type Capability,
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
