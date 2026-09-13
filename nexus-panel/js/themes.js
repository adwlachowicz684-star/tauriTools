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
  // 环境色（原「主题色」）：与强调色并列的第二个可调主色，只作次要点缀。
  // 状态色（--ok/--running/--warn/--danger）语义固定，不随它变化。
  '--accent', '--env-color', '--accent-glow',
  // 状态色：与装饰色（accent / accent-2）分离，不参与主题色微调。
  // 否则用户把主题色设成红色，就会出现"红色的成功提示"。
  '--ok', '--running', '--warn', '--danger',
  '--surface-raised', '--text-soft',
  '--border', '--blur', '--hairline', '--mask',
  '--scroll-thumb', '--badge-fg',
  // 圆角也是形状语言的一部分：新拟态的大圆角是"软"的一部分，
  // 扁平/Linear 风需要更硬朗的值。未定义的主题回退 CSS 默认值。
  '--r-xl', '--r-lg', '--r-md', '--r-sm',
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
      '--env-color': '#48e0c0',
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
      '--env-color': '#12a88c',
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
      '--env-color': '#5ad3c8',
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
      '--env-color': '#3ddc97',
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
      '--surface-sunk': '#0e0e16',
      '--sh-dark': '#0c0c14',
      '--sh-light': '#23233a',
      '--text': '#eae6ff',
      '--text-dim': '#9d94c4',
      '--text-mute': '#6b6490',
      '--accent': '#ff2e97',
      '--env-color': '#00e5ff',
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
      '--env-color': '#5fe3d0',
      '--border': 'rgba(255,255,255,.12)',
      '--blur': '14px',
    },
  },

  /* ---------------- 深色 · 新拟态 ---------------- */
  {
    id: 'graphite',
    name: '石墨灰',
    desc: '中性深灰 · 不抢戏，长时间盯屏最舒服',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#303236',
      '--surface': '#303236',
      '--surface-sunk': '#2c2e31',
      '--sh-dark': '#222427',
      '--sh-light': '#404347',
      '--text': '#e3e5e8',
      '--text-dim': '#9ba0a8',
      '--text-mute': '#6b7078',
      '--accent': '#7c9fff',
      '--env-color': '#6fd3a8',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'celadon',
    name: '青瓷',
    desc: '深墨绿 + 青瓷釉色，沉静有质感',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#24302c',
      '--surface': '#24302c',
      '--surface-sunk': '#202b27',
      '--sh-dark': '#18211e',
      '--sh-light': '#314039',
      '--text': '#d8e5df',
      '--text-dim': '#8ba398',
      '--text-mute': '#5f7569',
      '--accent': '#6fcf97',
      '--env-color': '#a8d8b9',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'amber-dusk',
    name: '暮橙',
    desc: '深褐底 + 琥珀，暖意十足',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#2e2723',
      '--surface': '#2e2723',
      '--surface-sunk': '#2a241f',
      '--sh-dark': '#1f1a17',
      '--sh-light': '#3d342e',
      '--text': '#ece2d8',
      '--text-dim': '#ab9c8d',
      '--text-mute': '#7a6d61',
      '--accent': '#ffa94d',
      '--env-color': '#ffd8a8',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'violet-dusk',
    name: '紫暮',
    desc: '深紫罗兰 + 品红点缀，优雅神秘',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#2b2740',
      '--surface': '#2b2740',
      '--surface-sunk': '#272335',
      '--sh-dark': '#1d1a2b',
      '--sh-light': '#3a3557',
      '--text': '#e2ddf0',
      '--text-dim': '#9a92b8',
      '--text-mute': '#6d6689',
      '--accent': '#b48cff',
      '--env-color': '#ff8fd0',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'carbon-blue',
    name: '碳晶蓝',
    desc: '编辑器风格冷蓝，代码与数据友好',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#1f2430',
      '--surface': '#1f2430',
      '--surface-sunk': '#1b202a',
      '--sh-dark': '#141821',
      '--sh-light': '#2b3242',
      '--text': '#d4dae6',
      '--text-dim': '#8492ab',
      '--text-mute': '#5c6880',
      '--accent': '#4d9de0',
      '--env-color': '#56d4c4',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'rose-noir',
    name: '玫瑰黑金',
    desc: '黑底 + 香槟金 + 玫瑰，低调奢华',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#1c1618',
      '--surface': '#1c1618',
      '--surface-sunk': '#161113',
      '--sh-dark': '#120d0f',
      '--sh-light': '#2e2529',
      '--text': '#f0e4e6',
      '--text-dim': '#b09ba0',
      '--text-mute': '#7d6a70',
      '--accent': '#d4a574',
      '--env-color': '#c97b84',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'ocean-deep',
    name: '深海',
    desc: '深蓝绿 + 天青，通透清凉',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#16262e',
      '--surface': '#16262e',
      '--surface-sunk': '#132227',
      '--sh-dark': '#0f1a20',
      '--sh-light': '#1f343d',
      '--text': '#d5e6ec',
      '--text-dim': '#84a3b0',
      '--text-mute': '#5b7784',
      '--accent': '#38bdf8',
      '--env-color': '#5eead4',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },

  /* ---------------- 浅色 · 新拟态 ---------------- */
  {
    id: 'paper',
    name: '宣纸',
    desc: '暖白纸感 + 朱砂点，久看不累',
    base: 'light',
    style: 'neumorph',
    vars: {
      '--bg': '#f0ece4',
      '--surface': '#f0ece4',
      '--surface-sunk': '#e7e2d8',
      '--sh-dark': '#d4cfc4',
      '--sh-light': '#faf8f3',
      '--text': '#3d3830',
      '--text-dim': '#6e675c',
      '--text-mute': '#a09a8d',
      '--accent': '#b8694d',
      '--env-color': '#6b8e5a',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'mint-morning',
    name: '薄荷晨光',
    desc: '清爽薄荷绿，明亮不刺眼',
    base: 'light',
    style: 'neumorph',
    vars: {
      '--bg': '#e8f0ec',
      '--surface': '#e8f0ec',
      '--surface-sunk': '#dfe9e3',
      '--sh-dark': '#c8d6cf',
      '--sh-light': '#f5faf8',
      '--text': '#2f4038',
      '--text-dim': '#647a6f',
      '--text-mute': '#96a89e',
      '--accent': '#1f8f6b',
      '--env-color': '#7cc4a8',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'sakura',
    name: '樱花',
    desc: '淡粉樱色，柔和温润',
    base: 'light',
    style: 'neumorph',
    vars: {
      '--bg': '#f5ebee',
      '--surface': '#f5ebee',
      '--surface-sunk': '#ede1e6',
      '--sh-dark': '#ddccd2',
      '--sh-light': '#fbf6f7',
      '--text': '#4a3238',
      '--text-dim': '#7d656c',
      '--text-mute': '#ac979e',
      '--accent': '#d63a68',
      '--env-color': '#f095b0',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'sandstone',
    name: '砂岩',
    desc: '大地色系，暖灰中带一点陶土',
    base: 'light',
    style: 'neumorph',
    vars: {
      '--bg': '#e9e4dc',
      '--surface': '#e9e4dc',
      '--surface-sunk': '#e0dad0',
      '--sh-dark': '#cbc4b8',
      '--sh-light': '#f6f3ee',
      '--text': '#403a32',
      '--text-dim': '#726a5e',
      '--text-mute': '#a39a8b',
      '--accent': '#b0601f',
      '--env-color': '#7d9b6a',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },

  /* ---------------- 扁平 ---------------- */
  {
    id: 'minimal-white',
    name: '极简白',
    desc: '纯白底 + 细描边，接近文档工具观感',
    base: 'light',
    style: 'flat',
    vars: {
      '--bg': '#ffffff',
      '--surface': '#fbfbfc',
      '--surface-sunk': '#f4f4f6',
      '--sh-dark': '#ececef',
      '--sh-light': '#f7f7f8',
      '--text': '#2d2d31',
      '--text-dim': '#65656e',
      '--text-mute': '#9a9aa2',
      '--accent': '#2f6fed',
      '--env-color': '#1fa97f',
      '--border': 'rgba(0,0,0,.08)',
      '--blur': '0px',
    },
  },
  {
    id: 'terminal',
    name: '终端绿',
    desc: '复古 CRT 荧光绿，极客味',
    base: 'dark',
    style: 'flat',
    vars: {
      '--bg': '#0d120e',
      '--surface': '#131a15',
      '--surface-sunk': '#090d0a',
      '--sh-dark': '#070a08',
      '--sh-light': '#161d18',
      '--text': '#6ee78f',
      '--text-dim': '#4a9e63',
      '--text-mute': '#336b44',
      '--accent': '#8affc1',
      '--env-color': '#ffd166',
      '--border': 'rgba(110,231,143,.14)',
      '--blur': '0px',
    },
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    desc: '霓虹黄 + 电光青，最高对比度',
    base: 'dark',
    style: 'flat',
    vars: {
      '--bg': '#0f0f1a',
      '--surface': '#171728',
      '--surface-sunk': '#0a0a12',
      '--sh-dark': '#08080f',
      '--sh-light': '#1f1f36',
      '--text': '#f5f0ff',
      '--text-dim': '#a89bd4',
      '--text-mute': '#6f6599',
      '--accent': '#f7ff3c',
      '--env-color': '#00fff0',
      '--border': 'rgba(247,255,60,.18)',
      '--blur': '0px',
    },
  },

  /* ---------------- 玻璃 ---------------- */
  {
    id: 'glass-light',
    name: '浅色玻璃',
    desc: '白底毛玻璃 + 淡蓝粉光晕',
    base: 'light',
    style: 'glass',
    vars: {
      '--bg': '#eef2f7',
      '--bg-image': 'radial-gradient(1000px 520px at 8% -8%, #cfe0ff 0%, transparent 58%), radial-gradient(820px 460px at 106% 108%, #ffd6e8 0%, transparent 55%)',
      '--surface': 'rgba(255,255,255,.55)',
      '--surface-sunk': 'rgba(0,0,0,.05)',
      '--sh-dark': 'rgba(120,130,150,.22)',
      '--sh-light': 'rgba(255,255,255,.70)',
      '--text': '#2c3242',
      '--text-dim': '#5f6878',
      '--text-mute': '#8d95a5',
      '--accent': '#3f74e0',
      '--env-color': '#1fa892',
      '--border': 'rgba(255,255,255,.65)',
      '--blur': '16px',
    },
  },
  {
    id: 'glass-aurora',
    name: '极光玻璃',
    desc: '强色彩渐变 + 毛玻璃，视觉冲击最强',
    base: 'dark',
    style: 'glass',
    vars: {
      '--bg': '#141024',
      '--bg-image': 'radial-gradient(900px 520px at 6% -6%, #1e4d8c 0%, transparent 55%), radial-gradient(760px 460px at 100% 6%, #7b2d7d 0%, transparent 52%), radial-gradient(880px 500px at 50% 118%, #0f5f5c 0%, transparent 58%)',
      '--surface': 'rgba(255,255,255,.09)',
      '--surface-sunk': 'rgba(0,0,0,.26)',
      '--sh-dark': 'rgba(0,0,0,.40)',
      '--sh-light': 'rgba(255,255,255,.10)',
      '--text': '#f2eefc',
      '--text-dim': '#b3aad6',
      '--text-mute': '#7f77a8',
      '--accent': '#8ce0ff',
      '--env-color': '#ff9ad5',
      '--border': 'rgba(255,255,255,.15)',
      '--blur': '18px',
    },
  },

  {
    id: 'agentflow-dark',
    name: 'Agent Flow 深色',
    desc: 'Linear / Vercel 风 · 扁平，靠明度差分层',
    base: 'dark',
    // flat 会让 neumorphism.css 关掉全部双向阴影，只留 1px 描边
    style: 'flat',
    vars: {
      /*
        这些值与 agent-flow 插件的原生层（--af-native-*）逐像素相同。
        插件在「跟随面板」模式下读取本主题的变量，于是：
            跟随 + Agent Flow 深色  ≡  原生模式
        改动这里任何一个值都会破坏这个等价性。
      */
      '--bg': '#0f1115',
      '--surface': '#171a21',
      '--surface-sunk': '#12151c',
      // 扁平风不需要塑形阴影，调成与底色接近以"隐形"
      '--sh-dark': '#0b0d11',
      '--sh-light': '#13161b',
      '--text': '#e6e9ef',
      '--text-dim': '#8b93a7',
      '--text-mute': '#687285',
      '--text-soft': '#c4cbd9',
      '--accent': '#4c8dff',
      '--env-color': '#22c55e',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--surface-raised': '#222836',
      '--border': '#262b36',
      '--blur': '0px',
      // 圆角比新拟态小一档，配合 flat 才是 Linear 那挂的观感
      '--r-xl': '12px',
      '--r-lg': '10px',
      '--r-md': '8px',
      '--r-sm': '5px',
    },
  },
];

/**
 * 浅色底专用色板。
 *
 * 同一组色值在深底浅底上的表现差异极大：#48e0c0（青）在深色底上
 * 对比度 10.5:1，放到浅色底 #e6e9ef 上只有 1.4:1 —— 基本看不见。
 * 所以浅色底统一压暗 42%，实测全部 ≥ 3.8:1。
 */
function darken(hex, amount) {
  const m = String(hex).match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const h = m[1];
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * (1 - amount))));
  return '#' + [0, 2, 4]
    .map((i) => f(parseInt(h.substr(i, 2), 16)).toString(16).padStart(2, '0'))
    .join('');
}

/** 强调色与环境色共用的候选色板 */
export const ACCENT_SWATCHES = [
  ['#5b8cff', '蓝'], ['#7aa2ff', '天蓝'], ['#48e0c0', '青'],
  ['#3ddc97', '薄荷'], ['#b48cff', '紫'], ['#ff2e97', '品红'],
  ['#ff8f5b', '橙'], ['#ffb454', '琥珀'], ['#ff6b8b', '粉'],
];

export const ACCENT_SWATCHES_LIGHT = ACCENT_SWATCHES.map(([c, l]) => [darken(c, 0.42), l]);

/** 按面板基调取对应色板：深色底用原色，浅色底用压暗版 */
export function swatchFor(base) {
  return base === 'light' ? ACCENT_SWATCHES_LIGHT : ACCENT_SWATCHES;
}

/**
 * 面板默认主题。
 *
 * 设为 Agent Flow 深色：它的变量值与 agent-flow 插件的原生层一致，
 * 因此未手动选过主题的用户打开插件时，观感与插件独立运行时完全相同。
 */
export const DEFAULT_THEME_ID = 'agentflow-dark';
