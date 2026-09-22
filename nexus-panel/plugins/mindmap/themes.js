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

/* ==================================================================
   预置自定义主题
   ------------------------------------------------------------------
   为什么做成**自定义主题**而不是加进上面的 THEMES：
     THEMES 里每一项的 value 都必须存在于 kityminder-core 的内置主题表
     （core 的 setTheme 靠 `list[name]` 查找）。凭空加一个 value，
     选它会注册失败、画布停在旧配色上 —— 内置表是**第三方库**的，改不了。
   自定义主题则走 registerCustomTheme() 写进同一张表，是官方扩展口。

   配色的一条硬约束（设计这些值时最容易被忽略）：
   ---------------------------------------------------------------
   registerCustomTheme() 内部是
       var bg = s.textColor; ... 'root-color': bg, 'main-color': bg, 'sub-color': bg
   即**三级节点共用同一个文字色**。于是 root / main / sub 三个背景必须落在
   同一明暗侧 —— 只要有一级跨到对面（例如 root 深蓝配浅字、sub 白底），
   同一个文字色必然在某一级上看不清，而这个缺陷只会体现在**那一级**上，
   调色时很容易被当成"这一级颜色没选好"而反复涂改。

   所以这里每个主题都满足：
     · textColor 在 root / main / sub 三处对比度均 ≥ 4.5（实测 5.6~14.5）
     · 层级靠 L* 递进区分（浅色 67/88/100，深色 33/24/15），相邻级差 ≥ 8
     · 连线、选中色对画布底 ≥ 3.0（连线是结构信息，太淡等于没有骨架）
   这些数值由 mm-palette-test 逐项断言，改动会被拦下。

   id 统一用 mm-preset- 前缀：与用户自建主题区分开，
   也避免将来内置主题扩名时撞车。
   ================================================================== */
export const PRESET_THEMES = [
  {
    id: 'mm-preset-mist-blue', name: '晨雾蓝', base: 'light',
    desc: '浅蓝灰画布 · 三级蓝递进，清爽耐看',
    palette: {
      background: '#F5F8FC', textColor: '#1B2A3E',
      selectedColor: '#2F6FBF', connectColor: '#698EB7', connectWidth: 2,
      rootBackground: '#7BA6D6', rootFontSize: 18, rootRadius: 8, rootSpace: 12,
      mainBackground: '#CCDFF3', mainFontSize: 15, mainRadius: 6, mainSpace: 8, mainMargin: 24,
      subBackground: '#FFFFFF', subFontSize: 13, subRadius: 5, subSpace: 6, subMargin: 24,
    },
  },
  {
    id: 'mm-preset-warm-sand', name: '暖砂', base: 'light',
    desc: '暖米画布 · 沙棕递进，纸质温润',
    palette: {
      background: '#FAF7F2', textColor: '#33291F',
      selectedColor: '#B07C3E', connectColor: '#A18663', connectWidth: 2,
      rootBackground: '#BD9E75', rootFontSize: 18, rootRadius: 8, rootSpace: 12,
      mainBackground: '#E6DBC8', mainFontSize: 15, mainRadius: 6, mainSpace: 8, mainMargin: 24,
      subBackground: '#FFFFFF', subFontSize: 13, subRadius: 5, subSpace: 6, subMargin: 24,
    },
  },
  {
    id: 'mm-preset-mint-morning', name: '薄荷晨', base: 'light',
    desc: '浅绿画布 · 薄荷递进，清透不刺眼',
    palette: {
      background: '#F4F9F6', textColor: '#1E2E26',
      selectedColor: '#3E8F6B', connectColor: '#669580', connectWidth: 2,
      rootBackground: '#78AE96', rootFontSize: 18, rootRadius: 8, rootSpace: 12,
      mainBackground: '#C7E3D6', mainFontSize: 15, mainRadius: 6, mainSpace: 8, mainMargin: 24,
      subBackground: '#FFFFFF', subFontSize: 13, subRadius: 5, subSpace: 6, subMargin: 24,
    },
  },
  {
    id: 'mm-preset-deep-ink', name: '深墨', base: 'dark',
    desc: '墨蓝画布 · 节点浮起，长时盯屏不累',
    palette: {
      background: '#141922', textColor: '#E8EDF5',
      selectedColor: '#5B8CFF', connectColor: '#4265B9', connectWidth: 2,
      rootBackground: '#304D82', rootFontSize: 18, rootRadius: 8, rootSpace: 12,
      mainBackground: '#2B3A53', mainFontSize: 15, mainRadius: 6, mainSpace: 8, mainMargin: 24,
      subBackground: '#1D2634', subFontSize: 13, subRadius: 5, subSpace: 6, subMargin: 24,
    },
  },
  {
    id: 'mm-preset-pine-forest', name: '松林', base: 'dark',
    desc: '墨绿画布 · 松针配色，沉静专注',
    palette: {
      background: '#121A16', textColor: '#E6EFE9',
      selectedColor: '#4FA37A', connectColor: '#387356', connectWidth: 2,
      rootBackground: '#2D5643', rootFontSize: 18, rootRadius: 8, rootSpace: 12,
      mainBackground: '#273E31', mainFontSize: 15, mainRadius: 6, mainSpace: 8, mainMargin: 24,
      subBackground: '#1B2821', subFontSize: 13, subRadius: 5, subSpace: 6, subMargin: 24,
    },
  },
  {
    id: 'mm-preset-dusk-violet', name: '暮紫', base: 'dark',
    desc: '紫黑画布 · 暮色递进，适合做创意图',
    palette: {
      background: '#171422', textColor: '#EDE9F5',
      selectedColor: '#8B6FD9', connectColor: '#6F59AD', connectWidth: 2,
      rootBackground: '#52418B', rootFontSize: 18, rootRadius: 8, rootSpace: 12,
      mainBackground: '#3D335C', mainFontSize: 15, mainRadius: 6, mainSpace: 8, mainMargin: 24,
      subBackground: '#292238', subFontSize: 13, subRadius: 5, subSpace: 6, subMargin: 24,
    },
  },
];

/**
 * 把预置主题并进自定义主题列表。
 *
 * 直接 concat 会让**删掉的预置主题下次启动又冒出来** —— 用户删一次不够，
 * 得每次都删，等于删除按钮是坏的。所以 `removed` 里记过的 id 永久跳过。
 *
 * @param {Array} customThemes 用户已存的主题（含其改过的预置主题）
 * @param {string[]} removed 用户删过的预置 id
 * @returns {Array} 合并后的列表；用户同名 id 的以**用户版**为准（可编辑、可保留改动）
 */
export function mergePresetThemes(customThemes = [], removed = []) {
  const list = Array.isArray(customThemes) ? [...customThemes] : [];
  const gone = new Set(removed || []);
  const has = new Set(list.map((t) => t?.id));
  for (const p of PRESET_THEMES) {
    if (gone.has(p.id) || has.has(p.id)) continue;
    // 深拷贝：否则用户编辑预置主题时改的是模块级常量，
    // 刷新后其它文档也跟着变（同一个对象被多处引用）。
    list.push(JSON.parse(JSON.stringify(p)));
  }
  return list;
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
/**
 * CSS 颜色名 → RGB（B6）。
 *
 * 只收了**常见且主题里可能用到**的一小撮，不是完整的 148 个。
 * 为什么不用完整表：这层的目的是兜住「导入的旧主题里写了颜色名」这种情况，
 * 完整表要占 3KB，而绝大多数名字永远不会出现 —— 性价比不划算。
 * 真正需要全覆盖时，浏览器原生解析更准（见 `parseColorWithDom`）。
 */
const NAMED_COLORS = {
  // 刻意**不含** transparent：透明没有 RGB 值，硬映射成黑色会让
  // 「这个色能不能用」的判断失真（colorKind 已单独识别它）。
  black: [0, 0, 0], white: [255, 255, 255],
  red: [255, 0, 0], lime: [0, 255, 0], blue: [0, 0, 255],
  yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
  silver: [192, 192, 192], gray: [128, 128, 128], grey: [128, 128, 128],
  maroon: [128, 0, 0], olive: [128, 128, 0], green: [0, 128, 0],
  purple: [128, 0, 128], teal: [0, 128, 128], navy: [0, 0, 128],
  orange: [255, 165, 0], gold: [255, 215, 0], pink: [255, 192, 203],
  brown: [165, 42, 42], coral: [255, 127, 80], salmon: [250, 128, 114],
  tomato: [255, 99, 71], khaki: [240, 230, 140], lavender: [230, 230, 250],
  beige: [245, 245, 220], ivory: [255, 255, 240], linen: [250, 240, 230],
  snow: [255, 250, 250], azure: [240, 255, 255], mintcream: [245, 255, 250],
  darkred: [139, 0, 0], darkgreen: [0, 100, 0], darkblue: [0, 0, 139],
  lightgray: [211, 211, 211], lightgrey: [211, 211, 211],
  darkgray: [169, 169, 169], darkgrey: [169, 169, 169],
  dimgray: [105, 105, 105], dimgrey: [105, 105, 105],
  whitesmoke: [245, 245, 245], gainsboro: [220, 220, 220],
  steelblue: [70, 130, 180], royalblue: [65, 105, 225],
  dodgerblue: [30, 144, 255], skyblue: [135, 206, 235],
  seagreen: [46, 139, 87], forestgreen: [34, 139, 34],
  firebrick: [178, 34, 34], crimson: [220, 20, 60],
  darkorange: [255, 140, 0], darkgoldenrod: [184, 134, 11],
  slategray: [112, 128, 144], slategrey: [112, 128, 144],
  lightblue: [173, 216, 230], lightgreen: [144, 238, 144],
  lightyellow: [255, 255, 224], lightpink: [255, 182, 193],
  hotpink: [255, 105, 180], deeppink: [255, 20, 147],
  orchid: [218, 112, 214], plum: [221, 160, 221], violet: [238, 130, 238],
  indigo: [75, 0, 130], turquoise: [64, 224, 208],
};

export function parseColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if ( m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  // B6 颜色名（大小写不敏感）
  const named = NAMED_COLORS[s.toLowerCase()];
  return named ? named.slice() : null;
}

const toHex = (rgb) => '#' + rgb.map((n) => clamp255(n).toString(16).padStart(2, '0')).join('');

/** 明暗调节：delta > 0 变亮，< 0 变暗 */
export function shiftColor(color, delta) {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return toHex(rgb.map((n) => clamp255(n + delta)));
}

/** WCAG 相对亮度（0~1），用于算对比度 */
function relLum(color) {
  const rgb = parseColor(color);
  if (!rgb) return 0;
  const f = (n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

/** 两色对比度（1~21） */
export function contrastRatio(a, b) {
  const la = relLum(a), lb = relLum(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 把颜色的感知亮度夹进 [min, max]。
 *
 * 画布不能走到纯白 / 纯黑 —— 两端都没有给"骨架色"留余量：
 * 画布越接近白，浅色节点（fresh 系的 #EEF3F6）越糊；越接近黑，
 * 深色节点越糊。夹到中间区间后，下面派生的描边与文字才有地方可去。
 *
 * 用**加性**偏移而不是按比例缩放：缩放对纯黑无效（0 × k 还是 0），
 * 而纯黑底的暗色主题恰恰是最需要抬起来的那一类。
 */
export function clampLuma(color, min = 38, max = 214) {
  if (!parseColor(color)) return color;
  const l = luma(color);
  if (l >= min && l <= max) return color;
  const dir = l < min ? 1 : -1;
  for (let i = 1; i <= 128; i++) {
    const c = shiftColor(color, dir * i * 2);
    const cl = luma(c);
    if (cl >= min && cl <= max) return c;
  }
  return shiftColor(color, dir * 256);
}

/**
 * 画布表面色：外壳底色的**色相与色温** + 固定的「画布档」亮度。
 *
 * ============================================================
 * 为什么画布不能跟着外壳的明暗走
 * ============================================================
 * 实测 14 套外壳 × 10 个节点主题（取 root / main 与画布的对比度，
 * 两者取小），两种取向的结果天差地别：
 *
 *   画布深色（现在的做法）   最差 2.89   —— 全部可读
 *   画布跟着外壳变浅（旧）   最差 1.08   —— 全部糊在一起
 *
 * 根因不是配色没调好，而是**不可能调好**：
 *   fresh-* 的 main 是 #EEF3F6 这类近白色，snow / classic / fish 的
 *   root 是 #E9DF98 这类浅黄 —— 它们都是**浅色填充**。
 *   画布一旦变浅，浅填充 vs 浅画布的对比度必然趋近 1。
 *
 * 有人说"那就把画布压暗一点、留出差值"：试过（旧实现的 clampLuma
 * 上限 214），浅色外壳 #f4f6fa 被压到 #d4d6da，亮度掉了 26 ——
 * 换来的是一块与界面对不上的脏灰，而对比度仍只有 1.08。
 * 既没解决问题，又制造了新的观感问题。
 *
 * 所以正确的取向是：**画布是一块独立的绘图表面，不是界面的一部分**。
 * 它的亮度固定在"深色画布档"（这是 kityminder 自带的默认，也是
 * Figma / PS 等工具里画布的样子），跟随外壳的是**色相与色温** ——
 * rose-noir 的画布偏暖褐、ocean-deep 偏青、sakura 偏品红。
 * 这样既"跟着主题"，又保证所有节点主题都浮得起来。
 *
 * 饱和度要压（上限 0.16、且只取原饱和的 6 成）：画布是背景，
 * 太艳会跟节点抢注意力。
 */
export function canvasSurface(bg, opts = {}) {
  const rgb = parseColor(bg);
  if (!rgb) return bg;
  const L = opts.lightness ?? 0.20;
  const sMax = opts.saturationMax ?? 0.16;
  const sKeep = opts.saturationKeep ?? 0.6;
  const [h, s] = rgbToHsl(rgb);
  return hslToHex(h, Math.min(s * sKeep, sMax), L);
}

/** RGB(0~255) → HSL，h 为 0~1 */
function rgbToHsl([r0, g0, b0]) {
  const r = r0 / 255, g = g0 / 255, b = b0 / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  if (h < 0) h += 1;
  return [h, s, l];
}

/** HSL(0~1) → hex */
function hslToHex(h, s, l) {
  const hue = ((h % 1) + 1) % 1 * 6;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  let rgb;
  if (hue < 1) rgb = [c, x, 0];
  else if (hue < 2) rgb = [x, c, 0];
  else if (hue < 3) rgb = [0, c, x];
  else if (hue < 4) rgb = [0, x, c];
  else if (hue < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return toHex(rgb.map((n) => clamp255(Math.round((n + m) * 255))));
}

/**
 * 从 base 出发，朝"远离"的方向偏移，直到对比度达标。
 *
 * 只调亮度、不动色相饱和度 —— 与本项目修主题对比度时的一贯做法一致：
 * 这样派生出来的线/文字仍是"同一个色调家族"，不会横空出现一个陌生色。
 */
export function awayFrom(base, ratio = 3) {
  const light = isLightColor(base);
  const dir = light ? -1 : 1;
  for (let i = 1; i <= 64; i++) {
    const c = shiftColor(base, dir * i * 4);
    if (contrastRatio(c, base) >= ratio) return c;
  }
  return light ? '#141418' : '#f2f2f4';
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

  /* 画布底板：外壳的色相 / 色温 + 固定的深色画布档（见 canvasSurface 注释）。
     再沉一档做出「凹进去一块画布」的层次 —— 深浅两端都用同一个偏移，
     不再按基调分叉，避免"凹进去"在深色主题下变成"凸出来"。 */
  const canvasBg = shiftColor(canvasSurface(bg), -5);
  const border = light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.09)';

  /* 画布上的浮层（搜索面板）：比画布浮起一档。
     画布恒为深色档，所以这里不再按外壳基调分叉 —— 统一走"深色上浮起"的偏移。 */
  const panelBg = shiftColor(canvasBg, 11);
  const panelHeadBg = shiftColor(panelBg, 5);
  const panelHover = shiftColor(panelBg, 9);
  const panelCloseHover = shiftColor(panelBg, 14);

  return {
    canvasBg,
    canvasBorder: border,
    panelBg,
    panelHeadBg,
    /* 浮层压在**画布**上，画布恒为深色档 → 文字一律走深色档的浅色值。
       这里若还按外壳基调选，浅色外壳会给出深色文字，压在深色画布上直接消失。 */
    panelText: '#CFCFCF',
    panelDim: '#9A9AA0',
    panelHover,
    panelCloseHover,
    loadingBg: 'rgba(27,27,31,.9)',
    loadingText: '#AFAFAF',
    /* ---- 骨架色：连接线 / 无填充节点文字 / 描边兜底 ----
       派生自画布底色，保证"画布怎么变，骨架都看得见"。
       只提供**兜底值**，是否采用由 criticalOverrides() 判断 ——
       节点主题自带的颜色只要本来就够对比，一律保留不动。 */
    connectColor: awayFrom(canvasBg, 3),
    canvasText: awayFrom(canvasBg, 4.5),
    nodeStroke: awayFrom(canvasBg, 3),
  };
}

/**
 * 判断需要对当前节点主题施加哪些关键色覆盖。
 *
 * 为什么需要这个（而不是无条件改）：
 *   画布底色跟随外壳，节点配色却是**自带主题的固定调色板** ——
 *   两者由不同的人选，必然会出现错配。最典型的是 fresh-* 系列：
 *   main 节点 #EEF3F6 配 white 连接线，在它自己的 #FBFBFB 底上靠
 *   投影区分；一旦画布跟着外壳跑到更浅或更深，连接线与节点边界
 *   就直接消失。
 *
 * 取舍：三种色各自独立判断，**达标的保留原值**。
 *   无条件覆盖会把用户自定义主题（registerCustomTheme）里精心挑的
 *   连接线色也冲掉 —— 那是"为了不出错而牺牲偏好"，过头了。
 *
 * @param {string} canvasBg 画布底色
 * @param {Object} items    内核当前主题项（getThemeItems()）
 * @returns {Object} 需要覆盖的键（空对象表示无需改动）
 */
export function criticalOverrides(canvasBg, items) {
  if (!canvasBg || !items) return {};
  const out = {};

  /* 1) 连接线：在画布上画，必须跟画布比 */
  const cc = items['connect-color'];
  if (!cc || cc === 'none' || !isPaintable(cc) || contrastRatio(cc, canvasBg) < 2.5) {
    out['connect-color'] = awayFrom(canvasBg, 3);
  }

  /* 2) 子节点文字：只有"子节点没填充"时才压在画布上。
        snow / fish 的 sub-background 是 #FFFFFF，文字跟白底比，
        跟画布无关 —— 那种情况下改它反而会破坏原本的可读性。 */
  const subBg = String(items['sub-background'] || '').toLowerCase();
  const subOnCanvas = !subBg || subBg === 'transparent' || subBg === 'none';
  if (subOnCanvas) {
    const sc = items['sub-color'];
    if (!sc || !isPaintable(sc) || contrastRatio(sc, canvasBg) < 3) {
      out['sub-color'] = awayFrom(canvasBg, 4.5);
    }
  }

  /* 3) 描边兜底：节点填充与画布太接近时，补一圈可见边界。
     阈值 1.8 是量出来的，不是拍的：
       fresh root #73A1BF vs 浅色画布 = 1.90  → 够区分，不动
       fresh main #EEF3F6 同底          = 1.30  → 糊，补描边
     再往上抬（比如 2.5）会把本来靠投影就分得清的节点也加上一圈线，
     整张图变得很"框"；再往下压则糊的照样糊。 */
  for (const type of ['root', 'main', 'sub']) {
    const fill = items[type + '-background'];
    const stroke = items[type + '-stroke'];
    if (!fill || !isPaintable(fill)) continue;      // 无填充 → 靠文字，不补描边
    if (contrastRatio(fill, canvasBg) >= 1.8) continue;   // 填充本身够区分
    if (isPaintable(stroke) && contrastRatio(stroke, canvasBg) >= 2.5) continue;
    out[type + '-stroke'] = awayFrom(canvasBg, 3);
  }

  return out;
}

/** 是否可渲染的真实色值（排除 none / transparent / 空） */
function isPaintable(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return false;
  return /^(#|rgb|hsl)/.test(s);
}
