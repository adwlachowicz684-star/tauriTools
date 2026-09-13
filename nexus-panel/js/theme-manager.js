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
    if (vars[k] != null) root.style.setProperty(k, vars[k]);
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
