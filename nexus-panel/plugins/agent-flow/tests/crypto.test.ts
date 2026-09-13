import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToB64, b64ToBytes, isCipherBundle, secretKind, deviceSeed,
  encryptString, decryptString, deriveKey, webCryptoBackend,
  CIPHER_VERSION, CIPHER_ALG, IV_BYTES, PBKDF2_ITER,
} from '../engine/crypto';
import {
  parseStore, serializeStore, encryptStore, decryptStore, emptyStore,
  newDeviceSalt, migratePlaintext, STORE_VERSION,
} from '../engine/credentialStore';

const be = webCryptoBackend();
const PASS = 'device-seed-abc123';

/* ---------- base64 ---------- */

test('base64: 空数组', () => {
  assert.equal(bytesToB64(new Uint8Array(0)), '');
});

test('base64: 往返一致（含 0 / 255 边界）', () => {
  const a = new Uint8Array([0, 1, 127, 128, 254, 255]);
  assert.deepEqual(Array.from(b64ToBytes(bytesToB64(a))), Array.from(a));
});

test('base64: 长度 1/2/3 的填充都正确', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const a = new Uint8Array(n).fill(200);
    assert.deepEqual(Array.from(b64ToBytes(bytesToB64(a))), Array.from(a), `长度 ${n}`);
  }
});

test('base64: 256 字节全字符集往返', () => {
  const a = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) a[i] = i;
  assert.deepEqual(Array.from(b64ToBytes(bytesToB64(a))), Array.from(a));
});

test('base64: 与标准实现一致', () => {
  assert.equal(bytesToB64(new TextEncoder().encode('hello')), Buffer.from('hello').toString('base64'));
});

/* ---------- 识别 ---------- */

test('识别: 完整的密文包', () => {
  assert.equal(isCipherBundle({
    v: 1, alg: 'AES-GCM', iter: 1, salt: 'a', iv: 'b', data: 'c',
  }), true);
});

test('识别: 缺字段不算', () => {
  assert.equal(isCipherBundle({ v: 1, alg: 'AES-GCM' }), false);
});

test('识别: null / 字符串都不算', () => {
  assert.equal(isCipherBundle(null), false);
  assert.equal(isCipherBundle('ghp_xxx'), false);
});

test('secretKind: 明文字符串 → plain', () => {
  assert.equal(secretKind('ghp_abc'), 'plain');
});

test('secretKind: 空串 → empty', () => {
  assert.equal(secretKind(''), 'empty');
});

test('secretKind: undefined → empty', () => {
  assert.equal(secretKind(undefined), 'empty');
});

test('secretKind: 密文包 → cipher', () => {
  assert.equal(secretKind({ v: 1, alg: 'AES-GCM', iter: 1, salt: 'a', iv: 'b', data: 'c' }), 'cipher');
});

/* ---------- 本机特征 ---------- */

test('本机特征: 拼接所有信号', () => {
  const s = deviceSeed({ userAgent: 'UA', language: 'zh', timezone: 'CST', screen: '1920x1080', cores: 8, deviceSalt: 'SALT' });
  assert.equal(s, 'UA|zh|CST|1920x1080|8|SALT');
});

test('本机特征: 缺字段填空，不报错', () => {
  assert.equal(deviceSeed({}), '||||0|');
});

test('本机特征: 设备盐不同则结果不同', () => {
  const a = deviceSeed({ userAgent: 'U', deviceSalt: 'A' });
  const b = deviceSeed({ userAgent: 'U', deviceSalt: 'B' });
  assert.notEqual(a, b);
});

/* ---------- 加解密（真实 AES-GCM）---------- */

test('加解密: 往返一致', async () => {
  const b = await encryptString(be, 'ghp_secretToken123', PASS);
  assert.equal(await decryptString(be, b, PASS), 'ghp_secretToken123');
});

test('加解密: 产出的是合法密文包', async () => {
  const b = await encryptString(be, 'x', PASS);
  assert.equal(b.v, CIPHER_VERSION);
  assert.equal(b.alg, CIPHER_ALG);
  assert.equal(b.iter, PBKDF2_ITER);
  assert.equal(isCipherBundle(b), true);
});

test('加解密: 密文里不含明文（这是本模块存在的意义）', async () => {
  const secret = 'ghp_SuperSecretValue98765';
  const b = await encryptString(be, secret, PASS);
  const dump = JSON.stringify(b);
  assert.equal(dump.includes(secret), false, '序列化后不应能搜到明文');
});

test('加解密: 同样的明文两次加密结果不同（IV 与 salt 都换）', async () => {
  const a = await encryptString(be, 'same', PASS);
  const b = await encryptString(be, 'same', PASS);
  assert.notEqual(a.iv, b.iv, 'IV 每次必须不同');
  assert.notEqual(a.salt, b.salt, 'salt 每次必须不同');
  assert.notEqual(a.data, b.data);
});

test('加解密: 口令错误时抛异常（不能静默返回空串）', async () => {
  const b = await encryptString(be, 'secret', PASS);
  await assert.rejects(() => decryptString(be, b, 'wrong-pass'), '错误口令应解密失败');
});

test('加解密: 密文被篡改时抛异常（GCM 完整性校验）', async () => {
  const b = await encryptString(be, 'secret', PASS);
  const raw = b64ToBytes(b.data);
  raw[0] = raw[0] ^ 0xff;
  const bad = { ...b, data: bytesToB64(raw) };
  await assert.rejects(() => decryptString(be, bad, PASS), '篡改应被 GCM 检出');
});

test('加解密: IV 长度符合 GCM 标准（12 字节）', async () => {
  const b = await encryptString(be, 'x', PASS);
  assert.equal(b64ToBytes(b.iv).length, IV_BYTES);
});

test('加解密: 中文内容往返', async () => {
  const b = await encryptString(be, '密钥内容-你好', PASS);
  assert.equal(await decryptString(be, b, PASS), '密钥内容-你好');
});

test('加解密: 空串往返', async () => {
  const b = await encryptString(be, '', PASS);
  assert.equal(await decryptString(be, b, PASS), '');
});

test('加解密: 超长内容往返（4KB）', async () => {
  const big = 'x'.repeat(4096);
  const b = await encryptString(be, big, PASS);
  assert.equal(await decryptString(be, b, PASS), big);
});

test('派生: 同样的输入得到同样的密钥', async () => {
  const salt = be.randomBytes(16);
  const a = await deriveKey(be, 'p', salt, 1000);
  const b = await deriveKey(be, 'p', salt, 1000);
  assert.equal(bytesToB64(a), bytesToB64(b));
});

test('派生: 盐不同则密钥不同', async () => {
  const a = await deriveKey(be, 'p', be.randomBytes(16), 1000);
  const b = await deriveKey(be, 'p', be.randomBytes(16), 1000);
  assert.notEqual(bytesToB64(a), bytesToB64(b));
});

test('派生: 迭代次数影响结果', async () => {
  const salt = be.randomBytes(16);
  const a = await deriveKey(be, 'p', salt, 1000);
  const b = await deriveKey(be, 'p', salt, 2000);
  assert.notEqual(bytesToB64(a), bytesToB64(b));
});

/* ---------- 存储层 ---------- */

const cred = (id: string, secret: string) => ({
  id, name: id, kind: 'github' as const, secret,
  capabilities: ['github:read' as const], createdAt: 1,
});

test('存储: 空文件解析出空结构', () => {
  const f = parseStore(null);
  assert.equal(f.credentials.length, 0);
  assert.equal(f.v, STORE_VERSION);
});

test('存储: 非法 JSON 不抛异常', () => {
  assert.equal(parseStore('{broken').credentials.length, 0);
});

test('存储: 非对象输入不崩', () => {
  assert.equal(parseStore('"just a string"').credentials.length, 0);
});

test('存储: 缺失字段自动补齐', () => {
  const f = parseStore(JSON.stringify({ credentials: [{ id: 'a' }] }));
  assert.equal(f.credentials[0].id, 'a');
  assert.equal(f.credentials[0].kind, 'generic');
  assert.equal(f.credentials[0].name, '凭据 1');
  assert.deepEqual(f.credentials[0].capabilities, []);
});

test('存储: 往返后密钥可还原，且落盘内容是密文', async () => {
  const file = emptyStore('SALT');
  const enc = await encryptStore(be, file, [cred('a', 'ghp_plain123')], PASS);
  const dumped = serializeStore(enc);
  assert.equal(dumped.includes('ghp_plain123'), false, '落盘不应含明文');

  const back = await decryptStore(be, parseStore(dumped), PASS);
  assert.equal(back.credentials[0].secret, 'ghp_plain123');
  assert.equal(back.failed.length, 0);
});

test('存储: 空密钥不加密（没东西可保护）', async () => {
  const enc = await encryptStore(be, emptyStore('S'), [cred('a', '')], PASS);
  assert.equal(enc.credentials[0].secret, '');
});

test('存储: 口令错误时该条留空并记入 failed，不整批失败', async () => {
  const enc = await encryptStore(be, emptyStore('S'), [
    cred('a', 'secret-a'), cred('b', 'secret-b'),
  ], PASS);
  const back = await decryptStore(be, enc, 'wrong');
  assert.equal(back.credentials.length, 2, '两条都还在');
  assert.deepEqual(back.failed, ['a', 'b']);
  assert.equal(back.credentials[0].secret, '');
});

test('存储: 只有一条坏掉时，其它条照常可用', async () => {
  const enc = await encryptStore(be, emptyStore('S'), [cred('ok', 'good')], PASS);
  // 手工塞一条损坏记录
  const broken = {
    ...enc,
    credentials: [
      ...enc.credentials,
      { id: 'bad', name: 'bad', kind: 'github', secret: { v: 1, alg: 'AES-GCM', iter: 1, salt: 'eA', iv: 'eA', data: 'eA' }, capabilities: [], createdAt: 1 },
    ],
  };
  const back = await decryptStore(be, broken, PASS);
  assert.equal(back.credentials[0].secret, 'good');
  assert.deepEqual(back.failed, ['bad']);
});

test('存储: 多条凭据互不串味', async () => {
  const enc = await encryptStore(be, emptyStore('S'), [
    cred('a', 'key-aaa'), cred('b', 'key-bbb'), cred('c', 'key-ccc'),
  ], PASS);
  const back = await decryptStore(be, enc, PASS);
  assert.deepEqual(back.credentials.map((c) => c.secret), ['key-aaa', 'key-bbb', 'key-ccc']);
});

/* ---------- 迁移 ---------- */

test('迁移: 明文密钥被识别并写回待加密', async () => {
  const target = [cred('a', '')];
  const r = await migratePlaintext(be, [{ id: 'a', secret: 'ghp_old' }], PASS, target);
  assert.equal(r.found, 1);
  assert.equal(r.done, 1);
  assert.equal(target[0].secret, 'ghp_old', '应写回以便 encryptStore 加密');
});

test('迁移: 空密钥跳过', async () => {
  const r = await migratePlaintext(be, [{ id: 'a', secret: '' }], PASS, [cred('a', '')]);
  assert.equal(r.found, 0);
});

test('迁移: 已是密文的跳过（不重复加密）', async () => {
  const bundle = await encryptString(be, 'x', PASS);
  const r = await migratePlaintext(be, [{ id: 'a', secret: bundle }], PASS, [cred('a', '')]);
  assert.equal(r.found, 0, '密文不该被当成明文再处理一次');
});

test('迁移: 找不到对应 id 时计 found 但不计 done', async () => {
  const r = await migratePlaintext(be, [{ id: 'gone', secret: 'x' }], PASS, []);
  assert.equal(r.found, 1);
  assert.equal(r.done, 0);
});

test('迁移: 迁移后落盘是密文且能还原', async () => {
  const target = [cred('a', '')];
  await migratePlaintext(be, [{ id: 'a', secret: 'ghp_legacy' }], PASS, target);
  const enc = await encryptStore(be, emptyStore('S'), target, PASS);
  const dumped = serializeStore(enc);
  assert.equal(dumped.includes('ghp_legacy'), false);
  const back = await decryptStore(be, parseStore(dumped), PASS);
  assert.equal(back.credentials[0].secret, 'ghp_legacy');
});

/* ---------- 设备盐 ---------- */

test('设备盐: 每次不同', () => {
  assert.notEqual(newDeviceSalt(be), newDeviceSalt(be));
});

test('设备盐: 长度符合 16 字节', () => {
  assert.equal(b64ToBytes(newDeviceSalt(be)).length, 16);
});
