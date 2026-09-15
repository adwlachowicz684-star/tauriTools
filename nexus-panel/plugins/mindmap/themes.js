/**
 * 思维导图插件 · 主题 / 布局元数据
 * ------------------------------------------------------------
 * 与 C# 侧 KityMinderContract.cs 一一对应（值经 kityminder-core 运行时核验）。
 * 注意：core 另有 -compact / -compat 变体未列出。
 */

/**
 * 内置配色主题：值 / 中文名 / 预览四色（画布底 / 根节点 / 主节点 / 子节点）
 * ============================================================
 * 四色**全部取自 kityminder.core.min.js 的真实主题定义**，不是估的：
 *
 * · fresh-* 系列由 HSL 生成：root = H(h,37%,60%)、main = H(h,33%,95%)、
 *   色相 j = { red:0, soil:25, green:122, blue:204, purple:246, pink:334 }。
 *   下面这六个 root 值就是用该公式算出来的，与原先手填的 `root` 完全一致
 *   （#BF7373 / #BF9373 / #73BF76 / #73A1BF / #7B73BF / #BF7394），可互为校验。
 * · classic / snow / fish 的 main = #a4c5c0、root = #e9df98，直接读自源码。
 * · wire 没有节点背景（stroke:none、只画 #999 的线），故四色都记为 #999999
 *   表示「线条灰」，配合 black 底。
 *
 * `sub` 为 'transparent' 表示子节点无填充（透出画布底色）—— 预览时按 bg
 * 显示并加虚线框标识，不能显示成空白，那会被当成「这一项没有颜色」。
 */
export const THEMES = [
  { value: 'fresh-blue', label: '清新蓝', bg: '#FBFBFB', root: '#73A1BF', main: '#EEF3F6', sub: 'transparent' },
  { value: 'fresh-green', label: '清新绿', bg: '#FBFBFB', root: '#73BF76', main: '#EEF6EE', sub: 'transparent' },
  { value: 'fresh-red', label: '清新红', bg: '#FBFBFB', root: '#BF7373', main: '#F6EEEE', sub: 'transparent' },
  { value: 'fresh-soil', label: '土壤棕', bg: '#FBFBFB', root: '#BF9373', main: '#F6F2EE', sub: 'transparent' },
  { value: 'fresh-purple', label: '清新紫', bg: '#FBFBFB', root: '#7B73BF', main: '#EFEEF6', sub: 'transparent' },
  { value: 'fresh-pink', label: '清新粉', bg: '#FBFBFB', root: '#BF7394', main: '#F6EEF2', sub: 'transparent' },
  { value: 'snow', label: '雪白', bg: '#3A4144', root: '#E9DF98', main: '#A4C5C0', sub: '#FFFFFF' },
  { value: 'classic', label: '经典黄', bg: '#3A4144', root: '#E9DF98', main: '#A4C5C0', sub: 'transparent' },
  { value: 'wire', label: '线框灰', bg: '#000000', root: '#999999', main: '#999999', sub: '#999999' },
  { value: 'fish', label: '青色', bg: '#3A4144', root: '#E9DF98', main: '#A4C5C0', sub: '#FFFFFF' },
];

/** 布局模板：与编辑器【外观】页签模板下拉一致 */
export const LAYOUTS = [
  { value: 'default', label: '思维导图' },
  { value: 'right', label: '逻辑结构图' },
  { value: 'filetree', label: '目录组织图' },
  { value: 'structure', label: '组织结构图' },
  { value: 'fish-bone', label: '鱼骨头图' },
  { value: 'tianpan', label: '天盘图' },
];

export const DEFAULT_THEME = 'fresh-blue';
export const DEFAULT_LAYOUT = 'default';

/**
 * 自定义主题的默认调色板。
 * 键名刻意与 kityminder-core 主题表解耦：编辑器页的 registerCustomTheme() 负责
 * 把这套扁平字段翻译进 core 的主题对象（含默认值兜底）。
 */
export function blankTheme(id, name) {
  return {
    id,
    name: name || '自定义主题',
    palette: {
      background: '#FBFBFB',
      textColor: '#333333',
      selectedColor: '#2B6CB0',
      connectColor: '#4A90D9',
      connectWidth: 2,
      rootBackground: '#4A90D9',
      rootFontSize: 16,
      rootRadius: 5,
      rootSpace: 10,
      mainBackground: '#DCE9F7',
      mainFontSize: 14,
      mainRadius: 3,
      mainSpace: 5,
      mainMargin: 20,
      subBackground: '#FFFFFF',
      subFontSize: 12,
      subRadius: 5,
      subSpace: 5,
      subMargin: 20,
    },
  };
}

/** 主题名 → 是否内置 */
export function isBuiltinTheme(name) {
  return THEMES.some((t) => t.value === name);
}

/**
 * A64 新建主题的种子调色板。
 *
 * 对应 WPF `OnNewThemeClick`（`MindMapPanel.xaml.cs:2859-2900`）：原版**始终**
 * 以当前选中主题为起点 —— 自定义主题直接取它的 palette，内置主题则把主色
 * 映射进 palette 的核心键。Web 版原先永远从 `blankTheme()` 起，等于每次
 * 新建都要从零调 7 个色，实际没人这么用。
 *
 * `sub` 为 'transparent' 表示子节点无填充（透出画布底色）。种子里**不能**
 * 把 'transparent' 直接写进 subBackground —— 那不是一个合法色值，
 * core 解析失败会让整个主题失效。此处回落成画布底色：视觉等价（透出底色
 * 与直接填底色在纯色背景上一致），且是合法值。
 *
 * @param {string} themeValue 当前主题值（内置名或自定义 id）
 * @param {Array} customThemes 自定义主题列表
 * @returns {object} palette
 */
export function themeSeed(themeValue, customThemes = []) {
  const custom = (customThemes || []).find((t) => t.id === themeValue);
  if (custom?.palette) return JSON.parse(JSON.stringify(custom.palette));

  const b = THEMES.find((t) => t.value === themeValue) || THEMES.find((t) => t.value === DEFAULT_THEME);
  const fallbackBg = b.bg;
  return {
    background: b.bg,
    textColor: isLightColor(b.bg) ? '#333333' : '#E8E8E8',
    selectedColor: b.root,
    connectColor: b.root,
    connectWidth: 2,
    rootBackground: b.root,
    rootFontSize: 16,
    rootRadius: 5,
    rootSpace: 10,
    mainBackground: b.main,
    mainFontSize: 14,
    mainRadius: 3,
    mainSpace: 5,
    mainMargin: 20,
    subBackground: b.sub === 'transparent' ? fallbackBg : b.sub,
    subFontSize: 12,
    subRadius: 5,
    subSpace: 5,
    subMargin: 20,
  };
}

/* ------------------------------------------------------------
   导入主题时的 palette 校验（A65 边界收口）
   ------------------------------------------------------------ */

/**
 * 判定一个值是否是能被 core 接受的色值（纯函数，可测）。
 *
 * `parseColor` 认的是 #RGB / #RRGGBB / rgb() / rgba()；
 * 而 `'transparent'` 虽然 CSS 合法，**写进 palette 会让 core 解析失败、
 * 整个主题失效**（A64 里已踩过一次）。所以这里单独放行并交给调用方回落。
 *
 * @returns {'color'|'transparent'|null}
 */
export function colorKind(v) {
  if (typeof v !== 'string') return null;
  if (v.trim().toLowerCase() === 'transparent') return 'transparent';
  return parseColor(v) ? 'color' : null;
}

/** palette 里应当是色值的字段 */
const COLOR_KEYS = [
  'background', 'textColor', 'selectedColor', 'connectColor',
  'rootBackground', 'mainBackground', 'subBackground',
];

/** 各字段的兜底色（非法值时的替代） */
const COLOR_FALLBACK = {
  background: '#FBFBFB',
  textColor: '#333333',
  selectedColor: '#4A90D9',
  connectColor: '#4A90D9',
  rootBackground: '#4A90D9',
  mainBackground: '#DCE9F7',
  subBackground: '#FFFFFF',
};

/**
 * 校验并修复导入的 palette（纯函数，可测）。
 *
 * 为什么必须做：A64（新建主题以当前为种子）里发现 `sub='transparent'`
 * 写进 palette 会让**整个主题失效**，当时在 themeSeed 里做了回落。
 * 但**导入路径完全没有这层校验** —— 同一个坑在两条路径上不对称，
 * 导入一个含非法色值的 JSON 就会静默得到一个坏主题。
 *
 * @param {object} pal 原始 palette
 * @returns {{palette:object, fixed:string[]}} fixed = 被修正的字段名，
 *   供调用方提示用户「哪些值被替换了」——静默改掉用户的东西不说一声不合适。
 */
export function sanitizePalette(pal) {
  const src = (pal && typeof pal === 'object') ? pal : {};
  const out = { ...src };
  const fixed = [];

  for (const k of COLOR_KEYS) {
    const v = src[k];
    if (v === undefined || v === null || v === '') continue;
    // 'transparent' 只对 subBackground 有意义（表示不填充，透出底色），
    // 但 core 不认它 —— 回落到画布底色，视觉效果一致。
    if (colorKind(v) === 'transparent') {
      out[k] = src.background && colorKind(src.background) === 'color'
        ? src.background
        : COLOR_FALLBACK.background;
      fixed.push(k);
      continue;
    }
    if (colorKind(v) !== 'color') {
      out[k] = COLOR_FALLBACK[k] ?? '#FFFFFF';
      fixed.push(k);
    }
  }

  // connectWidth：必须是正数。0 会让连线看不见，负数/NaN 会让 core 直接崩，
  // 而这两种都不会报错 —— 又是一个「静默坏掉」的入口。
  const w = Number(src.connectWidth);
  if (src.connectWidth !== undefined && (!Number.isFinite(w) || w <= 0)) {
    out.connectWidth = 2;
    fixed.push('connectWidth');
  }

  // 字号同理：0 或负数会让文字消失
  for (const k of ['rootFontSize', 'mainFontSize', 'subFontSize']) {
    const n = Number(src[k]);
    if (src[k] !== undefined && (!Number.isFinite(n) || n <= 0)) {
      out[k] = k === 'rootFontSize' ? 16 : (k === 'mainFontSize' ? 14 : 12);
      fixed.push(k);
    }
  }

  return { palette: out, fixed };
}

/* ------------------------------------------------------------
   外壳主题 → 画布配色
   ------------------------------------------------------------
   编辑器页面是独立文档（嵌套 iframe），拿不到外壳注入的 CSS 变量，
   所以由插件层从外壳主题变量派生出一组画布配色，再 postMessage 传进去。
   节点配色仍由 kityminder 主题决定，这里只负责「画布底板 + 画布上的浮层」，
   即：外壳决定明暗，脑图主题决定节点长相。
   ------------------------------------------------------------ */

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));

/** 解析 #RGB / #RRGGBB / rgb() / rgba()，失败返回 null */
export function parseColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if ( m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

const toHex = (rgb) => '#' + rgb.map((n) => clamp255(n).toString(16).padStart(2, '0')).join('');

/** 明暗调节：delta > 0 变亮，< 0 变暗 */
export function shiftColor(color, delta) {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return toHex(rgb.map((n) => clamp255(n + delta)));
}

/** 感知亮度（0-255），用于判断深/浅底 */
export function luma(color) {
  const rgb = parseColor(color);
  if (!rgb) return 0;
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

export const isLightColor = (color) => luma(color) > 140;

/**
 * 由外壳主题变量派生画布配色。
 * @param {Object} vars 外壳下发的 CSS 变量（含 --bg / --surface / --text 等）
 * @returns {Object|null} 画布配色；vars 不可解析时返回 null（编辑器会退回自带默认深色）
 */
export function deriveCanvasTheme(vars) {
  const bg = vars?.['--bg'] || vars?.['--surface'];
  if (!bg) return null;
  const light = isLightColor(bg);

  // 画布底板：比外壳背景略沉一点，做出「凹进去一块画布」的层次
  const canvasBg = shiftColor(bg, light ? -6 : -5);
  const border = light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.09)';

  // 画布上的浮层（搜索面板）：比画布浮起一档
  const panelBg = shiftColor(canvasBg, light ? 6 : 11);
  const panelHeadBg = shiftColor(panelBg, light ? 3 : 5);
  const panelHover = shiftColor(panelBg, light ? -6 : 9);
  const panelCloseHover = shiftColor(panelBg, light ? -10 : 14);

  return {
    canvasBg,
    canvasBorder: border,
    panelBg,
    panelHeadBg,
    panelText: light ? '#2c313c' : '#CFCFCF',
    panelDim: light ? '#6a7183' : '#9A9AA0',
    panelHover,
    panelCloseHover,
    loadingBg: light ? 'rgba(233,236,242,.88)' : 'rgba(27,27,31,.9)',
    loadingText: light ? '#5a6070' : '#AFAFAF',
  };
}
