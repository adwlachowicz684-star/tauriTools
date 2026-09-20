/**
 * 主题系统测试（开发用，可删）
 * 覆盖：预设完整性 → 变量落地 → 持久化 → 派生变量 → 自定义主题 → 基调切换联动插件适配
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle;

const tm = await import('./js/theme-manager.js');
const { PRESET_THEMES, THEME_VARS, ACCENT_SWATCHES } = await import('./js/themes.js');
const { installAdapter, setPolicy } = await import('./js/theme-normalizer.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const cssVar = (k) => document.documentElement.style.getPropertyValue(k).trim();
const root = document.documentElement;

/* ============================================================
   0. 主题体系的三个结构性检查
   ------------------------------------------------------------
   这三节是"主题梳理"时补的，各自对应一类曾经出过的问题。
   ============================================================ */

/* ---------- 0a. 风格 × 基调 的覆盖（笛卡尔积不能有洞） ---------- */
{
  const bases = [...new Set(PRESET_THEMES.map((x) => x.base))];
  const styles = [...new Set(PRESET_THEMES.map((x) => x.style))];
  const holes = [];
  for (const b of bases) {
    for (const st of styles) {
      const n = PRESET_THEMES.filter((x) => x.base === b && x.style === st).length;
      if (n === 0) holes.push(`${b}×${st}`);
    }
  }
  t('风格 × 基调 每种组合至少有一套主题', holes.length === 0,
    holes.join(', ') || `${bases.length} 基调 × ${styles.length} 风格 = ${bases.length * styles.length} 格全满`);

  // 分布：不要求均匀，但要看得见偏斜（浅色扁平/浅色玻璃都只有 1 套）
  const dist = {};
  for (const x of PRESET_THEMES) {
    const k = `${x.base}×${x.style}`;
    dist[k] = (dist[k] || 0) + 1;
  }
  console.log('   分布：' + Object.entries(dist).map(([k, v]) => `${k}=${v}`).join('  '));
  t('每种风格都有深浅两套以上（不是单一基调撑着）',
    styles.every((st) => PRESET_THEMES.filter((x) => x.style === st && x.base === 'dark').length > 0
      && PRESET_THEMES.filter((x) => x.style === st && x.base === 'light').length > 0));
}

/* ---------- 0b. 全对比面自检（不只算 --bg） ----------
   此前只验了 --text / --text-dim 在 --bg 上，于是"卡片面""强调色"
   这些承载面完全没进视野 —— 角标白字压亮黄强调色（cyberpunk 1.09）
   就这样漏了 13 套。 */
{
  const hex2rgb = (h) => { const x = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
  const lum = (h) => {
    const [r, g, b] = hex2rgb(h).map((v) => { const y = v / 255; return y <= 0.03928 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const cr = (a, b) => { const la = lum(a), lb = lum(b); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };
  const solid = (c) => c && /^#[0-9a-f]{6}$/i.test(c);

  /* [前景, 承载面, 最低对比度, 说明]
     --surface 在玻璃主题下是 rgba，跳过（半透明无法算亮度）。 */
  const PAIRS = [
    ['--text', '--bg', 4.5, '正文@底色'],
    ['--text-soft', '--bg', 4.5, '次级正文@底色'],
    ['--text-dim', '--bg', 3.0, '弱化文字@底色'],
    ['--text-mute', '--bg', 3.0, '三级文字@底色'],
    ['--accent', '--bg', 3.0, '强调色@底色'],
    ['--text', '--surface', 4.5, '正文@卡片面'],
    ['--text-dim', '--surface', 3.0, '弱化@卡片面'],
    ['--text-mute', '--surface', 3.0, '三级@卡片面'],
    ['--text', '--surface-raised', 4.5, '正文@浮起面'],
  ];
  const dimBad = [];
  for (const th of PRESET_THEMES) {
    for (const [fg, bgc, min, label] of PAIRS) {
      if (!solid(th.vars[fg]) || !solid(th.vars[bgc])) continue;
      const c = cr(th.vars[fg], th.vars[bgc]);
      if (c < min) dimBad.push(`${th.id} ${label} ${c.toFixed(2)}<${min}`);
    }
  }
  t('文字/强调色在所有承载面上达标', dimBad.length === 0, dimBad.slice(0, 4).join(' | ') || '全部达标');

  /* 角标文字：压在 --accent 上，必须按强调色明暗选黑白。
     曾写死 #ffffff → 23 套里 13 套不可读（最低 1.09）。

     这里**必须读真实派生结果**（applyTheme 后取 CSS 变量），
     不能在测试里自己复现 pickOn 的逻辑 —— 那等于用"我认为该怎么算"
     去验证"代码怎么算"，把 badge-fg 改回写死白也不会变红。 */
  const badgeBad = [];
  let improved = 0;
  for (const th of PRESET_THEMES) {
    tm.applyTheme(th.id);
    const fg = cssVar('--badge-fg');
    const ac = cssVar('--accent');
    if (!solid(fg) || !solid(ac)) continue;
    const c = cr(fg, ac);
    const asWhite = cr('#ffffff', ac);
    if (c > asWhite + 0.01) improved++;
    if (c < 4.5) badgeBad.push(`${th.id}(${fg}@${ac} ${c.toFixed(2)})`);
  }
  t('角标文字（--badge-fg）在强调色上 ≥ 4.5', badgeBad.length === 0,
    badgeBad.slice(0, 5).join(' | ') || `全部达标（${improved} 套由白字改善而来）`);
  /* 派生而非写死：至少要在亮色强调色那几套上转成黑字 */
  const lightAccent = PRESET_THEMES.filter((x) => solid(x.vars['--accent']) && lum(x.vars['--accent']) > 0.5);
  let flipped = 0;
  for (const th of lightAccent) {
    tm.applyTheme(th.id);
    if (cssVar('--badge-fg').toLowerCase() === '#000000') flipped++;
  }
  t('亮色强调色上角标文字翻成黑色（不是一律白）',
    lightAccent.length > 0 && flipped === lightAccent.length,
    `${flipped}/${lightAccent.length} 套`);
  /* 勾是硬编码 SVG，读不到 CSS 变量 —— 必须有黑勾那套，否则白勾压亮色底 */
  const ctl = readFileSync('css/controls.css', 'utf8');
  t('勾选标记备了黑勾（data-badge-fg=dark 时切换）',
    /data-badge-fg='dark'/.test(ctl));
}

/* ---------- 0c. 插件的 followsTheme 与"是否真的跟随"一致 ---------- */
{
  const reg = readFileSync('plugins/registry.js', 'utf8');
  /* 按 "id: '" 切成块，避免用含换行的正则（会被当成真实换行截断） */
  const marks = reg.split("id: '").slice(1)
    .map((chunk) => ({ id: chunk.slice(0, chunk.indexOf("'")), body: chunk.slice(0, 900) }))
    .filter((x) => /followsTheme:\s*true/.test(x.body))
    .map((x) => x.id);
  /* 真跟随 = 插件的 CSS/HTML 里读外壳主题变量。
     判据量化：≥3 处引用 --bg/--surface/--text/--accent 之一。 */
  const SHELL = ['--bg', '--surface', '--surface-raised', '--surface-sunk', '--text', '--text-dim', '--accent'];
  const follows = [];
  const { readdirSync, existsSync } = await import('node:fs');
  for (const dir of readdirSync('plugins')) {
    let hits = 0;
    for (const f of ['styles.css', 'style.css', 'index.html']) {
      const fp = `plugins/${dir}/${f}`;
      if (!existsSync(fp)) continue;
      const txt = readFileSync(fp, 'utf8');
      /* 'var\\(' —— 少一层转义的话 JS 里就是 var( ，( 会被当成分组起点 */
      for (const v of SHELL) hits += (txt.match(new RegExp('var\\(' + v + '[),]', 'g')) || []).length;
    }
    if (hits >= 3) follows.push({ id: dir, hits });
  }
  const missing = follows.filter((x) => !marks.includes(x.id)).map((x) => `${x.id}(${x.hits}处)`);
  t('读了外壳变量的插件都标了 followsTheme', missing.length === 0,
    missing.join(', ') || `已标：${marks.join(', ')}`);

  /* 反向：标了却几乎不读外壳变量的（标错 → 该加的滤镜没加） */
  const wrong = marks.filter((id) => !follows.some((f) => f.id === id));
  t('标了 followsTheme 的插件确实读外壳变量（无错标）', wrong.length === 0, wrong.join(', '));
  console.log('   跟随主题的插件：' + follows.map((f) => `${f.id}(${f.hits})`).join('  '));
}

/* ---------- 1. 预设完整性 ---------- */
console.log(`\n预设主题：${PRESET_THEMES.map((x) => x.name).join(' / ')}\n`);
t('预设主题数量 ≥ 20', PRESET_THEMES.length >= 20, String(PRESET_THEMES.length));
t('每个主题都有唯一 id', new Set(PRESET_THEMES.map((x) => x.id)).size === PRESET_THEMES.length);
t('每个主题都声明了 base', PRESET_THEMES.every((x) => x.base === 'dark' || x.base === 'light'));

const REQUIRED = ['--bg', '--surface', '--sh-dark', '--sh-light', '--text', '--accent'];
t('每个主题都定义了核心变量',
  PRESET_THEMES.every((x) => REQUIRED.every((k) => x.vars[k])),
  PRESET_THEMES.filter((x) => !REQUIRED.every((k) => x.vars[k])).map((x) => x.id).join(',') || '全部齐备');

// 每套主题的配色必须自洽：凹陷面比底色暗、双向阴影方向正确、文字对比度达标
const hex2rgb = (h) => { const s = h.replace('#',''); return [0,2,4].map(i=>parseInt(s.slice(i,i+2),16)); };
const lum = (h) => { const [r,g,b] = hex2rgb(h).map(v=>{const x=v/255; return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4;}); return 0.2126*r+0.7152*g+0.0722*b; };
const contrast = (a,b) => { const la=lum(a), lb=lum(b); const [hi,lo]=la>lb?[la,lb]:[lb,la]; return (hi+0.05)/(lo+0.05); };

let shadeBad = [], contrastBad = [];
for (const x of PRESET_THEMES) {
  const v = x.vars;
  // 玻璃主题的半透明色不参与亮度比较
  const solid = (c) => c && /^#[0-9a-f]{6}$/i.test(c);
  // 纯黑底（lum≈0）无法再暗，凹陷与暗影只能往亮走 —— 这种是物理限制，豁免
  const nearBlack = solid(v['--bg']) && lum(v['--bg']) < 0.005;
  // 凹陷面要跟**卡片面**比，而不是跟底色比。
  // 扁平风（如 Agent Flow 深色）刻意让底色最深：bg #0f1115 < sunk #12151c < surface #171a21，
  // 用"比底色暗"判定会误报；但"凹陷面比卡片面暗"这个语义在任何风格下都成立。
  if (solid(v['--surface']) && solid(v['--surface-sunk']) && !nearBlack) {
    if (lum(v['--surface-sunk']) >= lum(v['--surface'])) shadeBad.push(x.id + '(sunk 未凹陷)');
  }
  if (solid(v['--bg']) && solid(v['--sh-dark']) && solid(v['--sh-light']) && !nearBlack) {
    if (lum(v['--sh-dark']) > lum(v['--bg'])) shadeBad.push(x.id + '(sh-dark 方向反)');
    // 纯白底无法再亮，豁免 sh-light
    if (lum(v['--sh-light']) < lum(v['--bg']) && lum(v['--bg']) < 0.95) {
      shadeBad.push(x.id + '(sh-light 方向反)');
    }
  }
  if (solid(v['--bg']) && solid(v['--text'])) {
    const c = contrast(v['--text'], v['--bg']);
    if (c < 4.5) contrastBad.push(`${x.id}(正文 ${c.toFixed(2)})`);
  }
  if (solid(v['--bg']) && solid(v['--text-dim'])) {
    const c = contrast(v['--text-dim'], v['--bg']);
    if (c < 3) contrastBad.push(`${x.id}(次级文字 ${c.toFixed(2)})`);
  }
}
t('每套主题：凹陷面/阴影方向正确', shadeBad.length === 0, shadeBad.join(', ') || `${PRESET_THEMES.length} 套全部正确`);
t('每套主题：正文对比度 ≥ 4.5、次级 ≥ 3', contrastBad.length === 0, contrastBad.join(', ') || '全部达标');

// 风格覆盖
const styles = new Set(PRESET_THEMES.map((x) => x.style));
t('覆盖新拟态/扁平/玻璃三种风格',
  styles.has('neumorph') && styles.has('flat') && styles.has('glass'),
  [...styles].join('+'));
t('深浅两种基调都有', new Set(PRESET_THEMES.map((x) => x.base)).size === 2);

/* ---------- 2. 应用主题后变量落地 ---------- */
tm.applyTheme('oled-flat');
t('切换主题后 --bg 已更新', cssVar('--bg') === '#000000', cssVar('--bg'));
t('html[data-theme] 已标记', root.dataset.theme === 'oled-flat', root.dataset.theme);
t('html[data-theme-base] 已标记', root.dataset.themeBase === 'dark', root.dataset.themeBase);
t('扁平主题 --border 非透明', cssVar('--border') !== 'transparent', cssVar('--border'));

tm.applyTheme('glass-dark');
t('玻璃主题 --blur 已开启', cssVar('--blur') === '14px', cssVar('--blur'));
t('玻璃主题 --surface 为半透明', /rgba/.test(cssVar('--surface')), cssVar('--surface'));
t('玻璃主题带背景渐变', cssVar('--bg-image') !== 'none');

tm.applyTheme('neumorph-light');
t('浅色主题 base=light', tm.getBase() === 'light');
t('浅色主题 --bg 为浅色', cssVar('--bg') === '#e6e9ef', cssVar('--bg'));

// 新拟态特征：surface 与 bg 同色（靠阴影塑形）
tm.applyTheme('neumorph-dark');
t('新拟态特征：surface 与 bg 同色', cssVar('--surface') === cssVar('--bg'));

/* ---------- 3. 派生变量 ---------- */
t('派生 --accent-glow', /rgba/.test(cssVar('--accent-glow')), cssVar('--accent-glow'));
t('派生 --hairline（深色用微白）', /255, ?255, ?255/.test(cssVar('--hairline')), cssVar('--hairline'));
t('派生 --scroll-thumb', cssVar('--scroll-thumb').startsWith('#'), cssVar('--scroll-thumb'));
t('派生 --mask', /rgba/.test(cssVar('--mask')), cssVar('--mask'));
// 变量必须**有来源**：要么主题内联设置，要么 css/neumorphism.css 的 :root 有默认值。
// 圆角这类变量允许主题不定义（见 themes.js「未定义的主题回退 CSS 默认值」），
// 但不能两头都不管 —— 那会得到一个空变量，用到它的样式直接失效。
//
// 另一个隐含前提：切主题时要清掉上一套主题残留的内联值，
// 否则 CSS 兜底永远被内联样式压住，轮不上生效。
const cssRootText = (() => {
  try {
    const css = readFileSync(new URL('./css/neumorphism.css', import.meta.url), 'utf8');
    const m = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
    return m ? m[1] : '';
  } catch { return ''; }
})();
const cssDefaults = new Set([...cssRootText.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
const missingSource = THEME_VARS.filter(
  (k) => document.documentElement.style.getPropertyValue(k).trim() === '' && !cssDefaults.has(k),
);

t('THEME_VARS 均有来源（内联或 CSS 兜底）',
  missingSource.length === 0,
  missingSource.join(',') || '全部有来源');

/* 切主题时不能留下上一套主题的残值。
   扁平主题定义了圆角，新拟态主题没定义 —— 切回去时若不主动清除，
   内联值会一直压住 CSS 里的默认值，圆角就回不来了。 */
{
  const FLAT = PRESET_THEMES.find((x) => x.style === 'flat' && x.vars?.['--r-xl']);
  const SOFT = PRESET_THEMES.find((x) => x.style !== 'flat' && !x.vars?.['--r-xl']);
  if (FLAT && SOFT) {
    tm.applyTheme(FLAT.id);
    const flatVal = cssVar('--r-xl');
    tm.applyTheme(SOFT.id);
    const after = document.documentElement.style.getPropertyValue('--r-xl').trim();
    t('切回未定义该变量的主题时清掉残留内联值',
      flatVal !== '' && after === '', `扁平 ${flatVal} → 切回后 ${after || '(已清除)'}`);
  } else {
    t('切回未定义该变量的主题时清掉残留内联值', true, '样本不足，跳过');
  }
}

/* 圆角要么不定义（交给 CSS 兜底），要么四个全定义。
   只定义一部分会拼出「混合风格」：比如 --r-xl 用主题的 12px、
   --r-md 却落到 CSS 兜底的 17px，同一套界面上两种圆角语言。
   这条断言把「半套覆盖」钉死在加主题的时候，而不是等看出来。 */
{
  const R_KEYS = ['--r-xl', '--r-lg', '--r-md', '--r-sm'];
  const half = PRESET_THEMES.filter((x) => {
    const n = R_KEYS.filter((k) => x.vars?.[k] != null).length;
    return n > 0 && n < R_KEYS.length;
  }).map((x) => {
    const got = R_KEYS.filter((k) => x.vars?.[k] != null).join(',');
    const miss = R_KEYS.filter((k) => x.vars?.[k] == null).join(',');
    return `${x.id}(有:${got} 缺:${miss})`;
  });
  t('圆角不出现半套覆盖', half.length === 0, half.join('; ') || '无半套主题');
}

/* ---------- 4. 持久化 ---------- */
tm.applyTheme('neon-dark');
t('主题选择已持久化', localStorage.getItem('nexus:theme') === 'neon-dark');
t('getCurrent 返回当前主题', tm.getCurrent().id === 'neon-dark');

/* ---------- 5. 强调色微调 ---------- */
tm.applyTheme('neumorph-dark');
tm.setAccent('#ff2e97');
t('强调色覆盖生效', cssVar('--accent') === '#ff2e97', cssVar('--accent'));
t('强调色辉光同步更新', /255, 46, 151/.test(cssVar('--accent-glow')), cssVar('--accent-glow'));
t('强调色已持久化', localStorage.getItem('nexus:accent') === '#ff2e97');
t('强调色候选非空', ACCENT_SWATCHES.length >= 6, String(ACCENT_SWATCHES.length));

/* ---------- 6. 自定义主题 ---------- */
const custom = tm.saveAsCustom('我的主题');
t('可另存为自定义主题', custom.custom === true && !!custom.id, custom.name);
t('自定义主题进入列表', tm.listThemes().some((x) => x.id === custom.id));
tm.applyTheme(custom.id);
t('自定义主题可应用', tm.getCurrent().id === custom.id);
tm.deleteCustomTheme(custom.id);
t('自定义主题可删除', !tm.listThemes().some((x) => x.id === custom.id));

/* ---------- 7. 基调联动：面板变浅后，深色插件需要反转 ---------- */
function buildPlugin(bg, color) {
  const el = document.createElement('div');
  el.innerHTML = `<div style="background:${bg};color:${color}"><h1 style="color:${color}">x</h1>
    <div style="background:${bg};color:${color}">y</div></div>`;
  document.body.appendChild(el);
  return el;
}

async function adapt(manifest, el) {
  const wrap = document.createElement('div');
  wrap.appendChild(el);
  document.body.appendChild(wrap);
  let info = null;
  const teardown = await installAdapter({
    manifest, wrap, target: el, root: el, isIframe: false,
    onInfo: (i) => { info = i; },
  });
  return { el, wrap, teardown, info };
}

setPolicy('auto');
localStorage.removeItem('nexus:accent');

// 面板深色 + 插件浅色 → 应反转
tm.applyTheme('neumorph-dark');
const a1 = await adapt({ id: 'p1', theme: 'light' }, buildPlugin('#ffffff', '#333333'));
t('深色面板 + 浅色插件 → 施加反转', a1.el.style.filter.includes('invert'), a1.info?.reason);
a1.teardown();

// 面板深色 + 插件深色 → 不反转
const a2 = await adapt({ id: 'p2', theme: 'dark' }, buildPlugin('#2b2f36', '#d9dee8'));
t('深色面板 + 深色插件 → 不反转', a2.el.style.filter === '', a2.info?.reason);
a2.teardown();

// 面板浅色 + 插件深色 → 应反转（这是本轮新增的双向能力）
tm.applyTheme('neumorph-light');
const a3 = await adapt({ id: 'p3', theme: 'dark' }, buildPlugin('#2b2f36', '#d9dee8'));
t('浅色面板 + 深色插件 → 施加反转（双向）', a3.el.style.filter.includes('invert'), a3.info?.reason);
a3.teardown();

// 面板浅色 + 插件浅色 → 不反转
const a4 = await adapt({ id: 'p4', theme: 'light' }, buildPlugin('#ffffff', '#333333'));
t('浅色面板 + 浅色插件 → 不反转', a4.el.style.filter === '', a4.info?.reason);
a4.teardown();

/* ---------- 8. 自动检测（不声明 theme 时） ---------- */
tm.applyTheme('neumorph-dark');
const a5 = await adapt({ id: 'p5' }, buildPlugin('#ffffff', '#333333'));
t('未声明 theme 时自动检测为浅色并反转', a5.el.style.filter.includes('invert'), a5.info?.pluginBase);
a5.teardown();

/* ---------- 9. 订阅通知 ---------- */
let notified = 0;
const off = tm.onChange(() => notified++);
tm.applyTheme('midnight');
tm.setAccent('#48e0c0');
t('主题变更可订阅', notified >= 2, String(notified));
off();
tm.applyTheme('neumorph-dark');
t('取消订阅后不再通知', notified === 2, String(notified));

/* ---------- 10. 易漏项：点缀色可读性 / 风格角标 ---------- */
const { STYLE_LABELS } = await import('./js/themes.js');

/* 点缀色（强调色 / 环境色）不是正文，但至少要看得见 —— 非文本元素的 AA 线是 3:1。
   浅色底最容易翻车：青色 #48e0c0 在米白底只有 1.4:1，几乎隐形。
   基准取 --surface（卡片实际底色），玻璃主题 surface 半透明时才退回 --bg。 */
const isHex = (c) => !!c && /^#[0-9a-f]{6}$/i.test(c);
const decorBad = [];
for (const x of PRESET_THEMES) {
  const v = x.vars;
  const card = isHex(v['--surface']) ? v['--surface'] : v['--bg'];
  if (!isHex(card)) continue;
  for (const k of ['--accent', '--env-color', '--text-mute']) {
    if (!isHex(v[k])) continue;
    const c = contrast(v[k], card);
    if (c < 3) decorBad.push(`${x.id}(${k} ${c.toFixed(2)})`);
  }
}
t('每套主题：点缀色与最弱文字对比度 ≥ 3', decorBad.length === 0, decorBad.join(', ') || '全部达标');

// 卡片角标直接取 STYLE_LABELS[style]，style 拼错会渲染成一个空白角标
const styleBad = PRESET_THEMES.filter((x) => !STYLE_LABELS[x.style]).map((x) => `${x.id}(${x.style})`);
t('每套主题的 style 都能取到角标文案', styleBad.length === 0, styleBad.join(', ') || '全部有文案');
t('每套主题都写了描述文案', PRESET_THEMES.every((x) => String(x.desc || '').trim().length > 0));

/* ---------- 11. 色相 / 明暗按主题独立 ---------- */
/* 全局单键的旧实现会把 A 主题调好的偏移带到 B 主题上，
   而各主题的可调空间完全不同（纯黑底只能提亮、纯白底只能压暗），
   串过去往往正好踩在另一套主题的雷区。 */
tm.applyTheme('neumorph-dark');
tm.setThemeShift(40, 10);
t('设置后可读回', tm.getHueShift() === 40 && tm.getLightShift() === 10,
  `${tm.getHueShift()}° / ${tm.getLightShift()}%`);

tm.applyTheme('midnight');
t('切到别的主题：偏移不跟过去', tm.getHueShift() === 0 && tm.getLightShift() === 0,
  `${tm.getHueShift()}° / ${tm.getLightShift()}%`);

tm.setThemeShift(-60, -25);
t('每个主题可各存一套', tm.getHueShift() === -60 && tm.getLightShift() === -25,
  `${tm.getHueShift()}° / ${tm.getLightShift()}%`);

tm.applyTheme('neumorph-dark');
t('切回原主题：仍是原值', tm.getHueShift() === 40 && tm.getLightShift() === 10,
  `${tm.getHueShift()}° / ${tm.getLightShift()}%`);
t('不切换也能按 id 查询', tm.getHueShift('midnight') === -60, String(tm.getHueShift('midnight')));

// 旧版是全局单键，读不到本主题的键时要回落过去，老用户调过的值不至于丢
localStorage.clear();
localStorage.setItem('nexus:hue-shift', '25');
localStorage.setItem('nexus:light-shift', '-10');
tm.applyTheme('graphite');
t('旧版全局值可迁移到当前主题', tm.getHueShift() === 25 && tm.getLightShift() === -10,
  `${tm.getHueShift()}° / ${tm.getLightShift()}%`);

tm.setThemeShift(0, 0);
tm.applyTheme('celadon');
tm.setThemeShift(30, 15);
tm.resetColors();
t('重置清掉当前主题偏移', tm.getHueShift() === 0 && tm.getLightShift() === 0);

tm.setThemeShift(999, -999);
t('超出范围被夹取', tm.getHueShift() === 180 && tm.getLightShift() === -50,
  `${tm.getHueShift()}° / ${tm.getLightShift()}%`);
tm.setThemeShift(0, 0);

/* ---------- 12. 浮层底板 ---------- */
/* 弹窗 / 吐司这类盖在别的内容上的容器，底板必须比 --surface 实，
   否则后面的界面会透上来与浮层文字叠在一起（玻璃主题下透出率曾高达 93%）。 */
const cssText = readFileSync(new URL('./css/neumorphism.css', import.meta.url), 'utf8');
t('--surface-overlay 在 THEME_VARS 里', THEME_VARS.includes('--surface-overlay'));
t('CSS 有兜底值', /--surface-overlay\s*:/.test(cssText));
t('.dialog 用浮层底板', /\.dialog\s*\{[^}]*surface-overlay/.test(cssText));

// 玻璃主题必须显式给一个高不透明度的值，不能只靠兜底
const glass = PRESET_THEMES.filter((x) => x.style === 'glass');
const glassBad = glass.filter((x) => {
  const v = x.vars['--surface-overlay'];
  if (!v) return true;
  const m = /rgba?\([^)]*?([\d.]+)\s*\)/.exec(v);
  return !m || parseFloat(m[1]) < 0.8;
});
t('玻璃主题浮层底板足够实（alpha ≥ .8）', glassBad.length === 0,
  glassBad.map((x) => x.id).join(', ') || `${glass.length} 套均达标`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
