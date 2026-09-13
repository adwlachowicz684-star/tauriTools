/**
 * 主题适配器单元测试（开发用，可删）
 * 验证：亮度采样是否正确区分浅/深色插件，以及适配是否真正施加与可回滚。
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.localStorage = dom.window.localStorage;

const {
  sampleBrightness, isLightTheme, installAdapter,
  getPolicy, setPolicy, setPluginOverride, DARK_FILTER,
} = await import('./js/theme-normalizer.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------- 构造两种风格的插件 DOM ---------- */
function buildLight() {
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="background:#ffffff;color:#333333">
      <h1 style="color:#111111">Dashboard</h1>
      <div style="background:#f5f6f8;color:#222222">card</div>
      <button style="background:#2f6fed;color:#ffffff">查询</button>
      <table style="background:#ffffff;color:#555555"><tr><td>a</td></tr></table>
    </div>`;
  document.body.appendChild(el);
  return el;
}
function buildDark() {
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="background:#2b2f36;color:#d9dee8">
      <h1 style="color:#ffffff">Dashboard</h1>
      <div style="background:#282c33;color:#8b93a2">card</div>
      <button style="background:#5b8cff;color:#ffffff">查询</button>
    </div>`;
  document.body.appendChild(el);
  return el;
}

/* ---------- 1. 亮度采样 ---------- */
const lightEl = buildLight();
const darkEl = buildDark();

const bLight = sampleBrightness(lightEl);
const bDark = sampleBrightness(darkEl);
console.log(`\n亮度采样：浅色插件=${bLight?.toFixed(3)}  深色插件=${bDark?.toFixed(3)}\n`);

t('浅色插件识别为浅色 (isLightTheme=true)', isLightTheme(lightEl), bLight?.toFixed(3));
t('深色插件识别为深色 (isLightTheme=false)', !isLightTheme(darkEl), bDark?.toFixed(3));
t('浅色亮度 > 深色亮度', bLight > bDark, `${bLight.toFixed(3)} > ${bDark.toFixed(3)}`);

/* ---------- 2. 自动适配：浅色 -> 施加滤镜 ---------- */
async function mountLikeShell(root, manifest) {
  const wrap = document.createElement('div');
  wrap.className = 'plugin-wrap';
  wrap.appendChild(root);
  document.body.appendChild(wrap);
  const teardown = await installAdapter({
    manifest, wrap, target: root, root, isIframe: false,
  });
  return { wrap, root, teardown };
}

setPolicy('auto');
const lightCase = await mountLikeShell(lightEl, { id: 'p-light', theme: 'light' });
t('浅色插件已施加反转滤镜', lightCase.root.style.filter === DARK_FILTER,
  lightCase.root.style.filter);
t('浅色插件已加 nexus-adapted 标记', lightCase.root.classList.contains('nexus-adapted'));
t('已插入色调统一覆盖层', !!lightCase.wrap.querySelector('.nexus-tone-overlay'));
t('图片还原样式已注入', !!document.getElementById('nexus-img-fix'));

/* ---------- 3. 深色插件不应被误伤 ---------- */
const darkCase = await mountLikeShell(darkEl, { id: 'p-dark', theme: 'dark' });
t('深色插件未施加滤镜', darkCase.root.style.filter === '', `filter="${darkCase.root.style.filter}"`);
t('深色插件无覆盖层', !darkCase.wrap.querySelector('.nexus-tone-overlay'));

/* ---------- 4. 策略：never / always ---------- */
setPolicy('never');
const neverCase = await mountLikeShell(buildLight(), { id: 'p-never', theme: 'auto' });
t('策略=never 时不适配', neverCase.root.style.filter === '');

setPolicy('always');
const alwaysCase = await mountLikeShell(buildDark(), { id: 'p-always', theme: 'auto' });
t('策略=always 时深色插件也强制适配', alwaysCase.root.style.filter === DARK_FILTER);

/* ---------- 5. 单插件覆盖优先于全局 ---------- */
setPolicy('never');
setPluginOverride('p-override', 'always');
const ovCase = await mountLikeShell(buildLight(), { id: 'p-override', theme: 'auto' });
t('单插件覆盖(always) 优先于全局(never)', ovCase.root.style.filter === DARK_FILTER);

/* ---------- 6. teardown 可回滚 ---------- */
lightCase.teardown();
t('teardown 清除滤镜', lightCase.root.style.filter === '');
t('teardown 移除覆盖层', !lightCase.wrap.querySelector('.nexus-tone-overlay'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
