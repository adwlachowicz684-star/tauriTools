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
  // 形状语言：新拟态靠大圆角软化，扁平风该更克制。
  // 主题未定义时自动回退 CSS 里的默认值（applyTo 会跳过 null），不影响既有主题。
  '--r-xl', '--r-lg', '--r', '--r-sm',
];

/**
 * 面板默认主题。
 *
 * 设为 Agent Flow 深色，与 agent_flow 插件的观感一致 ——
 * 注意这只是"看起来协调"，插件自身的样式靠 --af-* 前缀变量独立保证，
 * 切到别的主题时 agent_flow 也不会走样。
 */
export const DEFAULT_THEME_ID = 'agentflow-dark';

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
  {
    /**
     * Agent Flow 风格（Linear / Vercel 那一路开发者工具审美）
     *
     * 与其它主题的差别在**分层方式**：
     *   · 新拟态 —— surface 与 bg 同色，靠双向阴影塑形
     *   · 本主题 —— surface 比 bg 亮一档，靠**明度差**分层，阴影隐形
     * 所以这里 --sh-* 被调到紧贴底色（视觉上消失），层次改由
     * --surface 的明度差 + --border 的细描边承担。
     *
     * 配色取自 Tailwind 默认色板：accent=blue-500，accent-2=green-500，
     * warn=amber-500，danger=red-500；背景接近 zinc-950 再压暗一档。
     */
    id: 'agentflow-dark',
    name: 'Agent Flow 深色',
    desc: 'Linear 风 · 蓝灰低饱和，明度分层，久看不累',
    base: 'dark',
    style: 'flat',
    vars: {
      // 背景不用纯黑：#0f1115 是偏蓝的深灰，长时间盯着不刺眼
      '--bg': '#0f1115',
      // 面板比背景亮一档 —— 这是整套观感的核心。
      // 比 Agent Flow 原值(#171a21)略提亮：原比例 1.085 在本面板的分层里偏糊，
      // 提到 1.19 既保留蓝灰调，又能看清面板边界
      '--surface': '#1e222b',
      '--surface-sunk': '#0d1014',
      // 扁平风：阴影紧贴底色 → 视觉隐形，不参与塑形
      '--sh-dark': '#0b0d11',
      '--sh-light': '#13161b',
      '--text': '#e6e9ef',
      '--text-dim': '#8b93a7',
      // 比 Agent Flow 原值(#5f6773)提亮，保证弱化文本仍有 3.3:1 可读
      '--text-mute': '#687285',
      '--accent': '#4c8dff',
      '--accent-2': '#22c55e',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      // 边框极细且低对比：刚好看得见，不抢内容。
      // 比原值(#262b36)提亮一档，因 surface 变亮后原值相对过弱(1.12)
      '--border': '#313846',
      '--blur': '0px',
      // 扁平风用小圆角：新拟态的 26/20/14/9 偏"软"，Linear 一路更硬朗
      '--r-xl': '12px',
      '--r-lg': '10px',
      '--r': '8px',
      '--r-sm': '5px',
    },
  },
];

/** 强调色候选（任何主题下都能单独微调） */
export const ACCENT_SWATCHES = [
  ['#5b8cff', '蓝'], ['#7aa2ff', '天蓝'], ['#48e0c0', '青'],
  ['#3ddc97', '薄荷'], ['#b48cff', '紫'], ['#ff2e97', '品红'],
  ['#ff8f5b', '橙'], ['#ffb454', '琥珀'], ['#ff6b8b', '粉'],
];
