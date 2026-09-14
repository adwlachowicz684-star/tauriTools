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
globalThis.navigator = dom.window.navigator;
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

/* ============ B. 未声明 settings 的插件应隐藏按钮 ============ */
console.log('\n--- B. 未声明 settings 的插件 ---');
N.navigate('demo-iframe');
await sleep(600);
const btn2 = document.querySelector('#bar-plugin-settings');
t('切到无设置插件后按钮隐藏（或保持隐藏）', !btn2 || btn2.hidden);

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
  const ev = new sdkDom.window.MessageEvent('message', { data });
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
  new sdkDom2.window.MessageEvent('message', { data }));
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
const deliver3 = (d) => sdkDom3.window.dispatchEvent(new sdkDom3.window.MessageEvent('message', { data: d }));
deliver3({ channel: 'nexus-bridge-v1', type: 'init', manifest: { id: 'p' }, theme: {}, view: 'settings' });
deliver3({ channel: 'nexus-bridge-v1', type: 'mount' });
await sleep(60);
t('未提供 settingsFn：hasSettings=false', sdkDom3.window.__hasSettings === false);
t('未提供 settingsFn：回退到主视图而非开空面板', onlyMain === 1, `调用 ${onlyMain} 次`);

globalThis.window = savedWindow;
globalThis.document = savedDoc;

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
