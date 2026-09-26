/**
 * 思维导图插件 · 侧栏页面与对话框
 * ============================================================
 * 对应 C# 版 MindMapPanel 的四个侧栏页（文件 / 样式 / 标签 / 主题），
 * 外加自定义主题编辑器、视频播放、备份恢复三个浮层。
 *
 * 所有面板只依赖传入的 app 句柄，不直接持有状态：
 *   app.bridge    编辑器桥接
 *   app.api       插件层能力（状态栏提示 / 提交变更 / 取选中节点…）
 *   app.sheet     当前画布
 */

import { h } from '../../js/plugin-sdk.js';
import { confirm as _askConfirm, alert as _askAlert, prompt as _askText } from '../../js/dialog.js';
import { THEMES, LAYOUTS, blankTheme, DEFAULT_THEME, themeSeed, sanitizePalette } from './themes.js';

/**
 * 弹层关闭后「把焦点还给画布」的回调，由插件层注入。
 *
 * **为什么需要**：dialog / popupMenu 都挂在 `document.body` 上（不在 root 内），
 * 关掉时里面的按钮被 remove —— 浏览器此时把 activeElement 退回 `<body>`
 * （实测确认）。而画布的键盘输入全靠 iframe 里一个隐藏 input.km-receiver
 * 持有焦点才收得到，于是**关掉任何一个弹层之后，Delete / 方向键 / F2 /
 * Ctrl+B 全部失效**，直到用户再点一下画布。
 *
 * 不直接在这里 import bridge：panels.js 的约定是「所有面板只依赖传入的
 * app 句柄，不直接持有状态」，而 dialog()/popupMenu() 是模块级函数、
 * 拿不到那个 app。故用注入。
 */
let refocusAfterPopup = null;
export function setPopupRefocus(fn) { refocusAfterPopup = fn; }
function refocusCanvasAfterPopup() {
  try { refocusAfterPopup?.(); } catch { /* 焦点归还失败不该拦住关闭 */ }
}

/**
 * 通用弹层（js/dialog.js 那一套：confirm / alert / prompt）用完同样要还焦点。
 *
 * 【为什么本地 dialog() 修了还不够】panels.js 里存在**两套**弹层：
 * 本地的 dialog()/popupMenu()（已修）与 js/dialog.js 的 confirm/alert/prompt。
 * 后者 mount() 里记的是 `prevFocus = document.activeElement`，关闭时
 * `prevFocus.focus()` 还原 —— 而那个 prevFocus 是**触发它的按钮**（浏览器在
 * mousedown 就把它聚焦了，早于我们的 click 委托）。于是关掉之后焦点又回到
 * 侧栏按钮上，Delete / 方向键 / F2 / Ctrl+B 照样失效。
 *
 * 用 finally 而不是 then：取消、关闭、抛错都要还，否则「取消之后又是坏的」。
 */
const askConfirm = async (o) => { try { return await _askConfirm(o); } finally { refocusCanvasAfterPopup(); } };
const askAlert = async (o) => { try { return await _askAlert(o); } finally { refocusCanvasAfterPopup(); } };
const askText = async (o) => { try { return await _askText(o); } finally { refocusCanvasAfterPopup(); } };

/**
 * 主题重名时加序号（纯函数，可测）。
 *
 * 导入不检查重名的话，同名主题会堆成一列，用户分不清哪个是哪个 ——
 * id 是新生成的，所以「重名」不会导致覆盖，只是**看不出区别**。
 * 加 (2)(3) 后缀比弹框问「是否覆盖」轻：导入是低频操作，
 * 而覆盖会让用户丢掉原来那个。
 */
/**
 * A29 搜索结果的展示文案（纯函数，可测）。
 *
 * 原实现三种情况都显示「无匹配」：
 *   1. 没输入关键字
 *   2. 编辑器还没就绪（此时根本没搜）
 *   3. 真的没搜到
 *
 * 其中第 2 种最误导 —— 用户会以为脑图里确实没有这个词。
 * 前两种要**提醒**（warn），第三种是正常结果，不该报警。
 *
 * @param {string} keyword 搜索框原文
 * @param {object|null} r `EditorBridge.search()` 的返回
 * @returns {{text:string, warn:boolean}}
 */
export function searchStatusText(keyword, r) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return { text: '请输入关键字', warn: true };
  if (!r || r.ok === false) {
    return {
      text: r?.reason === 'error' ? '搜索失败' : '编辑器未就绪',
      warn: true,
    };
  }
  if (!r.total) return { text: '无匹配', warn: false };
  return { text: `${r.index}/${r.total}`, warn: false };
}

/**
 * A5 从剪贴板数据里挑出图片（纯函数，可测）。
 *
 * 走 `paste` 事件而不是 `navigator.clipboard.read()`：
 * 后者要用户授权、且在 WebView2 里常被拒；前者是用户主动 Ctrl+V 的自然结果，
 * 权限与兼容性都更稳。
 *
 * 只认图片：剪贴板里同时可能有文字、HTML、文件，
 * 不加过滤的话会把文本也当成图标（生成一个打不开的条目）。
 *
 * @param {DataTransfer|null} dt
 * @returns {File[]} 图片文件列表
 */
export function imageItemsFromClipboard(dt) {
  if (!dt) return [];
  const out = [];
  // files 优先：多数浏览器复制图片时会给出 File
  for (const f of dt.files || []) {
    if (f && String(f.type || '').startsWith('image/')) out.push(f);
  }
  if (out.length) return out;
  // 兜底：某些环境只填 items 不填 files
  for (const it of dt.items || []) {
    if (it?.kind === 'file' && String(it.type || '').startsWith('image/')) {
      const f = typeof it.getAsFile === 'function' ? it.getAsFile() : null;
      if (f) out.push(f);
    }
  }
  return out;
}

export function uniqueThemeName(name, themes = []) {
  const base = String(name || '未命名').trim() || '未命名';
  const taken = new Set((themes || []).map((t) => t.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}
import { LAYOUT_THUMBS } from './layout-thumbs.js';
import * as io from './io.js';
import * as diag from './diagnostics.js';
import * as store from './store.js';
import * as mi from './mediainfo.js';
import * as picons from './preset-icons.js';
import * as tb from './tag-badges.js';

const FONTS = ['微软雅黑', '宋体', '黑体', '楷体', 'Arial', 'Consolas', 'sans-serif'];
const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40];
// 字号的微调范围。必须比预设档位**更宽**：预设最小 12、最大 40，
// 若把 min/max 卡在档位两端，滚轮微调到那儿就动不了了，
// 而"比 40 再大一点"这种需求是真的存在的（标题节点）。
const MIN_FS = 8;
const MAX_FS = 72;

/**
 * 把当前值补进档位列表，并保持有序（纯函数，可测）。
 *
 * B4/B5：节点的字号/圆角/线宽可能来自导入文件、样式刷或旧版本数据，
 * 不在预设档位里。此时下拉**没有任何一项被选中**，显示成空白或第一项 ——
 * 用户会以为「字号是 12」，实际是 13，随手一改就把值弄丢了。
 *
 * 对齐 WPF `MindMapPanel.xaml.cs:2521-2544` 的做法：动态补项 + 刷新。
 *
 * @param {Array<number>} presets 预设档位（升序）
 * @param {number} value 当前值
 * @returns {Array<number>} 含当前值的新列表（升序、去重）
 */
export function withPresetValue(presets, value) {
  const list = Array.isArray(presets) ? presets.slice() : [];
  // null / '' 要显式挡掉：Number(null) 是 0 且 Number.isFinite(0) 为真，
  // 不挡的话「节点没设字号」会往下拉里塞一个 **0** 选项。
  if (value === null || value === undefined || value === '') return list;
  const n = Number(value);
  if (!Number.isFinite(n)) return list;
  if (list.includes(n)) return list;
  list.push(n);
  // 数值升序：字符串排序会把 100 排到 20 前面
  return list.sort((a, b) => a - b);
}
/* 圆角预设：上限 20，不含 24。
 *
 * kity 的 setRadius 内部是 formatRadius(w, h, r) = min(floor(min(w/2, h/2)), r)
 * —— 圆角**不能超过节点较短边的一半**。实测（真实内核跑在 jsdom 里）：
 *   root   104×40 → 上限 20
 *   子主题  96×26 → 上限 13
 *   长子节点 258×22 → 上限 11
 * 也就是说 24 **在任何节点上都达不到**（最大也只有 20），放在预设里
 * 只会让用户点了发现没变化，以为控件坏了。
 */
const RADII = [0, 3, 5, 8, 12, 16, 20];
/** 圆角可调上限（= 根节点的实测上限 20；再大只会饱和，不会有视觉变化） */
const MAX_RADIUS = 20;
const WIDTHS = [1, 2, 3, 4, 6];

/* --------------------------- 小组件 --------------------------- */

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ogv']);

const extOf = (name) => String(name || '').split('.').pop().toLowerCase();
const isImageName = (name) => IMAGE_EXTS.has(extOf(name));

/** 按扩展名给一个象形图标。附件卡片上比干巴巴的一行文字直观得多。 */
function fileIcon(name) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return '🖼';
  if (VIDEO_EXTS.has(ext)) return '🎬';
  if (ext === 'pdf') return '📕';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return '🗜';
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return '📗';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📙';
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext)) return '🎵';
  if (['txt', 'md', 'log'].includes(ext)) return '📃';
  if (['json', 'xml', 'yml', 'yaml'].includes(ext)) return '🧩';
  return '📄';
}

/* ------------------------- 主题配色条 ------------------------- */

/**
 * 主题预览四色：画布底 / 根节点 / 主节点 / 子节点。
 *
 * 之前每个主题只有一个圆点（根节点色），看不出画布底色和各级节点长什么样 ——
 * 尤其 snow / classic / fish 三者 root 同为 #E9DF98，单看圆点完全分不出来。
 */
function themeSwatch(t) {
  const bg = t?.bg || '#FBFBFB';
  return {
    bg,
    root: t?.root || '#4A90D9',
    main: t?.main || '#DCE9F7',
    // 子节点无填充时透出的是画布底色，按 bg 显示（并标为 transparent）
    sub: t?.sub === 'transparent' ? bg : (t?.sub || '#FFFFFF'),
    subTransparent: t?.sub === 'transparent',
  };
}

/** 自定义主题：palette 字段名与内置主题不同，在这里归一 */
function customSwatch(t) {
  const p = t?.palette || {};
  return themeSwatch({
    bg: p.background || '#FBFBFB',
    root: p.rootBackground || '#4A90D9',
    main: p.mainBackground || '#DCE9F7',
    sub: p.subBackground || p.background || '#FFFFFF',
  });
}

/**
 * 四段颜色条。
 * 段间不留缝也不加分隔线 —— 40px 宽分四段已经很窄，再留缝就成四个孤立色点了。
 */
function swatchBar(s) {
  const seg = (color, title, transparent) =>
    h('span.mm-sw' + (transparent ? '.transparent' : ''), {
      style: { background: color },
      title,
    });
  return h('span.mm-swbar', {},
    seg(s.bg, `画布底色 ${s.bg}`),
    seg(s.root, `根节点 ${s.root}`),
    seg(s.main, `主节点 ${s.main}`),
    seg(s.sub, s.subTransparent ? `子节点 透明（透出 ${s.bg}）` : `子节点 ${s.sub}`, s.subTransparent),
  );
}

function section(title, ...children) {
  return h('div.mm-field', {}, h('h3', {}, title), ...children);
}

/**
 * 标题行右侧带一个操作按钮的 section。
 *
 * 用于「清除样式」这类**作用于整节**的操作：放在标题右边意味着
 * 「这一节的样式都能被它清掉」，语义比在节尾另起一行按钮清楚得多 ——
 * 也避免了四个清除按钮挤成一排、看不出各自管哪一块。
 *
 * 按钮用 .mm-btn.quiet（弱化态）：删除类操作在面板里到处都是，
 * 全都用常规按钮会喧宾夺主，抢走主操作（选色 / 选字号）的注意力。
 */
function sectionAct(title, action, ...children) {
  return h('div.mm-field', {},
    h('div.mm-sec-head', {},
      h('h3', {}, title),
      h('span', { style: { flex: '1 1 auto' } }),
      action),
    ...children);
}

/* ------------------------- 悬浮说明（问号提示框） ------------------------- */

/**
 * 提示框单例。
 *
 * **必须挂到 document.body 而不是留在面板里**：侧栏是
 * `overflow-y: auto` 的滚动容器，提示框若留在里面，一旦内容超出
 * 侧栏边界就会被**裁剪** —— 表现为"提示框只显示一半"或者干脆看不见。
 * 挂 body + `position: fixed` 才能完全不受祖先 overflow 影响。
 */
let helpTipEl = null;
let helpTipAnchor = null;

function ensureHelpTip() {
  if (helpTipEl && helpTipEl.isConnected) return helpTipEl;
  helpTipEl = h('div.mm-helptip', { role: 'tooltip' });
  // 鼠标移到提示框上也要能停住 —— 否则想选中里面文字时一移过去就消失了
  helpTipEl.addEventListener('mouseenter', () => { clearTimeout(helpTipHideTimer); });
  helpTipEl.addEventListener('mouseleave', () => hideHelpTip());
  document.body.appendChild(helpTipEl);
  return helpTipEl;
}

let helpTipHideTimer = 0;

/**
 * 定位并显示提示框。
 *
 * 竖直方向：优先放问号**下方**；下方空间不够则翻到上方。
 * 水平方向：让提示框左边缘尽量贴住问号，但整体**钳在视口内** ——
 * 侧栏贴着窗口右缘，不钳的话提示框会超出屏幕右边被切掉。
 */
function showHelpTip(anchor, lines) {
  const el = ensureHelpTip();
  clearTimeout(helpTipHideTimer);
  el.innerHTML = '';
  const arr = Array.isArray(lines) ? lines : [lines];
  arr.filter(Boolean).forEach((t) => {
    // 用 textContent 构造，不拼 innerHTML —— 说明文案里含冒号引号等字符，
    // 拼串有转义问题；且将来若混入动态内容就是 XSS
    el.appendChild(h('div.mm-helptip-line', {}, String(t)));
  });
  el.style.visibility = 'hidden';
  el.classList.add('open');
  helpTipAnchor = anchor;
  positionHelpTip();
  el.style.visibility = '';
}

function positionHelpTip() {
  const el = helpTipEl;
  if (!el || !helpTipAnchor) return;
  const a = helpTipAnchor.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth || 0;
  const vh = document.documentElement.clientHeight || window.innerHeight || 0;
  const M = 8;                      // 与视口边缘的最小留白

  // jsdom 里 getBoundingClientRect 全为 0 —— 此时别把 top/left 算成负的
  // 一大截（那样在真实环境里会因为初始值错乱闪一下），直接退到 (0,0)
  if (!a.width && !a.height && !a.left && !a.top) {
    el.style.top = '0px'; el.style.left = '0px';
    return;
  }

  let top = a.bottom + 6;
  if (b.height && top + b.height > vh - M) {
    const up = a.top - b.height - 6;
    // 上方也放不下时取空间较大的一侧，而不是硬塞回下方被切掉
    top = (up >= M) ? up : Math.max(M, vh - b.height - M);
  }
  let left = a.left;
  if (b.width) left = Math.min(Math.max(M, left), Math.max(M, vw - b.width - M));

  el.style.top = Math.round(top) + 'px';
  el.style.left = Math.round(left) + 'px';
}

function hideHelpTip() {
  clearTimeout(helpTipHideTimer);
  // 留一点延迟：鼠标从问号移到提示框本体的途中会短暂离开两者，
  // 立即隐藏会导致"怎么都移不过去"
  helpTipHideTimer = setTimeout(() => {
    if (helpTipEl) helpTipEl.classList.remove('open');
    helpTipAnchor = null;
  }, 120);
}

/**
 * 圆形小问号。
 *
 * 说明文字不直接铺在界面上：它们都是"用之前不必知道、想知道时再看"的
 * 补充信息，全铺开会让导入导出页变成一整页说明文字，按钮反而找不着。
 *
 * 用**自定义提示框而不是原生 title**：title 有 1 秒以上延迟、
 * 不能换行、长句会拉成一条横贯屏幕的长条，且样式完全不受控。
 */
function helpDot(text, label) {
  const dot = h('button.mm-help', {
    type: 'button',
    'aria-label': label || '说明',
    title: '',           // 置空：否则自定义提示框与原生 title 会**同时**弹两个
  }, '?');
  dot.addEventListener('mouseenter', () => showHelpTip(dot, text));
  dot.addEventListener('mouseleave', () => hideHelpTip());
  dot.addEventListener('focus', () => showHelpTip(dot, text));
  dot.addEventListener('blur', () => hideHelpTip());
  return dot;
}

/**
 * 带问号的节标题。
 *
 * 问号放在**标题行右侧**（与「清除样式」按钮同位置）。放在标题左边会
 * 把标题挤得参差不齐 —— 各节标题字数不一，左边对齐的是标题本身。
 */
function sectionTip(title, tip, ...children) {
  return h('div.mm-field', {},
    h('div.mm-sec-head', {},
      h('h3', {}, title),
      helpDot(tip, `${title}：说明`),
      h('span', { style: { flex: '1 1 auto' } })),
    ...children);
}

/**
 * 弱化删除按钮（✕）。
 *
 * 样式面板里清除类操作很多（清颜色、清图标、清各类样式），
 * 若都做成常规 .mm-btn，整页会是一排排实心按钮，
 * 主操作（选色块 / 选字号 / 选徽章）反而被淹没了。
 * 这里统一用一个无背景、弱化色的图标按钮。
 */
function quietBtn(title, onclick) {
  // 用 ⟲ 而不是 ✕ / ×：
  // ✕ 在界面上的通行含义是「关闭 / 取消」，而这里是「把样式恢复默认」。
  // 用户看到 ✕ 会以为点了就把这一节收起来，不敢点。
  // ⟲ 表达的是「还原」，与清除样式的实际行为一致。
  return h('button.mm-btn.quiet.icon', { onclick, title }, '⟲');
}

/**
 * 取色行。
 *
 * `extras` 用于把同类控件塞进**同一行**（例如字体色后面跟 B / I / S）。
 * 分开成两行的代价不只是多占一行高度：颜色与字形修饰都是「文字外观」，
 * 拆开后用户要理解为两组不同的东西，而它们其实是同一组。
 */
function colorRow(label, value, onPick, onClear, extras) {
  const inp = h('input', {
    type: 'color',
    value: value || '#4A90D9',
    style: { position: 'absolute', inset: '0', opacity: '0', width: '100%', height: '100%', cursor: 'pointer' },
    oninput: (e) => onPick(e.target.value),
  });
  const sw = h('button.mm-swatch', {
    style: { background: value || '#4A90D9', position: 'relative' },
    title: label,
    onclick: () => inp.click(),
  }, inp);
  return h('div.mm-row', {},
    h('span.mm-label', { style: { minWidth: '48px' } }, label),
    sw,
    onClear ? quietBtn(`清除${label}`, onClear) : null,
    ...(extras || []),
  );
}

/**
 * 面板内部异步兜底：与 index.js 的 guard() 同职责。
 * 面板层是独立模块，拿不到 index.js 里那个，这里自备一个 ——
 * onclick 拿不到 Promise，失败必须转成状态栏提示，否则界面毫无反应。
 */
function safe(label, fn, onErr) {
  return (...args) => {
    let r;
    try {
      r = fn(...args);
    } catch (e) {
      onErr(`${label}失败：${e?.message || e}`);
      return undefined;
    }
    if (r && typeof r.then === 'function') {
      return r.catch((e) => { onErr(`${label}失败：${e?.message || e}`); });
    }
    return r;
  };
}

/**
 * Windows 经典数值输入框（up-down control）。
 *
 * 三件事分开做，缺一件都会让人以为控件坏了：
 *   1. ▲ / ▼ —— ±1
 *   2. ▾ —— 弹出预设值列表（圆角 / 线宽 / 字号各有常用档位，逐个点更快）
 *   3. 滚轮 —— ±1
 *
 * **滚轮是 ±1，不是在预设列表里前后挪**。这两者差别很大：圆角预设是
 * [0,3,5,8,12,16,24]，在 3 上滚一下若是"下一个选项"就跳到 5，
 * 而用户期望的是 4 —— 微调要靠滚轮，粗调才用列表。
 *
 * @param {object} o
 * @param {number} o.value   当前值
 * @param {number} o.min     下限（滚轮/箭头都钳在这里）
 * @param {number} o.max     上限
 * @param {number[]} o.list  预设值（下拉列表的内容，可为空）
 * @param {(v:number)=>void} o.onChange
 */
export function numSpinner(o) {
  const min = Number.isFinite(o.min) ? o.min : 0;
  const max = Number.isFinite(o.max) ? o.max : 999;
  const list = (o.list || []).filter((v) => Number.isFinite(v));
  /** 钳到 [min,max] 并取整 —— 输入框里可能粘进 "12.7" 或 "abc" */
  const clamp = (v, fallback) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };

  /*
   * 初值**也要钳**。此前只在 emit 里钳，初值是裸的 Math.round(Number(v))：
   *   Number(null) === 0   → cur = 0
   *   Number('')   === 0   → cur = 0
   * 而线宽的 min 是 1 —— 于是框里会显示 **0**，一个根本不在允许范围内的值
   * （上报侧 strokeWidth / lineWidth 在主题值为 0 时确实会给出 "0"）。
   * 用户看到 0 只会以为「线宽设成了 0，所以看不见边框」。
   *
   * fallback 传 min：初值解析不出来时用下限 —— 此时没有"上一次的值"可用。
   */
  let cur = clamp(o.value, min);
  const emit = (v) => {
    const n = clamp(v, cur);
    if (n === cur) { inp.value = String(n); return; }   // 无变化就别回调，免得白记一次撤销
    cur = n;
    inp.value = String(n);
    o.onChange?.(n);
  };

  const inp = h('input.mm-num', {
    type: 'text',
    inputmode: 'numeric',
    value: String(cur),
    title: o.title || '',
    onchange: (e) => emit(e.target.value),
    onkeydown: (e) => {
      // ↑ / ↓ 与按钮同义；输入框里按方向键挪光标是另一回事，这里直接接管
      if (e.key === 'ArrowUp') { e.preventDefault(); emit(cur + 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); emit(cur - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); emit(inp.value); }
    },
  });
  // 失焦时把非法输入还原成当前值 —— 留着 "abc" 在框里，用户会以为真的设成了
  inp.addEventListener('blur', () => { inp.value = String(cur); });

  const arrow = (glyph, delta, tip) => h('button.mm-num-arrow', {
    tabindex: '-1',
    title: tip,
    onclick: () => { emit(cur + delta); inp.focus(); },
  }, glyph);

  const caret = h('button.mm-num-arrow.mm-num-caret', {
    tabindex: '-1',
    title: '选择预设值',
    onclick: () => {
      if (!list.length) return;
      popupMenu(caret, list.map((v) => ({
        label: String(v),
        onSelect: () => emit(v),
      })));
    },
  }, '▾');

  const box = h('span.mm-num-box', {},
    inp,
    h('span.mm-num-spin', {}, arrow('▲', 1, '增加 1'), arrow('▼', -1, '减少 1')),
    caret,
  );

  /* ---- 滚轮 ----
   * 一次手势只走一格：触控板一划就是几十个 wheel 事件，不锁的话数值会瞬间
   * 冲到上限。与图片预览同一套做法（触发后上锁，静默 WHEEL_GAP 才解锁）。
   */
  const WHEEL_GAP = 90;
  let locked = false;
  let idle = 0;
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (locked) return;
    locked = true;
    // 只看方向，不看 delta 大小：惯性滚动的 delta 能攒到几百，
    // 按量换算会一次跳很多格
    emit(cur + (e.deltaY < 0 ? 1 : -1));
    clearTimeout(idle);
    idle = setTimeout(() => { locked = false; }, WHEEL_GAP);
  }, { passive: false });

  return box;
}

function chips(items, current, onPick) {
  return h('div.mm-grid', {},
    ...items.map((it) =>
      h('button.mm-chip' + (String(current) === String(it.v) ? '.on' : ''), {
        onclick: () => onPick(it.v),
        title: it.t || String(it.v),
      }, it.t || String(it.v))),
  );
}

/* =========================== 侧栏主体 =========================== */

/**
 * 右侧属性侧栏。
 * ============================================================
 * 对齐 C# 版 MindMapPanel：主体区是两列网格，画布占 Column 0，
 * 侧栏占 Column 1 固定 276px 且**常驻**（XAML 里没有折叠逻辑）。
 *
 * 四个页签（主题 / 标签 / 样式 / 文件）**不在**这里 —— C# 把它们的
 * ToggleButton 放在顶栏最右（Grid.Column=14），由 index.js 的 buildToolbar
 * 生成，通过 opts.onPage 回调与本处的当前页保持高亮同步。
 *
 * 页签也曾短暂地放在侧栏顶部，但那样会占掉侧栏内容约 34px 的可用高度，
 * 且与原版不符，故改回顶栏。
 */
export function buildSide(app, opts = {}) {
  const pages = {};
  let current = null;

  /**
   * 本侧栏实例创建的 Blob URL 池。
   * ============================================================
   * io.getAsset(id, true) 每次调用都**新建一个** URL —— 这是刻意为之
   * （调用方各自持有、各自释放，避免共享 URL 被谁提前 revoke），
   * 代价是每次 refresh（切页、附加/移除附件后重建 DOM）都会漏一批。
   * 视频预览 + 图片缩略图一次就要两个，漏得更快。
   *
   * 侧栏没有 unmount 钩子，统一在 render 重建 DOM 前回收。
   * 挂在实例上而非模块级：模块级单例会被多个侧栏实例互相 revoke 掉还在用的 URL。
   */
  let mediaUrls = [];
  const trackMediaUrl = (u) => { if (u) mediaUrls.push(u); return u; };
  const releaseMediaUrls = () => {
    for (const u of mediaUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
    mediaUrls = [];
  };

  const body = h('div.mm-side.open', {});   // 常驻：初始即带 open
  const el = body;

  /** 切换页。常驻侧栏不再有「再点一次收起」的语义 —— 那会把面板点没。 */
  function open(page) {
    if (!pages[page]) return;
    current = page;
    body.dataset.page = page;      // 标记当前页，便于外部（含测试）判断侧栏停在哪个页
    render();
    opts.onPage?.(page);           // 顶栏页签据此同步高亮
  }

  function render() {
    // 重建 DOM 前先回收上一批 Blob URL —— refresh 会被「附加/移除附件」
    // 反复触发，不回收就会一直攒着（每个视频都是一份完整文件的内存映射）
    releaseMediaUrls();
    body.innerHTML = '';
    body.appendChild(pages[current]());
  }

  function refresh() {
    if (current) render();
  }

  /* ------------------------- 导入导出页 ------------------------- */

  /**
   * 导入导出页。
   *
   * 界面上**所有**导入导出入口集中在这里 —— 顶栏那 7 个按钮
   * （导入 / 导出▾ / XMIND / TXT / MD / SVG / PNG）已移除，
   * 历史快照弹窗里的导入导出按钮也一并收过来。
   *
   * 为什么集中：原先分散在顶栏、文件页、主题页、快照弹窗四处，
   * 同一个「导出」在不同地方能点到的格式还不一样（顶栏有 PNG 倍率、
   * 文件页只有 JSON/MD），用户不知道去哪儿找某个格式。
   *
   * **例外：主题的导入 / 导出留在主题页**，与「新建 / 编辑 / 删除」同排。
   * 它们操作的是「主题」这个对象，和主题列表是一组连贯动作；收进本页后
   * 主题页要靠一句 hint 指路，等于把一组连贯操作拆成两地。
   * 集中原则解决的是"同一个导出在不同地方长得不一样"，
   * 而主题这里是"同一对象的操作要不要分开" —— 后者不该拆。
   */
  function pageExchange() {
    const btn = (label, onclick, title) => h('button.mm-btn', {
      onclick: safe(label, onclick, (m) => app.api.status(m, true)),
      title: title || '',
    }, label);

    /** 一行按钮（自动换行，格式多时不至于挤成一团） */
    const row = (...els) => h('div.mm-row', {}, ...els);
    const hint = (t) => h('div.mm-hint', {}, t);

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      // 各节的**补充**说明都收进标题右边的问号里，界面上只留按钮。
      // 保留在界面上的只有「导入会替换且不可撤销」这一条 ——
      // 那是会造成数据丢失的警告，藏进悬浮框里就有可能被跳过不看。
      sectionTip('导入',
        ['支持 XMind / JSON / Markdown / FreeMind / OPML / Mermaid / PlantUML。',
          '按文件内容嗅探格式 —— 把 .opml 存成 .xml、把 .mmd 存成 .txt 也能认出来。'],
        row(btn('导入文件…', () => app.api.importFile(), '选择文件导入（会替换全部画布，导入前有确认）')),
        hint('⚠ 导入会替换当前所有画布，且不可撤销 —— 建议先导出或备份。'),
      ),

      sectionTip('导出为文档',
        ['XMind 与官方互通（多画布、主题、外框、附件一并打包，换机可还原）。',
          'JSON 保留全部私有字段，本工具无损往返。',
          'Markdown 便于人读与 diff（多画布按「## 画布：」分块）。'],
        row(
          btn('XMind', () => app.api.exportXMind(), '导出为 .xmind（含附件打包）'),
          btn('JSON', () => app.api.exportJson(), '导出为 .json（本工具无损往返）'),
          btn('TXT', () => app.api.exportTxt(), '导出为 .txt（与 JSON 同内容，仅扩展名不同）'),
          btn('Markdown', () => app.api.exportMarkdown(), '导出为 .md（多画布按「## 画布：」分块）'),
        ),
      ),

      // 「（单画布）」必须写在标题里：这几种格式顶层只有一个根，装不下多画布，
      // 只导当前画布。不写明的话用户会以为多画布都导了，在别的软件里打开
      // 发现少了一半，回来也不知道问题出在哪。
      sectionTip('导出为交换格式（单画布）',
        ['给别的软件用。这些格式顶层只有一个根，装不下多画布 —— 只导当前画布，其余画布不写入。',
          '只交换「文字 + 层级 + 折叠状态」；图标、优先级、进度、附件一概不写 —— '
          + '塞进自定义属性只会在别的软件里变乱码。'],
        row(
          btn('FreeMind', () => app.api.exchange('freemind'), 'FreeMind / Freeplane / XMind 可导入'),
          btn('OPML', () => app.api.exchange('opml'), 'OmniOutliner / Workflowy / 幕布 等大纲工具'),
          btn('Mermaid', () => app.api.exchange('mermaid'), 'GitHub / GitLab / Notion / Obsidian 原生渲染'),
          btn('PlantUML', () => app.api.exchange('plantuml'), 'PlantUML / Confluence / 多数 Wiki'),
        ),
      ),

      sectionTip('导出为图像 / PDF',
        ['SVG 是矢量图，可无损放大；PDF 不经浏览器、不弹对话框直接保存。',
          'PNG 倍率要你主动选：默认 3 倍的话一个普通脑图会导出几十 MB，多数人并不需要。'],
        row(
          btn('SVG', () => app.api.exportSvg(), '矢量图，可无损放大'),
          btn('PDF（矢量）', () => app.api.exportPdf(), '不经浏览器、不弹对话框，直接保存；失败时自动改用打印对话框'),
          btn('打印 / 存为 PDF…', () => openPrintSettings(app, (o) => app.api.printMap(o)),
            '用系统打印对话框，可在其中选「另存为 PDF」'),
        ),
        row(
          btn('PNG · 1 倍', () => app.api.exportPng(1), '位图，1 倍 = 画布原尺寸'),
          btn('PNG · 2 倍', () => app.api.exportPng(2), '像素密度翻倍，文字与连线不糊'),
          btn('PNG · 3 倍', () => app.api.exportPng(3), '体积较大，适合打印或大屏'),
        ),
      ),

      sectionTip('快照备份',
        ['快照是自动 / 手动保存的历史副本，误操作后可回滚。',
          '导出 / 导入快照用于换机迁移（按时间戳去重）。'],
        row(
          btn('立即备份', async () => { await app.api.backupNow(); refresh(); }, '立刻保存一份当前状态'),
          btn('历史快照…', () => openBackups(app), '查看 / 恢复快照'),
          btn('导出快照', () => app.api.exportBackups(), '把所有快照导出为 JSON 文件（换机迁移用）'),
          btn('导入快照…', () => app.api.importBackups(), '从 JSON 文件导入快照（按时间戳去重）'),
        ),
      ),
    );
  }

  pages.file = pageFile;
  pages.style = pageStyle;
  pages.tag = pageTag;
  pages.theme = pageTheme;
  pages.exchange = pageExchange;

  /* ------------------------- 文件页 ------------------------- */

  /**
   * 附件元信息表。
   * 名称/大小来自节点引用（同步可得），类型与修改时间在资产库里，
   * 视频还要解析文件头 —— 所以整块先占位，异步填完再局部更新，
   * 不阻塞面板首次渲染。
   */
  function metaRow(k, v) {
    const val = v == null || v === '' ? '—' : String(v);
    return h('div.mm-meta-row', {},
      h('span.mm-meta-k', {}, k),
      h('span.mm-meta-v', { title: val }, val));
  }

  function fillMeta(box, rows, empty) {
    box.innerHTML = '';
    if (!rows) {
      box.appendChild(h('div.mm-hint', {}, empty));
      return;
    }
    for (const [k, v] of rows) box.appendChild(metaRow(k, v));
  }

  /** 文件信息：名称 / 大小 / 类型 / 修改时间 */
  async function fillFileMeta(ref, box) {
    // 名称与大小已经显示在卡片上，这里只补卡片放不下的项，避免重复
    box.innerHTML = '';
    if (!ref) return;                             // 「未附加」由卡片自己表达

    // A16 路径失效：**仍展示已知字段 + 失效原因**（对照 WPF LoadFileIntoPanel，
    // :552-557）。原版在文件被移动/删除时照样列出类型与所在目录，理由是
    // 「方便定位是哪个附件失效」—— 只写一句「打不开」，用户连是哪个文件都不知道。
    if (!ref.a) {
      const rows = [['类型', mi.shortType('', ref.n)]];
      if (ref.legacyPath) {
        rows.push(['所在目录', io.dirOf(ref.legacyPath) || '—']);
        rows.push(['完整路径', ref.legacyPath]);
      }
      fillMeta(box, rows, '');
      box.appendChild(h('div.mm-hint.warn', {}, '原文件已不在原路径（C# 版遗留的本地路径引用），请重新附加一次'));
      return;
    }

    const a = await io.getAsset(ref.a);          // 只要元信息，不建 URL
    if (!a) {
      box.appendChild(h('div.mm-hint', {}, '附件数据已丢失（可重新附加一次）'));
      return;
    }

    // A17 / B23 / B24：类型 · 大小 · 修改时间 · 添加时间 · 所在目录
    //
    // 「创建时间」在 Web 版没有直接对应 —— 沙箱里的文件是附加时存进来的副本，
    // 操作系统那个 ctime 无从取得。最接近的语义是**添加时间**（addedAt），
    // 即这份附件进入本脑图的时间；原文件在磁盘上的创建时间拿不到，
    // 硬凑一个不存在的值不如写明它是什么。
    const rows = [
      ['类型', mi.shortType(a.type, a.name || ref.n)],
      ['大小', io.formatSize(a.size ?? ref.s)],
      ['修改', mi.formatDateTime(a.mtime || a.addedAt)],
      ['添加', mi.formatDateTime(a.addedAt)],
    ];
    // 目录只对老路径有意义；新附件存在 IndexedDB 里，没有文件系统路径可谈
    if (ref.legacyPath) rows.push(['所在目录', io.dirOf(ref.legacyPath) || '—']);
    fillMeta(box, rows, '');
  }

  /**
   * 视频元信息：分辨率 / 帧率 / 比特率 / 视频编码 / 音频编码 / 时长。
   * 浏览器只给得出时长与分辨率，帧率和编解码器必须解容器，
   * 所以走 mediainfo.probeVideo；结果写回资产库，下次打开直接读。
   */
  async function fillVideoMeta(vref, box, onMeta) {
    // 名称 / 大小 / 时长 由预览区下方的摘要行显示，这里只列技术参数
    box.innerHTML = '';
    if (!vref) return;                            // 「未附加」由预览区自己表达
    if (!vref.a) {
      box.appendChild(h('div.mm-hint', {}, '旧版本地路径，沙箱内读不到文件本体'));
      return;
    }
    const a = await io.getAsset(vref.a);          // 只要元信息，不建 URL
    if (!a) {
      box.appendChild(h('div.mm-hint', {}, '视频数据已丢失（可重新附加一次）'));
      return;
    }

    let meta = a.meta;
    if (!meta) {
      box.appendChild(h('div.mm-hint', {}, '正在解析媒体信息…'));
      meta = await mi.probeVideo(a.blob);
      await io.saveAssetMeta(vref.a, meta);       // 缓存，避免每次开面板都解析
    }

    const w = meta.width || 0;
    const h_ = meta.height || 0;
    const vcodec = [meta.videoCodec, meta.videoCodecDetail ? `(${meta.videoCodecDetail})` : '']
      .filter(Boolean).join(' ') || '—';
    const acodecParts = [meta.audioCodec, mi.formatChannels(meta.audioChannels)];
    if (meta.audioSampleRate) acodecParts.push(`${(meta.audioSampleRate / 1000).toFixed(meta.audioSampleRate % 1000 ? 1 : 0)} kHz`);
    const acodec = acodecParts.filter(Boolean).join(' · ') || '—';

    fillMeta(box, [
      ['分辨率', w && h_ ? `${w}×${h_}` : '—'],
      ['帧率', mi.formatFps(meta.frameRate)],
      ['比特率', mi.formatBitrate(meta.bitrate)],
      ['视频编码', vcodec],
      ['音频编码', acodec],
      ['容器', meta.container || '—'],
    ], '');
    // 时长不在表里了，回填给预览区下方的摘要行
    try { onMeta?.(meta); } catch { /* 摘要行写不进去不影响别处 */ }
  }

  /**
   * 附件卡片：图标（图片则直接显示缩略图）+ 名称 + 大小，点一下即打开。
   * 之前的形态是「两行文字 + 三个按钮」，文件长什么样完全看不出来。
   */
  function buildFileCard(ref, onOpen) {
    if (!ref) return h('div.mm-acard.empty', {}, '当前节点未附加文件');

    const name = ref.n || '未命名';
    const iconBox = h('div.mm-acard-icon', {}, fileIcon(name));

    // 图片直接显示缩略图：比一个 🖼 图标有用得多
    if (ref.a && isImageName(name)) {
      safe('读取缩略图', async () => {
        const asset = await io.getAsset(ref.a, true);
        if (!asset?.url) return;
        trackMediaUrl(asset.url);
        iconBox.innerHTML = '';
        iconBox.appendChild(h('img.mm-acard-thumb', { src: asset.url, alt: name }));
      }, () => { /* 缩略图失败不影响卡片本身，留着图标即可 */ })();
    }

    return h('button.mm-acard', { title: '点击打开', onclick: onOpen },
      iconBox,
      h('div.mm-acard-main', {},
        h('div.mm-acard-name', { title: name }, name),
        h('div.mm-acard-sub', {}, io.formatSize(ref.s))),
    );
  }

  /**
   * 视频预览：默认显示首帧，点一下**就地**播放（不再弹浮层）。
   * 返回 { el, setDuration } —— 时长要等媒体头解析完才知道，由 fillVideoMeta 回填。
   */
  function buildVideoPreview(vref) {
    const dur = h('span.mm-vsum-dur', {}, '');
    // A21 播放状态：C# 版是 MediaElement 的播放/暂停两态；
    // 这里用一个文字标记表达，比让用户去猜控件里的三角形是朝哪边清楚。
    const state = h('span.mm-vsum-state', {}, '');
    const box = h('div.mm-vthumb', {});
    // A20 进度条：原生 controls 在 276px 侧栏里会被挤成一条，
    // 播放/音量/全屏几个按钮叠在一起几乎点不中。这里单独给一条可拖拽的时间轴。
    const bar = h('input.mm-vseek', {
      type: 'range', min: '0', max: '1000', value: '0', step: '1',
      disabled: true,            // 时长未知前无法定位
      title: '拖动定位',
    });
    const wrap = h('div.mm-vwrap', {},
      box,
      h('div.mm-vsum', {},
        h('span.mm-vsum-name', { title: vref?.n || '' }, vref?.n || '未附加视频'),
        dur,
        state,
        h('span.mm-vsum-size', {}, vref?.s ? io.formatSize(vref.s) : '')),
      bar,
    );

    let video = null;
    let seeking = false;      // 正在拖进度条：期间 timeupdate 不许回写，否则滑块会跟手指打架

    /**
     * 时长未知的两种情况都要挡住：元数据还没解析完（NaN），或是直播流（Infinity）。
     * 这两种情况下进度条没有意义，放开会让滑块行为诡异（拖到 Infinity）。
     */
    const seekable = () => !!video && Number.isFinite(video.duration) && video.duration > 0;

    const syncBar = () => {
      if (!seekable()) return;
      bar.disabled = false;
      if (!seeking) bar.value = String(Math.round((video.currentTime / video.duration) * 1000));
    };

    const setState = (s) => {
      state.textContent = s === 'playing' ? '播放中' : s === 'paused' ? '已暂停' : s === 'ended' ? '已结束' : '';
      // 状态同时反映在缩略图上，封面状态下看摘要行容易漏看
      box.classList.toggle('is-playing', s === 'playing');
    };

    bar.addEventListener('input', () => {
      if (!seekable()) return;
      seeking = true;
      video.currentTime = (Number(bar.value) / 1000) * video.duration;
    });
    // 松手才解除锁定：拖拽期间 timeupdate 会持续回调，不锁住滑块会来回跳
    const endSeek = () => { seeking = false; };
    bar.addEventListener('change', endSeek);
    bar.addEventListener('pointerup', endSeek);

    const setDuration = (d) => { dur.textContent = (d && mi.formatDuration(d)) || ''; };

    /**
     * 三态必须分开说清楚 —— 混在一起就是「视频凭空消失」。
     *
     * 之前只有「有 a」和「没有 a」两态，没有 a 时统一显示「未附加视频」。
     * 但 vref 存在而 vref.a 为空是**另一种情况**：C# 版迁移过来的纯路径引用，
     * 或者 .xmind 里没打包本体 —— 节点上明明挂着视频（画布图标还在画着），
     * 侧栏却说「未附加」，看起来就像视频被一起删掉了。
     */
    if (!vref) {
      box.classList.add('empty');
      box.appendChild(h('div.nx-empty.mm-vthumb-empty', {}, '未附加视频'));
      return { el: wrap, setDuration };
    }
    if (!vref.a) {
      box.classList.add('empty');
      box.appendChild(h('div.nx-empty.mm-vthumb-empty', {}, '旧版本地路径，沙箱内读不到本体'));
      return { el: wrap, setDuration };
    }
    // 加载中先给个说法：整块纯黑会被当成「没了」
    box.classList.add('loading');
    box.appendChild(h('div.nx-empty.mm-vthumb-empty', {}, '读取中…'));

    const start = () => {
      if (!video) return;
      // 就地播：不换元素、不弹窗。controls 里自带全屏，侧栏里放不下也能看。
      video.controls = true;
      video.muted = false;
      video.currentTime = 0;
      box.classList.add('playing');
      try {
        const p = video.play();
        // 自动播放可能被浏览器策略拒绝；controls 已经出来了，用户能自己点
        if (p && p.catch) p.catch(() => {});
      } catch {
        // 环境根本没实现 play（jsdom 直接抛 Not implemented）。
        // 控件已经挂上，不影响手动播放。
      }
    };

    /**
     * A21 播放状态 / A20 进度同步。
     *
     * 状态由**元素事件**驱动而不是在 start() 里直接写「播放中」：
     * play() 可能被浏览器策略拒绝（此时并没有真的在播），也可能播完自动停。
     * 只有元素自己报的事件才是可信的。
     */
    const bindPlayback = () => {
      if (!video) return;
      video.addEventListener('play', () => setState('playing'));
      video.addEventListener('pause', () => setState('paused'));
      video.addEventListener('ended', () => setState('ended'));
      video.addEventListener('timeupdate', syncBar);
      video.addEventListener('loadedmetadata', syncBar);
    };

    safe('读取视频', async () => {
      const asset = await io.getAsset(vref.a, true);
      if (!asset?.url) {
        // 清掉「读取中…」再写结论，否则两段文字叠在一起
        box.classList.remove('loading');
        box.classList.add('broken');
        box.innerHTML = '';
        box.appendChild(h('div.nx-empty.mm-vthumb-empty', {}, '视频数据已丢失'));
        return;
      }
      trackMediaUrl(asset.url);
      // preload=metadata 只拉头部：能解出首帧当封面，又不会把整个视频读进内存。
      // #t=0.1 是必要的 —— 不少浏览器不 seek 就不绘制首帧，只显示一片黑。
      video = h('video.mm-vthumb-media', {
        src: asset.url + '#t=0.1',
        preload: 'metadata',
        muted: true,
        playsinline: true,
      });
      video.addEventListener('error', () => {
        box.classList.add('broken');
        app.api.status('视频无法播放（格式可能不受支持）', true);
      });
      // 首帧就绪再撤掉「读取中…」：提前清会让黑块闪一下，看着像加载失败
      video.addEventListener('loadeddata', () => {
        box.classList.remove('loading');
        const t = box.querySelector('.mm-vthumb-empty');
        if (t) t.remove();
      });
      // ▶ 只是个视觉提示，点击交给 box，避免按钮与容器双重触发
      box.innerHTML = '';
      box.appendChild(video);
      box.appendChild(h('div.mm-vthumb-play', {}, '▶'));
      box.classList.remove('loading');
      box.classList.add('ready');
      bindPlayback();
      syncBar();
    }, (m) => app.api.status(m, true))();

    // 点缩略图 = 播放/暂停切换（再次点击暂停，符合媒体播放器习惯）
    box.addEventListener('click', () => {
      if (!video) return;
      if (video.paused) start();
      else { try { video.pause(); } catch { /* jsdom 等环境可能未实现 */ } }
    });
    return { el: wrap, setDuration };
  }

  /**
   * 文件页（多附件）。
   *
   * 一个节点可挂**多个**文件、多个视频、多张图片，所以这里是列表而不是单个卡片。
   * 关键变化：附加一律是**追加**（`appendRef`），不再有"顶掉原有附件"这回事，
   * 因此也不再需要覆盖确认 —— 那条设置项一并取消。
   *
   * 详情区（A16/A17/A20 的目录、时间、时长）跟着"当前选中项"走：
   * 全展开会让一个挂了 5 个附件的节点把侧栏撑到没法用。
   */
  // 「详情区显示第几个」必须存在 **pageFile 之外**。
  // pageFile 每次 refresh 都会重新执行，写在里面等于每次刷新都归 0 ——
  // 点第 3 个文件想看它的详情，refresh 完又跳回第 1 个，点了没反应。
  let _curFile = 0;
  let _curVid = 0;
  // 弹文件选择框**之前**记住的节点 id（见 focusNode 的说明）
  let _pendingNodeId = '';

  function pageFile() {
    const files = app.api.selectedRefs('file');
    const videos = app.api.selectedRefs('video');
    const images = app.api.selectedImages();
    // 存量过大图片：单位是 dataURL 字符数，与 images 元素本身一致（不是原文件字节数）。
    // 压缩是这一版新加的，老文档里那些过去塞进去的大图只能靠这个入口瘦。
    const heavy = images.filter((u) => String(u).length > io.IMG_INLINE_MAX);

    // 换节点 / 删了附件之后索引可能越界，钳回 0（不是显示 undefined）
    if (_curFile >= files.length) _curFile = 0;
    if (_curVid >= videos.length) _curVid = 0;
    const curFile = _curFile;
    const curVid = _curVid;

    const fileMeta = h('div.mm-meta', {});
    const videoMeta = h('div.mm-meta', {});
    const vprev = buildVideoPreview(videos[curVid] || null);
    safe('读取文件信息', () => fillFileMeta(files[curFile], fileMeta),
      (m) => { app.api.status(m, true); })();
    safe('读取视频信息', () => fillVideoMeta(videos[curVid], videoMeta, vprev.setDuration),
      (m) => { app.api.status(m, true); })();

    /**
     * 写回前**切回目标节点**。
     *
     * 文件选择框是异步的：弹框期间焦点离开 iframe，选中态可能已经丢了。
     * 而所有命令都作用于「当前选中节点」—— 没有选中就**静默什么都不做**，
     * 表现为「点了没反应，而且面板读不到任何附件」。
     * 所以异步之前记住 nodeId，写回之前切回来。
     *
     * @returns {boolean} 切回成功（false = 现在没有选中节点，调用方应提示）
     */
    const focusNode = () => {
      const id = _pendingNodeId || app.bridge?.getSelectedNodeId?.() || '';
      if (!id) return false;
      /*
       * **必须检查 selectNodeById 的返回值**。
       *
       * 它靠 id 遍历整棵树去找节点（见编辑器 __minderSelectNode），
       * 找不到就返回 false —— 比如附加过程中用户把那个节点删了。
       * 早先这里不看返回值、一律 return true，于是：
       *   写回作用于「当前选中节点」（可能是**另一个**节点，或根本没有），
       *   而界面照样提示「已附加 xxx」—— 附件挂错地方甚至丢失，假成功。
       */
      return !!app.bridge?.selectNodeById?.(id);
    };
    /** 弹选择框**之前**调用：把当前节点 id 存下来 */
    const rememberNode = () => { _pendingNodeId = app.bridge?.getSelectedNodeId?.() || ''; };

    /** 读当前某类的原始串（用于追加/删除后写回） */
    const rawOf = (kind) => (kind === 'video' ? app.bridge.getSelectedVideo() : app.bridge.getSelectedFile());

    const setList = (kind, list) => {
      app.bridge[kind === 'video' ? 'setVideo' : 'setFile'](list.length ? io.encodeRefList(list) : null);
    };

    /** 附加（追加，不覆盖） */
    const attach = async (kind) => {
      const label = kind === 'video' ? '视频' : '文件';
      rememberNode();                       // 必须在**弹框之前**
      const f = await io.pickFile(kind === 'video' ? 'video/*' : '');
      if (!f) return;
      // 体积上限：附件本体在 IndexedDB 不进文档，但导出 .xmind 会连字节打包，
      // 让一个 2GB 的视频进来等于把导出变成必然失败
      if (io.overAssetLimit(f)) {
        app.api.status(`「${f.name}」${io.formatSize(f.size)} 超过附件上限 ${io.formatSize(io.ASSET_MAX)}`, true);
        return;
      }
      /*
       * 存资产与取封面**并发**做，且都排在 focusNode() **之前**。
       *
       * 顺序不能反：focusNode() 之后如果还有 await，期间用户点了别处，
       * 写回就会挂到新的选中节点上 —— 正是上方注释警告的那类数据错乱。
       *
       * 封面必须在这里取：拖放那条路（index.js handleDropFiles）早就存了
       * ref.t，唯独按钮这条路没有 —— 于是「拖进来的视频有封面、
       * 点按钮附加的没有」，看着像渲染坏了。
       */
      const [id, thumb] = await Promise.all([
        io.putAsset(f),
        kind === 'video' ? Promise.resolve(app.api.videoThumb?.(f) || null) : Promise.resolve(null),
      ]);
      if (!id) { app.api.status('附件保存失败', true); return; }
      // 写回前切回：putAsset 和 pickFile 都是异步的，期间选中可能已丢
      if (!focusNode()) { app.api.status('请先选中一个节点再附加', true); return; }
      const list = io.decodeRefList(rawOf(kind));
      const ref = { n: f.name, a: id, s: f.size };
      if (thumb) ref.t = thumb;
      list.push(ref);
      setList(kind, list);
      app.api.commit();
      refresh();
      app.api.status(`已附加${label}：${f.name}`);
    };

    /** 移除第 index 个（并同步删资产本体） */
    const removeAt = async (kind, index) => {
      const label = kind === 'video' ? '视频' : '文件';
      rememberNode();
      const list = io.decodeRefList(rawOf(kind));
      const r = list[index];
      if (!r) return;
      const ok = await confirmDialog(
        `移除${label}附件`,
        `确定移除「${r.n || '（未命名）'}」？\n\n附件本体将从本地库中删除，此操作不可恢复。`,
        '移除', true);
      if (!ok) return;
      if (!focusNode()) { app.api.status('请先选中一个节点再移除附件', true); return; }
      list.splice(index, 1);
      setList(kind, list);
      if (r.a) await io.dropAsset(r.a);
      app.api.commit();
      refresh();
      app.api.status(`已移除${label}：${r.n || '（未命名）'}`);
    };

    /**
     * 打开第 index 个（图片预览 / 视频播放 / 其余下载）
     *
     * 视频要带上 onSetThumb，否则浮层里**没有「设为封面」按钮** ——
     * 早先这里调 openVideo(app, asset) 不传 opt，于是只有从画布节点点开的
     * 视频才有那个按钮，从侧栏点开的没有，看着像功能丢了。
     */
    const openAt = async (kind, ref, index) => {
      if (!ref?.a) { app.api.status('该附件来自旧版路径，无法在沙箱内打开', true); return; }
      const asset = await io.getAsset(ref.a, true);
      if (!asset?.blob) { app.api.status('附件数据已丢失', true); return; }
      trackMediaUrl(asset.url);
      if (kind === 'video') {
        const i = Number(index);
        openVideo(app, asset, {
          index: i,
          // 传 nodeId：浮层开着时用户可能点了别的节点，不切回去会写错视频
          onSetThumb: (dataUrl) => {
            const id = _pendingNodeId || app.bridge?.getSelectedNodeId?.() || '';
            app.api.setVideoThumb?.(i, id, dataUrl);
          },
        });
        return;
      }
      if (isImageName(ref.n) && asset.url) openPreview(app, asset);
      else io.downloadBlob(io.safeFileName(asset.name || ref.n || '附件'), asset.blob);
    };

    const addImages = async () => {
      rememberNode();                       // 必须在**弹框之前**
      const picked = await io.pickFiles('image/*');
      if (!picked || !picked.length) return;
      // 写回前切回节点；并且**实时**重读列表 ——
      // 不能用页面构建时的 images 快照：期间选中/内容都可能变过
      if (!focusNode()) { app.api.status('请先选中一个节点再添加图片', true); return; }
      // 原上游在这里数「>2MB 的张数」再提示；现在压缩是在入口做的
      // （io.imageToInline），压不动的那张会走下面 failed 分支并给出原因，
      // 不会再有「已添加但仍超 2MB」这种事后警告，所以 big 计数去掉。
      const images = app.api.selectedImages();
      const urls = [];
      const failed = [];
      let srcBytes = 0; let outBytes = 0;
      for (const f of picked) {
        // 与拖放走**同一个**入口（io.imageToInline）：压缩 + 体积上限。
        // 两处各写一份读文件逻辑的话，改了一处忘另一处就是长期的漂移源。
        const r = await io.imageToInline(f);
        if (!r.url) { failed.push(r.error || `「${f.name}」未能添加`); continue; }
        urls.push(r.url);
        srcBytes += r.before; outBytes += r.after;
      }
      if (!urls.length) { app.api.status(failed[0] || '图片读取失败', true); return; }
      app.bridge.setImages([...images, ...urls]);
      app.api.commit();
      refresh();
      const shrink = outBytes < srcBytes
        ? `（${io.formatSize(srcBytes)} → ${io.formatSize(outBytes)}）` : '';
      const tail = failed.length ? `，${failed.length} 张未添加：${failed.join('；')}` : '';
      app.api.status(`已添加 ${urls.length} 张图片${shrink}${tail}`, failed.length > 0);
    };

    const removeImage = (index) => {
      if (!focusNode()) { app.api.status('请先选中一个节点再移除图片', true); return; }
      const list = app.api.selectedImages().slice();
      list.splice(index, 1);
      app.bridge.setImages(list);
      app.api.commit();
      refresh();
    };

    /**
     * 把节点上**已经内联**的过大图片重新压一遍。
     *
     * 逐张处理、一次写回：中途失败的那张保持原样（压不动总比丢了强），
     * 最后把"压了几张、从小到多小、哪张没成"一并说出来。
     */
    const shrinkHeavy = async () => {
      const list = images.slice();
      const idx = list
        .map((u, i) => (String(u).length > io.IMG_INLINE_MAX ? i : -1))
        .filter((i) => i >= 0);
      if (!idx.length) { app.api.status('没有超过上限的图片'); return; }
      let srcBytes = 0; let outBytes = 0;
      const failed = [];
      for (const i of idx) {
        const r = await io.shrinkDataUrl(list[i]);
        if (!r.url) { failed.push(r.error || `第 ${i + 1} 张`); continue; }
        srcBytes += String(list[i]).length;
        outBytes += r.url.length;
        list[i] = r.url;
      }
      const done = idx.length - failed.length;
      if (!done) { app.api.status(failed[0] || '压缩失败', true); return; }
      app.bridge.setImages(list);
      app.api.commit();
      refresh();
      const tail = failed.length ? `，${failed.length} 张未能压缩：${failed.join('；')}` : '';
      app.api.status(`已压缩 ${done} 张图片：${io.formatSize(srcBytes)} → ${io.formatSize(outBytes)}${tail}`,
        failed.length > 0);
    };

    /** 一行附件：名字 + 右侧小按钮（下载 / 移除） */
    // 选中态必须**看得见**：详情区在下方，不加高亮的话用户点完
    // 根本不知道自己选的是哪一行（尤其同名文件多的时候）
    const row = (kind, ref, index, label) => h(
      `div.mm-arow${index === (kind === 'file' ? curFile : curVid) ? '.on' : ''}`, {
      onclick: () => {
        if (kind === 'file') _curFile = index; else _curVid = index;
        refresh();
      },
      title: ref.n || '未命名',
    },
    h('span.mm-arow-icon', {}, kind === 'video' ? '🎬' : fileIcon(ref.n || '')),
    h('span.mm-arow-name', {}, ref.n || '未命名'),
    h('button.mm-mini', {
      onclick: (e) => { e.stopPropagation(); safe('打开', () => openAt(kind, ref, index), (m) => app.api.status(m, true))(); },
      title: '打开 / 下载',
    }, '⤓'),
    h('button.mm-mini', {
      /*
       * 必须包 safe()：removeAt 是 async，不接住 rejection 的话失败就是
       * **静默**的 —— 按钮点了没反应，状态栏也不说话（只有诊断日志里
       * 有一条 unhandledrejection）。
       *
       * 同一行的「打开」按钮早就包了 safe()，唯独这个「移除」漏了：
       * 又是"同一件事多条路径、只修了一条"。
       */
      onclick: (e) => {
        e.stopPropagation();
        safe('移除附件', () => removeAt(kind, index), (m) => app.api.status(m, true))();
      },
      title: `移除${label}`,
    }, '✕'));

    // 没选中节点时三个列表必然都是空的，和「这个节点确实没附件」
    // **长得一模一样** —— 用户会以为附件数据丢了。所以要区分开说。
    //
    // 只在**能确认**没选中时才换文案（能力检测）：
    // bridge 没提供 getSelectedNodeId 就当"不知道"，照常显示原句。
    // 否则会把「节点确实没附件」误报成「没选中节点」，反而更误导。
    const canTell = typeof app.bridge?.getSelectedNodeId === 'function';
    const selId = canTell ? (app.bridge.getSelectedNodeId() || '') : null;
    const noSel = canTell && !selId;

    const listBox = (kind, list, label) => (list.length
      ? h('div.mm-alist', {}, ...list.map((r, i) => row(kind, r, i, label)))
      : h('div.mm-hint', {}, emptyHint(label)));

    /**
     * 空列表的提示语。
     *
     * 未选中节点时提示换成「请先选节点」——但**只在文件那一栏换**，
     * 视频/图片两栏仍显示各自的空提示。三栏都换的话同一句话重复三遍，
     * 而且用户只需要在最上面看到一次引导就够了。
     */
    function emptyHint(label) {
      if (noSel && label === '文件') {
        return '当前没有选中节点。附件是挂在节点上的 —— 请先在画布上点选一个节点。';
      }
      return `当前节点没有${label}附件`;
    }

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      section(`文件附件${files.length ? `（${files.length}）` : ''}`,
        listBox('file', files, '文件'),
        fileMeta,
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: safe('附加文件', () => attach('file'), (m) => app.api.status(m, true)),
          }, '附加文件…'),
        ),
      ),
      section(`视频附件${videos.length ? `（${videos.length}）` : ''}`,
        listBox('video', videos, '视频'),
        vprev.el,
        videoMeta,
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: safe('附加视频', () => attach('video'), (m) => app.api.status(m, true)),
          }, '附加视频…'),
        ),
      ),
      section(`图片${images.length ? `（${images.length}）` : ''}`,
        images.length
          ? h('div.mm-thumbs', {}, ...images.map((u, i) => h('div.mm-thumb', {
            onclick: () => openPreview(app, { url: u, name: `图片 ${i + 1}` }, {
              // 传**整张列表**：这样预览里能左右切换、有 i/n 计数。
              // 只传单张的话，看第二张还得关掉浮层再点一次缩略图。
              list: images.map((x, k) => ({ url: x, name: `图片 ${k + 1}` })),
              index: i,
            }),
            title: '点击放大',
          },
          h('img', { src: u, alt: `图片 ${i + 1}` }),
          h('button.mm-thumb-x', {
            onclick: (e) => { e.stopPropagation(); removeImage(i); },
            title: '移除这张',
          }, '✕'))))
          : h('div.mm-hint', {}, '当前节点没有图片'),
        h('div.mm-row', {},
          h('button.mm-btn', { onclick: safe('添加图片', addImages, (m) => app.api.status(m, true)) }, '添加图片…'),
          // 只在真有超限图片时才出现 —— 平时不占位、不打扰
          heavy.length
            ? h('button.mm-btn', {
              onclick: safe('压缩图片', shrinkHeavy, (m) => app.api.status(m, true)),
              title: '这些图是过去内联进来的，重压到上限以内',
            }, `压缩过大图片（${heavy.length}）`)
            : null,
        ),
        h('div.mm-hint', {}, '单张图显示在节点框内；两张及以上自动变成可切换的横幅。'),
        heavy.length
          ? h('div.mm-hint', {}, `${heavy.length} 张图片超过内联上限（共 ${io.formatSize(heavy.reduce((s, u) => s + String(u).length, 0))}），可点「压缩过大图片」瘦身。`)
          : null,
      ),
      // 导入导出已全部移到侧栏「导入导出」页 —— 原先这里只有 3 个按钮
      // （JSON / MD / 导入），而顶栏有全套，同一件事两个入口且能力不一致，
      // 用户不知道该去哪儿找某个格式。
    );
  }

  /* ------------------------- 样式页 ------------------------- */

  function pageStyle() {
    const st = app.api.nodeStyle();
    const set = (patch) => {
      app.bridge.setNodeStyle(patch);
      app.api.commit();
      refresh();
    };
    // 文字格式走内核命令（bold/italic/…），与节点样式(setnodestyle)是两套机制
    const run = (name, value) => {
      app.bridge?.exec(name, value);
      app.api.commit();
    };

    // 「清除样式」按钮挂在**每一节的标题右边**，而不是在末尾凑成一排四个。
    // 四个同名按钮挤一排时，用户分不清哪个清的是文字、哪个清的是连线；
    // 挂标题右边后，「这个按钮管这一节」是由位置直接表达出来的。
    const clearBtn = (label, scopes) => quietBtn(label, () => {
      for (const sc of scopes) app.bridge?.clearNodeStyle(sc);
      app.api.commit();
      refresh();
    });

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      // 文字段：C# 版 SidePageStyle 的第一段。原本插件只把它放在顶部工具栏，
      // 工具栏控件太多挤不下，且无法回显当前节点的格式状态（无状态按钮）。
      // 这里补齐，并按 collectNodeStyle 上报的字段回显/高亮当前值。
      sectionAct('文字', clearBtn('清除文字样式', ['text']),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '字体'),
          h('select.mm-select', {
            style: { flex: '1 1 auto' },
            onchange: (e) => run('fontfamily', e.target.value),
          }, ...FONTS.map((f) =>
            h('option', { value: f, selected: st.fontFamily === f }, f))),
        ),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '字号'),
          // 数值一律走 numSpinner：滚轮 ±1 微调、▲▼ 步进、▾ 选预设档位。
          // 原来是下拉框，改一次要两步（点开 → 找值），而且没法微调。
          numSpinner({
            value: st.fontSize, min: MIN_FS, max: MAX_FS,
            list: SIZES, title: '字号（滚轮 / ▲▼ 微调，▾ 选预设）',
            onChange: (v) => run('fontsize', v),
          }),
        ),
        // 颜色与 B/I/S **同一行**：它们都是「文字外观」的开关，
        // 拆成两行会让人以为是两组不相干的设置
        colorRow('字体色', st.color,
          (v) => run('forecolor', v),
          () => { app.bridge?.clearNodeStyle('text'); app.api.commit(); refresh(); },
          [
            // 与前面的色块**留一段空隙**：颜色（取色）与 B/I/S（字形开关）
            // 是两套东西，紧贴着会看成一组控件。空隙放在这一组的第一个上，
            // 而不是给每个 chip 都加 —— 那是"间距"不是"分隔"。
            h('button.mm-chip' + (st.bold ? '.on' : ''), {
              style: { fontWeight: '700', marginLeft: '14px' },
              onclick: () => run('bold'),
              title: '加粗',
            }, 'B'),
            h('button.mm-chip' + (st.italic ? '.on' : ''), {
              style: { fontStyle: 'italic' },
              onclick: () => run('italic'),
              title: '斜体',
            }, 'I'),
            h('button.mm-chip' + (st.strikethrough ? '.on' : ''), {
              style: { textDecoration: 'line-through' },
              onclick: () => run('strikethrough'),
              title: '删除线',
            }, 'S'),
          ]),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '水平'),
          ...[['left', '左'], ['center', '中'], ['right', '右']].map(([v, t]) =>
            h('button.mm-chip' + (st.textAlign === v ? '.on' : ''), {
              onclick: () => run('textalign', v),
              title: `水平${t}对齐`,
            }, t)),
        ),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '垂直'),
          ...[['top', '上'], ['middle', '中'], ['bottom', '下']].map(([v, t]) =>
            h('button.mm-chip' + (st.verticalAlign === v ? '.on' : ''), {
              onclick: () => run('valign', v),
              title: `文字垂直${t}对齐`,
            }, t)),
        ),
      ),
      // 「节点填充」与「节点边框」合并为一节：圆角归入本节后，
      // 四组控件（填充 / 描边 / 线宽 / 圆角）本来就是「节点长什么样」的
      // 同一个维度。分成两节反而让「圆角」看起来像独立功能。
      // 清除要同时清 node（填充+圆角）与 border（描边色+线宽）两个 scope ——
      // 内核里它们是两个命令，只清一个会留下半截样式。
      sectionAct('节点', clearBtn('清除节点样式', ['node', 'border']),
        colorRow('填充', st.fill, (v) => set({ fill: v }), () => set({ fill: null })),
        colorRow('描边', st.stroke, (v) => set({ stroke: v }), () => set({ stroke: null })),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '线宽'),
          numSpinner({
            value: st.strokeWidth, min: 1, max: 12,
            list: WIDTHS, title: '节点描边线宽（滚轮 / ▲▼ 微调，▾ 选预设）',
            onChange: (w) => set({ strokeWidth: w }),
          }),
        ),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '圆角'),
          numSpinner({
            // 上限 MAX_RADIUS(20)：见 RADII 的说明 —— 圆角超过节点较短边的
            // 一半会被 kity 静默钳住，给再大的范围也只是"拖了没反应"
            value: st.radius, min: 0, max: MAX_RADIUS,
            list: RADII, title: '节点圆角（滚轮 / ▲▼ 微调，▾ 选预设）',
            onChange: (r) => set({ radius: r }),
          }),
        ),
      ),
      sectionAct('连线', clearBtn('清除连线样式', ['line']),
        colorRow('连线', st.lineColor, (v) => set({ lineColor: v }), () => set({ lineColor: null })),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '线宽'),
          numSpinner({
            value: st.lineWidth, min: 1, max: 12,
            list: WIDTHS, title: '连线线宽（滚轮 / ▲▼ 微调，▾ 选预设）',
            onChange: (w) => set({ lineWidth: w }),
          }),
        ),
      ),
      // 外观：C# 样式页「外观」段（整理布局 + 清除/复制/粘贴样式）
      section('外观',
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: () => { app.bridge?.exec('resetlayout'); app.api.commit(); app.api.status('布局已整理'); },
            title: '重新排列节点布局（resetlayout）',
          }, '整理布局'),
        ),
      ),
      section('样式刷',
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: () => { app.bridge.copyNodeStyle(); app.api.status('已复制节点样式'); },
            title: '复制选中节点的全部节点级样式到内存剪贴板',
          }, '复制样式'),
          h('button.mm-btn', {
            onclick: () => { app.bridge.pasteNodeStyle(); app.api.commit(); app.api.status('已粘贴节点样式'); },
            title: '把剪贴板里的样式贴到当前选中节点',
          }, '粘贴样式'),
          // 「清除全部」放在样式刷里：两者都是**整体**操作（作用于全部样式），
          // 而各节标题右边的按钮是**分节**操作。混在一起会让人以为是同一粒度。
          h('button.mm-btn', {
            onclick: () => {
              for (const sc of ['text', 'node', 'border', 'line']) app.bridge?.clearNodeStyle(sc);
              app.api.commit();
              refresh();
              app.api.status('已清除全部样式');
            },
            title: '清除文字 / 节点 / 边框 / 连线的全部自定义样式',
          }, '清除全部'),
        ),
        h('div.mm-hint', {}, '快捷键 Ctrl+Shift+C / Ctrl+Shift+V（编辑器内置）。剪贴板仅本次会话有效。'),
      ),
    );
  }

  /* ------------------------- 标签页 ------------------------- */

  /**
   * A1/A2 优先级 / 进度徽章行。
   * 对齐 WPF `BuildSpriteNumRow` 的两行布局（1–5 / 6–9 + 清除格）。
   */
  function badgeRow(kind, current, onPick) {
    return h('div.mm-badges', {},
      ...tb.BADGE_ROWS.map((row) =>
        h('div.mm-badge-row', {},
          ...row.map((v) => {
            const on = String(current) === String(v) && !!v;
            return h('button.mm-badge' + (on ? '.on' : ''), {
              onclick: () => onPick(v),
              title: tb.badgeTitle(kind, v),
              'data-v': String(v),
            },
              h('span.mm-badge-face', {
                style: {
                  background: tb.badgeBg(kind, v),
                  color: tb.badgeTextColor(kind, v),
                  width: tb.BADGE_SIZE + 'px',
                  height: tb.BADGE_SIZE + 'px',
                },
              }, tb.badgeLabel(v)),
            );
          }))),
    );
  }

  function pageTag() {
    const pickImage = async () => {
      const f = await io.pickFile('image/*');
      if (!f) return;
      // 与拖放 / 侧栏共用压缩入口。注意这里写的是**老字段 image**（单个槽位），
      // 不走 images 数组 —— bridge.setImage 内部会处理两者的互斥。
      const r = await io.imageToInline(f);
      if (!r.url) { app.api.status(r.error || '图片读取失败', true); return; }
      app.bridge.setImage(r.url);
      app.api.commit();
      // 压过就说一句：否则中间那几百毫秒用户不知道发生了什么，
      // 事后发现图变小了会怀疑是分辨率被偷走了
      if (r.scaled) {
        app.api.status(`图片已压缩至 ${r.w}×${r.h}（${io.formatSize(r.before)} → ${io.formatSize(r.after)}）`);
      }
    };

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      section('优先级',
        // A1/A13：徽章行（1–5 / 6–9 + 清除格）。清除格走 priority 0，
        // 与 WPF 的 cell9 一致 —— 它和其他格同排，不再是另起一个按钮。
        badgeRow('priority', app.bridge.getSelectedPriority?.() ?? null,
          (v) => { app.bridge.exec('priority', v); app.api.commit(); refresh(); }),
      ),
      section('进度',
        // A2/A14：同理，清除格是 progress 0。
        badgeRow('progress', app.bridge.getSelectedProgress?.() ?? null,
          (v) => { app.bridge.exec('progress', v); app.api.commit(); refresh(); }),
      ),
      // 三个按钮**同一行**：「选图标」「选图片」「清除」是同一件事的三个动作，
      // 拆成两行后「清除图标」孤零零占一行，看着像另一个独立功能
      section('图标',
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: safe('打开图标库', () => openIconLibrary(app), (m) => app.api.status(m, true)),
            title: '从预设图标库点选（A3–A10）',
          }, '图标库…'),
          h('button.mm-btn', { onclick: pickImage }, '浏览图片…'),
          quietBtn('清除节点上的图标 / 图片', () => { app.bridge.setImage(null); app.api.commit(); }),
        ),
        h('div.mm-hint', {}, '图标与图片都以 dataURL 内联进脑图，随文件一起导出；建议控制在 2MB 内。'),
      ),
      section('超链接',
        h('input.mm-input', {
          placeholder: 'https://…（清空后回车移除）',
          onchange: (e) => {
            const v = e.target.value.trim();
            app.bridge.setHyperlink(v || null);
            app.api.commit();
          },
        }),
      ),
      section('备注',
        h('input.mm-input', {
          placeholder: '节点备注（清空后回车移除）',
          onchange: (e) => {
            const v = e.target.value.trim();
            app.bridge.setNote(v || null);
            app.api.commit();
          },
        }),
      ),
    );
  }

  /* ------------------------- 主题导入 / 导出 ------------------------- */

  /**
   * 导出当前画布使用的自定义主题为 JSON（对齐 C# OnExportThemeClick）。
   * C# 是「导出选中的主题」，插件的主题列表没有独立的选中态（点即应用），
   * 故改为导出当前画布正在用的那个 —— 更符合直觉，也省去一次选择。
   */
  async function exportThemeFile() {
    const id = app.sheet?.theme;
    const t = (app.customThemes || []).find((x) => x.id === id);
    if (!t) {
      app.api.status('当前画布用的是内置主题，无法导出（请先新建或选中自定义主题）', true);
      return;
    }
    const r = await io.saveText(
      `主题-${io.safeFileName(t.name || '未命名')}.json`,
      JSON.stringify(t, null, 2),
      'application/json',
    );
    // 与其余 7 处导出保持一致的提示口径（ok / cancel / fallback / error 四种）
    if (r !== 'cancel') {
      app.api.status(r === 'error' ? '导出主题失败' : `已导出主题：${t.name || '未命名'}`);
    }
  }

  /** 从 JSON 文件导入自定义主题（对齐 C# OnImportThemeClick，重新生成 id 避免覆盖） */
  async function importThemeFile() {
    const f = await io.pickFile('.json,application/json');
    if (!f) return;
    let t;
    try {
      t = JSON.parse(await io.readText(f));
    } catch {
      app.api.status('导入主题失败：不是合法的 JSON', true);
      return;
    }
    const pal = t?.palette || t;
    if (!t?.name || !pal || typeof pal !== 'object') {
      app.api.status('导入主题失败：文件格式不符（缺少 name / palette）', true);
      return;
    }
    // A65 边界：导入的 palette 可能含非法值（'transparent'、任意字符串、
    // 0 或负数）。这些**都不会报错**，只会让主题静默失效 ——
    // 画布停在一片错色上，用户根本不知道是导入的锅。
    // A64（新建主题）早就做了这层回落，导入路径此前**完全没有**，
    // 属于同一个坑在两条路上的不对称。
    const { palette, fixed } = sanitizePalette(pal);
    const name = uniqueThemeName(t.name, app.customThemes);
    const copy = {
      id: 'custom-' + Math.random().toString(36).slice(2, 10),
      name,
      palette,
    };
    app.customThemes = [...(app.customThemes || []), copy];
    const okSave = await app.api.saveThemes();
    if (!okSave) { app.api.status('导入失败（未写入本地库）', true); return; }
    app.bridge.registerTheme(copy);
    app.api.applyTheme(copy.id);
    refresh();
    // 修正过的字段必须说出来 —— 静默改掉用户文件里的值不合适
    app.api.status(fixed.length
      ? `已导入「${name}」；已修正 ${fixed.length} 个无效值：${fixed.join('、')}`
      : `已导入自定义主题：${name}`);
  }

  /* ------------------------- 主题页 ------------------------- */

  function pageTheme() {
    const cur = app.sheet?.theme || 'fresh-blue';
    // 当前主题的显示名（新建种子提示用）：自定义主题有 name，内置主题查 THEMES
    const curName = (app.customThemes || []).find((x) => x.id === cur)?.name
      || THEMES.find((x) => x.value === cur)?.label
      || cur;
    const curLayout = app.sheet?.layout || 'default';

    const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      ...THEMES.map((t) =>
        h('button.mm-theme' + (cur === t.value ? '.on' : ''), {
          onclick: () => { app.api.applyTheme(t.value); refresh(); },
        },
          swatchBar(themeSwatch(t)),
          h('span.name', {}, t.label),
        )),
      ...(app.customThemes || []).map((t) =>
        h('div.mm-theme' + (cur === t.id ? '.on' : ''), {},
          h('span', {
            style: { display: 'flex', cursor: 'pointer' },
            onclick: () => { app.api.applyTheme(t.id); refresh(); },
          }, swatchBar(customSwatch(t))),
          h('span.name', {
            onclick: () => { app.api.applyTheme(t.id); refresh(); },
            title: t.id?.startsWith?.('mm-preset-')
              ? '预置主题：可编辑、可删除，删后不再出现'
              : '自定义主题',
          }, t.name || t.id),
          h('button.mm-btn.icon', { onclick: () => { openThemeEditor(app, t); }, title: '编辑' }, '✎'),
          h('button.mm-btn.icon', {
            // A62 删除回退（对照 WPF OnDeleteThemeClick，MindMapPanel.xaml.cs:2825）
            onclick: safe('删除主题', async () => {
              // 关键：删的若是**正在使用**的主题，必须先切回内置并落盘，
              // 否则 sheet.theme 会指向一个已注销的 id —— 重载后主题注册失败，
              // 画布停在错误配色上，且用户没有任何提示。
              //
              // 与 C# 版的刻意差异：WPF 是**无条件**切回 fresh-blue，
              // 即删一个压根没在用的主题，也会把当前主题重置掉。
              // 这里改成「只有删的是当前主题才回退」——删别的主题不该打扰用户。
              const isCurrent = cur === t.id;
              if (isCurrent) await app.api.applyTheme(DEFAULT_THEME);
              app.customThemes = (app.customThemes || []).filter((x) => x.id !== t.id);
              await app.api.markPresetRemoved(t.id);
              const ok = await app.api.saveThemes();
              if (!ok) {
                app.api.status('删除失败（未写入本地库）', true);
                if (isCurrent) await app.api.applyTheme(t.id);   // 回滚，别把用户卡在中间态
                return;
              }
              refresh();
              app.api.status(isCurrent
                ? `已删除「${t.name}」并回退到内置主题`
                : `已删除「${t.name}」`);
            }, (m) => app.api.status(m, true)),
            title: '删除',
          }, '✕'),
        )),
    );

    // 当前是不是内置主题 —— 内置主题无法导出（没有可序列化的自定义定义）。
    // 这条信息原本靠节尾那句 hint 传达；按钮移到本页后改为**直接禁用**导出按钮：
    // 让按钮可点、点了再报错，等于把"做不了"这件事推迟到用户已经付出操作之后。
    const isBuiltin = THEMES.some((t) => t.value === cur);

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      // 导入 / 导出与「新建 / 编辑 / 删除」同排：它们都是**对主题这个对象**的操作，
      // 放在一处才看得出「主题能做的全在这里」。原先收进侧栏「导入导出」页后，
      // 主题页要靠一句 hint 指路，等于把一组连贯操作拆成了两地。
      sectionTip('配色主题',
        ['导入 / 导出仅针对**自定义**主题；内置主题无法导出。',
          '导入会重新生成 id，不会覆盖同名主题。'],
        list,
        // 三个按钮**各占一行**：主题页的按钮文字不短（「导入主题」四个字），
        // 挤在一排时每个都被压到要截断（曾显示成「导入…」），
        // 用户得悬停才知道是干什么的。竖排是这里的唯一选择 ——
        // 侧栏只有 252px 可用，而「新建 / 导入主题 / 导出主题」没有更短的写法。
        h('div.mm-col', {},
          // A64：把当前主题传进去当种子（原版 OnNewThemeClick 同款行为）
          h('button.mm-btn', {
            onclick: () => openThemeEditor(app, null, cur),
            title: `以当前主题「${curName}」为起点新建`,
          }, '＋ 新建主题'),
          // 命名必须**成对**：「导入主题」对「导出主题」。
          // 早先一个是「导入…」、另一个是「导出」，看着像两个不相干的功能，
          // 而且省略号是因为按钮太窄被截断的，不是有意省略。
          h('button.mm-btn', {
            onclick: safe('导入主题', () => importThemeFile(), (m) => app.api.status(m, true)),
            title: '从 JSON 文件导入自定义主题（重新生成 id，不会覆盖同名）',
          }, '导入主题'),
          h('button.mm-btn', {
            onclick: safe('导出主题', () => exportThemeFile(), (m) => app.api.status(m, true)),
            disabled: isBuiltin,
            title: isBuiltin
              ? '当前是内置主题，无法导出（请先新建或选中自定义主题）'
              : '把当前画布正在用的自定义主题导出为 JSON',
          }, '导出主题'),
        ),
      ),
      section('布局模板',
        // 两列缩略图网格 + 名称，对齐 WPF 原版（UniformGrid Columns="2" + 100×58 缩略图）
        h('div.mm-layouts', {},
          ...LAYOUTS.map((l) =>
            h('button.mm-layout' + (curLayout === l.value ? '.on' : ''), {
              onclick: () => { app.api.applyLayout(l.value); refresh(); },
              title: l.label,
            },
              h('span.mm-layout-thumb', {},
                // 缺图时退化成占位符而不是空白 —— 空白在深色面板上等同于「没这项」
                LAYOUT_THUMBS[l.value]
                  ? h('img', { src: LAYOUT_THUMBS[l.value], alt: l.label, width: '100', height: '40' })
                  : h('span.mm-layout-nothumb', {}, '⁇')),
              h('span.mm-layout-name', {}, l.label))),
        ),
      ),
      // 注：这里原先有个「整理布局」用 exec('arrange') —— 那是内核拖拽排序模块的内部命令
      // （需要 index 参数），单独执行无效。真正的整理布局是 resetlayout，已在本页「外观」段。
      //
      // 「展开层级」已移到左侧图标条：它是**看整幅图**的操作，跟
      // 「样式（针对选中节点）」不是一类事，放这儿每次用都要先切页再往下翻。
      // 整节删掉，不留空节也不留第二处入口。
    );
  }

  // 默认停在「主题」页，与 C# 构造函数里的 ShowSidePage("theme") 一致
  open('theme');
  // close 保留为空实现：侧栏常驻后没有收起语义，但外部（含历史调用点）可能还在调
  return { el, open, close: () => {}, refresh, isOpen: () => true, current: () => current };
}

/* =========================== 浮层 =========================== */

/**
 * 通用浮层。
 * @param onClose 关闭时的清理钩子：点遮罩、点关闭按钮、外部调 close() 都会触发，
 *   用于释放 Blob URL 之类的一次性资源。
 */
function dialog(title, children, onClose, opt) {
  const mask = h('div.mm-mask', {});
  // wide：媒体查看（图片预览 / 视频播放）用。普通 dialog 固定 560px 宽，
  // 会把大图压到要左右拖动才看得全。
  const dlgCls = 'div.mm-dialog' + (opt && opt.wide ? '.wide' : '');
  let cleaned = false;
  const close = () => {
    if (cleaned) return;
    cleaned = true;
    mask.remove();
    refocusCanvasAfterPopup();
    try { onClose?.(); } catch { /* 清理失败不该拦住关闭 */ }
  };
  mask.appendChild(
    h(dlgCls, {},
      h('h3', {}, title),
      ...children,
      h('div.mm-actions', {}, h('button.mm-btn', { onclick: close }, '关闭')),
    ),
  );
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.body.appendChild(mask);
  return { mask, close };
}

/**
 * 确认对话框（Promise 版）。
 *
 * 之前这类确认用的是 `window.confirm`：它长相由浏览器决定、在深色面板上
 * 是个突兀的白框，而且**无法测试**（jsdom 里没有实现，直接返回 undefined）。
 *
 * 返回 Promise 而不是收回调：调用点是 async 流程（先 await 确认、再打开文件
 * 选择框），用回调会把后续逻辑缩进一层。
 *
 * @returns {Promise<boolean>} true = 确认
 */
export function confirmDialog(title, message, okText = '确定', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; dlg.close(); resolve(v); } };
    const dlg = dialog(title, [
      h('div.mm-hint', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.6' } }, message),
      h('div.mm-actions', {},
        h('button.mm-btn' + (danger ? '.danger' : ''), { onclick: () => finish(true) }, okText),
        h('button.mm-btn', { onclick: () => finish(false) }, '取消'),
      ),
    ], () => finish(false));
    dlg.mask.addEventListener('click', (e) => { if (e.target === dlg.mask) finish(false); });
  });
}

/**
 * A39 轻量弹出菜单（导出格式等）。
 *
 * 用独立的 mask + 定位面板，而不是给每个按钮都配一个 `<dialog>`：
 * 菜单的生命周期是「点开 → 选一项 → 立刻关」，与对话框的「填完再提交」
 * 不同，套用 dialog() 会多出一层无意义的「关闭」按钮。
 *
 * @param {HTMLElement} anchorEl 定位锚点（菜单贴在它下方）
 * @param {Array<{label:string,onSelect:Function,hint?:string}|'-'>} items '-' 为分隔线
 */
/*
 * 当前开着的菜单（模块级单例）。
 *
 * 为什么要记：onDoc 里刻意放过了「点在锚点上」（`e.target !== anchorEl`），
 * 否则 pointerdown 先关、紧接着的 click 又开，菜单永远打不开。
 * 但这一放过就留了个洞 —— 再点一次同一个锚点时 onDoc 不关，
 * 而 click 照样又开一个：
 *
 *   实测（jsdom 复刻真实调用序列 pointerdown → click）：
 *   连点 ▾ 三次，DOM 里 .mm-menu-mask 数是 1 → 2 → 3。
 *
 * 三个 mask 位置完全相同，看着只有一个，但：
 *   · 选中某项只关掉**最上面**那个，下面两层还挂着 → 选完菜单不关；
 *   · 每个 mask 各带一个 document 监听，层层叠加。
 *
 * 修法：同一个锚点再点一次 = 收起（与原生下拉的 toggle 行为一致）。
 */
let openMenu = null;

export function popupMenu(anchorEl, items) {
  // 同一个锚点再点一次 → 收起并**不再开新的**
  if (openMenu && openMenu.anchor === anchorEl) {
    const prev = openMenu;
    openMenu = null;
    prev.close();
    return { close: () => {} };
  }
  const close = () => {
    mask.remove();
    // 同理 dialog：菜单项按钮被 remove 后 activeElement 退回 <body>，
    // 画布收不到键。选完预设立刻把焦点还回去。
    refocusCanvasAfterPopup();
    document.removeEventListener('pointerdown', onDoc, true);
    if (openMenu && openMenu.close === close) openMenu = null;
  };
  const onDoc = (e) => { if (!mask.contains(e.target) && e.target !== anchorEl) close(); };

  const panel = h('div.mm-menu', {},
    ...items.map((it) => (it === '-'
      ? h('div.mm-menu-sep', {})
      : h('button.mm-menu-item', {
        title: it.hint || '',
        onclick: () => { close(); try { it.onSelect?.(); } catch { /* 单项失败不该卡住菜单 */ } },
      }, it.label))));

  const mask = h('div.mm-menu-mask', {}, panel);
  document.body.appendChild(mask);

  // 贴着锚点右下角排；越界就往回收，否则贴右边缘的按钮会把菜单顶出屏幕外
  const r = anchorEl?.getBoundingClientRect?.();
  if (r) {
    const w = 168;
    const left = Math.min(r.left, Math.max(4, window.innerWidth - w - 4));
    const top = Math.min(r.bottom + 2, Math.max(4, window.innerHeight - 8 - items.length * 28));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  // 捕获阶段：否则点到画布会先被画布的 mousedown 处理掉，菜单关不掉
  document.addEventListener('pointerdown', onDoc, true);
  // 开新的之前先收掉上一个（锚点不同的情况），否则同样是叠层
  if (openMenu) { const p0 = openMenu; openMenu = null; p0.close(); }
  openMenu = { anchor: anchorEl, close };
  return { close };
}

/**
 * A35 / A41 打印设置框。
 *
 * 放在 panels.js 是因为 `dialog()` 在这里 —— index.js 拿不到它。
 *
 * 为什么要单独一框：方向与页边距在浏览器的打印对话框里也能调，但**藏得深**，
 * 而且用户往往是按下打印、看到预览才发现方向不对，白走一轮。
 * 这里先给一次明确选择，成本极低。
 *
 * @param {object} app
 * @param {Function} onPrint 收到 { landscape, margin } 后由调用方执行打印
 */
export function openPrintSettings(app, onPrint) {
  let landscape = true;      // 脑图通常更宽，横向更少浪费纸张
  let margin = 10;

  const dirBtn = h('button.mm-btn' + (landscape ? '.on' : ''), {
    onclick: () => {
      landscape = !landscape;
      dirBtn.classList.toggle('on', landscape);
      dirBtn.textContent = landscape ? '横向' : '纵向';
    },
    title: '脑图通常更宽，横向更少浪费纸张',
  }, landscape ? '横向' : '纵向');

  const marginSel = h('select.mm-select', {
    onchange: (e) => { margin = Number(e.target.value); },
    title: '页边距，毫米',
  }, ...[0, 5, 10, 15, 20].map((m) =>
    h('option', { value: m, selected: m === margin }, m === 0 ? '无边距' : `${m} mm`)));

  const dlg = dialog('打印 / 存为 PDF', [
    h('div.mm-row', {}, h('span.mm-label', {}, '纸张方向'), dirBtn),
    h('div.mm-row', {}, h('span.mm-label', {}, '页边距'), marginSel),
    h('div.mm-hint', {},
      '将打开系统打印对话框；在其中选「另存为 PDF」即可导出 PDF。', '\n',
      '打印的是**完整画布**，不是当前可见的那一块。'),
    h('div.mm-actions', {},
      h('button.mm-btn', {
        onclick: () => { dlg.close(); try { onPrint?.({ landscape, margin }); } catch { /* 交给调用方处理提示 */ } },
      }, '打印…'),
      h('button.mm-btn', { onclick: () => dlg.close() }, '取消'),
    ),
  ]);
  return dlg;
}

/**
 * A71 诊断窗口。
 *
 * 错误信息用**只读 textarea** 而不是 <pre>：用户要能选中、能整段复制去报问题。
 * <pre> 在窄侧栏里换行混乱，复制出来也常带上缩进。
 *
 * @param {object} o
 * @param {Array} o.entries 诊断条目
 * @param {Function} o.onClear 清空回调
 */
export function openDiagnostics(o = {}) {
  const entries = o.entries || [];
  const text = diag.formatReport(entries);

  const ta = h('textarea.mm-diag', {
    readonly: true,
    rows: 14,
    spellcheck: 'false',
    style: { width: '100%', resize: 'vertical' },
  }, text);

  const countEl = h('div.mm-hint', {}, `共 ${entries.length} 条`);

  return dialog('诊断记录', [
    h('div.mm-hint', {},
      '记录画布（iframe 内）与外壳的错误与警告。',
      '\n',
      'kityminder 跑在嵌套 iframe 里，那边的报错不会出现在外壳控制台 —— 没有这里就查不到线索。'),
    countEl,
    ta,
    h('div.mm-actions', {},
      h('button.mm-btn', {
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(ta.value);
            countEl.textContent = '已复制到剪贴板';
          } catch {
            // 剪贴板不可用时退化为全选：至少用户能手动 Ctrl+C
            ta.focus();
            ta.select();
            countEl.textContent = '无法自动复制，已全选，请按 Ctrl+C';
          }
        },
      }, '复制'),
      h('button.mm-btn', {
        onclick: () => { o.onClear?.(); ta.value = ''; countEl.textContent = '已清空'; },
      }, '清空'),
    ),
  ]);
}

/** 自定义主题编辑器 */
export function openThemeEditor(app, theme, seedTheme) {
  // A64：新建（theme 为空）时以 seedTheme 为种子，而不是永远空白。
  //   · 自定义主题 → 克隆它的 palette
  //   · 内置主题   → 用它的四色（bg/root/main/sub）映射成 palette
  // 编辑时 theme 非空，走原路径（深拷贝自身，保留 id 以覆盖更新）。
  const editing = theme
    ? JSON.parse(JSON.stringify(theme))
    : {
      id: 'th' + Math.random().toString(36).slice(2, 10),
      name: '自定义主题',
      palette: themeSeed(seedTheme, app.customThemes),
    };
  const p = editing.palette || (editing.palette = {});

  const rows = [
    ['背景', 'background'], ['文字色', 'textColor'], ['选中色', 'selectedColor'],
    ['连线色', 'connectColor'], ['根节点底色', 'rootBackground'],
    ['主干底色', 'mainBackground'], ['分支底色', 'subBackground'],
  ];

  const nameInput = h('input.mm-input', { value: editing.name || '', placeholder: '主题名称' });

  const save = async () => {
    editing.name = nameInput.value.trim() || '自定义主题';
    const ok = app.bridge.registerTheme(editing);
    if (!ok) { app.api.status('主题注册失败（编辑器未就绪？）', true); return; }
    const list = (app.customThemes || []).filter((x) => x.id !== editing.id);
    list.push(editing);
    app.customThemes = list;
    // saveThemes 失败是「返回 false」而非抛异常，不判断就会提示成功实则没存上
    const saved = await app.api.saveThemes();
    if (!saved) { app.api.status('主题保存失败（未写入本地库）', true); return; }
    app.api.applyTheme(editing.id);
    // **必须重刷侧栏**：主题列表是在 pageTheme() 里按 app.customThemes
    // 现算的，不刷的话新建的主题不会出现在列表里，得切走页签再切回来才看得到
    // —— 用户会以为没保存成功，其实已经落盘了。编辑改名同理（列表还显示旧名）。
    app.api.refreshSide?.();
    dlg.close();
    app.api.toast('主题已保存并应用', 'ok');
  };

  const dlg = dialog(theme ? '编辑主题' : '新建主题', [
    h('div.mm-field', {}, h('span.mm-label', {}, '名称'), nameInput),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      ...rows.map(([label, key]) => {
        let input;
        const sw = h('button.mm-swatch', {
          style: { background: p[key] || '#4A90D9', position: 'relative' },
          onclick: () => input.click(),
        });
        input = h('input', {
          type: 'color',
          value: p[key] || '#4A90D9',
          style: { position: 'absolute', inset: '0', opacity: '0', width: '100%', height: '100%', cursor: 'pointer' },
          oninput: (e) => {
            p[key] = e.target.value;
            sw.style.background = e.target.value;
          },
        });
        sw.appendChild(input);
        return h('div.mm-row', {}, h('span.mm-label', { style: { minWidth: '88px' } }, label), sw,
          h('span.mm-hint', {}, p[key] || ''));
      }),
    ),
    h('div.mm-actions', {}, h('button.mm-btn.primary', {
      onclick: safe('保存主题', save, (m) => app.api.status(m, true)),
    }, '保存并应用')),
  ]
  );
  return dlg;
}

/**
 * 视频播放浮层：直接用原生 <video controls>，进度条/音量/全屏由浏览器提供。
 * 关闭时释放 Blob URL —— getAsset() 每次调用都会新建一个，不释放就是内存泄漏
 * （反复点开附件会一直堆积）。
 */
/**
 * 视频播放浮层。
 *
 * 两个新增按钮：
 * - **截图**：把当前画面存成图片（下载）
 * - **设为封面**：把当前画面写回该视频的引用（ref.t），节点卡片上立刻换成这张
 *
 * 「设为封面」只在有节点上下文时出现（opt.onSetThumb）——
 * 没有上下文还显示的话，点了就是静默无反应，比不显示更让人困惑。
 *
 * 自动播放的坑：浏览器会阻止**有声**自动播放。点画布上的视频是一次用户手势，
 * 但 postMessage 是异步的，浮层建好时手势可能已过期 —— 表现为「点开了但不动」。
 * 所以先试有声播放，被拒就转静音（能看，用户再手动点取消静音）。
 */
export function openVideo(app, asset, opt = {}) {
  const v = h('video.mm-video', { src: asset.url, controls: true, autoplay: true, playsinline: true });
  const hint = h('div.mm-hint', {});
  const release = () => { if (asset.url) URL.revokeObjectURL(asset.url); };

  /** 抓当前画面。视频还没加载出画面时返回 null（不是空串 —— 空串画出来是全黑） */
  function grab() {
    try {
      const w = v.videoWidth;
      const hh = v.videoHeight;
      if (!w || !hh) return null;
      const c = document.createElement('canvas');
      c.width = w; c.height = hh;
      c.getContext('2d').drawImage(v, 0, 0, w, hh);
      // jpeg：缩略图与截图都不需要无损，体积差好几倍
      return c.toDataURL('image/jpeg', 0.72);
    } catch {
      return null;
    }
  }

  function withFrame(fn, okMsg) {
    const d = grab();
    if (!d) { app.api?.status?.('还没读到画面，等视频播起来再试', true); return; }
    fn(d);
    if (okMsg) app.api?.status?.(okMsg);
  }

  const shot = h('button.mm-btn', {
    onclick: () => withFrame((d) => {
      const base = String(asset.name || '视频').replace(/\.[^.]+$/, '');
      // 扩展名必须跟**实际字节**一致：抓出来的是 JPEG，存成 .png 的话
      // 有些看图软件会直接拒绝打开（"文件已损坏"），而内容其实没问题。
      io.downloadBlob(io.safeFileName(`${base}-截图.jpg`), io.dataUrlToBlob(d));
    }, '已保存截图'),
  }, '截图');

  const setThumb = h('button.mm-btn', {
    onclick: () => withFrame((d) => { opt.onSetThumb?.(d); }, '已设为该视频的封面'),
    title: '把当前画面设为节点卡片上显示的封面',
  }, '设为封面');

  const actions = h('div.mm-actions', {},
    shot,
    // 没有节点上下文时不给这个按钮（点了没反应更让人困惑）
    ...(opt.onSetThumb ? [setThumb] : []));

  // 有声自动播放被拒 → 转静音。不处理的话用户看到的就是一动不动的首帧
  const tryPlay = () => {
    try {
      const p = v.play?.();
      if (!p || typeof p.catch !== 'function') return;
      p.catch(() => {
        v.muted = true;
        const p2 = v.play?.();
        if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
        hint.textContent = '浏览器阻止了有声自动播放，已静音播放（可点右下角取消静音）';
      });
    } catch { /* 不支持 play() 就交给 autoplay 属性 */ }
  };
  // 要等元素进 DOM 且元数据就绪；过早调 play 会被当成无手势
  v.addEventListener?.('loadedmetadata', tryPlay, { once: true });
  setTimeout(tryPlay, 0);

  // wide：竖屏视频按 560px 铺开会很高，宽版能让它更舒展；
  // 更关键的是 video 已限高，按钮不会被挤出可视区。
  return dialog(`播放：${asset.name || '视频'}`, [v, hint, actions], release, { wide: true });
}

/** 图片附件预览浮层（点节点图标时，图片比直接下载更直观） */
/**
 * 图片预览。
 *
 * 支持**多张切换**：传 `opts.list` 就有左右按钮和「i/n」计数，
 * 同时支持 ← → 快捷键。单张时不显示这些（没必要占地方）。
 *
 * 为什么快捷键要能关掉：预览是模态浮层，但键盘监听挂在 document 上 ——
 * 关掉浮层时必须解绑，否则残留的监听会拦住后续画布上的 ← →
 * （那两个键在 kityminder 里是有用的）。
 *
 * @param {object} opts.list 可选，`[{ url, name, blob }]`
 * @param {number} opts.index 可选，起始下标
 */
export function openPreview(app, asset, opts) {
  const WHEEL_STEP = 40;    // 累积到这个位移才切一张（触控板一划会发几十个事件）
  const WHEEL_GAP = 90;     // 两次切换的最小间隔（ms），挡住惯性滚动
  const items = (opts && opts.list && opts.list.length)
    ? opts.list
    : [{ url: asset.url, name: asset.name, blob: asset.blob }];
  let idx = Number(opts && opts.index) || 0;
  if (!(idx >= 0 && idx < items.length)) idx = 0;

  const img = h('img.mm-preview', { src: items[idx].url, alt: items[idx].name || '图片' });
  const counter = h('span.mm-preview-count', {});
  const many = items.length > 1;

  /** 当前项的 blob：dataURL 没有 blob，现转（「另存为」要的是字节） */
  const blobOf = (it) => {
    if (it.blob) return it.blob;
    try { return io.dataUrlToBlob(String(it.url || '')); } catch { return null; }
  };
  const save = h('button.mm-btn', {
    onclick: () => {
      const b = blobOf(items[idx]);
      if (!b) { app.api.status('另存为失败：拿不到图片数据', true); return; }
      io.downloadBlob(io.safeFileName(items[idx].name || '图片'), b);
    },
  }, '另存为');

  const setIdx = (n) => {
    // 循环：到第 1 张再往左跳到最后一张，反之亦然（与画布横幅一致）
    idx = (n + items.length) % items.length;
    img.src = items[idx].url;
    img.alt = items[idx].name || '图片';
    counter.textContent = `${idx + 1}/${items.length}`;
    // 必须改**浮层里那个** h3。改到一个游离元素上的话标题纹丝不动，
    // 「i/n」变了标题没变，看着像切失败了
    if (titleNode) titleNode.textContent = `预览：${items[idx].name || '图片'}`;
  };

  const nav = many ? h('div.mm-preview-nav', {},
    h('button.mm-btn', { onclick: () => setIdx(idx - 1), title: '上一张（←）' }, '◀'),
    counter,
    h('button.mm-btn', { onclick: () => setIdx(idx + 1), title: '下一张（→）' }, '▶'),
  ) : null;

  // dialog 返回的 mask 里第一个 h3 就是标题，换张时同步改掉
  let titleNode = null;

  // wide：早先套在 560px 的 dialog 里，稍大一点的图就被压到要左右拖动
  const dlg = dialog(`预览：${items[idx].name || '图片'}`, [
    h('div', {}, img, nav, h('div.mm-actions', {}, save)),
  ], () => {
    offKeys();
    // 逐项释放：切换过的每一项都可能是一个 blob: URL
    for (const it of items) {
      try { if (it.url && /^blob:/.test(String(it.url))) URL.revokeObjectURL(it.url); } catch { /* ignore */ }
    }
  }, { wide: true });

  titleNode = dlg.mask.querySelector('h3');
  if (many) {
    counter.textContent = `${idx + 1}/${items.length}`;
    if (titleNode) titleNode.textContent = `预览：${items[idx].name || '图片'}`;
  }

  // ---- ← → 切换 ----
  function onKey(e) {
    if (!many) return;
    // 输入框里不要抢（预览浮层里没有输入，但保险一点）
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setIdx(idx - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setIdx(idx + 1); }
  }
  /**
   * 滚轮切换。
   *
   * 三个必须处理的点：
   *
   * 1. **一次手势只切一张**。滚轮事件远比按键密集 —— 触控板轻轻一划就是
   *    几十个事件，不处理的话三张图会被瞬间切好几圈。所以触发一次后**上锁**，
   *    等滚轮停下来（WHEEL_GAP 内不再有事件）才解锁。
   *    （不用"累积量/阈值"那套：惯性滚动的 delta 能攒到几百，会一次切很多张。）
   * 2. **要 preventDefault**，否则浮层背后的页面跟着一起滚。
   * 3. **只拦浮层内的滚动** —— 浮层外的滚轮不该被吃掉。
   */
  let acc = 0;
  let locked = false;
  let idleTimer = 0;
  function onWheel(e) {
    if (!many) return;
    if (!dlg.mask.contains(e.target)) return;
    e.preventDefault();
    // 有输入焦点时不抢（预览里没有输入框，但别把行为写死）
    acc += (e.deltaY || 0) + (e.deltaX || 0);
    if (Math.abs(acc) < WHEEL_STEP) return;
    // 上锁期间也要**把累积量清掉**：不清的话解锁那一刻 acc 已经攒够阈值，
    // 会立刻再切一张 —— 用户停手后画面自己又跳一下。
    if (locked) { acc = 0; return; }
    // **先取方向再清零** —— 顺序反了的话 acc 已经是 0，
    // `acc > 0` 永远为假，于是向下滚也变成往上一张
    const dir = acc > 0 ? 1 : -1;
    acc = 0;
    setIdx(idx + dir);
    // **必须上锁**：此前漏了这一行，`locked` 永远是 false，
    // 于是"一次手势只切一张"根本没生效 —— 触控板一划连切好几张。
    locked = true;
    clearTimeout(idleTimer);
    // 滚轮停下才解锁：这样「滑一次 = 切一张」，连滑两下是两张
    idleTimer = setTimeout(() => { locked = false; }, WHEEL_GAP);
  }
  function offWheel() {
    clearTimeout(idleTimer);
    locked = false;
    acc = 0;
  }

  function offKeys() {
    try { document.removeEventListener('keydown', onKey, true); } catch { /* ignore */ }
    try { document.removeEventListener('wheel', onWheel, { capture: true }); } catch { /* ignore */ }
    offWheel();
  }
  if (many) {
    document.addEventListener('keydown', onKey, true);
    // **必须 passive:false**：wheel 默认按 passive 注册，此时 preventDefault()
    // 会被忽略（浏览器还会打警告），浮层背后就会跟着一起滚。
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  }

  return dlg;
}

/** 历史快照列表 */
export async function openBackups(app) {
  const list = await store.listBackups();
  const box = h('div.mm-list', {});

  const render = async () => {
    box.innerHTML = '';
    const items = await store.listBackups();
    if (!items.length) {
      box.appendChild(h('div.mm-hint', {}, '暂无快照'));
      return;
    }
    for (const b of items) {
      box.appendChild(
        h('div.mm-item', {},
          h('span.name', {}, `${new Date(b.ts).toLocaleString()} · ${(b.sheets || []).length} 张画布`),
          h('button.mm-btn.icon', {
            onclick: safe('恢复快照', async () => {
              if (!b.sheets) return;
              // A46 恢复会覆盖**当前所有画布**且不可逆 —— 必须确认。
              // 不确认的话，误点一下整份工作就没了。
              const n = (b.sheets || []).length;
              const ok = await askConfirm({
                title: '恢复快照',
                message:
                  `恢复到 ${new Date(b.ts).toLocaleString()} 的快照？\n\n` +
                  `当前所有画布将被替换为该快照的 ${n} 张画布，此操作不可撤销。\n` +
                  `（恢复前的当前状态会自动另存一份快照，可再回滚）`,
                danger: true,
              });
              if (!ok) return;
              await app.api.restoreBackup(b);
              dlg.close();
            }, (m) => app.api.status(m, true)),
          }, '恢复'),
        ),
      );
    }
  };
  await render();

  const dlg = dialog('历史快照', [
    h('div.mm-hint', {}, `按时间倒序，最多保留 ${app.settings?.backupMax ?? store.BACKUP_KEEP} 份。恢复会覆盖当前所有画布。`),
    box,
    h('div.mm-actions', {},
      h('button.mm-btn', {
        onclick: safe('立即备份', async () => { await app.api.backupNow(); await render(); },
          (m) => app.api.status(m, true)),
      }, '立即备份'),
      h('button.mm-btn', {
        onclick: safe('清空快照', async () => { await store.clearBackups(); await render(); },
          (m) => app.api.status(m, true)),
      }, '清空快照'),
    ),
  ]
  );
  return dlg;
}

/* ------------------------- 预设图标库（A3–A10） ------------------------- */

/**
 * 图标库浮层：左侧分组列表，右侧图标网格，点图标即设为选中节点的图片。
 *
 * 与 WPF `OnPresetIconClick` 的差别：WPF 点一下就直接设为节点图片并关掉窗口。
 * 这里保留窗口开着 —— 连续给多个节点配图标是常见操作，关了又开很烦。
 */
export async function openIconLibrary(app) {
  let groups = await picons.loadLibrary();
  let activeId = groups[0]?.id || null;

  const grid = h('div.mm-icons', {});
  const groupList = h('div.mm-icon-groups', {});
  const hint = h('div.mm-hint', {}, '');

  const renderGroups = () => {
    groupList.innerHTML = '';
    groups.forEach((g) => {
      groupList.appendChild(
        h('button.mm-btn.icon-group' + (g.id === activeId ? '.on' : ''), {
          onclick: () => {
            activeId = g.id;
            renderGroups();
            // renderGrid 是 async：不接住的话切分组失败就是静默的
            safe('切换分组', () => renderGrid(), (m) => app.api.status(m, true))();
          },
          title: g.builtin ? '内置分组（不可编辑）' : g.name,
        }, g.name + (g.builtin ? '' : ` (${(g.icons || []).length})`)),
      );
    });
  };

  const renderGrid = async () => {
    const g = groups.find((x) => x.id === activeId) || groups[0];
    grid.innerHTML = '';
    if (!g) { grid.appendChild(h('div.mm-hint', {}, '暂无分组')); return; }
    const icons = g.icons || [];
    if (!icons.length) {
      grid.appendChild(h('div.mm-hint', {}, g.builtin ? '（内置）' : '该分组还没有图标，可点下方「导入」添加'));
    }
    for (const ic of icons) {
      const isUser = ic.kind === 'user';
      const box = h('button.mm-icon-cell', {
        onclick: safe('应用图标', async () => {
          const url = await picons.iconToDataUrl(ic);
          if (!url) { app.api.status('图标数据读取失败', true); return; }
          // 尺寸不用自己设：内核 image 命令会先 new Image() 探测真实尺寸
          // 再写 imageSize（受 maxImageWidth/Height 限制，默认 200）。
          // SVG 里写了明确的 width/height 属性，所以能正确探测到。
          app.bridge.setImage(url);
          app.api.commit();
          app.api.status(`已应用图标：${ic.name}`);
        }, (m) => app.api.status(m, true)),
        title: ic.name,
      });
      if (isUser) {
        // 用户图标要从 IndexedDB 取缩略图（异步）
        const rec = await store.get('asset:' + ic.assetId, null);
        if (rec?.blob) {
          const url = URL.createObjectURL(rec.blob);
          mediaUrls.push(url);
          box.appendChild(h('img', { src: url, alt: ic.name }));
        } else {
          box.appendChild(h('span.mm-icon-broken', {}, '⁇'));
        }
      } else {
        const u = picons.iconPreviewUrl(ic);
        if (u) box.appendChild(h('img', { src: u, alt: ic.name }));
        else box.appendChild(h('span.mm-icon-broken', {}, '⁇'));
      }
      box.appendChild(h('span.mm-icon-name', {}, ic.name));
      grid.appendChild(box);
    }
  };

  // 用户图标预览会建 Blob URL，浮层关掉时统一回收
  const mediaUrls = [];

  const reload = async () => {
    groups = await picons.loadLibrary();
    if (!groups.some((g) => g.id === activeId)) activeId = groups[0]?.id || null;
    renderGroups();
    await renderGrid();
  };

  // ---- 分组管理 ----
  const newGroup = async () => {
    const name = await askText({ label: '新分组名称', defaultValue: '新分组' });
    if (name == null) return;
    const g = await picons.addGroup(name);
    if (!g) { app.api.status('新建分组失败', true); return; }
    activeId = g.id;
    await reload();
    app.api.status('已新建分组：' + g.name);
  };

  const renameCur = async () => {
    const g = groups.find((x) => x.id === activeId);
    if (!g) return;
    if (g.builtin) { app.api.status('内置分组不可重命名', true); return; }
    const name = await askText({ label: '分组名称', defaultValue: g.name });
    if (name == null || name === g.name) return;
    const r = await picons.renameGroup(g.id, name);
    if (!r.ok) { app.api.status(r.error, true); return; }
    await reload();
    app.api.status('已重命名');
  };

  const delCur = async () => {
    const g = groups.find((x) => x.id === activeId);
    if (!g) return;
    if (g.builtin) { app.api.status('内置分组不可删除', true); return; }
    const n = (g.icons || []).length;
    if (!await askConfirm({ message: `删除分组「${g.name}」？${n ? `组内 ${n} 个图标会一并删除。` : ''}`, danger: true })) return;
    const r = await picons.deleteGroup(g.id);
    if (!r.ok) { app.api.status(r.error, true); return; }
    await reload();
    app.api.status('已删除分组：' + g.name);
  };

  /** A4 导入：把选中的图片存进 IndexedDB 并归入当前分组 */
  const importIcons = async () => {
    const files = await io.pickFiles('image/*');
    if (files?.length) await addImageFiles(files);
  };

  /**
   * 把图片文件存入当前分组（A4 文件导入 与 A5 剪贴板导入 共用）。
   * 抽出来是因为两条路的处理完全一致：容量校验 → 存资产 → 建条目。
   */
  const addImageFiles = async (files) => {
    const g = groups.find((x) => x.id === activeId);
    if (!g) return;
    if (g.builtin) { app.api.status('内置分组不可添加图标，请先新建一个分组', true); return; }
    let ok = 0;
    for (const f of files) {
      if (f.size > 1024 * 1024) { hint.textContent = `「${f.name}」超过 1MB，已跳过`; continue; }
      const id = await io.putAsset(f);
      if (!id) continue;
      const r = await picons.addIcon(g.id, { kind: 'user', name: f.name.replace(/\.[^.]+$/, ''), assetId: id });
      if (r.ok) ok++;
    }
    await reload();
    app.api.status(ok ? `已导入 ${ok} 个图标` : '导入失败（未写入本地库）', !ok);
  };

  /**
   * A5 剪贴板位图导入。
   *
   * 不弹授权框、不读剪贴板历史 —— 只在用户主动 Ctrl+V 时取图。
   * 剪贴板里没图就完全不响应（不提示），否则每按一次 Ctrl+V 都弹提示很烦。
   */
  const onPasteIcons = async (e) => {
    const files = imageItemsFromClipboard(e?.clipboardData);
    if (!files.length) return;         // 非图片：交给浏览器默认行为
    e.preventDefault();
    await addImageFiles(files);
  };

  /** A18 清理失效图标（资产已读不到的条目） */
  const pruneIcons = async () => {
    const r = await picons.pruneMissing();
    if (!r.removed) { app.api.status('没有失效图标'); return; }
    await reload();
    app.api.status(`已清理 ${r.removed} 个失效图标（涉及 ${r.groups} 个分组）`);
  };

  const dlg = dialog('图标库', [
    h('div.mm-icon-layout', {},
      h('div.mm-icon-side', {},
        groupList,
        h('div.mm-row', { style: { flexWrap: 'wrap' } },
          h('button.mm-btn', {
            onclick: safe('新建分组', () => newGroup(), (m) => app.api.status(m, true)),
            title: '新建分组',
          }, '＋分组'),
          h('button.mm-btn', {
            onclick: safe('重命名分组', () => renameCur(), (m) => app.api.status(m, true)),
          }, '重命名'),
          h('button.mm-btn', {
            onclick: safe('删除分组', () => delCur(), (m) => app.api.status(m, true)),
            title: '删除当前分组（至少保留一个）',
          }, '删除'),
        ),
        h('div.mm-row', { style: { flexWrap: 'wrap' } },
          h('button.mm-btn', {
            onclick: safe('导入图片', () => importIcons(), (m) => app.api.status(m, true)),
            title: '从图片文件导入',
          }, '导入图片'),
          // A5：不弹授权框，靠用户主动 Ctrl+V（见 onPasteIcons）
          h('button.mm-btn', {
            onclick: () => app.api.status('在此窗口按 Ctrl+V 即可把剪贴板里的图片加进当前分组'),
            title: '剪贴板位图导入（A5）',
          }, '粘贴图片'),
          // A18
          h('button.mm-btn', {
            onclick: safe('清理失效图标', () => pruneIcons(), (m) => app.api.status(m, true)),
            title: '移除资产已丢失的图标条目（对齐 WPF PruneMissing）',
          }, '清理失效'),
        ),
      ),
      h('div.mm-icon-main', {},
        grid,
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: safe('导入图片', () => importIcons(), (m) => app.api.status(m, true)),
            title: '把图片导入当前分组',
          }, '导入…'),
          h('button.mm-btn', { onclick: () => { app.bridge.setImage(null); app.api.commit(); app.api.status('已清除节点图标'); } }, '清除节点图标'),
        ),
        hint,
      ),
    ),
    h('div.mm-hint', {}, '点图标即设为选中节点的图片。图标本体存在本地库；内置图标是矢量图，不占脑图体积。'),
  ], () => {
    // 浮层关掉时回收预览用的 Blob URL，否则会一直攒着
    for (const u of mediaUrls) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } }
    mediaUrls.length = 0;
    // 粘贴监听必须解绑：挂在 document 上不解绑会一直存活到页面关闭，
    // 且闭包捕获了本次的 groups/activeId —— 之后再开图标库会**重复触发**，
    // 一次 Ctrl+V 加进去两份图标。
    document.removeEventListener('paste', onPasteIcons);
  });

  // 挂在 document 而不是对话框元素上：paste 只会派发给**当前焦点元素**，
  // 对话框本身拿不到焦点（点的是里面的按钮），挂在它上面收不到事件。
  document.addEventListener('paste', onPasteIcons);

  renderGroups();
  await renderGrid();
  return dlg;
}

/* ------------------------- 设置 ------------------------- */

/**
 * 设置面板（顶栏「设置」按钮打开）。
 *
 * 备份间隔 / 最多保留份数 / 布局动画这类**与当前节点无关**的全局选项，
 * 原先堆在文件页里 —— 它们不是「文件」的属性，放在那儿既难找，
 * 又把一个常用页签撑得很长。现在统一收到设置里。
 */
export function openSettings(app) {
  const s = app.settings || {};

  // 布局动画按钮就地更新：整体重建会让同面板里的 <select> 失焦
  const animBtn = h('button.mm-btn' + (s.animate ? '.on' : ''), {
    onclick: () => {
      app.api.setAnimate(!app.settings?.animate);
      // 重新读一遍：setAnimate 内部会写回 settings，以它的结果为准
      const on = !!app.settings?.animate;
      animBtn.classList.toggle('on', on);
      animBtn.textContent = on ? '已开启' : '已关闭';
    },
  }, s.animate ? '已开启' : '已关闭');

  const intervalSel = h('select.mm-select', {
    onchange: (e) => app.api.setBackupMinutes(Number(e.target.value)),
    title: '每隔多久比对一次内容并写入快照；关闭则不自动备份',
  }, ...[0, 1, 2, 5, 10, 30].map((m) =>
    h('option', { value: m, selected: Number(s.backupMinutes ?? 2) === m },
      m === 0 ? '关闭' : `${m} 分钟`)));

  // A47 暂停开关：就地更新文案（整体重建会让同面板的 <select> 失焦）
  const pauseBtn = h('button.mm-btn' + (s.backupPaused ? '.on' : ''), {
    onclick: () => {
      app.api.setBackupPaused(!app.settings?.backupPaused);
      const on = !!app.settings?.backupPaused;
      pauseBtn.classList.toggle('on', on);
      pauseBtn.textContent = on ? '已暂停' : '进行中';
    },
    title: '临时停掉自动快照；与「间隔=关闭」不同，暂停会保留原间隔值',
  }, s.backupPaused ? '已暂停' : '进行中');

  const keepSel = h('select.mm-select', {
    onchange: (e) => app.api.setBackupMax(Number(e.target.value)),
    title: '同一份脑图最多保留的快照份数，超出自动删除最旧的一份',
  }, ...[1, 2, 3, 5, 10].map((n) =>
    h('option', { value: n, selected: Number(s.backupMax ?? 3) === n }, `${n} 份`)));

  // PDF 导出通道：让用户能改默认，但**不是必选** ——
  // 任一通道走不通都会自动托底到另一条，这里选的只是「先试哪条」。
  const pdfSel = h('select.mm-select', {
    onchange: (e) => app.api.setPdfChannel(e.target.value),
    title: '「矢量」不弹对话框、直接保存；失败会自动改用打印对话框',
  },
  h('option', {
    value: 'vector',
    selected: (s.pdfChannel || 'vector') === 'vector',
  }, '矢量（直接保存）'),
  h('option', {
    value: 'dialog',
    selected: s.pdfChannel === 'dialog',
  }, '打印对话框'));

  return dialog('设置', [
    section('备份',
      h('div.mm-row', {}, h('span.mm-label', {}, '自动间隔'), intervalSel),
      h('div.mm-hint', {}, '到点才比对一次；内容与最新快照相同则不写盘，避免空转。'),
      h('div.mm-row', { style: { marginTop: '2px' } },
        h('span.mm-label', {}, '自动快照'), pauseBtn),
      h('div.mm-hint', {}, '暂停只临时停，间隔值保留；选「关闭」才是永久停用。'),
      h('div.mm-row', { style: { marginTop: '2px' } }, h('span.mm-label', {}, '最多保留'), keepSel),
      h('div.mm-hint', {}, '调小后立即清理超出部分，无需等下次备份。'),
      h('div.mm-row', { style: { marginTop: '4px' } },
        h('button.mm-btn', { onclick: () => app.api.backupNow() }, '立即备份'),
        h('button.mm-btn', {
          onclick: safe('打开快照', () => openBackups(app), (m) => app.api.status(m, true)),
        }, '历史快照…'),
      ),
      // 快照的**导出/导入文件**已移到侧栏「导入导出」页（与其余导入导出入口集中）。
      // 这里只留备份策略（间隔 / 暂停 / 保留份数）与历史快照入口。
      h('div.mm-hint', {}, '换机迁移（把快照导出成文件带走 / 从文件合并回来）在侧栏「导入导出」页。'),
    ),
        section('导出',
      h('div.mm-row', {}, h('span.mm-label', {}, 'PDF 通道'), pdfSel),
      h('div.mm-hint', {},
        '「矢量」用 svg2pdf 直接转，不经浏览器、不弹对话框，输出仍是矢量可无损放大。',
        '\n',
        '任一通道不可用时会自动改用另一条，这里只是决定先试哪条。'),
    ),
section('外观',
      h('div.mm-row', {}, h('span.mm-label', {}, '布局动画'), animBtn),
      h('div.mm-hint', {}, '开启后打开画布、展开/收起分支会播 300ms 过渡动画；关闭则直接显示最终布局。'),
    ),
    section('拖放附加',
      h('div.mm-hint', {},
        '把图片 / 视频 / 文件拖到节点上即可附加，全部挂在该节点上（可多个）。',
        '\n',
        '图片显示为可切换的横幅，视频是一张带数字角标的卡片，文件每行一个。'),
    ),
    section('其它',
      h('div.mm-row', {},
        h('button.mm-btn', {
          onclick: () => openShortcuts(app),
          title: '查看编辑器支持的快捷键',
        }, '快捷键…'),
        // A71：画布跑在 iframe 里，那边报错不进外壳控制台，
        // 没有这个入口用户遇到「点了没反应」时毫无线索。
        h('button.mm-btn', {
          onclick: () => app.api.openDiagnostics(),
          title: '查看画布与外壳的错误、警告记录',
        }, '诊断记录…'),
        // A70：debug 构建才真的能开，release 会给出提示
        h('button.mm-btn', {
          onclick: safe('开发者工具', () => app.api.openDevTools(), (m) => app.api.status(m, true)),
          title: '打开开发者工具（仅调试构建可用）',
        }, '开发者工具'),
      ),
      h('div.mm-hint', {}, '诊断记录会一直累积到清空为止（最多保留最近 100 条）。'),
    ),
  ]);
}

/* ------------------------- 快捷键说明 ------------------------- */

/**
 * 编辑器页面（editor/index.html）实际注册的快捷键。
 * 注：core 另外内置 Ctrl+A 全选、方向键导航、/ 折叠、Alt+1~5 展开层级。
 * 这里只列页面显式注册的，避免把内核行为写成文档后对不上。
 */
const SHORTCUTS = [
  // —— 编辑器页面显式注册（editor/index.html）——
  ['Tab', '插入下级节点并进入编辑'],
  ['Enter', '插入同级节点并进入编辑'],
  ['Delete / Backspace', '删除选中节点（根节点除外）'],
  ['F2', '编辑选中节点文字'],
  ['Ctrl + B', '加粗'],
  ['Ctrl + I', '斜体'],
  ['Ctrl + D', '删除线'],
  ['Ctrl + E', '水平居中'],
  ['Ctrl + L', '水平左对齐'],
  ['Ctrl + R', '水平右对齐'],
  ['Ctrl + Shift + C', '复制节点样式'],
  ['Ctrl + Shift + V', '粘贴节点样式'],
  // —— 页面补齐：内核只登记了键码、未实现行为，由 editor/index.html 实现 ——
  ['↑ / ↓', '在兄弟节点间移动'],
  ['←', '移到父节点（只移动，不折叠）'],
  ['→', '进入第一个子节点（折叠着会先展开）'],
  ['Ctrl + ←', '折叠选中分支'],
  ['Ctrl + →', '展开选中分支'],
  ['/', '折叠 / 展开选中节点（来回切换）'],
  ['Alt + 1~5', '从选中节点展开到第 N 级（更深层收起）'],
  // —— 内核 commandShortcutKeys 注册 ——
  // ClipboardModule 提供 copy/cut/paste 命令并注册了这组快捷键；
  // DragTree 提供节点拖拽（含多选，见 getSelectedAncestors）。
  ['Ctrl + C / X / V', '复制 / 剪切 / 粘贴节点（含子树，根不可复制）'],
  ['Alt + ↑ / ↓', '节点上移 / 下移'],
  ['Shift + Tab', '插入上级节点'],
  ['Ctrl + Shift + L', '整理布局'],
  ['Ctrl + = / -', '画布缩放'],
  ['Ctrl + A', '全选'],
  ['Ctrl + C / X / V', '复制 / 剪切 / 粘贴节点'],
];

/** 快捷键说明浮层：快捷键由编辑器页面注册，插件无法改写，只能如实列出 */
export function openShortcuts(app) {
  const rows = SHORTCUTS.map(([k, d]) =>
    h('div.mm-row', { style: { gap: '10px' } },
      h('code.mm-kbd', {}, k),
      h('span', { style: { fontSize: '12px' } }, d),
    ));
  return dialog('快捷键', [
    h('div.mm-hint', {}, '快捷键由编辑器内核注册，焦点需在画布上才生效。'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' } }, ...rows),
  ]);
}
