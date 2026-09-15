/**
 * 悬浮提示（接管原生 title）
 * ============================================================
 * 为什么需要它：浏览器原生 title 的显示延迟约 1 秒，且**无法通过任何
 * CSS / JS 调整** —— 它是浏览器自己定的。要"鼠标移上去立刻显示"，
 * 只能自己实现一个，并把原生 title 摘掉（否则会两个提示一起弹）。
 *
 * 设计要点：
 *
 * 1. 事件委托，不逐个绑定
 *    全仓有 169 处 title，且插件会动态插入 DOM。逐个绑定既慢又漏。
 *    委托到 document 上，新插入的元素天然生效。
 *
 * 2. 惰性接管
 *    不在初始化时扫描全表，而是 mouseover 命中了才把 title 搬到
 *    data-nexus-tip。代价极小，且天然覆盖动态内容。
 *
 * 3. pointer-events: none
 *    提示本身不能吃鼠标事件。否则它出现在光标下方时会把 hover 目标
 *    抢走，立刻触发 mouseout → 隐藏 → 又 mouseover → 疯狂闪烁。
 *
 * 4. 摘 title 的同时补 aria-label
 *    原生 title 对读屏软件是可用的，摘掉会让这部分信息丢失。
 *    元素没有 aria-label 时补一个，把无障碍信息留在原地。
 */

const TIP_ID = 'nexus-tip';
const ATTR = 'data-nexus-tip';

let tipEl = null;
let installed = false;
let current = null;        // 当前提示所依附的元素

function ensureEl() {
  if (tipEl && tipEl.isConnected) return tipEl;
  tipEl = document.createElement('div');
  tipEl.id = TIP_ID;
  tipEl.className = 'nexus-tip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  return tipEl;
}

/** 把元素上的原生 title 转成自定义提示的数据源（只做一次） */
function adopt(el) {
  if (!el || el.dataset.nexusTip !== undefined) return el.getAttribute(ATTR);
  const text = el.getAttribute('title');
  if (!text) return null;
  el.setAttribute(ATTR, text);
  // 摘掉原生 title：不摘会两个提示一起弹（原生那个还慢一拍）
  el.removeAttribute('title');
  // 补 aria-label，别把读屏软件能读到的信息一起摘没了
  if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', text);
  return text;
}

function hide() {
  if (!tipEl) return;
  tipEl.classList.remove('on');
  current = null;
}

/**
 * 定位：优先在元素上方，上方放不下就翻到下方；
 * 水平居中于元素，并夹在视口内 —— 否则靠边的按钮（比如标题栏最右）
 * 提示会溢出屏幕被裁掉。
 */
function place(el) {
  const r = el.getBoundingClientRect();
  const t = tipEl;
  // 先显示再量：display:none 时量不到尺寸
  t.style.visibility = 'hidden';
  t.classList.add('on');
  const tr = t.getBoundingClientRect();
  t.style.visibility = '';

  const gap = 8;
  let top = r.top - tr.height - gap;
  if (top < 4) top = r.bottom + gap;                    // 上方放不下 → 翻到下方
  if (top + tr.height > innerHeight - 4) top = 4;       // 下方也放不下 → 贴顶

  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(4, Math.min(left, innerWidth - tr.width - 4));

  t.style.left = left + 'px';
  t.style.top = top + 'px';
}

function show(el) {
  const text = el.getAttribute(ATTR);
  if (!text) return;
  current = el;
  const t = ensureEl();
  t.textContent = text;
  place(el);
}

function onOver(e) {
  const el = e.target?.closest?.(`[${ATTR}], [title]`);
  if (!el) { if (current) hide(); return; }
  if (el === current) return;
  adopt(el);
  show(el);
}

/** 滚动 / 缩放后元素位置变了，提示不该留在原地 */
function onReflow() { if (current) hide(); }

/** 键盘可达：Tab 聚焦到按钮时也要能看到提示 */
function onFocusIn(e) {
  const el = e.target?.closest?.(`[${ATTR}], [title]`);
  if (!el) return;
  adopt(el);
  show(el);
}
function onFocusOut() { hide(); }

/**
 * 安装悬浮提示。
 * @returns {() => void} 卸载函数（测试里要能干净地拆掉）
 */
export function installTooltip() {
  if (installed || typeof document === 'undefined') return () => {};
  installed = true;

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', (e) => {
    // 只有真的离开了当前元素才隐藏；在子元素间移动不算
    if (!current) return;
    if (!current.contains(e.relatedTarget)) hide();
  }, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  window.addEventListener('scroll', onReflow, true);
  window.addEventListener('resize', onReflow);

  return function uninstall() {
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('scroll', onReflow, true);
    window.removeEventListener('resize', onReflow);
    if (tipEl) { tipEl.remove(); tipEl = null; }
    current = null;
    installed = false;
  };
}

/** 测试用：读取当前是否正在显示 */
export function __debug() {
  return { installed, current, visible: !!tipEl && tipEl.classList.contains('on') };
}
