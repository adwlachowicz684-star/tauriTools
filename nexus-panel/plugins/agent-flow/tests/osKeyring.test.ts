import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OS_KEYRING_KEY_BYTES,
  toOsKeyringRead,
  newOsKeyringKey,
  planOsKeyringStart,
  judgeOsKeyringWrite,
} from '../engine/osKeyring';

/**
 * 主密钥放进 OS 凭据管理器。
 *
 * 这块最怕的不是出错，是**静默出错**：
 *   · 管理器不可用 → 静默退回设备特征派生 → 用户以为受 OS 保护，实际没有
 *   · 写入没存住   → 照样拿它加密     → 凭据永久解不开（数据丢失）
 * 两者都不报错，所以必须逐条盯住。
 */

/* ---------------- 读取结果归一 ---------------- */

test('读到字符串 → use', () => {
  const r = toOsKeyringRead('abc123');
  assert.deepEqual(planOsKeyringStart(r), { action: 'use', key: 'abc123' });
});

test('null / undefined 当"没有这条"，不是错误', () => {
  assert.deepEqual(toOsKeyringRead(null), { ok: true, value: null });
  assert.deepEqual(toOsKeyringRead(undefined), { ok: true, value: null });
  assert.deepEqual(planOsKeyringStart(toOsKeyringRead(null)).action, 'create');
});

test('空串当"没有这条"（有些后端这样表示不存在）', () => {
  /*
   * 不当成空密钥去解密 ——
   * 那会得到一个"口令不对"的错，而真正的处理是"新建一条"。
   */
  assert.deepEqual(toOsKeyringRead(''), { ok: true, value: null });
  assert.deepEqual(toOsKeyringRead('   '), { ok: true, value: null });
});

test('非字符串 → 判为不可用（不乱猜）', () => {
  const r = toOsKeyringRead({ v: 1 });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /非字符串/);
});

/* ---------------- 不可用时绝不静默 ---------------- */

test('读失败 → unavailable 并带上原因（不是退回 auto）', () => {
  const plan = planOsKeyringStart({ ok: false, reason: 'Secret Service 不可用' });
  assert.equal(plan.action, 'unavailable');
  assert.match((plan as { reason: string }).reason, /Secret Service/);
});

/*
 * 这条是整个模块的要点：
 * 静默降级会让用户以为在用 OS 保护，实际还是设备特征派生 ——
 * 假的安全感比没有更糟。
 */
test('不可用时不会产出任何可用密钥', () => {
  const plans = [
    planOsKeyringStart({ ok: false, reason: 'x' }),
    planOsKeyringStart({ ok: false, reason: 'y' }),
  ];
  for (const p of plans) {
    assert.equal(p.action, 'unavailable');
    assert.ok(!('key' in p) || !(p as { key?: string }).key);
  }
});

/* ---------------- 生成主密钥 ---------------- */

test('生成的密钥是 32 字节的 hex', () => {
  const key = newOsKeyringKey((n) => new Uint8Array(n).fill(7));
  assert.equal(key.length, OS_KEYRING_KEY_BYTES * 2);
  assert.match(key, /^[0-9a-f]+$/);
});

test('两次生成不一样（必须真随机，不能是派生的）', () => {
  /*
   * 派生的等于把钥匙又放回机器里 —— 拷走目录照样能复现，白做。
   */
  let seq = 0;
  const rand = (n: number) => {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) { a[i] = (seq + i) % 256; seq += 1; }
    return a;
  };
  assert.notEqual(newOsKeyringKey(rand), newOsKeyringKey(rand));
});

test('单字节要补零（7 写成 07，不是 7）', () => {
  const key = newOsKeyringKey((n) => new Uint8Array(n).fill(7));
  assert.equal(key, '07'.repeat(OS_KEYRING_KEY_BYTES));
  assert.ok(!/[^0-9a-f]/.test(key));
});

/* ---------------- 写后回读 ---------------- */

test('回读一致 → 通过', () => {
  const r = judgeOsKeyringWrite({ ok: true, value: 'KEY' }, 'KEY');
  assert.deepEqual(r, { ok: true });
});

test('回读为空 → 失败（没真存住）', () => {
  /*
   * Linux 上钥匙串锁着时会接受写入但读不出来。
   * 此时若照样加密，下次再也解不开 —— 数据丢失。
   */
  const r = judgeOsKeyringWrite({ ok: true, value: null }, 'KEY');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /没有真正存住|回读为空/);
});

test('回读失败 → 失败', () => {
  const r = judgeOsKeyringWrite({ ok: false, reason: '读不了' }, 'KEY');
  assert.equal(r.ok, false);
});

test('回读到别的值 → 失败（不能被转义或截断）', () => {
  const r = judgeOsKeyringWrite({ ok: true, value: 'KE' }, 'KEY');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /不一致/);
});

/* ---------------- 存档里的 mode 必须被认出来 ---------------- */

/*
 * 这条是"新增第三种模式"最容易漏的一处：
 * parseStore 以前只判 passphrase，其余一律 auto。
 * 加了 oskeyring 不补这里的话 ——
 * 存的是 oskeyring、读回来变 auto，
 * 于是拿**设备特征**去解用 OS 密钥加密的数据，
 * 一条都解不开，且界面上没有任何提示。
 */
test('存档里的 oskeyring 不会被读成 auto', async () => {
  const { parseStore, serializeStore, emptyStore } = await import('../engine/credentialStore');
  const s = serializeStore({ ...emptyStore('salt', 'oskeyring') });
  assert.equal(parseStore(s).mode, 'oskeyring');
});

test('老的两种模式不受影响', async () => {
  const { parseStore, serializeStore, emptyStore } = await import('../engine/credentialStore');
  assert.equal(parseStore(serializeStore({ ...emptyStore('s', 'auto') })).mode, 'auto');
  assert.equal(parseStore(serializeStore({ ...emptyStore('s', 'passphrase') })).mode, 'passphrase');
});

test('不认识的 mode 退回 auto（不为未知值造出第三种状态）', async () => {
  const { parseStore } = await import('../engine/credentialStore');
  assert.equal(parseStore(JSON.stringify({ v: 1, mode: 'weird', credentials: [] })).mode, 'auto');
});

/* ---------------- 源码守卫 ---------------- */

test('三种模式的文案都写清了"防不住什么"', async () => {
  const { VAULT_MODE_META } = await import('../types');
  const keys = Object.keys(VAULT_MODE_META);
  assert.deepEqual(keys.sort(), ['auto', 'oskeyring', 'passphrase']);
  for (const k of keys) {
    const v = (VAULT_MODE_META as never as Record<string, { hint: string }>)[k];
    assert.ok(v.hint && v.hint.length > 20, `${k} 要有实质说明`);
  }
  /*
   * 每种都得点出它的**局限**，不能只说"更安全" ——
   * 只说优点会让人以为是无敌的。
   */
  assert.match(VAULT_MODE_META.auto.hint, /拷走|离线|仍/);
  assert.match(VAULT_MODE_META.oskeyring.hint, /仍|能登录/);
  assert.match(VAULT_MODE_META.passphrase.hint, /每次|忘/);
});

test('面板是三选一，不是"切换"按钮', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ROOT = process.env.AF_SRC ?? path.resolve(__dirname, '..');
  const f = fs.readFileSync(path.join(ROOT, 'components/CredentialPanel.tsx'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  /*
   * 匹配"遍历 VAULT_MODE_META 渲染按钮" ——
   * 只查"文件里有 VAULT_MODE_META"的话，
   * import 语句里也有，把三选一改回单按钮照样通过。
   */
  assert.ok(
    /Object\.keys\(VAULT_MODE_META\)/.test(f),
    '要遍历三种模式渲染，写死单个切换按钮看不出一共有几种',
  );
});

test('离开 OS 凭据管理器时要删掉那条记录', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ROOT = process.env.AF_SRC ?? path.resolve(__dirname, '..');
  const f = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  /*
   * 留着等于在数据目录之外又留了一把能解开旧密文的钥匙，
   * 而用户以为已经换掉了。
   *
   * 只查"文件里有 osKeyringDelete 这个词"是不够的 ——
   * import 语句里也有它，把调用删掉检查照样通过。
   * （这个假阴性和前面几次踩的是同一类：注释/import 里的字符串会骗过源码检查。）
   */
  assert.ok(
    /await\s+osKeyringDelete\s*\(\s*\)/.test(f),
    '切走 oskeyring 时要真的调用 osKeyringDelete（只 import 不算）',
  );
});
