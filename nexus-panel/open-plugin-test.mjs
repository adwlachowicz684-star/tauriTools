/**
 * 跨插件打开（openPlugin）—— E2 触发源测试
 * ============================================================
 * 覆盖的是"机制有没有人用"和"会不会被借去提权"两件事。
 *
 * ① 行为 —— jsdom **真跑** createModuleContext，验证：
 *      ctx.openPlugin 存在、内置插件放行、第三方被拒、目标不存在返回 false
 * ② 契约 —— host 桥接分支、project-group 的触发按钮、sdk 的两条通路
 *
 * 运行：node open-plugin-test.mjs
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

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="c"></div></body></html>', {
  url: 'http://localhost/',
});
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'CustomEvent', 'Event', 'localStorage']) {
  globalThis[k] = dom.window[k];
}
globalThis.location = dom.window.location;

const sdk = read('js/plugin-sdk.js');
const host = read('js/host.js');
const pg = read('plugins/project-group/App.tsx');

const strip = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const sdkC = strip(sdk);
const hostC = strip(host);
const pgC = strip(pg);

/* ============================================================
   1. 行为：真跑 createModuleContext
   ============================================================ */
console.log('\n=== 1. 行为（jsdom 真跑） ===');

const { createModuleContext } = await import('./js/plugin-sdk.js');

/* 事件总线：最小实现，够 bus.on/emit 用 */
const mkBus = () => {
  const m = new Map();
  return {
    on(name, fn) { (m.get(name) || m.set(name, new Set()).get(name)).add(fn); return () => m.get(name)?.delete(fn); },
    emit(name, v) { for (const fn of m.get(name) || []) fn(v); },
  };
};

function mkCtx(manifest, openPluginImpl) {
  return createModuleContext({
    manifest,
    container: dom.window.document.getElementById('c'),
    bus: mkBus(),
    openArgs: null,
    openPlugin: openPluginImpl,
  });
}

/* ① 内置插件：宿主放行 */
let called = null;
const builtinCtx = mkCtx({ id: 'project-group', builtin: true }, (id, args) => {
  called = { id, args };
  return true;
});
t('ctx.openPlugin 是函数', typeof builtinCtx.openPlugin === 'function');
await builtinCtx.openPlugin('md', { path: 'D:/a.md' });
t('调用透传到宿主注入的函数', called?.id === 'md' && called?.args?.path === 'D:/a.md');
t('宿主返回 true 时 ctx 拿到 true',
  await builtinCtx.openPlugin('md', { path: 'x' }) === true);

/* ② 没注入时（iframe/未注入）：不抛错，返回 false */
const noImplCtx = mkCtx({ id: 'pg2', builtin: true }, null);
t('未注入时不抛错（抛了就是 unhandled rejection = 点了没反应）',
  typeof noImplCtx.openPlugin === 'function');
let threw = false;
let r2 = null;
try { r2 = await noImplCtx.openPlugin('md', {}); } catch { threw = true; }
t('未注入时返回 false 而不是抛错', !threw && r2 === false, `→ threw=${threw} r=${r2}`);

/* ③ ctx 形状一致：同页也有 openArgs / onOpenArgs */
t('同页 ctx 仍有 openArgs', 'openArgs' in builtinCtx);
t('同页 ctx 仍有 onOpenArgs', typeof builtinCtx.onOpenArgs === 'function');

/* ============================================================
   2. 宿主侧：builtin 校验与返回值（契约 + 逻辑）
   ============================================================ */
console.log('\n=== 2. 宿主侧校验 ===');

t('宿主有 openWithArgsFor（带调用方的那一个）',
  /async function openWithArgsFor\(from, id, args\)/.test(hostC));
t('openWithArgsFor 校验 from.builtin', /if \(!from\?\.builtin\) return false;/.test(hostC));
t('校验在 return 之前（不校验就是提权口子）',
  hostC.indexOf('if (!from?.builtin) return false;') <
  hostC.indexOf('return await openWithArgs(id, args);'));

t('openWithArgs 目标不存在时返回 false（不返回会分不清原因）',
  /if \(!target\) return false;/.test(hostC));
t('已激活时走事件总线并返回 true',
  /bus\.emit\(`plugin:open-args:\$\{id\}`, args\);\s*\n\s*return true;/.test(hostC));
t('未激活时 mount 并返回 true', /await mount\(id, args\);\s*\n\s*return true;/.test(hostC));

t('iframe 桥接有 open-plugin 分支', /case 'open-plugin':/.test(hostC));
t('桥接分支同样校验 builtin（第三方沙箱不能绕过）',
  /case 'open-plugin': \{\s*\n\s*if \(!manifest\?\.builtin\)/.test(hostC));
t('拒绝时**回包**而不是只抛错（漏回会让调用方挂到超时）',
  /return reply\(false, false, '跨插件打开只允许内置插件使用'\);/.test(hostC));

/* ============================================================
   3. sdk 两条通路
   ============================================================ */
console.log('\n=== 3. sdk 通路 ===');

t('sdk 里 openPlugin **只有一份**（两份则后者覆盖前者，注入的函数永远不被调用）',
  (sdkC.match(/\n    openPlugin\(/g) || []).length === 1,
  `→ ${(sdkC.match(/\n    openPlugin\(/g) || []).length} 份`);
t('优先用宿主注入的函数（同页不走消息）', /base\.openPlugin\s*\n\s*\? base\.openPlugin\(/.test(sdkC));
t('否则走桥接 open-plugin', /transport\.request\('open-plugin'/.test(sdkC));
/* 关键：外面套 Promise.resolve —— module 的 transport.request 是同步返回 */
t('套了 Promise.resolve（同步 transport 直接 .catch 会 TypeError）',
  /return Promise\.resolve\([\s\S]{0,200}?\)\.catch\(\(\) => false\);/.test(sdkC));
t('返回 false 而不是抛错', /\.catch\(\(\) => false\)/.test(sdkC));

/* ============================================================
   4. project-group 触发源
   ============================================================ */
console.log('=== 4. project-group 触发源 ===');

t('有 readMarkdown', /const readMarkdown = useCallback/.test(pgC));
t('调 ctx.openPlugin(\'md\', { path })',
  /ctx\.openPlugin\?\.\('md', \{ path: contentSel\.path \}\)/.test(pgC));
t('只认 md/markdown/txt（拿二进制去读是一堆乱码且不报错）',
  /\\\.\(md\|markdown\|mdown\|mkd\|txt\)\$\/i/.test(pgC));
t('未选中时提示而不是静默',
  /if \(!contentSel\) \{\s*\n\s*ctx\.toast\('请先在内容浏览里选中一个条目'/.test(pgC));
/* 返回的 false 必须被处理：不打理就是"点了没反应" */
t('openPlugin 返回 false 时有提示（不静默）',
  /if \(!ok\) \{[\s\S]{0,160}?打开 Markdown 阅读器失败/.test(pgC));
t('头部有「阅读」按钮', /onClick=\{readMarkdown\}/.test(pgC));
t('按钮未选中时 disabled（禁用而非隐藏）',
  /disabled=\{!contentSel\}\s*\n\s*onClick=\{readMarkdown\}/.test(pgC));
t('阅读按钮与编辑按钮并存',
  /onClick=\{openMarkdown\}/.test(pgC) && /onClick=\{readMarkdown\}/.test(pgC));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
