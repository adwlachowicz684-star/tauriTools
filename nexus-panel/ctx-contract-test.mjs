/**
 * ctx 契约兑现测试 —— d.ts 声明的**必选**字段，运行时两条路径都得真给
 * ============================================================
 * 为什么要这个测试
 * ------------------------------------------------------------
 * 第一百六十八轮修掉的那个缺陷，形状是这样的：
 *
 *   `plugin-sdk.d.ts` 声明 `owned: Owned`（必选，不是 `owned?`），
 *   三处注释（owned.js / buildCtx / d.ts）都承诺"iframe 插件也会拿到"，
 *   而实现只在**同页（module）路径** `createOwned(...)`，
 *   iframe 的 buildCtx 没传 → `ctx.owned === undefined`。
 *
 *   而当时**没有任何一层能发现它**：
 *     · d.ts 有声明       → 类型检查不报错
 *     · 现有插件没读这个字段 → 没人踩
 *     · 唯一相关的那条断言只验注释文本（注释在就绿）
 *
 * 也就是说：**契约层（d.ts）与实现层（plugin-sdk.js）之间的漂移，
 * 此前没有一道守卫管**。dts-drift-test 只查"TSX import 了而 d.ts 没声明"，
 * 查的是另一个方向（TSX → d.ts），不查 d.ts → 运行时。
 *
 * 所以本文件只做**行为层**：
 *   1. 从 d.ts 解析出 PluginContext 的**必选**成员（带 `?` 的不算）
 *   2. 真的造出两条路径的 ctx（module 走 createModuleContext、
 *      iframe 走 bootIframePlugin 完整握手）
 *   3. 逐个断言**非空** —— 不是"源码里出现了这个字样"
 *
 * 判据刻意只做"必选"这一个方向
 * ------------------------------------------------------------
 * 反方向（运行时给了、d.ts 没声明）**不作为失败**，只列为告知。
 * 原因：本项目里 d.ts 是**有意裁剪**的公开面 —— 第一百五十六轮实测过，
 * `host.d.ts` 手写 155 行，js 里还有几十个内部导出**刻意不声明**；
 * 按"实现有的都必须声明"扫会一片误报，而**误报的下场是守卫被删**。
 * 内部字段（下划线开头）连告知都不列。
 */

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), 'utf8');

let pass = 0, fail = 0, skip = 0, note = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (name, extra = '') => { note++; console.log(`ℹ️ ${name}${extra ? ' → ' + extra : ''}`); };

/* ============================================================
   1. 解析 d.ts：PluginContext 的顶层成员
   —— 逐字符带深度扫描，注释、嵌套对象（`store: { … }`）都要正确跳过。
      只按行/按正则切会把 `store: { get(...)… }` 里的子成员误当顶层成员。
   ============================================================ */
function parseMembers(dtsText, iface) {
  const i0 = dtsText.indexOf('interface ' + iface);
  if (i0 < 0) return null;
  let i = dtsText.indexOf('{', i0);
  if (i < 0) return null;
  let depth = 1, buf = '';
  const members = [];
  for (i += 1; i < dtsText.length && depth > 0; i += 1) {
    const c = dtsText[i];
    if (c === '/' && dtsText[i + 1] === '*') {
      const e = dtsText.indexOf('*/', i + 2);
      i = (e < 0 ? dtsText.length : e + 2) - 1;
      continue;
    }
    if (c === '/' && dtsText[i + 1] === '/') {
      const e = dtsText.indexOf('\n', i);
      i = (e < 0 ? dtsText.length : e + 1) - 1;
      continue;
    }
    if (c === '{') { depth += 1; }
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) { if (buf.trim()) members.push(buf); break; }
    }
    if (depth === 1 && c === ';') { members.push(buf); buf = ''; continue; }
    buf += c;
  }
  return members.map((m) => {
    const s = m.trim();
    const optional = /\?\s*[:()]/.test(s);
    const mm = s.match(/^([A-Za-z_$][\w$]*)/);
    return mm ? { name: mm[1], optional } : null;
  }).filter(Boolean);
}

const dts = src('js/plugin-sdk.d.ts');
const members = parseMembers(dts, 'PluginContext');
const required = (members || []).filter((m) => !m.optional).map((m) => m.name);

console.log('=== 1. d.ts 解析（判据本身必须真的解析出东西，否则后面全是假绿）===');
t('PluginContext 解析成功', Array.isArray(members) && members.length > 0,
  `成员 ${(members || []).length} 个`);
t('必选成员数量合理（≥5，解析出 0 个说明判据空转）', required.length >= 5,
  `必选 ${required.length} 个：${required.join(', ')}`);
/*
 * 这一条是**元断言**：钉住"判据认得出 owned"。
 * 少了它，把 parseMembers 改成恒返回 [] 时 —— required 为空、
 * 第 3/4 节的逐字段循环**一次都不执行**，而"没有一条失败"会让
 * 主断言照样绿。正是本项目反复撞的那种"整节空跑而报告全绿"。
 */
t('判据认得出 owned（防空转：少了这条，判据清空也全绿）', required.includes('owned'));
t('必选/可选能区分（`?` 的不算必选）',
  (members || []).some((m) => m.optional) && (members || []).some((m) => !m.optional));

/* ============================================================
   2. 真的造出两条路径的 ctx
   ============================================================ */
console.log('\n=== 2. 两条路径都拿到 ctx（前置条件）===');

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="mod-host"></div></body></html>', {
  url: 'http://localhost/plugin.html',
  pretendToBeVisual: true,
});
const { window: sdkWin } = dom;
const posted = [];
sdkWin.parent = { postMessage: (m) => posted.push(m) };
globalThis.window = sdkWin;
globalThis.document = sdkWin.document;
globalThis.localStorage = sdkWin.localStorage;
globalThis.location = sdkWin.location;
Object.defineProperty(globalThis, 'navigator', {
  value: sdkWin.navigator, configurable: true, writable: true,
});
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { createModuleContext, bootIframePlugin } = await import('./js/plugin-sdk.js');

/* --- 路径 A：同页（module）--- */
let modCtx = null;
try {
  modCtx = createModuleContext({
    manifest: { id: 'probe-module', name: '探针', version: '1.0.0' },
    container: sdkWin.document.getElementById('mod-host'),
    bus: { on: () => () => {}, emit: () => {} },
    theme: {},
    shellHooks: {},
  });
} catch (e) {
  console.log(`   module ctx 构造异常：${e.message}`);
}
t('同页路径拿到 ctx', !!modCtx);

/* --- 路径 B：iframe（走完整握手，不是只 new 一个对象）--- */
let iframeCtx = null;
bootIframePlugin((c) => { iframeCtx = c; });
const channel = posted[0]?.channel;
// 必须带 source：SDK 用 `e.source !== window.parent` 做来源校验，
// 缺了它所有消息会被静默丢弃（表现为 ctx 一直是 null —— 假绿）
const deliver = (msg) => sdkWin.dispatchEvent(new sdkWin.MessageEvent('message', {
  data: { channel, ...msg },
  source: sdkWin.parent,
}));
deliver({ type: 'init', manifest: { id: 'probe-iframe', name: '探针' }, theme: {}, view: 'main', isolated: false });
deliver({ type: 'mount' });
await new Promise((r) => setTimeout(r, 30));
t('iframe 路径拿到 ctx（握手真的走通）', !!iframeCtx);

/* ============================================================
   3. 逐字段兑现（本文件的核心）
   ============================================================ */
console.log('\n=== 3. d.ts 必选字段：两条路径都真给 ===');
const missing = [];
if (modCtx && iframeCtx) {
  for (const f of required) {
    const a = modCtx[f] !== undefined;
    const b = iframeCtx[f] !== undefined;
    if (!a) missing.push(`module:${f}`);
    if (!b) missing.push(`iframe:${f}`);
    t(`ctx.${f} 两条路径都非空`, a && b,
      `module=${a ? '有' : '缺'} iframe=${b ? '有' : '缺'}`);
  }
} else {
  skip += required.length * 1;
  t('前置不成立（ctx 没拿到）→ 逐字段断言无法执行，记为失败', false);
}
t('汇总：无缺失字段', missing.length === 0, missing.join(' | '));

/* ============================================================
   4. 反方向（运行时给了、d.ts 没声明）只列告知，不算失败
   ============================================================ */
console.log('\n=== 4. 反方向：运行时有、d.ts 未声明（告知，不算失败）===');
{
  const declared = new Set((members || []).map((m) => m.name));
  const runtimeOnly = new Set();
  for (const ctx of [modCtx, iframeCtx]) {
    if (!ctx) continue;
    for (const k of Object.keys(ctx)) {
      if (k.startsWith('_')) continue;
      if (!declared.has(k)) runtimeOnly.add(k);
    }
  }
  const list = [...runtimeOnly].sort();
  if (list.length) {
    info('d.ts 未声明但运行时存在的字段（有意裁剪的公开面，不判失败）', list.join(', '));
  } else {
    info('无未声明字段');
  }
  /*
   * 这里**不写** `t('反方向不判失败', true)` 这种断言 ——
   * 它是恒真的占位断言，会被 assertion-hygiene 第 1 节点名
   * （实测：本文件 157 行曾有一条，被判 ❌）。
   * 反方向本来就只是告知，用 info() 计数即可，不混进通过数。
   */
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skip} 项，告知 ${note} 条`);
process.exit(fail ? 1 : 0);
