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
} from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../config/nexus.config.mjs';

/**
 * 「不能交给 Vite 处理」的原生子目录，构建后原样补拷。
 *
 * 成因：这些文件靠相对 URL 在运行时直接引用，Vite 的 HTML/JS 管线不认识：
 *   · mindmap/editor —— kityminder 的 4 个原文件，靠 <script src> 加载
 *     （由编辑器 iframe 以 ./editor/index.html 直接加载，见 editor-bridge.js）
 *   · project-group/preseticons —— 122 个 .ico，靠 <img src> 加载；
 *     icon-picker 服务还以 ../project-group/preseticons/x.ico 跨插件引用，
 *     两者解析到同一个 runtime-plugins/ 路径，同 origin，都能访问。
 *
 * 少了它表现为「插件能开、画布/图标一片空白」—— index.html 正常产出，
 * 但 editor/index.html 或 .ico 404，且**看不出是构建配置问题**。
 */
const NATIVE_SUBDIRS = [
  { plugin: 'mindmap', dir: 'editor' },
  { plugin: 'project-group', dir: 'preseticons' },
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

/** 构建单个插件到 runtime-plugins/<id>/ */
async function buildOne(id) {
  const pluginDir = resolve(PATHS.plugins, id);
  const outDir = resolve(PATHS.runtimePlugins, id);
  const t0 = Date.now();

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
  const ms = Date.now() - t0;
  console.log(`✅ ${id} → runtime-plugins/${id}/ （${ms}ms）`);
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
  console.log(`[build-plugins] 构建 ${ids.length} 个 iframe 插件 → runtime-plugins/`);
  const t0 = Date.now();
  for (const id of ids) {
    await buildOne(id);
  }
  console.log(`[build-plugins] 完成，总耗时 ${Date.now() - t0}ms`);
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
