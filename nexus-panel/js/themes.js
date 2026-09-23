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
 *
 * 排列与书写约定（便于逐行比对，新增主题时照抄即可）：
 *   1. 先按风格分组（新拟态 → 扁平 → 玻璃），组内深色在前、浅色在后
 *   2. 变量按 基底 → 塑形 → 文本 → 主色 → 状态色 → 风格 → 圆角 的顺序写
 *   3. 派生量（--hairline / --mask / --scroll-thumb / --badge-fg / --accent-glow）
 *      由 theme-manager 统一算，主题里不要写
 *   4. 圆角只在需要偏离默认值的风格里写（扁平 / 玻璃），且必须四个一起写 ——
 *      只写一半会让上一主题的内联值残留（见 theme-manager 的清空逻辑）
 *   5. 文本与点缀色的对比度有下限：正文 ≥ 4.5、次级 ≥ 3，
 *      改色值后请跑 `npm run test:theme`
 */

export const THEME_VARS = [
  // 基底：底色 / 背景渐变 / 卡片面 / 凹陷面 / 浮起一档的面
  '--bg', '--bg-image', '--surface', '--surface-sunk',
  // 浮层底面：弹窗 / 吐司 / 下拉这类「盖在别的内容上」的容器专用。
  // 它必须比 --surface 实 —— 底板半透明时，后面的界面会透上来与浮层里的
  // 文字叠在一起，玻璃主题下尤其明显（见 glass 主题里那几个高 alpha 值）。
  '--surface-overlay',
  // 塑形：右下暗、左上亮
  '--sh-dark', '--sh-light',
  // 文本：正文 / 次正文 / 次级 / 最弱
  '--text', '--text-dim', '--text-mute',
  // 环境色（原「主题色」）：与强调色并列的第二个可调主色，只作次要点缀。
  // 状态色（--ok/--running/--warn/--danger）语义固定，不随它变化。
  '--accent', '--env-color', '--accent-glow',
  // 状态色：与装饰色（accent / accent-2）分离，不参与主题色微调。
  // 否则用户把主题色设成红色，就会出现"红色的成功提示"。
  '--ok', '--running', '--warn', '--danger',
  '--surface-raised', '--text-soft',
  /* --divider / --edge 由 theme-manager 按基调**派生**，主题数据里不该填
     （填了就可能又被填成 transparent，失去"保证可见"的作用）。

     但它们**必须留在 THEME_VARS 里**，这是两件不同的事：
       · 不进主题 vars  → 主题数据不能自己填（deriveVars 会无条件覆盖）
       · 进 THEME_VARS  → applyTo 才会把派生值写到 :root 上

     曾因把这两件事混为一谈而漏登记，后果很隐蔽：
     deriveVars 算出了正确值，applyTo 却不写它，实际生效的是
     neumorphism.css 里那条**写死的深色兜底** —— 深色下碰巧一样所以没暴露，
     一切到浅色主题，分隔线与立体描边就全都变成白线、几乎看不见。
     （agent-flow 的输入框边框也接在 --divider 上，一并消失。） */
  '--divider', '--edge',
  '--border', '--blur', '--hairline', '--mask',
  '--scroll-thumb', '--badge-fg',
  // 圆角也是形状语言的一部分：新拟态的大圆角是"软"的一部分，
  // 扁平/Linear 风需要更硬朗的值。未定义的主题回退 CSS 默认值。
  '--r-xl', '--r-lg', '--r-md', '--r-sm',
];

/**
 * style → 中文名。
 *
 * 主题卡片右上角的小角标用它，让"同样是深色"的几套能一眼分出新拟态 / 扁平 / 玻璃。
 * 放在主题数据里而不是各 UI 组件里，是为了让选择器与设置页永远显示同一套叫法。
 */
export const STYLE_LABELS = { neumorph: '新拟态', flat: '扁平', glass: '玻璃' };

/** 取风格的中文名；未知风格（如自定义主题没写 style）返回空串，卡片上就不显示角标 */
export function styleLabel(style) {
  return STYLE_LABELS[style] || '';
}

/* ==================================================================
   风格参数：每种风格特有的可调项
   ------------------------------------------------------------------
   为什么不能共用一套"强度"滑块：
   三种风格靠**完全不同的手段**塑形，可调的东西不是一个维度 ——
     · 玻璃   靠"透"：面板是半透明的，模糊半径决定背景虚化程度
     · 新拟态 靠"凸"：面板与底板同色，全靠双向阴影撑出立体
     · 扁平   靠"勾"：没有立体感，边界由描边勾出来
   给玻璃调"立体度"、给扁平调"透明度"都毫无意义，所以按风格分开定义。

   `affects` 列出该参数要缩放哪些变量 —— **必须是 rgba() 形式**：
   实现是缩放其 alpha 通道，对 #rrggbb 无效（会原样返回）。
   三套主题的 --surface 里，只有 glass 用 rgba，另两套用 hex，
   这正是"透明度只该出现在玻璃风格"的结构性原因。

   默认值 100（%）＝主题自带的原始强度。存的是**倍率**而不是绝对值：
   每套主题的原始 alpha 差异很大（玻璃深色 .07 / 浅色 .55），
   存绝对值会把这个差异抹平，所有玻璃主题变成一个样。

   参数按主题 id 分别存储（见 theme-manager 的 styleKey），
   与色相 / 明暗同理 —— 在 A 主题调好的值不该串到 B 主题上。
   ================================================================== */
export const STYLE_PARAMS = {
  glass: [
    {
      key: 'glass-alpha', label: '玻璃透明度', unit: '%',
      min: 20, max: 260, step: 5,
      /*
       * invert：调高 = 更透。
       * 原先是倍率直接乘 alpha —— 200% 反而把 alpha 翻倍，
       * 于是"透明度"越高面板越实，与标签和描述正好相反。
       * 描述从一开始写的就是"调高更透"，所以错的是实现，不是文案。
       */
      invert: true,
      affects: ['--surface', '--surface-raised', '--surface-sunk'],
      /*
       * 弹框单独一档：只吃一半幅度，并设不透明度地板。
       *
       * 面板透一点是玻璃的观感，弹框透就是灾难 —— 它浮在主面板之上，
       * 底下内容一透出来，弹框里的文字就没法读了。
       * 所以弹框不能和面板同步变透：
       *   · softAffects —— 只吃一半幅度（k' = 1 + (k-1)/2）
       *   · alphaFloor  —— 再怎么调也不低于 0.88
       */
      softAffects: ['--surface-overlay'],
      alphaFloor: 0.88,
      desc: '面板的通透程度。调低更实（内容更清晰），调高更透（背景更明显）。弹框只吃一半幅度，且不会低于 88% 不透明度',
    },
    {
      key: 'glass-blur', label: '模糊强度', unit: 'px',
      min: 0, max: 32, step: 1,
      /* 不是 alpha 缩放，而是直接改 --blur 的长度值（见 applyStyleParams） */
      absolute: true,
      affects: ['--blur'],
      desc: '背景的虚化半径。0 为完全不模糊（等同普通半透明）',
    },
  ],
  neumorph: [
    {
      key: 'relief', label: '立体度', unit: '%',
      min: 0, max: 220, step: 5,
      /* mode='deviation'：缩放阴影色**离底色多远**，而不是缩放 alpha。
         必须如此 —— 新拟态的 --sh-dark/--sh-light 14 套全是**不透明 hex**，
         alpha 缩放对 hex 无效，照 alpha 做这个滑块会完全没反应。 */
      mode: 'deviation',
      affects: ['--sh-dark', '--sh-light'],
      desc: '凸起 / 凹陷的强度。调低趋于扁平，调高更立体',
    },
  ],
  flat: [
    {
      key: 'edge-weight', label: '描边强度', unit: '%',
      min: 0, max: 260, step: 5,
      affects: ['--border'],
      desc: '边界描边的明显程度。调低边界更隐，调高更硬朗',
    },
  ],
};

/** 取某风格的参数列表；未知风格（自定义主题没写 style）返回空数组，设置页就不显示这一节 */
export function styleParams(style) {
  return STYLE_PARAMS[style] || [];
}

export const PRESET_THEMES = [
  /* ---------------- 新拟态 · 深色 ---------------- */
  {
    id: 'neumorph-dark',
    name: '深色新拟态',
    desc: '灰蓝底 · 元素与背景同色，靠双向阴影塑形',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#2b2f36',
      '--surface': '#2b2f36',
      '--surface-sunk': '#282c33',
      '--surface-raised': '#373c45',
      '--sh-dark': '#16181d',
      '--sh-light': '#414855',
      '--text': '#d9dee8',
      '--text-soft': '#bac0cc',
      '--text-dim': '#9198a7',
      '--text-mute': '#737c8a',
      '--accent': '#5b8cff',
      '--env-color': '#48e0c0',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'midnight',
    name: '午夜蓝',
    desc: '深蓝调 · 沉稳耐看，适合长时间盯屏',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#232838',
      '--surface': '#232838',
      '--surface-sunk': '#1f2432',
      '--surface-raised': '#2d3348',
      '--sh-dark': '#0f1119',
      '--sh-light': '#394057',
      '--text': '#cdd4e6',
      '--text-soft': '#aeb6cc',
      '--text-dim': '#8791ac',
      '--text-mute': '#697497',
      '--accent': '#6f9cff',
      '--env-color': '#5ad3c8',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
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
      '--surface-raised': '#3d4045',
      '--sh-dark': '#191b1d',
      '--sh-light': '#484b50',
      '--text': '#e3e5e8',
      '--text-soft': '#c6c9ce',
      '--text-dim': '#9ba0a8',
      '--text-mute': '#7a7f88',
      '--accent': '#7c9fff',
      '--env-color': '#6fd3a8',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'celadon',
    name: '青瓷',
    desc: '墨绿底 · 青瓷釉色，沉静有质感',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#24302c',
      '--surface': '#24302c',
      '--surface-sunk': '#202b27',
      '--surface-raised': '#2e3d38',
      '--sh-dark': '#121816',
      '--sh-light': '#394a42',
      '--text': '#d8e5df',
      '--text-soft': '#b9cbc3',
      '--text-dim': '#8ba398',
      '--text-mute': '#677f72',
      '--accent': '#6fcf97',
      '--env-color': '#a8d8b9',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'amber-dusk',
    name: '暮橙',
    desc: '深褐底 · 琥珀点缀，暖意十足',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#2e2723',
      '--surface': '#2e2723',
      '--surface-sunk': '#2a241f',
      '--surface-raised': '#3b322d',
      '--sh-dark': '#14110f',
      '--sh-light': '#493e37',
      '--text': '#ece2d8',
      '--text-soft': '#d2c6ba',
      '--text-dim': '#ab9c8d',
      '--text-mute': '#817367',
      '--accent': '#ffa94d',
      '--env-color': '#ffd8a8',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'violet-dusk',
    name: '紫暮',
    desc: '深紫底 · 品红点缀，优雅神秘',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#2b2740',
      '--surface': '#2b2740',
      '--surface-sunk': '#272335',
      '--surface-raised': '#373252',
      '--sh-dark': '#14121e',
      '--sh-light': '#433d65',
      '--text': '#e2ddf0',
      '--text-soft': '#c5bfda',
      '--text-dim': '#9a92b8',
      '--text-mute': '#797296',
      '--accent': '#b48cff',
      '--env-color': '#ff8fd0',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'carbon-blue',
    name: '碳晶蓝',
    desc: '冷蓝调 · 编辑器风格，代码与数据友好',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#1f2430',
      '--surface': '#1f2430',
      '--surface-sunk': '#1b202a',
      '--surface-raised': '#282e3d',
      '--sh-dark': '#0a0c10',
      '--sh-light': '#333c4f',
      '--text': '#d4dae6',
      '--text-soft': '#b4bdce',
      '--text-dim': '#8492ab',
      '--text-mute': '#65728b',
      '--accent': '#4d9de0',
      '--env-color': '#56d4c4',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'rose-noir',
    name: '玫瑰黑金',
    desc: '近黑底 · 香槟金配玫瑰，低调奢华',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#1c1618',
      '--surface': '#1c1618',
      '--surface-sunk': '#161113',
      '--surface-raised': '#433c3e',
      '--sh-dark': '#000000',
      '--sh-light': '#362b30',
      '--text': '#f0e4e6',
      '--text-soft': '#d6c7ca',
      '--text-dim': '#b09ba0',
      '--text-mute': '#7d6a70',
      '--accent': '#d4a574',
      '--env-color': '#c97b84',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'ocean-deep',
    name: '深海',
    desc: '深蓝绿 · 天青点缀，通透清凉',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#16262e',
      '--surface': '#16262e',
      '--surface-sunk': '#132227',
      '--surface-raised': '#1c313b',
      '--sh-dark': '#070c0f',
      '--sh-light': '#263f4a',
      '--text': '#d5e6ec',
      '--text-soft': '#b5cbd4',
      '--text-dim': '#84a3b0',
      '--text-mute': '#5b7784',
      '--accent': '#38bdf8',
      '--env-color': '#5eead4',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'cocoa-night',
    name: '可可夜',
    desc: '可可褐底 · 琥珀金点缀，暖调深色',
    base: 'dark',
    style: 'neumorph',
    vars: {
      '--bg': '#33291f',
      '--surface': '#33291f',
      '--surface-sunk': '#2b2119',
      '--surface-raised': '#463a2e',
      /* 暖深色的阴影必须也带暖调：用纯黑会让凸起的边缘泛青 */
      '--sh-dark': '#191309',
      '--sh-light': '#4d4033',
      '--text': '#f2ece1',
      '--text-soft': '#d9cfc0',
      '--text-dim': '#b7aa95',
      '--text-mute': '#8d8271',
      '--accent': '#d4a24a',
      '--env-color': '#8fae5a',
      '--ok': '#8fae5a',
      '--running': '#6fa8dc',
      '--warn': '#e0a94f',
      '--danger': '#e07a5f',
      '--border': 'transparent',
      '--blur': '0px',
      '--r-xl': '18px',
      '--r-lg': '14px',
      '--r-md': '11px',
      '--r-sm': '7px',
    },
  },

  /* ---------------- 新拟态 · 浅色 ---------------- */
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
      '--surface-raised': '#f4f5f8',
      '--sh-dark': '#bdc1cb',
      '--sh-light': '#ffffff',
      '--text': '#3a4050',
      '--text-soft': '#4d5464',
      '--text-dim': '#616778',
      '--text-mute': '#798297',
      '--accent': '#3b6fe0',
      '--env-color': '#10927a',
      '--ok': '#1a9446',
      '--running': '#437de1',
      '--warn': '#b17208',
      '--danger': '#e54141',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'paper',
    name: '宣纸',
    desc: '暖白纸感 · 朱砂点缀，久看不累',
    base: 'light',
    style: 'neumorph',
    vars: {
      '--bg': '#f0ece4',
      '--surface': '#f0ece4',
      '--surface-sunk': '#e7e2d8',
      '--surface-raised': '#f8f6f3',
      '--sh-dark': '#cac4b7',
      '--sh-light': '#ffffff',
      '--text': '#3d3830',
      '--text-soft': '#514b42',
      '--text-dim': '#6e675c',
      '--text-mute': '#8b8374',
      '--accent': '#b8694d',
      '--env-color': '#6b8e5a',
      '--ok': '#1a9446',
      '--running': '#4480e6',
      '--warn': '#b17208',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'mint-morning',
    name: '薄荷晨光',
    desc: '薄荷绿底 · 清爽明亮，不刺眼',
    base: 'light',
    style: 'neumorph',
    vars: {
      '--bg': '#e8f0ec',
      '--surface': '#e8f0ec',
      '--surface-sunk': '#dfe9e3',
      '--surface-raised': '#f5f8f6',
      '--sh-dark': '#b9cbc2',
      '--sh-light': '#ffffff',
      '--text': '#2f4038',
      '--text-soft': '#44574e',
      '--text-dim': '#5b6f65',
      '--text-mute': '#738a7d',
      '--accent': '#1f8f6b',
      '--env-color': '#429474',
      '--ok': '#1a9446',
      '--running': '#4480e6',
      '--warn': '#b87708',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'sakura',
    name: '樱花',
    desc: '淡粉樱色 · 柔和温润',
    base: 'light',
    style: 'neumorph',
    vars: {
      '--bg': '#f5ebee',
      '--surface': '#f5ebee',
      '--surface-sunk': '#ede1e6',
      '--surface-raised': '#faf6f7',
      '--sh-dark': '#d5c1c8',
      '--sh-light': '#ffffff',
      '--text': '#4a3238',
      '--text-soft': '#5e464d',
      '--text-dim': '#7c646b',
      '--text-mute': '#987e87',
      '--accent': '#d63a68',
      '--env-color': '#e64c7a',
      '--ok': '#1a9446',
      '--running': '#4480e6',
      '--warn': '#b87708',
      '--danger': '#ef4444',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'sandstone',
    name: '砂岩',
    desc: '大地色系 · 暖灰里带一点陶土',
    base: 'light',
    style: 'neumorph',
    vars: {
      '--bg': '#e9e4dc',
      '--surface': '#e9e4dc',
      '--surface-sunk': '#e0dad0',
      '--surface-raised': '#f5f3ef',
      '--sh-dark': '#c4bcaf',
      '--sh-light': '#ffffff',
      '--text': '#403a32',
      '--text-soft': '#544d44',
      '--text-dim': '#6b6458',
      '--text-mute': '#887d6b',
      '--accent': '#b0601f',
      '--env-color': '#6b865b',
      '--ok': '#199145',
      '--running': '#437de1',
      '--warn': '#aa6d08',
      '--danger': '#e54141',
      '--border': 'transparent',
      '--blur': '0px',
    },
  },
  {
    id: 'terracotta',
    name: '赤陶',
    desc: '陶土白底 · 赭橙点缀，手作质感',
    base: 'light',
    style: 'neumorph',
    vars: {
      '--bg': '#eadfd3',
      '--surface': '#eadfd3',
      '--surface-sunk': '#e2d5c7',
      '--surface-raised': '#f4eee5',
      /* 阴影取陶土的**暖灰**方向：用中性灰会把暖底压出一块脏斑 */
      '--sh-dark': '#c9b7a2',
      '--sh-light': '#fffdfa',
      '--text': '#3d2f26',
      '--text-soft': '#4f4034',
      '--text-dim': '#6b5b4c',
      '--text-mute': '#877565',
      '--accent': '#8a4a20',
      '--env-color': '#6d7a45',
      '--ok': '#4f7a3f',
      '--running': '#4a7fb5',
      '--warn': '#a87208',
      '--danger': '#b5432f',
      '--border': 'transparent',
      '--blur': '0px',
      '--r-xl': '18px',
      '--r-lg': '14px',
      '--r-md': '11px',
      '--r-sm': '7px',
    },
  },

  /* ---------------- 扁平 ---------------- */
  {
    id: 'oled-flat',
    name: '纯黑扁平',
    desc: 'OLED 纯黑 · 无阴影，靠描边分层',
    base: 'dark',
    style: 'flat',
    vars: {
      '--bg': '#000000',
      '--surface': '#141416',
      '--surface-sunk': '#0c0c0e',
      '--surface-raised': '#3a3a3c',
      '--sh-dark': '#08080a',
      '--sh-light': '#0e0e10',
      '--text': '#e8e8ec',
      '--text-soft': '#c6c6cd',
      '--text-dim': '#94949e',
      '--text-mute': '#65656f',
      '--accent': '#7c8cff',
      '--env-color': '#3ddc97',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'rgba(255,255,255,.09)',
      '--blur': '0px',
      '--r-xl': '12px',
      '--r-lg': '10px',
      '--r-md': '8px',
      '--r-sm': '5px',
    },
  },
  {
    id: 'neon-dark',
    name: '霓虹暗夜',
    desc: '品红配电光青 · 高饱和，科技感强',
    base: 'dark',
    style: 'flat',
    vars: {
      '--bg': '#12121c',
      '--surface': '#1b1b2b',
      '--surface-sunk': '#0e0e16',
      '--surface-raised': '#414153',
      '--sh-dark': '#0c0c14',
      '--sh-light': '#23233a',
      '--text': '#eae6ff',
      '--text-soft': '#cbc5e7',
      '--text-dim': '#9d94c4',
      '--text-mute': '#6d6692',
      '--accent': '#ff2e97',
      '--env-color': '#00e5ff',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'rgba(255,46,151,.16)',
      '--blur': '0px',
      '--r-xl': '12px',
      '--r-lg': '10px',
      '--r-md': '8px',
      '--r-sm': '5px',
    },
  },
  {
    id: 'terminal',
    name: '终端绿',
    desc: 'CRT 荧光绿 · 复古极客味',
    base: 'dark',
    style: 'flat',
    vars: {
      '--bg': '#0d120e',
      '--surface': '#131a15',
      '--surface-sunk': '#090d0a',
      '--surface-raised': '#39403b',
      '--sh-dark': '#070a08',
      '--sh-light': '#161d18',
      '--text': '#6ee78f',
      '--text-soft': '#60ca7d',
      '--text-dim': '#4a9e63',
      '--text-mute': '#37754a',
      '--accent': '#8affc1',
      '--env-color': '#ffd166',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'rgba(110,231,143,.14)',
      '--blur': '0px',
      '--r-xl': '12px',
      '--r-lg': '10px',
      '--r-md': '8px',
      '--r-sm': '5px',
    },
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    desc: '霓虹黄配电光青 · 最高对比度',
    base: 'dark',
    style: 'flat',
    vars: {
      '--bg': '#0f0f1a',
      '--surface': '#171728',
      '--surface-sunk': '#0a0a12',
      '--surface-raised': '#3d3d50',
      '--sh-dark': '#08080f',
      '--sh-light': '#1f1f36',
      '--text': '#f5f0ff',
      '--text-soft': '#d6ceee',
      '--text-dim': '#a89bd4',
      '--text-mute': '#6f6599',
      '--accent': '#f7ff3c',
      '--env-color': '#00fff0',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'rgba(247,255,60,.18)',
      '--blur': '0px',
      '--r-xl': '12px',
      '--r-lg': '10px',
      '--r-md': '8px',
      '--r-sm': '5px',
    },
  },
  {
    id: 'minimal-white',
    name: '极简白',
    desc: '纯白底 · 细描边，接近文档工具观感',
    base: 'light',
    style: 'flat',
    vars: {
      '--bg': '#ffffff',
      '--surface': '#fbfbfc',
      '--surface-sunk': '#f4f4f6',
      '--surface-raised': '#fefeff',
      '--sh-dark': '#ececef',
      '--sh-light': '#f7f7f8',
      '--text': '#2d2d31',
      '--text-soft': '#434349',
      '--text-dim': '#65656e',
      '--text-mute': '#8d8d96',
      '--accent': '#2f6fed',
      '--env-color': '#1da178',
      '--ok': '#1b9d4b',
      '--running': '#4987f5',
      '--warn': '#c07c09',
      '--danger': '#ef4444',
      '--border': 'rgba(0,0,0,.08)',
      '--blur': '0px',
      '--r-xl': '12px',
      '--r-lg': '10px',
      '--r-md': '8px',
      '--r-sm': '5px',
    },
  },

    /* 浅色扁平此前**只有极简白一套**（见"风格 × 基调"分布：
       深色扁平 4 套、浅色扁平 1 套）。纯白底在长时间使用时偏刺眼，
       所以补两套带色温的：一套暖（素笺）、一套冷（晨雾）。

       为什么不直接改极简白：它是对外承诺过的"文档工具观感"，
       改底色等于换了一个主题。补新的比改旧的更安全。 */
    {
      id: 'paper-flat',
      name: '素笺',
      desc: '暖米白 · 扁平，纸质观感',
      base: 'light',
      style: 'flat',
      vars: {
        '--bg': '#f7f6f3',
        '--surface': '#fffefb',
        '--surface-sunk': '#f0eee9',
        '--surface-raised': '#fffefd',
        /* 扁平风格靠明度差分层：阴影色与面色拉开，但不用双向塑形
           （那是新拟态的手法，扁平下会显得脏） */
        '--sh-dark': '#e3e0d9',
        '--sh-light': '#fffef8',
        '--text': '#33322e',
        '--text-soft': '#45443f',
        '--text-dim': '#66645e',
        '--text-mute': '#8b8982',
        '--accent': '#2f6fed',
        '--env-color': '#1da178',
        '--ok': '#1b9d4b',
        '--running': '#4987f5',
        '--warn': '#c07c09',
        '--danger': '#ef4444',
        '--border': 'rgba(0,0,0,.10)',
        '--blur': '0px',
        /* 圆角比极简白再硬一档：纸质偏"印刷品"，太软会失去利落感 */
        '--r-xl': '10px',
        '--r-lg': '8px',
        '--r-md': '6px',
        '--r-sm': '4px',
      },
    },
    {
      id: 'mist-flat',
      name: '晨雾',
      desc: '冷灰白 · 扁平，低饱和',
      base: 'light',
      style: 'flat',
      vars: {
        '--bg': '#f2f4f7',
        '--surface': '#fafbfd',
        '--surface-sunk': '#e9ecf1',
        '--surface-raised': '#fdfeff',
        '--sh-dark': '#dde1e8',
        '--sh-light': '#ffffff',
        '--text': '#2a2f3a',
        '--text-soft': '#3b4150',
        '--text-dim': '#5b6472',
        '--text-mute': '#808794',
        '--accent': '#3b6fe0',
        '--env-color': '#0f8f7a',
        '--ok': '#1b9d4b',
        '--running': '#4987f5',
        '--warn': '#b8800a',
        '--danger': '#e0433c',
        '--border': 'rgba(0,0,0,.09)',
        '--blur': '0px',
        '--r-xl': '10px',
        '--r-lg': '8px',
        '--r-md': '6px',
        '--r-sm': '4px',
      },
    },
    {
      id: 'oat-umber',
      name: '燕麦赭石',
      desc: '燕麦底 · 赤陶点缀，纸质温润',
      base: 'light',
      style: 'flat',
      vars: {
        '--bg': '#f2ede4',
        '--surface': '#faf7f1',
        '--surface-sunk': '#eae2d5',
        '--surface-raised': '#fffdf8',
        /* 扁平靠明度差分层：阴影色与面色拉开，但不用双向塑形
           （那是新拟态的手法，扁平下会显得脏） */
        '--sh-dark': '#dcd3c4',
        '--sh-light': '#fffef9',
        '--text': '#33291f',
        '--text-soft': '#4a3e31',
        '--text-dim': '#6e6355',
        '--text-mute': '#8a8070',
        '--accent': '#a6503c',
        '--env-color': '#77805c',
        '--ok': '#4f7a3f',
        '--running': '#4a7fb5',
        '--warn': '#b08a4a',
        '--danger': '#c2402a',
        /* --border 用可可系细线而不是纯黑：暖纸底上纯黑描边会发灰发脏 */
        '--border': 'rgba(70,58,46,.12)',
        '--blur': '0px',
        /* 圆角比素笺软一档：这一族追求"温润"，太利落会失去纸质手感 */
        '--r-xl': '16px',
        '--r-lg': '12px',
        '--r-md': '9px',
        '--r-sm': '6px',
      },
    },

    {
      id: 'olive-paper',
      name: '橄榄纸',
      desc: '米白纸质 · 橄榄绿主调',
      base: 'light',
      style: 'flat',
      vars: {
        '--bg': '#f1f0e7',
        '--surface': '#fbfbf4',
        '--surface-sunk': '#e8e7db',
        '--surface-raised': '#fdfdf9',
        '--sh-dark': '#d8d7c6',
        '--sh-light': '#fffef9',
        '--text': '#2e3128',
        '--text-soft': '#3f4337',
        '--text-dim': '#5c6052',
        '--text-mute': '#7f8272',
        '--accent': '#6b7a4a',
        '--env-color': '#b08a4a',
        '--ok': '#4f7a3f',
        '--running': '#4a7fb5',
        '--warn': '#b08a4a',
        '--danger': '#b5432f',
        '--border': 'rgba(46,49,40,.11)',
        '--blur': '0px',
        '--r-xl': '14px',
        '--r-lg': '11px',
        '--r-md': '8px',
        '--r-sm': '5px',
      },
    },

  /* ---------------- 玻璃 ---------------- */
  {
    id: 'glass-dark',
    name: '玻璃拟态',
    desc: '半透明毛玻璃 · 背景带极光渐变',
    base: 'dark',
    style: 'glass',
    vars: {
      '--bg': '#1b1f2b',
      '--bg-image': 'radial-gradient(1200px 600px at 12% -10%, #2d3a5c 0%, transparent 60%), radial-gradient(900px 500px at 110% 110%, #4a2a55 0%, transparent 55%)',
      '--surface': 'rgba(36, 41, 57, 0.9)',
      '--surface-sunk': 'rgba(19, 22, 31, 0.94)',
      '--surface-overlay': 'rgba(40, 46, 64, 0.96)',
      '--surface-raised': 'rgba(43, 49, 68, 0.94)',
      '--sh-dark': 'rgba(0,0,0,.34)',
      '--sh-light': 'rgba(255,255,255,.07)',
      '--text': '#eef1f8',
      '--text-soft': '#d2d7e3',
      '--text-dim': '#a8b0c4',
      '--text-mute': '#767e94',
      '--accent': '#7aa2ff',
      '--env-color': '#5fe3d0',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'rgba(255,255,255,.12)',
      '--blur': '14px',
      '--r-xl': '18px',
      '--r-lg': '14px',
      '--r-md': '11px',
      '--r-sm': '7px',
    },
  },
  {
    id: 'glass-light',
    name: '浅色玻璃',
    desc: '白底毛玻璃 · 淡蓝粉光晕',
    base: 'light',
    style: 'glass',
    vars: {
      '--bg': '#eef2f7',
      '--bg-image': 'radial-gradient(1000px 520px at 8% -8%, #cfe0ff 0%, transparent 58%), radial-gradient(820px 460px at 106% 108%, #ffd6e8 0%, transparent 55%)',
      '--surface': 'rgba(247, 249, 252, 0.9)',
      '--surface-sunk': 'rgba(228, 232, 237, 0.94)',
      '--surface-overlay': 'rgba(252, 254, 255, 0.96)',
      '--surface-raised': 'rgba(251, 253, 254, 0.94)',
      '--sh-dark': 'rgba(120,130,150,.22)',
      '--sh-light': 'rgba(255,255,255,.70)',
      '--text': '#2c3242',
      '--text-soft': '#404858',
      '--text-dim': '#5f6878',
      '--text-mute': '#7e889a',
      '--accent': '#3f74e0',
      '--env-color': '#1c9783',
      '--ok': '#1b9d4b',
      '--running': '#4987f5',
      '--warn': '#c07c09',
      '--danger': '#ef4444',
      '--border': 'rgba(255,255,255,.65)',
      '--blur': '16px',
      '--r-xl': '18px',
      '--r-lg': '14px',
      '--r-md': '11px',
      '--r-sm': '7px',
    },
  },
  {
    id: 'glass-aurora',
    name: '极光玻璃',
    desc: '强色彩渐变配毛玻璃 · 视觉冲击最强',
    base: 'dark',
    style: 'glass',
    vars: {
      '--bg': '#141024',
      '--bg-image': 'radial-gradient(900px 520px at 6% -6%, #1e4d8c 0%, transparent 55%), radial-gradient(760px 460px at 100% 6%, #7b2d7d 0%, transparent 52%), radial-gradient(880px 500px at 50% 118%, #0f5f5c 0%, transparent 58%)',
      '--surface': 'rgba(26, 21, 48, 0.9)',
      '--surface-sunk': 'rgba(14, 12, 26, 0.94)',
      '--surface-overlay': 'rgba(30, 24, 54, 0.96)',
      '--surface-raised': 'rgba(32, 25, 57, 0.94)',
      '--sh-dark': 'rgba(0,0,0,.40)',
      '--sh-light': 'rgba(255,255,255,.10)',
      '--text': '#f2eefc',
      '--text-soft': '#d9d3ed',
      '--text-dim': '#b3aad6',
      '--text-mute': '#7f77a8',
      '--accent': '#8ce0ff',
      '--env-color': '#ff9ad5',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': 'rgba(255,255,255,.15)',
      '--blur': '18px',
      '--r-xl': '18px',
      '--r-lg': '14px',
      '--r-md': '11px',
      '--r-sm': '7px',
    },
  },

    /* 浅色玻璃此前只有 glass-light 一套 —— 与浅色扁平是同一个洞。
       两套玻璃都自带渐变背景（--bg-image）：毛玻璃的"透"
       必须透出点什么才有意义，纯色底上开模糊等于没开。 */
    {
      id: 'glass-mint',
      name: '薄荷玻璃',
      desc: '浅薄荷底 · 清透毛玻璃',
      base: 'light',
      style: 'glass',
      vars: {
        '--bg': '#e6f2ee',
        '--bg-image': 'radial-gradient(980px 500px at 10% -6%, #bfe8dc 0%, transparent 58%), radial-gradient(800px 460px at 104% 106%, #cfe6ff 0%, transparent 55%)',
        '--surface': 'rgba(241, 247, 245, 0.9)',
        '--surface-sunk': 'rgba(221, 232, 228, 0.94)',
        '--surface-overlay': 'rgba(248, 252, 251, 0.96)',
        '--surface-raised': 'rgba(245, 249, 248, 0.94)',
        '--sh-dark': 'rgba(90,130,115,.20)',
        '--sh-light': 'rgba(255,255,255,.72)',
        '--text': '#223029',
        '--text-soft': '#35463f',
        '--text-dim': '#556a61',
        '--text-mute': '#71867c',
        '--accent': '#1c8f74',
        '--env-color': '#2f74c8',
        '--ok': '#17874a',
        '--running': '#3d84e8',
        '--warn': '#a87208',
        '--danger': '#d93f38',
        '--border': 'rgba(255,255,255,.62)',
        '--blur': '15px',
        '--r-xl': '18px',
        '--r-lg': '14px',
        '--r-md': '11px',
        '--r-sm': '7px',
      },
    },
    {
      id: 'glass-nebula',
      name: '星云玻璃',
      desc: '深蓝紫底 · 星云光晕配毛玻璃',
      base: 'dark',
      style: 'glass',
      vars: {
        '--bg': '#10131f',
        '--bg-image': 'radial-gradient(1000px 560px at 8% -8%, #2b3f8f 0%, transparent 56%), radial-gradient(760px 480px at 96% 12%, #6b2f8a 0%, transparent 54%), radial-gradient(900px 520px at 44% 116%, #14555e 0%, transparent 58%)',
        '--surface': 'rgba(21, 25, 41, 0.9)',
        '--surface-sunk': 'rgba(12, 14, 22, 0.94)',
        '--surface-overlay': 'rgba(24, 29, 46, 0.96)',
        '--surface-raised': 'rgba(25, 30, 49, 0.94)',
        '--sh-dark': 'rgba(0,0,0,.38)',
        '--sh-light': 'rgba(255,255,255,.09)',
        '--text': '#eef0fa',
        '--text-soft': '#d5d9ec',
        '--text-dim': '#a9b0cc',
        '--text-mute': '#767da0',
        '--accent': '#7fb0ff',
        '--env-color': '#c58cff',
        '--ok': '#22c55e',
        '--running': '#4c8dff',
        '--warn': '#f59e0b',
        '--danger': '#ef4444',
        '--border': 'rgba(255,255,255,.14)',
        '--blur': '16px',
        '--r-xl': '18px',
        '--r-lg': '14px',
        '--r-md': '11px',
        '--r-sm': '7px',
      },
    },
    {
      id: 'glass-amber',
      name: '琥珀玻璃',
      desc: '暖褐底 · 琥珀光晕配毛玻璃',
      base: 'dark',
      style: 'glass',
      vars: {
        '--bg': '#241d16',
        '--bg-image': 'radial-gradient(1000px 540px at 10% -8%, #5a3a1e 0%, transparent 58%), radial-gradient(860px 480px at 104% 110%, #4a2418 0%, transparent 55%)',
        '--surface': 'rgba(48, 38, 29, 0.9)',
        '--surface-sunk': 'rgba(26, 21, 16, 0.94)',
        '--surface-overlay': 'rgba(54, 44, 33, 0.96)',
        '--surface-raised': 'rgba(57, 46, 35, 0.94)',
        '--sh-dark': 'rgba(0,0,0,.38)',
        '--sh-light': 'rgba(255,240,220,.09)',
        '--text': '#f6efe3',
        '--text-soft': '#ddd2be',
        '--text-dim': '#b6a892',
        '--text-mute': '#8a7c68',
        '--accent': '#e0a94f',
        '--env-color': '#8fae5a',
        '--ok': '#8fae5a',
        '--running': '#6fa8dc',
        '--warn': '#e0a94f',
        '--danger': '#e07a5f',
        '--border': 'rgba(255,240,220,.14)',
        '--blur': '16px',
        '--r-xl': '18px',
        '--r-lg': '14px',
        '--r-md': '11px',
        '--r-sm': '7px',
      },
    },

  /* ---------------- 默认 ---------------- */
  {
    id: 'agentflow-dark',
    name: 'Agent Flow 深色',
    desc: 'Linear / Vercel 风 · 扁平，靠明度差分层',
    base: 'dark',
    style: 'flat',
    vars: {
      /*
        这些值与 agent-flow 插件的原生层（--af-native-*）逐像素相同。
        插件在「跟随面板」模式下读取本主题的变量，于是：
            跟随 + Agent Flow 深色  ≡  原生模式
        改动这里任何一个值都会破坏这个等价性 —— 所以本主题刻意
        不参与「文本 / 点缀色对比度微调」，改色前请先想清楚。
      */
      '--bg': '#0f1115',
      '--surface': '#171a21',
      '--surface-sunk': '#12151c',
      '--surface-raised': '#222836',
      '--sh-dark': '#0b0d11',
      '--sh-light': '#13161b',
      '--text': '#e6e9ef',
      '--text-soft': '#c4cbd9',
      '--text-dim': '#8b93a7',
      '--text-mute': '#687285',
      '--accent': '#4c8dff',
      '--env-color': '#22c55e',
      '--ok': '#22c55e',
      '--running': '#4c8dff',
      '--warn': '#f59e0b',
      '--danger': '#ef4444',
      '--border': '#262b36',
      '--blur': '0px',
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

/* ==================================================================
   预设背景
   ------------------------------------------------------------------
   主题自带的 --bg-image 是它设计的一部分（如"极光玻璃"的光晕），
   换掉会失去主题特征 —— 所以预设背景是**用户可选**的叠加项，
   不是修改主题本身。选了就存在本地，恢复默认即可回到主题自带背景。

   为什么做成 CSS 渐变而不是图片文件：
     · 零字节 —— 不占 localStorage（自定义图要转 base64，1.5MB 上限
       正是为了不给存储撑爆，预设若也存图会挤掉其它设置）
     · 随窗口尺寸自适应 —— radial-gradient 用百分比定位，图片会拉伸变形

   每个预设标了 `base`：设置页据此把"明显不适合当前基调"的排在后面，
   但不禁止 —— 深底配浅渐变也是一种风格，用户想试就该能试。
   ================================================================== */
export const BG_PRESETS = [
  {
    id: 'bg-mist', name: '晨雾', base: 'light',
    css: 'radial-gradient(1000px 520px at 12% -8%, #dfe9f5 0%, transparent 60%), radial-gradient(820px 460px at 104% 106%, #f0e4f2 0%, transparent 56%)',
  },
  {
    id: 'bg-dune', name: '沙丘', base: 'light',
    css: 'radial-gradient(1100px 560px at 30% -10%, #f6e7d2 0%, transparent 58%), radial-gradient(900px 480px at 108% 112%, #ecd9c4 0%, transparent 54%)',
  },
  {
    id: 'bg-sakura', name: '樱雪', base: 'light',
    css: 'radial-gradient(960px 500px at 8% -6%, #ffd9e6 0%, transparent 58%), radial-gradient(860px 470px at 102% 108%, #d9ecff 0%, transparent 55%)',
  },
  {
    id: 'bg-mint', name: '薄荷', base: 'light',
    css: 'radial-gradient(980px 500px at 10% -6%, #c8ecdf 0%, transparent 58%), radial-gradient(800px 460px at 104% 106%, #d4e8ff 0%, transparent 55%)',
  },
  {
    id: 'bg-abyss', name: '深海', base: 'dark',
    css: 'radial-gradient(1000px 560px at 10% -10%, #12415c 0%, transparent 58%), radial-gradient(880px 500px at 106% 110%, #0d2a3a 0%, transparent 56%)',
  },
  {
    id: 'bg-aurora', name: '极光', base: 'dark',
    css: 'radial-gradient(900px 520px at 6% -6%, #1e4d8c 0%, transparent 55%), radial-gradient(760px 460px at 100% 6%, #7b2d7d 0%, transparent 52%), radial-gradient(880px 500px at 50% 118%, #0f5f5c 0%, transparent 58%)',
  },
  {
    id: 'bg-starry', name: '星夜', base: 'dark',
    css: 'radial-gradient(1100px 600px at 20% -12%, #232a52 0%, transparent 56%), radial-gradient(900px 500px at 96% 108%, #3a2350 0%, transparent 54%)',
  },
  {
    id: 'bg-ember', name: '余烬', base: 'dark',
    css: 'radial-gradient(1000px 540px at 12% -8%, #5a2418 0%, transparent 56%), radial-gradient(880px 480px at 104% 112%, #3d1c2e 0%, transparent 54%)',
  },
  /* 暖纸质 / 大地色系那一族（燕麦赭石、赤陶、可可夜）专用。
     沙丘偏黄、余烬偏红，这两个补的是"亚麻/陶土"与"焙茶"的空档 ——
     暖色渐变此前只有那两套，配暖纸主题时色相总差一点。 */
  {
    id: 'bg-linen', name: '亚麻', base: 'light',
    css: 'radial-gradient(1060px 540px at 16% -10%, #f4ead9 0%, transparent 58%), radial-gradient(880px 470px at 106% 110%, #e8d6c0 0%, transparent 55%)',
  },
  {
    id: 'bg-hojicha', name: '焙茶', base: 'dark',
    css: 'radial-gradient(1000px 540px at 14% -8%, #4a3a22 0%, transparent 57%), radial-gradient(860px 470px at 102% 110%, #2e2118 0%, transparent 55%)',
  },
];

/** 按 id 取预设背景；取不到返回 null */
export function findBgPreset(id) {
  return BG_PRESETS.find((p) => p.id === id) || null;
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
