#!/usr/bin/env node
/**
 * 运行时模块图 / 12 仓共享镜像自足守卫（第 214 轮）
 * ============================================================================
 *
 * 与上游第 64 轮 ⑧ 节互补，不重复
 * ------------------------------------------------------------
 * 并行窗口第 64 轮（P0）已把第 63 轮那句
 *   import { checkSingleFile } from '../scripts/single-file.mjs'
 * 修成 js/single-file-shape.mjs（零依赖），并在 installed-frame-test.mjs ⑧ 节
 * 从 js/host.js 做 BFS、vm 隔离 realm 真加载，钉住主壳闭包零 node:。
 * 本守卫**不重做那半截**，只补它没覆盖的另一半：
 *
 *   · 入口用 index.html 里真正的 <script type="module">（js/shell.js），
 *     不是 host.js —— 主面板是从 shell 起加载的；
 *   · ⑧ 节的 crossScripts 只查 `js/ → scripts/` 这一种越界；这里按
 *     **共享镜像口径 js/ css/ src/** 做通用越界判据；
 *   · ⑧ 节的 vm 探针验的是「主仓能加载」；这里验的是
 *     **12 个插件仓的形状**：它们只有 js/ css/ src/，没有 scripts/，
 *     也没有根级测试工具。造一个只有 js/ 的模拟仓真 import，硬证据。
 *
 * 第 63 轮那句断链的两处实测后果（修复前）：
 *   · 主仓无构建模式下浏览器原生 ESM 解析 node:path 在模块图实例化阶段
 *     失败 —— 不是已安装插件打不开，而是 shell.js → host.js 整条链
 *     加载不了、主面板白屏；
 *   · 插件仓镜像里根本没有 scripts/single-file.mjs，Node 实测
 *     `ERR_MODULE_NOT_FOUND`。
 * 而第 63 轮守卫 ⑥g 把「必须 import ../scripts/single-file.mjs」钉成了
 * 契约，断链被当成正确形状守着 —— 18 套守卫全绿（都跑在 Node）。
 *
 * 本守卫钉四件事：
 *   ① 从 index.html 的 module script 出发做**静态** import BFS，闭包里
 *      不许有 node: / 裸包名，相对 import 全部指向存在的文件；
 *   ② js/ css/ src/ 镜像口径内的文件，静态 import 不许指向口径外；
 *   ③ 行为层真跑：只有 js/ 的模拟插件仓能加载 installed-frame.js，
 *      把它改回旧 import 时必须 ERR_MODULE_NOT_FOUND；
 *   ④ 元断言：注释喂饱反例、空图防空跑、判据不恒真不恒假。
 *
 * ⚠️ 只管**静态** import。动态 import('@tauri-apps/api/*') 是 tauri-core.js
 * 与 host.js 刻意保留的降级通道（try/catch 吞掉，无构建模式下照常跑）；
 * 但静态 node: 连 catch 都来不及，浏览器在实例化阶段就拒了。
 *
 * 零外部依赖，按 import.meta.url 定位根，从任意 cwd 可跑。
 */

import {
  readFileSync, existsSync, readdirSync, writeFileSync, cpSync,
  mkdtempSync, rmSync,
} from 'node:fs';
import { join, dirname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripCommentsJs } from './test-scan-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const r = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');
const has = (p) => existsSync(join(ROOT, p));
/* 路径统一成相对 ROOT 的 / 形式，避免 Windows 分隔符把前缀判据判歪。 */
const relOf = (p) => normalize(p).split(sep).join('/');
const joinRel = (base, spec) => relOf(join(dirname(base), spec));
const IN_MIRROR = /^(js|css|src)\//;
const SHAPE = 'js/single-file-shape.mjs';

let pass = 0;
let fail = 0;
function t(name, ok, info = '') {
  if (ok) { pass += 1; return; }
  fail += 1;
  console.log(`  ✗ ${name}${info ? ` — ${info}` : ''}`);
}

/** 只取**静态** import / export-from 说明符（剥注释走公共设施）。 */
function staticImports(src) {
  const s = stripCommentsJs(String(src || ''));
  const out = [];
  for (const m of s.matchAll(/(?:^|[\s;])(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  /* 副作用 import（import './x.js'）。负向前瞻排掉 `import ('x')` 动态形态。 */
  for (const m of s.matchAll(/(?:^|[\s;])import\s+(?!\()['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/** 静态 import BFS。read/has 可注入，便于喂合成图做元断言。 */
function walk(entry, opts = {}) {
  const read = opts.read || r;
  const exists = opts.has || has;
  const seen = new Map();
  const queue = [entry];
  const bad = [];
  const missing = [];
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    if (!exists(cur)) { missing.push({ from: cur, spec: entry, to: cur, why: 'entry-missing' }); continue; }
    const specs = staticImports(read(cur));
    seen.set(cur, specs);
    for (const spec of specs) {
      if (/^node:/.test(spec) || !spec.startsWith('.')) {
        bad.push({ from: cur, spec, why: /^node:/.test(spec) ? 'node-builtin' : 'bare-specifier' });
        continue;
      }
      const nxt = joinRel(cur, spec);
      if (!exists(nxt)) missing.push({ from: cur, spec, to: nxt, why: 'missing' });
      else queue.push(nxt);
    }
  }
  return { seen, bad, missing };
}

/** 镜像口径内 → 口径外的静态 import。12 仓只有 js/ css/ src/，越界即断链。 */
function mirrorEscapes(graph) {
  const out = [];
  for (const [rel, specs] of graph.seen) {
    if (!IN_MIRROR.test(rel)) continue;
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const nxt = joinRel(rel, spec);
      if (!IN_MIRROR.test(nxt)) out.push({ from: rel, spec, to: nxt });
    }
  }
  return out;
}

/** 唯一的合格判据。抽成函数是为了让元断言能验它不恒真 / 不恒假。 */
function graphOk(graph) {
  return graph.seen.size >= 20
    && graph.bad.length === 0
    && graph.missing.length === 0
    && mirrorEscapes(graph).length === 0;
}

/* ---------------- ① 真模块图：从 index.html 的 module script 出发 ---------------- */
const html = r('index.html');
const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
const entry = entryMatch ? relOf(entryMatch[1].replace(/^\.\//, '')) : '';
t('①a index.html 能解析出 type="module" 入口', entry === 'js/shell.js', String(entry));
const graph = walk(entry);
t('①b 模块闭包非空（防空跑假绿）', graph.seen.size >= 20, `实际 ${graph.seen.size} 个文件`);
t('①c 闭包里没有静态 node: / 裸包名 import',
  graph.bad.length === 0, JSON.stringify(graph.bad.slice(0, 3)));
t('①d 闭包里静态相对 import 全部指向存在的文件',
  graph.missing.length === 0, JSON.stringify(graph.missing.slice(0, 3)));
const esc = mirrorEscapes(graph);
t('①e 镜像口径内没有指向 js/css/src 之外的静态 import',
  esc.length === 0, JSON.stringify(esc.slice(0, 3)));
t('①f 真模块图整体合格', graphOk(graph) === true);
t('①g installed-frame.js 确实在闭包里（不是没扫到它）',
  graph.seen.has('js/installed-frame.js'));
t('①h 闭包里不含 scripts/ 下的文件',
  ![...graph.seen.keys()].some((p) => p.startsWith('scripts/')),
  [...graph.seen.keys()].filter((p) => p.startsWith('scripts/')).join(','));
t('①i 入口是 shell.js 而非 host.js（与上游 ⑧ 节的 BFS 起点互补）',
  entry === 'js/shell.js' && graph.seen.has('js/host.js'));

/* ---------------- ② 镜像自足：只按 webview 运行时模块图口径 ----------------
 * js/ 里混着 Node 侧扫描脚本（dead-class-scan.js / plugin-modes.js /
 * style-audit.js），它们 import 根级 ../test-scan-utils.mjs，由 Node 直接跑、
 * 不进 webview 模块图。按「js/ 全量文件」判越界会把这些既有形状误报成新洞；
 * 按「闭包内文件」判才是 12 仓镜像自足的准确口径 —— 这不是按文件名加白名单，
 * 是按模块图切，见 ②g 的反例元断言。 */
const runtimeJs = [...graph.seen.keys()].filter((p) => p.startsWith('js/'));
const jsEscapes = [];
for (const f of runtimeJs) {
  for (const spec of staticImports(r(f))) {
    if (!spec.startsWith('.')) continue;
    const nxt = joinRel(f, spec);
    if (!IN_MIRROR.test(nxt)) jsEscapes.push({ from: f, spec, to: nxt });
  }
}
t('②a 闭包内确实扫到 js/ 文件（防空跑）', runtimeJs.length >= 20, `实际 ${runtimeJs.length}`);
t('②b 闭包内 js/ 文件的静态 import 没有越出共享镜像口径',
  jsEscapes.length === 0, JSON.stringify(jsEscapes.slice(0, 3)));
const frameSrc = stripCommentsJs(r('js/installed-frame.js'));
t('②c installed-frame.js import 的是同目录零依赖判据模块',
  /from\s*['"]\.\/single-file-shape\.mjs['"]/.test(frameSrc)
  && !/from\s*['"]\.\.\/scripts\//.test(frameSrc));
t('②d 判据模块零 import（不自拽 node: 或镜像外路径）',
  staticImports(r(SHAPE)).length === 0, JSON.stringify(staticImports(r(SHAPE))));
t('②e 构建期 single-file.mjs 仍 re-export 同一份判据',
  /export\s*\{[\s\S]*?checkSingleFile[\s\S]*?\}\s*from\s*['"]\.\.\/js\/single-file-shape\.mjs['"]/.test(r('scripts/single-file.mjs')));
const pureGraph = walk(SHAPE);
t('②f 判据模块单独成图：闭包恰好 1 个、零越界零缺失（12 仓最小闭环）',
  pureGraph.seen.size === 1 && pureGraph.bad.length === 0
  && pureGraph.missing.length === 0 && mirrorEscapes(pureGraph).length === 0,
  JSON.stringify({ n: pureGraph.seen.size, bad: pureGraph.bad, missing: pureGraph.missing }));
const withNodeSide = new Map(graph.seen);
withNodeSide.set('js/dead-class-scan.js', ['../test-scan-utils.mjs']);
t('②g 判据按模块图口径而非文件名豁免（Node 侧脚本入图即报越界）',
  mirrorEscapes({ seen: withNodeSide }).some((e) => e.from === 'js/dead-class-scan.js'));

/* ---------------- ③ 行为层：模拟插件仓（只有 js/）真加载 ----------------
 * 12 仓的共享镜像只含 js/ css/ src/。造一棵只有 js/ 的树，用子进程
 * 真 import installed-frame.js —— 静态 BFS 说「没越界」不等于「能加载」。 */
function loadInSim(revert) {
  let sim = '';
  let out = '';
  let code = -1;
  try {
    sim = mkdtempSync(join(ROOT, '_r214_mirror_sim_'));
    cpSync(join(ROOT, 'js'), join(sim, 'js'), { recursive: true });
    if (revert) {
      const p = join(sim, 'js', 'installed-frame.js');
      const s = readFileSync(p, 'utf8').replace(
        "from './single-file-shape.mjs'", "from '../scripts/single-file.mjs'");
      writeFileSync(p, s);
    }
    const target = 'file://' + join(sim, 'js', 'installed-frame.js');
    const proc = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import(${JSON.stringify(target)}).then(()=>console.log('OK')).catch(e=>{console.log('FAIL '+e.code+' '+e.message);process.exit(1)})`],
      { encoding: 'utf8', timeout: 30000 });
    out = (proc.stdout || '') + (proc.stderr || '');
    code = proc.status;
  } catch (e) {
    out = String((e && e.message) || e);
  } finally {
    if (sim) { try { rmSync(sim, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ } }
  }
  return { out, code };
}
{
  const good = loadInSim(false);
  t('③a 只有 js/ 的模拟插件仓能加载 installed-frame.js（镜像自足）',
    good.code === 0 && /^OK/m.test(good.out),
    `exit=${good.code} ${good.out.slice(0, 160)}`);
  t('③b 成功路径里没有 ERR_MODULE_NOT_FOUND', !/ERR_MODULE_NOT_FOUND/.test(good.out));
  /* 行为层反向验证：把 import 换回旧写法，模拟仓必须报「文件不存在」。
     不改生产文件，证据比静态判据更硬。 */
  const bad = loadInSim(true);
  t('③c 把 import 换回 ../scripts/single-file.mjs 时模拟仓加载失败',
    bad.code !== 0 && /ERR_MODULE_NOT_FOUND/.test(bad.out),
    `exit=${bad.code} ${bad.out.slice(0, 160)}`);
  t('③d 失败证据点名的是 scripts/single-file.mjs（不是别的模块）',
    /scripts\/single-file\.mjs/.test(bad.out), bad.out.slice(0, 160));
}

/* ---------------- ④ 元断言：判据不恒真 / 不恒假 / 不被注释喂饱 ---------------- */
{
  t('④a staticImports 对空文本返回空', staticImports('').length === 0);
  const commentOnly = "/* import { resolve } from 'node:path'; */\nexport const x = 1;";
  t('④b 注释里的 node: import 不算静态 import（不喂饱判据）',
    staticImports(commentOnly).length === 0, JSON.stringify(staticImports(commentOnly)));
  const dynamicOnly = "export async function f(){ return await import('@tauri-apps/api/core'); }";
  t('④c 动态 import 不算静态 import（降级通道不误报）',
    staticImports(dynamicOnly).length === 0, JSON.stringify(staticImports(dynamicOnly)));
  t('④d 真的静态 node: import 会被抓出来',
    staticImports("import { resolve } from 'node:path';").includes('node:path'));
  t('④e graphOk 对空图为假（防空跑）',
    graphOk({ seen: new Map(), bad: [], missing: [] }) === false);
  const fakeBad = { seen: new Map(Array.from({ length: 25 }, (_, i) => [`js/f${i}.js`, []])), bad: [{ from: 'js/a.js', spec: 'node:path' }], missing: [] };
  t('④f graphOk 对含 node: 的图为假（不恒真）', graphOk(fakeBad) === false);
  const fakeEscape = { seen: new Map([...Array.from({ length: 25 }, (_, i) => [`js/f${i}.js`, []]), ['js/x.js', ['../scripts/y.mjs']]]), bad: [], missing: [] };
  t('④g graphOk 对镜像越界的图为假（不恒真）', graphOk(fakeEscape) === false);
  t('④h graphOk 对真模块图为真（不恒假）', graphOk(graph) === true);
  t('④i mirrorEscapes 能点名越界文件与说明符',
    mirrorEscapes(fakeEscape).some((e) => e.from === 'js/x.js' && e.to === 'scripts/y.mjs'));
  const reverted = new Map(graph.seen);
  reverted.set('js/installed-frame.js', ['../scripts/single-file.mjs']);
  t('④j 把 import 换回 ../scripts/single-file.mjs 时镜像越界判据报红',
    mirrorEscapes({ seen: reverted }).length > 0);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
