/**
 * 构建产物完整性检查（N65）
 * ============================================================
 * 为什么要有这个脚本
 * ------------------------------------------------------------
 * N62 暴露的教训：**静态检查再全，也替代不了一次真实的构建产物检查**。
 *
 * 122 个预设图标在 Vite 生产构建下全部 404，而我此前几十轮测试全绿 ——
 * 因为所有测试都跑在**源码**上，从来没有人看过 dist 里到底有什么。
 *
 * 更糟的是人工检查也会出错：我自己就差点把"dist 是 3 天前的旧产物"
 * 误判成"服务插件没被纳入构建"。过期产物会让判断完全跑偏。
 *
 * 所以把"构建后该确认什么"固化成脚本。它同时覆盖两个待验证项：
 *   · N54 —— home 在 Vite 下是否真走同页（嵌合是否成立）
 *   · N62 —— 122 个图标是否真的进了 dist
 *
 * 用法
 * ------------------------------------------------------------
 *   npm run build && npm run check:dist
 *
 * 不跑构建直接检查的话，它会报"产物缺失"—— 那是**真实情况**，不是误报。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/*
 * 支持环境变量覆盖产物目录。
 * 一是 CI 里产物不一定在 ./dist；二是**测试自身也需要验证** ——
 * 要确认"产物完整时脚本不误报"，就得能指向一份构造好的完整产物。
 * 没这个口子就只能拿真实构建产物试，而沙盒里跑不了构建。
 */
const DIST = process.env.NEXUS_DIST
  ? path.resolve(process.env.NEXUS_DIST)
  : path.join(HERE, 'dist');

let pass = 0;
let fail = 0;
const warns = [];
const t = (name, cond, hint = '') => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else {
    fail += 1;
    console.log(`❌ ${name}${hint ? `  —— ${hint}` : ''}`);
  }
};

/** 从 registry.js 源码解析插件清单（不 import：它是浏览器 ESM） */
function parseRegistry() {
  const src = fs.readFileSync(path.join(HERE, 'plugins/registry.js'), 'utf8');
  const out = [];
  const re = /\{\s*id:\s*'([^']+)'/g;
  const marks = [...src.matchAll(re)].map((m) => ({ id: m[1], at: m.index }));
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].at : src.length;
    const blk = src.slice(marks[i].at, end);
    const tri = blk.match(/entry:\s*noBuild\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/);
    const konst = blk.match(/entry:\s*'([^']+)'/);
    const typeTri = blk.match(/type:\s*noBuild\s*\?\s*'(\w+)'\s*:\s*'(\w+)'/);
    const typeConst = blk.match(/type:\s*'(\w+)'/);
    out.push({
      id: marks[i].id,
      viteEntry: tri ? tri[2] : (konst ? konst[1] : null),
      viteType: typeTri ? typeTri[2] : (typeConst ? typeConst[1] : null),
      kind: (blk.match(/kind:\s*'([^']+)'/) || [])[1] || 'app',
    });
  }
  return out;
}

console.log('=== 0. 先确认产物是新的（否则后面全是误判）===');
/*
 * 这一节是教训的直接产物：我曾用 3 天前的旧 dist 判断
 * "color-picker / icon-picker 没被纳入构建"，差点误报一个不存在的 bug。
 *
 * 判断依据：dist/index.html 的 mtime 必须**不早于**源码里最晚修改的
 * 插件文件。比"距今多少天"可靠 —— 后者在几天没改动时会误报。
 */
if (!fs.existsSync(DIST)) {
  console.log('❌ dist/ 不存在 —— 请先 npm run build');
  process.exit(1);
}
const distMtime = fs.statSync(path.join(DIST, 'index.html')).mtimeMs;
let newestSrc = 0;
let newestFile = '';
for (const dir of ['plugins', 'js', 'src', 'css']) {
  const base = path.join(HERE, dir);
  if (!fs.existsSync(base)) continue;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = fs.statSync(p).mtimeMs;
        if (m > newestSrc) { newestSrc = m; newestFile = path.relative(HERE, p); }
      }
    }
  };
  walk(base);
}
const stale = newestSrc > distMtime;
if (stale) {
  warns.push(`产物比源码旧（最新源码: ${newestFile}）—— 请重新 npm run build 再检查`);
}
t('dist/index.html 不早于最新源码（产物是新的）', !stale,
  stale ? `最新源码 ${newestFile} 比产物新` : '');

console.log('\n=== 1. 每个 registry 插件的入口都在 dist 里 ===');
const plugins = parseRegistry();
t('解析出插件清单', plugins.length > 0);
for (const p of plugins) {
  if (!p.viteEntry) continue;
  const rel = p.viteEntry.replace(/^\.\//, '');
  const abs = path.join(DIST, rel);
  const ok = fs.existsSync(abs);
  /*
   * Vite 模式下：
   *   · iframe 插件 → entry 是 .html，由 rollup input 产出，应在 dist
   *   · module 插件 → entry 是 module.tsx，由 import.meta.glob 产出 chunk，
   *     **不会以原名出现在 dist**（chunk 名是哈希）
   *
   * 所以 module 类型不能用"文件存在"判断 —— 那是错的判据。
   */
  if (p.viteType === 'module') {
    t(`${p.id}（同页 module）入口不要求以原名存在（glob 产出 chunk）`, true);
    continue;
  }
  t(`${p.id} 的 ${rel} 存在于 dist`, ok, ok ? '' : 'Vite 模式 iframe 插件入口应是 rollup input');
}

console.log('\n=== 2. N62：122 个预设图标真的拷进去了 ===');
const iconDir = path.join(DIST, 'plugins/project-group/preseticons');
const icos = fs.existsSync(iconDir)
  ? fs.readdirSync(iconDir).filter((f) => f.endsWith('.ico'))
  : [];
t('dist/plugins/project-group/preseticons/ 存在', fs.existsSync(iconDir));
t(`里面有 .ico（期望 ~122，实际 ${icos.length}）`, icos.length > 100,
  icos.length === 0 ? '**图标全没了**（N62 的 bug 回来了）' : '');

console.log('\n=== 3. Mindmap 的 kity 内核（原生子目录另一条）===');
const edDir = path.join(DIST, 'plugins/mindmap/editor');
t('dist/plugins/mindmap/editor/ 存在', fs.existsSync(edDir));
if (fs.existsSync(edDir)) {
  const files = fs.readdirSync(edDir);
  t('含 kity.min.js', files.includes('kity.min.js'));
  t('含 kityminder.core.min.js', files.includes('kityminder.core.min.js'));
}

console.log('\n=== 4. N54：home 在 Vite 下是否真走同页 ===');
const home = plugins.find((p) => p.id === 'home');
t('registry 里有 home', !!home);
if (home) {
  t('home 的 Vite type 是 module（嵌合已落地）', home.viteType === 'module',
    `实际 ${home.viteType}`);
  t('home 的 Vite entry 是 module.tsx（符合 glob 命名约定）',
    /module\.(tsx|ts|js|mjs)$/.test(home.viteEntry || ''), `实际 ${home.viteEntry}`);
  /*
   * glob 产出的是 chunk，无法按原名核对。但可以核**约束**：
   * 如果它是 iframe 类型却给 .tsx 入口，构建必然 404 —— 这条能挡住。
   */
  t('不存在「iframe 类型却用非 .html 入口」的插件（否则必 404）',
    plugins.every((p) => p.viteType !== 'iframe' || (p.viteEntry || '').endsWith('.html')));
}

console.log('\n=== 5. 无构建示例插件（PLAIN_PLUGINS 整目录拷贝）===');
for (const id of ['demo-iframe', 'demo-module', 'demo-light']) {
  const dir = path.join(DIST, 'plugins', id);
  t(`dist/plugins/${id}/ 存在`, fs.existsSync(dir));
}

console.log('\n=== 6. 外壳入口 ===');
t('dist/index.html 存在', fs.existsSync(path.join(DIST, 'index.html')));
t('dist/assets/ 有产物', fs.existsSync(path.join(DIST, 'assets')));

console.log('\n=== 7. 反向检查：不该多出来的东西 ===');
/*
 * .tsx/.ts 源文件**不该**原样出现在 dist ——
 * 若出现，说明某处变成了"整目录拷贝"，那会盖掉打包产物
 * （vite.config 注释里明确警告过这一点）。
 */
const strayTsx = [];
const scanTs = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) scanTs(p);
    else if (/\.(tsx|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) strayTsx.push(path.relative(DIST, p));
  }
};
if (fs.existsSync(path.join(DIST, 'plugins'))) scanTs(path.join(DIST, 'plugins'));
t('dist/plugins 下没有原样拷贝的 .ts/.tsx 源文件', strayTsx.length === 0,
  strayTsx.length ? `发现 ${strayTsx.length} 个: ${strayTsx.slice(0, 3).join(', ')}` : '');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (warns.length) {
  console.log('\n⚠️  注意：');
  for (const w of warns) console.log(`   ${w}`);
}
if (fail) {
  console.log(`
产物不完整。最常见的原因：
  1. 没跑构建，或跑的是旧产物 —— npm run build 后再 npm run check:dist
  2. vite.config.ts 的 NATIVE_SUBDIRS 被改动 —— 它负责拷贝 preseticons 与 mindmap/editor
  3. 新增了 iframe 插件但入口不是 index.html —— buildInputs 只扫 index.html`);
}
process.exit(fail ? 1 : 0);
