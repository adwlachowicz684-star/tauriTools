import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTemplate, rewriteRefHeads, tokenRe,
} from '../engine/template';
import { expandModules } from '../engine/modules';
import {
  expandCanvasRefs, KIND_CANVAS_REF,
} from '../engine/canvasRef';
import { readSrc } from './srcScan';

/*
 * ==================================================================
 * 改节点 id 时改写引用：判据必须与渲染器同源
 * ==================================================================
 *
 * 展开（模块 / 跨画布）会给内部节点 id 加实例前缀，于是文本里的
 * {{A.output}} 必须跟着变成 {{inst__A.output}}，否则渲染取不到值，
 * **且不报错** —— 只是空串，界面上表现为「下游没数据」。
 *
 * 以前两份展开各写一份「只认 `{{id.`」的正则：
 *
 *   modules.ts   `[A-Za-z0-9_-]+` —— 认 `-`，不认中文，不认简写
 *   canvasRef.ts `refHeadRe()`     —— 认中文，不认 `-`，不认简写
 *
 * 而渲染器 tokenRe() 三者全认。于是同一句引用在两种展开里结果不同：
 *
 *   {{A}}            → 两边都不改（output 简写，engine.test.ts 有专门用例）
 *   {{a-b.output}}   → 模块改对、跨画布没改
 *   {{价格.output}}  → 跨画布改对、模块没改
 *
 * 探针实测（修前）：
 *   模块   {{A}} => {{A}}                 跨画布 {{A}} => {{A}}
 *   模块   {{a-b.output}} => {{inst__a-b.output}}
 *                                        跨画布 {{a-b.output}} => {{a-b.output}}
 *   模块   {{价格.output}} => {{价格.output}}
 *                                        跨画布 {{价格.output}} => {{r1__价格.output}}
 *
 * 现在统一由 template.ts 的 rewriteRefHeads 走 tokenRe() 决定「什么算引用」。
 * ==================================================================
 */

type Data = Record<string, unknown>;
const N = (id: string, extra: Data = {}) => ({ id, data: { kind: 'const', label: id, ...extra } });
const E = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });
const d = (n: { data?: unknown }): Data => (n.data ?? {}) as Data;

/** 模块展开：返回内部 B 节点的 text */
function viaModule(value: string, innerId = 'A'): string {
  const def = {
    id: 'md1', name: 'M',
    nodes: [N(innerId), N('B', { text: value })],
    edges: [E(innerId, 'B')],
  };
  const g = expandModules(
    { nodes: [N('inst', { kind: 'module', moduleId: 'md1' })], edges: [] } as never,
    () => def as never,
  );
  const b = g.nodes.find((n) => String(n.id) === 'inst__B');
  assert.ok(b, '模块内部节点应被加前缀并入');
  return String(d(b as never).text);
}

/** 跨画布展开：返回子画布 C 节点的 text */
function viaCanvas(value: string, innerId = 'A'): string {
  const inner = {
    id: 'B', name: '子画布',
    nodes: [N(innerId), N('C', { text: value })],
    edges: [E(innerId, 'C')],
  };
  const out = expandCanvasRefs(
    { nodes: [N('r1', { kind: KIND_CANVAS_REF, canvasId: 'B' })], edges: [] } as never,
    (id) => (id === 'B' ? (inner as never) : null),
  );
  const c = out.nodes.find((n) => String(n.id) === 'r1__C');
  assert.ok(c, '子画布节点应被加前缀并入');
  return String(d(c as never).text);
}

/* ================= 纯函数层 ================= */

test('output 简写 {{A}} 也要重写（此前两份实现都漏）', () => {
  assert.equal(rewriteRefHeads('读到 {{A}} 了', new Map([['A', 'inst__A']])), '读到 {{inst__A}} 了');
});

test('带点、连字符、中文、多级后缀都要重写，且只换第一段', () => {
  const m = new Map([
    ['A', 'inst__A'], ['a-b', 'inst__a-b'], ['价格', 'inst__价格'],
  ]);
  assert.equal(rewriteRefHeads('{{A.output}}', m), '{{inst__A.output}}');
  assert.equal(rewriteRefHeads('{{a-b.output}}', m), '{{inst__a-b.output}}');
  assert.equal(rewriteRefHeads('{{价格.output}}', m), '{{inst__价格.output}}');
  assert.equal(rewriteRefHeads('{{A.fields.title}}', m), '{{inst__A.fields.title}}');
});

test('原文里的空白与标点原样保留（不重建整句）', () => {
  const m = new Map([['A', 'inst__A']]);
  assert.equal(rewriteRefHeads('{{ A.output }}', m), '{{ inst__A.output }}');
  assert.equal(rewriteRefHeads('前缀 {{A.output}}，后缀', m), '前缀 {{inst__A.output}}，后缀');
});

test('一句里多处引用都要改（/g 且每次新实例）', () => {
  const m = new Map([['A', 'x__A'], ['B', 'x__B']]);
  assert.equal(
    rewriteRefHeads('{{A.output}} + {{B}} + {{A.name}}', m),
    '{{x__A.output}} + {{x__B}} + {{x__A.name}}',
  );
  // 连续调用不能互相踩 lastIndex
  assert.equal(rewriteRefHeads('{{A.output}}', m), '{{x__A.output}}');
  assert.equal(rewriteRefHeads('{{A.output}}', m), '{{x__A.output}}');
});

test('判据同源：渲染器认得的 id 形状，重写也必须认得', () => {
  /*
   * 这条是整份测试里最要紧的一条 —— 不是「我手动对齐了几个例子」，
   * 而是把「渲染能解析」与「重写能改」绑成同一个判据。
   * 将来谁给 tokenRe 放开/收紧字符集，这里会立刻指出重写是否跟上。
   */
  for (const id of ['A', 'a-b', '价格', 'n_1']) {
    const tpl = `{{${id}.output}}`;
    const rendered = renderTemplate(tpl, { outputs: { [id]: 'V' } });
    assert.equal(rendered.text, 'V', `渲染应认得 ${tpl}`);
    assert.equal(rendered.missing.length, 0, `渲染不该报缺失：${tpl}`);
    assert.equal(tokenRe().exec(tpl)?.[1], `${id}.output`, `tokenRe 应把 ${tpl} 分成一个引用`);
    assert.equal(
      rewriteRefHeads(tpl, new Map([[id, 'inst__' + id]])),
      `{{inst__${id}.output}}`,
      `重写应认得 ${tpl}`,
    );
  }
});

test('闭环：重写后的引用真的能取到值（不是只改了字符串）', () => {
  for (const id of ['A', 'a-b', '价格']) {
    const rewritten = rewriteRefHeads(`{{${id}}}`, new Map([[id, 'inst__' + id]]));
    assert.equal(
      renderTemplate(rewritten, { outputs: { ['inst__' + id]: 'OK' } }).text,
      'OK',
      `${id}：重写后应真的解析出值`,
    );
  }
});

/* ================= 反例：防过度修复 ================= */

test('保留字与别的画布节点一律不动', () => {
  const m = new Map([['A', 'inst__A']]);
  const src = '{{input}} / {{loop.item}} / {{chain.output}} / {{params.价格}} / {{env.TOKEN}} / {{var.x}} / {{Z.output}}';
  assert.equal(rewriteRefHeads(src, m), src);
});

test('没有 {{ 的文本、空 map、数字与布尔不受影响', () => {
  assert.equal(rewriteRefHeads('普通文本 A.output', new Map([['A', 'x']])), '普通文本 A.output');
  assert.equal(rewriteRefHeads('{{A.output}}', new Map()), '{{A.output}}');
  assert.equal(rewriteRefHeads('', new Map()), '');
});

/* ================= 两种展开：同一份值、同样的形状 ================= */

test('端到端：三种形态在模块展开里都改对', () => {
  assert.equal(viaModule('{{A}}'), '{{inst__A}}');
  assert.equal(viaModule('{{a-b.output}}', 'a-b'), '{{inst__a-b.output}}');
  assert.equal(viaModule('{{价格.output}}', '价格'), '{{inst__价格.output}}');
});

test('端到端：三种形态在跨画布展开里都改对', () => {
  assert.equal(viaCanvas('{{A}}'), '{{r1__A}}');
  assert.equal(viaCanvas('{{a-b.output}}', 'a-b'), '{{r1__a-b.output}}');
  assert.equal(viaCanvas('{{价格.output}}', '价格'), '{{r1__价格.output}}');
});

test('端到端：对象数组里的简写/中文/连字符一起覆盖（与上轮递归叠加）', () => {
  for (const [id, value, wantM, wantC] of [
    ['A', '{{A}}', '{{inst__A}}', '{{r1__A}}'],
    ['a-b', '{{a-b.output}}', '{{inst__a-b.output}}', '{{r1__a-b.output}}'],
    ['价格', '{{价格.output}}', '{{inst__价格.output}}', '{{r1__价格.output}}'],
  ] as const) {
    const items = [{ id: 'c0', name: '标题', value, valueType: 'text' }];
    const def = { id: 'md1', name: 'M', nodes: [N(id), N('B', { items })], edges: [E(id, 'B')] };
    const g = expandModules(
      { nodes: [N('inst', { kind: 'module', moduleId: 'md1' })], edges: [] } as never,
      () => def as never,
    );
    const b = g.nodes.find((n) => String(n.id) === 'inst__B');
    assert.equal((d(b as never).items as Data[])[0].value, wantM, `模块 ${id}`);

    const inner = { id: 'B', name: '子', nodes: [N(id), N('C', { items })], edges: [E(id, 'C')] };
    const out = expandCanvasRefs(
      { nodes: [N('r1', { kind: KIND_CANVAS_REF, canvasId: 'B' })], edges: [] } as never,
      (cid) => (cid === 'B' ? (inner as never) : null),
    );
    const c = out.nodes.find((n) => String(n.id) === 'r1__C');
    assert.equal((d(c as never).items as Data[])[0].value, wantC, `跨画布 ${id}`);
  }
});

test('反例：模块/跨画布展开都不碰保留字', () => {
  const src = '{{input}} + {{params.价格}} + {{loop.item}}';
  assert.equal(viaModule(src), src);
  assert.equal(viaCanvas(src), src);
});

/* ================= 源码守卫 ================= */

test('源码守卫：两份展开的字符串分支都调 rewriteRefHeads', () => {
  for (const f of ['engine/modules.ts', 'engine/canvasRef.ts']) {
    const src = readSrc(f);
    assert.ok(src.length > 2000, `守卫自身要读到源码：${f}`);
    assert.ok(/rewriteRefHeads\(/.test(src), `${f} 必须调用统一入口`);
    assert.ok(
      !/\/\{\{/.test(src),
      `${f} 不许再自带 {{...}} 正则（字符集与简写必须同源）`,
    );
    assert.ok(!/refHeadRe\(/.test(src), `${f} 不该再调已删除的 refHeadRe()`);
  }
});

test('源码守卫：rewriteRefHeads 走 tokenRe()，不许另立字符集', () => {
  const src = readSrc('engine/template.ts');
  const start = src.indexOf('export function rewriteRefHeads');
  assert.ok(start > 0, '守卫自身要找到定义');
  const body = src.slice(start, start + 1400);
  assert.ok(/tokenRe\(\)/.test(body), '重写必须用渲染器同一个分词入口');
  assert.ok(!/new RegExp\(/.test(body), '重写里不许再 new 一份正则');
  assert.ok(!/refHeadRe\(/.test(src), '旧的 refHeadRe 应已移除');
});

/* ==================================================================
 * 渲染保留字：展开改写不能把「全局输入」改成「节点引用」
 * ==================================================================
 *
 * idMap 的键是模块/子画布内部的节点 id。若某内部节点恰好叫
 * input / params / var / loop / chain / env，而文本里写的是
 * {{input}}（全局输入）、{{params.价格}}（画布参数），
 * 改了就变成对一个常量节点的引用 —— 不报错、测试不红，
 * 界面上是「输入怎么突然变成了上游的某个值」。
 *
 * 探针实测（补这条之前）：
 *   模块展开   {{input}} + {{params.价格}} + {{A}}
 *           → {{inst__input}} + {{inst__params.价格}} + {{inst__A}}
 *   跨画布展开 → {{r1__input}} + {{r1__params.价格}} + {{r1__A}}
 *
 * 这六个名字在 renderTemplate 里有专门分支，本来就不是节点 id。
 * ================================================================== */

const RESERVED = ['input', 'chain', 'loop', 'var', 'params', 'env'] as const;

test('渲染保留字不是节点 id：重写必须整句跳过', () => {
  const m = new Map(RESERVED.map((h) => [h, 'inst__' + h] as const));
  for (const h of RESERVED) {
    assert.equal(rewriteRefHeads(`{{${h}}}`, m), `{{${h}}}`, `${h} 简写不许改`);
    assert.equal(
      rewriteRefHeads(`{{${h}.output}}`, m), `{{${h}.output}}`,
      `${h} 带点不许改`,
    );
  }
  assert.equal(
    rewriteRefHeads('{{input}} + {{params.价格}} + {{env.TOKEN}}', m),
    '{{input}} + {{params.价格}} + {{env.TOKEN}}',
  );
});

test('保留字清单与渲染器分支同源（不许另写一份）', () => {
  /*
   * 不比对实现里的 Set 字面量（那是抄一份），而是从 renderTemplate
   * 的真实分支里把 `nodeId === 'xxx'` 提取出来。渲染器哪天加了第七个
   * 保留字而跳过清单没跟上，这里立刻红。
   */
  const src = readSrc('engine/template.ts');
  const at = src.indexOf('export function renderTemplate');
  const end = src.indexOf('export function unresolvedIssue');
  assert.ok(at > 0 && end > at, '守卫自身要找到 renderTemplate 的函数体');
  const body = src.slice(at, end);
  const found = new Set<string>();
  for (const mm of body.matchAll(/nodeId === '([a-z]+)'/g)) found.add(mm[1] as string);
  assert.ok(found.size >= 6, `守卫自身要读到保留字分支（实得 ${found.size} 个）`);
  assert.deepEqual(
    [...found].sort(), [...RESERVED].sort(),
    '渲染器保留字与重写跳过清单必须一致',
  );
});

test('反例：跳过保留字不等于一律不重写（防过度修复）', () => {
  const m = new Map([['A', 'inst__A'], ['a-b', 'inst__a-b'], ['价格', 'inst__价格']]);
  assert.equal(
    rewriteRefHeads('{{A}} + {{a-b.output}} + {{价格}}', m),
    '{{inst__A}} + {{inst__a-b.output}} + {{inst__价格}}',
  );
  assert.equal(
    rewriteRefHeads('{{input}} + {{A}}', m),
    '{{input}} + {{inst__A}}',
  );
});

test('端到端：内部节点撞上保留字，两种展开都只改真正的节点 id', () => {
  const text = '{{input}} + {{params.价格}} + {{A}}';
  const ids = ['input', 'params', 'A'];
  const nodes = [...ids.map((id) => N(id)), N('B', { text })];
  const edges = ids.map((id) => E(id, 'B'));

  const def = { id: 'md1', name: 'M', nodes, edges };
  const g = expandModules(
    { nodes: [N('inst', { kind: 'module', moduleId: 'md1' })], edges: [] } as never,
    () => def as never,
  );
  const b = g.nodes.find((n) => String(n.id) === 'inst__B');
  assert.equal(
    d(b as never).text,
    '{{input}} + {{params.价格}} + {{inst__A}}',
    '模块展开',
  );

  const inner = { id: 'B', name: '子', nodes, edges };
  const out = expandCanvasRefs(
    { nodes: [N('r1', { kind: KIND_CANVAS_REF, canvasId: 'B' })], edges: [] } as never,
    (cid) => (cid === 'B' ? (inner as never) : null),
  );
  const c = out.nodes.find((n) => String(n.id) === 'r1__C');
  /* 跨画布那侧的 helper 用的是 C 节点，这里显式换成 B 同形数据 */
  const c2 = out.nodes.find((n) => String(n.id) === 'r1__B');
  assert.ok(c || c2, '子画布节点应被加前缀并入');
  assert.equal(
    d((c || c2) as never).text,
    '{{input}} + {{params.价格}} + {{r1__A}}',
    '跨画布展开',
  );
});
