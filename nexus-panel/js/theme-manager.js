/**
 * 主题管理器
 * ============================================================
 * 负责：应用主题到 CSS 变量、持久化、订阅变更、自定义主题、强调色微调。
 *
 * 设计要点：
 *   1. 主题只写 CSS 变量到 :root，DOM 与 CSS 文件完全不动
 *   2. 派生变量（hairline / mask / scroll-thumb / accent-glow）按 base 自动算，
 *      主题定义里不用重复写
 *   3. 切换后立即通知订阅者 —— 外壳用它来刷新 iframe 插件与重算适配
 */

import {
  PRESET_THEMES, THEME_VARS, DERIVED_VARS, ACCENT_SWATCHES, ACCENT_SWATCHES_LIGHT,
  DEFAULT_THEME_ID, swatchFor, styleParams, BG_PRESETS, findBgPreset,
} from './themes.js';

export { ACCENT_SWATCHES, ACCENT_SWATCHES_LIGHT, swatchFor, PRESET_THEMES, THEME_VARS };
/* 风格参数表转出去：设置页要按当前风格渲染对应的滑块 */
export { STYLE_PARAMS } from './themes.js';
/* 预设背景表：设置页要渲染可选宫格 */
export { BG_PRESETS } from './themes.js';

const KEY_THEME = 'nexus:theme';
const KEY_ACCENT = 'nexus:accent';
// 环境色（原「主题色」）：与强调色并列的第二个可调主色
const KEY_ENV = 'nexus:env-color';
/*
 * 自定义色的收藏夹：**强调色与环境色各存一份**。
 *
 * 为什么要分开：色盘的「常用色」是调用方传进去、又原样带回来的
 * （pick 返回 { hex, custom }），共用一个键的话，
 * 在强调色里收藏的一批色会串到环境色那边去。
 */
const KEY_CUSTOM_ACCENT = 'nexus:accent-custom';
const KEY_CUSTOM_ENV = 'nexus:env-custom';
// 用户是否手动选过主题 —— 没选过时默认主题才能继续生效
const KEY_USERSET = 'nexus:theme-userset';
// 主题色调整：在主题自身配色上做整体偏移（色相角度 / 明暗百分比）
const KEY_HUE = 'nexus:hue-shift';
const KEY_LIGHT = 'nexus:light-shift';
const KEY_CUSTOM = 'nexus:custom-themes';
// 首屏防闪用：最近一次应用的底色 / 前景色
const KEY_PRELOAD_BG = 'nexus:preload-bg';
const KEY_PRELOAD_FG = 'nexus:preload-fg';
/* 基调（dark / light）：iframe 内的独立文档要靠它设 color-scheme，
   否则里面的表单控件与滚动条永远按浏览器默认的浅色渲染 */
const KEY_PRELOAD_BASE = 'nexus:preload-base';

/* ---------------------------- 颜色工具 ---------------------------- */
function parseHex(hex) {
  if (!hex) return null;
  const s = String(hex).trim();
  const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('');

/** amount > 0 变亮，< 0 变暗 */
function shift(hex, amount) {
  const c = parseHex(hex);
  if (!c) return hex;
  const f = (v) => (amount >= 0 ? v + (255 - v) * (amount / 100) : v * (1 + amount / 100));
  return toHex({ r: f(c.r), g: f(c.g), b: f(c.b) });
}

function rgba(hex, a) {
  const c = parseHex(hex);
  if (!c) return `rgba(120,140,255,${a})`;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

/* ------------------- 主题色调整（色相 / 明暗） ------------------- */

/**
 * 参与整体偏移的变量白名单。
 *
 * 刻意排除：
 *  · --ok / --running / --warn / --danger  状态色，语义固定，不能被偏移
 *  · --accent / --env-color                用户显式挑的，再偏移就不可控了
 *  · --accent-glow                         由 accent 派生，跟随 accent
 *  · --bg-image                            渐变，整体变换不可靠
 *  · --blur 等非颜色量
 */
const SHIFTABLE_VARS = [
  '--bg', '--surface', '--surface-sunk', '--surface-raised',
  '--sh-dark', '--sh-light',
  '--text', '--text-dim', '--text-mute', '--text-soft',
  '--border',
];

/** 解析任意 CSS 颜色 → {r,g,b,a}；无法识别返回 null */
function parseColor(c) {
  if (c == null) return null;
  const s2 = String(c).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s2);
  if (m) {
    const h = m[1];
    return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16),
             b: parseInt(h[2] + h[2], 16), a: 1 };
  }
  m = /^#([0-9a-f]{6})$/i.exec(s2);
  if (m) {
    const h = m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
             b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = /^#([0-9a-f]{8})$/i.exec(s2);
  if (m) {
    const h = m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
             b: parseInt(h.slice(4, 6), 16), a: parseInt(h.slice(6, 8), 16) / 255 };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s2);
  if (m) {
    const ps = m[1].split(',').map((x) => parseFloat(x));
    if (ps.length >= 3 && ps.slice(0, 3).every((n) => !isNaN(n))) {
      return { r: ps[0], g: ps[1], b: ps[2], a: ps.length > 3 && !isNaN(ps[3]) ? ps[3] : 1 };
    }
  }
  return null;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/**
 * 单色偏移。
 *
 * 明暗用幂律 l' = l^p（p = 1 - percent/100）而不是直接加减：
 * 幂律在 [0,1] 上单调、不会截断，且保留了颜色的相对层次 ——
 * 直接加会让暗色一下子跳到中灰，而亮色几乎没变化。
 */
function shiftColor(str, hueDelta, lightPow) {
  const c = parseColor(str);
  if (!c) return str;
  let { h, s, l } = rgbToHsl(c.r, c.g, c.b);
  // 近灰色的色相不稳定（HSL 里灰色的 h 无意义），跳过以免引入杂色
  if (s > 0.06 && hueDelta) h = (h + hueDelta + 3600) % 360;
  if (lightPow !== 1) l = Math.max(0, Math.min(1, Math.pow(l, lightPow)));
  const o = hslToRgb(h, s, l);
  const r = Math.round(o.r), g = Math.round(o.g), b = Math.round(o.b);
  if (c.a < 1) return `rgba(${r}, ${g}, ${b}, ${c.a})`;
  return toHex({ r, g, b });
}

/* --- 可读性保护所需的几个小工具 --- */
function relLum(c) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrastRatio(a, b) {
  const l1 = relLum(a), l2 = relLum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** alpha 合成：fg 叠在 bg 上（glass 主题的 surface 是半透明的） */
function composite(fg, bg) {
  if (!fg) return bg;
  if (!bg) return { ...fg, a: 1 };
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function mixColor(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t,
           b: a.b + (b.b - a.b) * t, a: a.a };
}

function fmtColor(c) {
  const r = Math.round(c.r), g = Math.round(c.g), b = Math.round(c.b);
  if (c.a < 1) return `rgba(${r}, ${g}, ${b}, ${c.a})`;
  return toHex({ r, g, b });
}

/**
 * 在某个底色上挑一个可读的前景色：黑白两端各算一遍，取对比度更高的。
 *
 * 为什么不做"往目标色插值"：角标压在**品牌强调色**上，
 * 把强调色改深/改浅等于改了品牌色，那是另一件事。
 * 换前景色（黑↔白）不动底色，是这类场景的标准做法。
 */
function pickOnColor(bgHex) {
  const bg = parseColor(bgHex);
  if (!bg) return '#ffffff';
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };
  return contrastRatio(white, bg) >= contrastRatio(black, bg) ? '#ffffff' : '#000000';
}

/** 颜色是否偏暗（用于决定叠在它上面的前景色用黑还是白） */
function isDarkish(hex) {
  const c = parseColor(hex);
  if (!c) return false;
  return relLum(c) < 0.4;
}

/**
 * 明暗偏移把正文和底色一起推，浅色主题大幅提亮时对比度会掉到 3 左右 ——
 * 正文就糊了。这里在「偏移后的正文」与「原始正文」之间插值回拉，
 * 直到对比度回到 4.65（WCAG 正文 AA 是 4.5，留一点余量抵消取整误差）。
 *
 * 只对 --text 做，其他文字档（--text-dim / --text-soft）是次要信息，
 * 跟着走即可，过度保护反而会让层次消失。
 */
function ensureTextReadable(vars) {
  const bg = composite(parseColor(vars['--surface']), parseColor(vars['--bg']));
  const shifted = parseColor(vars['--text']);
  if (!bg || !shifted) return;
  if (contrastRatio(shifted, bg) >= 4.65) return;

  /* 朝对比度更高的那一端推。
     不能只看"正文现在是亮还是暗"：大幅提亮深色主题时底色会跨到浅色区，
     此时继续把正文推向纯白反而更糟（白字配浅底），
     正确做法是翻成深色字。所以黑白两端都算一遍，取更高的那个。 */
  const white = { r: 255, g: 255, b: 255, a: shifted.a };
  const black = { r: 0, g: 0, b: 0, a: shifted.a };
  const target = contrastRatio(white, bg) >= contrastRatio(black, bg) ? white : black;
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const c = mixColor(shifted, target, t);
    if (contrastRatio(c, bg) >= 4.65) { vars['--text'] = fmtColor(c); return; }
  }
  vars['--text'] = fmtColor(target);
}

/**
 * 把某个主题的色相 / 明暗偏移套用到一组变量上（原地改）。
 * 传入 theme 才能取到**那套主题**的偏移 —— 不传就默认当前主题，
 * 于是「另存为自定义主题」会把当前偏移一并固化进去，符合预期。
 */
function applyShift(vars, theme) {
  const hue = getHueShift(theme?.id);
  const pct = getLightShift(theme?.id);
  if (!hue && !pct) return vars;
  const pow = 1 - pct / 100;
  for (const k of SHIFTABLE_VARS) {
    if (vars[k] == null) continue;
    vars[k] = shiftColor(vars[k], hue, pow);
  }
  if (pct) ensureTextReadable(vars);
  return vars;
}

/* ---------------------------- 派生变量 ---------------------------- */

/**
 * 把用户调过的风格参数写进变量表。
 *
 * 两种模式：
 *   · 倍率（默认）—— 缩放 affects 里各变量的 alpha，100% 等于主题原值
 *   · 绝对值（absolute: true）—— 直接替换，用于 --blur 这种长度值
 *
 * 为什么 --blur 不能用倍率：主题里它是 `0px`（非玻璃风格根本没开模糊），
 * 任何倍率乘 0 还是 0。而玻璃主题的 `12px` 用户想调到 0 也调不动。
 * 长度量只能直接给值。
 */
function applyStyleParams(vars, theme) {
  const list = styleParams(theme?.style);
  if (!list.length) return vars;
  for (const p of list) {
    const raw = getStyleParam(p.key, theme?.id);
    if (raw == null) continue;                       // 没调过 → 保持主题原值
    if (p.absolute) {
      /* 绝对值的 min/max 由 STYLE_PARAMS 定，这里只夹一次防越界 */
      const n = Math.max(p.min, Math.min(p.max, Number(raw)));
      for (const k of p.affects) vars[k] = k === '--blur' ? `${n}px` : String(n);
      continue;
    }
    /*
     * invert（玻璃透明度）：标签写的是"透明度"，调高就该更透 = alpha 更低，
     * 所以取倒数。100% 时 k=1 保持主题原值，两种方向都以此为中心。
     */
    const k = p.invert ? 100 / Number(raw) : Number(raw) / 100;
    if (!isFinite(k)) continue;
    /*
     * opacity 模式（磨砂颗粒）：它是不透明度**数值**，不是颜色，
     * scaleAlpha 只对 rgba() 字符串有效，对 '0.055' 无能为力。
     * 上限 0.15 —— 资料实测：颗粒超过约 15% 就不再是质感，
     * 而是肉眼可见的噪点。这里硬性夹住，滑块拖到底也不会脏。
     */
    if (p.mode === 'opacity') {
      for (const name of p.affects) {
        const cur = parseFloat(vars[name]);
        if (!isFinite(cur)) continue;
        vars[name] = String(Math.min(0.15, +(cur * k).toFixed(3)));
      }
      continue;
    }
    for (const name of p.affects) {
      if (vars[name] == null) continue;
      vars[name] = p.mode === 'deviation'
        /* 立体度：缩放阴影色**离底色多远**（hex 阴影只能这么调，见 scaleDeviation） */
        ? scaleDeviation(vars[name], vars['--bg'], k)
        : scaleAlpha(vars[name], k);
    }
    /* 弹框：只吃一半幅度 + 不透明度地板（见 STYLE_PARAMS 的 softAffects） */
    if (p.softAffects) {
      const kSoft = 1 + (k - 1) / 2;
      for (const name of p.softAffects) {
        if (vars[name] == null) continue;
        vars[name] = scaleAlpha(vars[name], kSoft);
        if (p.alphaFloor != null) vars[name] = clampAlphaMin(vars[name], p.alphaFloor);
      }
    }
  }
  return vars;
}

/**
 * 主题的元数据覆盖：深浅 / 风格。
 *
 * 为什么这两个也要能改：
 *   用户想"把这套深色新拟态改成浅色版"，只改颜色是不够的 ——
 *   base 决定派生量的方向（分隔线用微白还是微黑）、插件的基调、
 *   浏览器表单控件的配色。不改 base 的话，界面变浅了但分隔线还是
 *   浅色、几乎看不见，看着像坏了。
 */
function applyMetaOverride(theme) {
  if (!theme) return theme;
  let b = null;
  let st = null;
  try {
    b = localStorage.getItem(KEY_BASE_OVR + ':' + theme.id);
    st = localStorage.getItem(KEY_STYLE_OVR + ':' + theme.id);
  } catch { /* 存储不可用：用原值 */ }
  if (!b && !st) return theme;
  return {
    ...theme,
    base: b === 'dark' || b === 'light' ? b : theme.base,
    style: st || theme.style,
  };
}

/** 把用户逐项覆盖的变量叠加进变量表 */
function applyVarOverrides(vars, theme) {
  let map = {};
  try {
    map = JSON.parse(localStorage.getItem(varMapKey(theme.id)) || '{}');
  } catch { /* 手改坏了不该让主题整个崩掉 */ }
  for (const [k, val] of Object.entries(map)) {
    if (typeof val === 'string' && val !== '') vars[k] = val;
  }
}

const varMapKey = (themeId) => `${KEY_VAR}:${themeId || current?.id || getThemeId()}`;

function readVarMap(themeId) {
  try {
    const m = JSON.parse(localStorage.getItem(varMapKey(themeId)) || '{}');
    return m && typeof m === 'object' ? m : {};
  } catch { return {}; }
}

function writeVarMap(themeId, map) {
  try { localStorage.setItem(varMapKey(themeId), JSON.stringify(map)); } catch { /* 忽略 */ }
}

/** @returns {string|null} 该变量在此主题下的用户覆盖值，未覆盖为 null */
export function getVarOverride(name, themeId) {
  const v = readVarMap(themeId)[name];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 全部覆盖（name → value），供设置页判断"哪些项被改过" */
export function getVarOverrides(themeId) {
  return readVarMap(themeId);
}

export function setVarOverride(name, value, themeId) {
  const m = readVarMap(themeId);
  if (value == null || value === '') delete m[name];
  else m[name] = String(value);
  writeVarMap(themeId, m);
  return m;
}

export function resetVarOverride(name, themeId) {
  const m = readVarMap(themeId);
  delete m[name];
  writeVarMap(themeId, m);
}

/** 清空该主题下的所有变量覆盖 */
export function resetAllVarOverrides(themeId) {
  writeVarMap(themeId, {});
}

/* ---- 元数据覆盖的读写 ---- */
export function getBaseOverride(themeId) {
  const id = themeId || current?.id || getThemeId();
  try {
    const v = localStorage.getItem(KEY_BASE_OVR + ':' + id);
    return v === 'dark' || v === 'light' ? v : null;
  } catch { return null; }
}

export function setBaseOverride(base, themeId) {
  const id = themeId || current?.id || getThemeId();
  try {
    if (!base) localStorage.removeItem(KEY_BASE_OVR + ':' + id);
    else localStorage.setItem(KEY_BASE_OVR + ':' + id, base);
  } catch { /* 忽略 */ }
}

export function getStyleOverride(themeId) {
  const id = themeId || current?.id || getThemeId();
  try { return localStorage.getItem(KEY_STYLE_OVR + ':' + id); } catch { return null; }
}

export function setStyleOverride(style, themeId) {
  const id = themeId || current?.id || getThemeId();
  try {
    if (!style) localStorage.removeItem(KEY_STYLE_OVR + ':' + id);
    else localStorage.setItem(KEY_STYLE_OVR + ':' + id, style);
  } catch { /* 忽略 */ }
}

function deriveVars(rawTheme) {
  /*
   * 先叠元数据覆盖（深浅 / 风格），再算变量 ——
   * 否则用户把深色主题改成浅色后，--divider 仍按深色取微白，
   * 结果是"界面变浅了但分隔线消失了"。
   */
  const theme = applyMetaOverride(rawTheme);
  const v = { ...theme.vars };
  const dark = theme.base === 'dark';

  // 先偏移基础配色，再做派生计算 —— 这样 scroll-thumb、hairline 之类
  // 由 --bg 派生的量也会跟着一起变，不会出现"底色变了滑块没变"。
  applyShift(v, theme);

  /* 风格参数放在色相/明暗**之后**、派生**之前**：
     · 之后 —— 偏移改的是颜色本身，若先缩放再偏移，
       缩放出的半透明面被偏移时会带着 alpha 一起走，结果与先偏移不同；
     · 之前 —— 将来若有从 --surface 派生的量，也能跟着一起变。
     这里只缩放主题**自己写的**值，不碰下面的派生量 ——
     派生量（--divider / --edge / --scroll-thumb 等）是"保证可见"的兜底，
     随用户滑块一起变淡就会失去兜底作用。 */
  applyStyleParams(v, theme);

  /* 用户逐项覆盖。
     ------------------------------------------------------------------
     位置刻意在**风格参数之后、派生量之前**：
       · 之后 —— 用户显式填的值优先于滑块缩放的结果。
         否则"手动把 --surface 调实"会被玻璃透明度滑块再乘一遍，
         用户改了没效果，只会以为控件坏了。
       · 之前 —— 派生量（--divider / --hairline / --scroll-thumb）
         从 --bg 算出，用户改了底色后它们要跟着一起变，
         放在派生之后就会停留在旧底色的取值上。 */
  applyVarOverrides(v, theme);

  /*
   * 玻璃风格的浮层底：主题没自带时**必须派生**，不能靠 CSS 兜底。
   * ------------------------------------------------------------------
   * 场景：用户把一套新拟态主题改成玻璃风格（风格也是参数了）。
   * 新拟态主题压根没有 --surface-overlay，改完后弹窗就退回
   * neumorphism.css 的兜底值 —— 那是按"面板本来就实"设计的，
   * 在半透明面板上等于弹窗没有底板，底下文字透上来与弹窗文字叠一起
   * （用户此前报过这个问题，当时是靠给 6 套玻璃主题补 overlay 解决的，
   *   但那条路覆盖不到"非玻璃主题改成玻璃"这条新路径）。
   *
   * 只在 glass 且缺失时派生：其余风格的面板本就实心，
   * CSS 兜底够用，无谓派生反而会改动现有观感。
   */
  if (theme.style === 'glass' && v['--surface-overlay'] == null) {
    const src = v['--surface-raised'] || v['--surface'];
    const c = src ? parseColor(src) : null;
    if (c) {
      /* 每通道 +4、alpha 0.96 —— 与玻璃主题自带的
         raised rgba(43,49,68,.94) → overlay rgba(47,53,74,.96) 同比例 */
      const lift = (x) => Math.min(255, Math.round(x) + 4);
      v['--surface-overlay'] = `rgba(${lift(c.r)}, ${lift(c.g)}, ${lift(c.b)}, 0.96)`;
    }
  }

  // 强调色辉光
  v['--accent-glow'] = rgba(v['--accent'], dark ? 0.32 : 0.22);

  // 分隔线：深色用微白，浅色用微黑
  v['--hairline'] = dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.07)';

  /* 分隔线：任何风格下都必须可见。
     ------------------------------------------------------------------
     与 --border 的区别（这是两回事，不能混用）：
       --border 是**风格开关** —— 新拟态下为 transparent（让阴影塑形），
         扁平 / 玻璃下才着色。它的值取决于"当前风格靠什么勾边界"。
       --divider 是**保证可见的边界** —— 不管什么风格都有颜色。

     混用的后果（实测）：agent-flow 曾把分隔线接到 --border 上，
     于是新拟态下 26 处分隔线 + 10 处无底色控件全部消失，
     侧边栏与画布连成一片。扁平 / 玻璃恰好没事，只是因为它们给
     --border 赋了值 —— 属于"碰巧没踩到"，不是设计对了。

     凡是"两个区域之间的分界"都用这个，不要用 --border：
     分界两侧往往同色（新拟态下 --surface 与 --bg 就是同一个值），
     一旦它透明就没有任何东西托底。 */
  v['--divider'] = dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.12)';

  /* 立体描边：给外凸元素勾一圈极淡的边，补上阴影撑不起来的那部分边界。
     ------------------------------------------------------------------
     为什么需要它：新拟态的卡片与底板**完全同色**，边界只能靠阴影勾。
     但 box-shadow 的模糊会把阴影摊进一条渐变带里 —— 实测 9px 模糊下
     有效强度只剩原值的 29%，把阴影色调到 ΔL* 11 也只落到 3.2（勉强可辨）。
     而 `inset 0 0 0 1px` 这层描边**没有模糊、不参与摊薄**，
     实测能直接贡献 ΔL* ≈ 7（深色）/ 8（浅色），是真正让边界清晰的那一下。

     为什么不用 --border：主元素上已经有 `border: 1px solid var(--border)`，
     而 --border 在新拟态下是 transparent（靠阴影）、在扁平下才着色。
     改 --border 会连带影响输入框、分隔线等一整套用法，那是另一件事。

     扁平风格给 transparent：它靠 --border 描边就够了，
     再叠一层 inset 描边会变成 2px 的粗边。 */
  v['--edge'] = theme.style === 'flat'
    ? 'transparent'
    : (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.10)');

  // 滚动条滑块：比底色略亮（深色）/ 略暗（浅色）
  v['--scroll-thumb'] = shift(v['--bg'], dark ? 16 : -16);

  // 遮罩
  v['--mask'] = dark ? 'rgba(10,12,16,.62)' : 'rgba(90,96,110,.32)';

  /* 角标文字：压在 --accent 之上，必须按强调色自己的明暗选黑白。
     ------------------------------------------------------------------
     此前写死 '#ffffff' —— 实测 23 套里有 **13 套不可读**：

       cyberpunk   #f7ff3c 亮黄 → 1.09    terminal    #8affc1 亮绿 → 1.22
       glass-aurora#8ce0ff 亮青 → 1.48    celadon     #6fcf97 → 1.90
       amber-dusk  #ffa94d 亮橙 → 1.90    …

     根因：白字只在**深色强调色**上成立，而这些主题的强调色本身就是亮色。
     取黑白两端里对比度更高的那个即可 —— 与 ensureTextReadable() 同思路。 */
  v['--badge-fg'] = pickOnColor(v['--accent']);

  // 未定义的兜底
  v['--bg-image'] = v['--bg-image'] || 'none';
  v['--border'] = v['--border'] || 'transparent';
  v['--blur'] = v['--blur'] || '0px';
  v['--warn'] = v['--warn'] || '#ffb454';
  v['--danger'] = v['--danger'] || '#ff6b6b';
  return v;
}

/* ---------------------------- 自定义主题 ---------------------------- */
export function getCustomThemes() {
  try { return JSON.parse(localStorage.getItem(KEY_CUSTOM) || '[]'); } catch { return []; }
}
function saveCustomThemes(list) {
  localStorage.setItem(KEY_CUSTOM, JSON.stringify(list));
}
export function saveCustomTheme(theme) {
  const list = getCustomThemes().filter((t) => t.id !== theme.id);
  list.push(theme);
  saveCustomThemes(list);
  return theme;
}
export function deleteCustomTheme(id) {
  saveCustomThemes(getCustomThemes().filter((t) => t.id !== id));
}

/* ---------------------------- 主题查找 ---------------------------- */
export function listThemes() {
  return [...PRESET_THEMES, ...getCustomThemes()];
}
/**
 * 按 id 取主题，取不到就退回默认，再取不到退回第一个预设。
 *
 * 兜底**不能递归**：此前写法是 `find(id) || findTheme(DEFAULT_THEME_ID) || PRESET[0]`。
 * 若 DEFAULT_THEME_ID 恰好不在列表里（自定义主题被删、或默认 id 写错），
 * 第二项会用**完全相同的参数**再调一次自己 → 无限递归 → 栈溢出，
 * 而 `|| PRESET_THEMES[0]` 这层兜底永远到不了。
 * 改成非递归的三级查找，任何情况下都有返回值。
 */
export function findTheme(id) {
  const all = listThemes();
  return all.find((t) => t.id === id)
    || all.find((t) => t.id === DEFAULT_THEME_ID)
    || PRESET_THEMES[0];
}

/* ---------------------------- 状态 ---------------------------- */
let current = null;
const listeners = new Set();

export function getThemeId() {
  // 未手动选过主题时用 DEFAULT_THEME_ID（Agent Flow 深色）而不是数组第一项，
  // 这样打开 agent-flow 插件的观感与它独立运行时一致。
  try { return localStorage.getItem(KEY_THEME) || DEFAULT_THEME_ID; } catch { return DEFAULT_THEME_ID; }
}
export function getAccent() {
  try { return localStorage.getItem(KEY_ACCENT) || null; } catch { return null; }
}

/** 环境色：与强调色并列的第二个可调主色，仅作次要点缀 */
export function getEnvColor() {
  try { return localStorage.getItem(KEY_ENV) || null; } catch { return null; }
}

/*
 * 收藏夹上限。
 *
 * **必须与色盘的 MAX_CUSTOM（24）对齐，不能比它小** ——
 * 小了会把用户收藏的色静默截断：在色盘里收藏 20 个，
 * 回到设置页存下来只剩 16 个，用户不会收到任何提示。
 */
const CUSTOM_MAX = 24;

/**
 * 读某个槽位的自定义色收藏夹。
 *
 * slot —— 'accent' | 'env'
 *
 * 解析失败一律返回空数组，不抛：收藏夹只是"上次用过的色"，
 * 读不出来最多是不显示，不至于让整个设置页打不开。
 */
export function getCustomColors(slot) {
  const key = slot === 'env' ? KEY_CUSTOM_ENV : KEY_CUSTOM_ACCENT;
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v)
      ? v.filter((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))
        /* 统一小写：色盘 normalizeHex 返回大写，手改的可能是小写，
           不归一化的话同一个色会被当成两个，重复占位 */
        .map((c) => c.toLowerCase())
        .slice(0, CUSTOM_MAX)
      : [];
  } catch { return []; }
}

/**
 * 存收藏夹。
 *
 * 刻意**只认 #rrggbb**：色盘返回的已归一化，而手改 localStorage 的人
 * 塞进来的怪值会让面板渲染出非法色。过滤掉比带着跑更安全。
 */
export function saveCustomColors(slot, list) {
  const key = slot === 'env' ? KEY_CUSTOM_ENV : KEY_CUSTOM_ACCENT;
  const seen = new Set();
  const clean = (Array.isArray(list) ? list : [])
    .filter((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))
    .map((c) => c.toLowerCase())
    /* 去重：色盘内按原样比较，同一色的大写与小写会各占一格 */
    .filter((c) => (seen.has(c) ? false : (seen.add(c), true)))
    .slice(0, CUSTOM_MAX);
  try { localStorage.setItem(key, JSON.stringify(clean)); } catch {}
  return clean;
}

/**
 * 色相 / 明暗偏移**按主题分别存储**。
 *
 * 早先是全局一份（nexus:hue-shift 一个键），结果在 A 主题上调好的偏移
 * 会带到 B 主题上 —— 而不同主题的可调空间完全不同（纯黑底只能提亮、
 * 纯白底只能压暗），串过去往往正好是另一个主题的雷区。
 * 现在每个主题 id 各存一份，切主题时各自的偏移跟着切，互不干扰。
 *
 * 兼容：读时若本主题没存过，回落到旧的全局键（老用户已调好的值不至于丢），
 * 再没有才是 0。写时只写本主题的键，旧键保持不变。
 */
const shiftKey = (key, themeId) => `${key}:${themeId || getThemeId()}`;

/** 取某个主题的偏移值；本主题没存过就看旧的全局键（迁移用） */
function readShift(key, clampFn) {
  const id = current?.id || getThemeId();
  try {
    const own = localStorage.getItem(shiftKey(key, id));
    if (own != null) return clampFn(parseInt(own, 10));
    const legacy = localStorage.getItem(key);      // 旧版全局键
    return clampFn(parseInt(legacy || '0', 10));
  } catch { return 0; }
}

const clampHue = (n) => (isNaN(n) ? 0 : Math.max(-180, Math.min(180, n)));
const clampLight = (n) => (isNaN(n) ? 0 : Math.max(-50, Math.min(50, n)));

/* ------------------------ 风格参数（按主题存） ------------------------
 *
 * 三种风格各有独特的可调项（玻璃的透明度 / 模糊、新拟态的立体度、
 * 扁平的描边强度），定义在 js/themes.js 的 STYLE_PARAMS。
 *
 * 存法与色相 / 明暗**完全一致**（styleKey 按主题 id 分档），
 * 理由也相同：各主题的原始强度差异很大（玻璃深色 surface alpha .07、
 * 浅色 .55），存倍率而非绝对值；而倍率是相对本主题的，
 * 串到别的主题上必然不合适。
 */
const KEY_STYLE = 'nexus:style-param';
/*
 * 主题变量的用户覆盖。
 * ------------------------------------------------------------------
 * 存法与 styleKey / shiftKey 完全一致：**按主题 id 分档**。
 * 在 A 主题把底色改成蓝色，不该让 B 主题也变蓝 —— 每套主题是独立的设计，
 * 串了就等于"调一个坏一堆"，用户再也不敢动这些滑块。
 */
const KEY_VAR = 'nexus:theme-var';
/* 元数据覆盖（base 深浅 / style 风格）。
   这两个不是 CSS 变量，而是主题的"身份"，单独存。
   注意不能复用 KEY_STYLE —— 那个是风格参数的键前缀。 */
const KEY_BASE_OVR = 'nexus:theme-base-ovr';
const KEY_STYLE_OVR = 'nexus:theme-style-ovr';
const styleKey = (paramKey, themeId) =>
  `${KEY_STYLE}:${paramKey}:${themeId || current?.id || getThemeId()}`;

/** 取某主题的某风格参数；没设过返回 100（＝主题自带强度）。unit='px' 时返回 null 表示未设过 */
export function getStyleParam(paramKey, themeId) {
  try {
    const v = localStorage.getItem(styleKey(paramKey, themeId));
    return v == null ? null : Number(v);
  } catch { return null; }
}

/** 设置风格参数并立即重绘。改的不是当前主题时不重绘，等切过去自然读新值 */
export function setStyleParam(paramKey, value, themeId) {
  const id = themeId || current?.id || getThemeId();
  try { localStorage.setItem(styleKey(paramKey, id), String(Number(value))); } catch {}
  if (id !== (current?.id || getThemeId())) return getCurrent();
  const theme = current || findTheme(getThemeId());
  const applied = applyTo(theme, getAccent(), getEnvColor());
  listeners.forEach((fn) => {
    try { fn(applied, 'style-param'); } catch (e) { console.error('[theme]', e); }
  });
  return applied;
}

/** 复位某个风格参数到主题自带强度 */
export function resetStyleParam(paramKey, themeId) {
  const id = themeId || current?.id || getThemeId();
  try { localStorage.removeItem(styleKey(paramKey, id)); } catch {}
  if (id !== (current?.id || getThemeId())) return getCurrent();
  const theme = current || findTheme(getThemeId());
  const applied = applyTo(theme, getAccent(), getEnvColor());
  listeners.forEach((fn) => {
    try { fn(applied, 'style-param'); } catch (e) { console.error('[theme]', e); }
  });
  return applied;
}

/** 解析 hex / rgb() / rgba() 为 {r,g,b,a}；解析不了返回 null */
function parseAny(str) {
  const s = String(str || '').trim();
  const hex = parseHex(s);
  if (hex) return { ...hex, a: 1 };
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (!m) return null;
  const p = m[1].split(',').map((x) => x.trim());
  const r = parseFloat(p[0]), g = parseFloat(p[1]), b = parseFloat(p[2]);
  if (![r, g, b].every(isFinite)) return null;
  return { r, g, b, a: p.length > 3 && isFinite(parseFloat(p[3])) ? parseFloat(p[3]) : 1 };
}

const rgbToHex = (c) => '#' + [c.r, c.g, c.b]
  .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'))
  .join('');

/**
 * 缩放 rgba() 的 alpha 通道。
 *
 * 只认 rgba() —— 对 #rrggbb 或 `none` / `transparent` 原样返回。
 * 这不是偷懒：玻璃风格的 --surface 是半透明的，alpha 决定它
 * "透多少"，正是这里要调的东西；而把不透明的 hex 强行套 alpha
 * 会让底板透上来与文字叠在一起，是另一种风格不该发生的事。
 *
 * 上限锁 1：alpha 超过 1 浏览器会按 1 处理，但那样"继续调就没反应了"，
 * 用户会以为滑块坏了。锁到 1 让手感在饱和处停住而不是静默无效。
 */
/**
 * 把 alpha 抬到不低于 floor。
 *
 * 只用于"必须看得清"的浮层（弹框）。返回原串当它不是 rgba 时，
 * 与 scaleAlpha 的保守策略一致 —— 认不出的格式不动它。
 */
function clampAlphaMin(str, floor) {
  const m = /^rgba?\(([^)]+)\)$/.exec(String(str || '').trim());
  if (!m) return str;
  const parts = m[1].split(',').map((s) => s.trim());
  if (parts.length < 4) return str;
  const a = parseFloat(parts[3]);
  if (!isFinite(a) || a >= floor) return str;
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${floor})`;
}

/*
 * 缩放某色的 alpha 通道。
 *
 * ⚠️ 必须**同时认 hex 与 rgba()** —— 这是实测出来的一个真 bug：
 *
 *   新拟态主题的 --surface / --surface-sunk 是不透明 hex
 *   （深色新拟态：#2b2f36 / #282c33）。用户把这套主题改成玻璃风格后，
 *   设置页会出现"玻璃透明度"滑块（STYLE_PARAMS 按风格渲染），
 *   但它缩放的 --surface 是 hex —— 原实现只认 rgba()、对 hex 原样返回，
 *   于是**滑块拖到底也一点变化都没有**，用户只会以为控件坏了。
 *
 *   这与"立体度"必须用 deviation 模式（而非 alpha）是同一个根因的两半：
 *   三种风格的原始值写法不同，缩放手段就得跟着变。
 *   当时只修了新拟态的一半，玻璃这一半漏了。
 *
 * hex 视作 alpha=1（不透明）参与缩放，语义正确：hex 就是不透明色。
 */
function scaleAlpha(str, k) {
  const s = String(str || '').trim();
  if (!s || s === 'transparent' || s === 'none') return str;

  let r;
  let g;
  let b;
  let a;

  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean).map((x) => x.trim());
    if (parts.length < 3) return str;
    /* 通道可能是百分比（rgb(50% 20% 10%)），统一换算到 0-255 */
    const to255 = (x) => (x.endsWith('%')
      ? Math.round((parseFloat(x) / 100) * 255)
      : Math.round(parseFloat(x)));
    [r, g, b] = [to255(parts[0]), to255(parts[1]), to255(parts[2])];
    /* rgb()（三参数）没有 alpha，视作 1 参与缩放 ——
       否则"rgb(36,41,57)"这种写法同样调不动 */
    a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    if (![r, g, b].every(Number.isFinite) || !isFinite(a)) return str;
  } else {
    const hm = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
    if (!hm) return str;                      // 渐变、命名色等：改不了就原样返回
    let h = hm[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
    a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  }

  const na = Math.max(0, Math.min(1, a * k));
  return `rgba(${r}, ${g}, ${b}, ${Number(na.toFixed(3))})`;
}

/**
 * 缩放某色**相对底色**的偏离量（新拟态的"立体度"用它）。
 *
 * ==================================================================
 * 为什么不能用 scaleAlpha —— 这是本轮实测才发现的一个错误：
 *
 *   新拟态的 --sh-dark / --sh-light 是**不透明 hex**
 *   （深色新拟态：#16181d / #414855，底色 #2b2f36），14 套全部是 hex。
 *   而 scaleAlpha 只认 rgba()，对 hex 原样返回 ——
 *   照原方案做下去，"立体度"滑块拖到底也**一点变化都没有**。
 *
 *   立体感的来源不是 alpha，而是阴影色**离底色多远**：
 *     k=1 → 原值（正常凸起）
 *     k=0 → 等于底色 → 阴影消失 → 退化为扁平（语义正确！）
 *     k=2 → 偏离加倍 → 更立体
 *   这才是"立体度"该调的量，也天然覆盖"调到 0 就是扁平"这个直觉。
 * ==================================================================
 *
 * 输出保持原格式：入参是 hex 就出 hex，是 rgba 就保留 alpha，
 * 免得把主题里刻意写的半透明阴影改成不透明。
 */
function scaleDeviation(str, baseStr, k) {
  const c = parseAny(str);
  const b = parseAny(baseStr);
  if (!c || !b) return str;
  /* rgba 先合成到底色上再缩放偏离，否则半透明阴影的"实际观感强度"
     与算出来的对不上（合成后偏离变小，缩放会放大误差）。 */
  const ca = Math.max(0, Math.min(1, c.a));
  const eff = {
    r: c.r * ca + b.r * (1 - ca),
    g: c.g * ca + b.g * (1 - ca),
    b: c.b * ca + b.b * (1 - ca),
  };
  const out = {
    r: Math.max(0, Math.min(255, b.r + (eff.r - b.r) * k)),
    g: Math.max(0, Math.min(255, b.g + (eff.g - b.g) * k)),
    b: Math.max(0, Math.min(255, b.b + (eff.b - b.b) * k)),
  };
  if (ca < 1) {
    /* 原本半透明 → 转回"能产生同样观感"的 rgba（alpha 不变） */
    const a = ca;
    const rgb = {
      r: (out.r - b.r * (1 - a)) / a,
      g: (out.g - b.g * (1 - a)) / a,
      b: (out.b - b.b * (1 - a)) / a,
    };
    return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${a})`;
  }
  return rgbToHex(out);
}

/** 色相偏移，单位度，范围 -180 ~ 180，0 表示不偏移 */
export function getHueShift(themeId) {
  if (themeId) {
    try {
      const v = localStorage.getItem(shiftKey(KEY_HUE, themeId));
      return v == null ? 0 : clampHue(parseInt(v, 10));
    } catch { return 0; }
  }
  return readShift(KEY_HUE, clampHue);
}

/** 明暗偏移，单位百分比，范围 -50（压暗）~ 50（提亮），0 表示不偏移 */
export function getLightShift(themeId) {
  if (themeId) {
    try {
      const v = localStorage.getItem(shiftKey(KEY_LIGHT, themeId));
      return v == null ? 0 : clampLight(parseInt(v, 10));
    } catch { return 0; }
  }
  return readShift(KEY_LIGHT, clampLight);
}

/**
 * 同时设置色相与明暗（分开设会触发两次重绘，滑块拖动时会卡顿）。
 * 只作用于**当前主题**。
 */
export function setThemeShift(hue, light, themeId) {
  const h = Math.max(-180, Math.min(180, Math.round(Number(hue) || 0)));
  const l = Math.max(-50, Math.min(50, Math.round(Number(light) || 0)));
  const id = themeId || current?.id || getThemeId();
  try {
    localStorage.setItem(shiftKey(KEY_HUE, id), String(h));
    localStorage.setItem(shiftKey(KEY_LIGHT, id), String(l));
  } catch {}
  // 改的不是当前主题时不用重绘，等切过去自然会读新值
  if (id !== (current?.id || getThemeId())) return getCurrent();
  const theme = current || findTheme(getThemeId());
  const applied = applyTo(theme, getAccent(), getEnvColor());
  listeners.forEach((fn) => {
    try { fn(applied, 'theme-shift'); } catch (e) { console.error('[theme]', e); }
  });
  return applied;
}

/** 清空某个主题的偏移（供「恢复主题自带配色」用，默认当前主题） */
function clearShift(themeId) {
  try {
    localStorage.removeItem(shiftKey(KEY_HUE, themeId));
    localStorage.removeItem(shiftKey(KEY_LIGHT, themeId));
  } catch {}
}
export function getCurrent() {
  return current || findTheme(getThemeId());
}
/** 面板基调：给插件适配器判断要不要反转 */
export function getBase() {
  return (current || findTheme(getThemeId())).base;
}

/* ---------------------------- 切换过渡 ---------------------------- */
let transitionTimer = null;
function flashTransition() {
  const root = document.documentElement;
  if (!root.classList) return;
  root.classList.add('theme-transition');
  clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 320);
}

/**
 * 主题是否正处于切换过渡中。
 *
 * 这个查询很关键：过渡期间元素的 computed color 是**动画中间值**，
 * 此时采样插件颜色会读到中间色 → 基调误判 → 施加本不该有的反转
 * （表现就是"插件和主平台反过来了"）。采样方必须先等它返回 false。
 */
export function isThemeTransitioning() {
  try {
    return !!document.documentElement?.classList?.contains('theme-transition');
  } catch { return false; }
}

/* ---------------------------- 应用 ---------------------------- */
/**
 * 让已保存的自定义色跟随面板基调。
 *
 * 同一个色值在深底浅底上表现差异极大：#48e0c0（青）在深色底上对比度
 * 10.5:1，放到浅色底只有 1.4:1 —— 几乎看不见。
 *
 * 所以切换主题时，若发现存的是"另一套色板里的同款色"，
 * 就自动换成当前基调对应的那个值（青 → #2a826f）。
 * 完全自定义的值（不在任何色板里）原样保留，不擅自改动。
 */
function adaptSwatchToBase(color, base) {
  if (!color) return color;
  const cur = swatchFor(base);
  const low = String(color).toLowerCase();
  if (cur.some(([c]) => c.toLowerCase() === low)) return color;
  const other = swatchFor(base === 'light' ? 'dark' : 'light');
  const idx = other.findIndex(([c]) => c.toLowerCase() === low);
  return idx >= 0 ? cur[idx][0] : color;
}

function applyTo(rawTheme, accent, envColor) {
  /* 统一在这里叠元数据覆盖：本函数后面还要用 theme.base 决定
     colorScheme、data-theme-base、首屏防闪的 preload-base ——
     用未覆盖的 theme 会让"改成浅色"之后滚动条与表单控件仍是深色的。 */
  const theme = applyMetaOverride(rawTheme);
  const vars = deriveVars(theme);
  if (accent) {
    vars['--accent'] = accent;
    vars['--accent-glow'] = rgba(accent, theme.base === 'dark' ? 0.32 : 0.22);
  }
  if (envColor) {
    // 环境色不做二次派生：它本身就是"第二个主色"，直接用原值。
    // 注意它只影响 --env-color，不碰 --ok / --running 等状态色 ——
    // 否则把环境色设成红色，就会得到"红色的成功提示"。
    vars['--env-color'] = envColor;
  }

  /* 用户自选背景图。
     ------------------------------------------------------------------
     它**只在主题本身就带背景图时**才生效（见 supportsBgImage）。
     给没有背景图的主题硬塞一张图，会盖掉主题的底色设计，
     而且那些主题的文字/卡片对比度本来就是按纯色底算的 ——
     压上一张图后可能整片看不清，用户只会觉得"这套主题坏了"。 */
  if (supportsBgImage(theme)) {
    const custom = getBgImage();
    if (custom) vars['--bg-image'] = 'url("' + escapeCssUrl(custom) + '")';
    /* 预设背景与自定义图**互斥**：后者优先（它是用户特意挑的图）。
       不互斥的话两个都设了会出现"图上叠渐变"，谁也看不清。 */
    else {
      const preset = findBgPreset(getBgPreset());
      if (preset) vars['--bg-image'] = preset.css;
    }
  }

  const root = document.documentElement;
  for (const k of THEME_VARS) {
    if (vars[k] != null) {
      root.style.setProperty(k, vars[k]);
    } else {
      // 新主题没定义的变量必须**主动清掉**。
      // 只写不删的话，上一套主题的内联值会一直挂在 :root 上：
      // 从定义了 --r-xl:12px 的扁平主题切回新拟态主题，圆角会停在 12px，
      // 因为 CSS 里的 26px 永远被内联样式压住、根本没有机会生效。
      // 清掉后由 css/neumorphism.css 的 :root 兜底。
      root.style.removeProperty(k);
    }
  }

  /* 缓存底色与前景色，供首屏防闪脚本读取。
     这样新增主题时不必再回 index.html 同步一张硬编码表 —— 加主题只需改 themes.js。 */
  try {
    if (vars['--bg']) localStorage.setItem(KEY_PRELOAD_BG, vars['--bg']);
    if (vars['--text']) localStorage.setItem(KEY_PRELOAD_FG, vars['--text']);
    localStorage.setItem(KEY_PRELOAD_BASE, theme.base);
  } catch { /* 存储不可用时忽略 */ }
  root.dataset.theme = theme.id;
  root.dataset.themeBase = theme.base;
  root.dataset.themeStyle = theme.style || 'neumorph';
  /* 叠在 --accent 上的前景色现在是按强调色明暗派生的（黑或白），
     而 SVG data URI **读不到 CSS 变量** —— 勾选标记只能硬编码颜色。
     用这个根属性把"该用黑勾还是白勾"告诉 CSS。
     否则亮色强调色（cyberpunk 的亮黄）上会是一个白勾，对比度 1.09，等于没有。 */
  root.dataset.badgeFg = isDarkish(vars['--badge-fg']) ? 'dark' : 'light';
  // 让浏览器表单控件、滚动条跟随主题
  root.style.colorScheme = theme.base;
  return { ...theme, vars };
}

export function applyTheme(id, accent, envColor, opts = {}) {
  const theme = findTheme(id);
  flashTransition();
  const a = adaptSwatchToBase(accent ?? getAccent(), theme.base);
  const e = adaptSwatchToBase(envColor ?? getEnvColor(), theme.base);
  const applied = applyTo(theme, a, e);
  current = theme;
  try {
    localStorage.setItem(KEY_THEME, theme.id);
    // 存的是适配后的值，保证下次切换仍在当前基调的正确档位上
    if (a) localStorage.setItem(KEY_ACCENT, a);
    else localStorage.removeItem(KEY_ACCENT);
    if (e) localStorage.setItem(KEY_ENV, e);
    else localStorage.removeItem(KEY_ENV);
    // 仅在用户主动选择时打标记，默认主题才能对「没选过的人」继续生效
    if (opts.userInitiated !== false) localStorage.setItem(KEY_USERSET, '1');
  } catch { /* 忽略存储失败 */ }
  listeners.forEach((fn) => {
    try { fn(applied, 'theme'); } catch (er) { console.error('[theme]', er); }
  });
  return applied;
}

/** 只改强调色，保持当前主题 */
export function setAccent(accent) {
  const theme = current || findTheme(getThemeId());
  const a = adaptSwatchToBase(accent, theme.base);
  const applied = applyTo(theme, a, getEnvColor());
  try { localStorage.setItem(KEY_ACCENT, a); } catch {}
  listeners.forEach((fn) => {
    try { fn(applied, 'accent'); } catch (e) { console.error('[theme]', e); }
  });
  return applied;
}

/** 只改环境色，保持当前主题与强调色 */
export function setEnvColor(envColor) {
  const theme = current || findTheme(getThemeId());
  const e = adaptSwatchToBase(envColor, theme.base);
  const applied = applyTo(theme, getAccent(), e);
  try { localStorage.setItem(KEY_ENV, e); } catch {}
  listeners.forEach((fn) => {
    try { fn(applied, 'env-color'); } catch (er) { console.error('[theme]', er); }
  });
  return applied;
}

/**
 * 复位的**通用内核**：清掉某个键，用剩余的自定义值重绘，并通知监听者。
 *
 * 为什么要有它而不用 resetColors 那种「全清 + applyTheme 重来」：
 * 单项复位必须**保留其余项**。若走 applyTheme 会把强调色、环境色、
 * 色相、明暗一股脑全清 —— 用户只想把色相调回 0，结果强调色也没了。
 * 那种「点小按钮却丢了别的设置」比不提供复位更糟。
 *
 * @param {string[]} keys 要清除的存储键
 * @param {string}   kind 通知给监听者的变更类型
 */
function resetOne(keys, kind) {
  try { keys.forEach((k) => localStorage.removeItem(k)); } catch { /* 忽略存储失败 */ }
  const theme = current || findTheme(getThemeId());
  const applied = applyTo(theme, getAccent(), getEnvColor());
  listeners.forEach((fn) => {
    try { fn(applied, kind); } catch (e) { console.error('[theme]', e); }
  });
  return applied;
}

/* ------------------------------ 背景图 ------------------------------ */

const KEY_BG_IMAGE = 'nexus:bg-image';

/**
 * 这套主题**支不支持**背景图。
 *
 * 判据：主题自己就带了 `--bg-image`（渐变）。没带的就是纯色主题 ——
 * 它们的设计语言就是干净底色，压张图上去只会糊。
 *
 * 为什么看主题而不是看「用户设没设」：设置面板要据此决定
 * 是给"选图"入口还是给"🚫 此主题不支持"的占位。
 */
export function supportsBgImage(theme) {
  const t = theme || current || findTheme(getThemeId());
  if (!t) return false;
  /*
   * 玻璃风格**无论主题有没有自带背景渐变**，都允许配背景。
   *
   * 玻璃的观感来自"背后有东西可透"，没有背景的玻璃就是一块实心板。
   * 原先只看主题自带 --bg-image，于是"把新拟态改成玻璃"之后
   * 背景图与预设宫格两块 UI 全部不显示 —— 用户想配都配不了。
   *
   * 其余风格维持原判：给实心面板硬塞一张图会盖掉底色设计，
   * 而那些主题的文字对比度本就是按纯色底算的。
   */
  const style = getStyleOverride(t.id) || t.style;
  if (style === 'glass') return true;
  const v = deriveVars(t)['--bg-image'];
  return !!v && v !== 'none';
}

/** 用户自选的背景图（dataURL 或 URL）；没选过返回空串 */
export function getBgImage() {
  try { return localStorage.getItem(KEY_BG_IMAGE) || ''; } catch { return ''; }
}

/* ------------------------ 预设背景 ------------------------ */
const KEY_BG_PRESET = 'nexus:bg-preset';

/** 当前选中的预设背景 id；没选过返回空串 */
export function getBgPreset() {
  try { return localStorage.getItem(KEY_BG_PRESET) || ''; } catch { return ''; }
}

/**
 * 选一个预设背景。传空串表示不用预设（回到主题自带背景）。
 *
 * 选预设时**清掉自定义图**：两者互斥，留着旧的自定义图会导致
 * 预设永远不生效（applyTo 里自定义图优先），用户点了没反应。
 */
export function setBgPreset(id) {
  if (!supportsBgImage()) return false;
  try {
    if (id) localStorage.setItem(KEY_BG_PRESET, id);
    else localStorage.removeItem(KEY_BG_PRESET);
    if (id) localStorage.removeItem(KEY_BG_IMAGE);
  } catch { /* 存储失败时静默：背景丢了不影响主流程 */ }
  return resetOne([], 'bg-image');
}

/**
 * 转义 CSS url() 里的内容。
 *
 * 为什么必须转：用户的图片路径/URL 里可能含 `"` 或 `\`，
 * 直接拼进 `url("...")` 会**提前闭合字符串**，后面的内容被当成 CSS 规则
 * 解析 —— 轻则背景失效，重则该条声明之后的所有变量都不生效。
 */
function escapeCssUrl(u) {
  return String(u || '').replace(/[\\"]/g, (c) => '\\' + c);
}

/** 设置背景图并立即生效。返回 false 表示主题不支持（调用方应提示） */
export function setBgImage(url) {
  if (!supportsBgImage()) return false;
  try {
    if (url) localStorage.setItem(KEY_BG_IMAGE, url);
    else localStorage.removeItem(KEY_BG_IMAGE);
  } catch { /* 超出配额时静默失败：背景图丢了不影响主流程 */ }
  /* 走 resetOne 的同一条通知链路（kind 用 'bg-image'）：
     它本就负责「用当前值重绘 + 通知监听者」，这里只是值为空。 */
  return resetOne([], 'bg-image');
}

/** 恢复主题自带的背景图 */
export function resetBgImage() {
  /* 预设也要一起清 —— 否则点"恢复默认"后底色变回来了，
     渐变还挂在上面，用户会以为按钮坏了。 */
  try { localStorage.removeItem(KEY_BG_PRESET); } catch {}
  return resetOne([KEY_BG_IMAGE], 'bg-image');
}

/** 只把**强调色**恢复为主题自带（环境色、色相、明暗都保留） */
export function resetAccent() {
  return resetOne([KEY_ACCENT], 'accent');
}

/** 只把**环境色**恢复为主题自带 */
export function resetEnvColor() {
  return resetOne([KEY_ENV], 'env-color');
}

/**
 * 只把**色相**归零（明暗保留）。
 *
 * 走 setThemeShift 而不是直接删键：删键后 getHueShift 会回落到
 * 「旧版全局键」，而那个键可能还留着别的历史值 —— 归零不成反被回填。
 * setThemeShift 写的是当前主题自己的键，语义才干净。
 */
export function resetHueShift() {
  return setThemeShift(0, getLightShift());
}

/** 只把**明暗**归零（色相保留）；理由同上 */
export function resetLightShift() {
  return setThemeShift(getHueShift(), 0);
}

/** 清除自定义的强调色与环境色，回到主题自带配色 */
export function resetColors() {
  const id = current?.id || getThemeId();
  try {
    localStorage.removeItem(KEY_ACCENT);
    localStorage.removeItem(KEY_ENV);
    // 偏移按主题存，这里只清当前这套；旧的全局键一并清掉，避免又被回落读到
    clearShift(id);
    localStorage.removeItem(KEY_HUE);
    localStorage.removeItem(KEY_LIGHT);
  } catch {}
  return applyTheme(getThemeId(), null, null, { userInitiated: true });
}

/** 把当前主题 + 强调色另存为自定义主题 */
export function saveAsCustom(name) {
  const raw = current || findTheme(getThemeId());
  /*
   * 固化元数据覆盖：用户把深色主题改成浅色后保存，新主题必须记成浅色 ——
   * 否则副本一加载就退回深色，白调一场（覆盖是按**原主题 id** 存的，
   * 副本 id 不同，那层覆盖根本读不到）。
   */
  const theme = applyMetaOverride(raw);
  const vars = deriveVars(theme);
  const accent = getAccent();
  if (accent) {
    vars['--accent'] = accent;
    vars['--accent-glow'] = rgba(accent, theme.base === 'dark' ? 0.32 : 0.22);
  }
  const env = getEnvColor();
  if (env) vars['--env-color'] = env;
  const custom = {
    id: 'custom-' + Date.now().toString(36),
    name: name || `${theme.name} 副本`,
    desc: '自定义主题',
    base: theme.base,
    style: theme.style,
    custom: true,
    /* 剔掉派生量再存。
       deriveVars 的结果里混着 --divider / --hairline / --scroll-thumb 这些算出来的值，
       存进去等于把它们钉死：以后改底色，分隔线不会跟着变。
       它们本该每次从 --bg 重算（这也是不给用户改的原因）。 */
    vars: Object.fromEntries(
      Object.entries(vars).filter(([k]) => !DERIVED_VARS.includes(k)),
    ),
  };
  return saveCustomTheme(custom);
}

/* ---------------------------- 订阅 ---------------------------- */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---------------------------- 初始化 ---------------------------- */
export function initTheme() {
  // 参数顺序是 (id, accent, envColor, opts) —— 一旦 applyTheme 再扩参，
  // 这里必须同步，否则 opts 会被当成环境色写进 localStorage。
  return applyTheme(getThemeId(), getAccent(), getEnvColor(), { userInitiated: false });
}

/* 供 iframe 插件同步用：返回扁平的变量表 */
/**
 * 按**指定主题**导出变量（而非当前全局主题）。
 *
 * 用于插件自选主题：某个插件可以指定"整体深色时用 A 套、浅色时用 B 套"，
 * 此时要算的是那套主题的变量，不是全局那套。
 * 走 deriveVars(theme) 而非读 :root，所以那套主题自己的色相/明暗偏移
 * （远端 05b88c6e 起按主题独立存储）也会正确带上。
 *
 * 强调色 / 环境色是用户单独调的两档、与主题独立存储，所以这里同样叠加上去 ——
 * 否则插件自选主题后会丢掉用户调的强调色。
 */
export function exportVarsFor(theme) {
  const vars = deriveVars(theme);
  const accent = getAccent();
  if (accent) {
    vars['--accent'] = accent;
    vars['--accent-glow'] = rgba(accent, theme.base === 'dark' ? 0.32 : 0.22);
  }
  const env = getEnvColor();
  if (env) vars['--env-color'] = env;
  return vars;
}

export function exportVars() {
  return exportVarsFor(current || findTheme(getThemeId()));
}

export { shift, rgba, parseHex, clampAlphaMin };
