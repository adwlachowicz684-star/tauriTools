/**
 * 主题系统测试（开发用，可删）
 * 覆盖：预设完整性 → 变量落地 → 持久化 → 派生变量 → 自定义主题 → 基调切换联动插件适配
 */
import { JSDOM } from 'jsdom';

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
  if (solid(v['--bg']) && solid(v['--surface-sunk']) && !nearBlack) {
    if (lum(v['--surface-sunk']) >= lum(v['--bg'])) shadeBad.push(x.id + '(sunk 未凹陷)');
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
t('THEME_VARS 全部已落地',
  THEME_VARS.every((k) => cssVar(k) !== ''),
  THEME_VARS.filter((k) => cssVar(k) === '').join(',') || '全部有值');

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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
