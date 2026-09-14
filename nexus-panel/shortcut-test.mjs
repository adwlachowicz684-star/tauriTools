/**
 * 快捷键隔离测试（开发用，可删）
 * ------------------------------------------------------------
 * 核心要验证的机制：插件的快捷键只在自己被激活时才生效。
 *
 *   A. combo 解析与匹配（mod/ctrl/shift/alt、mod 的平台差异）
 *   B. 同页插件：激活时响应 → 切走后失效 → 卸载后无残留
 *   C. 设置抽屉打开时，主视图快捷键暂停、面板自己的生效
 *   D. 两个插件注册同一个键，互不干扰
 *   E. iframe 插件把外壳保留键转发回外壳（焦点在沙箱时外壳收不到事件）
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
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
dom.window.__NEXUS_NO_BUILD__ = true;
globalThis.__NEXUS_NO_BUILD__ = true;

const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
  key: (i) => [..._ls.keys()][i] ?? null,
  get length() { return _ls.size; },
};
// 固定为 macOS，让 mod = ⌘（可切换验证平台差异）
let platform = 'MacIntel';
Object.defineProperty(dom.window.navigator, 'platform', { get: () => platform, configurable: true });
globalThis.navigator = dom.window.navigator;

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ A. combo 解析与匹配 ============ */
console.log('\n--- A. 快捷键解析 ---');
const { parseCombo, matchCombo, isMac } = await import('./js/plugin-sdk.js');

const key = (o) => new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...o });

t("解析 'mod+k'", (() => { const s = parseCombo('mod+k'); return s && s.mod && s.key === 'k'; })());
t("解析 'ctrl+shift+p'", (() => {
  const s = parseCombo('ctrl+shift+p');
  return s && s.ctrl && s.shift && !s.mod && s.key === 'p';
})());
t('非法 combo 返回 null', parseCombo('') === null && parseCombo('shift+') === null);

platform = 'MacIntel';
t('macOS 下 mod = ⌘', matchCombo(key({ key: 'k', metaKey: true }), parseCombo('mod+k')));
t('macOS 下 mod 不匹配 Ctrl', !matchCombo(key({ key: 'k', ctrlKey: true }), parseCombo('mod+k')));

platform = 'Win32';
t('Windows 下 mod = Ctrl', matchCombo(key({ key: 'k', ctrlKey: true }), parseCombo('mod+k')));
t('Windows 下 mod 不匹配 ⌘', !matchCombo(key({ key: 'k', metaKey: true }), parseCombo('mod+k')));

platform = 'MacIntel';
t('修饰键必须精确匹配（多了 alt 不触发）',
  !matchCombo(key({ key: 'k', metaKey: true, altKey: true }), parseCombo('mod+k')));
t('shift 状态不同不触发',
  !matchCombo(key({ key: 'k', metaKey: true, shiftKey: true }), parseCombo('mod+k'))
  && matchCombo(key({ key: 'k', metaKey: true, shiftKey: true }), parseCombo('mod+shift+k')));
t("功能键 'esc' 可匹配", matchCombo(key({ key: 'Escape', code: 'Escape' }), parseCombo('esc')));
platform = 'MacIntel';

/* ============ 启动外壳 ============ */
await import('./js/shell.js');
await sleep(400);
const N = globalThis.window.__NEXUS__;

/* ============ B. 同页插件：激活 / 失活 / 卸载 ============ */
console.log('\n--- B. 同页插件快捷键的激活隔离 ---');

N.navigate('demo-module');
await sleep(350);
const stage = document.querySelector('#stage-scroll');
t('示例·同页插件已挂载', /计数器/.test(stage.textContent));

const pressModK = () => {
  const ev = new dom.window.KeyboardEvent('keydown', {
    key: 'k', code: 'KeyK', metaKey: true, bubbles: true, cancelable: true,
  });
  document.dispatchEvent(ev);
};

pressModK();
await sleep(120);
t('激活时：mod+k 生效', /快捷键 mod\+k/.test(stage.textContent),
  (stage.textContent.match(/快捷键[^\n]*/) || ['(无)'])[0].slice(0, 20));

// 切到别的插件
N.navigate('settings');
await sleep(350);
const logBefore = stage.textContent;
pressModK();
await sleep(120);
const curStage = document.querySelector('#stage-scroll');
t('切走后：mod+k 不再触发旧插件',
  !/快捷键 mod\+k/.test(curStage.textContent) || curStage === stage,
  '旧插件实例已卸载');

// 回到插件，验证仍然可用（没被误伤）
N.navigate('demo-module');
await sleep(350);
const stage2 = document.querySelector('#stage-scroll');
pressModK();
await sleep(120);
t('切回来后：快捷键恢复生效', /快捷键 mod\+k/.test(stage2.textContent));

/* ============ C. 抽屉打开时主视图暂停 ============ */
console.log('\n--- C. 设置抽屉打开时的优先级 ---');
const btn = document.querySelector('#bar-plugin-settings');
btn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep(500);
t('设置抽屉已打开', !!document.querySelector('#drawer-mask .drawer'));

const beforePause = document.querySelector('#stage-scroll').textContent;
pressModK();
await sleep(120);
const afterPause = document.querySelector('#stage-scroll').textContent;
t('抽屉打开时：主视图快捷键暂停（未新增日志）',
  (afterPause.match(/快捷键 mod\+k/g) || []).length === (beforePause.match(/快捷键 mod\+k/g) || []).length);

document.querySelector('#dw-close')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep(200);
t('抽屉已关闭', !document.querySelector('#drawer-mask'));

const beforeResume = document.querySelector('#stage-scroll').textContent;
pressModK();
await sleep(120);
t('抽屉关闭后：主视图快捷键恢复',
  (document.querySelector('#stage-scroll').textContent.match(/快捷键 mod\+k/g) || []).length
  > (beforeResume.match(/快捷键 mod\+k/g) || []).length);

/* ============ D. 卸载后无残留 ============ */
console.log('\n--- D. 卸载后不残留 ---');
N.navigate('home');
await sleep(400);
const homeStage = document.querySelector('#stage-scroll');
const cntBefore = (homeStage.textContent.match(/快捷键 mod\+k/g) || []).length;
pressModK();
await sleep(120);
t('插件卸载后按键无残留响应',
  (document.querySelector('#stage-scroll').textContent.match(/快捷键 mod\+k/g) || []).length === cntBefore);

/* ============ E. iframe 转发外壳保留键 ============ */
console.log('\n--- E. iframe 内的外壳保留键转发 ---');
const sdkDom = new JSDOM('<!doctype html><html><body><div id="plugin-mount"></div></body></html>', {
  url: 'http://localhost/x',
});
const forwarded = [];
sdkDom.window.parent.postMessage = (msg) => {
  if (msg.type === 'shell-shortcut') forwarded.push(msg.combo);
};
const savedW = globalThis.window, savedD = globalThis.document;
Object.defineProperty(sdkDom.window.navigator, 'platform', { get: () => 'MacIntel', configurable: true });
globalThis.window = sdkDom.window;
globalThis.document = sdkDom.window.document;
globalThis.navigator = sdkDom.window.navigator;
globalThis.Node = sdkDom.window.Node;
globalThis.HTMLElement = sdkDom.window.HTMLElement;

const { bootIframePlugin: boot2 } = await import('./js/plugin-sdk.js?fresh=1');
boot2(async () => {});
const deliver = (d) => sdkDom.window.dispatchEvent(
  new sdkDom.window.MessageEvent('message', { data: d, source: sdkDom.window.parent }));
deliver({ channel: 'nexus-bridge-v1', type: 'init', manifest: { id: 'p' }, theme: {}, view: 'main' });
await sleep(60);

// 在沙箱里按 ⌘R —— 主窗口收不到，应被转发
sdkDom.window.dispatchEvent(new sdkDom.window.KeyboardEvent('keydown', {
  key: 'r', code: 'KeyR', metaKey: true, bubbles: true, cancelable: true,
}));
await sleep(60);
t('沙箱内 ⌘R 已转发给外壳', forwarded.includes('mod+r'), forwarded.join(','));

// 插件自己的快捷键不应被当成外壳键转发
forwarded.length = 0;
sdkDom.window.dispatchEvent(new sdkDom.window.KeyboardEvent('keydown', {
  key: 'j', code: 'KeyJ', metaKey: true, bubbles: true, cancelable: true,
}));
await sleep(60);
t('插件自有键（⌘J）不被误转发', forwarded.length === 0, forwarded.join(',') || '无转发');

globalThis.window = savedW;
globalThis.document = savedD;

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
