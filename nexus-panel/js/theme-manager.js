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
  PRESET_THEMES, THEME_VARS, ACCENT_SWATCHES, ACCENT_SWATCHES_LIGHT,
  DEFAULT_THEME_ID, swatchFor,
} from './themes.js';

export { ACCENT_SWATCHES, ACCENT_SWATCHES_LIGHT, swatchFor, PRESET_THEMES, THEME_VARS };

const KEY_THEME = 'nexus:theme';
const KEY_ACCENT = 'nexus:accent';
// 环境色（原「主题色」）：与强调色并列的第二个可调主色
const KEY_ENV = 'nexus:env-color';
// 用户是否手动选过主题 —— 没选过时默认主题才能继续生效
const KEY_USERSET = 'nexus:theme-userset';
// 主题色调整：在主题自身配色上做整体偏移（色相角度 / 明暗百分比）
const KEY_HUE = 'nexus:hue-shift';
const KEY_LIGHT = 'nexus:light-shift';
const KEY_CUSTOM = 'nexus:custom-themes';
// 首屏防闪用：最近一次应用的底色 / 前景色
const KEY_PRELOAD_BG = 'nexus:preload-bg';
const KEY_PRELOAD_FG = 'nexus:preload-fg';

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

/** 把当前的色相 / 明暗偏移套用到一组变量上（原地改） */
function applyShift(vars) {
  const hue = getHueShift();
  const pct = getLightShift();
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
function deriveVars(theme) {
  const v = { ...theme.vars };
  const dark = theme.base === 'dark';

  // 先偏移基础配色，再做派生计算 —— 这样 scroll-thumb、hairline 之类
  // 由 --bg 派生的量也会跟着一起变，不会出现"底色变了滑块没变"。
  applyShift(v);

  // 强调色辉光
  v['--accent-glow'] = rgba(v['--accent'], dark ? 0.32 : 0.22);

  // 分隔线：深色用微白，浅色用微黑
  v['--hairline'] = dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.07)';

  // 滚动条滑块：比底色略亮（深色）/ 略暗（浅色）
  v['--scroll-thumb'] = shift(v['--bg'], dark ? 16 : -16);

  // 遮罩
  v['--mask'] = dark ? 'rgba(10,12,16,.62)' : 'rgba(90,96,110,.32)';

  // 角标文字
  v['--badge-fg'] = '#ffffff';

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
export function findTheme(id) {
  return listThemes().find((t) => t.id === id) || findTheme(DEFAULT_THEME_ID) || PRESET_THEMES[0];
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

/** 色相偏移，单位度，范围 -180 ~ 180，0 表示不偏移 */
export function getHueShift() {
  try {
    const n = parseInt(localStorage.getItem(KEY_HUE) || '0', 10);
    return isNaN(n) ? 0 : Math.max(-180, Math.min(180, n));
  } catch { return 0; }
}

/** 明暗偏移，单位百分比，范围 -50（压暗）~ 50（提亮），0 表示不偏移 */
export function getLightShift() {
  try {
    const n = parseInt(localStorage.getItem(KEY_LIGHT) || '0', 10);
    return isNaN(n) ? 0 : Math.max(-50, Math.min(50, n));
  } catch { return 0; }
}

/** 同时设置色相与明暗（分开设会触发两次重绘，滑块拖动时会卡顿） */
export function setThemeShift(hue, light) {
  const h = Math.max(-180, Math.min(180, Math.round(Number(hue) || 0)));
  const l = Math.max(-50, Math.min(50, Math.round(Number(light) || 0)));
  try {
    localStorage.setItem(KEY_HUE, String(h));
    localStorage.setItem(KEY_LIGHT, String(l));
  } catch {}
  const theme = current || findTheme(getThemeId());
  const applied = applyTo(theme, getAccent(), getEnvColor());
  listeners.forEach((fn) => {
    try { fn(applied, 'theme-shift'); } catch (e) { console.error('[theme]', e); }
  });
  return applied;
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

function applyTo(theme, accent, envColor) {
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
  } catch { /* 存储不可用时忽略 */ }
  root.dataset.theme = theme.id;
  root.dataset.themeBase = theme.base;
  root.dataset.themeStyle = theme.style || 'neumorph';
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

/** 清除自定义的强调色与环境色，回到主题自带配色 */
export function resetColors() {
  try {
    localStorage.removeItem(KEY_ACCENT);
    localStorage.removeItem(KEY_ENV);
    localStorage.removeItem(KEY_HUE);
    localStorage.removeItem(KEY_LIGHT);
  } catch {}
  return applyTheme(getThemeId(), null, null, { userInitiated: true });
}

/** 把当前主题 + 强调色另存为自定义主题 */
export function saveAsCustom(name) {
  const theme = current || findTheme(getThemeId());
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
    vars,
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
export function exportVars() {
  const theme = current || findTheme(getThemeId());
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

export { shift, rgba, parseHex };
