/**
 * 幽灵 import 守卫：凡是 import / require 一个**磁盘上不存在**的相对模块，必须报错。
 * ============================================================
 * 要防的形状：**删功能时漏删引用者**。
 *
 * 上游把 agent-flow 的任务板整体撤到独立插件 plugins/task-board，删掉了
 * `engine/taskBoard.ts`。而还有 5 个文件写着 `from '../engine/taskBoard'`：
 *   · 两个界面组件（TaskBoard.tsx / TaskBoardDetail.tsx）
 *   · 三个测试文件（session / boardCancelStatus / importTargets）
 * 后果不是"少几条断言"，而是：
 *   ① check-types 门禁直接判失败 → 两千八百多条测试**一条都跑不到**；
 *   ② 补好类型后能跑了，但那三个测试仍 MODULE_NOT_FOUND 崩掉 →
 *      退出码还是 1，报告上看着"只红了三个文件"，实际整套件当时不可信。
 *
 * 而残留之所以留得住，是因为删的人按模块名去搜引用时搜的是
 * `taskBoard.ts`（带扩展名），恰好漏掉了裸的 `'../engine/taskBoard'`。
 * **grep 漏一个词，就漏掉五个文件** —— 所以这条不能再靠人肉 grep。
 *
 * ⛔ 判据的四条硬约束（否则这条守卫自己就成了"看着在查、一条没验"）：
 *   ① **必须扫到足够多的文件与边**，并断言这个数 —— 扫 0 个文件时
 *      "没有幽灵 import" 恒真，全绿但什么都没验（本项目栽过多次）；
 *   ② **必须先剥注释** —— 注释里的示例路径会被当成真实 import，
 *      于是修好了也照样报红，红的是注释（本项目栽过两次）；
 *   ③ **解析必须走一次性建好的路径集合**，不能每条边去 existsSync：
 *      2000 条边 × 15 个候选扩展名 ≈ 3 万次 stat，在本仓库所在的慢盘上
 *      要跑几百秒 —— 表现是"脚本卡住"，卡住会被当成环境噪音跳过，
 *      于是这条守卫等于不存在（第一版就栽在这里，实测 35s→卡死）；
 *   ④ **自带反例自检**，且反例**自己造**、不依赖真实代码里恰好有这种写法。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join as pjoin, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './js/dead-class-scan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const fails = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else fails.push(`${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------- 一次性遍历：既收集源文件，也建好"磁盘上到底有哪些路径" ---------- */
const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', '_archive', '__pycache__',
  '.vite', 'coverage', '.cache', '__mi_selfcheck__',
]);
/* 只扫会被真正加载/编译的源码。docs/ 与 md 示例里出现的 import 是文档片段，
 * 不该被当成真实依赖（误报会诱使人去改文档）。 */
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

const srcFiles = [];
const onDisk = new Set();   // 所有已存在的文件路径（含 .json/.css/.svg/.png…）
function walk(dir) {
  let ents;
  try { ents = readdirSync(dir); } catch { return; }
  for (const e of ents) {
    if (SKIP_DIR.has(e)) continue;
    const p = pjoin(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p);
    else {
      onDisk.add(p);
      if (SRC_EXT.has(extname(e))) srcFiles.push(p);
    }
  }
}
walk(HERE);

/* ① 硬约束：扫到的文件数必须够多。扫 0 个 → 下面所有断言恒真。 */
t('扫描到的源文件数必须 > 200（否则是 walk 坏了，全绿也等于没验）',
  srcFiles.length > 200, `实际 ${srcFiles.length}`);
t('路径集合必须 > 1000 条（否则解析会把真实存在的文件判成不存在）',
  onDisk.size > 1000, `实际 ${onDisk.size}`);

/* ---------- 抽取相对 import ---------- */
/* 四种写法，全部**行首锚定**（多行 import 靠 [^'"`]* 跨行吃掉中间的花括号）：
 *   import … from '…' / export … from '…' / import '…' / require('…') / import('…')
 * 行首锚定是为了不吃进测试**夹具字符串**里的同形文本 —— 那些不是真依赖，
 * 报出来会诱使人去改夹具（第一版就有 6 条这种误报）。
 * 剥注释必须在抽取之前：注释里的示例路径同样会被当成真依赖。 */
const RE_FROM = /^[ \t]*(?:import|export)\b[^'"`]*?from[ \t]*['"]([^'"]+)['"]/gm;
const RE_BARE = /^[ \t]*import[ \t]+['"]([^'"]+)['"]/gm;
const RE_REQ = /\brequire[ \t]*\([ \t]*['"]([^'"]+)['"]/g;
const RE_DYN = /\bimport[ \t]*\([ \t]*['"]([^'"]+)['"]/g;

const CAND_EXT = [
  '', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.css',
  '/index.js', '/index.mjs', '/index.cjs', '/index.jsx',
  '/index.ts', '/index.tsx', '/index.json',
];

/** 相对模块名 → 磁盘上是否找得到（集合查表，零 stat） */
function resolveTarget(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const ext of CAND_EXT) {
    if (onDisk.has(base + ext)) return base + ext;
  }
  return null;
}

/** 长得像模块路径才算：带 ? 的查询串、模板里的 ${}、含空格的一律不是 */
function looksLikeSpec(s) {
  return /^\.\.?\//.test(s) && !/[?*${}\s]/.test(s);
}

/*
 * 显式豁免：必须「文件 + 模块名」成对给出，且**豁免本身要能被验证** ——
 * 这里断言该模块名确实还出现在那个文件里；夹具一删，豁免就变成
 * 一行永远生效的免死金牌，于是这条规则会被慢慢掏空。
 * （当下的唯一一条：`plugin-panel-actions-test.mjs` 里
 *   `.replace("await import('…/host.js')", 'hostMod')` 是把源码片段
 *   当作**字符串**改写后塞进 new Function，不是真依赖。）
 */
const ALLOW = [
  { file: 'plugin-panel-actions-test.mjs', spec: '../../js/host.js' },
];
for (const a of ALLOW) {
  const p = pjoin(HERE, a.file);
  let ok = false;
  try { ok = readFileSync(p, 'utf8').includes(a.spec); } catch { ok = false; }
  t(`豁免项仍然成立（${a.file} 里确实有 "${a.spec}" 这段文本）`, ok);
}
const allowKey = new Set(ALLOW.map((a) => a.file + '\u0000' + a.spec));

const edges = [];
const missing = [];
for (const f of srcFiles) {
  let src;
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  let code;
  try { code = stripComments(src); } catch { code = src; }
  const specs = new Set();
  for (const re of [RE_FROM, RE_BARE, RE_REQ, RE_DYN]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) specs.add(m[1]);
  }
  for (const s of specs) {
    if (!looksLikeSpec(s)) continue;
    edges.push([f, s]);
    if (!resolveTarget(f, s) && !allowKey.has(relative(HERE, f) + '\u0000' + s)) {
      missing.push([relative(HERE, f), s]);
    }
  }
}

/* ① 硬约束续：抽取到的相对 import 边也必须够多，否则是正则坏了。 */
t('抽取到的相对 import 边必须 > 300（否则是正则坏了，全绿也等于没验）',
  edges.length > 300, `实际 ${edges.length}`);

try { writeFileSync('/data/workspace/_mi_missing.json', JSON.stringify(missing, null, 1)); } catch {}

t('⛔ 不得 import 磁盘上不存在的相对模块（删功能时漏删引用者会让整套测试跑不起来）',
  missing.length === 0,
  missing.slice(0, 12).map(([f, s]) => `${f} → ${s}`).join(' | '));

/* ---------- 自检：判据自己不能失明 ---------- */
/* 反例自己造。注意：样本里的路径必须**拼出来**而不是写成字面量，
 * 否则本文件自己会命中规则（第一版就报了自己的 ./z.js / ./w.js）。 */
{
  const { mkdirSync, rmSync } = await import('node:fs');
  const tmp = pjoin(HERE, '__mi_selfcheck__');
  const a = pjoin(tmp, 'a.mjs');
  const real = pjoin(tmp, 'real.js');
  const P = './' + 'nope-not-here.js';
  const Q = './' + 'real.js';
  const R = './' + 'real';
  try {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(a, '', 'utf8');
    writeFileSync(real, '', 'utf8');
    onDisk.add(a); onDisk.add(real);
    t('自检：指向不存在文件的相对 import 必须被判为 missing',
      !resolveTarget(a, P));
    t('自检：存在的相对 import（带扩展名）不得误报', !!resolveTarget(a, Q));
    t('自检：存在的相对 import（无扩展名）不得误报', !!resolveTarget(a, R));
    rmSync(tmp, { recursive: true, force: true });
    onDisk.delete(a); onDisk.delete(real);
  } catch (e) {
    t('自检样本可写可读', false, String(e && e.message));
  }
}

/* 自检：四种写法都得抽得出来，不是只认了一种 */
{
  const D = './';
  const probe = [
    'import a from ' + "'" + D + "x.js'",
    'import ' + "'" + D + "y.css'",
    "const m = require('" + D + "z.js');",
    "const d = await import('" + D + "w.js');",
    "export { q } from '" + D + "v.js';",
  ].join('\n');
  const got = new Set();
  for (const re of [RE_FROM, RE_BARE, RE_REQ, RE_DYN]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(probe))) got.add(m[1]);
  }
  for (const want of [D + 'x.js', D + 'y.css', D + 'z.js', D + 'w.js', D + 'v.js']) {
    t(`自检：能抽出 import 写法 ${want}`, got.has(want), `抽到 ${[...got].join(',')}`);
  }
}

/* 自检：剥注释确实生效（否则注释里的示例路径会被当成真依赖） */
{
  const probe = "// import a from './only-in-comment.js';\nimport b from './real-target.js';\n";
  const stripped = stripComments(probe);
  RE_FROM.lastIndex = 0;
  const got = [...stripped.matchAll(RE_FROM)].map((m) => m[1]);
  t('自检：注释里的 import 不得被抽出', !got.includes('./only-in-comment.js'),
    `抽到 ${got.join(',')}`);
  t('自检：注释外的 import 仍要抽得出来', got.includes('./real-target.js'),
    `抽到 ${got.join(',')}`);
}

/* ---------- 结果 ---------- */
console.log(`[missing-import] 源文件 ${srcFiles.length} / 相对 import 边 ${edges.length}`);
if (fails.length) {
  console.error(`\n❌ missing-import-test：${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✅ missing-import-test：${pass} 通过 / 0 失败`);
