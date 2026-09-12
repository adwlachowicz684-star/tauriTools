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

import { PRESET_THEMES, THEME_VARS, ACCENT_SWATCHES, ACCENT_SWATCHES_LIGHT, DEFAULT_THEME_ID, swatchFor } from './themes.js';

export { ACCENT_SWATCHES, ACCENT_SWATCHES_LIGHT, PRESET_THEMES, THEME_VARS, DEFAULT_THEME_ID };

const KEY_THEME = 'nexus:theme';
const KEY_ACCENT = 'nexus:accent';
/** 主题色（--accent-2）：与强调色并列、可独立微调的第二个主色 */
const KEY_THEME_COLOR = 'nexus:theme-color';
const KEY_CUSTOM = 'nexus:custom-themes';
/** 用户是否手动选过主题；未选过时才允许默认主题升级生效 */
const KEY_USERSET = 'nexus:theme-userset';

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

/* ---------------------------- 派生变量 ---------------------------- */
function deriveVars(theme) {
  const v = { ...theme.vars };
  const dark = theme.base === 'dark';

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

  // 控件浮起底色：主题未显式定义时从 surface 派生（深色上浮，浅色下沉）
  v['--surface-raised'] = v['--surface-raised'] || shift(v['--surface'], dark ? 9 : -7);

  // 卡片内正文：比 text-dim 亮一档（深色）/ 暗一档（浅色）
  v['--text-soft'] = v['--text-soft'] || shift(v['--text-dim'], dark ? 22 : -22);

  // 未定义的兜底
  v['--bg-image'] = v['--bg-image'] || 'none';
  v['--border'] = v['--border'] || 'transparent';
  v['--blur'] = v['--blur'] || '0px';
  v['--warn'] = v['--warn'] || '#ffb454';
  v['--danger'] = v['--danger'] || '#ff6b6b';

  // 圆角兜底：主题未声明时按风格派生。
  // 不能靠 CSS 的 :root 默认值 —— applyTo 只覆写主题已声明的变量，
  // 一旦某个主题漏写，切换主题后圆角会残留上一个主题的值
  // （新增状态色时就踩过一次：7 个主题里 6 个缺 --r-*，圆角卡死在扁平风）。
  const radii = theme.style === 'flat' ? {
    '--r-xl': '12px', '--r-lg': '10px', '--r': '8px', '--r-sm': '5px',
  } : {
    '--r-xl': '26px', '--r-lg': '20px', '--r': '14px', '--r-sm': '9px',
  };
  for (const [k, def] of Object.entries(radii)) v[k] = v[k] || def;

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
  return (
    listThemes().find((t) => t.id === id) ||
    PRESET_THEMES.find((t) => t.id === DEFAULT_THEME_ID) ||
    PRESET_THEMES[0]
  );
}

/* ---------------------------- 状态 ---------------------------- */
let current = null;
const listeners = new Set();

export function getThemeId() {
  try { return localStorage.getItem(KEY_THEME) || DEFAULT_THEME_ID; } catch { return DEFAULT_THEME_ID; }
}
export function getAccent() {
  try { return localStorage.getItem(KEY_ACCENT) || null; } catch { return null; }
}
export function getThemeColor() {
  try { return localStorage.getItem(KEY_THEME_COLOR) || null; } catch { return null; }
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

/* ---------------------------- 应用 ---------------------------- */
/**
 * 让已保存的自定义色跟随面板基调。
 *
 * 场景：在深色主题上选了「青 #48e0c0」，切到浅色主题后色板换成压暗版，
 * 但这个亮青在浅底上对比度只有 1.4 —— 几乎看不见。
 * 于是在切换主题时，若发现存的是"另一套色板里的同款色"，
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

function applyTo(theme, accent, themeColor) {
  const vars = deriveVars(theme);
  if (accent) {
    vars['--accent'] = accent;
    vars['--accent-glow'] = rgba(accent, theme.base === 'dark' ? 0.32 : 0.22);
  }
  if (themeColor) {
    // 主题色不做二次派生：它本身就是"第二个主色"，直接用原值
    vars['--accent-2'] = themeColor;
  }
  const root = document.documentElement;
  for (const k of THEME_VARS) {
    if (vars[k] != null) root.style.setProperty(k, vars[k]);
  }
  root.dataset.theme = theme.id;
  root.dataset.themeBase = theme.base;
  root.dataset.themeStyle = theme.style || 'neumorph';
  // 让浏览器表单控件、滚动条跟随主题
  root.style.colorScheme = theme.base;
  return { ...theme, vars };
}

export function applyTheme(id, accent, themeColor, opts = {}) {
  const theme = findTheme(id);
  flashTransition();
  const a = adaptSwatchToBase(accent ?? getAccent(), theme.base);
  const c2 = adaptSwatchToBase(themeColor ?? getThemeColor(), theme.base);
  const applied = applyTo(theme, a, c2);
  current = theme;
  try {
    localStorage.setItem(KEY_THEME, theme.id);
    // 存的是适配后的值，保证下次切换仍在当前基调的正确档位上
    if (a) localStorage.setItem(KEY_ACCENT, a);
    else localStorage.removeItem(KEY_ACCENT);
    if (c2) localStorage.setItem(KEY_THEME_COLOR, c2);
    else localStorage.removeItem(KEY_THEME_COLOR);
    // 仅在用户主动选择时打标记，默认主题才能对"没选过的人"继续生效
    if (opts.userInitiated !== false) localStorage.setItem(KEY_USERSET, '1');
  } catch { /* 忽略存储失败 */ }
  listeners.forEach((fn) => {
    try { fn(applied, 'theme'); } catch (e) { console.error('[theme]', e); }
  });
  return applied;
}

/** 只改强调色，保持当前主题与主题色 */
export function setAccent(accent) {
  const theme = current || findTheme(getThemeId());
  const applied = applyTo(theme, accent, getThemeColor());
  try { localStorage.setItem(KEY_ACCENT, accent); } catch {}
  listeners.forEach((fn) => {
    try { fn(applied, 'accent'); } catch (e) { console.error('[theme]', e); }
  });
  return applied;
}

/** 只改主题色（第二个主色），保持当前主题与强调色 */
export function setThemeColor(themeColor) {
  const theme = current || findTheme(getThemeId());
  const applied = applyTo(theme, getAccent(), themeColor);
  try { localStorage.setItem(KEY_THEME_COLOR, themeColor); } catch {}
  listeners.forEach((fn) => {
    try { fn(applied, 'theme-color'); } catch (e) { console.error('[theme]', e); }
  });
  return applied;
}

/** 清除自定义色，回到主题自带配色 */
export function resetColors() {
  try {
    localStorage.removeItem(KEY_ACCENT);
    localStorage.removeItem(KEY_THEME_COLOR);
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
  const themeColor = getThemeColor();
  if (themeColor) vars['--accent-2'] = themeColor;
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
/**
 * 初始化。
 *
 * 默认主题升级的关键：老用户 localStorage 里存着旧主题 id，
 * 直接读会永远轮不到新默认。这里对"从未手动选过主题"的用户清掉旧值，
 * 让 DEFAULT_THEME_ID 真正生效；手动选过的则保留其选择。
 */
export function initTheme() {
  try {
    if (localStorage.getItem(KEY_USERSET) !== '1') localStorage.removeItem(KEY_THEME);
  } catch { /* 忽略 */ }
  // 注意参数顺序：applyTheme(id, accent, themeColor, opts)。
  // 这里两个色都传 null，让 applyTheme 内部回退到 getAccent()/getThemeColor() 读存储值。
  const applied = applyTheme(getThemeId(), null, null, { userInitiated: false });
  // 首屏防闪注入的 html{background:...} 已完成使命，交给 CSS 的
  // body{background:var(--bg)} 接管，否则切换主题时底色会卡在首屏那一版
  try {
    document.getElementById('nexus-preload-bg')?.remove();
  } catch { /* 忽略 */ }
  return applied;
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
  const themeColor = getThemeColor();
  if (themeColor) vars['--accent-2'] = themeColor;
  return vars;
}

export { shift, rgba, parseHex };
