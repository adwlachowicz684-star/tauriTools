import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldLikeOf, acceptsTextOf } from '../engine/fieldLike';

/**
 * FieldDef → FieldLike。
 *
 * 这里的重点是"函数形态"：FieldDef 的 label / hint / options 都允许是函数
 * （为了随其它字段变化），漏处理一种界面上就会出现 [object Object] ——
 * **不报错，只是一串垃圾**，很难查到源头。
 */

const D = { mode: 'json' };

test('字符串 label / hint 原样取', () => {
  const r = fieldLikeOf([{ type: 'text', key: 'a', label: '地址', hint: '含协议' }], D);
  assert.equal(r[0].label, '地址');
  assert.equal(r[0].hint, '含协议');
});

test('函数 label 要就地求值', () => {
  const r = fieldLikeOf([
    { type: 'text', key: 'p', label: (d: Record<string, unknown>) => (d.mode === 'json' ? '路径' : '正则') },
  ], D);
  assert.equal(r[0].label, '路径');
});

test('函数是 JSX 等非字符串时给 null，不能出现 [object Object]', () => {
  const r = fieldLikeOf([
    { type: 'text', key: 'a', hint: () => ({ props: {}, type: 'span' }) },
  ], D);
  assert.equal(r[0].hint, null);
});

test('label 函数抛异常时吞掉，不让整个说明块崩', () => {
  const r = fieldLikeOf([
    { type: 'text', key: 'a', label: () => { throw new Error('读不到'); } },
  ], D);
  assert.equal(r[0].label, null);
  assert.equal(r.length, 1);
});

test('options 是函数时求值', () => {
  const r = fieldLikeOf([
    { type: 'select', key: 'm', options: () => [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] },
  ], D);
  assert.deepEqual(r[0].options, [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }]);
});

test('options 缺 label 时用 value 兜底', () => {
  const r = fieldLikeOf([{ type: 'select', key: 'm', options: [{ value: 'a' }] }], D);
  assert.deepEqual(r[0].options, [{ value: 'a', label: 'a' }]);
});

test('options 里没有 value 的项丢掉（点了没反应）', () => {
  const r = fieldLikeOf([
    { type: 'select', key: 'm', options: [{ label: '甲' }, { value: 'b' }] },
  ], D);
  assert.deepEqual(r[0].options, [{ value: 'b', label: 'b' }]);
});

test('when 恒为 null —— 函数的显示条件推导不出来，不猜', () => {
  const r = fieldLikeOf([{ type: 'text', key: 'a', when: () => true }], D);
  assert.equal(r[0].when, null);
});

test('content 只取字符串（note 块的正文）', () => {
  const r = fieldLikeOf([
    { type: 'note', content: '等待上限 10 分钟' },
    { type: 'note', content: 42 },
  ], D);
  assert.equal(r[0].content, '等待上限 10 分钟');
  assert.equal(r[1].content, null);
});

test('extraKeys 转成字符串数组', () => {
  const r = fieldLikeOf([{ type: 'custom', extraKeys: ['a', 'b'] }], D);
  assert.deepEqual(r[0].extraKeys, ['a', 'b']);
});

test('垃圾项跳过，不产生 undefined 条目', () => {
  const r = fieldLikeOf([null, undefined, 'x', { type: 'text', key: 'a' }], D);
  assert.equal(r.length, 1);
  assert.equal(r[0].key, 'a');
});

test('空输入不出错', () => {
  assert.deepEqual(fieldLikeOf([], D), []);
  assert.deepEqual(fieldLikeOf(undefined as never, D), []);
});

/* ---------------- 接受侧可读化 ---------------- */

test("'any' 显示「任何」", () => {
  assert.equal(acceptsTextOf('any'), '任何');
});

test("'none' 显示「（无需输入）」", () => {
  assert.equal(acceptsTextOf('none'), '（无需输入）');
});

test('数组按 PORT_LABEL 转成中文，不是原始值', () => {
  assert.equal(acceptsTextOf(['text', 'json']), '文本 / JSON');
});

test('空数组也算无需输入', () => {
  assert.equal(acceptsTextOf([]), '（无需输入）');
});

test('未知端口名退回原始值，不显示 undefined', () => {
  assert.equal(acceptsTextOf(['zzz']), 'zzz');
});

test('null / undefined 不出 undefined 字样', () => {
  assert.equal(acceptsTextOf(null), '');
  assert.equal(acceptsTextOf(undefined), '');
});
