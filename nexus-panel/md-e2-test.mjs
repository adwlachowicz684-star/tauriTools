/**
 * md 插件 E2（宿主传路径）+ 通用传参机制测试
 * ============================================================
 * 分两类：
 *   ① 行为 —— 用 jsdom **真跑** createModuleContext，验证 ctx.openArgs /
 *      ctx.onOpenArgs 的语义（挂载期参数 vs 运行中补发）。
 *   ② 契约 —— 宿主与 SDK 的接线、白名单登记。
 *      这类错了不报错（"传了路径没反应"），只能靠断言钉。
 *
 * 运行：node md-e2-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${extra ? '  → ' + extra : ''}`); }
}

const host = read('js/host.js');
const sdk = read('js/plugin-sdk.js');
const policy = read('js/invoke-policy.js');
const app = read('plugins/md/App.tsx');
const entry = read('plugins/md/module.tsx');

/* 剥注释：注释里会写 openArgs 这些词，不剥会造成假绿/假红 */
const strip = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const hostC = strip(host);
const sdkC = strip(sdk);
const appC = strip(app);

/* ============================================================
   1. 传参机制：真跑
   ============================================================ */
console.log('\n=== 1. ctx.openArgs 行为（真跑） ===');

/*
 * plugin-sdk 是浏览器代码：createModuleContext 内部直接用 `document`
 * （bindShortcut 要往文档上挂 keydown）。所以必须先造出全局 document。
 * 用 jsdom 而不是自己造个假对象：它还会用到 document.createElement、
 * Node 原型等，糊一个假的会在更深处以更难懂的方式炸。
 */
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

let createModuleContext;
try {
  ({ createModuleContext } = await import('./js/plugin-sdk.js'));
} catch (e) {
  console.log(`❌ 无法加载 plugin-sdk：${e.message}`);
  fail++;
}

if (createModuleContext) {
  /* 造一个最小 DOM 环境 */
  const el = {
    className: '', dataset: {}, style: {},
    appendChild() {}, removeChild() {}, attachShadow: null,
    addEventListener() {}, removeEventListener() {},
  };
  const mkBus = () => {
    const map = new Map();
    return {
      on(ev, fn) { if (!map.has(ev)) map.set(ev, new Set()); map.get(ev).add(fn); return () => map.get(ev)?.delete(fn); },
      emit(ev, p) { map.get(ev)?.forEach((fn) => fn(p)); },
    };
  };
  const manifest = { id: 'md', name: 'Markdown' };

  const ctxWith = createModuleContext({
    manifest, container: el, bus: mkBus(), theme: {}, shellHooks: {},
    openArgs: { path: 'D:/a.md' },
  });
  t('挂载期参数 → ctx.openArgs 同步可读', ctxWith.openArgs?.path === 'D:/a.md');

  const ctxNo = createModuleContext({
    manifest, container: el, bus: mkBus(), theme: {}, shellHooks: {},
  });
  t('没带参数时 openArgs 是 null（不是 {}，可区分"没带"与"带了空对象"）',
    ctxNo.openArgs === null);

  /* 运行中补发：走带 id 前缀的事件 */
  const bus = mkBus();
  const ctx2 = createModuleContext({
    manifest, container: el, bus, theme: {}, shellHooks: {},
  });
  let got = null;
  const off = ctx2.onOpenArgs?.((args) => { got = args; });
  t('ctx.onOpenArgs 存在', typeof ctx2.onOpenArgs === 'function');

  bus.emit('plugin:open-args:md', { path: 'D:/b.md' });
  t('运行中补发（事件名带 id 前缀）能收到', got?.path === 'D:/b.md');

  /* 关键：别人插件的事件不能串台 */
  got = null;
  bus.emit('plugin:open-args:other', { path: 'D:/c.md' });
  t('别的插件 id 的事件不会串台', got === null);

  got = null;
  off?.();
  bus.emit('plugin:open-args:md', { path: 'D:/d.md' });
  t('取消订阅后不再收到', got === null);
}

/* ============================================================
   2. 宿主接线
   ============================================================
 */
console.log('\n=== 2. 宿主（host.js）接线 ===');

/* args 允许带默认值（args = null）—— 断言别钉死写法，钉"有没有第二个参数" */
t('mount 接收第二个参数 args',
  /async function mount\(id, args\s*(=\s*null)?\)/.test(hostC));
t('mount 把 args 传给 iframe 分支',
  /mountIframeView\(stage, manifest, token, 'main', args\)/.test(hostC));
t('mount 把 args 传给 module 分支',
  /mountModule\(stage, manifest, token, args\)/.test(hostC));
t('mountIframeView 有 openArgs 形参',
  /mountIframeView\(hostEl, manifest, token, view = 'main', openArgs = null\)/.test(hostC));
t('init 消息带 openArgs（iframe 端才拿得到）',
  /type: 'init', manifest,[\s\S]{0,200}?openArgs/.test(hostC));
t('mountModule 有 openArgs 形参',
  /mountModule\(stage, manifest, token, openArgs = null\)/.test(hostC));
t('createModuleContext 传入 openArgs',
  /manifest, container, bus, openArgs,/.test(hostC));
t('导出 openWithArgs', /openWithArgs,/.test(hostC));

/*
 * openWithArgs 的关键：不能直接 emit 了事。
 * 插件还没挂载时总线订阅不存在，emit 会**静默丢弃** ——
 * 表现是"第一次传路径没反应"，且不报错。
 */
t('openWithArgs 有"未激活则 mount"分支（否则首次传参静默丢失）',
  /async function openWithArgs\(id, args\)[\s\S]{0,300}?await mount\(id, args\)/.test(hostC));
t('openWithArgs 有"已激活则 emit"分支（否则二次传参整篇重载）',
  /state\.activeId === id && state\.instance[\s\S]{0,200}?bus\.emit/.test(hostC));

/* ============================================================
   3. SDK 接线
   ============================================================
 */
console.log('\n=== 3. SDK（plugin-sdk.js）接线 ===');

t('createModuleContext 解构 openArgs',
  /openArgs = null,[\s\S]{0,80}?\}\) \{/.test(sdkC) ||
  /openArgs = null,.*\n\}\) \{/s.test(sdkC));
t('buildCtx 把 openArgs 放到 ctx 上',
  /openArgs: base\.openArgs \?\? null,/.test(sdkC));
t('buildCtx 提供 onOpenArgs（走带 id 前缀的事件）',
  /onOpenArgs\(handler\)[\s\S]{0,120}?bus\.on\(`plugin:open-args:\$\{id\}`/.test(sdkC));
t('iframe 端把 init 里的 openArgs 记下来',
  /if \('openArgs' in d\) openArgs = d\.openArgs \?\? null;/.test(sdkC));
t('iframe 端 buildCtx 传入 openArgs',
  /mode: 'iframe',[\s\S]{0,200}?openArgs,/.test(sdkC));

/* ============================================================
   4. md 插件接入
   ============================================================
 */
console.log('\n=== 4. md 插件接入 ===');

t('module.tsx 把 ctx 传给 App（不传则路径入口静默失效）',
  /\(ctx\) => <MdApp ctx=\{ctx\} \/>/.test(entry));
t('App 接收 ctx 参数', /function MdApp\(\{ ctx \}/.test(appC));
t('接了 ctx.openArgs（挂载期）', /ctx\.openArgs\?\.path/.test(appC));
t('接了 ctx.onOpenArgs（运行中补发）', /ctx\.onOpenArgs\?/.test(appC));
t('effect 返回取消订阅（否则卸载后仍收事件）', /return \(\) => off\?\.\(\)/.test(appC));
t('调用 fpx_read_file', /ctx\.invoke\('fpx_read_file'/.test(appC));
/*
 * 这条防的是"长文档读到一半就断"：
 * Rust 侧 fpx_read_file 默认 20000 字符，只加一句"已截断"，不报错。
 */
t('显式传 max（默认 20000 对阅读器太小且静默截断）',
  /max: MAX_READ_CHARS/.test(appC));
t('MAX_READ_CHARS 明显大于 20000',
  (() => {
    const m = appC.match(/MAX_READ_CHARS = ([\d\s*]+);/);
    if (!m) return false;
    /* eslint-disable no-eval */
    return eval(m[1]) > 20000;
  })());
t('读失败有提示（不静默）', /读取失败/.test(appC));

/* ============================================================
   5. 白名单
   ============================================================
 */
console.log('\n=== 5. 命令白名单 ===');

/*
 * md 现在两条：fpx_read_file（E2 读路径）+ fpx_copy_text（批次 3 复制）。
 * 断言写成"必须含这两条、且不含任何 M 类"而不是钉死数组字面量 ——
 * 钉死的话每加一条合法命令都要回来改测试，"忘了改"会被误判成安全回归。
 */
t('md 登记了 fpx_read_file（E2 读路径）',
  /md: \[[^\]]*'fpx_read_file'/.test(policy));
t('md 登记了 fpx_copy_text（复制）',
  /md: \[[^\]]*'fpx_copy_text'/.test(policy));
t('md 未登记任何 M 类能力（run_node / webhook / window_action）',
  !/md: \[[^\]]*(run_node|webhook_start|window_action)/.test(policy));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
