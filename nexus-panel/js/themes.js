/**
 * 主题预设
 * ============================================================
 * 一套 CSS 不动，只换变量值就能从"新拟态"切到"扁平"或"玻璃"：
 *   · 新拟态 —— --surface 与 --bg 同色，靠 --sh-dark / --sh-light 双向阴影塑形
 *   · 扁平   —— --sh-* 调到与底色几乎同色（阴影隐形），改由 --border 描边
 *   · 玻璃   —— --surface 半透明 + --blur 打开毛玻璃
 * 所以每套主题只需定义下面这组变量。
 *
 * base 字段很关键：它告诉插件适配器"面板现在是深色还是浅色"，
 * 用于判断第三方插件需不需要反转（见 theme-normalizer.js）。
 */

export const THEME_VARS = [
  '--bg', '--bg-image', '--surface', '--surface-sunk',
  '--sh-dark', '--sh-light',
  '--text', '--text-dim', '--text-mute',
  '--accent', '--accent-2', '--accent-glow',
  '--warn', '--danger',
  '--border', '--blur', '--hairline', '--mask',
  '--scroll-thumb', '--badge-fg',
];

export const PRESET_THEMES = [
  {
    id: 'neumorph-dark',
    name: '深色新拟态',
    desc: '默认 · 元素与背景同色，双向阴影塑形',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#2b2f36',
      '--surface': '#2b2f36',
      '--surface-sunk': '#282c33',
      '--sh-dark': '#1d2027',
      '--sh-light': '#383e49',
      '--text': '#d9dee8',
      '--text-dim': '#8b93a2',
      '--text-mute': '#5f6773',
      '--accent': '#5b8cff',
      '--accent-2': '#48e0c0',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'neumorph-light',
    name: '浅色新拟态',
    desc: '米白底 · 同样的立体感，明亮通透',
    base: 'light',
    style: 'neumorph',
    vars: {
      '--bg': '#e6e9ef',
      '--surface': '#e6e9ef',
      '--surface-sunk': '#dfe2e9',
      '--sh-dark': '#c3c7d0',
      '--sh-light': '#f7f9fc',
      '--text': '#3a4050',
      '--text-dim': '#6a7183',
      '--text-mute': '#9aa1b1',
      '--accent': '#3b6fe0',
      '--accent-2': '#12a88c',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'midnight',
    name: '午夜蓝',
    desc: '深蓝调 · 沉稳，适合长时间盯屏',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#232838',
      '--surface': '#232838',
      '--surface-sunk': '#1f2432',
      '--sh-dark': '#171b28',
      '--sh-light': '#2f3548',
      '--text': '#cdd4e6',
      '--text-dim': '#7f89a6',
      '--text-mute': '#5a6382',
      '--accent': '#6f9cff',
      '--accent-2': '#5ad3c8',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'oled-flat',
    name: '纯黑扁平',
    desc: 'OLED 纯黑 · 无阴影，靠描边划分层次',
    base: 'dark',
    style: 'flat',
    vars: {
      '--bg': '#000000',
      '--surface': '#141416',
      '--surface-sunk': '#0c0c0e',
      // 阴影调成与底色接近 → 视觉上"隐形"，于是自动变成扁平风
      '--sh-dark': '#08080a',
      '--sh-light': '#0e0e10',
      '--text': '#e8e8ec',
      '--text-dim': '#94949e',
      '--text-mute': '#5e5e68',
      '--accent': '#7c8cff',
      '--accent-2': '#3ddc97',
      '--border': 'rgba(255,255,255,.09)',
      '--blur': '0px',
    },
  },
  {
    id: 'neon-dark',
    name: '霓虹暗夜',
    desc: '高饱和品红 + 青，科技感强',
    base: 'dark',
    style: 'flat',
    vars: {
      '--bg': '#12121c',
      '--surface': '#1b1b2b',
      '--surface-sunk': '#15151f',
      '--sh-dark': '#0c0c14',
      '--sh-light': '#23233a',
      '--text': '#eae6ff',
      '--text-dim': '#9d94c4',
      '--text-mute': '#6b6490',
      '--accent': '#ff2e97',
      '--accent-2': '#00e5ff',
      '--border': 'rgba(255,46,151,.16)',
      '--blur': '0px',
    },
  },
  {
    id: 'glass-dark',
    name: '玻璃拟态',
    desc: '半透明 + 毛玻璃，背景带极光渐变',
    base: 'dark',
    style: 'glass',
    vars: {
      '--bg': '#1b1f2b',
      '--bg-image': 'radial-gradient(1200px 600px at 12% -10%, #2d3a5c 0%, transparent 60%), radial-gradient(900px 500px at 110% 110%, #4a2a55 0%, transparent 55%)',
      '--surface': 'rgba(255,255,255,.07)',
      '--surface-sunk': 'rgba(0,0,0,.22)',
      '--sh-dark': 'rgba(0,0,0,.34)',
      '--sh-light': 'rgba(255,255,255,.07)',
      '--text': '#eef1f8',
      '--text-dim': '#a8b0c4',
      '--text-mute': '#767e94',
      '--accent': '#7aa2ff',
      '--accent-2': '#5fe3d0',
      '--border': 'rgba(255,255,255,.12)',
      '--blur': '14px',
    },
  },
];

/** 强调色候选（任何主题下都能单独微调） */
export const ACCENT_SWATCHES = [
  ['#5b8cff', '蓝'], ['#7aa2ff', '天蓝'], ['#48e0c0', '青'],
  ['#3ddc97', '薄荷'], ['#b48cff', '紫'], ['#ff2e97', '品红'],
  ['#ff8f5b', '橙'], ['#ffb454', '琥珀'], ['#ff6b8b', '粉'],
];
