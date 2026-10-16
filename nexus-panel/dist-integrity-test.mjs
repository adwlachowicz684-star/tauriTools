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
 *   · N62 —— 122 个图标是否真的进了产物
 *
 * 运行时加载改造后（iframe 插件独立构建到 runtime-plugins/）：
 *   · 主构建（vite build）只产外壳 → 查 dist/；
 *   · 插件构建（build-plugins.mjs）→ 查 runtime-plugins/<id>/；
 *   · 本脚本同时看两侧，并核对"runtime 标记完整性"——
 *     registry 里 type:'iframe' 漏标 runtime:true 的插件，生产态会
 *     找不到入口（404 → 握手超时），这是新架构唯一不能静默的字段。
 *
 * 用法
 * ------------------------------------------------------------
 *   npm run build && npm run check:dist
 *   （npm run build 已内含 plugins:build，即 iframe 插件独立构建）
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
/* iframe 插件的独立构建产物目录（与 config/nexus.config.mjs 的
   RUNTIME_PLUGINS_DIR 同值；浏览器侧 host.js 里也有一份同名常量，
   三处一致性由本文件第 8 节钉住）。 */
const RT = process.env.NEXUS_RUNTIME_PLUGINS
  ? path.resolve(process.env.NEXUS_RUNTIME_PLUGINS)
  : path.join(HERE, 'runtime-plugins');

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
/*
 * 显式「跳过」—— 判据不适用于这一类插件时，不要写 t(…, true)：
 *   恒真且计入 pass，于是"这条其实没验"被混进通过数里。
 *   跳过必须看得见：单列计数并写进汇总行。
 */
let skipped = 0;
const skip = (name, why) => {
  skipped += 1;
  console.log(`⊘ ${name}（跳过：${why}）`);
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
      // 运行时加载标记：iframe 插件必须标（漏标 = 生产态 404 → 握手超时）
      runtime: /^\s*runtime:\s*true/m.test(blk),
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
/*
 * 必须查 index.html 本身，不能只查 dist/ 目录在不在：
 *   目录存在而 index.html 缺失（构建中途失败、或产物被清了一半）时，
 *   下面那句 statSync 直接抛 ENOENT —— **崩 ≠ 红**：进程崩在半路，
 *   既没有 ❌ 也没有汇总行，体检会把它当成"环境异常"而不是"产物不完整"，
 *   而真正的原因（少了一个文件）在报错里一个字都看不到。
 *   所以这里显式判定并打印结论，让产物半残这件事**看得见**。
 */
if (!fs.existsSync(DIST) || !fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log(`❌ ${path.relative(HERE, path.join(DIST, 'index.html'))} 不存在 —— dist 不完整，请先 npm run build`);
  /*
   * 这里原本只 `process.exit(1)`，**没有汇总行**。
   *   体检（sweep）靠汇总行读结论，读不到就归进"可疑/崩在半路"——
   *   于是"产物少了一个文件"这件有明确结论的事，
   *   在体检单上表现为一行看不出方向的异常。
   * 补上同格式的汇总行，让它和正常路径一样**带上数字退出**。
   */
  fail += 1;
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skipped} 项`);
  process.exit(1);
}
const distMtime = fs.statSync(path.join(DIST, 'index.html')).mtimeMs;
/*
 * 产物新鲜度拆成两侧（运行时加载改造后插件源码不再进 dist）：
 *   · 外壳源码（js/src/css）→ 比 dist/index.html；
 *   · 插件源码（plugins/）  → 比 runtime-plugins/<id>/index.html。
 * 混在一起比会把"改了插件忘了 plugins:build"误报成 dist 旧，
 * 也会把"改了外壳忘了 build"放过 —— 两边各自的时效各自判。
 */
const walkNewest = (base) => {
  let newest = 0;
  let file = '';
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) { newest = m; file = path.relative(HERE, p); }
      }
    }
  };
  if (fs.existsSync(base)) walk(base);
  return { newest, file };
};
const shellParts = ['js', 'src', 'css']
  .map((d) => ({ dir: d, ...walkNewest(path.join(HERE, d)) }));
const shellSrc = Math.max(...shellParts.map((p) => p.newest));
const shellNewestFile = shellParts.reduce((a, b) => (a.newest >= b.newest ? a : b)).file;
const staleShell = shellSrc > distMtime;
if (staleShell) {
  warns.push(`外壳产物比源码旧（最新源码: ${shellNewestFile}）—— 请重新 npm run build 再检查`);
}
t('dist/index.html 不早于外壳源码（js/src/css 产物是新的）', !staleShell,
  staleShell ? `最新源码 ${shellNewestFile} 比产物新` : '');

/* 插件侧时效：逐个 runtime 插件比对。整体取"runtime-plugins 下最新
   index.html"与"plugins/ 下最新源码"比 —— 单插件落后也会被抓住，
   提示语里点名是哪个插件。 */
const rtMtime = (() => {
  if (!fs.existsSync(RT)) return 0;
  let newest = 0;
  for (const d of fs.readdirSync(RT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(RT, d.name, 'index.html');
    if (fs.existsSync(f)) newest = Math.max(newest, fs.statSync(f).mtimeMs);
  }
  return newest;
})();
const { newest: pluginSrcNewest, file: pluginNewestFile } = walkNewest(path.join(HERE, 'plugins'));
const stalePlugins = rtMtime > 0 && pluginSrcNewest > rtMtime;
if (stalePlugins) {
  warns.push(`插件产物比源码旧（最新源码: ${pluginNewestFile}）—— 请重新 npm run plugins:build 再检查`);
}
t('runtime-plugins 不早于插件源码（plugins/<id> 产物是新的）', !stalePlugins,
  stalePlugins ? `最新源码 ${pluginNewestFile} 比插件产物新` : (rtMtime === 0 ? 'runtime-plugins 还没有产物，先 npm run plugins:build' : ''));

console.log('\n=== 1. 每个 registry 插件的入口都在产物里 ===');
const plugins = parseRegistry();
t('解析出插件清单', plugins.length > 0);
for (const p of plugins) {
  if (!p.viteEntry) continue;
  const rel = p.viteEntry.replace(/^\.\//, '');
  /*
   * 运行时加载改造后三类插件各有去处：
   *   · module 插件 → import.meta.glob 产出 chunk，**不会以原名出现在
   *     dist**（chunk 名是哈希），只能用约束判断，不能用"文件存在"；
   *   · runtime iframe 插件 → scripts/build-plugins.mjs 独立构建，
   *     入口在 runtime-plugins/<id>/index.html，**不在 dist**；
   *   · （无第三类：registry 里 iframe 必须标 runtime，见第 8 节）
   */
  if (p.viteType === 'module') {
    skip(`${p.id}（同页 module）入口存在性`, 'glob 产出 chunk，不会以原名出现在 dist');
    continue;
  }
  if (p.runtime) {
    const ok = fs.existsSync(path.join(RT, p.id, 'index.html'));
    t(`${p.id} 的 runtime-plugins/${p.id}/index.html 存在`, ok,
      ok ? '' : 'iframe 插件应由 scripts/build-plugins.mjs 独立构建（npm run plugins:build）');
    continue;
  }
  /* 不该到达这里：iframe 不标 runtime 会被第 8 节抓出来。防御性报错，
     避免将来第 8 节被改松时这里静默通过。 */
  t(`${p.id}（iframe 但未标 runtime）`, false, '见第 8 节：iframe 插件必须 runtime:true');
}

console.log('\n=== 2. N62：122 个预设图标真的拷进去了 ===');
const iconDir = path.join(RT, 'project-group/preseticons');
const icos = fs.existsSync(iconDir)
  ? fs.readdirSync(iconDir).filter((f) => f.endsWith('.ico'))
  : [];
t('runtime-plugins/project-group/preseticons/ 存在', fs.existsSync(iconDir));
t(`里面有 .ico（期望 ~122，实际 ${icos.length}）`, icos.length > 100,
  icos.length === 0 ? '**图标全没了**（N62 的 bug 回来了）' : '');

console.log('\n=== 3. Mindmap 的 kity 内核（原生子目录另一条）===');
const edDir = path.join(RT, 'mindmap/editor');
t('runtime-plugins/mindmap/editor/ 存在', fs.existsSync(edDir));
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
/*
 * demo-module 没有 index.html → 不进 runtime-plugins，仍由主构建
 * 整目录拷进 dist/plugins/demo-module/（无构建模式源码直出的兜底）。
 * demo-iframe / demo-light 有 index.html → 被 build-plugins.mjs 收编，
 * 产物在 runtime-plugins/ 下（改造前它们在 dist/plugins/，是 rollup input）。
 */
for (const id of ['demo-iframe', 'demo-light']) {
  const dir = path.join(RT, id);
  t(`runtime-plugins/${id}/ 存在`, fs.existsSync(dir));
}
t('dist/plugins/demo-module/ 存在', fs.existsSync(path.join(DIST, 'plugins/demo-module')));

console.log('\n=== 6. 外壳入口 ===');
t('dist/index.html 存在', fs.existsSync(path.join(DIST, 'index.html')));
t('dist/assets/ 有产物', fs.existsSync(path.join(DIST, 'assets')));
t('dist/plugins/registry.js 存在（运行时动态加载）',
  fs.existsSync(path.join(DIST, 'plugins/registry.js')));

console.log('\n=== 7. 反向检查：不该多出来的东西 ===');
/*
 * .tsx/.ts 源文件**不该**原样出现在产物里 ——
 * 若出现，说明某处变成了"整目录拷贝"，那会盖掉打包产物
 * （vite.config 注释里明确警告过这一点）。
 * 两侧产物都查：dist/plugins（PLAIN 拷贝）与 runtime-plugins/（插件构建）。
 */
const strayTsx = [];
const scanTs = (base, d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) scanTs(base, p);
    else if (/\.(tsx|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      strayTsx.push(path.relative(base, p));
    }
  }
};
if (fs.existsSync(path.join(DIST, 'plugins'))) scanTs(DIST, path.join(DIST, 'plugins'));
if (fs.existsSync(RT)) scanTs(RT, RT);
t('产物里没有原样拷贝的 .ts/.tsx 源文件', strayTsx.length === 0,
  strayTsx.length ? `发现 ${strayTsx.length} 个: ${strayTsx.slice(0, 3).join(', ')}` : '');

console.log('\n=== 8. runtime 标记完整性（运行时加载的护栏）===');
/*
 * registry 里 type:'iframe' 的插件必须标 runtime:true ——
 * 漏标的表现是生产态 iframe src 走相对路径（dist 里没有插件页面）
 * → 404 → 「握手超时（10s）」，且完全看不出是漏了一个字段。
 * module 插件反过来不能标 runtime：同页插件与外壳同文档，
 * 物理上无法独立构建（标了也不会有产物，纯误导）。
 */
const iframeNoRuntime = plugins.filter((p) => p.viteType === 'iframe' && !p.runtime);
t('所有 iframe 插件都标了 runtime:true', iframeNoRuntime.length === 0,
  iframeNoRuntime.length ? `漏标：${iframeNoRuntime.map((p) => p.id).join(', ')}` : '');
const moduleRuntime = plugins.filter((p) => p.viteType === 'module' && p.runtime);
t('没有 module 插件误标 runtime:true', moduleRuntime.length === 0,
  moduleRuntime.length ? `误标：${moduleRuntime.map((p) => p.id).join(', ')}` : '');

/* 目录名三处同源：config/nexus.config.mjs（RUNTIME_PLUGINS_DIR）、
   js/host.js（浏览器侧常量，不能 import config）、本测试。 */
const cfgSrc = fs.readFileSync(path.join(HERE, 'config/nexus.config.mjs'), 'utf8');
const hostSrc = fs.readFileSync(path.join(HERE, 'js/host.js'), 'utf8');
const cfgDir = (cfgSrc.match(/RUNTIME_PLUGINS_DIR\s*=\s*'([^']+)'/) || [])[1];
const hostDir = (hostSrc.match(/const RUNTIME_PLUGINS_DIR\s*=\s*'([^']+)'/) || [])[1];
t("config 与 host.js 的 RUNTIME_PLUGINS_DIR 一致", cfgDir === 'runtime-plugins' && hostDir === cfgDir,
  `config=${cfgDir} host=${hostDir}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skipped} 项`);
if (warns.length) {
  console.log('\n⚠️  注意：');
  for (const w of warns) console.log(`   ${w}`);
}
if (fail) {
  console.log(`
产物不完整。最常见的原因：
  1. 没跑构建，或跑的是旧产物 —— npm run build 后再 npm run check:dist
     （iframe 插件是独立构建：npm run plugins:build，可 --only <id> 单跑）
  2. scripts/build-plugins.mjs 的 NATIVE_SUBDIRS 被改动 —— 它负责拷贝
     preseticons 与 mindmap/editor 到 runtime-plugins/
  3. registry 新增了 iframe 插件但漏标 runtime:true —— 见第 8 节`);
}
process.exit(fail ? 1 : 0);
