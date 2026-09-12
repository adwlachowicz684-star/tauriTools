/**
 * 冒烟测试（仅开发用，可删）：用 jsdom 跑一遍外壳，
 * 验证：注册表加载 → 侧边栏渲染 → 同页插件挂载 → 事件/持久化。
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 路径基准取自本文件位置，而非写死的绝对路径或 cwd：
// 否则换目录名 / 换机器 / CI checkout 到别的名字时，所有 module 插件
// 都会报「无法加载插件入口」，看起来像代码坏了，实际是测试路径问题。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(HERE, 'index.html');

const html = fs.readFileSync(INDEX_HTML, 'utf8');
const dom = new JSDOM(html, {
  url: pathToFileURL(INDEX_HTML).href,
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
// file:// 下 jsdom 的 localStorage 不可用，用内存桩替代
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
  key: (i) => [..._ls.keys()][i] ?? null,
  get length() { return _ls.size; },
};
globalThis.navigator = dom.window.navigator;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.getComputedStyle = dom.window.getComputedStyle;

// jsdom 默认不执行 <script>，而 index.html 里的 __NEXUS_NO_BUILD__ 标记就是靠
// 内联脚本设置的。这里显式补上，让测试跑在「无构建（原生）」分支上。
dom.window.__NEXUS_NO_BUILD__ = true;
globalThis.__NEXUS_NO_BUILD__ = true;

const errors = [];
dom.window.addEventListener('error', (e) => errors.push(e.message));

await import('./js/shell.js');
await new Promise((r) => setTimeout(r, 400));

const N = globalThis.window.__NEXUS__;
const plugins = N?.getPlugins() || [];
console.log('插件数:', plugins.length, plugins.map((p) => p.id).join(', '));
console.log('侧边栏项:', document.querySelectorAll('#plugin-list .nav-item').length);
console.log('当前插件:', N?.state.activeId);
console.log('hash:', location.hash);
console.log('舞台内容长度:', document.querySelector('#stage-scroll').innerHTML.length);
console.log('标题栏标题:', document.querySelector('#bar-title').textContent);

// 切到示例同页插件，验证挂载 + 交互
N.navigate('demo-module');
await new Promise((r) => setTimeout(r, 300));
const stage = document.querySelector('#stage-scroll');
console.log('demo-module 挂载:', stage.textContent.includes('计数器'));

const btn = [...stage.querySelectorAll('button')].find((b) => b.textContent.includes('＋'));
btn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 120));
console.log('计数器点击后:', stage.querySelector('.num')?.textContent);
console.log('持久化:', localStorage.getItem('nexus:demo-module:count'));
console.log('角标:', JSON.stringify(N.state.badges));

// 注意：jsdom 不会真正加载 iframe 子文档，iframe 挂载路径无法在此验证。
// iframe 的主题适配逻辑由 adapt-test.mjs 单独覆盖。

// 切到设置插件
N.navigate('settings');
await new Promise((r) => setTimeout(r, 250));
console.log('settings 挂载:', document.querySelector('#stage-scroll').textContent.includes('插件管理'));

console.log(errors.length ? '❌ 运行时错误: ' + errors.join(' | ') : '✅ 无运行时错误');
process.exit(0);
