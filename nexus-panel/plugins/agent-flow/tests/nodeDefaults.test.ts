import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAll, getDefault, hasDefault, setDefault, clearDefault,
  sanitizeForDefault, withDefault, matchPresetKey, NODE_DEFAULTS_KEY,
} from '../engine/nodeDefaults';
import { hadInlineSecret, VIEW_KEYS } from '../engine/sanitize';

/*
 * 刻意不写返回类型注解：strip-ts.py 处理不了 `KV & { map: ... }`
 * 这类交叉类型，会原样留下 `: KV & {...}` 导致生成的 .mjs 语法错误。
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

/* ---------------- 存取 ---------------- */

test('存了能读回来', () => {
  const kv = memKV();
  setDefault('task:codebuddy', { prompt: 'p', workdir: '/w' }, kv);
  assert.equal(getDefault('task:codebuddy', kv).prompt, 'p');
  assert.equal(hasDefault('task:codebuddy', kv), true);
});

test('没设过的预设返回空对象，hasDefault 为假', () => {
  const kv = memKV();
  assert.deepEqual(getDefault('task:codebuddy', kv), {});
  assert.equal(hasDefault('task:codebuddy', kv), false);
});

test('两个变体的默认互不干扰（按 preset.key 存）', () => {
  const kv = memKV();
  setDefault('task:codebuddy', { cli: 'codebuddy', prompt: 'A' }, kv);
  setDefault('task:tracecode', { cli: 'tracecode', prompt: 'B' }, kv);
  assert.equal(getDefault('task:codebuddy', kv).prompt, 'A');
  assert.equal(getDefault('task:tracecode', kv).prompt, 'B');
});

test('清除只清指定那条', () => {
  const kv = memKV();
  setDefault('a', { x: 1 }, kv);
  setDefault('b', { x: 2 }, kv);
  clearDefault('a', kv);
  assert.equal(hasDefault('a', kv), false);
  assert.equal(hasDefault('b', kv), true);
});

test('全部清除后键被删掉，不留空对象', () => {
  const kv = memKV();
  setDefault('a', { x: 1 }, kv);
  clearDefault('a', kv);
  assert.equal(kv.map.has(NODE_DEFAULTS_KEY), false);
});

test('坏 JSON 读出空表，不抛异常', () => {
  const kv = memKV();
  kv.map.set(NODE_DEFAULTS_KEY, '{坏掉的');
  assert.deepEqual(loadAll(kv), {});
});

test('存进去是深拷贝：调用方之后改了不影响默认', () => {
  const kv = memKV();
  const src = { llm: { model: 'gpt' }, prompt: 'p' };
  setDefault('ocr', src, kv);
  (src.llm as { model: string }).model = '改过了';
  assert.equal((getDefault('ocr', kv).llm as { model: string }).model, 'gpt');
});

/* ---------------- 净化 ---------------- */

test('剥掉运行时字段（不然新节点看起来已经跑过）', () => {
  const out = sanitizeForDefault({
    prompt: 'p', status: 'success', output: '旧输出', error: 'e', lastSha: 'abc',
  });
  assert.equal(out.prompt, 'p');
  assert.equal(out.status, undefined);
  assert.equal(out.output, undefined);
  assert.equal(out.lastSha, undefined);
});

/**
 * 这条守一个会让新节点跑不起来的坑：
 * stackParent 不剥的话，每个新建节点都"嵌合"到一个不存在的父节点上，
 * 引擎把它转成边，于是新节点莫名不执行。
 */
test('剥掉显示与布局状态（size / stackParent / stackCollapsed）', () => {
  const out = sanitizeForDefault({
    prompt: 'p', size: 'sm', stackParent: 'A', stackCollapsed: true,
  });
  assert.equal(out.prompt, 'p');
  assert.equal(out.size, undefined);
  assert.equal(out.stackParent, undefined);
  assert.equal(out.stackCollapsed, undefined);
});

test('剥掉内联密钥，但保留凭据引用', () => {
  const out = sanitizeForDefault({ token: 'ghp_xxx', credentialId: 'c1', repo: 'o/r' });
  assert.equal(out.token, '');
  assert.equal(out.credentialId, 'c1', '凭据 id 不是密钥，要保留');
  assert.equal(out.repo, 'o/r');
});

test('嵌套的 llm.apiKey 也要剥', () => {
  const out = sanitizeForDefault({ llm: { apiKey: 'sk-x', model: 'm' } });
  assert.equal((out.llm as { apiKey: string }).apiKey, '');
  assert.equal((out.llm as { model: string }).model, 'm', '同层其它字段保留');
});

test('hadInlineSecret 能识别出内联密钥（用于提示用户）', () => {
  assert.equal(hadInlineSecret({ token: 'x' }), true);
  assert.equal(hadInlineSecret({ credentialId: 'c1' }), false);
});

test('setDefault 返回是否剥过密钥', () => {
  const kv = memKV();
  assert.equal(setDefault('a', { token: 'x' }, kv).strippedSecrets, true);
  assert.equal(setDefault('b', { prompt: 'p' }, kv).strippedSecrets, false);
});

/* ---------------- 应用 ---------------- */

test('叠加顺序：默认盖在已有值之上', () => {
  const kv = memKV();
  setDefault('task', { prompt: '我的默认' }, kv);
  const out = withDefault('task', { prompt: '出厂', workdir: '/w' }, kv);
  assert.equal(out.prompt, '我的默认');
  assert.equal(out.workdir, '/w', '默认里没有的字段保留');
});

test('没设默认时原样返回', () => {
  const kv = memKV();
  const src = { prompt: 'p' };
  assert.deepEqual(withDefault('task', src, kv), src);
});

/**
 * 多个新建节点不能共享嵌套对象 ——
 * 浅拷贝会让改一个节点的模型配置，另一个跟着变。
 */
test('叠加时深拷贝：多个新节点不共享嵌套对象', () => {
  const kv = memKV();
  setDefault('ocr', { llm: { model: 'gpt' } }, kv);
  const a = withDefault('ocr', { kind: 'ocr' }, kv);
  const b = withDefault('ocr', { kind: 'ocr' }, kv);
  assert.notEqual(a.llm, b.llm);
  (a.llm as { model: string }).model = '改了';
  assert.equal((b.llm as { model: string }).model, 'gpt');
});

/* ---------------- 预设反查 ---------------- */

const PRESETS = [
  { key: 'task:codebuddy', type: 'task', init: () => ({ cli: 'codebuddy' }) },
  { key: 'task:tracecode', type: 'task', init: () => ({ cli: 'tracecode' }) },
  { key: 'ocr', type: 'ocr', init: () => ({}) },
];

test('按 init 字段匹配到对应变体', () => {
  assert.equal(matchPresetKey(PRESETS, 'task', { cli: 'codebuddy' }), 'task:codebuddy');
  assert.equal(matchPresetKey(PRESETS, 'task', { cli: 'tracecode' }), 'task:tracecode');
});

test('没有 init 的单条预设直接命中', () => {
  assert.equal(matchPresetKey(PRESETS, 'ocr', { detail: 'auto' }), 'ocr');
});

/**
 * 改过 init 涉及的字段后就不属于任何预设了 ——
 * 返回 null，调用方回落到 node.type（存成该类型的通用默认）。
 */
test('改了变体字段后匹配不到（回落由调用方处理）', () => {
  assert.equal(matchPresetKey(PRESETS, 'task', { cli: '别的' }), null);
});

test('类型完全没预设时返回 null', () => {
  assert.equal(matchPresetKey(PRESETS, '不在表里', {}), null);
});

test('显示状态清单非空（被误清空会导致 stackParent 存进默认值）', () => {
  assert.ok(VIEW_KEYS.includes('stackParent'), 'stackParent 必须在剥离清单里');
  assert.ok(VIEW_KEYS.includes('size'));
  assert.ok(VIEW_KEYS.includes('stackCollapsed'));
});
