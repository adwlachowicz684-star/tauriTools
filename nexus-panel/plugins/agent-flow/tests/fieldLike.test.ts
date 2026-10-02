import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldLikeOf, acceptsTextOf } from '../engine/fieldLike';
import { deriveParams } from '../engine/blockApi';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AF_SRC } from './srcScan';

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

/*
 * ================= 下面三条盯的是同一个 bug =================
 *
 * custom 是"手写一段 JSX"的逃生口，它读写哪些键从外面看不出来，
 * 只能靠 **spec.keys** 声明 —— 真实节点定义里全都是这么写的
 * （19 个块、34 个键），**没有一处写过 extraKeys**。
 *
 * 而 fieldLike 以前只读 extraKeys。于是契约侧（侧栏说明）的参数表把
 * custom 块声明的键**全丢了**：挑节点时看到的说明里，
 * CLI 节点不显示 prompt（要跑什么命令）、HTTP 节点不显示 url（请求地址）
 * —— 偏偏是最核心的那一项，且全程不报错。
 *
 * 而两千多条测试一路全绿：测试喂的是 extraKeys 这个真实代码里
 * 根本不存在的字段，测试与实现各说一份，谁也没发现另一边是空的。
 */
test('custom 块的 spec.keys 要带出来（真实定义只写 spec，不写 extraKeys）', () => {
  const r = fieldLikeOf([
    { type: 'custom', spec: { keys: ['method', 'url'], kind: 'select' } },
  ], D);
  assert.deepEqual(
    r[0].extraKeys,
    ['method', 'url'],
    'spec.keys 没带出来 —— 侧栏说明里这个节点的参数表会少掉这些键',
  );
});

test('契约侧参数表带上 custom 声明的键（url / method 不丢）', () => {
  /* 按真实写法规格造一份：custom 块不带顶层 key，只有 spec.keys */
  const fields = fieldLikeOf([
    { type: 'custom', spec: { keys: ['method', 'url'], kind: 'select' } },
  ], D);
  const keys = deriveParams(fields).rows.map((r) => r.key);
  assert.ok(keys.includes('url'), `参数表里没有 url：${keys.join('、') || '（空）'}`);
  assert.ok(keys.includes('method'), `参数表里没有 method：${keys.join('、') || '（空）'}`);
});

test('spec.keys 缺失时不臆造，退回 extraKeys', () => {
  assert.equal(fieldLikeOf([{ type: 'custom' }], D)[0].extraKeys, undefined);
  assert.deepEqual(fieldLikeOf([{ type: 'custom', extraKeys: ['x'] }], D)[0].extraKeys, ['x']);
  /* spec.keys 是空数组时不该盖掉 extraKeys */
  assert.deepEqual(
    fieldLikeOf([{ type: 'custom', spec: { keys: [] }, extraKeys: ['x'] }], D)[0].extraKeys,
    ['x'],
  );
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

/*
 * 源码层再钉一道：真实定义**只**写 spec.keys。
 *
 * 少了这条的话，将来有人照着 FieldLike 的类型去写 extraKeys
 * （它看着就像是个公开字段），会发现写了不生效 ——
 * 而上面三条用的是手造数据，抓不到"真实定义里没人这么写"。
 */
test('源码：真实节点定义用 spec.keys 声明，不写 extraKeys（那是死字段）', () => {
  if (!AF_SRC) return;
  const dir = join(AF_SRC, 'nodes/defs');
  let specHits = 0;
  const bad: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
    const src = readFileSync(join(dir, f), 'utf-8');
    specHits += (src.match(/spec:\s*\{\s*keys:/g) ?? []).length;
    if (/\bextraKeys\b/.test(src)) bad.push(f);
  }
  assert.ok(specHits >= 15, `只读到 ${specHits} 处 spec.keys —— 判据可能失效了`);
  assert.deepEqual(
    bad, [],
    `这些定义写了 extraKeys —— 真实链路只认 spec.keys，写了不生效：${bad.join('、')}`,
  );
});
