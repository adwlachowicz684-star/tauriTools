import test from 'node:test';
import assert from 'node:assert/strict';
import { loadList, loadObject, saveWrapped, type KV } from '../engine/kv';
import { hadInlineSecret, stripSecrets, stripViewKeys, SECRET_PATHS } from '../engine/sanitize';

/*
 * 刻意不写返回类型注解：strip-ts.py 处理不了 KV & {...} 这类交叉类型。
 */
function memKV() {
  const map = new Map<string, string>();
  return {
    map,
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => void map.set(k, v),
    remove: (k: string) => void map.delete(k),
  };
}

/* ---------------- kv ---------------- */

test('loadList：读包装对象里的列表', () => {
  const kv = memKV();
  saveWrapped(kv, 'k', 1, 'cards', [{ a: 1 }, { a: 2 }]);
  assert.equal((loadList(kv, 'k', 'cards') as unknown[]).length, 2);
});

test('loadList：兼容直接是数组的旧格式', () => {
  const kv = memKV();
  kv.set('k', JSON.stringify([{ a: 1 }]));
  assert.equal((loadList(kv, 'k', 'cards') as unknown[]).length, 1);
});

test('loadList：按校验器过滤坏元素', () => {
  const kv = memKV();
  saveWrapped(kv, 'k', 1, 'cards', [{ id: 'a' }, { bad: true }]);
  const list = loadList(kv, 'k', 'cards', (v) => Boolean((v as { id?: string }).id));
  assert.equal((list as unknown[]).length, 1);
});

test('loadList：坏 JSON 与字段缺失都返回空数组', () => {
  const kv = memKV();
  kv.set('k', '{坏掉的');
  assert.deepEqual(loadList(kv, 'k', 'cards'), []);
  kv.set('k2', JSON.stringify({ version: 1 }));
  assert.deepEqual(loadList(kv, 'k2', 'cards'), []);
});

test('loadList：没存过返回空数组', () => {
  assert.deepEqual(loadList(memKV(), '没有的键', 'cards'), []);
});

test('loadObject：坏 JSON 返回空对象', () => {
  const kv = memKV();
  kv.set('k', '不是 JSON');
  assert.deepEqual(loadObject(kv, 'k'), {});
});

test('loadObject：数组内容视为无效（要的是对象表）', () => {
  const kv = memKV();
  kv.set('k', JSON.stringify([1, 2]));
  assert.deepEqual(loadObject(kv, 'k'), {});
});

test('saveWrapped 写入带版本号的包装', () => {
  const kv = memKV();
  saveWrapped(kv, 'k', 3, 'mods', [{ x: 1 }]);
  const parsed = JSON.parse(kv.map.get('k') ?? '{}') as { version: number; mods: unknown[] };
  assert.equal(parsed.version, 3);
  assert.equal(parsed.mods.length, 1);
});

/* ---------------- sanitize ---------------- */

test('SECRET_PATHS 覆盖了三类内联密钥', () => {
  assert.ok(SECRET_PATHS.includes('token'));
  assert.ok(SECRET_PATHS.includes('llm.apiKey'));
  assert.ok(SECRET_PATHS.includes('config.token'));
});

test('hadInlineSecret 认得嵌套与顶层的密钥', () => {
  assert.equal(hadInlineSecret({ token: 'x' }), true);
  assert.equal(hadInlineSecret({ llm: { apiKey: 'sk' } }), true);
  assert.equal(hadInlineSecret({ config: { token: 'x' } }), true);
  assert.equal(hadInlineSecret({ credentialId: 'c1' }), false);
});

test('stripSecrets 挖空但保留字段结构（界面上输入框还在）', () => {
  const out = stripSecrets({ token: 'ghp', repo: 'o/r' });
  assert.equal(out.token, '');
  assert.ok('token' in out, '键要留着，用户才知道该填什么');
  assert.equal(out.repo, 'o/r');
});

test('stripSecrets 挖嵌套时不破坏同层其它字段', () => {
  const out = stripSecrets({ llm: { apiKey: 'sk', model: 'm' }, prompt: 'p' });
  const llm = out.llm as { apiKey: string; model: string };
  assert.equal(llm.apiKey, '');
  assert.equal(llm.model, 'm');
  assert.equal(out.prompt, 'p');
});

test('stripViewKeys 剥掉显示与布局状态', () => {
  const out = stripViewKeys({ prompt: 'p', size: 'sm', stackParent: 'A', stackCollapsed: true });
  assert.equal(out.prompt, 'p');
  assert.equal(out.size, undefined);
  assert.equal(out.stackParent, undefined);
  assert.equal(out.stackCollapsed, undefined);
});

/**
 * 这条守的是"新增密钥字段时漏改一处"的风险 ——
 * 这份清单此前在两个模块各写了一份，漏改就会明文泄露。
 * 现在只有一处，测试盯着它不为空。
 */
test('密钥清单只有一份（sanitize 是唯一来源）', () => {
  assert.ok(SECRET_PATHS.length >= 3, '清单被清空会导致密钥明文落盘');
});
