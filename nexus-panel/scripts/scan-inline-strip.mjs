/**
 * 内联剥注释实现扫描器
 * ============================================================
 * 背景：本仓库的扫描类测试大量做法是「读源码 → 剥注释 → 正则断言」。
 * 历史上各写一份剥注释，全仓出现过至少 5 种**语义不同**的形态：
 *
 *   · 块注释留空格 / 压成空串（后者会把相邻 token 粘成一个不存在的记号）
 *   · 行注释判据 `(^|\s)` / `(^|[^:])` / 裸 `\/\/`（裸判据会吞 https://）
 *   · 只剥块注释、不剥行注释
 *
 * 所以「把 16 份内联实现合并成一份」这个想法**不能直接做**：
 * 有几份的判据确实不同，机械替换会改变断言结果，而结果变化未必报红
 * （判据变松 → 假绿；变紧 → 误报）。这个扫描器先把实际形态分好类，
 * 由 inline-strip-audit-test.mjs 的台账决定哪些能安全销账。
 *
 * 设计约束：
 *   · 先剥注释再找命中 —— 否则注释里引用的正则原文会被算成真实现
 *     （test-scan-utils.mjs 文件头就引用了多种历史写法）。
 *   · 自身 / 公共设施 / 守卫一律排除，避免「台账字面量把文件判成已接线」
 *     那种自证陷阱（orphan-modules-guard 踩过）。
 *   · 只做分类，不做修改、不做判断。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { stripCommentsFlatJs } from '../test-scan-utils.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'runtime-plugins', 'target', 'coverage']);
const SKIP_FILES = new Set([
  'test-scan-utils.mjs', 'test-scan-fs.mjs',
  'inline-strip-audit-test.mjs', 'scan-inline-strip.mjs',
]);

const BLOCK_FLAT = String.raw`/\/\*[\s\S]*?\*\//g, ''`;
const BLOCK_SPACE = String.raw`/\/\*[\s\S]*?\*\//g, ' '`;
const LINE_SAFE = String.raw`(^|\s)\/\/`;
const LINE_COLON = String.raw`(^|[^:])\/\/`;
const LINE_BARE = String.raw`\/\/[^\n]*`;
const LINE_BARE2 = String.raw`\/\/.*$`;

/** 只看真代码里的 .replace(...) 调用行；注释已由调用方先剥掉 */
function stripLines(code) {
  return code.split('\n').filter((l) => l.includes('.replace(') || l.includes('replace('));
}

/**
 * 给单个文件分类。返回 null 表示「没有内联剥注释实现」。
 * kinds 可能多项（一个文件里同时有多种写法，saveguard 就是这样）。
 */
export function classifyInlineStrip(code) {
  const lines = stripLines(code);
  if (!lines.length) return null;
  const joined = lines.join('\n');
  const hasBlockFlat = joined.includes(BLOCK_FLAT);
  const hasBlockSpace = joined.includes(BLOCK_SPACE);
  const hasBlockAny = /\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//.test(joined);
  if (!hasBlockAny && !/\/\/[^\n]*/.test(joined)) return null;

  const kinds = new Set();
  if (hasBlockFlat) kinds.add('flat');
  if (hasBlockSpace) kinds.add('space');
  if (hasBlockAny && !hasBlockFlat && !hasBlockSpace) kinds.add('block-other');

  if (joined.includes(LINE_COLON)) kinds.add('line-colon');
  else if (joined.includes(LINE_SAFE)) kinds.add('line-safe');
  else if (joined.includes(LINE_BARE) || joined.includes(LINE_BARE2)) kinds.add('line-bare');

  if (!kinds.size) return null;
  return [...kinds].sort();
}

/** 扫全仓 .mjs，返回 [{file, kinds}]，file 为仓库相对路径（/ 分隔） */
export function scanInlineStrip(root) {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || name.startsWith('.tmp')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.mjs') || SKIP_FILES.has(basename(p))) continue;
      files.push(p);
    }
  }
  walk(root);

  const hits = [];
  for (const p of files) {
    let raw;
    try { raw = readFileSync(p, 'utf8'); } catch { continue; }
    // 已用公共设施的文件：即使注释里提到旧写法也不算内联实现
    if (/from\s+['"][^'"]*test-scan-(?:utils|fs)\.mjs['"]/.test(raw)) continue;
    const code = stripCommentsFlatJs(raw);
    const kinds = classifyInlineStrip(code);
    if (kinds) hits.push({ file: relative(root, p).split('\\').join('/'), kinds });
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file));
}
