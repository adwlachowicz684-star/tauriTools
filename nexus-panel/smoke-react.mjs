/**
 * React 外壳冒烟测试（开发用，可删）
 * ------------------------------------------------------------
 * 用 esbuild 把 TSX 外壳打成 CJS，再放进 jsdom 里跑：
 * 验证注册表加载 → 侧边栏渲染 → 同页插件挂载 → 交互 / 持久化 / 角标。
 */
import { JSDOM } from 'jsdom';
import { createRequire as _cr } from 'node:module';
const _req = _cr(import.meta.url);
const esbuild = _req(process.env.ESBUILD_PATH || '/data/workspace/.deps/node_modules/esbuild');
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
/* 产物必须落在项目目录内：若放 /tmp，它 require('react') 会解析到全局副本，
   而本脚本从项目目录解析到的是本地副本 —— 两份 React 同时存在就会
   报 "Invalid hook call"。同目录才能保证拿到同一份。 */
const OUT = new URL('./.smoke-react.cjs', import.meta.url).pathname;

await esbuild.build({
  entryPoints: [path.join(HERE, 'src/App.tsx')],
  bundle: true,
  outfile: OUT,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react-dom/client'],
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(HERE, 'js/host.js')).href) },
  logLevel: 'error',
});

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="toasts"></div></body></html>', {
  url: pathToFileURL(path.join(HERE, 'index.html')).href,
  pretendToBeVisual: true,
});

const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
globalThis.navigator = w.navigator;
globalThis.location = w.location;
globalThis.HTMLElement = w.HTMLElement;
globalThis.Node = w.Node;
globalThis.Event = w.Event;
globalThis.MouseEvent = w.MouseEvent;
globalThis.getComputedStyle = w.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

// file/http 下 jsdom 的 localStorage 不可用 → 内存桩
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
  key: (i) => [..._ls.keys()][i] ?? null,
  get length() { return _ls.size; },
};
Object.defineProperty(w, 'localStorage', { value: globalThis.localStorage, configurable: true });

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origError(...a); };

const App = require(OUT).default;
const React = require('react');
const { createRoot } = require('react-dom/client');

const root = createRoot(document.getElementById('root'));
root.render(React.createElement(App));

const tick = (ms = 300) => new Promise((r) => setTimeout(r, ms));
await tick(600);

const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];

console.log('侧边栏插件数:', qa('#plugin-list .nav-item').length,
  qa('#plugin-list .nav-label').map((e) => e.textContent).join(', '));
console.log('窗口标题栏:', q('.tb-brand span')?.textContent, '| 内容区标题:', q('#plugin-bar h1')?.textContent);

// 切到「示例·同页」插件（原生 JS，jsdom 里可运行）
const target = qa('#plugin-list .nav-item').find((b) => b.textContent.includes('示例·同页'));
console.log('找到同页示例插件:', !!target);
target?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await tick(500);

const stage = q('#stage-scroll');
console.log('同页插件挂载:', /计数器/.test(stage.textContent));
const btn = qa('#stage-scroll button').find((b) => b.textContent.includes('＋'));
btn?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await tick(200);
console.log('计数器:', stage.querySelector('.num')?.textContent,
  '| 持久化:', localStorage.getItem('nexus:demo-module:count'));
console.log('侧边栏角标:', qa('.nav-badge').map((e) => e.textContent).filter(Boolean).join(','));

// 切到 iframe 插件，验证 iframe 被创建（jsdom 不会加载页面，只验证宿主行为）
const iframePlugin = qa('#plugin-list .nav-item').find((b) => b.textContent.includes('示例·React'));
iframePlugin?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await tick(400);
console.log('iframe 已插入:', !!q('#stage-scroll iframe'), '| src:', q('#stage-scroll iframe')?.getAttribute('src'));

console.log('主题已应用:', document.documentElement.dataset.theme,
  '| 基调:', document.documentElement.dataset.themeBase,
  '| --bg:', document.documentElement.style.getPropertyValue('--bg'));

/* ---- window.__NEXUS__：与原生外壳（js/shell.js）对齐的字段清单 ---- */
const nexus = w.__NEXUS__ || {};
const NEXUS_KEYS = [
  'state', 'bus', 'toast', 'navigate', 'removePlugin', 'getPlugins',
  'mountPlugin', 'getInstance', 'openPluginSettings', 'closePluginSettings',
  'external', 'theme',
];
const missing = NEXUS_KEYS.filter((k) => nexus[k] === undefined);
console.log('__NEXUS__ 字段:', missing.length ? `❌ 缺少 ${missing.join(', ')}` : `✅ ${NEXUS_KEYS.length} 项齐全`);

const fnOf = (obj, keys) => keys.filter((k) => typeof obj?.[k] !== 'function');
const extMiss = fnOf(nexus.external, ['loadPolicy', 'savePolicy', 'listHosts', 'setHostStatus', 'removeHost', 'suggestCsp', 'rescanAll', 'scanPlugin', 'setRefreshHandler']);
console.log('external 外链管理:', extMiss.length ? `❌ 缺少 ${extMiss.join(', ')}` : '✅ 策略+扫描+刷新回调齐全');
const themeMiss = fnOf(nexus.theme, ['applyTheme', 'setAccent', 'getCurrent', 'exportVars', 'getBase']);
console.log('theme 主题 API:', themeMiss.length ? `❌ 缺少 ${themeMiss.join(', ')}` : '✅ 与原生外壳一致');

/* ---- 插件设置链路：「⚙ 设置」→ 抽屉 → 关闭 ---- */
const modPlugin = qa('#plugin-list .nav-item').find((b) => b.textContent.includes('示例·同页'));
modPlugin?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await tick(600);

const setBtn = qa('#plugin-bar .bar-btn').find((b) => b.textContent.includes('设置'));
console.log('「⚙ 设置」按钮出现:', !!setBtn);
setBtn?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await tick(800);

const drawer = q('.drawer-mask');
console.log('抽屉已打开:', !!drawer, '| 标题:', q('.drawer .drawer-title h2')?.textContent?.trim());
console.log('外壳开关区块:', q('.drawer .p-card h2')?.textContent ?? '(无)');
const bodyText = (q('.drawer-body')?.textContent || '').replace(/\s+/g, ' ').trim();
console.log('设置面板容器:', bodyText ? bodyText.slice(0, 40) : '(空)');

w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await tick(300);
console.log('Esc 后抽屉已销毁:', !q('.drawer-mask'));

/* ---- 卸载：登记过的 setTimeout 不再触发，且不抛错 ---- */
const beforeUnmount = errors.length;
root.unmount();
await tick(3000);
console.log('卸载后无新增错误:', errors.length === beforeUnmount);

console.log(errors.length ? '⚠ 控制台错误: ' + errors.slice(0, 3).join(' | ') : '✅ 无运行时错误');
process.exit(0);
