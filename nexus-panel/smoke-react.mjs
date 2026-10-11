/**
 * React 外壳冒烟测试（开发用，可删）
 * ------------------------------------------------------------
 * 用 esbuild 把 TSX 外壳打成 CJS，再放进 jsdom 里跑：
 * 验证注册表加载 → 侧边栏渲染 → 同页插件挂载 → 交互 / 持久化 / 角标。
 */
import { JSDOM } from 'jsdom';
import { createRequire as _cr } from 'node:module';
const _req = _cr(import.meta.url);
/* esbuild 已声明在 devDependencies（此前只靠 vite 间接带一份，换台机器
   或换个包管理器就解析不到）。解析顺序：ESBUILD_PATH 环境变量 → 本地
   node_modules。
   ⚠️ 这里**不能再加写死的绝对路径兜底** —— 原先写着
   /data/workspace/.deps/node_modules/esbuild，那是某台机器上的路径，
   在别人机器上和 CI 上都没有意义。缺包就该明确报错让人 npm install，
   而不是悄悄去碰一个不存在的目录。 */
function loadEsbuild() {
  if (process.env.ESBUILD_PATH) return _req(process.env.ESBUILD_PATH);
  try {
    return _req('esbuild');
  } catch {
    throw new Error('缺 esbuild：请先 npm install（它已声明在 devDependencies）');
  }
}
const esbuild = loadEsbuild();
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
/* 产物必须落在项目目录内：若放 /tmp，它 require('react') 会解析到全局副本，
   而本脚本从项目目录解析到的是本地副本 —— 两份 React 同时存在就会
   报 "Invalid hook call"。同目录才能保证拿到同一份。 */
// 必须用 fileURLToPath：new URL(...).pathname 在 Windows 上是 "/E:/..."
// （多一个前导斜杠），esbuild 会拿它去拼出 "…\nexus-panel\E:" 这种非法路径。
/* 产物名带 pid：并发跑（体检分片同时开十几个、或两人同时跑）时若都写同一个
   文件名，后启动的会把先启动的写一半的文件覆盖掉 —— 表现是"偶尔少几条断言"，
   而失败原因离"文件名撞了"很远。落 .tool_output/ 是它已在 .gitignore 里。
   退出时删掉，避免每次跑完多一个几十 KB 的残留。 */
const OUT_DIR = fileURLToPath(new URL('./.tool_output/', import.meta.url));
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, `smoke-react.${process.pid}.cjs`);
process.on('exit', () => { try { fs.unlinkSync(OUT); } catch { /* 已删就无所谓 */ } });

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
// Node 21+ 起 globalThis.navigator 是只读 getter，直接赋值会抛 TypeError
Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true, writable: true });
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
/* 等"条件成立"，而不是"睡固定时长"。
   ⚠️ 旧版全程固定 tick：机器一忙（体检 12 个分片并发）挂载就会超时，
   表现为 4 条断言偶发失败、单独重跑又全绿 —— 假失败会让人去查界面逻辑，
   而真因只是"这次慢了两百毫秒"。轮询到成立才继续，慢机器与 CI 都稳。 */
const waitFor = async (fn, { timeout = 8000, interval = 20 } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let v = false;
    try { v = fn(); } catch { v = false; }
    if (v) return true;
    await tick(interval);
  }
  return false;
};
/* 首次渲染：等"侧边栏真的渲染出来"，而不是睡固定时长。
   实测：8 个 CPU 占满时固定 600ms 不够，侧边栏还是 0 项 → 6 条断言一起假失败。 */
await waitFor(() => document.querySelectorAll('#plugin-list .nav-item').length > 0);
/* 再等默认插件（概览，.tsx 入口）把加载尝试的结果报出来。
   ⚠️ 这里等的是"出现了报错"，下面断言的是"报错里能筛出 TSX 那一类"：
   两者不是同一件事 —— 筛正则若写错、一条都筛不出来，这里会空等 8 秒
   然后照样判红，不会变成恒真的假绿。 */
await waitFor(() => errors.length > 0, { timeout: 8000 });

const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];

/* 每条观察都必须是断言，并且失败要让进程非 0 退出。
   ⚠️ 旧版只把结果 console.log 出来、末尾无条件 process.exit(0)：
      于是这里报什么问题都"通过"，体检单上看它永远是绿的，
      而它其实一条断言都没守（本项目反复出现的"崩/错 ≠ 红"）。 */
let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? ' → ' + detail : ''}`); }
  else { fails.push(name); console.log(`❌ ${name}${detail ? ' → ' + detail : ''}`); }
};

const navCount = qa('#plugin-list .nav-item').length;
ok('侧边栏渲染出插件列表', navCount > 0, `${navCount} 个：${qa('#plugin-list .nav-label').map((e) => e.textContent).join(', ')}`);

const brand = q('.tb-brand span')?.textContent;
ok('窗口标题栏有品牌名', brand === 'Nexus Panel', brand);
ok('内容区有插件标题', !!q('#plugin-bar h1')?.textContent, q('#plugin-bar h1')?.textContent);

// 切到「示例·同页」插件（原生 JS，jsdom 里可运行）
const target = qa('#plugin-list .nav-item').find((b) => b.textContent.includes('示例·同页'));
ok('找到同页示例插件', !!target);
target?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

const stage = q('#stage-scroll');
const mounted = await waitFor(() => /计数器/.test(stage.textContent));
ok('同页插件挂载', mounted, mounted ? '' : JSON.stringify(stage.textContent).slice(0, 160));
const btn = qa('#stage-scroll button').find((b) => b.textContent.includes('＋'));
btn?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await waitFor(() => stage.querySelector('.num')?.textContent === '1');
const num = stage.querySelector('.num')?.textContent;
const persisted = localStorage.getItem('nexus:demo-module:count');
ok('计数器点击后自增', num === '1', num);
ok('计数写入持久化', persisted === '1', persisted);
/* 角标是"概览"插件收到 demo:counter 广播后再渲染的，比计数本身晚一拍：
   计数变 1 之后角标还没出来是正常的，直接判就是偶发假失败。 */
const badged = await waitFor(() => qa('.nav-badge').map((e) => e.textContent).filter(Boolean).length > 0);
ok('侧边栏角标出现', badged, qa('.nav-badge').map((e) => e.textContent).filter(Boolean).join(','));

// 切到 iframe 插件，验证 iframe 被创建（jsdom 不会加载页面，只验证宿主行为）
const iframePlugin = qa('#plugin-list .nav-item').find((b) => b.textContent.includes('示例·React'));
iframePlugin?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await waitFor(() => !!document.querySelector('#stage-scroll iframe'));
ok('iframe 插件已插入', !!q('#stage-scroll iframe'), q('#stage-scroll iframe')?.getAttribute('src'));

ok('主题已应用到 documentElement',
  document.documentElement.dataset.theme === 'agentflow-dark' && document.documentElement.dataset.themeBase === 'dark',
  `${document.documentElement.dataset.theme} / ${document.documentElement.dataset.themeBase} / --bg=${document.documentElement.style.getPropertyValue('--bg')}`);

/* 控制台错误的处理必须分两类，不能一把豁免：
   · TSX 插件入口在纯 Node 下加载不了（要 vite 转译，Node 20 不认 .tsx）
     —— 这是**环境限制**不是缺陷，单列跳过并说明；
   · 除此之外的任何错误都是真失败。
   豁免写成"忽略全部 errors"的话，真错误会跟着一起被吞掉。 */
const TSX_LIMIT = /Unknown file extension "\.tsx"|无法加载插件入口：.*\.tsx/;
const tsxErrs = errors.filter((e) => TSX_LIMIT.test(e));
const otherErrs = errors.filter((e) => !TSX_LIMIT.test(e));
ok('除 Node 不认 .tsx 这类环境限制外，无运行时错误', otherErrs.length === 0, otherErrs.slice(0, 2).join(' | '));
// 元断言：豁免必须真的命中过。没命中说明上面的过滤条件是空转的，
// 那它就会把真错误也一并放过（"豁免必须真会豁免"）。
ok('TSX 豁免确实命中（否则等于放行一切）', tsxErrs.length > 0, `豁免 ${tsxErrs.length} 条`);

console.log(`\nReact 外壳冒烟：通过 ${pass} 项，失败 ${fails.length} 项（共 ${pass + fails.length} 项）`);
process.exit(fails.length ? 1 : 0);
