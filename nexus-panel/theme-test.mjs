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
