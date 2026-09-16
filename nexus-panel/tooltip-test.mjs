/**
 * 悬浮提示回归测试（开发用，可删）
 * ------------------------------------------------------------
 * 覆盖：原生 title 的显示延迟约 1 秒且**无法调整**，所以自己实现
 * 一个"鼠标移上去立刻显示"的提示，并把原生 title 摘掉。
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
     <button id="a" title="重新加载插件">↻</button>
     <button id="b" title="插件设置">⚙</button>
     <button id="c">无提示</button>
   </body></html>`,
  { url: 'http://localhost/', pretendToBeVisual: true },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const { installTooltip, __debug } = await import('./js/tooltip.js');

/* ---------- 1. 接管原生 title ---------- */
console.log('\n=== 1. 接管 ===');
const a = document.getElementById('a');
t('初始带原生 title', a.getAttribute('title') === '重新加载插件');

const uninstall = installTooltip();
t('installTooltip 返回卸载函数', typeof uninstall === 'function');
t('安装后标记为已安装', __debug().installed === true);

// 模拟鼠标移入
a.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));

t('mouseover 后 title 已被摘掉（防止原生提示一起弹）', a.getAttribute('title') === null);
t('内容转移到 data-nexus-tip', a.getAttribute('data-nexus-tip') === '重新加载插件');
t('补了 aria-label（别把读屏能读到的信息摘没了）', a.getAttribute('aria-label') === '重新加载插件');
t('提示已显示', __debug().visible === true);
t('当前依附元素正确', __debug().current === a);

const tip = document.getElementById('nexus-tip');
t('提示元素已插入 body', !!tip);
t('提示内容是按钮的说明文字', tip?.textContent === '重新加载插件');
t('提示带 role=tooltip', tip?.getAttribute('role') === 'tooltip');

/* ---------- 2. 立刻显示（无延迟） ---------- */
console.log('\n=== 2. 零延迟 ===');
const b = document.getElementById('b');
b.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
t('换到另一个按钮：同一帧内就已显示（无 setTimeout）', __debug().visible === true);
t('内容已跟着换', document.getElementById('nexus-tip').textContent === '插件设置');

/* ---------- 3. 移开隐藏 ---------- */
console.log('\n=== 3. 移开隐藏 ===');
a.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
const outEvt = new dom.window.MouseEvent('mouseout', { bubbles: true });
Object.defineProperty(outEvt, 'relatedTarget', { value: document.body });
a.dispatchEvent(outEvt);
t('真正离开元素后隐藏', __debug().visible === false);
t('隐藏后清空依附元素', __debug().current === null);

/* ---------- 4. 无 title 的元素不显示 ---------- */
console.log('\n=== 4. 无提示的元素 ===');
const c = document.getElementById('c');
c.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
t('无 title 的元素不会弹出提示', __debug().visible === false);
t('也不会被塞上 data-nexus-tip', c.getAttribute('data-nexus-tip') === null);

/* ---------- 5. 键盘可达 ---------- */
console.log('\n=== 5. 键盘 ===');
b.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
t('focusin 也显示（Tab 键可达）', __debug().visible === true);
b.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
t('focusout 隐藏', __debug().visible === false);

/* ---------- 6. 卸载干净 ---------- */
console.log('\n=== 6. 卸载 ===');
uninstall();
t('卸载后标记为未安装', __debug().installed === false);
t('提示元素已移除', !document.getElementById('nexus-tip'));

/* ---------- 7. 关键设计（源码级） ---------- */
console.log('\n=== 7. 关键设计 ===');
const tipSrc = src('js/tooltip.js');
t('提示本身 pointer-events:none（防止抢 hover 导致闪烁）',
  /pointer-events:\s*none/.test(src('css/neumorphism.css').split('.nexus-tip')[1]?.split('}')[0] ?? ''));
t('用事件委托而非逐个绑定', /document\.addEventListener\('mouseover', onOver/.test(tipSrc));
t('滚动时隐藏（否则位置会错）',
  /window\.addEventListener\('scroll', onReflow/.test(tipSrc)
  && /function onReflow\(\) \{ if \(current\) hide\(\); \}/.test(tipSrc));
t('定位做了视口夹取（靠边按钮不溢出）',
  /Math\.max\(4, Math\.min\(left, innerWidth - tr\.width - 4\)\)/.test(tipSrc));
t('上方放不下会翻到下方', /if \(top < 4\) top = r\.bottom \+ gap;/.test(tipSrc));

/* ---------- 8. 两个入口都接上了 ---------- */
console.log('\n=== 8. 入口接线 ===');
/* 断言只锁定 installTooltip 出现在 import 里，不锁死整个 import 列表 ——
   将来再加导出（如 refreshTooltip）不该让这条红。 */
t('无构建版（shell.js）已安装',
  /import \{[^}]*\binstallTooltip\b[^}]*\} from '\.\/tooltip\.js';/.test(src('js/shell.js'))
  && /^installTooltip\(\);$/m.test(src('js/shell.js')));
t('Vite 版（App.tsx）已安装',
  /import \{[^}]*\binstallTooltip\b[^}]*\} from '\.\.\/js\/tooltip\.js';/.test(src('src/App.tsx'))
  && /useEffect\(\(\) => installTooltip\(\), \[\]\)/.test(src('src/App.tsx')));

/* ============================================================
   B5：侧边栏展开时不弹 nav-item 提示
   ============================================================ */
console.log('\n=== 9. B5 · 侧边栏展开时抑制 nav-item 提示 ===');

const b5Src = src('js/tooltip.js');
const shellSrc = src('js/shell.js');
const appSrc = src('src/App.tsx');

t('tooltip.js 有 suppressed 判断', /function suppressed\(el\)/.test(b5Src));
t('判断的是 .nav-item', /classList\?\.contains\('nav-item'\)/.test(b5Src));
t('判断的是 #body.open 状态', /getElementById\('body'\)[\s\S]{0,80}classList\.contains\('open'\)/.test(b5Src));
/* 刻意不含 side-toggle：它的 title 是「展开/收起」，描述动作而非名字，
   展开后仍然有用 */
t('不含 .side-toggle（它的提示是动作描述，不是重复的名字）',
  !/side-toggle/.test(b5Src.split('function suppressed')[1]?.split('\n}')[0] ?? ''));

t('adopt 与 show 已分离（不显示时也要摘掉原生 title）',
  /adopt\(el\);\s*\n\s*if \(suppressed\(el\)\) \{ hide\(\); return; \}/.test(b5Src));
t('onFocusIn 也走了抑制（键盘 Tab 同样不弹）',
  (b5Src.match(/if \(suppressed\(el\)\) \{ hide\(\); return; \}/g) || []).length >= 2);

t('导出 refreshTooltip', /export function refreshTooltip\(\)/.test(b5Src));
t('refreshTooltip 会隐藏被抑制的当前提示',
  /if \(current && suppressed\(current\)\) hide\(\);/.test(b5Src));

t('无构建版：toggle 后调用了 refreshTooltip',
  /classList\.toggle\('open'\)[\s\S]{0,120}refreshTooltip\(\)/.test(shellSrc));
/* React 版必须在 DOM 更新后跑 —— 在 setSidebarOpen 回调里调会读到旧 class */
t('Vite 版：在 useEffect 里按 sidebarOpen 变化刷新（不是在 setState 回调里）',
  /useEffect\(\(\) => \{ refreshTooltip\(\); \}, \[sidebarOpen\]\)/.test(appSrc));

/* ---- 行为验证（真的跑一遍）---- */
/* 上面第 6 节已经 uninstall，所以这里能重新装。
   必须把 globalThis.document 指到新文档**再** install：
   tooltip 的事件委托是绑在 document 上的，绑完再换 document 就收不到事件了。 */
const dom2 = new JSDOM(
  `<!doctype html><html><body>
     <div id="body" class="open"><aside id="sidebar">
       <button class="nav-item" title="脑图（沙箱）"><span class="nav-label">脑图</span></button>
     </aside></div>
   </body></html>`,
  { pretendToBeVisual: true, url: 'http://localhost/' });
globalThis.window = dom2.window;
globalThis.document = dom2.window.document;
globalThis.getComputedStyle = dom2.window.getComputedStyle;

const { installTooltip: install2, refreshTooltip: refresh2 } = await import('./js/tooltip.js');
install2();

const nav = dom2.window.document.querySelector('.nav-item');
const bodyEl = dom2.window.document.getElementById('body');

// ① 展开状态：hover 后应摘掉 title（否则原生 tooltip 照弹），但不显示自定义提示
nav.dispatchEvent(new dom2.window.MouseEvent('mouseover', { bubbles: true }));
t('展开时：原生 title 已被摘掉（否则浏览器自己会弹）', !nav.hasAttribute('title'));
t('展开时：信息保留在 aria-label（读屏不丢）', nav.getAttribute('aria-label') === '脑图（沙箱）');
t('展开时：未显示自定义提示', !dom2.window.document.getElementById('nexus-tip'));

// ② 收起状态：应正常显示
bodyEl.classList.remove('open');
nav.dispatchEvent(new dom2.window.MouseEvent('mouseover', { bubbles: true }));
const tip2 = dom2.window.document.getElementById('nexus-tip');
t('收起时：正常显示提示', !!tip2 && tip2.classList.contains('on'));
t('收起时：提示文本正确', !!tip2 && tip2.textContent === '脑图（沙箱）');

// ③ 收起→展开：正挂着的提示应被 refreshTooltip 收掉
bodyEl.classList.add('open');
refresh2();
const tip3 = dom2.window.document.getElementById('nexus-tip');
t('收起→展开：refreshTooltip 收掉了正挂着的提示',
  !tip3 || !tip3.classList.contains('on'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
