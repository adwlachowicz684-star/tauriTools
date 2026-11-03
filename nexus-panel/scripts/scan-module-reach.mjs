#!/usr/bin/env node
/**
 * 模块可达性扫描器 —— 找出「测通了但没接进产品」的孤儿模块
 * ============================================================================
 *
 * 为什么不能用「grep 文件名」来判孤儿（实测踩过）：
 *   `s.includes('plugin-fs')` 会把 `plugin-fs-bridge.js` 里所有提及算成
 *   `plugin-fs.js` 的引用；`plugin-store` 会吸收 `plugin-store-client`。
 *   粗统计一度给出「installer 有 8 个生产引用」这种完全错误的结论 ——
 *   **孤儿清单本身是假的，比没有清单更危险**。
 *
 * 判据（刻意保守）：
 *   · 只认「能解析成本地真实文件的相对/根相对路径字符串」，不是子串匹配
 *   · 先剥注释（复用 test-scan-utils 的 stripCommentsJs，全仓只此一份实现）
 *   · 字符串字面量整体收：静态 import / require / HTML script src /
 *     动态字符串路径（ICON_DIR 那类）一视同仁，宁可多算可达、不误报孤儿
 *   · 引用方区分「生产」与「测试」：测试 import 不算接线
 *
 * 可达性定义（这是关键，不是「单个文件有没有人 import」）：
 *   从**所有非测试源码入口**（index.html / src / plugins / config / scripts）
 *   加 js/shell.js 出发做 BFS。整组市场模块互相 import 形成一个闭环，
 *   闭环里每个文件都「有人引用」，但**整个闭环没有连到宿主** ——
 *   逐文件数引用看不出这件事，只有可达性看得出。
 *
 * 排除的根（防自证陷阱，见守卫注释）：
 *   · 守卫自身、本扫描器自身：它们必然含台账里的模块名字符串
 *   · scripts/probe-* 探针：只读不进 CI，引用了也不等于产品接线
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, extname } from 'node:path';
import { stripCommentsJs } from '../test-scan-utils.mjs';

const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.html']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'runtime-plugins', 'preseticons', 'editor', 'docs',
]);

export function collectFiles(root) {
  const out = [];
  function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.tmp-')) continue;
        walk(p);
      } else if (EXTS.has(extname(e.name))) out.push(p);
    }
  }
  walk(root);
  return out;
}

export const relOf = (root, p) => relative(root, p).replace(/\\/g, '/');

/** 测试文件判据。守卫、探针、公共设施都不算测试（它们形态不同，见各自注释）。 */
export function isTestFile(root, p) {
  const r = relOf(root, p);
  return /(-test\.(mjs|js|cjs|ts|tsx)$|\.test\.(ts|tsx|js)$|testkit\.mjs$|testkit\.js$)/.test(r)
    || /(^|\/)tests\//.test(r) || /\/__tests__\//.test(r);
}

/**
 * 把一个路径字符串解析成仓库内真实文件。
 * 只接受 `.` 或 `/` 开头：`js/foo.js` 这种不带前导点的文档字样不算引用。
 * 省略后缀的 ESM 写法（'./foo'）要补齐 .js/.mjs/.ts/.tsx 与 /index.js。
 */
export function resolveRef(root, fromFile, spec, fileSet) {
  if (typeof spec !== 'string') return null;
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const base = spec.startsWith('/')
    ? join(root, spec.slice(1))
    : resolve(dirname(fromFile), spec);
  for (const c of [base, base + '.js', base + '.mjs', base + '.ts', base + '.tsx', join(base, 'index.js')]) {
    if (fileSet.has(c)) return c;
  }
  return null;
}

/** 纯函数：一段源码里所有「能解析成本地文件」的引用目标。供元断言注入合成样本。 */
export function refsInCode(root, fromFile, code, fileSet) {
  const cleaned = stripCommentsJs(String(code));
  const out = new Set();
  const re = /['"]([^'"\n]+)['"]/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const target = resolveRef(root, fromFile, m[1], fileSet);
    if (target && target !== fromFile) out.add(target);
  }
  return [...out];
}

/** 这些文件不能当生产根：它们含台账模块名字符串，会把守卫自己「接上线」。 */
export function isMetaRoot(root, p) {
  const r = relOf(root, p);
  return r === 'orphan-modules-guard-test.mjs'
    || r === 'scripts/scan-module-reach.mjs'
    || /^scripts\/probe-/.test(r)
    || /-probe\.mjs$/.test(r);
}

export function scanModuleReach(root) {
  const files = collectFiles(root);
  const fileSet = new Set(files);
  const graph = new Map(files.map((f) => [f, refsInCode(root, f, safeRead(f), fileSet)]));

  const roots = files.filter((f) => {
    if (isTestFile(root, f) || isMetaRoot(root, f)) return false;
    const r = relOf(root, f);
    if (r === 'index.html' || r === 'index.react.html') return true;
    if (r.startsWith('js/')) return r === 'js/shell.js';
    return true;
  });

  const reachable = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of graph.get(cur) || []) {
      if (!reachable.has(nxt)) { reachable.add(nxt); queue.push(nxt); }
    }
  }

  const incoming = new Map(files.map((f) => [f, { prod: [], test: [] }]));
  for (const [from, tos] of graph) {
    for (const to of tos) {
      const bucket = incoming.get(to);
      if (!bucket) continue;
      (isTestFile(root, from) ? bucket.test : bucket.prod).push(relOf(root, from));
    }
  }

  const jsModules = files.filter((f) => {
    const r = relOf(root, f);
    return r.startsWith('js/') && r.endsWith('.js') && !r.endsWith('.d.ts');
  });
  const prodReach = [], testOnly = [], unreachable = [];
  for (const f of jsModules) {
    const r = relOf(root, f);
    if (reachable.has(f)) prodReach.push(r);
    else if ((incoming.get(f)?.test.length || 0) > 0) testOnly.push(r);
    else unreachable.push(r);
  }
  prodReach.sort(); testOnly.sort(); unreachable.sort();
  return { files, roots, graph, reachable, incoming, jsModules, prodReach, testOnly, unreachable };
}

function safeRead(f) {
  try { return readFileSync(f, 'utf8'); } catch { return ''; }
}

/** ① 的判据抽出来，供元断言测「判据恒真/恒假」。 */
export const orphansOk = (actual, knownKeys) =>
  JSON.stringify([...actual].sort()) === JSON.stringify([...knownKeys].sort());
