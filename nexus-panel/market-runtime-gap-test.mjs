/**
 * 市场编排层「运行时归属」欠账守卫
 * ============================================================================
 * 钉住一件事：产品里至今没有装/卸/查更新能力，**不是因为接线方案没定**，
 * 而是逻辑层带着 Node 专有依赖，webview 里根本加载不了。
 *
 * 第 43 轮更正
 * ------------------------------------------------------------
 * 旧版只扫 `import node:*`，于是 29/0 全绿却漏了两类同样致命的阻塞：
 *   · Buffer / process / require 等 Node 专有全局（不写 import 也崩）
 *   · 静态 import 链（自己零 node:，被依赖方拖死）
 * 本轮销掉 market / tarball 两条账，并把两类盲区纳入独立反推。
 *
 * ⛔ 期望值必须用**独立算法**反推
 * ------------------------------------------------------------
 * 不能拿 scanMarketRuntime() 的结果验台账——那是拿生成器验自己，
 * 判据写错时两边一起错、测试照样绿。本守卫用另一套剥注释实现、
 * 另一套正则、另一套 BFS 独立扫 js/ 全量模块再求交。
 *
 * 已知边界（写在这里，不假装能守住）
 * ------------------------------------------------------------
 * 纯静态守卫挡不住「把某条主断言整行删掉」。这一层靠每轮破坏验证兜，
 * 与第 30/31/37 轮同形。真正跑进无 Node 全局的 realm 由
 * webview-runtime-test.mjs 负责（本守卫只做静态面）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, MARKET_ENTRY, allJsModules, marketClosure, scanMarketRuntime } from './scripts/scan-market-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEBT = join(HERE, 'scripts/market-runtime-debt.json');

let pass = 0;
const fails = [];
function t(name, ok, detail = '') {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

/** 独立剥注释：逐行状态机，与扫描器那套正则不同实现 */
function stripIndependent(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let s = line;
    if (inBlock) {
      const end = s.indexOf('*/');
      if (end < 0) { out.push(' '.repeat(s.length)); continue; }
      s = ' '.repeat(end + 2) + s.slice(end + 2);
      inBlock = false;
    }
    let guard = 0;
    while (guard++ < 50) {
      const start = s.indexOf('/*');
      if (start < 0) break;
      const end = s.indexOf('*/', start + 2);
      if (end < 0) {
        s = s.slice(0, start) + ' '.repeat(s.length - start);
        inBlock = true;
        break;
      }
      s = s.slice(0, start) + ' '.repeat(end + 2 - start) + s.slice(end + 2);
    }
    const linePos = s.indexOf('//');
    if (linePos >= 0 && !(linePos > 0 && s[linePos - 1] === ':')) s = s.slice(0, linePos);
    out.push(s);
  }
  return out.join('\n');
}

/** 独立正则：单/双引号的 node: 说明符，兼容多行 import */
const NODE_RE = /(?:import|from|require\()[^;\n]*?['"]node:([A-Za-z0-9_/-]+)['"]/g;
/** 独立正则：Node 专有全局（与扫描器的 5 条 pattern 不同实现） */
const GLOBAL_RE = /\bBuffer\s*[.[]|\bprocess\s*\.|\b__dirname\b|\b__filename\b|\brequire\s*\(/g;
/** 独立相对 import 正则：要求 .js 后缀，与扫描器口径不同 */
const IMPORT_RE = /from\s*['"](\.\/[^'"]+\.js)['"]/g;

function readStripped(rel) {
  return stripIndependent(readFileSync(join(ROOT, rel), 'utf8'));
}
function independentNodeScan(rel) {
  const out = new Set();
  let m;
  NODE_RE.lastIndex = 0;
  while ((m = NODE_RE.exec(readStripped(rel))) !== null) out.add(m[1]);
  return [...out].sort();
}
function independentGlobalScan(rel) {
  const src = readStripped(rel);
  const out = new Set();
  let m;
  GLOBAL_RE.lastIndex = 0;
  while ((m = GLOBAL_RE.exec(src)) !== null) {
    const hit = m[0];
    if (hit.startsWith('Buffer')) out.add('Buffer');
    else if (hit.startsWith('process')) out.add('process');
    else if (hit.startsWith('__dirname')) out.add('__dirname');
    else if (hit.startsWith('__filename')) out.add('__filename');
    else out.add('require');
  }
  return [...out].sort();
}
function independentImports(rel) {
  const src = readStripped(rel);
  const out = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    out.add(join(dirname(rel), m[1]).replace(/\\/g, '/'));
  }
  return [...out].sort();
}
/** 独立 BFS：自身零 node: 但可达 blocked 的模块（universe 含入口） */
function independentChain(universe, blockedSet) {
  const out = [];
  for (const f of universe) {
    if (blockedSet.has(f)) continue;
    const seen = new Set([f]);
    const queue = [f];
    let hit = false;
    while (queue.length) {
      const cur = queue.shift();
      for (const dep of independentImports(cur)) {
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

/* ---------------- ① 闭包与扫描器结果自洽 ---------------- */
const scan = scanMarketRuntime();
const closure = marketClosure();
const universe = new Set([MARKET_ENTRY, ...closure]);
const all = {};
const allGlobals = {};
for (const f of allJsModules()) {
  const mods = independentNodeScan(f);
  const globs = independentGlobalScan(f);
  if (mods.length) all[f] = mods;
  if (globs.length) allGlobals[f] = globs;
}
const expected = Object.keys(all).filter((f) => universe.has(f)).sort();
const expectedGlobals = Object.keys(allGlobals).filter((f) => universe.has(f)).sort();
const blockedSet = new Set(expected);
const expectedChain = independentChain([...universe].sort(), blockedSet);

t('①a 扫描器闭包与 BFS 一致',
  JSON.stringify(scan.closure) === JSON.stringify(closure),
  `scan=${scan.closure.length} bfs=${closure.length}`);
t('①b 闭包恰好 10 个模块且都在 js/ 下',
  closure.length === 10 && closure.every((f) => f.startsWith('js/') && existsSync(join(ROOT, f))),
  `closure=${closure.length}`);
t('①c 独立反推 node: 集合已销空（第 48 轮销掉 plugin-installer）',
  expected.length === 0, `expected=${expected.length}: ${expected.join(',')}`);
t('①d 入口自身已零 node: import（销账后不许悄悄加回来）',
  !all[MARKET_ENTRY], `entry=${JSON.stringify(all[MARKET_ENTRY] || null)}`);
t('①e 解包器已零 node: import',
  !all['js/plugin-tarball.js'], `tarball=${JSON.stringify(all['js/plugin-tarball.js'] || null)}`);

/* ---------------- ② 台账 entries 与实际完全一致 ---------------- */
let debt = null;
try { debt = JSON.parse(readFileSync(DEBT, 'utf8')); } catch (e) {
  t('②a 欠账台账可解析', false, String(e.message || e));
}
if (debt) {
  const files = (debt.entries || []).map((x) => x.file).sort();
  t('②a 台账集合 == 独立反推集合（多一条/少一条都红）',
    JSON.stringify(files) === JSON.stringify(expected),
    `台账=${files.length} 期望=${expected.length}`);
  for (const f of expected) {
    const row = (debt.entries || []).find((x) => x.file === f);
    t(`②b ${f} 的 node 列表与独立扫描一致`,
      !!row && JSON.stringify([...(row.node || [])].sort()) === JSON.stringify(all[f]),
      `台账=${JSON.stringify(row?.node)} 实测=${JSON.stringify(all[f])}`);
    t(`②c ${f} 带 why / unblock（欠账不是空头字符串）`,
      !!row && String(row.why || '').length > 20 && String(row.unblock || '').length > 20);
  }
  const resolved = (debt.resolved || []).map((x) => x.file).sort();
  t('②d 已销账恰为 6 个且都带 how / evidence',
    JSON.stringify(resolved) === JSON.stringify([
      'js/installed-plugin-scan.js', 'js/plugin-installer.js', 'js/plugin-ledger.js',
      'js/plugin-market.js', 'js/plugin-store-client.js', 'js/plugin-tarball.js',
    ])
      && (debt.resolved || []).every((x) => String(x.how || '').length > 30 && String(x.evidence || '').length > 10),
    `resolved=${resolved.join(',')}`);
  /* ②a 销空后变成 []===[] 恒真。补两条：台账状态与 installer 的销账记录，
     以及判据本身仍能识别一个真 node: 样本（否则「销账」可能只是判据坏了）。 */
  t('②a′ 台账 status=all-resolved 且 installer 有独立销账记录',
    debt.status === 'all-resolved' && debt.phase === 48
      && (debt.resolved || []).some((x) => x.file === 'js/plugin-installer.js'
        && /注入式/.test(String(x.how)) && /WebCrypto/.test(String(x.how))),
    `status=${debt.status} phase=${debt.phase}`);
  NODE_RE.lastIndex = 0;
  const nodeProbe = 'import { readFileSync } from ' + "'node:fs'" + ';';
  const probeHits = [];
  let pm;
  while ((pm = NODE_RE.exec(stripIndependent(nodeProbe))) !== null) probeHits.push(pm[1]);
  NODE_RE.lastIndex = 0;
  t('②a″ 销空后判据仍能识别真 node:fs 样本（防空集合假绿）',
    JSON.stringify(probeHits) === JSON.stringify(['fs']), `got=${probeHits.join(',')}`);
}

/* ---------------- ③ 盲区①：Node 专有全局 ---------------- */
if (debt) {
  const rows = ((debt.blindSpots || {}).globals || []).map((x) => x.file).sort();
  t('③a 全局盲区台账 == 独立反推（Buffer 这类不写 import 也崩的依赖）',
    JSON.stringify(rows) === JSON.stringify(expectedGlobals),
    `台账=${rows.join(',')} 实测=${expectedGlobals.join(',')}`);
  for (const f of expectedGlobals) {
    const row = ((debt.blindSpots || {}).globals || []).find((x) => x.file === f);
    t(`③b ${f} 的 names 与独立扫描一致`,
      !!row && JSON.stringify([...(row.names || [])].sort()) === JSON.stringify(allGlobals[f]),
      `台账=${JSON.stringify(row?.names)} 实测=${JSON.stringify(allGlobals[f])}`);
    t(`③c ${f} 带 why / unblock`,
      !!row && String(row.why || '').length > 20 && String(row.unblock || '').length > 20);
  }
  t('③d 扫描器 nodeGlobals 与独立反推一致',
    JSON.stringify(Object.keys(scan.nodeGlobals).sort()) === JSON.stringify(expectedGlobals),
    `scan=${Object.keys(scan.nodeGlobals).sort().join(',')}`);
  /* ③a′：globals 销空后，空集合比较是「[] === [] 恒真」的形状。
     补独立静态判据：store-client 源码确实零 Buffer 命中，且判据本身
     仍能识别真 Buffer 用法 —— 否则「销账」可能只是把判据改坏了。 */
  const scRaw = readFileSync(join(ROOT, 'js/plugin-store-client.js'), 'utf8');
  /* 不另写剥注释正则：那会被 inline-strip-audit 记成新的一份内联实现，
     本轮就是这么多出 2 条欠账的。改用守卫自己已有的 readStripped。 */
  t('③a′ 销空后 store-client 源码确实零 Buffer 静态命中（防空集合假绿）',
    independentGlobalScan('js/plugin-store-client.js').length === 0
      && !/\bBuffer\s*[.[]/.test(readStripped('js/plugin-store-client.js')));
  GLOBAL_RE.lastIndex = 0;
  t('③a″ 全局判据仍能识别真实 Buffer 用法（没被改成恒空）',
    GLOBAL_RE.test(stripIndependent('const b = Buffer.from(ab);')));
  GLOBAL_RE.lastIndex = 0;
}

/* ---------------- ④ 盲区②：静态 import 链 ---------------- */
if (debt) {
  const rows = ((debt.blindSpots || {}).staticChain || []).map((x) => x.file).sort();
  t('④a 静态链台账 == 独立 BFS 反推（自己零 node: 也被拖死）',
    JSON.stringify(rows) === JSON.stringify(expectedChain),
    `台账=${rows.join(',')} 实测=${expectedChain.join(',')}`);
  t('④b 解包器已不在静态链集合里（链已切断）',
    !expectedChain.includes('js/plugin-tarball.js'), expectedChain.join(','));
  t('④c 扫描器 chainBlocked 与独立 BFS 一致',
    JSON.stringify([...scan.chainBlocked].sort()) === JSON.stringify(expectedChain),
    `scan=${scan.chainBlocked.join(',')}`);
  for (const f of expectedChain) {
    const row = ((debt.blindSpots || {}).staticChain || []).find((x) => x.file === f);
    t(`④d ${f} 带 why / unblock`,
      !!row && String(row.why || '').length > 20 && String(row.unblock || '').length > 20);
  }
  /* ④a 销空后同样是 []===[]。补：installer 源码确实零 node:，
     且入口仍静态 import 它 —— 链「通了」不是把 import 删掉换来的。 */
  const instSrcStatic = readStripped('js/plugin-installer.js');
  t('④e 销空后 installer 源码确实零 node: import',
    !/['"]node:/.test(instSrcStatic));
  t('④f 入口仍静态 import installer（销账不是删掉整条依赖）',
    /\.\/plugin-installer\.js/.test(readStripped(MARKET_ENTRY)));
}

/* ---------------- ⑤ 注释更正必须落地 ---------------- */
const entrySrc = readFileSync(join(ROOT, MARKET_ENTRY), 'utf8');
t('⑤a 编排层注释写明运行位置目标是 webview',
  /运行位置目标：webview/.test(entrySrc));
t('⑤b 编排层注释写明「不是缺一个 IPC 命令」',
  /不是缺一个\s*IPC\s*命令/.test(entrySrc));
t('⑤c 编排层注释写明闭包已全部可加载，且区分「能加载」与「已被调用」',
  /闭包 10 个模块全部可加载/.test(entrySrc) && /能加载.*≠.*已被调用|能加载.*已被调用/s.test(entrySrc));
t('⑤d 注释不再声称「这些模块都 import node:fs」（销账后不许留旧结论）',
  !/运行位置是 Node 侧 \/ IPC 桥/.test(entrySrc));

/* ---------------- ⑥ safe / blocked 集合守恒 ---------------- */
t('⑥a webview 可加载集合恰为 10 个（闭包全量）',
  scan.safe.length === 10 && scan.safe.every((f) => !expected.includes(f)),
  `safe=${scan.safe.join(',')}`);
t('⑥b blocked 集合已销空且不含入口',
  scan.blocked.length === 0 && !scan.blocked.includes(MARKET_ENTRY),
  `blocked=${scan.blocked.join(',')}`);
t('⑥c store-client 已进 safe 且不在 blocked（销账不是只改台账）',
  scan.safe.includes('js/plugin-store-client.js')
    && !scan.blocked.includes('js/plugin-store-client.js'),
  `safe=${scan.safe.join(',')} blocked=${scan.blocked.join(',')}`);
t('⑥d installed-plugin-scan 已进 safe 且不在 blocked（销账不是只改台账）',
  scan.safe.includes('js/installed-plugin-scan.js')
    && !scan.blocked.includes('js/installed-plugin-scan.js'),
  `safe=${scan.safe.join(',')} blocked=${scan.blocked.join(',')}`);

t('⑥e plugin-ledger 已进 safe 且不在 blocked（销账不是只改台账）',
  scan.safe.includes('js/plugin-ledger.js')
    && !scan.blocked.includes('js/plugin-ledger.js'),
  `safe=${scan.safe.join(',')} blocked=${scan.blocked.join(',')}`);
t('⑥f plugin-installer 已进 safe 且不在 blocked（第 48 轮销的不是台账字符串）',
  scan.safe.includes('js/plugin-installer.js')
    && !scan.blocked.includes('js/plugin-installer.js'),
  `safe=${scan.safe.join(',')} blocked=${scan.blocked.join(',')}`);
t('⑥g 静态链污染集合已销空（入口不再被任何 blocked 依赖拖死）',
  scan.chainBlocked.length === 0 && expectedChain.length === 0,
  `chain=${scan.chainBlocked.join(',')}`);

/* ---------------- ⑦ 元断言：判据本身不假绿 ---------------- */
const nodeSamples = [
  { name: '⑦a 能识别 node:fs', src: `import { readFileSync } from 'node:fs';`, want: ['fs'] },
  { name: '⑦b 能识别 node:path', src: `import { join } from 'node:path';`, want: ['path'] },
  { name: '⑦c 注释里的 node: 不算', src: `/* import { x } from 'node:fs'; */\nconst a = 1;`, want: [] },
  { name: '⑦d URL 的 // 不被当注释起点', src: `const u = 'https://api.github.com/x';\nimport { z } from 'node:zlib';`, want: ['zlib'] },
  { name: '⑦e 空文件不误报', src: `export const a = 1;`, want: [] },
];
for (const s of nodeSamples) {
  const stripped = stripIndependent(s.src);
  const got = new Set();
  let m;
  NODE_RE.lastIndex = 0;
  while ((m = NODE_RE.exec(stripped)) !== null) got.add(m[1]);
  t(s.name, JSON.stringify([...got].sort()) === JSON.stringify(s.want),
    `got=${[...got].sort()} want=${s.want}`);
}
const globalSamples = [
  { name: '⑦f 能识别 Buffer.from', src: `const b = Buffer.from(ab);`, want: ['Buffer'] },
  { name: '⑦g 能识别 process.cwd', src: `const p = process.cwd();`, want: ['process'] },
  { name: '⑦h 注释里的 Buffer 不算', src: `/* Buffer.isBuffer(x) */\nconst a = 1;`, want: [] },
  { name: '⑦i 普通字符串里的 Buffer 不算', src: `const s = 'Buffer from nowhere';`, want: [] },
  { name: '⑦j 空文件不误报', src: `export const a = 1;`, want: [] },
];
for (const s of globalSamples) {
  const stripped = stripIndependent(s.src);
  const got = new Set();
  let m;
  GLOBAL_RE.lastIndex = 0;
  while ((m = GLOBAL_RE.exec(stripped)) !== null) {
    const hit = m[0];
    got.add(hit.startsWith('Buffer') ? 'Buffer' : hit.startsWith('process') ? 'process'
      : hit.startsWith('__dirname') ? '__dirname' : hit.startsWith('__filename') ? '__filename' : 'require');
  }
  t(s.name, JSON.stringify([...got].sort()) === JSON.stringify(s.want),
    `got=${[...got].sort()} want=${s.want}`);
}
t('⑦k node 判据不是恒真/恒假',
  nodeSamples.some((s) => s.want.length === 0) && nodeSamples.some((s) => s.want.length > 0));
t('⑦l 全局判据不是恒真/恒假',
  globalSamples.some((s) => s.want.length === 0) && globalSamples.some((s) => s.want.length > 0));

/* ---------------- ⑧ 销账态：空集合不许假绿 ----------------
   第 47 轮之前 expected 至少有 1 条，「台账 == 实测」是实打实的比较；
   销空后它退化成 []===[] 恒真。这一节用四条与台账无关的判据兜住：
   闭包规模守恒、扫描范围非空、源码标记仍在、async 导出仍在。
   ⛔ 纯静态守卫仍挡不住「把本节某条主断言整行删掉」，
      这层和第 30/31/37/47 轮同形，靠每轮破坏验证兜。 */
const allMods = allJsModules();
const instRaw = readFileSync(join(ROOT, 'js/plugin-installer.js'), 'utf8');
const instStripped = readStripped('js/plugin-installer.js');
t('⑧a 闭包 10 / safe 10 / blocked 0 / 静态链 0 四者同时成立',
  scan.closure.length === 10 && scan.safe.length === 10
  && scan.blocked.length === 0 && scan.chainBlocked.length === 0,
  `closure=${scan.closure.length} safe=${scan.safe.length} blocked=${scan.blocked.length} chain=${scan.chainBlocked.length}`);
t('⑧b 扫描范围非空（expected 为空不是因为根本没扫到文件）',
  allMods.length >= 10 && allMods.includes('js/plugin-installer.js'),
  `allJsModules=${allMods.length}`);
t('⑧c installer 源码零 node: import / 零 Node 专有全局（独立扫描）',
  independentNodeScan('js/plugin-installer.js').length === 0
  && independentGlobalScan('js/plugin-installer.js').length === 0
  && !/['"]node:/.test(instStripped));
t('⑧d installer 功能没被删光换销账（注入式 fs / WebCrypto / bytesKnown 三处标记都在）',
  /function requireFs\(/.test(instRaw) && /getRandomValues/.test(instRaw)
  && /bytesKnown/.test(instRaw) && /await fs\.move\(/.test(instRaw));
t('⑧e 五个导出确实都还是 async（漏一个就是拿 Promise 当结果对象）',
  (instRaw.match(/export\s+async\s+function\s+\w+\s*\(/g) || []).length === 5
  && ['extractEntries', 'verifyPluginDir', 'installPlugin', 'uninstallPlan', 'uninstallPlugin']
    .every((n) => new RegExp('export\\s+async\\s+function\\s+' + n + '\\s*\\(').test(instRaw)));
t('⑧f 台账 note 写明「能加载 ≠ 已被调用」（不把接线问题冒充已解决）',
  /能加载\s*≠\s*已被调用/.test(String(debt && debt.note || '')));

if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
}
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) process.exitCode = 1;
