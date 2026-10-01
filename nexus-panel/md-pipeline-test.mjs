/**
 * md 渲染管线 —— 运行时来源解析测试
 * ============================================================
 *
 * 钉的是"装进工具里的包真的被用上"这条链路。
 * 它的失效形态是**装成功却没效果**：界面显示"已安装并验证可加载"，
 * 渲染行为一点没变，不报错、不红。所以能真跑的一律真跑，
 * 只查源码的断言也尽量查"那一处"而不是"文件里有没有这个词"。
 *
 * 运行：node md-pipeline-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

/**
 * 剥注释 —— 断言"那一处"之前先剥，否则注释里的字样会造出假绿。
 *
 * 改用共用实现（此前这里是第三份内联副本）。注意行注释判据从 `(^|[^:])`
 * 收窄成共用模块的 `(^|\s)`：前者会把 `a//b` 这类**代码里的双斜杠**也当
 * 注释剥掉（扫到含路径的源码时等于在检查一段被截断的文本，可能假绿）。
 * 实测换成共用实现后 37 项断言结果不变。
 */
function strip(src) {
  return stripCommentsFlatJs(src || '');
}

const {
  SWAP_SLOTS,
  BUNDLED_PLUGINS,
  pluginFnOf,
  resolvePlugins,
  resetPluginCache,
} = await import('./plugins/md/pipeline.js');

const { REMARK_PLUGINS, REHYPE_PLUGINS } = await import('./plugins/md/render-config.js');

/* ============================================================
   1. 槽位表与打包版对齐
   ============================================================ */
console.log('\n=== 1. 槽位表 ===');

t('三个包都登记了槽位',
  ['remark-gfm', 'rehype-slug', 'rehype-highlight']
    .every((n) => SWAP_SLOTS[n] && typeof SWAP_SLOTS[n].index === 'number'));

/*
 * 槽位下标必须在**数组范围内**。越界不报错（withSwap 直接跳过），
 * 表现是"装了却没换" —— 所以必须钉住，不能靠"看着没问题"。
 */
t('rehype-slug 的槽位在 rehype 数组内',
  SWAP_SLOTS['rehype-slug'].layer === 'rehype' &&
  SWAP_SLOTS['rehype-slug'].index < REHYPE_PLUGINS.length);
t('rehype-highlight 的槽位在 rehype 数组内',
  SWAP_SLOTS['rehype-highlight'].layer === 'rehype' &&
  SWAP_SLOTS['rehype-highlight'].index < REHYPE_PLUGINS.length);
t('remark-gfm 的槽位在 remark 数组内',
  SWAP_SLOTS['remark-gfm'].layer === 'remark' &&
  SWAP_SLOTS['remark-gfm'].index < REMARK_PLUGINS.length);

/* ============================================================
   2. pluginFnOf —— CDN 单文件的两种形态
   ============================================================ */
console.log('\n=== 2. 从模块里取插件函数 ===');

const fn = function marker() {};
t('裸函数直接可用', pluginFnOf(fn) === fn);
t('{ default: fn } 取 default（CDN +esm 的常见形态）',
  pluginFnOf({ default: fn }) === fn);
t('没有 default 的命名空间对象 → null（回退打包版，不是"取到个空模块"）',
  pluginFnOf({ other: fn }) === null);
t('default 不是函数 → null', pluginFnOf({ default: 123 }) === null);
t('null / undefined → null', pluginFnOf(null) === null && pluginFnOf(undefined) === null);

/* ============================================================
   3. 没有 ctx：一律打包版
   ============================================================ */
console.log('\n=== 3. 无 ctx（老宿主 / iframe 沙箱） ===');

resetPluginCache();
const noCtx = await resolvePlugins(null);
t('无 ctx 返回打包版数组',
  Array.isArray(noCtx.remark) && Array.isArray(noCtx.rehype));
t('无 ctx 时三个来源都记 bundle',
  Object.values(noCtx.sources).every((v) => v === 'bundle'));
t('无 ctx 时数组内容与 render-config 一致（没有多/少元素）',
  noCtx.remark.length === REMARK_PLUGINS.length &&
  noCtx.rehype.length === REHYPE_PLUGINS.length);

/* ============================================================
   4. 装了运行时版 —— 真跑替换
   ============================================================ */
console.log('\n=== 4. 运行时版替换（真跑） ===');

/** 造一个假 ctx：map 里给了就用运行时版，其余走 fallback。 */
function fakeCtx(map, opts = {}) {
  let calls = 0;
  return {
    calls() { return calls; },
    requireDep(name, o = {}) {
      calls++;
      if (opts.throw) return Promise.reject(new Error('boom'));
      if (opts.broken && map[name]) return Promise.resolve({ mod: { default: 'not-a-fn' }, source: 'runtime' });
      if (map[name]) return Promise.resolve({ mod: { default: map[name] }, source: 'runtime' });
      return Promise.resolve(o.fallback ? o.fallback() : null).then((mod) => ({
        mod: mod ? { default: mod } : null,
        source: 'bundle',
      }));
    },
  };
}

const rtGfm = function runtimeGfm() {};
const rtSlug = function runtimeSlug() {};
const rtHl = function runtimeHighlight() {};
const ctxAll = fakeCtx({ 'remark-gfm': rtGfm, 'rehype-slug': rtSlug, 'rehype-highlight': rtHl });

resetPluginCache();
const all = await resolvePlugins(ctxAll);

t('remark-gfm 用了运行时版',
  all.sources['remark-gfm'] === 'runtime' &&
  all.remark[SWAP_SLOTS['remark-gfm'].index][0] === rtGfm);

/*
 * 选项必须保留 —— 整条替换成裸 fn 会丢掉 singleTilde:false，
 * "约 ~200ms"这类成对单波浪又变成删除线。这是**配置**回退，
 * 界面上看不出是插件换了，只能靠断言钉。
 */
const gfmSlot = all.remark[SWAP_SLOTS['remark-gfm'].index];
t('remark-gfm 的选项保留了（仍是 [fn, opts] 元组）',
  Array.isArray(gfmSlot) && gfmSlot[0] === rtGfm &&
  gfmSlot[1] && gfmSlot[1].singleTilde === false);

t('rehype-slug 用了运行时版且**回到原槽位**',
  all.sources['rehype-slug'] === 'runtime' &&
  all.rehype[SWAP_SLOTS['rehype-slug'].index] === rtSlug);
t('rehype-highlight 用了运行时版且**回到原槽位**',
  all.sources['rehype-highlight'] === 'runtime' &&
  all.rehype[SWAP_SLOTS['rehype-highlight'].index] === rtHl);

/* 顺序：slug 必须仍在 highlight 之前（见 render-config 的顺序说明） */
t('rehype 顺序没被挪动（slug 仍在 highlight 之前）',
  SWAP_SLOTS['rehype-slug'].index < SWAP_SLOTS['rehype-highlight'].index &&
  all.rehype.indexOf(rtSlug) < all.rehype.indexOf(rtHl));
t('换完数组长度不变（不是追加）',
  all.rehype.length === REHYPE_PLUGINS.length &&
  all.remark.length === REMARK_PLUGINS.length);

/* ============================================================
   5. 只装一部分 / 坏了 / 抛异常
   ============================================================ */
console.log('\n=== 5. 混合与失败回退 ===');

resetPluginCache();
const part = await resolvePlugins(fakeCtx({ 'rehype-highlight': rtHl }));
t('只装了一个包：那个用运行时版，其余仍是打包版',
  part.sources['rehype-highlight'] === 'runtime' &&
  part.sources['rehype-slug'] === 'bundle' &&
  part.sources['remark-gfm'] === 'bundle');
t('没装的那两个仍是打包版的函数（没被换成 undefined）',
  typeof part.rehype[SWAP_SLOTS['rehype-slug'].index] === 'function' &&
  Array.isArray(part.remark[0]) && typeof part.remark[0][0] === 'function');

resetPluginCache();
const broken = await resolvePlugins(
  fakeCtx({ 'rehype-slug': rtSlug }, { broken: true }),
);
t('装的那份不是函数 → 回退打包版，不抛',
  broken.sources['rehype-slug'] === 'bundle' &&
  typeof broken.rehype[SWAP_SLOTS['rehype-slug'].index] === 'function');

resetPluginCache();
const throwing = await resolvePlugins(fakeCtx({}, { throw: true }));
t('requireDep 抛异常 → 不抛，全用打包版',
  Object.values(throwing.sources).every((v) => v === 'bundle'));

/* ============================================================
   6. 只解析一次（四个入口必须拿到同一份）
   ============================================================ */
console.log('\n=== 6. 进程内只解析一次 ===');

resetPluginCache();
const ctxCount = fakeCtx({ 'remark-gfm': rtGfm });
const a1 = await resolvePlugins(ctxCount);
const a2 = await resolvePlugins(ctxCount);
const a3 = await resolvePlugins(ctxCount);
t('解析只做一次（三次调用 = 三次 requireDep，没有重复解析）',
  ctxCount.calls() === 3, `实际 ${ctxCount.calls()} 次`);
t('三次调用拿到的是同一份结果（引用相同）', a1 === a2 && a2 === a3);

/*
 * 并发：两个入口同时解析，必须共享同一个 Promise。
 * 各解析各的会出两套结论 —— 同一段 md 在两个入口渲染出不同结果
 * （F11 修掉的正是这个），且不报错。
 */
resetPluginCache();
const ctxPara = fakeCtx({ 'remark-gfm': rtGfm });
const [p1, p2] = await Promise.all([resolvePlugins(ctxPara), resolvePlugins(ctxPara)]);
t('并发解析共享同一结果', p1 === p2);
t('并发时也只解析一次', ctxPara.calls() === 3, `实际 ${ctxPara.calls()} 次`);

/* ============================================================
   7. 两个入口走同一个解析入口（源码级）
   ============================================================ */
console.log('\n=== 7. 入口接线 ===');

const appSrc = read('plugins/md/App.tsx');
const svcSrc = read('plugins/md-render/module.js');

t('app 入口渲染时用的是解析结果，不是常量数组',
  /remarkPlugins=\{plugins\.remark\}/.test(strip(appSrc)) &&
  /rehypePlugins=\{plugins\.rehype\}/.test(strip(appSrc)));
t('app 入口挂载后触发解析', /resolvePlugins\(ctx\)/.test(strip(appSrc)));

/*
 * 换插件必须清块缓存：缓存键是块文本，插件换了而键没变，
 * 渲染过的块会继续用旧插件的元素 —— "装了新版，翻回前面还是老的"。
 */
const appClean = strip(appSrc);
t('插件变化时重建块缓存（否则旧块永远用旧插件渲染）',
  /useEffect\(\(\) => \{\s*cacheRef\.current = createBlockCache\(\);\s*\}, \[plugins\]\)/.test(appClean));

t('服务入口也用解析结果',
  /resolvePlugins\(ctx\)/.test(strip(svcSrc)) &&
  /remarkPlugins: remark/.test(strip(svcSrc)) &&
  /rehypePlugins: rehype/.test(strip(svcSrc)));
t('服务的两个方法都标了 async（返回 Promise，调用方必须 await）',
  /async function renderToHtml/.test(svcSrc) && /async function renderConfig/.test(svcSrc));

/* ============================================================
   8. 依赖清单能扫出这三个消费方（真跑）
   ============================================================ */
console.log('\n=== 8. 依赖清单里的运行时消费方 ===');

const manifest = read('js/deps-manifest.js');
function runtimeUsedBy(pkg) {
  const i = manifest.indexOf(`"${pkg}"`);
  if (i < 0) return null;
  const seg = manifest.slice(i, i + 1200);
  const m = /"runtimeUsedBy":\s*\[([\s\S]*?)\]/.exec(seg);
  return m ? m[1] : null;
}
for (const pkg of ['remark-gfm', 'rehype-slug', 'rehype-highlight']) {
  const u = runtimeUsedBy(pkg);
  t(`${pkg} 的 runtimeUsedBy 里有 md（界面才会显示"装了有人用"）`,
    !!u && u.includes('md'), String(u).slice(0, 80));
}

/* ============================================================
   9. 真跑渲染：换成运行时版后渲染仍然正常
   ============================================================ */
console.log('\n=== 9. 真跑渲染（运行时版） ===');

try {
  const { default: svc } = await import('./plugins/md-render/module.js');
  const gfm = (await import('remark-gfm')).default;
  const slug = (await import('rehype-slug')).default;
  const hl = (await import('rehype-highlight')).default;

  resetPluginCache();
  const ctxReal = fakeCtx({ 'remark-gfm': gfm, 'rehype-slug': slug, 'rehype-highlight': hl });
  const html = await svc.methods.renderToHtml({ text: '| a | b |\n|---|---|\n| 1 | 2 |' }, ctxReal);
  t('换运行时版后表格仍渲染成 <table>', /<table>/.test(html));

  const html2 = await svc.methods.renderToHtml({ text: '## 标题一' }, ctxReal);
  t('换运行时版后标题仍带 id（slug 生效）', /<h2 id="[^"]+"/.test(html2));

  const cfg = await svc.methods.renderConfig({}, ctxReal);
  t('renderConfig 返回的也是解析后的数组',
    Array.isArray(cfg.remarkPlugins) && Array.isArray(cfg.rehypePlugins));
} catch (e) {
  t('真跑渲染（需要 react-markdown 等依赖已装）', false, String(e && e.message));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
