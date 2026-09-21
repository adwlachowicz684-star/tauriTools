import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webCryptoBackend } from '../engine/crypto';
import {
  sealSecrets, unsealSecrets,
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

test('升级: 明文存档读回后重新落盘即变密文', async () => {
  const legacy = JSON.stringify({ n1: SECRET });
  const r = await unsealSecrets(be, legacy, PASS);
  assert.equal(r.legacyPlaintext, true);

  const rewritten = await sealSecrets(be, r.keys, PASS);
  assert.equal(rewritten.includes(SECRET), false);
  assert.equal((await unsealSecrets(be, rewritten, PASS)).legacyPlaintext, false);
  assert.deepEqual((await unsealSecrets(be, rewritten, PASS)).keys, { n1: SECRET });
});

/*
 * 明文识别改由 unsealSecrets 的 legacyPlaintext 承担 ——
 * 它才是 App 真正用于提示"检测到旧版明文密钥"的字段。
 */
test('明文存档：legacyPlaintext 为 true，且密钥读得出来', async () => {
  const r = await unsealSecrets(be, JSON.stringify({ n1: SECRET }), 'pw');
  assert.equal(r.legacyPlaintext, true);
  assert.equal(r.keys.n1, SECRET);
  assert.equal(r.failed, false);
});

test('密文包：legacyPlaintext 为 false', async () => {
  const raw = await sealSecrets(be, { n1: SECRET }, 'pw');
  const r = await unsealSecrets(be, raw, 'pw');
  assert.equal(r.legacyPlaintext, false);
  assert.equal(r.keys.n1, SECRET);
});

/*
 * 「没存过」与「存了但坏了」要分开：
 *   null / ''  → 首次使用，不是错误（failed: false），不该弹警告
 *   '{}'       → 解析成功但内容为空，也不是错误
 *   'not-json' → 真坏了，必须标记 failed，不能静默给空
 * 混为一谈的话，新用户一打开就会看到"密钥读取失败"。
 */
test('没存过（null / 空串）不算失败', async () => {
  for (const raw of [null, '']) {
    const r = await unsealSecrets(be, raw, PASS);
    assert.equal(r.failed, false, `输入 ${JSON.stringify(raw)} 是首次使用，不该报失败`);
    assert.equal(r.legacyPlaintext, false);
    assert.deepEqual(r.keys, {});
  }
});

test('内容为空的存档也不算失败', async () => {
  const r = await unsealSecrets(be, '{}', PASS);
  assert.equal(r.failed, false);
  assert.equal(r.legacyPlaintext, false);
});

test('存档损坏（非 JSON）要标记 failed，不能静默给空', async () => {
  const r = await unsealSecrets(be, 'not-json', PASS);
  assert.equal(r.failed, true);
  assert.equal(r.legacyPlaintext, false);
  assert.deepEqual(r.keys, {});
});
