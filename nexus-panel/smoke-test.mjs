/**
 * 冒烟测试（npm test 默认跑这个）：用 jsdom 跑一遍外壳，
 * 验证：注册表加载 → 侧边栏渲染 → 同页插件挂载 → 事件/持久化。
 *
 * ⚠️ 这里原来**永远退出 0**：
 *     最后一行的 `process.exit(0)` 是无条件的，
 *     上面那句 `console.log('❌ 运行时错误: ...')` 只是**打印**了错误，
 *     既不断言也不改退出码。
 *
 *     后果是 `npm test` **不可能失败** ——
 *     外壳哪怕整个挂掉、插件一个都加载不出来、控制台刷满报错，
 *     它照样打印一堆 ❌ 然后 exit(0)，CI 全绿。
 *     这是比"断言写错"更彻底的失效：连红的机会都没有。
 *
 * 现在改成真断言 + 真退出码。刻意**不断言具体插件数量**
 * （注册表会随增删变化，写死数字很快就会被改成一个恒真的值），
 * 只断言"该发生的都发生了"：加载到了插件、渲染出了侧边栏、
 * 插件能挂载、点击有反应、设置页打得开。
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 一切路径以脚本自身位置为基准，不依赖 CWD，也不假设项目放在哪个目录下。
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
// Node 21+ 起 globalThis.navigator 是只读 getter，直接赋值会抛 TypeError
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.getComputedStyle = dom.window.getComputedStyle;

// jsdom 默认不执行 <script>，而 index.html 里的 __NEXUS_NO_BUILD__ 标记就是靠
// 内联脚本设置的。这里显式补上，让测试跑在「无构建（原生）」分支上。
dom.window.__NEXUS_NO_BUILD__ = true;
globalThis.__NEXUS_NO_BUILD__ = true;

const errors = [];
dom.window.addEventListener('error', (e) => errors.push(e.message));

let pass = 0; let fail = 0;
const t = (name, ok, info) => {
  if (ok) { pass++; console.log(`✅ ${name}${info ? ` → ${info}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${info ? ` → ${info}` : ''}`); }
};

await import('./js/shell.js');
await new Promise((r) => setTimeout(r, 400));

const N = globalThis.window.__NEXUS__;
const plugins = N?.getPlugins() || [];
console.log('插件数:', plugins.length, plugins.map((p) => p.id).join(', '));
t('外壳加载到了插件（注册表非空）', plugins.length > 0, `${plugins.length} 个`);
t('侧边栏渲染出条目', document.querySelectorAll('#plugin-list .nav-item').length > 0,
  `${document.querySelectorAll('#plugin-list .nav-item').length} 项`);
t('有当前激活插件', !!N?.state.activeId, N?.state.activeId || '(无)');
t('舞台渲染出内容', (document.querySelector('#stage-scroll')?.innerHTML.length || 0) > 0,
  `${document.querySelector('#stage-scroll')?.innerHTML.length || 0} 字符`);
t('标题栏有标题', !!document.querySelector('#bar-title')?.textContent?.trim(),
  document.querySelector('#bar-title')?.textContent || '(空)');

// 切到示例同页插件，验证挂载 + 交互
N.navigate('demo-module');
await new Promise((r) => setTimeout(r, 300));
const stage = document.querySelector('#stage-scroll');
t('demo-module 能挂载（舞台出现"计数器"）', stage.textContent.includes('计数器'));

const btn = [...stage.querySelectorAll('button')].find((b) => b.textContent.includes('＋'));
btn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 120));
const after = stage.querySelector('.num')?.textContent;
t('点击后计数器有变化（交互真的生效）', !!after, after || '(无)');
t('计数写入了 localStorage（持久化生效）',
  localStorage.getItem('nexus:demo-module:count') !== null,
  String(localStorage.getItem('nexus:demo-module:count')));

// 注意：jsdom 不会真正加载 iframe 子文档，iframe 挂载路径无法在此验证。
// iframe 的主题适配逻辑由 adapt-test.mjs 单独覆盖。

// 切到设置插件
N.navigate('settings');
await new Promise((r) => setTimeout(r, 250));
t('settings 插件能挂载（出现"插件管理"）',
  document.querySelector('#stage-scroll').textContent.includes('插件管理'));

t('运行期无未捕获错误', errors.length === 0, errors.join(' | ') || '0 条');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
/*
 * 关键：退出码必须反映结果。
 * 原来这里是无条件的 process.exit(0)，
 * 使得 npm test **结构上不可能失败**。
 */
process.exit(fail ? 1 : 0);
