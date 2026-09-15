/**
 * 插件主题适配器 (Theme Normalizer)
 * ============================================================
 * 解决的问题：第三方插件是浅色扁平风格，面板是深色新拟态，直接混进来很违和。
 *
 * 三级策略，按侵入性从低到高：
 *   L1 变量注入   —— 把所有主题变量灌给插件（iframe 写进 :root，module 直接继承）
 *                    只有"用了 CSS 变量"的插件才吃这套，零副作用，永远执行
 *   L2 滤镜暗化   —— invert(1) hue-rotate(180deg)，不改布局、不碰 DOM，
 *                    一步把浅色整体翻成深色，且保留原有色彩关系与可读性
 *   L3 色调统一   —— mix-blend-mode: color 覆盖层，把反色后的杂色拉向面板基色，
 *                    解决"翻过来是深色，但不是同一种深色"的问题
 *
 * 图片/视频会被 L2 连带反色，所以对 img/video/canvas/svg 做二次反转还原。
 * ------------------------------------------------------------
 */

/** 反转滤镜：白→黑、黑→白，色相旋转 180° 保持颜色"看起来还是那个颜色" */
export const DARK_FILTER = 'invert(1) hue-rotate(180deg) saturate(1.08) contrast(1.02)';
/** 二次反转，用于还原被误伤的图片 */
export const IMG_FIX_FILTER = 'invert(1) hue-rotate(180deg)';

/** 用户可选的整体策略 */
export const ADAPT_POLICIES = [
  { value: 'auto', label: '自动检测', desc: '采样插件配色，浅色才适配' },
  { value: 'always', label: '总是适配', desc: '不管什么插件都强制深色化' },
  { value: 'never', label: '从不适配', desc: '完全保留插件原始外观' },
];

/** 插件 manifest.theme 可选值：声明插件"自身"是什么主题，帮助跳过检测 */
export const PLUGIN_THEMES = [
  { value: 'auto', label: '自动检测' },
  { value: 'dark', label: '本身深色（不适配）' },
  { value: 'light', label: '本身浅色（需适配）' },
];

/* ---------------------------- 偏好存储 ---------------------------- */
const GLOBAL_KEY = 'nexus:theme-adapt';
const PLUGIN_KEY = (id) => `nexus:theme-adapt:${id}`;

export function getPolicy() {
  try { return localStorage.getItem(GLOBAL_KEY) || 'auto'; } catch { return 'auto'; }
}
export function setPolicy(v) {
  try { localStorage.setItem(GLOBAL_KEY, v); } catch {}
}
export function getPluginOverride(id) {
  try { return localStorage.getItem(PLUGIN_KEY(id)); } catch { return null; }
}
export function setPluginOverride(id, v) {
  try { v ? localStorage.setItem(PLUGIN_KEY(id), v) : localStorage.removeItem(PLUGIN_KEY(id)); } catch {}
}
/** 单插件最终策略：插件级覆盖 > 全局策略 */
export function resolvePolicy(id) {
  return getPluginOverride(id) || getPolicy();
}

/* ---------------------------- 颜色工具 ---------------------------- */
function parseColor(str) {
  if (!str || str === 'transparent') return null;
  const m = String(str).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  const [r, g, b] = p;
  const a = p.length > 3 ? p[3] : 1;
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return { r, g, b, a };
}

/** 感知亮度（Rec.709），0=全黑 1=全白 */
function luminance({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * 采样一个根节点的"视觉亮度"：综合背景色与文字色
 * 背景亮 + 文字暗 => 接近 1（典型浅色主题）
 * 背景暗 + 文字亮 => 接近 0（典型深色主题）
 */
export function sampleBrightness(root, max = 80) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;

  const bgLums = [];
  const fgLums = [];

  const collect = (el) => {
    let cs;
    try { cs = getComputedStyle(el); } catch { return; }
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg.a >= 0.5) bgLums.push(luminance(bg));
    const fg = parseColor(cs.color);
    if (fg && fg.a >= 0.5) fgLums.push(luminance(fg));
  };

  collect(root);
  const nodes = root.querySelectorAll('*');
  for (let i = 0; i < nodes.length && i < max; i++) collect(nodes[i]);

  if (!bgLums.length && !fgLums.length) return null;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const bg = avg(bgLums);
  const fg = avg(fgLums);

  // 两者都有时取"背景为主、文字为辅"；只有文字时（透明背景）反推
  if (bg === null) return fg === null ? null : 1 - fg;
  if (fg === null) return bg;
  return bg * 0.75 + (1 - fg) * 0.25;
}

/** 判定阈值：> 0.55 认为是浅色主题 */
const LIGHT_THRESHOLD = 0.55;
export function isLightTheme(root) {
  const b = sampleBrightness(root);
  return b === null ? false : b > LIGHT_THRESHOLD;
}

/**
 * 等主题切换的过渡动画结束。
 *
 * 过渡期间 `getComputedStyle` 返回的是**动画中间值**，拿它判定基调必定出错：
 * 深色→浅色切到一半时读数是中性灰，会被判成"深色插件"，
 * 于是施加反转；等过渡跑完插件已是浅色，再被反转 → 与主平台正好相反。
 * 这是"连续切换主题和插件后插件深浅反转"的根因。
 */
async function waitThemeSettled(timeout = 700) {
  const t0 = Date.now();
  // 先等 .theme-transition class 摘掉
  while (Date.now() - t0 < timeout) {
    let busy = false;
    try {
      const tm = await import('./theme-manager.js');
      busy = tm.isThemeTransitioning();
    } catch { busy = false; }
    if (!busy) break;
    await sleep(60);
  }
  // 再给一帧，确保样式已按最终值重算
  await sleep(50);
}

/** 连续采样直到读数稳定，避免读到过渡残影 */
async function stableSample(getRoot, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = getRoot();
    const b = r ? sampleBrightness(r) : null;
    if (b !== null) {
      if (last !== null && Math.abs(b - last) < 0.02) return b;   // 稳定了
      last = b;
    }
    if (i < tries - 1) await sleep(90);
  }
  return last;
}

/* ---------------------------- 样式注入 ---------------------------- */
function imgFixCss() {
  return `
    img, video, canvas, svg, picture, iframe,
    [data-nexus-no-invert] {
      filter: ${IMG_FIX_FILTER} !important;
    }`;
}

function injectStyle(target, css, id) {
  if (!target) return () => {};
  try {
    const existing = target.getElementById?.(id);
    if (existing) { existing.remove(); }
    const s = target.createElement ? target.createElement('style') : document.createElement('style');
    s.id = id;
    s.textContent = css;
    (target.head || target).appendChild(s);
    return () => s.remove();
  } catch { return () => {}; }
}

/* ---------------------------- 主入口 ---------------------------- */

/**
 * 挂载后调用，返回 teardown。
 * @param {object}   o
 * @param {object}   o.manifest   插件清单（读 theme 字段）
 * @param {Element}  o.wrap       外层容器（position:relative），overlay 挂这里
 * @param {Element}  o.target     被施加滤镜的元素（module=插件容器 / iframe=iframe 本身）
 * @param {Element}  o.root       插件真实内容根（用于采样；iframe 时为 contentDocument.body）
 * @param {Document} o.doc        插件文档（module=document / iframe=contentDocument）
 * @param {boolean}  o.isIframe
 */
export async function installAdapter(o) {
  const { manifest, wrap, target, isIframe, onInfo } = o;
  const policy = resolvePolicy(manifest.id);

  if (policy === 'never') {
    onInfo?.({ adapted: false, reason: 'policy-never' });
    return () => {};
  }

  // 面板当前基调：深色面板要"暗化"浅色插件，浅色面板要"亮化"深色插件，
  // 两者用的是同一个滤镜，所以只需比较基调是否一致。
  //
  // 可由调用方显式指定（o.panelBase）：插件自选了主题后，它看到的面板基调
  // 是自己那套的、而非全局的。宿主侧用 baseForPlugin() 算好传进来；
  // 不传则回退全局基调（老调用方行为不变）。
  let panelBase = 'dark';
  if (o.panelBase) {
    panelBase = o.panelBase;
  } else {
    try {
      const tm = await import('./theme-manager.js');
      panelBase = tm.getBase();
    } catch { /* 主题模块不可用时按深色处理 */ }
  }

  // 等插件把内容渲染出来再采样（异步插件可能慢一拍）
  const getRoot = () => {
    if (isIframe) {
      try { return target.contentDocument?.body || null; } catch { return null; }
    }
    return o.root || o.target;
  };

  // 判定插件自身基调：'light' | 'dark'
  let pluginBase;
  let baseSource = 'sampled';
  if (policy === 'always') {
    pluginBase = panelBase === 'dark' ? 'light' : 'dark';   // 强制取反，保证一定反转
    baseSource = 'policy';
  } else if (manifest.theme === 'light' || manifest.theme === 'dark') {
    pluginBase = manifest.theme;
    baseSource = 'manifest';
  } else if (o.reportedBase === 'light' || o.reportedBase === 'dark') {
    /* 隔离插件：外壳读不到 contentDocument，由插件自己采样后上报。
       没有这一步的话，隔离插件的采样会静默失败 → 被当成"基调一致" → 不反转，
       于是在深色面板上留下一块刺眼的白，且不报任何错。 */
    pluginBase = o.reportedBase;
    baseSource = 'reported';
  } else {
    /* 走自动检测。
       两道保险，缺一不可：
         1) 等主题过渡结束 —— 否则读到动画中间色，必然误判
         2) 连续采样直到稳定 —— 挡住个别插件自己的入场/异步渲染动画 */
    await waitThemeSettled();
    let b = null;
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 120 : 260);
      const r = getRoot();
      if (!r) continue;
      b = await stableSample(() => getRoot());
      if (b !== null) pluginBase = b > LIGHT_THRESHOLD ? 'light' : 'dark';
      if (r.children?.length || i === 3) break;
    }
    if (!pluginBase) {
      pluginBase = panelBase;                                // 采样失败：视为与面板一致，不反转
      baseSource = 'fallback';
    }
  }

  // 基调一致 → 只做色调统一，不反转
  if (pluginBase === panelBase) {
    onInfo?.({ adapted: false, reason: 'base-match', pluginBase, panelBase, baseSource });
    return () => {};
  }

  /* ---- L2：滤镜暗化 ----
     先清一遍再施加：让 installAdapter 对同一 target 幂等。
     否则重复/并发调用（快速连点主题）会层层叠加滤镜与覆盖层。 */
  try {
    target.style.filter = '';
    target.classList?.remove('nexus-adapted');
    wrap?.querySelectorAll?.('.nexus-tone-overlay').forEach((o) => o.remove());
  } catch { /* DOM 可能已销毁 */ }

  target.style.filter = DARK_FILTER;
  target.classList?.add('nexus-adapted');

  /* ---- 图片二次反转还原 ---- */
  let removeImgFix = () => {};
  const applyImgFix = () => {
    const doc = isIframe ? safeDoc(target) : document;
    removeImgFix = injectStyle(doc, imgFixCss(), 'nexus-img-fix');
  };
  applyImgFix();
  if (isIframe) {
    // iframe 内容可能重新加载，补一次
    target.addEventListener('load', applyImgFix, { once: false });
  }

  /* ---- L3：色调统一覆盖层 ---- */
  const overlay = document.createElement('div');
  overlay.className = 'nexus-tone-overlay';
  wrap.appendChild(overlay);

  onInfo?.({
    adapted: true,
    reason: policy === 'always' ? 'forced' : 'base-mismatch',
    pluginBase, panelBase, baseSource,
  });

  return () => {
    try {
      target.style.filter = '';
      target.classList?.remove('nexus-adapted');
      // A5：load 监听必须移除，否则每次切插件/切主题都会再挂一个，越积越多
      if (isIframe) target.removeEventListener('load', applyImgFix);
      removeImgFix();
      overlay.remove();
    } catch { /* 卸载时 DOM 可能已销毁 */ }
  };
}

function safeDoc(iframe) {
  try { return iframe.contentDocument; } catch { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 给插件开发者的可选工具：把一段浅色 CSS 改写成使用面板主题变量
 * （用于你"改造"第三方插件源码的场景，比滤镜更彻底）
 *
 * 只做三类安全替换：纯白底 → --surface、浅灰底 → --surface-sunk、
 * 深色文字 → --text。其余（品牌色、边框、阴影）保持原样，避免改坏。
 */
export function lightenToDarkVars(css) {
  return String(css)
    .replace(/#ffffff\b/gi, 'var(--surface)')
    .replace(/#fff\b/gi, 'var(--surface)')
    .replace(/\brgba?\(\s*255\s*,\s*255\s*,\s*255\s*\)/gi, 'var(--surface)')
    .replace(/#f[0-9a-f]{5}\b/gi, 'var(--surface-sunk)')
    .replace(/#e[0-9a-f]{5}\b/gi, 'var(--surface-sunk)')
    .replace(/#(?:1|2|3)[0-9a-f]{5}\b/gi, 'var(--text)');
}
