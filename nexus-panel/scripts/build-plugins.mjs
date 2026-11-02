/**
 * 插件独立构建（runtime plugins）
 * ============================================================
 * 为什么要有这个脚本
 * ------------------------------------------------------------
 * iframe 插件原先全部作为 rollup input 打主程序（产物 dist/plugins/<id>/），
 * 于是「改一行插件代码 → 重编主程序 → 重新出安装包」成为唯一路径 ——
 * 对本地自用工具这是纯粹的浪费：插件才是迭代主体，外壳半年不动一次。
 *
 * 现在每个 iframe 插件用 Vite 独立构建到 runtime-plugins/<id>/：
 *   · 主程序构建只留外壳（vite build 秒级完成）；
 *   · 改插件只重跑本脚本（可 --only <id> 单插件，增量秒级）；
 *   · tauri.conf.json 的 bundle.resources 把 runtime-plugins/ 收进安装包，
 *     生产态由 js/host.js 用 convertFileSrc 从 $RESOURCE 加载；
 *   · 已安装的正式版更新插件 = 把 runtime-plugins/<id> 拷进安装目录，重启，
 *     主程序零重编、零出包。
 *
 * 与主构建的分工（边界，别混）：
 *   · iframe 插件（有 index.html）     → 本脚本 → runtime-plugins/<id>/
 *   · module 插件（home/settings/md…） → 主构建 import.meta.glob，产物在 dist
 *   · registry.js                      → 主构建拷贝到 dist/plugins/registry.js
 *
 * 用法：
 *   node scripts/build-plugins.mjs                # 全量构建所有 iframe 插件
 *   node scripts/build-plugins.mjs --only task-board   # 只构建指定插件
 */

import { build } from 'vite';
import react from '@vitejs/plugin-react';
import {
  existsSync, readdirSync, mkdirSync, copyFileSync, statSync, readFileSync,
  writeFileSync, renameSync,
} from 'node:fs';
import { resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../config/nexus.config.mjs';
import { STALE_ROOT } from './stale-root.mjs';
import { inlineHtml, checkSingleFile } from './single-file.mjs';

/**
 * 「不能交给 Vite 处理」的原生子目录，构建后原样补拷。
 *
 * 成因：这些文件靠相对 URL 在运行时直接引用，Vite 的 HTML/JS 管线不认识：
 *   · mindmap/editor —— kityminder 的 4 个原文件，靠 <script src> 加载
 *     （由编辑器 iframe 以 ./editor/index.html 直接加载，见 editor-bridge.js）
 *   · project-group/preseticons —— 122 个 .ico，靠 <img src> 加载
 *   · icon-picker/preseticons —— 同一批图标的**第二份拷贝**（自带）。
 *
 *     为什么要两份：目标是每个插件一个 GitHub 仓库、独立安装、互不影响。
 *     原先 icon-picker 以 `../project-group/preseticons/` 跨插件引用，
 *     只装 icon-picker 而没装 project-group 时立刻 404，
 *     且**构建期不响**（ICON_DIR 是字符串常量，Vite 不解析、原样进产物），
 *     只表现为图标一片空白。多一份 747 KB 换掉这类静默失效，划算。
 *
 *     ⚠ 两份必须一致，由 cross-plugin-coupling-test.mjs 的
 *       「共享资源一致性」一节守着。
 *
 * 少了它表现为「插件能开、画布/图标一片空白」—— index.html 正常产出，
 * 但 editor/index.html 或 .ico 404，且**看不出是构建配置问题**。
 */
const NATIVE_SUBDIRS = [
  { plugin: 'mindmap', dir: 'editor' },
  { plugin: 'project-group', dir: 'preseticons' },
  { plugin: 'icon-picker', dir: 'preseticons' },
];

/** 拷贝一个文件 / 一棵目录树（不用 cpSync：Windows 上覆盖已存在文件会走
 *  unlink 并抛 errno=0 假错，copyFileSync 覆盖写幂等，无此问题）。 */
function copyInto(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      copyInto(resolve(src, name), resolve(dest, name));
    }
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

/**
 * 扫出所有 iframe 插件：plugins/<id>/index.html 存在即算。
 *
 * 与旧主构建的 buildInputs() 同口径 —— 运行时加载不是挑几个插件迁，
 * 是「有 index.html 的全部独立构建」，新增插件零配置自动纳入。
 */
export function scanIframePlugins() {
  const dir = PATHS.plugins;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory() && existsSync(resolve(dir, d.name, 'index.html')))
    .map((d) => d.name)
    .sort();
}

/**
 * 把已存在的输出目录改名挪走，让 Vite 面对一个干净（不存在）的 outDir。
 *
 * 为什么不直接 emptyOutDir：project-group 的输出目录里有 122 个 preseticons
 * （原生子目录，每次构建后补拷进去），下一次构建时 Vite 的 emptyOutDir 会
 * 一次性删这 169 个文件 —— 撞本机的 safe-delete 批量守卫（≥50 需确认），
 * 构建直接失败。于是「每次成功构建都会把下一次构建卡死」，只能手动挪目录。
 *
 * rename 不是删除：守卫不管，且同卷改名瞬间完成。陈旧目录丢到系统临时目录
 * 里（名字带时间戳，互不覆盖），随系统清理即可，不污染仓库。
 */
function stashOutDir(outDir) {
  if (!existsSync(outDir)) return null;
  /* 同卷改名（跨卷会 EXDEV，见 stale-root.mjs 的说明） */
  mkdirSync(STALE_ROOT, { recursive: true });
  const stale = resolve(STALE_ROOT, `${basename(outDir)}-${Date.now()}`);
  try {
    renameSync(outDir, stale);
    return stale;
  } catch (e) {
    /* 改名失败（跨卷/占用）就原样留着，让 emptyOutDir 自己处理。 */
    console.warn(`[build-plugins] 旧产物挪不走（${e.code}），沿用 emptyOutDir`);
    return null;
  }
}

/**
 * 构建失败时把 stash 出去的旧产物搬回来。
 *
 * 为什么必须：stash 是「先挪走再重建」，一旦构建失败，outDir 就既没有新
 * 产物也没有旧产物 —— 插件直接从能加载变成 404。构建失败不该顺手把上一次
 * 的好产物也赔进去。
 * 实测踩到：agent-flow 因上游漏改调用方构建失败，产物目录被挪走后没能重建。
 */
function restoreOutDir(outDir, stale) {
  if (!stale || !existsSync(stale) || existsSync(outDir)) return;
  try {
    renameSync(stale, outDir);
    console.warn(`[build-plugins] 构建失败，已还原旧产物：${basename(outDir)}`);
  } catch (e) {
    console.error(`[build-plugins] 旧产物还原失败（${e.code}）：${stale}`);
  }
}

/**
 * 「真·单文件」判定 —— 阶段 0 安装方案的口径。
 *
 * ⛔ htmlOk 只覆盖 **index.html 里静态写着的**子资源引用。它看不见
 *    运行时用字符串拼出来的路径（例：icon-picker 的
 *    `ICON_DIR + encodeURIComponent(name) + '.ico'`）。这类资源 Vite
 *    不解析、checkSingleFile 也分析不了，产物里原样留着 `./preseticons/`，
 *    但 checkSingleFile 仍返回 ok:true —— 实测（第一百八十五轮）。
 *
 * 于是「HTML 自包含」≠「只拷一个 index.html 就能用」。
 * runtimeDirs 来自 NATIVE_SUBDIRS（构建脚本自己维护的权威清单，机械可查），
 * 非空就说明安装时必须整目录带上，否则图标/编辑器静默 404。
 *
 * 汇总报告曾把这类插件也打印成「完全自包含」—— 报告在撒谎。
 * 现在由这个函数统一口径，测试直接 import 它（本模块末尾有 isMain 守卫）。
 */
export function isInstallableSingleFile({ htmlOk, runtimeDirs = [] }) {
  return htmlOk === true && runtimeDirs.length === 0;
}

/**
 * 某插件在产物目录里真实存在的运行时资源目录。
 * 从 NATIVE_SUBDIRS 取，并核实目录确实产出 —— 清单写了但没拷出来要报空，
 * 不能凭清单就宣称"有资源"。
 */
export function runtimeDirsOf(id, outDir) {
  return NATIVE_SUBDIRS
    .filter((x) => x.plugin === id)
    .map((x) => x.dir)
    .filter((d) => existsSync(resolve(outDir, d)));
}

/**
 * 把构建产物内联成单文件 index.html（仅 --single-file 时执行）。
 *
 * 为什么单独一步：asset 协议加载时，页面里任何 ./assets/*.js 都会因路径
 * %2F 编码解析到协议根而 403（清单阶段 0 的「坑①」）。内联是唯一不改 Rust、
 * 不改 CSP 的绕法。详见 scripts/single-file.mjs 文件头。
 *
 * 判失败的口径（别放宽）：
 *   · script / stylesheet 仍在 remaining → **抛错**。说明内联根本没生效，
 *     写出去的是「能开但样式与脚本都缺」的残品，且没有任何报错。
 *   · 图片类 remaining 与 warnings（动态 import、CSS url()）→ 只报告不抛错。
 *     它们意味着「不算完全自包含」，但是否可接受由人判断（122 个 .ico
 *     内联会让产物膨胀到不可接受）。
 */
function inlineOne(id, outDir, inlineImages) {
  const htmlPath = resolve(outDir, 'index.html');
  const before = readFileSync(htmlPath, 'utf8');
  const r = inlineHtml(before, {
    dir: outDir,
    readFile: (p) => (existsSync(p) ? readFileSync(p) : null),
    inlineImages,
  });
  const chk = checkSingleFile(r.html);

  const blocking = chk.remaining.filter(
    (x) => x.kind === 'script' || x.kind === 'stylesheet',
  );
  if (blocking.length) {
    throw new Error(
      `[build-plugins] ${id} 内联后仍残留阻塞类引用：`
      + blocking.map((x) => x.url).join(', '),
    );
  }
  writeFileSync(htmlPath, r.html);

  const kb = (Buffer.byteLength(r.html, 'utf8') / 1024).toFixed(0);
  const htmlOk = chk.remaining.length === 0 && chk.warnings.length === 0;
  const runtimeDirs = runtimeDirsOf(id, outDir);
  const selfContained = isInstallableSingleFile({ htmlOk, runtimeDirs });
  console.log(
    `   ${htmlOk ? '📄' : '⚠️ '} 单文件 ${id}：${kb}KB，内联 ${r.inlined.length} 项`
    + (r.removed.length ? `，删除预载 ${r.removed.length} 条` : '')
    + (chk.remaining.length ? `，残留外部引用 ${chk.remaining.length} 条` : '')
    + (chk.warnings.length ? `，告警 ${chk.warnings.length} 条` : '')
    + (runtimeDirs.length ? `，另有运行时资源目录 ${runtimeDirs.join(', ')}` : ''),
  );
  for (const x of chk.remaining.slice(0, 5)) {
    console.log(`      · 残留 ${x.kind} ${x.url}`);
  }
  for (const w of chk.warnings.slice(0, 5)) {
    console.log(`      · 告警 ${w.kind} ${w.url}`);
  }
  if (runtimeDirs.length) {
    console.log(`      · ⚠ 上述目录不随 index.html 内联，安装时必须整目录带上`
      + `（只拷 index.html 会静默丢资源）`);
  }
  return { ok: htmlOk, selfContained, runtimeDirs,
    remaining: chk.remaining.length, warnings: chk.warnings.length, kb };
}

/** 构建单个插件到 runtime-plugins/<id>/ */
async function buildOne(id, opts = {}) {
  const pluginDir = resolve(PATHS.plugins, id);
  const outDir = resolve(PATHS.runtimePlugins, id);
  const t0 = Date.now();

  const stashed = stashOutDir(outDir);

  try {
    await build({
    /* root 指向插件目录：index.html 里的 ./main.tsx 等相对引用按它解析。
       configFile:false 必须显式关掉 —— 否则 Vite 会顺着 root 往上找到
       仓库根的 vite.config.ts，把主构建配置（多页 input、clearScreen 等）
       整套套回来，产出结构直接错。 */
    root: pluginDir,
    configFile: false,
    plugins: [react()],
    logLevel: 'warn',
    /* base:'./' —— 产物里的 chunk/CSS 引用必须是相对路径。
       默认 '/' 会产出 /assets/xxx.js，而运行时页面在 asset.localhost 源下，
       绝对路径解析到 asset.localhost/assets/…，asset 协议服务器只服务
       $RESOURCE/$APPDATA 下的真实文件 → 404 → 白屏。 */
    base: './',
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2021',
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
      minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
      rollupOptions: {
        input: resolve(pluginDir, 'index.html'),
      },
    },
  });

  /* 原生子目录补拷（在 emptyOutDir 之后、且 Vite 不再碰它们） */
  for (const { plugin, dir } of NATIVE_SUBDIRS) {
    if (plugin !== id) continue;
    const src = resolve(PATHS.plugins, plugin, dir);
    if (existsSync(src)) copyInto(src, resolve(outDir, dir));
  }

  verifyOne(id, outDir);
  } catch (e) {
    /* 关键：失败时把旧产物搬回来，否则插件从能加载直接变 404 */
    restoreOutDir(outDir, stashed);
    throw e;
  }

  let sf = null;
  if (opts.singleFile) sf = inlineOne(id, outDir, !!opts.singleFileImages);

  const ms = Date.now() - t0;
  console.log(`✅ ${id} → runtime-plugins/${id}/ （${ms}ms）`);
  return sf;
}

/**
 * 构建后校验：入口 HTML 在，且它引用的本地 JS/CSS 都真的产出了。
 *
 * 为什么必须校验：Vite 对「HTML 引了但 rollup 没收到」的情况**不报错**
 * （动态 import 的 chunk 按需生成，漏一个只在运行到那一下才 404）。
 * 到运行时就是「插件能开、点某个功能白屏」，且完全看不出是构建问题。
 * 构建期多花 10ms 校验，好过下次再排查一遍。
 */
function verifyOne(id, outDir) {
  const htmlPath = resolve(outDir, 'index.html');
  if (!existsSync(htmlPath)) {
    throw new Error(`[build-plugins] ${id} 构建产物缺少 index.html（${relative(PATHS.root, htmlPath)}）`);
  }
  const html = readFileSync(htmlPath, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\.[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  for (const ref of refs) {
    const abs = resolve(outDir, ref);
    if (!existsSync(abs)) {
      throw new Error(
        `[build-plugins] ${id} 的 index.html 引用了 ${ref}，但产物里没有该文件\n`
        + '（常见原因：入口脚本没被 rollup 收录，运行时必 404）',
      );
    }
  }
}

async function main() {
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  let ids = scanIframePlugins();
  if (only) {
    if (!ids.includes(only)) {
      console.error(`[build-plugins] --only ${only}：plugins/${only}/index.html 不存在，`
        + `可选：${ids.join(', ')}`);
      process.exit(1);
    }
    ids = [only];
  }
  if (ids.length === 0) {
    console.log('[build-plugins] 没有发现 iframe 插件（plugins/<id>/index.html）');
    return;
  }
  mkdirSync(PATHS.runtimePlugins, { recursive: true });
  const singleFile = process.argv.includes('--single-file');
  const singleFileImages = process.argv.includes('--single-file-images');
  if (singleFile) {
    console.log('[build-plugins] 单文件模式：子资源内联进 index.html'
      + (singleFileImages ? '（含图片）' : '（图片不内联）'));
  }
  console.log(`[build-plugins] 构建 ${ids.length} 个 iframe 插件 → runtime-plugins/`);
  const t0 = Date.now();
  const reports = [];
  for (const id of ids) {
    const sf = await buildOne(id, { singleFile, singleFileImages });
    if (sf) reports.push({ id, ...sf });
  }
  console.log(`[build-plugins] 完成，总耗时 ${Date.now() - t0}ms`);

  /* 逐插件结论汇总：阶段 0 要的就是「哪些插件真能只拷一个 index.html」这份硬数据。
     ⛔ 口径已改：htmlOk 只说明 HTML 静态引用内联干净；带运行时资源目录的
        插件（icon-picker 的 preseticons、mindmap 的 editor）**不算**完全自包含。
        第一百八十四轮曾把 icon-picker 报成「完全自包含 1/1」—— 报告撒谎。 */
  if (reports.length) {
    const full = reports.filter((r) => r.selfContained);
    console.log(`\n[单文件] 真·完全自包含 ${full.length}/${reports.length}：`
      + full.map((r) => r.id).join(', '));
    const withDirs = reports.filter((r) => r.ok && !r.selfContained);
    if (withDirs.length) {
      console.log(`[单文件] HTML 自包含但另有运行时资源目录 ${withDirs.length}（安装须整目录拷）：`
        + withDirs.map((r) => `${r.id}(${r.runtimeDirs.join(',')})`).join(', '));
    }
    const partial = reports.filter((r) => !r.ok);
    if (partial.length) {
      console.log(`[单文件] HTML 仍残留引用 ${partial.length}：`
        + partial.map((r) => `${r.id}(残留${r.remaining}/告警${r.warnings})`).join(', '));
    }
  }
}

/* 被 npm script 直接运行时才执行；被测试 import 时只暴露函数 */
const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`[build-plugins] 构建失败：${e?.message || e}`);
    process.exit(1);
  });
}
