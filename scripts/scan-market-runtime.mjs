/**
 * 市场逻辑层「运行时归属」判定
 * ============================================================================
 * 用途：回答一个被含糊了很多轮的问题——
 *   「编排层为何一直没接进产品？缺的到底是什么？」
 *
 * 实测答案不是「接线方案没定」，也不是「缺一个 IPC 命令」：
 *   Tauri 产品运行时只有 webview，invoke 只能调 Rust 命令，
 *   Rust 里跑不了 JS 编排层。而编排层的依赖闭包里有同步 node:fs、
 *   node:crypto 等 —— 在 webview 里 import 都过不去。
 *
 * 第 43 轮更正：**只看 `import node:*` 会漏两类同样致命的阻塞**
 *   · Buffer / process / __dirname / require 等 Node 专有全局
 *     —— 一个 node: 都不写，照样在 webview 里 ReferenceError；
 *   · 静态 import 链 —— 自己零 node: 的模块，只要 import 了
 *     一个带 node: 的模块，整条链一起加载不了。
 *     plugin-tarball.js 原先就是「只为拿 sniffArchive 而 import
 *     plugin-installer.js」，把 installer 顶层三个 node: 全拖进来。
 *
 * 本扫描器把这件事变成可执行判定：
 *   · closure       —— 从入口出发的所有本地相对 import
 *   · blocked/safe  —— 按 node: 内建 import 分流
 *   · nodeGlobals   —— 按 Node 专有全局分流
 *   · chainBlocked  —— 自身零 node: 但可达 blocked 的模块
 *
 * ⛔ 不做任何"顺手修好"的事：改同步 fs 为异步注入是独立一轮的改造，
 *    本模块只负责把阻塞面钉住，避免继续用"接线待定"含糊过去。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MARKET_ENTRY = 'js/plugin-market.js';

/** 只读这些目录下的 js —— 不递归全仓，避免把 dist/ 与插件副本算进来 */
export const SCAN_DIRS = ['js'];

/**
 * 剥注释。口径与 test-scan-utils.mjs 的 stripCommentsFlat(Js) 一致：
 *   · 块注释整体压成等量空白（保偏移，行号不会漂）
 *   · 行注释只认 (^|\s)//，避免把 https:// 与 file:// 吞掉
 * 这里刻意**不** import 那个公共设施：本脚本要能被守卫用另一套正则
 * 独立复核，共用同一份实现就变成"拿生成器验自己"。
 */
export function stripComments(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  s = s.replace(/(^|\s)\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  return s;
}

/** 一个文件里出现的 node: 内建模块名（排序去重） */
export function nodeBuiltinsOf(rel) {
  const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
  const re = /from\s*['"]node:([^'"]+)['"]|require\(\s*['"]node:([^'"]+)['"]\s*\)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1] || m[2]);
  return [...out].sort();
}

/** Node 专有全局。⛔ 只认「真的被用起来」的形态，注释已剥掉 */
export const GLOBAL_PATTERNS = [
  ['Buffer', /\bBuffer\s*[.[]/g],
  ['process', /\bprocess\s*\./g],
  ['__dirname', /\b__dirname\b/g],
  ['__filename', /\b__filename\b/g],
  ['require', /\brequire\s*\(/g],
];

export function nodeGlobalsOf(rel) {
  const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
  const out = new Set();
  for (const [name, re] of GLOBAL_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(src)) out.add(name);
  }
  return [...out].sort();
}

/** 一个文件里的本地相对 import（只认 ./ 开头，含 .js 后缀） */
export function localImportsOf(rel) {
  const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
  const re = /from\s*['"](\.\/[^'"]+)['"]|import\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] || m[2];
    const base = dirname(rel);
    out.add(join(base, spec).replace(/\\/g, '/'));
  }
  return [...out].sort();
}

/** 从编排层出发做 BFS，拿到完整本地依赖闭包（不含入口自身） */
export function marketClosure(entry = MARKET_ENTRY) {
  const seen = new Set([entry]);
  const queue = [entry];
  const rel = [];
  while (queue.length) {
    const cur = queue.shift();
    for (const dep of localImportsOf(cur)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      rel.push(dep);
      queue.push(dep);
    }
  }
  return rel.sort();
}

/**
 * 静态链污染：自身零 node: import，但沿本地 import 能走到 blocked 的模块。
 * 入口也在 universe 里 —— 它 import 了 blocked 依赖，同样算被拖死。
 */
export function chainBlockedOf(universe, blockedSet) {
  const out = [];
  for (const f of universe) {
    if (blockedSet.has(f)) continue;
    const seen = new Set([f]);
    const queue = [f];
    let hit = false;
    while (queue.length) {
      const cur = queue.shift();
      for (const dep of localImportsOf(cur)) {
        if (blockedSet.has(dep)) { hit = true; continue; }
        if (seen.has(dep)) continue;
        seen.add(dep);
        queue.push(dep);
      }
    }
    if (hit) out.push(f);
  }
  return out.sort();
}

/** 主判定结果 */
export function scanMarketRuntime() {
  const closure = marketClosure();
  const universe = [MARKET_ENTRY, ...closure];
  const nodeImports = {};
  const nodeGlobals = {};
  const blocked = [];
  const safe = [];
  for (const f of closure) {
    const mods = nodeBuiltinsOf(f);
    const globs = nodeGlobalsOf(f);
    if (globs.length) nodeGlobals[f] = globs;
    if (mods.length) {
      nodeImports[f] = mods;
      blocked.push(f);
    } else {
      safe.push(f);
    }
  }
  const chainBlocked = chainBlockedOf(universe, new Set(blocked));
  return { entry: MARKET_ENTRY, closure, blocked, safe, nodeImports, nodeGlobals, chainBlocked };
}

/** js/ 下所有模块文件名，供守卫做「集合完备性」独立反推 */
export function allJsModules() {
  const out = [];
  for (const d of SCAN_DIRS) {
    for (const f of readdirSync(join(ROOT, d))) {
      if (f.endsWith('.js')) out.push(`${d}/${f}`);
    }
  }
  return out.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = scanMarketRuntime();
  console.log(`入口: ${r.entry}`);
  console.log(`闭包: ${r.closure.length} 个模块`);
  console.log(`node: import 阻塞: ${r.blocked.length} / 可加载: ${r.safe.length}`);
  for (const f of r.blocked) console.log(`  阻塞 ${f} -> node:${r.nodeImports[f].join(', node:')}`);
  console.log(`Node 专有全局: ${Object.keys(r.nodeGlobals).length}`);
  for (const f of Object.keys(r.nodeGlobals)) console.log(`  全局 ${f} -> ${r.nodeGlobals[f].join(',')}`);
  console.log(`静态链被拖死: ${r.chainBlocked.length}`);
  for (const f of r.chainBlocked) console.log(`  链 ${f}`);
  console.log(JSON.stringify(r, null, 2));
}
