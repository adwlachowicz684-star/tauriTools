/**
 * 主题连续切换的适配回归测试（开发用，可删）
 * ------------------------------------------------------------
 * 复现并守住这个 bug：
 *   「连续切换主题和插件后，插件深浅会和主平台反转」
 *
 * 根因：主题切换会挂 .theme-transition（320ms），CSS 过渡 260ms。
 * 而 installAdapter 在原实现里 sleep 120ms 就采样 —— 正落在过渡中段，
 * getComputedStyle 返回的是**动画中间值**（中性灰）：
 *     深色 #2b2f36 → 浅色 #e6e9ef 的中点 ≈ #888c92（亮度 ~0.29）
 * 判定为 "dark"，而此时面板基调已是 "light" → 误判为不一致 → 施加反转。
 * 等过渡跑完插件已是浅色，再被反转 → 与主平台正好相反。
 *
 * 修复：采样前先等过渡结束（waitThemeSettled）+ 连续采样取稳定值。
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: pathToFileURL(path.join(HERE, 'index.html')).href,
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
  key: (i) => [..._ls.keys()][i] ?? null,
  get length() { return _ls.size; },
};

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nz = await import('./js/theme-normalizer.js');
const tm = await import('./js/theme-manager.js');

/** 造一个插件容器，颜色可随时间变（模拟 CSS 过渡） */
function makePlugin(bg, fg) {
  const el = dom.window.document.createElement('div');
  el.style.backgroundColor = bg;
  el.style.color = fg;
  dom.window.document.body.appendChild(el);
  return el;
}

/** 模拟一次主题切换：挂 transition，并在期间把插件颜色从 from 过渡到 to */
function startTransition(pluginEl, from, to, ms = 260) {
  dom.window.document.documentElement.classList.add('theme-transition');
  const timers = [];
  timers.push(setTimeout(() => {
    pluginEl.style.backgroundColor = from.bg;
    pluginEl.style.color = from.fg;
  }, 0));
  // 中段：中间值（这就是原来被误读的那一帧）
  timers.push(setTimeout(() => {
    pluginEl.style.backgroundColor = '#888c92';
    pluginEl.style.color = '#7a7d80';
  }, ms * 0.45));
  // 结束：落到最终值
  timers.push(setTimeout(() => {
    pluginEl.style.backgroundColor = to.bg;
    pluginEl.style.color = to.fg;
    dom.window.document.documentElement.classList.remove('theme-transition');
  }, ms));
  return () => timers.forEach(clearTimeout);
}

const DARK = { bg: '#2b2f36', fg: '#d9dee8' };
const LIGHT = { bg: '#e6e9ef', fg: '#3a4050' };

/* ================= 1. 先证明 bug 确实成立 ================= */
console.log('\n--- 1. 复现：过渡中段采样会误判 ---');
{
  const el = makePlugin(DARK.bg, DARK.fg);
  // 面板切到浅色（变量已更新），但插件还在过渡中（读到中间值）
  el.style.backgroundColor = '#888c92';
  el.style.color = '#7a7d80';
  const b = nz.sampleBrightness(el);
  const judged = b > 0.55 ? 'light' : 'dark';
  t('过渡中间色被判定为 dark（而面板已是 light → 会误反转）',
    judged === 'dark', `亮度 ${b.toFixed(3)} → ${judged}`);
  el.remove();
}

/* ================= 2. 修复后：会等过渡结束 ================= */
console.log('\n--- 2. 修复：采样前等待过渡结束 ---');

// 保证面板基调是浅色
tm.applyTheme('neumorph-light');
const panelBase = tm.getBase();
t('面板基调已切为浅色', panelBase === 'light', panelBase);

{
  const el = makePlugin(DARK.bg, DARK.fg);
  const wrap = dom.window.document.createElement('div');
  wrap.style.position = 'relative';
  dom.window.document.body.appendChild(wrap);

  const cancel = startTransition(el, DARK, LIGHT, 260);

  const teardown = await nz.installAdapter({
    manifest: { id: 'seq-plugin', name: '跟随主题的插件' },
    wrap, target: el, root: el, isIframe: false,
  });

  const filtered = el.style.filter !== '';
  t('自适应插件（跟随面板变量）不被反转', !filtered,
    filtered ? `误施加了滤镜：${el.style.filter}` : '未施加滤镜 ✓');
  t('也没有残留色调覆盖层', !wrap.querySelector('.nexus-tone-overlay'));

  teardown?.();
  cancel();
  el.remove(); wrap.remove();
}

/* ================= 3. 写死浅色的第三方插件仍要正确反转 ================= */
console.log('\n--- 3. 不能误伤：写死浅色的插件仍应反转 ---');
tm.applyTheme('neumorph-dark');          // 回到深色面板
t('面板基调已切回深色', tm.getBase() === 'dark', tm.getBase());
{
  const el = makePlugin('#f5f5f5', '#222222');   // 典型第三方浅色插件
  const wrap = dom.window.document.createElement('div');
  wrap.style.position = 'relative';
  dom.window.document.body.appendChild(wrap);

  const teardown = await nz.installAdapter({
    manifest: { id: 'third-party-light', name: '第三方浅色插件' },
    wrap, target: el, root: el, isIframe: false,
  });

  t('深色面板下，写死浅色的插件被反转', el.style.filter !== '',
    el.style.filter ? '已施加滤镜' : '未施加（错误）');
  t('色调覆盖层已挂载', !!wrap.querySelector('.nexus-tone-overlay'));

  teardown?.();
  t('teardown 后滤镜清除', el.style.filter === '');
  t('teardown 后覆盖层移除', !wrap.querySelector('.nexus-tone-overlay'));
  el.remove(); wrap.remove();
}

/* ================= 4. 连续切换：滤镜与覆盖层不叠加 ================= */
console.log('\n--- 4. 连续切换主题：不叠加、不泄漏 ---');
tm.applyTheme('neumorph-dark');          // 深色面板 + 浅色插件 → 应反转
{
  const el = makePlugin('#f5f5f5', '#222222');
  const wrap = dom.window.document.createElement('div');
  wrap.style.position = 'relative';
  dom.window.document.body.appendChild(wrap);

  // 连开三次（模拟用户快速连点主题），不等待，制造并发
  const tds = [];
  const proms = [];
  for (let i = 0; i < 3; i++) {
    proms.push(nz.installAdapter({
      manifest: { id: 'spam-plugin', name: '快速切换' },
      wrap, target: el, root: el, isIframe: false,
    }).then((td) => tds.push(td)));
  }
  await Promise.all(proms);

  const overlayCount = wrap.querySelectorAll('.nexus-tone-overlay').length;
  t('并发三次只产生一层覆盖层', overlayCount === 1, `实际 ${overlayCount} 层`);

  // 全部 teardown
  for (const td of tds) td?.();
  t('全部 teardown 后覆盖层清空',
    wrap.querySelectorAll('.nexus-tone-overlay').length === 0);
  t('全部 teardown 后滤镜清空', el.style.filter === '');

  el.remove(); wrap.remove();
}

/* ================= 5. 深色面板 + 深色插件：不反转 ================= */
console.log('\n--- 5. 基调一致时不反转 ---');
{
  tm.applyTheme('neumorph-dark');
  const el = makePlugin(DARK.bg, DARK.fg);
  const wrap = dom.window.document.createElement('div');
  wrap.style.position = 'relative';
  dom.window.document.body.appendChild(wrap);

  const teardown = await nz.installAdapter({
    manifest: { id: 'dark-plugin', name: '深色插件' },
    wrap, target: el, root: el, isIframe: false,
  });
  t('深色面板 + 深色插件 → 不反转', el.style.filter === '');
  teardown?.();
  el.remove(); wrap.remove();
}

/* ================= 6. 隔离插件自报基调仍优先 ================= */
console.log('\n--- 6. 隔离插件自报基调不被过渡逻辑覆盖 ---');
{
  const el = makePlugin(DARK.bg, DARK.fg);
  const wrap = dom.window.document.createElement('div');
  wrap.style.position = 'relative';
  dom.window.document.body.appendChild(wrap);

  const teardown = await nz.installAdapter({
    manifest: { id: 'iso-plugin', name: '隔离插件' },
    wrap, target: el, root: el, isIframe: false,
    reportedBase: 'light',          // 插件自报：我是浅色
  });
  t('深色面板 + 自报浅色 → 反转', el.style.filter !== '',
    el.style.filter ? '已施加' : '未施加（错误）');
  teardown?.();
  el.remove(); wrap.remove();
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
