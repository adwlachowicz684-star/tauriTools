import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webCryptoBackend } from '../engine/crypto';
import {
  sealSecrets, unsealSecrets, isPlaintextVault,
} from '../engine/secretVault';

const be = webCryptoBackend();
const PASS = 'device-seed-abc123';
const SECRET = 'sk-live-THIS-SHOULD-NEVER-APPEAR-ON-DISK';

/* ---------- 落盘（加密） ---------- */

test('seal: 没有密钥时不写盘（返回空串）', async () => {
  assert.equal(await sealSecrets(be, {}, PASS), '');
});

test('seal: 空字符串密钥被过滤，非空保留', async () => {
  const raw = await sealSecrets(be, { n1: '', n2: 'k2' }, PASS);
  const r = await unsealSecrets(be, raw, PASS);
  assert.deepEqual(r.keys, { n2: 'k2' });
});

test('A3: 落盘内容里搜不到明文密钥', async () => {
  const raw = await sealSecrets(be, { n1: SECRET }, PASS);
  assert.equal(raw.includes(SECRET), false, '密钥不能明文出现在存储里');
  // 也不该出现在任何可打印片段里（防止分段拼接后被 grep 到）
  assert.equal(raw.includes('sk-live'), false);
});

test('seal: 同一份密钥两次加密结果不同（IV / salt 每次都换）', async () => {
  const a = await sealSecrets(be, { n1: SECRET }, PASS);
  const b = await sealSecrets(be, { n1: SECRET }, PASS);
  assert.notEqual(a, b, 'GCM 下重用 IV 会泄露明文关系');
});

/* ---------- 读回 ---------- */

test('unseal: 往返一致', async () => {
  const raw = await sealSecrets(be, { n1: SECRET, n2: 'k2' }, PASS);
  const r = await unsealSecrets(be, raw, PASS);
  assert.deepEqual(r.keys, { n1: SECRET, n2: 'k2' });
  assert.equal(r.failed, false);
  assert.equal(r.legacyPlaintext, false);
});

test('unseal: 空 / null 都是空结果，不算失败', async () => {
  assert.deepEqual(await unsealSecrets(be, null, PASS), { keys: {}, legacyPlaintext: false, failed: false });
  assert.deepEqual(await unsealSecrets(be, '', PASS), { keys: {}, legacyPlaintext: false, failed: false });
});

test('unseal: 非 JSON 视为失败（不静默当空）', async () => {
  const r = await unsealSecrets(be, 'not-json', PASS);
  assert.equal(r.failed, true);
  assert.deepEqual(r.keys, {});
});

test('unseal: 口令不对时失败，而不是返回空了事', async () => {
  const raw = await sealSecrets(be, { n1: SECRET }, PASS);
  const r = await unsealSecrets(be, raw, 'another-device-seed');
  assert.equal(r.failed, true, '解不开必须报出来，静默给空会让人以为密钥丢了');
  assert.deepEqual(r.keys, {});
});

test('unseal: 密文被篡改时失败（GCM 完整性）', async () => {
  const raw = await sealSecrets(be, { n1: SECRET }, PASS);
  const p = JSON.parse(raw);
  p.data = p.data.slice(0, -4) + 'AAAA';
  const r = await unsealSecrets(be, JSON.stringify(p), PASS);
  assert.equal(r.failed, true);
});

/* ---------- 旧版明文兼容 ---------- */

test('unseal: 旧版明文存档原样读出，并标记 legacy', async () => {
  const legacy = JSON.stringify({ n1: SECRET });
  const r = await unsealSecrets(be, legacy, PASS);
  assert.deepEqual(r.keys, { n1: SECRET }, '老用户的密钥不能因为升级就没了');
  assert.equal(r.legacyPlaintext, true);
  assert.equal(r.failed, false);
});

test('unseal: 空的明文存档不算 legacy', async () => {
  const r = await unsealSecrets(be, '{}', PASS);
  assert.equal(r.legacyPlaintext, false);
});

test('unseal: 数组不是合法存档', async () => {
  const r = await unsealSecrets(be, '["a","b"]', PASS);
  assert.equal(r.failed, true);
});

/* ---------- 明文识别 ---------- */

test('isPlaintextVault: 明文存档认得出来', () => {
  assert.equal(isPlaintextVault(JSON.stringify({ n1: SECRET })), true);
});

test('isPlaintextVault: 密文包不算明文', async () => {
  const raw = await sealSecrets(be, { n1: SECRET }, PASS);
  assert.equal(isPlaintextVault(raw), false);
});

test('isPlaintextVault: 空 / 非法都不算明文', () => {
  assert.equal(isPlaintextVault(null), false);
  assert.equal(isPlaintextVault(''), false);
  assert.equal(isPlaintextVault('{}'), false);
  assert.equal(isPlaintextVault('not-json'), false);
});

/* ---------- 升级路径 ---------- */

test('升级: 明文存档读回后重新落盘即变密文', async () => {
  const legacy = JSON.stringify({ n1: SECRET });
  const r = await unsealSecrets(be, legacy, PASS);
  assert.equal(r.legacyPlaintext, true);

  const rewritten = await sealSecrets(be, r.keys, PASS);
  assert.equal(rewritten.includes(SECRET), false);
  assert.equal(isPlaintextVault(rewritten), false);
  assert.deepEqual((await unsealSecrets(be, rewritten, PASS)).keys, { n1: SECRET });
});
