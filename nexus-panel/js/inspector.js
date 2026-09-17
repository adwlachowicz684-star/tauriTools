/**
 * 开发者模式 · 界面元素检查器
 * ============================================================
 * 仿浏览器 DevTools 的元素选择器：开启后鼠标悬浮到任意控件上，
 * 高亮该元素并显示它的标识（标签 / id / class / 插件归属 / 尺寸），
 * 点击可复制完整路径 —— 方便直接把某个控件指名道姓地说出来。
 *
 * 设计要点
 * ------------------------------------------------------------
 * 1. 用 elementFromPoint 而不是 mouseover
 *    mouseover 只能拿到**当前文档**的元素，iframe 里的内容它一个也够不着。
 *    elementFromPoint 会返回 iframe 元素本身，再手动递归进去即可。
 *    这是本工具能查到 iframe 插件（含设置页）内部的关键。
 *
 * 2. 坐标要逐级换算
 *    拿到 iframe 内部元素后，它的 rect 是**iframe 自己视口**里的坐标，
 *    高亮框画在主文档上，必须累加各级 iframe 的偏移。
 *    嵌套 iframe（插件里再套 iframe）靠 while 循环自然支持。
 *
 * 3. 高亮层与信息条都 pointer-events: none
 *    否则它出现在光标下方时会抢走 hover 目标，导致元素反复切换、疯狂闪烁。
 *    点击不用 overlay 接收，而是在 document 捕获阶段拦下来 ——
 *    这样既能拿到元素，又能顺便阻止误触发按钮（DevTools 就是这个手感）。
 *
 * 4. 隔离插件进不去，要能优雅降级
 *    用户给插件开了「严格沙箱」后，iframe 是 opaque origin，
 *    contentDocument 直接抛异常。此时查到 iframe 本身为止，并在信息条上
 *    标注"隔离，无法深入"，而不是静默什么都不显示。
 */

const KEY = 'nexus:dev-inspector';

let on = false;
let overlay = null;     // 高亮框
let badge = null;       // 信息条
let locked = null;      // 被点击锁定的元素（锁定后不随鼠标变化）
let cleanup = null;     // 卸载函数

/* ---------------------------- 标识生成 ---------------------------- */

/**
 * 单个元素的简短标识，形如 `button#btn-max.tb-btn.danger`
 * 只取前两个 class：插件里经常挂一长串工具类，全列出来没法读。
 */
function labelOf(el) {
  if (!el || el.nodeType !== 1) return '';
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const cls = [...(el.classList || [])].filter(Boolean).slice(0, 2);
  if (cls.length) s += '.' + cls.join('.');
  return s;
}

/** 元素所属插件（.plugin-wrap / .plugin-root / iframe 上都写了 data-plugin-id） */
function pluginOf(el) {
  let n = el;
  while (n && n.nodeType === 1) {
    const id = n.dataset?.pluginId;
    if (id) return id;
    if (n.tagName === 'IFRAME' && n.dataset?.pluginId) return n.dataset.pluginId;
    n = n.parentElement;
  }
  return null;
}

/**
 * 面包屑路径，形如 `#app > #body > aside#sidebar > nav#plugin-list`
 *
 * 从最近的语义节点往上找 5 层就够 —— 再往上全是 #app / body / html，
 * 对"指出是哪个控件"没有信息量，反而把字符串撑得没法读。
 */
function pathOf(el) {
  if (!el || el.nodeType !== 1) return '';
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1 && parts.length < 5) {
    parts.unshift(labelOf(n));
    if (n.id === 'app' || n.tagName === 'BODY' || n.tagName === 'HTML') break;
    n = n.parentElement;
  }
  return parts.join(' > ');
}

/* ---------------------------- 穿透 iframe ---------------------------- */

/** 取 iframe 的内部文档；隔离（opaque origin）时抛异常，返回 null */
function docOf(iframe) {
  try {
    const d = iframe.contentDocument;
    if (!d) return null;
    // 能摸到就说明同源（严格沙箱下这行就会抛）
    void d.body;
    return d;
  } catch {
    return null;
  }
}

/** 递归穿透：主文档 → iframe → 嵌套 iframe */
function elementAt(x, y) {
  let el = document.elementFromPoint(x, y);
  let guard = 0;
  while (el && el.tagName === 'IFRAME' && guard++ < 5) {
    const d = docOf(el);
    if (!d || typeof d.elementFromPoint !== 'function') break;
    const r = el.getBoundingClientRect();
    const inner = d.elementFromPoint(x - r.left, y - r.top);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/**
 * 把元素的 rect 换算成**主文档视口**坐标。
 * iframe 内部元素的 rect 是它自己视口里的，必须逐级累加父 iframe 的偏移。
 */
function absRect(el) {
  const own = el.getBoundingClientRect();
  let left = own.left, top = own.top;
  let w = own.width, h = own.height;

  let win = el.ownerDocument?.defaultView;
  let guard = 0;
  while (win && win !== window && guard++ < 5) {
    const fe = win.frameElement;
    if (!fe) break;
    const r = fe.getBoundingClientRect();
    left += r.left;
    top += r.top;
    win = win.parent;
  }
  return { left, top, width: w, height: h };
}

/* ---------------------------- 渲染 ---------------------------- */

function ensureEls() {
  if (overlay?.isConnected && badge?.isConnected) return;

  overlay = document.createElement('div');
  overlay.className = 'nx-insp-overlay';
  // 四段：上/右/下/左，中间镂空 —— 这样既能看清边界，又不遮住元素本身
  for (const k of ['top', 'right', 'bottom', 'left', 'tip']) {
    const d = document.createElement('div');
    d.className = 'nx-insp-' + k;
    overlay.appendChild(d);
  }

  badge = document.createElement('div');
  badge.className = 'nx-insp-badge';

  document.body.appendChild(overlay);
  document.body.appendChild(badge);
}

function clear() {
  overlay?.classList.remove('on');
  badge?.classList.remove('on');
}

function highlight(el) {
  ensureEls();
  const r = absRect(el);
  overlay.classList.add('on');
  overlay.style.setProperty('--x', r.left + 'px');
  overlay.style.setProperty('--y', r.top + 'px');
  overlay.style.setProperty('--w', r.width + 'px');
  overlay.style.setProperty('--h', r.height + 'px');

  const pid = pluginOf(el);
  const isolated = el.tagName === 'IFRAME' && !docOf(el);
  const size = `${Math.round(r.width)} × ${Math.round(r.height)}`;

  badge.innerHTML = '';
  const add = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    badge.appendChild(s);
    return s;
  };
  add('nx-insp-name', labelOf(el));
  add('nx-insp-size', size);
  if (pid) add('nx-insp-plugin', pid);
  if (isolated) add('nx-insp-warn', '隔离·无法深入');
  if (locked === el) add('nx-insp-locked', '已锁定·再点解锁');

  badge.classList.add('on');
  // 贴着高亮框左上角；上方放不下就翻到框内顶部
  const bw = badge.offsetWidth || 240;
  let bx = Math.max(4, Math.min(r.left, innerWidth - bw - 4));
  let by = r.top - badge.offsetHeight - 6;
  if (by < 4) by = r.top + 4;
  badge.style.left = bx + 'px';
  badge.style.top = by + 'px';
}

/* ---------------------------- 交互 ---------------------------- */

/** 复制到剪贴板；非安全上下文（file://）下降级到 execCommand */
async function copy(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 继续降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function onMove(e) {
  if (!on || locked) return;
  const el = elementAt(e.clientX, e.clientY);
  if (!el) { clear(); return; }
  if (el === overlay || overlay?.contains(el) || el === badge) return;
  highlight(el);
}

/** 开发者模式下点击 = 锁定/解锁，并顺手阻止按钮被真的触发 */
function onClick(e) {
  if (!on) return;
  e.preventDefault();
  e.stopPropagation();
  const el = elementAt(e.clientX, e.clientY);
  if (!el) return;
  if (locked === el) {
    locked = null;                    // 再点一次解锁
    highlight(el);
    return;
  }
  locked = el;
  highlight(el);
  const text = pathOf(el);
  copy(text).then((ok) => {
    globalThis.__NEXUS_INSPECTOR_COPY__ = { text, ok };
    try {
      document.dispatchEvent(new CustomEvent('nexus:inspector-copy', { detail: { text, ok } }));
    } catch { /* 测试环境可能没有 CustomEvent */ }
  });
}

/**
 * 处理一次 ESC（两级退出）。
 *
 * 抽成导出函数是因为**有两个入口**都要走它：
 *   · 主文档的 keydown（焦点在界面上）
 *   · 插件 iframe 转发回来的 shell-shortcut（焦点在插件里）
 * 不抽的话两边逻辑迟早写得不一样。
 *
 * @returns {boolean} 是否消费了这次按键（消费了就别再往下传）
 */
export function escInspector() {
  if (!on) return false;
  /*
   * 两级退出，跟 DevTools 一个手感：
   *   已锁定某个元素 → ESC 先解锁（回到悬停模式）
   *   没锁定（悬停中）→ ESC 关闭检查器
   *
   * 此前只写了"解锁"那一半，于是悬停态下 ESC 毫无反应 ——
   * 而这恰恰是最常用的状态（开着到处扫，看完想退）。
   * 那时唯一的退路是再按一次快捷键或点侧边栏按钮，用户不知道就会被困住。
   */
  if (locked) {
    locked = null;
    clear();
  } else {
    setInspector(false);
  }
  return true;
}

function onKey(e) {
  if (!on) return;
  if (e.key !== 'Escape') return;
  /* 别让 ESC 继续往下走 —— 它可能同时是"关闭弹窗"之类的其它快捷键 */
  if (escInspector()) e.stopPropagation();
}

/* ---------------------------- 开关 ---------------------------- */

export function isInspectorOn() {
  return on;
}

export function setInspector(next) {
  const want = !!next;
  if (want === on) return on;
  on = want;
  try {
    localStorage.setItem(KEY, want ? '1' : '0');
  } catch { /* 存储不可用时只影响记忆，不影响本次 */ }

  if (want) {
    ensureEls();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    cleanup = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
    // 开启时给 body 挂个标记，方便 CSS 配合（比如把光标换成十字）
    document.body.classList.add('nx-inspecting');
  } else {
    cleanup?.();
    cleanup = null;
    locked = null;
    clear();
    document.body.classList.remove('nx-inspecting');
  }
  try {
    document.dispatchEvent(new CustomEvent('nexus:inspector-toggle', { detail: { on } }));
  } catch { /* ignore */ }
  return on;
}

export function toggleInspector() {
  return setInspector(!on);
}

/**
 * 安装检查器（只装快捷键与状态恢复，真正的监听在开启时才挂）。
 * @returns {() => void} 卸载函数
 */
export function installInspector() {
  const onKeyCombo = (e) => {
    // Ctrl/Cmd + Shift + D —— 避开 Ctrl+Shift+I（webview 自身的 DevTools）
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (e.key.toLowerCase() !== 'd') return;
    e.preventDefault();
    toggleInspector();
  };
  document.addEventListener('keydown', onKeyCombo, true);

  // 上次开着就自动恢复，省得每次进来都要按一遍
  try {
    if (localStorage.getItem(KEY) === '1') setInspector(true);
  } catch { /* ignore */ }

  return function uninstall() {
    document.removeEventListener('keydown', onKeyCombo, true);
    setInspector(false);
    overlay?.remove();
    badge?.remove();
    overlay = badge = null;
  };
}

/** 测试用 */
export function __debug() {
  return {
    on,
    locked: locked ? labelOf(locked) : null,
    overlayOn: !!overlay?.classList.contains('on'),
    badgeOn: !!badge?.classList.contains('on'),
  };
}

/** 测试用：不依赖真实坐标，直接指定元素 */
export function __inspect(el) {
  if (!el) return;
  highlight(el);
}

export { labelOf, pathOf, pluginOf, absRect, elementAt };
