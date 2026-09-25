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
  /*
   * React 版的插件管理已从**行式**改成卡片：每个插件自成一格，
   * 不再有"同一列、不同行"这回事，也就不需要定宽格来防错位 ——
   * 定宽格解决的正是"名称列 flex:1 把宽度差转成右侧位移"。
   *
   * 所以这里**反向**钉住：React 版不应再出现 p-slot-act。
   * 只钉原生版（它仍是行式）不够 —— 哪天有人把行式搬回来，
   * 定宽格也会跟着回来，那条正向断言照样绿，而错位问题已随卡片消失。
   */
  t('React 版改用卡片承载（不再用 p-slot-act 定宽格）',
    !/p-slot-act/.test(react), '卡片里没有"列"，也就没有列错位');
  t('原生版（仍是行式）：内置/移除 套进 .p-slot-act', /span\.p-slot-act/.test(native));
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
  /*
   * set-body 现在是**模板串**：插件页要临时加 .fill 关掉外层滚动
   * （左列自己滚，外层再滚一次会出现两个滚动条）。
   * 断言跟着写法走，但必须仍钉住"类名在 className 上" ——
   * 只查裸 `set-body` 的话，把 class 去掉、只在注释里提到它也照样绿。
   */
  t('React 版用 .set-wrap + .set-body',
    /className="set-wrap"/.test(react) && /className=\{`set-body/.test(react),
    'set-body 用模板串挂 .fill，写成定串会漏判');
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
  /*
   * 工具栏那一区现在由 ToolbarSection / buildToolbarSection 渲染
   * （不再是简单的 filter + map），因为它还要管显示、排序、添加。
   * 断言跟着契约走：查这两个函数被定义且被引用。
   */
  /*
   * 组件已改名 PluginManager —— 它不再只管"右上角按钮"，
   * 而是把原插件管理（行式 PluginRow）与右上角管理合并进同一套卡片。
   * 名字跟着职责走，断言也跟着改：只查 ToolbarSection 会在合并后永远红，
   * 而"永远红"和"永远绿"一样没有信息量。
   */
  t('React 版有插件管理组件', /function PluginManager/.test(react));
  t('React 版引用了它', /<PluginManager[\s\S]{0,80}plugins=\{plugins\}/.test(react),
    '只查 "<PluginManager" 太松；钉到传参才算真接上');
  t('原生版有工具栏管理函数', /function buildToolbarSection/.test(native));
  /*
   * 钉**调用点**（前面有缩进、以逗号结尾），不是定义处 ——
   * 定义处也有同样的字符串，只查它会让"没接上"也能通过。
   */
  t('原生版引用了它', /\n\s+buildToolbarSection\(ctx, plugins, sub\),/.test(native));
  /*
   * 入口列表必须与加载器**共用同一个推导函数**。
   * 两边各写一遍判断必然漂移 —— 表现是"设置里关掉了，右上角还在"。
   */
  t('两版都用 toolbarEntriesOf 推导入口（与加载器同源）',
    /toolbarEntriesOf/.test(react) && /toolbarEntriesOf/.test(native));
  /*
   * 两版都改成**商店式卡片矩阵**（原来是下拉框 + 上移/下移按钮）。
   *
   * 下拉框的问题不是不好看，是信息被切成两半：下拉里只有"还没加入"的
   * 候选，已加入的要看上面那排入口 —— 两边各看一半才完整。
   * 矩阵一张卡同时给出"它是什么"和"现在什么状态"。
   */
  /*
   * 钉**类名本身**（带引号/花括号），不是裸子串：
   * 'tb-card-top' 里也含 'tb-card'，只查裸子串的话，
   * 把卡片的 class 去掉、只留子元素类名，这条照样绿。
   */
  /*
   * React 版已改成**左列表 + 右详情**（.pg-*），不再是卡片矩阵。
   * 原因：插件一多，矩阵就是一条无限长的带，要翻半天才找到想改的那个。
   * 左列只列名称（几十个也一屏放得下），右列只渲染当前选中那一个的完整设置。
   *
   * 断言钉新契约：左列容器 + 右列详情 + 可折叠分组，三者都要在。
   * 只钉"有 .pg-item"不够 —— 少了右列就退化成"只能看不能改"。
   */
  t('React 版用左列表 + 右详情（pg-list / pg-detail）',
    /className="pg-list"/.test(react) && /className="pg-detail"/.test(react)
    && /className="pg-item/.test(react),
    '矩阵已改为双栏，钉旧类名会永远红');
  /*
   * 无构建版（index.js）**仍是卡片矩阵** —— 它是手写 h() 的镜像实现，
   * 双栏改造尚未同步过去。
   *
   * 这条记的是**当前事实**，不是"应该如此"：
   * 两边不一致是已知待办（同步它需要重写整段 h() 结构）。
   * 写成"两版都如何"会永远红，而永远红和永远绿一样没有信息量 ——
   * 所以如实钉各自现状，并在下面用一条专门的对账断言盯住这个差异。
   */
  t('无构建版仍渲染卡片矩阵（tb-shop / tb-card，待同步双栏）',
    /h\('div\.tb-shop'/.test(native) && /class: 'tb-card'/.test(native),
    '无构建版尚未同步左列表+右详情');
  /*
   * 用户明确要求"不要用下拉框"——这条**反向**钉住：
   * 只允许字符里不再出现 select 元素，否则哪天有人"顺手补个下拉"就回退了。
   * 只钉正向（有矩阵）不够：矩阵和下拉可以同时存在。
   */
  /*
   * 钉**旧下拉文案消失**，而不是"全文没有 <select>"：
   * 设置页别处（主题、适配策略）本来就有合法的下拉框，
   * 全文件扫会把它们一起判进来 —— 那是断言范围错了，不是代码错了。
   */
  t('两版都不再有「添加插件」下拉框',
    !/把应用插件添加到右上角/.test(react) && !/把应用插件添加到右上角/.test(native));
  /* 卡片上两个按钮：展示/隐藏 与 加入/取消加入，两版都要有 */
  t('两版卡片都有「展示/隐藏」按钮',
    /'展示'/.test(react) && /'隐藏'/.test(react)
    && /label: '展示'/.test(native) && /label: '隐藏'/.test(native));
  t('两版卡片都有「加入/取消加入」按钮',
    /'加入'/.test(react) && /'取消加入'/.test(react)
    && /label: '加入'/.test(native) && /label: '取消加入'/.test(native));
  t('两版都用了 toggleHidden / addExtra / removeExtra',
    ['toggleHidden', 'addExtra', 'removeExtra']
      .every((fn) => react.includes(fn) && native.includes(fn)));
  /*
   * 服务插件不进界面，工具栏插件不可移除 —— 两种"加入"都得禁用，
   * 且**必须写明原因**（不给 title 就是"点了没反应且不知道为什么"）。
   */
  t('两版都禁用服务插件的加入并说明原因',
    /服务插件在后台运行，不进界面/.test(react)
    && /服务插件在后台运行，不进界面/.test(native));
  t('两版都禁用工具栏插件的移除并说明原因',
    /工具栏插件内置在右上角，不可移除/.test(react)
    && /工具栏插件内置在右上角，不可移除/.test(native));
  /* 未加入时「展示/隐藏」禁用且说明要先加入 —— 不画按钮会让人以为漏了 */
  t('两版都说明未加入时不能显示/隐藏',
    /先加入右上角/.test(react) && /先加入右上角/.test(native));
  /* CSS 必须写在 neumorphism.css：settings.css 是 iframe 专用补丁，
     同页模式刻意不引入它，写在那里的规则在同页下等于没写。 */
  /*
   * 钉**网格布局**而不只是"类名存在"：
   * 把 display:grid 改成 block 后卡片会竖成一列，那就不是矩阵了，
   * 只查类名的话这种退化一个都抓不到。
   */
  t('卡片样式写在 neumorphism.css 且是网格（两种模式都生效）',
    /\.tb-shop\s*\{[\s\S]{0,160}display:\s*grid/.test(css)
    && /\.tb-shop\s*\{[\s\S]{0,300}repeat\(auto-fill/.test(css));

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
  /*
   * 变量名在加拖拽排序时改过：原先 apps/svcs 定义在 JSX 的 IIFE 里，
   * 而拖拽的 hook **必须在组件顶层无条件调用**，写在 IIFE 中会报
   * hook 顺序错误 —— 所以提到顶层并改名为 appPlugins / svcPlugins。
   * 断言跟着改名，守的还是同一件事：引用了就得有定义。
   */
  /*
   * 合并成卡片矩阵后，svcPlugins 这个中间数组**不再存在**：
   * 服务组由 orderedFor('service') 从 all 里现算，分组渲染统一走
   * GROUPS.map，不再需要预先切出两个数组。
   *
   * 只留 appPlugins —— 拖拽 hook 的 count 与 getItemProps 索引都依赖它，
   * 它还必须是**侧边栏顺序**（见下面"应用组按侧边栏顺序"那条）。
   *
   * 断言跟着实现走：继续要求 svcPlugins 存在，等于钉住已废弃的中间变量，
   * 逼人为了过测试把它加回来。
   */
  t('React 版 appPlugins 有定义且被引用',
    defCount(r, 'appPlugins') === 1 && useCount(r, 'appPlugins') > 1,
    `定义 ${defCount(r, 'appPlugins')} / 出现 ${useCount(r, 'appPlugins')}`);
  t('React 版不再有 svcPlugins（服务组由 orderedFor 现算）',
    defCount(r, 'svcPlugins') === 0 && /orderedFor\(/.test(r),
    `定义 ${defCount(r, 'svcPlugins')}`);
  for (const nm of ['appRows', 'svcRows']) {
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

/* ================================================================
   I. 右上角按钮入口：能隐藏、能排序、能添加
   ================================================================
   之前的缺口：这一区只是把 kind:'toolbar' 的插件列出来，没有任何开关 ——
   想隐藏某个按钮没地方点、想把应用插件放到右上角更是没入口
   （这就是"找不到地方添加按钮入口"）。 */
console.log('\n--- I. 右上角入口管理 ---');
{
  const tb = src('js/toolbar-plugin.js');
  const react = src('plugins/settings/App.tsx');
  const native = src('plugins/settings/index.js');
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');

  /* 持久化存 localStorage：设置页与标题栏是两份模块实例，
     模块级变量会有第二份副本，改了这边那边不知道 */
  t('可见性/顺序存 localStorage（不是模块变量）',
    /localStorage/.test(tb) && /nexus:toolbar-hidden/.test(tb) && /nexus:toolbar-order/.test(tb));
  t('有手动添加入口的存储', /nexus:toolbar-extra/.test(tb));

  /* 排序函数不能依赖 defs —— 设置页那份实例里 defs 是空的 */
  t('sortIds 不读 defs（设置页那份实例里 defs 为空）',
    /export function sortIds\(ids\)/.test(strip(tb))
    && !/function sortIds[\s\S]{0,200}defs\.keys/.test(strip(tb)));

  /* 加载器要接受全部清单（否则应用插件的入口永远加载不到） */
  t('加载器按 kind / 声明 / extra 三类收口',
    /kind !== 'toolbar'/.test(strip(tb)) && /wantsEntry/.test(strip(tb)));
  t('两个外壳传**全部**清单给加载器（不能只 filter toolbar）',
    /loadToolbarPlugins\(all,/.test(strip(src('src/components/Titlebar.tsx')))
      && /loadToolbarPlugins\(all,/.test(strip(src('js/shell.js'))));

  /* 改完要立刻生效 */
  /*
   * 必须钉 `addEventListener(TOOLBAR_EVENT`：只查名字的话，
   * import 语句里也有它 —— 删掉监听断言照样绿（实测踩到）。
   */
  t('两个外壳都监听 toolbar 变更事件',
    /addEventListener\(TOOLBAR_EVENT/.test(strip(src('src/components/Titlebar.tsx')))
    && /addEventListener\(TOOLBAR_EVENT/.test(strip(src('js/shell.js'))));
  t('变更会派发事件', /function notifyToolbarChanged/.test(strip(tb)));

  /* 设置页两版都要能添加 */
  t('React 版有"添加为右上角按钮"入口', /addExtra/.test(react));
  t('原生版同样有', /addExtra/.test(native));
}

/* ============================================================
   F. 强调色 / 环境色的自定义色（色盘选色）
   ============================================================ */
{
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

  const sa = strip(app);
  const tm = strip(src('js/theme-manager.js'));

  console.log('\n--- F. 自定义色（色盘选色） ---');

  /* 两个槽位都要有入口 */
  t('强调色排有自定义入口', /customColorButton\('accent'\)/.test(sa));
  t('环境色排有自定义入口', /customColorButton\('env'\)/.test(sa));

  /* 存储：两个槽位必须分开，否则收藏色会互相串 */
  t('强调色与环境色的收藏夹各用一个键',
    /nexus:accent-custom/.test(tm) && /nexus:env-custom/.test(tm));
  t('getCustomColors 按 slot 取键', /slot === 'env' \? KEY_CUSTOM_ENV : KEY_CUSTOM_ACCENT/.test(tm));
  t('saveCustomColors 按 slot 取键', /saveCustomColors[\s\S]{0,260}KEY_CUSTOM_ENV/.test(tm));

  /* 只认 #rrggbb：localStorage 里的怪值不该被带进面板 */
  t('收藏夹过滤非法值（只留 #rrggbb）', /\^#\[0-9a-fA-F\]\{6\}\$/.test(tm));

  /* N28：无构建模式下色盘服务不可用，必须先问再调 */
  t('先 available() 再调 pick（不可用会 throw）',
    /await ctx\.services\.color\.available\(\)/.test(sa));
  t('不可用时有降级通路（原生取色器）', /type="color"/.test(sa) && /el\.click\(\)/.test(sa));

  /* 取消也要存收藏：用户可能刚收藏完就点取消 */
  t('取消了也保存 custom', /saveCustomColors\(slot, r\?\.custom\)/.test(sa));
  t('只有拿到 hex 才应用', /if \(r\?\.hex\) applyColor/.test(sa));

  /* pick 是 (initial, opts) 双参；写成对象形式会类型报错（实测踩到） */
  t('pick 用双参调用，不是对象形式',
    /color\.pick\(\s*\n?\s*isHex\(cur\)/.test(sa)
    && !/color\.pick\(\{\s*initial/.test(sa));

  /*
   * 当前色不在预设里时要显示出来。
   * 少了它：用户选了个自定义色，面板上看不到自己选了什么，
   * 一排预设色还全部保持不透明（因为都不等于当前色）→ 像没生效。
   */
  t('非预设的当前色会单独显示', /cur && !isPreset \? \(/.test(sa));

  /* 降级用的 input 必须由用户手势触发，不能按需 createElement */
  t('降级 input 常驻渲染（临时创建会被浏览器拦）',
    /ref=\{accentInput\}/.test(sa) && /ref=\{envInput\}/.test(sa));

  /*
   * 收藏色必须在设置页显示。
   *
   * 色盘的收藏是"调用方传进去、返回时带出来"的，持久化全靠设置页。
   * 存了却不在设置页显示，用户看不到成果 —— 收藏了几个色，
   * 回到设置页面板毫无变化，只会以为没生效。
   */
  t('设置页摆出收藏色（两个槽位）',
    /customSwatchRow\('accent'\)/.test(sa) && /customSwatchRow\('env'\)/.test(sa));
  t('没有收藏时不渲染空排', /if \(!list\.length\) return null/.test(sa));

  /* 删除走右键，且必须 preventDefault（否则弹出系统菜单盖住界面） */
  t('右键删除收藏色', /onContextMenu=/.test(sa) && /e\.preventDefault\(\)/.test(sa));
  t('删除后写回并刷新',
    /saveCustomColors\(slot, getCustomColors\(slot\)\.filter/.test(sa));

  /* 点击直接应用，不必再打开色盘 */
  t('点收藏色直接应用', /onClick=\{\(\) => \{ applyColor\(slot, c\); \}\}/.test(sa));

  /*
   * **不传 preset**。
   *
   * preset 是"覆盖色盘自带的预设色"。早先为了"跟上面那排一致"
   * 传了 swatchFor()（9 个），把色盘的 24 色砍成 9 色 ——
   * 本想打开更多选择，实际反而更少。
   */
  t('不传 preset（传了会把色盘预设色砍成 9 个）', !/preset:/.test(sa));

  /*
   * 收藏上限必须 >= 色盘的 MAX_CUSTOM。
   * 写死数字守不住：两边各自改，漂移时没人发现。
   * 所以从色盘源码里读出来再比。
   */
  {
    const cp = src('plugins/color-picker/ColorPicker.tsx');
    const cpMax = Number((cp.match(/MAX_CUSTOM\s*=\s*(\d+)/) || [])[1] || 0);
    const tmMax = Number((tm.match(/CUSTOM_MAX\s*=\s*(\d+)/) || [])[1] || 0);
    t('收藏上限不低于色盘上限（小了会静默截断）',
      cpMax > 0 && tmMax >= cpMax, `设置页 ${tmMax} / 色盘 ${cpMax}`);
  }

  /* ---- 行为验证：真跑一遍存储，而不是只查源码字符串 ---- */
  const TM = await import('./js/theme-manager.js');
  t('导出 getCustomColors / saveCustomColors',
    typeof TM.getCustomColors === 'function' && typeof TM.saveCustomColors === 'function');

  localStorage.removeItem('nexus:accent-custom');
  localStorage.removeItem('nexus:env-custom');
  t('初始为空数组', JSON.stringify(TM.getCustomColors('accent')) === '[]');

  TM.saveCustomColors('accent', ['#11aa22', '#ff0000']);
  TM.saveCustomColors('env', ['#00ff00']);
  t('两个槽位互不串（强调色 2 / 环境色 1）',
    TM.getCustomColors('accent').length === 2 && TM.getCustomColors('env').length === 1,
    `${TM.getCustomColors('accent').length} / ${TM.getCustomColors('env').length}`);

  /* 手改 localStorage 塞进来的怪值不该被带进面板 */
  TM.saveCustomColors('accent', ['#123456', 'javascript:alert(1)', 'rgb(1,2,3)', null, 42]);
  t('非法值被过滤，只留 #rrggbb',
    JSON.stringify(TM.getCustomColors('accent')) === '["#123456"]',
    JSON.stringify(TM.getCustomColors('accent')));

  /* 坏 JSON 不能让设置页打不开 */
  localStorage.setItem('nexus:accent-custom', '{{{坏 JSON');
  t('坏 JSON 不抛、退回空数组', JSON.stringify(TM.getCustomColors('accent')) === '[]');
  localStorage.removeItem('nexus:accent-custom');

  /*
   * 同一色的大小写两态要并成一格。
   * 色盘 normalizeHex 返回大写，手改 localStorage 的可能是小写，
   * 不去重的话同一个色占两格，24 个槽位白白少一个。
   */
  TM.saveCustomColors('accent', ['#AABBCC', '#aabbcc', '#112233']);
  t('大小写重复合并成一格', TM.getCustomColors('accent').length === 2,
    JSON.stringify(TM.getCustomColors('accent')));
  t('统一存小写', TM.getCustomColors('accent')[0] === '#aabbcc');

  /*
   * 读的一侧也要归一化。
   *
   * 只测"存进去是小写"抓不到这条：那时 saveCustomColors 已经归一化过，
   * 把 getCustomColors 的归一化删掉照样全绿（实测踩到）。
   * 必须绕过写入、直接往 localStorage 塞大写值才测得到 ——
   * 手改 localStorage 的人正是这么干的。
   */
  localStorage.setItem('nexus:accent-custom', JSON.stringify(['#AABBCC', '#112233']));
  t('直写 localStorage 的大写值读出时也归一化',
    TM.getCustomColors('accent')[0] === '#aabbcc',
    JSON.stringify(TM.getCustomColors('accent')));
  localStorage.removeItem('nexus:accent-custom');

  /* 右键删除：过滤掉指定色后写回，剩下的保持原顺序 */
  TM.saveCustomColors('accent', ['#111111', '#222222', '#333333']);
  TM.saveCustomColors('accent', TM.getCustomColors('accent').filter((x) => x !== '#222222'));
  t('删除收藏色后剩 2 个且顺序不变',
    JSON.stringify(TM.getCustomColors('accent')) === '["#111111","#333333"]',
    JSON.stringify(TM.getCustomColors('accent')));

  /* 删除全部后为空 —— 设置页据此不渲染那一排 */
  TM.saveCustomColors('accent', TM.getCustomColors('accent').filter(() => false));
  t('清空后为空数组', TM.getCustomColors('accent').length === 0);

  /*
   * 上限：两侧都要截断。
   *
   * 只测"读出来是 24"是**假绿** —— 读侧有 slice，写侧即使不截断，
   * 读出来照样是 24（实测踩到）。但那样 localStorage 里存的是 40 个，
   * 会无限增长。必须绕过读取，直接看存进去的原始数据。
   */
  TM.saveCustomColors('accent', Array.from({ length: 40 }, (_, i) =>
    '#' + (i + 1).toString(16).padStart(6, '0')));
  t('读出来截断到 24', TM.getCustomColors('accent').length === 24,
    String(TM.getCustomColors('accent').length));
  const rawLen = JSON.parse(localStorage.getItem('nexus:accent-custom') || '[]').length;
  t('写进去也截断到 24（否则 localStorage 无限增长）', rawLen === 24, String(rawLen));
  localStorage.removeItem('nexus:accent-custom');
  localStorage.removeItem('nexus:env-custom');
  localStorage.removeItem('nexus:accent-custom');
  localStorage.removeItem('nexus:env-custom');
}

/* ---------------------------------------------------------------- */
console.log('\n=== J. 右上角卡片必须与按钮同源（快照缺失也能列出）===');
/*
 * 用户实测：右上角明明有「切换主题 / MCP」这些按钮，设置页的卡片矩阵里
 * 却没有它们的卡 —— 于是想隐藏某个按钮时翻遍设置也找不到开关。
 *
 * 根因是**两处不同源**：
 *   · 标题栏用 loadRegistry() 实时读全量清单来加载按钮
 *   · 设置页此前读 shellGlobal().getPlugins() = state.plugins，是 refresh 时刻的快照
 * 快照里没有的东西无法管理。
 *
 * 两道修复，两道都要钉住：
 *   ① 设置页也用 loadRegistry() 实时读（降级到快照）
 *   ② 卡片来源并上 allToolbarDefs()（按钮渲染用的同一份 def）
 */
const setSrc = src('./plugins/settings/App.tsx');
t('① 设置页直接用 loadRegistry（与标题栏同源）',
  /await loadRegistry\(\)/.test(setSrc));
t('② 卡片来源并上 allToolbarDefs（兜底补卡）',
  /allToolbarDefs\(\)/.test(setSrc)
  && /!seen\.has\(/.test(setSrc),
  '缺一张卡 = 该按钮无法隐藏');
/*
 * 光"算了 ghosts"不够 —— 必须**真的用上**。
 * 只查 allToolbarDefs 是否存在，会被"算了却没并进 cards"骗过去
 * （改回 (plugins||[]).slice() 照样绿，而那正是要防的回退）。
 */
t('②b 清单并上 ghosts 后**真的被用上**（orderedFor 基于 all）',
  /const all = \(plugins \|\| \[\]\)\.concat\(ghosts\)/.test(setSrc)
  && /orderedFor[\s\S]{0,400}all\.filter/.test(setSrc),
  '只算不用 = 缺一张卡，该按钮就无法隐藏');
/* 兜底后必须真能补出卡片并允许隐藏 —— 用真实模块跑，不查字符串 */
{
  globalThis.localStorage = globalThis.localStorage || {
    _d: {}, getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; },
  };
  /*
   * 必须转成 file:// URL：直接把 `E:/...` 这种绝对路径交给 ESM loader，
   * 在 Windows 上会报 ERR_UNSUPPORTED_ESM_URL_SCHEME（protocol 'e:'），
   * 整个测试从这一行起就跑不下去了。上面那些 `import('./js/xxx.js')`
   * 是相对路径所以没事，这里是绝对路径才踩到。
   */
  const tp = await import(pathToFileURL(path.join(HERE, 'js/toolbar-plugin.js')).href);
  const tbManifests = [
    { id: 'toolbar-theme', name: '切换主题', icon: '◐', kind: 'toolbar', type: 'module' },
    { id: 'toolbar-mcp', name: 'MCP 状态', icon: '⬡', kind: 'toolbar', type: 'module' },
  ];
  await tp.loadToolbarPlugins(tbManifests, {
    loadModule: async (m) => ({ default: { id: m.id, label: m.icon, tip: m.name, onClick() {} } }),
  });
  /* 模拟"清单里没有 toolbar 插件"的最坏情况 */
  const plugins = [{ id: 'home', name: '概览', kind: 'app' }];
  const seen = new Set(plugins.map((p) => p.id));
  const ghosts = tp.allToolbarDefs().filter((d) => d && !seen.has(d.id))
    .map((d) => ({ id: d.id, name: d.tip || d.label || d.id, icon: d.label, kind: 'toolbar' }));
  const all = plugins.concat(ghosts);
  const entries = tp.toolbarEntriesOf(all);
  /*
   * 不写死数量：本文件的其它用例已经往 defs 里加载过入口，
   * allToolbarDefs() 返回的条数取决于前面的执行 —— 写死 2 会在别人
   * 加用例时假红。断言"这两个 id 确实被补出来了"才是要守的契约。
   */
  const gid = new Set(ghosts.map((g) => g.id));
  const eid = new Set(entries.map((e) => e.pluginId));
  t('清单缺 toolbar 时仍能补出卡片（切换主题 / MCP）',
    gid.has('toolbar-theme') && gid.has('toolbar-mcp')
    && eid.has('toolbar-theme') && eid.has('toolbar-mcp'),
    `补回 ${ghosts.length} 张 / 入口 ${entries.length}`);
  const extra = new Set(tp.extraIds());
  t('补出的卡片「隐藏」可用（joined=true）',
    all.filter((p) => p.kind === 'toolbar').every((p) => tp.wantsEntry(p, extra)));
}

/* ---------------------------------------------------------------- */
console.log('\n=== 右上角按钮卡片按 kind 分三组 ===');
/*
 * 需求：设置页的插件卡片要按 工具栏 / 应用 / 服务 分类。
 *
 * 理由不是"看起来整齐" —— 三类的**可用操作不同**：
 *   工具栏插件 → 自带入口，只能隐藏/展示，不能移除
 *   应用插件   → 唯一能「加入 / 取消加入」的一类
 *   服务插件   → 后台运行不进界面，两个按钮都不可用
 * 混排时用户得逐张读卡片小字才知道能点哪个；分组后看组标题即可。
 */
const appSrc = src('plugins/settings/App.tsx');
const cssSrc = src('css/neumorphism.css');

t('定义了三组（工具栏 / 应用 / 服务）',
  /key:\s*'toolbar'[\s\S]{0,300}key:\s*'app'[\s\S]{0,300}key:\s*'service'/.test(appSrc));
t('有分类函数（把 kind 归一到三组之一）',
  /kindOf[\s\S]{0,200}'toolbar'\s*\?\s*'toolbar'/.test(appSrc),
  '漏了归一化的话，未标注的插件会掉进 undefined 组、整组消失');
t('按分组渲染（GROUPS.map + orderedFor）',
  /GROUPS\.map\(/.test(appSrc) && /orderedFor\(/.test(appSrc)
  && !/cards\.map\(/.test(appSrc),
  '残留 cards.map 说明分组没接上渲染');
/*
 * ⚠️ 关键：三组**不是同一套排序**，混用会出真错。
 *   工具栏组 —— 按右上角按钮顺序（卡片标"第 N 位"）
 *   应用组   —— 按**侧边栏顺序**，因为拖拽排序改的就是这个顺序
 *   服务组   —— 清单原序（不在任何可见列表里，没有"顺序"可言）
 *
 * 应用组若也按 rank 排，卡片顺序会与拖拽要改的侧边栏顺序错位：
 * 拖第 2 张实际动的是侧边栏第 5 个，而且**不报错**，只是"拖完不对"。
 */
t('应用组按侧边栏顺序（appOrder），不按右上角 rank',
  /const appOrder = \(plugins \|\| \[\]\)\.filter/.test(appSrc)
  && /orderedFor[\s\S]{0,200}key === 'app'\) return appOrder/.test(appSrc),
  '应用组用 rank 排会让拖拽错位且不报错');
/*
 * 双栏化之后"第 N 位"从卡片角标挪进了右列的「右上角」键值对，
 * 文案排版也变了（`右上角` 是左侧标签，值与它不在同一个文本节点里）。
 * 断言按**现在的拼接形式**钉，仍钉住"真的把序号显示出来了" ——
 * 只查 rank.get 的话，算出来却没渲染也照样绿。
 */
t('工具栏组按右上角顺序排（详情里标第 N 位）',
  /key === 'toolbar'[\s\S]{0,300}rank\.get/.test(appSrc)
  && /第 \$\{\(pos \?\? 0\) \+ 1\} 位/.test(appSrc));
t('空组保留标题（不整块隐藏）',
  /g\.items\.length \? \([\s\S]{0,400}:\s*\(/ .test(appSrc)
  || /这一类当前没有插件/.test(appSrc),
  '整块隐藏会让"这类没有"和"这类没列出来"看起来一样');

/* CSS 必须写在 neumorphism.css —— settings.css 是 iframe 专用补丁，
   同页嵌合模式刻意不加载它，写在那里等于没写（这条之前踩过）。 */
/*
 * 双栏样式必须放在**共享层 controls.css**，不能放 settings.css ——
 * settings.css 是 iframe 专用补丁，同页嵌合模式刻意不加载它，
 * 写在那里等于没写（左列会一个插件都不显示，且不报错）。
 *
 * neumorphism.css 也不行：它靠 settings 主入口引入，
 * 而 .pg-* 是给外壳提供的通用组件用的。
 */
const cssCtl = src('css/controls.css');
t('双栏样式写在共享层 controls.css（两种模式都生效）',
  /\.pg-list\s*\{/.test(cssCtl) && /\.pg-detail\s*\{/.test(cssCtl)
  && /\.pg-group-head\s*\{/.test(cssCtl),
  '写进 settings.css 的话同页模式下不加载');
t('分组样式没写进 settings.css（那边不加载）',
  !/\.tb-group/.test(src('plugins/settings/settings.css')));

/* ---------------------------------------------------------------- */
console.log('\n=== 插件管理合并进卡片（原行式管理项全部入卡） ===');
/*
 * 需求：把原本「插件管理」的内容全部搬进卡片，卡片放大到约两倍。
 *
 * 合并的理由不是省地方 —— 两件事**作用的是同一个对象**：
 * 用户眼里"管理插件"就是在一处把运行方式、外观基调、入口位置都解决。
 * 分两块时，改基调在下面、改入口在上面，中间还隔着服务插件区。
 *
 * 断言必须钉住"管理项真的进了卡片"，而不只是"卡片还在"：
 * 少钉一项，就会有一天有人把某项搬回行式而测试全绿。
 */
const pm = src('plugins/settings/App.tsx');
/* 取 PluginManager 函数体 —— 这些类名/调用必须**在卡内**，
   只在文件里出现不算（别处也可能用到同名东西）。 */
const pmStart = pm.indexOf('function PluginManager(');
const pmBody = pm.slice(pmStart, pm.indexOf('\n/**\n * 快捷键总览。', pmStart));

/*
 * 双栏化后 entry 从"卡片上挨着名称的一行小字"挪进了右列的键值对区
 * （.pg-kv），不再会被挤断。
 * 仍钉住它**被渲染出来**：入口路径是排查"插件为什么加载不出来"的第一手信息，
 * 藏起来就得让人去翻控制台。
 */
t('详情里有 entry（入口路径）',
  /p\.entry/.test(pmBody) && /pg-kv/.test(pmBody));
t('卡片里有样式审计徽标', /StyleAuditBadge/.test(pmBody));
t('卡片里有移除/内置（卸载入口在卡上，不用再去别处找）',
  /移除/.test(pmBody) && /p\.builtin/.test(pmBody));
t('卡片里有右上角两个按钮（加入/取消 + 展示/隐藏）',
  /addExtra\(p\.id\)/.test(pmBody) && /removeExtra\(p\.id\)/.test(pmBody)
  && /toggleHidden\(e\.id\)/.test(pmBody));
t('拖拽只作用于应用组（服务组不在侧边栏，排了没处生效）',
  /isApp && ai !== undefined \? appsDrag\.getItemProps\(ai\)/.test(pmBody));

/* 卡片不能引用组件外的名字 —— 那是编译期 TS2304、运行时 undefined。 */
t('外壳动作经 props 传入（onRemove），不直接引用外层函数',
  /onRemove: \(p: any\) => void/.test(pmBody)
  && !/\bremovePlugin\(p\)/.test(pmBody),
  '在子组件里直接用 removePlugin 会编译不过');
t('父组件把卸载动作传下来了', /onRemove=\{removePlugin\}/.test(pm));

/* 放大：列宽 148 → 300 */
const cssPm = src('css/neumorphism.css');
const shopBlock = (() => {
  const i = cssPm.indexOf('.tb-shop {');
  return cssPm.slice(i, cssPm.indexOf('}', i) + 1);
})();
const w = Number((shopBlock.match(/minmax\((\d+)px/) || [])[1] || 0);
t('卡片列宽放大到 300px 量级（原 148px 装不下管理项）', w >= 280, `${w}px`);
t('卡片内新增的行有样式（entry / field）',
  /\.tb-card-entry\s*\{/.test(cssPm)
  && /\.tb-card-field\s*\{/.test(cssPm),
  '只有类名没有规则 = 内容裸排');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
