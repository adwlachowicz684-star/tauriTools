/**
 * React 外壳冒烟测试（开发用，可删）
 * ------------------------------------------------------------
 * 用 esbuild 把 TSX 外壳打成 CJS，再放进 jsdom 里跑：
 * 验证注册表加载 → 侧边栏渲染 → 同页插件挂载 → 交互 / 持久化 / 角标。
 */
import { JSDOM } from 'jsdom';
import { createRequire as _cr } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 路径基准取自本文件位置，避免换目录名 / 换机器后全部路径失效
const HERE = path.dirname(fileURLToPath(import.meta.url));
const _req = _cr(import.meta.url);
// esbuild 不在依赖里，优先按包名解析，回退到环境变量/旧路径
const esbuild = await (async () => {
  for (const p of [process.env.ESBUILD_PATH, 'esbuild', '/data/workspace/.deps/node_modules/esbuild']) {
    if (!p) continue;
    try { return _req(p); } catch { /* 继续尝试下一个 */ }
  }
  throw new Error('找不到 esbuild，请设 ESBUILD_PATH 或安装到 node_modules');
})();
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OUT = '/tmp/nexus-smoke.cjs';

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

console.log(errors.length ? '⚠ 控制台错误: ' + errors.slice(0, 3).join(' | ') : '✅ 无运行时错误');
process.exit(0);
