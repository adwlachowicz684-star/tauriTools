/**
 * 插件样式审计
 * ============================================================
 * 插件是**独立文档**（iframe 各有一份 document），外壳的 CSS 规则到不了那边，
 * 插件只能靠自己引入 + 外壳推送的变量保持观感一致。这条链上任何一环错位，
 * 表现都是"某个主题/某种风格下突然看不清"，而且很难联想到是变量接错了。
 *
 * 本模块把历史上真实踩过的坑固化成可复用的规则，在设置页的插件卡片上
 * 直接报出来，而不是等到某个主题下才发现。
 *
 * 每条规则都注明了**为什么错**和**实际后果**，因为单纯说"不该这么写"
 * 挡不住第二次犯 —— 得让人知道踩下去会碎成什么样。
 *
 * 用法：
 *   const issues = await auditPlugin(manifest);   // 拉 CSS + 跑规则
 *   const issues = auditCss(cssText, fileName);   // 只有文本时
 */

/* ------------------------------------------------------------------
   外壳保证存在的变量
   分三类，因为"不存在"的严重程度不同：
     · 主题推送的：随主题变化，插件必须引用它们才能换肤
     · tokens.css 定义的：尺度令牌，需 @import 才拿得到
     · 主题自己声明的：见 js/themes.js
   ------------------------------------------------------------------ */

/** 主题推送 / 外壳 :root 定义的变量 */
export const SHELL_VARS = [
  // 基底
  '--bg', '--bg-image', '--surface', '--surface-raised', '--surface-sunk',
  '--surface-overlay',
  // 文本
  '--text', '--text-dim', '--text-soft', '--text-mute',
  // 强调与状态
  '--accent', '--accent-glow', '--accent-2', '--env-color',
  '--ok', '--danger', '--warn', '--running', '--info',
  // 立体
  '--sh-dark', '--sh-light',
  // 风格层
  '--border', '--divider', '--blur', '--edge',
  // 派生
  '--hairline', '--mask', '--scroll-thumb', '--badge-fg',
  // 圆角主档
  '--r-xl', '--r-lg', '--r-md', '--r', '--r-sm',
  // 其它
  '--t',
];

/** css/tokens.css 定义的尺度令牌（需 @import 才能拿到） */
export const TOKEN_VARS = [
  '--sh-out-sm', '--sh-out-md', '--sh-out-lg', '--sh-out-xl',
  '--sh-in-xs', '--sh-in-sm', '--sh-in-md', '--sh-in-lg',
  '--sh-cast-xs', '--sh-cast-sm', '--sh-cast-md', '--sh-cast-lg',
  '--glow-sm', '--glow-md',
  '--r-xs', '--r-pill',
  '--relief-edge',
  '--dur-fast', '--dur-base', '--dur-slow',
  '--font-sans', '--font-mono',
  '--z-base', '--z-raised', '--z-sticky', '--z-float', '--z-menu',
  '--z-mask', '--z-dialog', '--z-pop', '--z-toast', '--z-tooltip',
  '--ring-neutral',
  '--z-inspector',
  '--z-picker',   /* 吸管 / 全屏取样遮罩 */
  /* 动画时长：与 --dur-*（一次性过渡）分开的一档，见 tokens.css 的说明 */
  '--anim-spin', '--anim-pulse', '--anim-in',
  /* 字号八档。此前全仓 17 档含 4 个半档（11.5/10.5/12.5/9），
     半档不是设计出来的，收到整数档后维护时不用再记"为什么偏偏是 11.5" */
  '--fs-10', '--fs-11', '--fs-12', '--fs-13',
  '--fs-14', '--fs-15', '--fs-18', '--fs-22', '--fs-30',
  /* 间距节奏：取值来自实际使用频次（2/4/6/8/10/12/14/16/18/20），不是凑整数 */
  '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5',
  '--sp-6', '--sp-7', '--sp-8', '--sp-9', '--sp-10',
  /* 标题三档：字号 + 字重成对。此前各插件各写一套（13/600、12/600+opacity、
     11/大写/字间距），统一后跨外壳与全部插件共用一个尺度。 */
  '--title-1-fs', '--title-1-fw',
  '--title-2-fs', '--title-2-fw',
  '--title-3-fs', '--title-3-fw',
];

/* 控件层（css/controls.css）定义的共享变量。
   --------------------------------------------------------------------
   与 TOKEN_VARS 一样是手工维护的列表 —— style-audit 要在设置页的浏览器
   环境里跑，不能读文件，所以无法像测试那样从 CSS 里反查。

   手工列表会漂移（controls.css 加了新变量、这里忘了同步），所以
   style-audit-test 里有一条断言盯着：controls.css 里定义的 --ctl-*
   必须全部出现在这个列表里。 */
export const CONTROLS_VARS = [
  '--ctl-disabled-opacity', '--ctl-disabled-cursor',
  /* 控件阴影档位。定义在 :root 而不是按钮规则内部 —— 见下。
     **新增变量必须同步登记到这里**：本轮就因为漏登记，把规范的写法
     误报成"变量未定义"（这是同一个坑第三次了）。 */
  '--ctl-shadow', '--ctl-shadow-sm', '--ctl-shadow-press',
];

const KNOWN = new Set([...SHELL_VARS, ...TOKEN_VARS, ...CONTROLS_VARS]);

/* ------------------------------------------------------------------ */

const LEVEL = { error: 'error', warn: 'warn', info: 'info' };

/**
 * 审计一段 CSS。
 *
 * @param {string} css      CSS 文本
 * @param {string} file     仅用于展示的名字
 * @param {object} [opt]    { extraKnown?: string[] } 该文件里另外定义的变量
 * @returns {{level, rule, msg, line}[]}
 */
export function auditCss(css, file = 'styles.css', opt = {}) {
  /* 注释要剥离，但必须**保留原来的换行结构**：把注释内的非换行字符换成空格，
     而不是整块删掉。因为 line 字段是拿去原文件里定位的，而这里的正则都在 text
     上匹配 —— 一旦整块删除，text 的行号坐标就比原文件少了注释占的行，
     报出去的行号会系统性偏小（project-group 的 style.css 曾因此偏 31 行）。
     换成空白同时保证注释里的写法不会被规则误判。 */
  const text = String(css || '').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  const push = (level, rule, msg, i) =>
    out.push({ level, rule, msg, line: i == null ? 0 : lineOf(i), file });

  /* 本文件自己定义的变量（插件私有的 --af-* 之类也算已知） */
  const local = new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  for (const v of opt.extraKnown || []) local.add(v);
  const isKnown = (v) => KNOWN.has(v) || local.has(v);

  const hasTokensImport = /@import\s+url\(['"]?[^'"]*tokens\.css/i.test(text);
  const isShell = /^(css\/)?(neumorphism|tokens)\.css$/.test(file);

  /* ---- E1：风格开关当分隔线 ----
     --border 在新拟态下是 transparent（边界交给阴影）。
     分界两侧往往同色，一透明就没有任何东西托底 —— 实测 agent-flow
     26 处、project-group 2 处分隔线整条消失，面板连成一片。 */
  for (const m of text.matchAll(
    /border-(?:right|left|top|bottom)\s*:\s*([^;]*var\(--border[^;]*);/gi)) {
    push(LEVEL.error, 'border-风格开关',
      '单边分隔线用了 --border（新拟态下透明 → 这条线会消失），应改用 --divider', m.index);
  }

  /* ---- E2：变量未定义且无兜底 ----
     var() 取不到值时该声明直接失效，退回到继承/初始值。
     后果是换主题不跟随，且往往表现为"某个主题下文字突然变亮/变暗"。 */
  const seenUndef = new Set();
  for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/gi)) {
    const v = m[1];
    if (isKnown(v)) continue;
    if (seenUndef.has(v)) continue;              // 同一个变量只报一次
    seenUndef.add(v);
    const withFallback = m[2] === ',';
    push(withFallback ? LEVEL.warn : LEVEL.error,
      withFallback ? 'var-未定义(有兜底)' : 'var-未定义',
      withFallback
        ? `var(${v}) 从未定义，只有兜底值在生效 —— 多半是拼写错误或改名后忘了同步`
        : `var(${v}) 从未定义，这条声明会直接失效（且不跟随主题）`,
      m.index);
  }

  /* ---- E3：立体阴影写死色值 ----
     换主题不跟着变：深色主题下 rgba(0,0,0,.3) 看不见，浅色下又太重。
     描边环 / 辉光 / 单方向投影是合法用法，不算。 */
  for (const m of text.matchAll(/box-shadow\s*:\s*([^;]+);/gi)) {
    const t = m[1].trim();
    if (/var\(--sh-(out|in|cast)/.test(t) || /var\(--af-cast/.test(t)) continue;
    if (/var\(--glow|var\(--accent-glow/.test(t)) continue;
    /* 描边环 / 状态光环：三轴全零 + 无模糊，只是"多画一个圈"，
       不产生明暗，也就不是立体感 —— 颜色写死与否都不影响这一定性。
       状态光环（节点外的 warn/error 圈）刻意保留状态色：
       红色的错误圈不该因为换主题变成蓝色。
       注意别写成 `var\(` 限定：那样写死颜色的环会被漏过来误报。 */
    if (/0 0 0 [\d.]+px /.test(t)) continue;
    if (/^inset 0 0 0 /.test(t) || t === 'none') continue;
    if (/^0 \d+px \d+px var\(--sh-dark\)$/.test(t)) continue;      // 标题栏向下投
    if (/^\d+px 0 \d+px var\(--sh-dark\)$/.test(t)) continue;      // 侧边栏向右投
    if (/^inset [-\d]+px [-\d]+px [-\d]+px var\(--sh-light\)$/.test(t)) continue;
    /* 单轴 + 零模糊 = 用阴影画的**指示条**（页签下方的强调色线、
       错误行左侧的红线）。不是立体感：没有模糊就没有双向明暗，
       只是多画一条线；颜色走变量就会跟着主题变。 */
    if (/^(?:inset )?-?\d+px 0 0 /.test(t)) continue;
    if (/^inset 0 -?\d+px 0 var\(--/.test(t)) continue;
    /* 用 color-mix(in srgb, var(--xx) …) 从主题变量**派生**的阴影。
       看着是"写了个颜色函数"，但它读的是 var(--bg) / var(--text) 等
       主题变量 —— 换主题照样跟着变，所以是合法的。
       纯 rgba(0,0,0,.3) 那种才是真写死。 */
    if (/color-mix\([^)]*var\(--/.test(t)) continue;
    /* 零模糊的**单像素描边环**（色盘游标那类）：它是"给指针加个边"，
       不是立体感 —— 没有模糊就不产生明暗，只是画一圈线。
       这类环的颜色往往必须硬编码：游标叠在任意颜色的色盘上，
       换成主题色会在同色区域整个消失（红区上红描边看不见）。
       属"叠在内容上"，与 .mm-vthumb-play 的白三角同理。 */
    if (/^(?:inset )?0 0 0 1px /.test(t)) continue;
    if (!/rgba?\(|#[0-9a-f]{3,8}\b/i.test(t)) continue;            // 没写死颜色就不管
    push(LEVEL.error, '阴影写死色值',
      `立体阴影里写死了颜色（换主题不会跟着变）：${t.slice(0, 48)}`, m.index);
  }

  if (isShell) return out;      // 以下规则只针对插件

  /* ---- W2：用了令牌却没引入 tokens.css ----
     插件是独立文档，外壳文档里的变量定义传不进去。
     表现是"本地开发好好的，打包后尺度和滚动条全变了"。 */
  const usedTokens = [...new Set(
    [...text.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1])
      .filter((v) => TOKEN_VARS.includes(v)))];
  if (usedTokens.length && !hasTokensImport) {
    push(LEVEL.warn, '缺-tokens-import',
      `用了 ${usedTokens.slice(0, 3).join(' / ')} 等 ${usedTokens.length} 个尺度令牌，`
      + '但没有 @import css/tokens.css —— 插件是独立文档，外壳那份传不进来', 0);
  }

  /* ---- W3：重新定义了主题推送的变量 ----
     会盖掉外壳推过来的值，导致这个插件不跟随换肤。 */
  for (const v of local) {
    if (SHELL_VARS.includes(v)) {
      push(LEVEL.warn, '覆盖主题变量',
        `重新定义了 ${v} —— 会盖掉主题推送的值，这个插件将不跟随换肤`, 0);
    }
  }

  /* ---- I1：硬编码颜色（结构色通常合法，只统计） ---- */
  const hard = [...text.matchAll(
    /(?:^|[;{\s])(?:color|background|background-color|border-color)\s*:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/gi)];
  if (hard.length) {
    push(LEVEL.info, '硬编码颜色',
      `${hard.length} 处写死颜色（节点色板、结构色这类通常是有意为之，`
      + '但若属文字/底板则不跟随换肤）', 0);
  }

  return out;
}

/* ------------------------------------------------------------------
   拉取插件的 CSS
   ------------------------------------------------------------------ */

/**
 * 从插件入口 HTML 里找出样式表地址并拉回来。
 *
 * 走 HTML 而不是猜文件名，是因为 Vite 打包后文件名带 hash
 * （styles.css → assets/index-XXXX.css），只有 HTML 里的 <link> 是准的。
 *
 * @param {object} manifest  插件清单（用 entry）
 * @param {string} [baseUrl] 解析相对路径的基准，默认当前文档
 */
export async function fetchPluginCss(manifest, baseUrl) {
  const entry = manifest?.entry;
  if (!entry || !/\.html$/i.test(entry)) return null;   // module 插件没有独立文档

  /* entry 形如 './plugins/<id>/index.html'，是相对**外壳根目录**的。
     调用方可能跑在两个不同的位置，基准不一样：
       · Vite 模式 —— settings 是 iframe，位于 /plugins/settings/index.html，
         要往上一级才是插件目录的根
       · 无构建模式 —— settings 是 module，直接在主文档（根）里跑
     所以先看自己是不是在 /plugins/<某目录>/ 下，再决定基准。 */
  let url;
  try {
    const base = new URL(baseUrl || location.href);
    const inPluginDir = /\/plugins\/[^/]+\/$/.test(base.pathname);
    const root = inPluginDir ? new URL('../', base).href : new URL('./', base).href;
    const rel = String(entry).replace(/^\.\//, '').replace(/^plugins\//, '');
    url = new URL(rel, root).href;
  } catch { return null; }

  const html = await fetch(url).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  if (!html) return null;

  const hrefs = [...html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)]
    .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1])
    .filter(Boolean);
  if (!hrefs.length) return null;

  const texts = await Promise.all(hrefs.map(async (h) => {
    try {
      const u = new URL(h, url).href;
      const r = await fetch(u);
      return r.ok ? { file: h.split('/').pop(), css: await r.text() } : null;
    } catch { return null; }
  }));
  const got = texts.filter(Boolean);
  return got.length ? got : null;
}

/**
 * 审计一个插件：拉 CSS + 跑规则。
 * 拿不到样式（隔离态 / 未构建 / module 插件）时返回 null，表示"未检测"。
 *
 * @returns {Promise<{issues, files}|null>}
 */
export async function auditPlugin(manifest, baseUrl) {
  const docs = await fetchPluginCss(manifest, baseUrl);
  if (!docs) return null;
  const issues = [];
  for (const d of docs) {
    issues.push(...auditCss(d.css, d.file).map((x) => ({ ...x, file: d.file })));
  }
  return { issues, files: docs.map((d) => d.file) };
}

/**
 * 按严重程度计数。
 *
 * @returns {{error: number, warn: number, info: number, [k: string]: number}}
 *   带索引签名，因为调用方会用动态的 level 字符串去取
 *   （TS 下 c[x.level] 若无索引签名会报 TS7053）。
 */
export function summarize(issues) {
  /** @type {{error: number, warn: number, info: number, [k: string]: number}} */
  const c = { error: 0, warn: 0, info: 0 };
  for (const x of issues || []) c[x.level] = (c[x.level] || 0) + 1;
  return c;
}

/**
 * 排序用的权重。同样是带索引签名的普通对象，
 * 供调用方以 `LEVEL_ORDER[level]` 取值。
 * @type {{error: number, warn: number, info: number, [k: string]: number}}
 */
export const LEVEL_ORDER = { error: 0, warn: 0.5, info: 2 };
LEVEL_ORDER.warn = 1;
