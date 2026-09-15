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
t('无构建版（shell.js）已安装',
  /import \{ installTooltip \} from '\.\/tooltip\.js';/.test(src('js/shell.js'))
  && /^installTooltip\(\);$/m.test(src('js/shell.js')));
t('Vite 版（App.tsx）已安装',
  /import \{ installTooltip \} from '\.\.\/js\/tooltip\.js';/.test(src('src/App.tsx'))
  && /useEffect\(\(\) => installTooltip\(\), \[\]\)/.test(src('src/App.tsx')));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
