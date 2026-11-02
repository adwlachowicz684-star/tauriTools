#!/usr/bin/env node
/**
 * 跨插件耦合扫描器 —— 拆独立仓库前的"拆得动吗"体检
 * ============================================================================
 *
 * 扫什么：插件源码里所有**越出自己目录、落到别的插件目录**的相对引用。
 *
 *     plugins/project-group/components/dialogCards.tsx:5
 *       import { ColorPicker } from '../../color-picker/ColorPicker';
 *                                     ^^^^^^^^^^^^^^^ 命中
 *
 * 为什么现在才需要它（此前几轮一直没查这一层）：
 *
 *   现状下这些引用**能正常工作**，因为它们解析到构建产物里的同一个
 *   `runtime-plugins/` 树、同一个 origin —— 所以构建不报错、界面不空白、
 *   任何现有守卫都不喊。它们是"现在没坏"的耦合，不是"没爆的 bug"。
 *
 *   但目标是**每个插件一个 GitHub 仓库、点安装即用、互不影响**。
 *   一旦独立安装：A 装了、B 没装，`../B/xxx` 立刻 404。
 *   ⛔ 这类失效最难查：index.html 正常产出、插件能打开，
 *      只是某个功能区域**一片空白** —— 与 build-plugins.mjs 里记的
 *      「插件能开、图标一片空白」是同一形状。
 *
 * ⚠️ 2026-11-03 实测更正（此前这层定性是错的，别再照着它选解耦方案）
 * ------------------------------------------------------------
 *   上面那段「A 装了 B 没装就 404」只对 **动态字符串路径** 成立
 *   （如 `const ICON_DIR = '../B/preseticons/'` —— Vite 不解析字符串，
 *     原样带进产物，运行时才去请求那条路径）。
 *
 *   而 `import ... from '../B/x'` / `@import '../B/x.css'` / `export * from`
 *   这类**静态导入在构建期就被内联打包**了，产物里根本不存在那条路径。
 *   实测（project-group 产物，07:39 那次真实构建）：
 *     · index.html 只引 `./assets/*`，全产物 0 个 `../` 相对引用
 *     · color-picker/style.css 的 249 个 fpx-* 类已合并进产物 CSS
 *     · 产物 JS 里的 `color-picker` 字样是**服务名** `call('color-picker',…)`，
 *       来自 plugin-sdk.js，不是文件路径
 *   所以这 4 条静态账**不阻断独立安装、运行时也不互相影响**；
 *   它们阻断的是**拆成独立仓库后源码构建期找不到文件**——阶段完全不同，
 *   解法也完全不同（构建期共享源码分发 / SDK 包，而不是运行时解耦）。
 *
 *   因此扫描器现在给每条命中打 `kind`，`runtimeRisk` 只对动态路径为真。
 *   守卫据此把红线钉在「运行时风险必须为 0」，而不是一味要求清零所有账。
 *
 * 判据（刻意保守，宁可漏报也不误报）：
 *   · 只认 `../<目录名>/` 且 <目录名> 恰好是某个插件 id —— 不猜
 *   · 剥注释后再扫：注释里的历史说明（`此前写的是 '../x/utils/color'`）
 *     不是真实引用，算进去就是噪声
 *   · 剥注释**保偏移**，否则行号对不上原文
 *
 * 不扫什么：
 *   · `../../../js/dialog.js` —— 指向宿主 SDK，不是插件，属正常依赖
 *   · 二进制资源目录（preseticons 等）—— 里面没有源码引用
 *   · 测试文件（`*-test.mjs` / `testkit.mjs`）—— 它们随仓库走，
 *     不构成"装了 A 没装 B 就 404"的运行时风险，混进来只会淹掉真信号
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, sep } from 'node:path';

const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'preseticons', 'editor', 'dist', 'docs']);
const SKIP_FILE = /(-test\.mjs|testkit\.mjs|\.d\.ts)$/;

/**
 * 剥注释但**保偏移**：注释内容除换行外一律换成空格。
 *
 * ⛔ 为什么不能直接用 stripComments（压成一个空格）：
 *    本扫描器要报**行号**。压成空格后偏移全乱，报出来的行号指向
 *    完全无关的另一行 —— 修的人按行号找过去什么都没有，
 *    比不报行号还糟。
 *
 * ⛔ 为什么行注释判据是 `(^|\s)//` 而不是裸 `//`：
 *    `https://`、`file://` 里的 `//` 前面是 `:`，裸判据会把 URL 之后
 *    的整行吞掉，扫到含链接的文件时得到一段被截断的文本（可能假绿）。
 *    真注释（行首、缩进后、行尾）的 `//` 前面必然是行首或空白，全覆盖。
 */
function blankComments(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 这个 `../xxx/` 是否落在 URL 里（`https://a.dev/../bbb/`）。
 *
 * ⛔ 为什么必须单独判：插件源码里大量出现 URL，而 URL 里的 `../bbb/`
 *    是**网络路径**的一部分，跟插件目录毫无关系。算进来就是误报，
 *    误报的下场是有人照着去"销账"，在台账里加一条根本不存在的欠账。
 *
 * ⛔ 为什么不能干脆跳过所有字符串字面量：本扫描器最重要的那条命中
 *    `const ICON_DIR = '../project-group/preseticons/'` **恰恰就是字符串** ——
 *    跳过字符串等于把真耦合全放掉。所以只能按"前面有没有 scheme"来判。
 */
function insideUrl(line, idx) {
  return /:\/\/\S*$/.test(line.slice(Math.max(0, idx - 16), idx));
}

/**
 * 这条引用是「构建期静态导入」还是「运行时动态路径」。
 *
 * ⛔ 顺序有讲究，调错会全判错：
 *    `export * from '../b/x'` 的前缀里同时含 `from`，先判 export 才是 re-export，
 *    否则会被下面的 import/from 吞成 static-import。
 *    `import {x} from '../b/x'` 前缀里有 `import` → static-import。
 *    `@import '../b/x.css'` 是 CSS 规则，单列一类（构建期同样内联）。
 *
 * ⛔ 为什么 dynamic-string 判据只看「命中前是不是引号开头」：
 *    真动态的典型是 `const ICON_DIR = '../b/preseticons/'` —— Vite 不解析
 *    字符串常量，路径原样进产物，运行时才发起请求。而静态导入的路径
 *    前面也有引号（`from '`、`@import '`），所以必须先让 import/export 判据
 *    吃掉它们，剩下的引号开头才是真动态。
 *
 * runtimeRisk 只对 dynamic-string / other 为真：只有它们会在运行时真去请求
 * 一条落到别的插件目录的路径，独立安装后才 404。
 */
export function classifyHit(line, idx) {
  const before = line.slice(0, idx);
  if (/@import/.test(before)) return 'css-import';
  if (/\bexport\b/.test(before)) return 're-export';
  if (/\bimport\b|\bfrom\b/.test(before)) return 'static-import';
  if (/["'`]\s*$/.test(before)) return 'dynamic-string';
  return 'other';
}

export const RUNTIME_RISK_KINDS = new Set(['dynamic-string', 'other']);

/** 列出 plugins/ 下的插件 id（有目录即算，manifest 另判） */
export function listPluginIds(root) {
  const dir = join(root, 'plugins');
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.') && statSync(join(dir, n)).isDirectory())
    .sort();
}

/** 是否有 nexus.plugin.json —— 有 = 要进市场（12 个 iframe 插件） */
export function isMarketPlugin(root, id) {
  return existsSync(join(root, 'plugins', id, 'nexus.plugin.json'));
}

/**
 * 扫全仓跨插件相对引用。
 * @param {string} root 仓库根（nexus-panel/）
 * @returns {Array<{file,line,target,owner,raw,blocking}>}
 */
export function scanCrossPlugin(root) {
  const ids = listPluginIds(root);
  const idSet = new Set(ids);
  const out = [];

  for (const owner of ids) {
    const base = join(root, 'plugins', owner);
    const walk = (dir) => {
      let ents;
      try { ents = readdirSync(dir); } catch { return; }
      for (const e of ents) {
        if (e.startsWith('.')) continue;
        const f = join(dir, e);
        let st;
        try { st = statSync(f); } catch { continue; }
        if (st.isDirectory()) {
          if (SKIP_DIRS.has(e)) continue;
          walk(f);
          continue;
        }
        if (!EXTS.has(extname(e)) || SKIP_FILE.test(e)) continue;
        let src;
        try { src = readFileSync(f, 'utf8'); } catch { continue; }
        const clean = blankComments(src);
        const lines = clean.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const re = /(\.\.\/)+([\w.-]+)\//g;
          let m;
          while ((m = re.exec(lines[i]))) {
            const target = m[2];
            if (!idSet.has(target) || target === owner) continue;
            if (insideUrl(lines[i], m.index)) continue;
            const kind = classifyHit(lines[i], m.index);
            out.push({
              file: f.replace(root + sep, '').split(sep).join('/'),
              line: i + 1,
              target,
              owner,
              raw: src.split(/\r?\n/)[i].trim().slice(0, 100),
              kind,
              /* 只有动态路径会在运行时真去请求别的插件目录 → 独立安装才 404。
                 静态导入在构建期内联，阻断的是「拆仓库后源码编译」，不是运行时。 */
              runtimeRisk: RUNTIME_RISK_KINDS.has(kind),
              /* 双方都要进市场 → 拆分时这条依赖要处理；
                 任一方不进市场（module 插件，随主程序构建）→ 不受拆分影响 */
              blocking: isMarketPlugin(root, owner) && isMarketPlugin(root, target),
            });
          }
        }
      }
    };
    walk(base);
  }
  return out;
}

/** 稳定 key，用于白名单比对 */
export const keyOf = (h) => `${h.file}:${h.line}->${h.target}`;

if (process.argv[1] && process.argv[1].endsWith('scan-coupling.mjs')) {
  const root = process.argv[2] || process.cwd();
  const hits = scanCrossPlugin(root);
  const blocking = hits.filter((h) => h.blocking);
  const runtime = hits.filter((h) => h.runtimeRisk);
  console.log(`跨插件引用 ${hits.length} 处（阻断拆分的 ${blocking.length} 处，其中运行时真会 404 的 ${runtime.length} 处）`);
  for (const h of hits) {
    const mark = h.runtimeRisk ? '🔴运行时' : h.blocking ? '🟡构建期' : '⚪';
    console.log(`  ${mark} [${h.kind}] ${h.file}:${h.line} → ${h.target}`);
    console.log(`      ${h.raw}`);
  }
}
