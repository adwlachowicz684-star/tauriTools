/**
 * 开发者模式 · 元素检查器回归测试（开发用，可删）
 * ------------------------------------------------------------
 * 覆盖：悬浮高亮、名称生成、iframe 穿透与坐标换算、
 *       隔离降级、点击锁定 + 复制、快捷键、状态持久化。
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const dom = new JSDOM(
  `<!DOCTYPE html><html><body>
     <div id="app">
       <aside id="sidebar"><nav id="plugin-list">
         <button class="nav-item active" id="nav-home">home</button>
       </nav></aside>
       <main id="main"><div id="plugin-bar">
         <button class="bar-btn" id="bar-reload">↻</button>
       </div></main>
     </div>
   </body></html>`,
  { url: 'http://localhost/', pretendToBeVisual: true },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;
// Node 21+ 起 globalThis.navigator 是只读 getter，直接赋值会抛 TypeError
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const insp = await import('./js/inspector.js');
const uninstall = insp.installInspector();

/* ---------- 1. 开关 ---------- */
console.log('\n=== 1. 开关 ===');
t('初始为关', insp.isInspectorOn() === false);
insp.setInspector(true);
t('可开启', insp.isInspectorOn() === true);
t('开启后 body 挂上标记', document.body.classList.contains('nx-inspecting'));
t('高亮层已插入', !!document.querySelector('.nx-insp-overlay'));
t('信息条已插入', !!document.querySelector('.nx-insp-badge'));
t('状态写入 localStorage', localStorage.getItem('nexus:dev-inspector') === '1');
insp.toggleInspector();
t('可切换关闭', insp.isInspectorOn() === false);
t('关闭后移除标记', !document.body.classList.contains('nx-inspecting'));

/* ---------- 2. 标识生成 ---------- */
console.log('\n=== 2. 标识 ===');
insp.setInspector(true);
const reload = document.getElementById('bar-reload');
t('标签 + id + class', insp.labelOf(reload) === 'button#bar-reload.bar-btn', insp.labelOf(reload));
t('标签 + class', insp.labelOf(document.getElementById('plugin-list')) === 'nav#plugin-list');

const wide = document.createElement('div');
wide.className = 'a b c d e f';
t('class 只取前两个（否则长串工具类没法读）', insp.labelOf(wide) === 'div.a.b', insp.labelOf(wide));

const p1 = insp.pathOf(reload);
t('路径含自身', p1.includes('button#bar-reload'), p1);
t('路径含祖先', p1.includes('main#main') || p1.includes('div#plugin-bar'), p1);
t('路径不超过 5 段', p1.split(' > ').length <= 5, String(p1.split(' > ').length));

/* ---------- 3. 悬浮高亮 ---------- */
console.log('\n=== 3. 高亮 ===');
insp.__inspect(reload);
t('高亮层已激活', insp.__debug().overlayOn === true);
t('信息条已激活', insp.__debug().badgeOn === true);
const badge = document.querySelector('.nx-insp-badge');
t('信息条显示元素名', badge.textContent.includes('button#bar-reload'), badge.textContent.trim());
t('信息条显示尺寸', /\d+ × \d+/.test(badge.textContent), badge.textContent.trim());
t('高亮层用 CSS 变量定位',
  /setProperty\('--x'/.test(src('js/inspector.js')));

/* ---------- 4. 插件归属 ---------- */
console.log('\n=== 4. 插件归属 ===');
const wrap = document.createElement('div');
wrap.className = 'plugin-wrap';
wrap.dataset.pluginId = 'mindmap';
const inner = document.createElement('span');
wrap.appendChild(inner);
document.body.appendChild(wrap);
t('能向上找到所属插件', insp.pluginOf(inner) === 'mindmap', String(insp.pluginOf(inner)));
insp.__inspect(inner);
t('信息条标出插件 id',
  document.querySelector('.nx-insp-badge').textContent.includes('mindmap'));
wrap.remove();

/* ---------- 5. 隔离 iframe 降级 ---------- */
console.log('\n=== 5. 隔离降级 ===');
const iframe = document.createElement('iframe');
document.body.appendChild(iframe);
// 模拟"严格沙箱"：contentDocument 直接抛异常（opaque origin 的真实表现）。
// 这里验证的是**降级行为**而不是源码长相 —— 抛异常时必须不崩，
// 并且要能在信息条上说明"进不去"，而不是静默什么都不显示。
Object.defineProperty(iframe, 'contentDocument', {
  get() { throw new Error('opaque origin'); },
});
let threw = false;
try {
  insp.__inspect(iframe);
} catch { threw = true; }
const t5 = document.querySelector('.nx-insp-badge').textContent;
t('隔离 iframe 不会让检查器崩溃', threw === false);
t('隔离 iframe 仍能高亮到自身', insp.__debug().overlayOn === true);
t('并标注「隔离·无法深入」', t5.includes('隔离'), t5.trim());
iframe.remove();

/* ---------- 6. 穿透与坐标换算（源码级） ---------- */
console.log('\n=== 6. 穿透 ===');
const isrc = src('js/inspector.js');
t('elementFromPoint 会递归进 iframe',
  /while \(el && el\.tagName === 'IFRAME' && guard\+\+ < 5\)/.test(isrc));
t('取文档做了 try/catch（严格沙箱会抛）',
  /function docOf\(iframe\) \{[\s\S]{0,200}?catch \{[\s\S]{0,60}?return null;/.test(isrc));
t('坐标逐级累加父 iframe 偏移',
  /while \(win && win !== window && guard\+\+ < 5\)/.test(isrc)
  && /left \+= r\.left;/.test(isrc));
t('有防死循环上限', (isrc.match(/guard\+\+ < 5/g) || []).length >= 2);

/* ---------- 7. 关键设计（源码级） ---------- */
console.log('\n=== 7. 设计 ===');
const css = src('css/neumorphism.css');
t('高亮层 pointer-events:none（否则抢 hover 导致闪烁）',
  /\.nx-insp-overlay \{[\s\S]{0,400}?pointer-events: none;/.test(css));
t('信息条 pointer-events:none',
  /\.nx-insp-badge \{[\s\S]{0,500}?pointer-events: none;/.test(css));
t('点击在捕获阶段拦截（顺手阻止误触发按钮）',
  /document\.addEventListener\('click', onClick, true\)/.test(isrc)
  && /e\.preventDefault\(\);/.test(isrc));
t('Esc 解锁', /if \(e\.key === 'Escape' && locked\)/.test(isrc));
t('复制有 execCommand 降级（file:// 下没有 clipboard API）',
  /document\.execCommand\('copy'\)/.test(isrc));

/* ---------- 8. 入口接线 ---------- */
console.log('\n=== 8. 入口 ===');
t('无构建版：shell.js 已安装', /installInspector\(\);/.test(src('js/shell.js')));
t('无构建版：侧边栏有按钮', /id="btn-inspect"/.test(src('index.html')));
t('Vite 版：App.tsx 已安装', /installInspector\(\)/.test(src('src/App.tsx')));
t('Vite 版：Sidebar 有按钮', /onInspect/.test(src('src/components/Sidebar.tsx')));
t('快捷键是 Ctrl/Cmd+Shift+D（避开 webview 的 Ctrl+Shift+I）',
  /e\.key\.toLowerCase\(\) !== 'd'/.test(isrc) && /e\.shiftKey/.test(isrc));

/* ---------- 9. 卸载 ---------- */
console.log('\n=== 9. 卸载 ===');
insp.setInspector(false);
uninstall();
t('卸载后关闭', insp.isInspectorOn() === false);
t('卸载后移除高亮层', !document.querySelector('.nx-insp-overlay'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
