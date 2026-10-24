/**
 * Owned 归属句柄 —— 契约兑现测试
 * ============================================================
 * 与 ctx-contract-test.mjs 的分工
 * ------------------------------------------------------------
 * 那个管 **PluginContext 的顶层字段**（id / owned / root / …），
 * 本文件管 **ctx.owned 这个对象自身**：
 *
 *   1. d.ts 的 `interface Owned` 声明了 12 个必选成员，
 *      运行时两条路径（同页 module / iframe 握手）都得真给；
 *   2. 而且**真能用** —— 不只是 `typeof === 'function'`。
 *
 * 为什么值得单独立一个文件
 * ------------------------------------------------------------
 * 第一百六十八轮那个缺陷就是 `ctx.owned === undefined`（iframe 路径漏传）。
 * 那次之后顶层字段有守卫了，但**对象内部的成员**仍然没有：
 * 将来有人在 createOwned 里少返回一个方法（比如重构时漏带 addHandle），
 * 类型检查不报错、`ctx.owned` 本身非空 → ctx-contract 照样全绿，
 * 而插件调到那个方法时是 `undefined is not a function`。
 *
 * Owned 是**卸载时收尾**的唯一通道：漏一个方法，对应的那类资源
 * （监听 / 节点 / 定时器 / 样式 / 句柄）在卸载后就留在宿主文档里，
 * 而界面上看不出任何异常 —— 正是本项目反复出现的"静默残留"。
 *
 * 判据刻意只做"必选"方向
 * ------------------------------------------------------------
 * 反方向（运行时给了、d.ts 没声明）不判失败，只列告知 ——
 * d.ts 是有意裁剪的公开面，按"实现有的都必须声明"扫会一片误报，
 * 而**误报的下场是守卫被删**。
 */

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(HERE, rel), 'utf8');

let pass = 0, fail = 0, skip = 0, note = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (name, extra = '') => { note++; console.log(`ℹ️ ${name}${extra ? ' → ' + extra : ''}`); };

/* ============================================================
   1. 解析 d.ts 的 interface Owned
   —— 逐字符带深度扫描，注释与嵌套对象类型都要正确跳过。
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
    /*
     * ⚠️ 可选性**只看成员名后紧跟的那个 `?`**。
     *
     * 早先的写法是 `/\?\s*[:()]/` —— 它会把**参数**里的 `?` 也算进来：
     *   `addListener(target, type, handler, options?: …)`
     * 明明是必选成员，只因有个可选参数就被判成 optional，
     * 于是**整条断言被跳过**（必选清单里没有它）。
     *
     * 这正是"判据失明"：表面全绿，实际少验了 5 个方法。
     *
     * ⚠️ 另外必须认 `readonly` 前缀：`readonly pluginId: string;`
     *    不带这一段的话，正则从 `readonly` 起匹配、后面接的是
     *    标识符而非 `:` → 匹配失败 → 该成员**整个消失**。
     *    实测后果：pluginId 不在必选清单里，跑到第 6 节被当成
     *    "运行时有而 d.ts 没声明" —— 它明明声明了，是判据没读出来。
     */
    const mm = s.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*[:()]/);
    return mm ? { name: mm[1], optional: !!mm[2] } : null;
  }).filter(Boolean);
}

const dts = src('js/plugin-sdk.d.ts');
const members = parseMembers(dts, 'Owned');
const required = (members || []).filter((m) => !m.optional).map((m) => m.name);

console.log('=== 1. d.ts 解析（判据本身必须真解析出东西，否则后面全是假绿）===');
t('Owned 解析成功', Array.isArray(members) && members.length > 0, `成员 ${(members || []).length} 个`);
t('必选成员数量合理（≥10）', required.length >= 10, `必选 ${required.length} 个`);
t('判据认得出 addUndo（防空转）', required.includes('addUndo'));
t('判据认得出 dispose（防空转）', required.includes('dispose'));

/*
 * 钉住上面那处修正：**带可选参数的方法，成员本身仍是必选**。
 * 少了这条，把判据改回 `/\?\s*[:()]/` 时 addListener / addHandle 等
 * 会被静默排除出必选清单 —— 报告照样全绿，实际少验 5 个。
 */
{
  const byName = Object.fromEntries((members || []).map((m) => [m.name, m]));
  t('addListener（参数带 `?`）仍判为必选成员',
    byName.addListener && byName.addListener.optional === false);
  t('addHandle（参数带 `?`）仍判为必选成员',
    byName.addHandle && byName.addHandle.optional === false);
  /*
   * 钉住 readonly 前缀：少了对 `readonly` 的处理，pluginId 会整个
   * 从必选清单里消失（实测它曾跑到第 6 节，被当成"d.ts 没声明"）。
   */
  t('pluginId（带 readonly 前缀）仍被解析为必选成员',
    byName.pluginId && byName.pluginId.optional === false);
}

/* ============================================================
   2. 两条路径都真的拿到 ctx.owned
   ============================================================ */
console.log('\n=== 2. 两条路径拿到 ctx.owned（前置条件）===');
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="mod-host"></div></body></html>',
  { url: 'http://localhost/plugin.html', pretendToBeVisual: true });
const { window: sdkWin } = dom;
const posted = [];
sdkWin.parent = { postMessage: (m) => posted.push(m) };
globalThis.window = sdkWin;
globalThis.document = sdkWin.document;
globalThis.localStorage = sdkWin.localStorage;
globalThis.location = sdkWin.location;
Object.defineProperty(globalThis, 'navigator', { value: sdkWin.navigator, configurable: true, writable: true });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { createModuleContext, bootIframePlugin } = await import('./js/plugin-sdk.js');

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
t('同页路径 ctx.owned 非空', !!modCtx?.owned);

let iframeCtx = null;
bootIframePlugin((c) => { iframeCtx = c; });
const channel = posted[0]?.channel;
/*
 * 必须带 source：SDK 用 `e.source !== window.parent` 做来源校验，
 * 缺了它所有消息会被静默丢弃（表现为 ctx 一直是 null —— 假绿）。
 */
const deliver = (msg) => sdkWin.dispatchEvent(new sdkWin.MessageEvent('message', {
  data: { channel, ...msg },
  source: sdkWin.parent,
}));
deliver({ type: 'init', manifest: { id: 'probe-iframe', name: '探针' }, theme: {}, view: 'main', isolated: false });
deliver({ type: 'mount' });
await new Promise((r) => setTimeout(r, 30));
t('iframe 路径拿到 ctx（握手真走通）', !!iframeCtx);
t('iframe 路径 ctx.owned 非空', !!iframeCtx?.owned);

/* ============================================================
   3. 逐成员兑现：两条路径都得真给
   ============================================================ */
console.log('\n=== 3. d.ts 必选成员：两条路径都真给 ===');
const missing = [];
const pairs = [['module', modCtx?.owned], ['iframe', iframeCtx?.owned]];
if (pairs.every(([, o]) => o)) {
  for (const name of required) {
    const got = pairs.map(([tag, o]) => [tag, o[name] !== undefined]);
    for (const [tag, ok] of got) {
      if (!ok) missing.push(`${tag}:${name}`);
    }
    t(`owned.${name} 两条路径都非空`, got.every(([, ok]) => ok),
      got.map(([tag, ok]) => `${tag}=${ok ? '有' : '缺'}`).join(' '));
  }
} else {
  skip += required.length;
  t('前置不成立（owned 没拿到）→ 逐成员断言无法执行，记为失败', false);
}
t('汇总：无缺失成员', missing.length === 0, missing.join(' | '));

/* ============================================================
   4. 行为层：不只是"存在"，还得真能用
   —— 只验 typeof === 'function' 的话，一个恒抛异常的空壳也能全绿。
      这里每条都走**真调用 + 看真实结果**。
   ============================================================ */
console.log('\n=== 4. 行为层：方法真能用（module 路径）===');
const o = modCtx?.owned;
if (o) {
  t('owned.pluginId 与 manifest.id 一致', o.pluginId === 'probe-module', String(o.pluginId));

  let undone = false;
  const undo = o.addUndo('probe-cap', () => { undone = true; });
  t('addUndo 返回撤销函数', typeof undo === 'function', typeof undo);
  t('addUndo 登记的 capability 记进 capabilities()',
    o.capabilities().includes('probe-cap'), JSON.stringify(o.capabilities()));
  undo();
  t('撤销函数真的执行了', undone);

  const node = sdkWin.document.createElement('div');
  const uNode = o.addNode(sdkWin.document.body, node);
  t('addNode 真把节点挂上宿主文档', sdkWin.document.body.contains(node));
  uNode();
  t('addNode 的撤销真把节点摘掉', !sdkWin.document.body.contains(node));

  const st = sdkWin.document.createElement('style');
  const uSt = o.addStyle(st);
  t('addStyle 真挂到 document.head', sdkWin.document.head.contains(st));
  uSt();
  t('addStyle 的撤销真摘掉', !sdkWin.document.head.contains(st));

  const d1 = o.dispose();
  t('dispose 返回 undone/failed 计数',
    typeof d1?.undone === 'number' && typeof d1?.failed === 'number',
    JSON.stringify(d1));
  t('dispose 后 isDisposed() 为真', o.isDisposed() === true);
  const d2 = o.dispose();
  t('dispose 幂等（第二次 undone 为 0，不重复撤）', d2?.undone === 0, JSON.stringify(d2));
} else {
  skip += 8;
  t('前置不成立（owned 没拿到）→ 行为断言无法执行，记为失败', false);
}

/* ============================================================
   5. 判据反向自检（防判据失明）
   —— 拿合成样本喂同一套 parseMembers，必须解析得出、且能把
      带可选参数的方法判成必选。样本走内存，不落盘。
   ============================================================ */
console.log('\n=== 5. 判据反向自检（合成样本）===');
{
  const fake = `
export interface Fake {
  /** 注释里的 ghost 不算 */
  plain(x: string): void;
  withOpt(a: number, b?: string): void;
  optMember?: () => void;
  readonly roMember: string;
  nested: { inner: () => void };
}
`;
  const ms = parseMembers(fake, 'Fake') || [];
  const byName = Object.fromEntries(ms.map((m) => [m.name, m]));
  t('解析出 plain', !!byName.plain);
  t('withOpt（参数带 `?`）判为必选', byName.withOpt?.optional === false);
  t('optMember（成员带 `?`）判为可选', byName.optMember?.optional === true);
  t('roMember（readonly 前缀）能解析且判为必选',
    byName.roMember && byName.roMember.optional === false);
  t('嵌套对象里的 inner 不算顶层成员', !byName.inner);
  t('注释里的 ghost 不算成员', !byName.ghost);
}

/* ============================================================
   6. 反方向（运行时给了、d.ts 没声明）只列告知
   ============================================================ */
console.log('\n=== 6. 反方向：运行时有、d.ts 未声明（告知，不算失败）===');
{
  const declared = new Set((members || []).map((m) => m.name));
  const runtimeOnly = new Set();
  for (const [, ow] of pairs) {
    if (!ow) continue;
    for (const k of Object.keys(ow)) {
      if (k.startsWith('_')) continue;
      if (!declared.has(k)) runtimeOnly.add(k);
    }
  }
  const list = [...runtimeOnly].sort();
  if (list.length) info('d.ts 未声明但运行时存在的（有意裁剪的公开面，不判失败）', list.join(', '));
  else info('无未声明成员');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skip} 项，告知 ${note} 条`);
process.exit(fail ? 1 : 0);
