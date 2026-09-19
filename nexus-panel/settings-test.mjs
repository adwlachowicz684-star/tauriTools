/**
 * 插件设置面板测试（开发用，可删）
 * ------------------------------------------------------------
 * 覆盖两条路径：
 *   A. module 插件：引擎 mountSettings() 调 def.settings(ctx)，与主视图共享 store / 事件总线
 *   B. iframe 插件：SDK 的 view 分派协议（view='main' 走 mountFn，view='settings' 走 settingsFn）
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
globalThis.MouseEvent = dom.window.MouseEvent;
dom.window.__NEXUS_NO_BUILD__ = true;
globalThis.__NEXUS_NO_BUILD__ = true;

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await import('./js/shell.js');
await sleep(400);
const N = globalThis.window.__NEXUS__;

/* ============ A. module 插件设置面板 ============ */
console.log('\n--- A. 同页（module）插件设置面板 ---');

N.navigate('demo-module');
await sleep(350);

const btn = document.querySelector('#bar-plugin-settings');
t('声明了 settings 的插件：设置按钮已显示', btn && !btn.hidden);

// 点击设置按钮 → 抽屉滑出 → 引擎把插件的 settings(ctx) 挂进去
btn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep(500);

const drawer = document.querySelector('#drawer-mask .drawer');
t('点击设置按钮后抽屉打开', !!drawer);

const drawerBody = document.querySelector('#dw-body');
t('设置面板内容已渲染', !!drawerBody && /同页插件设置/.test(drawerBody.textContent),
  drawerBody?.textContent?.slice(0, 26).replace(/\s+/g, ' '));
t('抽屉标题显示插件名', /示例·同页/.test(document.querySelector('.drawer-title')?.textContent || ''));

// 修改设置：关掉心跳 → 保存 → 主视图应收到广播
const toggle = [...drawerBody.querySelectorAll('button')]
  .find((b) => /已开启|已关闭/.test(b.textContent));
t('设置面板含开关控件', !!toggle, toggle?.textContent);

if (toggle) {
  const before = localStorage.getItem('nexus:demo-module:heartbeat');
  toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  const after = localStorage.getItem('nexus:demo-module:heartbeat');
  t('改动已写入插件专属 store', before !== after, `${before} → ${after}`);
}

const saveBtn = [...drawerBody.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存');
saveBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep(150);

const stage = document.querySelector('#stage-scroll');
t('主视图收到配置广播（设置→主视图联动）',
  /配置已更新/.test(stage.textContent),
  (stage.textContent.match(/配置已更新[^\n]*/) || [''])[0].slice(0, 40));

// 关闭抽屉
document.querySelector('#dw-close')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep(150);
t('抽屉可关闭', !document.querySelector('#drawer-mask'));

/* ============ B. 未声明 settings 的插件：按钮仍显示，抽屉只给外壳设置 ============
   此前按钮只在插件自带设置面板时才显示，于是大部分插件（home、agent-flow 等）
   根本没有入口。现在「⚙ 设置」对每个插件都显示：抽屉里除了插件自定义设置，
   还有外壳固定提供的沙箱 / 主题适配开关，对任何插件都有意义。 */
console.log('\n--- B. 未声明 settings 的插件 ---');
N.navigate('demo-iframe');
await sleep(600);
const btn2 = document.querySelector('#bar-plugin-settings');
t('切到无设置插件后按钮仍显示（外壳设置对每个插件都可用）', !!btn2 && !btn2.hidden);

/* 关键陷阱：插件没提供 settingsFn 时，SDK 会**回退 mainFn**
   （js/plugin-sdk.js:641）—— 若外壳照常调 mountSettings，抽屉里显示的
   会是插件主界面而不是设置。所以这里必须断言"出现了占位提示"，
   它间接证明外壳没有走引擎兜底。 */
btn2?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep(600);
t('无设置插件也能打开抽屉', !!document.querySelector('#drawer-mask'));
t('抽屉显示占位提示，而非把插件主视图塞进来',
  !!document.querySelector('#drawer-mask .drawer-empty'));
document.querySelector('#dw-close')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep(150);
t('关闭后抽屉已移除', !document.querySelector('#drawer-mask'));

/* ============ C. iframe SDK 的 view 分派协议 ============ */
console.log('\n--- C. iframe SDK 的视图分派协议 ---');

const sdkDom = new JSDOM('<!doctype html><html><body><div id="plugin-mount"></div></body></html>', {
  url: 'http://localhost/x',
});
const posted = [];
let handler = null;
sdkDom.window.addEventListener('message', (e) => handler?.(e));
// 拦截插件发往 parent 的消息
sdkDom.window.parent.postMessage = (msg) => {
  posted.push(msg);
  if (msg.type === 'ready') {
    sdkDom.window.__hasSettings = msg.hasSettings;
  }
};

const savedWindow = globalThis.window;
const savedDoc = globalThis.document;
globalThis.window = sdkDom.window;
globalThis.document = sdkDom.window.document;
globalThis.Node = sdkDom.window.Node;
globalThis.HTMLElement = sdkDom.window.HTMLElement;

let mainCalled = 0, settingsCalled = 0;
const { bootIframePlugin } = await import('./js/plugin-sdk.js');
bootIframePlugin(
  async () => { mainCalled++; return () => {}; },
  async () => { settingsCalled++; return () => {}; },
);

const deliver = (data) => {
  // e.source 必须是 SDK 认定的宿主窗口：SDK 侧有 `e.source !== window.parent` 校验
  const ev = new sdkDom.window.MessageEvent('message', { data, source: sdkDom.window.parent });
  sdkDom.window.dispatchEvent(ev);
};

// 主视图
deliver({ channel: 'nexus-bridge-v1', type: 'init', manifest: { id: 'p', version: '1' }, theme: {}, view: 'main' });
deliver({ channel: 'nexus-bridge-v1', type: 'mount' });
await sleep(60);
t("view='main' 调用主视图函数", mainCalled === 1 && settingsCalled === 0, `main=${mainCalled} settings=${settingsCalled}`);
t('ready 上报 hasSettings=true', sdkDom.window.__hasSettings === true);

// 设置视图（再开一个页面实例）
mainCalled = 0; settingsCalled = 0;
const sdkDom2 = new JSDOM('<!doctype html><html><body><div id="plugin-mount"></div></body></html>', { url: 'http://localhost/x' });
let posted2 = [];
sdkDom2.window.parent.postMessage = (msg) => {
  posted2.push(msg);
  if (msg.type === 'ready') sdkDom2.window.__hasSettings = msg.hasSettings;
};
globalThis.window = sdkDom2.window;
globalThis.document = sdkDom2.window.document;
bootIframePlugin(
  async () => { mainCalled++; },
  async () => { settingsCalled++; },
);
const deliver2 = (data) => sdkDom2.window.dispatchEvent(
  new sdkDom2.window.MessageEvent('message', { data, source: sdkDom2.window.parent }));
deliver2({ channel: 'nexus-bridge-v1', type: 'init', manifest: { id: 'p' }, theme: {}, view: 'settings' });
deliver2({ channel: 'nexus-bridge-v1', type: 'mount' });
await sleep(60);
t("view='settings' 调用设置函数", settingsCalled === 1 && mainCalled === 0, `main=${mainCalled} settings=${settingsCalled}`);
t('mounted 回执带上 view', posted2.some((m) => m.type === 'mounted' && m.view === 'settings'));

// 未提供 settingsFn 时，设置视图回退到主视图，且 hasSettings 为 false
const sdkDom3 = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/x' });
sdkDom3.window.parent.postMessage = (msg) => {
  if (msg.type === 'ready') sdkDom3.window.__hasSettings = msg.hasSettings;
};
globalThis.window = sdkDom3.window;
globalThis.document = sdkDom3.window.document;
let onlyMain = 0;
bootIframePlugin(async () => { onlyMain++; });
const deliver3 = (d) => sdkDom3.window.dispatchEvent(new sdkDom3.window.MessageEvent('message', { data: d, source: sdkDom3.window.parent }));
deliver3({ channel: 'nexus-bridge-v1', type: 'init', manifest: { id: 'p' }, theme: {}, view: 'settings' });
deliver3({ channel: 'nexus-bridge-v1', type: 'mount' });
await sleep(60);
t('未提供 settingsFn：hasSettings=false', sdkDom3.window.__hasSettings === false);
t('未提供 settingsFn：回退到主视图而非开空面板', onlyMain === 1, `调用 ${onlyMain} 次`);

/* ============================================================
   D. 设置页：快捷键总览 + 插件分区 + 竖排导航
   ============================================================ */
console.log('\n--- D. 设置页内容与显示 ---');
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const app = src('plugins/settings/App.tsx');
const idx = src('plugins/settings/index.js');
const css = src('css/neumorphism.css');
const scSrc = src('js/shell-shortcuts.js');

/* ---------- D1. 外壳快捷键单一数据源 ---------- */
t('存在外壳快捷键清单模块', scSrc.includes('SHELL_SHORTCUT_SPECS'));
t('React 设置页 import 了该清单', /from '\.\.\/\.\.\/js\/shell-shortcuts\.js'/.test(app));
t('原生设置页也 import 了（两个设置页不能只改一边）',
  /from '\.\.\/\.\.\/js\/shell-shortcuts\.js'/.test(idx));
/* 执行逻辑仍在各自外壳 —— 表只管展示，注释里必须写清，
   否则后来者会以为改表就能改行为 */
t('清单模块声明自己不参与执行', /不参与执行/.test(scSrc));

/* ---------- D2. 两个外壳暴露 getShortcuts ---------- */
t('React 外壳 __NEXUS__ 暴露 getShortcuts',
  /getShortcuts: \(\) => hostRef\.current\?\.getShortcuts\?\.\(\)/.test(src('src/App.tsx')));
t('原生外壳 __NEXUS__ 暴露 getShortcuts', /getShortcuts:/.test(src('js/shell.js')));
t('读不到时设置页显示「未连接到外壳」而不是假装没有',
  /未连接到外壳（沙箱隔离态），读不到插件注册的快捷键/.test(app)
  && /未连接到外壳（沙箱隔离态），读不到插件注册的快捷键/.test(idx));

/* ---------- D3. 撞车判断 ---------- */
t('有撞车检测（与外壳键）', /taken\.has\(normCombo\(accel\)\)/.test(app));
/* 撞车只能**算一次**：行内各判一遍的话，两边判据迟早写得不一样，
   于是列表标红而计数说 0 处 —— 自相矛盾比漏判更难发现。 */
t('撞车集合只算一次，行内复用（不各判一遍）',
  /const clashSet = new Set\(clashes\.map/.test(app)
  && /const clash = clashSet\.has\(accel\);/.test(app)
  && !/const clash = taken\.has\(normCombo\(accel\)\);/.test(app));
t('有插件之间撞车检测', /ids\.length > 1/.test(app) && /ids\.length > 1/.test(idx));
t('撞车会给出后果说明（外壳那个会失效）', /外壳那个会失效/.test(app));
/* mod 必须按平台展开，否则 Windows 上 Ctrl+B 与 mod+B 判成两个键 */
t('normCombo 把 mod 按平台展开（非 Mac 展开成 ctrl）', /p === 'mod' \? \(isMac\(\) \? 'meta' : 'ctrl'\)/.test(scSrc));

/* ---------- D4. 第三类必须说明 ---------- */
t('说明插件内部快捷键不在此列出（否则用户以为页面漏了）',
  /外壳看不到，这里也列不出来/.test(app) && /外壳看不到，这里也列不出来/.test(idx));

/* ---------- D5. 插件按 kind 分区 ----------
 * 原断言钉的是 `kind !== 'service'`（两区）。
 * 加了 kind:'toolbar' 后那种写法会把工具栏插件算成 app ——
 * 它不在侧边栏，却被列在"应用插件 · 显示在侧边栏"下面。
 * 所以改为按 kind 精确三分区（详见 G 节）。 */
t('React 版按 kind 分区（不是"非 service 即 app"）',
  !/p\.kind !== 'service'/.test(app) && /p\.kind === 'app'/.test(app));
t('原生版同样分区',
  !/p\.kind !== 'service'/.test(idx) && /p\.kind === 'app'/.test(idx));
t('服务区说明不进侧边栏的调用方式', /ctx\.services\.call 调用/.test(app));

/* ---------- D6. 竖排导航 ---------- */
/*
 * 跨块匹配的大跨度正则会被**下一个块**蒙混：
 * `\.set-wrap \{[\s\S]{0,200}display: flex;` 在 set-wrap 改成 block 之后，
 * 仍能匹配到紧随其后的 `.set-tabs { display: flex;` —— 断言永远绿。
 * 所以必须先**切出这一块**再匹配。
 */
const block = (sel) => {
  const i = css.indexOf(sel + ' {');
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
};
t('标签栏竖排（flex-direction: column）',
  /flex-direction: column;/.test(block('.set-tabs')));
t('有横向包裹容器', /display: flex;/.test(block('.set-wrap')));
t('内容区 min-width:0（否则长路径把这一列撑破、挤走导航）',
  /min-width: 0;/.test(block('.set-body')));
t('React 页渲染了 set-wrap', /className="set-wrap"/.test(app));
/* CSS 必须放 neumorphism.css —— settings.css 是 iframe 专用、同页不加载 */
t('CSS 放在 neumorphism.css 而非 settings.css',
  /\.set-wrap/.test(css) && !/\.set-wrap/.test(src('plugins/settings/settings.css')));

/* ---------- D7. 标签页新增「快捷键」 ---------- */
t('React 版 TabKey 含 shortcuts', /'shortcuts'/.test(app));
t('原生版 TABS 含 shortcuts', /'\[shortcuts', '快捷键'\]/.test(idx) || /\['shortcuts', '快捷键'\]/.test(idx));
t('原生版 pages 含 shortcuts（否则点标签是空白）', /shortcuts: h\('div', \{\}\)/.test(idx));
t('「关于」页指向完整列表', /完整列表见「快捷键」标签页/.test(app));

/* ---------- D8. 行为验证：撞车真的能被判出来 ---------- */
{
  const mod = await import('./js/shell-shortcuts.js');
  const set = mod.shellComboSet();
  t('外壳键集合非空', set.size >= 5, String(set.size));
  // 非 Mac 环境下 mod+b 归一化后应为 ctrl+b
  const n = mod.normCombo('mod+b');
  t('mod+b 归一化后是 ctrl+b 或 meta+b（按平台）',
    n === 'ctrl+b' || n === 'meta+b', n);
  t('Ctrl+B 与 mod+b 在非 Mac 上判定为同一键',
    mod.isMac() ? set.has(mod.normCombo('mod+b')) : set.has(mod.normCombo('Ctrl+B')));
  t('不相关的键不误报', !set.has(mod.normCombo('ctrl+shift+k')));
}

globalThis.window = savedWindow;
globalThis.document = savedDoc;

/* ================================================================
   E. 插件行对齐：内置 / 移除 必须同宽
   ================================================================
   名称列是 flex:1，会吃掉所有剩余空间。末尾一格宽度一变，
   被挤掉的量全部转成右侧各格的位移 —— 表现为「跟随全局」下拉框
   在内置行与非内置行之间左右错位。 */
console.log('\n--- E. 插件行末尾定宽 ---');
{
  const css = src('css/neumorphism.css');
  const react = src('plugins/settings/App.tsx');
  const native = src('plugins/settings/index.js');

  /*
   * CSS 要按**块**取：整份文件里 .set-tabs / .set-body 各有多处提及，
   * 直接 /width:\s*\d+/ 全文匹配会命中别的规则（假绿）。
   */
  const block = (sel) => {
    const i = css.indexOf(sel + ' {');
    if (i < 0) return '';
    return css.slice(i, css.indexOf('}', i));
  };
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');

  const act = strip(block('.p-slot-act'));
  const audit = strip(block('.p-slot-audit'));
  t('CSS 有 .p-slot-act 定宽', /width:\s*\d+px/.test(act), act.match(/width:[^;]*/)?.[0] || '（无）');
  t('.p-slot-act 不参与伸缩（flex:none）', /flex:\s*none/.test(act));
  t('CSS 有 .p-slot-audit 定宽', /width:\s*\d+px/.test(audit), audit.match(/width:[^;]*/)?.[0] || '（无）');

  /* 两个外壳都要真的套上这个格子 —— 只改 CSS 不套类是没效果的 */
  t('React 版：内置/移除 套进 .p-slot-act', /className="p-slot-act"/.test(react));
  t('原生版：内置/移除 套进 .p-slot-act', /span\.p-slot-act/.test(native));
  t('React 版：样式徽标套进 .p-slot-audit', /className="p-slot-audit"/.test(react));
  t('徽标按钮撑满格子（宽度不再随字数变）',
    /\.p-slot-audit > button\s*\{\s*width:\s*100%/.test(strip(css)));
}

/* ================================================================
   F. 竖排导航：两个外壳同结构 + 高度够
   ================================================================ */
console.log('\n--- F. 设置页竖排导航 ---');
{
  const css = src('css/neumorphism.css');
  const react = src('plugins/settings/App.tsx');
  const native = src('plugins/settings/index.js');
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (sel) => {
    const i = css.indexOf(sel + ' {');
    if (i < 0) return '';
    return css.slice(i, css.indexOf('}', i));
  };
  const tab = strip(block('.set-tab'));

  const h = Number((tab.match(/height:\s*(\d+)px/) || [])[1] || 0);
  /*
   * 32px 是横排时代的高度（一行挤 7 个必须压着）。
   * 竖排后每个独占一行，沿用它会显得又扁又挤。
   */
  t('竖排页签高度高于横排时代的 32px', h > 32, `${h}px`);
  t('选中态有左侧强调色竖条（用 ::before，不用 border-left）',
    /\.set-tab\.active::before/.test(css) && /content:\s*''/.test(css));
  t('不用 border-left（会把文字往右推、与其余项错位）',
    !/border-left/.test(strip(block('.set-tab.active'))));
  t('导航条竖排', /flex-direction:\s*column/.test(strip(block('.set-tabs'))));

  /* 两个外壳结构必须一致，否则一个并排一个堆叠 */
  t('React 版用 .set-wrap + .set-body', /className="set-wrap"/.test(react) && /className="set-body"/.test(react));
  t('原生版也用 .set-wrap + .set-body（不能平铺进 root）',
    /div\.set-wrap/.test(native) && /div\.set-body/.test(native));
  t('原生版不再把 tabBar 直接挂到 root',
    !/ctx\.root\.appendChild\(tabBar\)/.test(strip(native)));
}

/* ================================================================
   G. 插件分区：toolbar 不能被算成 app
   ================================================================
   实测踩过：`plugins.filter(p => p.kind !== 'service')` 会把
   kind:'toolbar' 也算进"应用插件 · 显示在侧边栏"，
   而工具栏插件根本不在侧边栏 —— 用户装了却找不到，且说明不了原因。 */
console.log('\n--- G. 插件按 kind 三分区 ---');
{
  const react = src('plugins/settings/App.tsx');
  const native = src('plugins/settings/index.js');
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
  const r = strip(react), n = strip(native);

  t('React 版不用 kind!==service 分 app（会把 toolbar 算进去）',
    !/kind\s*!==\s*'service'/.test(r));
  t('React 版按 app/service/toolbar 三区',
    /p\.kind === 'app'/.test(r) && /p\.kind === 'service'/.test(r) && /p\.kind === 'toolbar'/.test(r));
  t('原生版不用 kind!==service 分 app',
    !/kind\s*!==\s*'service'/.test(n));
  t('原生版按三区', /kind === 'toolbar'/.test(n) && /tbRows/.test(n));
  t('两版都有工具栏分区标题',
    /工具栏插件/.test(react) && /工具栏插件/.test(native));

  /*
   * 引用了就得有定义。
   * 这里差点出事：加了 {tbs.map(...)} 却没加 `const tbs = ...`，
   * 而字符串断言只查"有没有出现 tbs"—— 引用也算出现，于是漏过。
   * 结果是打开设置页插件页签直接 ReferenceError 白屏。
   *
   * 判断：const/let 定义恰好 1 处，且总出现次数 > 1（有真实引用）。
   */
  const defCount = (txt, name) => (txt.match(new RegExp(`(?:const|let)\\s+${name}\\s*=`, 'g')) || []).length;
  const useCount = (txt, name) => (txt.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
  for (const nm of ['apps', 'svcs', 'tbs']) {
    t(`React 版 ${nm} 有定义且被引用`,
      defCount(r, nm) === 1 && useCount(r, nm) > 1,
      `定义 ${defCount(r, nm)} / 出现 ${useCount(r, nm)}`);
  }
  for (const nm of ['appRows', 'svcRows', 'tbRows']) {
    t(`原生版 ${nm} 有定义且被引用`,
      defCount(n, nm) >= 1 && useCount(n, nm) > 1,
      `定义 ${defCount(n, nm)} / 出现 ${useCount(n, nm)}`);
  }
  /*
   * 侧边栏也应该只放 app —— 否则设置页分对了、侧边栏还是错的。
   * visiblePlugins 的口径在 js/host.js。
   */
  const host = src('js/host.js');
  t('visiblePlugins 排除 toolbar（不只是 service）',
    /export function visiblePlugins/.test(host)
    && /kind\s*!==\s*'toolbar'/.test(host));
}

/* ================================================================
   H. 检查器插件：提示按平台
   ================================================================ */
console.log('\n--- H. 检查器提示按平台 ---');
{
  const m = src('plugins/toolbar-inspector/module.js');
  const code = m.replace(/\/\*[\s\S]*?\*\//g, '');
  t('tip 不写死 Ctrl（Mac 上应为 ⌘）', !/tip:\s*'[^']*Ctrl/.test(code));
  t('tip 按平台生成', /get tip\(\)/.test(code) && /isMac\(\)/.test(code)
    && /⌘/.test(code) && /Ctrl/.test(code));
  t('平台判断有 try/catch（无 navigator 环境不能抛）',
    /function isMac\(\)[\s\S]{0,160}try\s*\{/.test(code));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
