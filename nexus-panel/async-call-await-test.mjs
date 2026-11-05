/**
 * async 导出函数的调用点 await 守卫
 * ============================================================
 * 第 43 轮把解包器改成异步（gunzipSync → DecompressionStream），第 44 轮把
 * 摘要校验改成异步（node:crypto → WebCrypto）。两轮都补了产品链路与离线测试
 * 的 await，但 **scripts/ 下的四个发布/联调脚本没补**：
 *   · publish-plugin-releases.mjs —— 每个插件都抛「打包回读失败: undefined」，
 *     12 仓一个都发不出去，报错却指向根本没坏的打包；
 *   · probe-github-real.mjs —— 崩在 out.entries.filter（Promise 没有 entries）；
 *   · probe-private-install.mjs —— 打包回读三条断言恒假，另一条替身校验
 *     形如「Promise.ok === true」也恒假。
 * 而几百套守卫全绿：market-runtime-gap / webview-runtime 只扫 import 行、
 * node 全局与依赖闭包，**没有一条扫「调用点有没有 await」**。
 *
 * 第 46 轮把 installed-plugin-scan.js 加入 CONTRACT_FILES：它新变成
 * export async function，全仓 4 个测试/探针的调用点必须跟着补 await，
 * 否则「一个插件都没出现」且不报错。名单是动态读的，不会漏。
 *
 * 判据：名单动态读自生产模块的 export async function（写死名单会漏掉下一个
 * 被 async 化的函数）；剥注释一律走共用模块，不再造内联副本；定义行排除、
 * 注释与字符串里的 await 不许喂饱；按语句（最后一个分号之后）判断 await。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const fails = [];
function t(name, cond, note = '') {
  if (cond) pass++; else fails.push(name + (note ? ` → ${note}` : ''));
  console.log(`  ${cond ? '✅' : '❌'} ${name}${note ? ` · ${note}` : ''}`);
}

/* ---------------- ① 名单动态读自生产模块 ---------------- */
const CONTRACT_FILES = [
  'js/plugin-tarball.js',
  'js/plugin-store-client.js',
  'js/plugin-market.js',
  'js/plugin-ledger.js',
  'js/installed-plugin-scan.js',
  /* 第 48 轮：installer 五个导出全部 async 化，调用点漏 await 时
     拿到的是 Promise 而非结果对象，表现为「装了但什么都没发生」。 */
  'js/plugin-installer.js',
];
function asyncExports(rel) {
  const src = stripCommentsFlatJs(readFileSync(join(ROOT, rel), 'utf8'));
  return [...src.matchAll(/export\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
}
const names = new Set();
for (const f of CONTRACT_FILES) for (const n of asyncExports(f)) names.add(n);

t('① async 名单非空且含两次 async 化的两个函数（空集合不许假绿）',
  names.size >= 4 && names.has('unpackTarGz') && names.has('verifyAssetDigest'),
  `names=${[...names].join(',')}`);
t('①′ 第 46 轮新 async 化的两个扫描导出也在名单里',
  names.has('scanInstalledPlugins') && names.has('pluginsWithInstalled'),
  `names=${[...names].join(',')}`);
t('①″ 第 47 轮新 async 化的两个台账导出也在名单里',
  names.has('readLedger') && names.has('writeLedger'),
  `names=${[...names].join(',')}`);
t('①‴ 第 48 轮新 async 化的五个落盘导出都在名单里（空名单不许假绿）',
  ['extractEntries', 'verifyPluginDir', 'installPlugin', 'uninstallPlan', 'uninstallPlugin']
    .every((n) => names.has(n)),
  `names=${[...names].join(',')}`);

/* ---------------- ② 行为层：真跑一次，钉住确实返回 Promise ----------------
   通过变量调用，避免在守卫自身源码文本里制造一个「故意不 await」的命中。 */
const tarball = await import('./js/plugin-tarball.js');
const storeClient = await import('./js/plugin-store-client.js');
const unpackCall = tarball.unpackTarGz;
const p1 = unpackCall(new Uint8Array([0]));
t('②a 解包器真身返回 Promise（不是靠文本猜 async）', typeof p1?.then === 'function');
await p1.catch(() => {});
const digestCall = storeClient.verifyAssetDigest;
const p2 = digestCall(new Uint8Array([1, 2, 3]), {});
t('②b 摘要校验真身返回 Promise', typeof p2?.then === 'function');
await p2.catch(() => {});

/* ---------------- ③ 扫描器 ---------------- */
function scanMisses(text) {
  /* 共用模块剥块注释时把整段（含内部换行）换成空串，扫描行号会被压缩。
     证据若用压缩后的行号，会把人指到无关的行上 —— 这正是本项目反复栽的
     「定位漂移」。故命中后按内容回原文反查真实行号。 */
  const rawLines = text.split('\n');
  const src = stripCommentsFlatJs(text);
  const lines = src.split('\n');
  const out = [];
  let total = 0;
  lines.forEach((line, i) => {
    for (const n of names) {
      const re = new RegExp('\\b' + n + '\\s*\\(', 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        /* 定义行：`export async function N(` 与对象/类方法 `async N(` 都不算调用 */
        const defRe = new RegExp('(?:export\\s+)?function\\s+' + n + '\\s*\\(|^\\s*async\\s+' + n + '\\s*\\(');
        if (defRe.test(line)) continue;
        total++;
        /* 只取最后一个分号之后的语句；字符串字面量先挖空，
           否则 `t('await 什么', N())` 里的 await 会把判据喂饱。 */
        const stmt = ((lines[i - 1] || '') + ' ' + line.slice(0, m.index))
          .split(';').pop().replace(/'[^']*'|"[^"]*"/g, ' ');
        const awaited = /\bawait\b/.test(stmt) || /\breturn\b/.test(stmt)
          || /\bvoid\s/.test(stmt) || /\.then\s*\(/.test(line);
        if (!awaited) {
          const snippet = line.trim().slice(0, 160);
          const hit = rawLines.findIndex((l) => l.includes(snippet.slice(0, 40)));
          out.push({ line: hit >= 0 ? hit + 1 : i + 1, name: n, text: snippet });
        }
      }
    }
  });
  out.total = total;
  return out;
}

/* 样本里的调用形态一律拼接，避免守卫扫到自己时把样本当成真调用 */
const N = 'unpack' + 'TarGz';
const CALL = N + '(';
const CU = 'check' + 'Updates';
const sample = {
  bad: 'const r = ' + CALL + 'x);',
  good: 'const r = await ' + CALL + 'x);',
  def: 'export async function ' + N + '(buf) { return 1; }',
  method: '  async ' + CU + '() { return 1; }',
  comment: '// const r = ' + CALL + 'x);',
  chain: 'const r = (await makeMarket({ a: [] }).market.' + CU + '()).results;',
  strAwait: 't("await 只是文案", ' + CALL + 'x));',
  thenForm: 'const r = ' + CALL + 'x).then(() => 1);',
};
t('④a 漏 await 的调用必须被检出', scanMisses(sample.bad).length === 1,
  `miss=${scanMisses(sample.bad).length}`);
t('④b 正常 await 不误报', scanMisses(sample.good).length === 0);
t('④c export async function 定义行不计入', scanMisses(sample.def).length === 0);
t('④d 对象方法定义行不计入', scanMisses(sample.method).length === 0);
t('④e 注释里的同名调用不计入（剥注释真生效）', scanMisses(sample.comment).length === 0);
t('④f await 与调用之间隔着链式成员不误报', scanMisses(sample.chain).length === 0,
  `miss=${scanMisses(sample.chain).length}`);
t('④g 字符串里的 await 不许喂饱判据', scanMisses(sample.strAwait).length === 1,
  `miss=${scanMisses(sample.strAwait).length}`);
t('④h .then 形态算已接住 Promise', scanMisses(sample.thenForm).length === 0);
t('④i 判据不是恒真（注入一行漏 await 到干净样本里会红）',
  scanMisses(sample.good + '\n' + sample.bad).length === 1);
t('④j 空文本零命中（说明 ⑤″ 的调用点规模断言不是摆设）',
  scanMisses('').total === 0);

/* ---------------- ⑤ 全仓实扫 ---------------- */
const SKIP = new Set(['node_modules', '.git', 'dist', 'target', '__pycache__', '.cache']);
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const misses = [];
let totalCalls = 0;
for (const p of files) {
  const rel = relative(ROOT, p).replace(/\\/g, '/');
  const found = scanMisses(readFileSync(p, 'utf8'));
  totalCalls += found.total;
  for (const m of found) misses.push(`${rel}:${m.line} [${m.name}] ${m.text}`);
}
t('⑤ 全仓 async 导出函数调用点漏 await 为 0', misses.length === 0,
  misses.slice(0, 6).join(' | ') || `扫描 ${files.length} 个文件 / ${totalCalls} 处调用`);
t('⑤′ 扫描规模非空（空目录会让上一条恒绿）', files.length > 100, `files=${files.length}`);
t('⑤″ 确实扫到了调用点（文件被清空时 ⑤ 会恒绿，必须单独堵住）',
  totalCalls >= 10, `calls=${totalCalls}`);

/* ---------------- ⑥ 对象方法形态（第 46 轮新增） ----------------
   createPluginMarket 返回对象里的 async list() 不是 export async function，
   ① 的动态名单收不到它，⑤ 全仓扫描因此看不见。破坏验证 D 向实测：
   摘掉 await 后 ⑤ 仍 17/0 全绿，只有端到端测试崩了且没有汇总行 ——
   「崩了不等于喊了」。这里补一层：静态盯住 market*.list( 调用点，
   行为上真构造一次实例确认它返回 Promise，并配两条样本元断言。 */
const LNAME = 'li' + 'st';
function listMisses(text) {
  const src = stripCommentsFlatJs(text);
  const out = [];
  src.split('\n').forEach((line, i) => {
    const re = new RegExp('\\b(?:market\\w*)\\s*\\.\\s*' + LNAME + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(line)) !== null) {
      const stmt = line.slice(0, m.index).split(';').pop();
      if (/\bawait\b/.test(stmt) || /\breturn\b/.test(stmt) || /\.then\s*\(/.test(line)) continue;
      out.push({ line: i + 1, text: line.trim().slice(0, 140) });
    }
  });
  return out;
}
const CALL6 = 'market.' + LNAME + '()';
const sample6 = {
  bad: 'const r = ' + CALL6 + ';',
  good: 'const r = await ' + CALL6 + ';',
};
t('⑥a 样本：漏 await 的 list 调用必须被检出', listMisses(sample6.bad).length === 1,
  `miss=${listMisses(sample6.bad).length}`);
t('⑥b 样本：正常 await 不误报', listMisses(sample6.good).length === 0);
const listHits = [];
for (const p of files) {
  const rel6 = relative(ROOT, p).replace(/\\/g, '/');
  for (const m of listMisses(readFileSync(p, 'utf8'))) listHits.push(`${rel6}:${m.line} ${m.text}`);
}
t('⑥c 全仓 market*.list 调用点漏 await 为 0', listHits.length === 0,
  listHits.slice(0, 4).join(' | ') || `扫描 ${files.length} 个文件`);

/* 行为层：真构造一次市场实例，确认 list() 真的返回 Promise。
   没注入 fs 时扫描器会明确 throw，这个 reject 正好证明「不是同步返回对象」；
   用 catch 接住，避免 unhandled rejection。 */
const mk = await import('./js/plugin-market.js');
const inst = mk.createPluginMarket({
  installedDir: join(ROOT, '.await-guard-no-dir'),
  ledgerFile: join(ROOT, '.await-guard-no-ledger.json'),
  fetch: async () => { throw new Error('守卫不发网络请求'); },
});
const lp = inst[LNAME]();
t('⑥d list() 真身返回 Promise（不是靠文本猜 async）', typeof lp?.then === 'function');
await lp.catch(() => {});

/* ---------------- ⑦ 市场实例内部台账包装函数（第 47 轮） ----------------
   readLedgerState / saveLedger 不是 export async function，① 的动态名单
   收不到；破坏验证 D 向实测：摘掉 install 里的 await 后 ⑤ 仍 22/0 全绿，
   只有端到端测试崩了且没有汇总行。这里补一层静态盯调用点 + 样本元断言。 */
const WRAPPERS = ['read' + 'LedgerState', 'save' + 'Ledger'];
function wrapperMisses(text) {
  const src = stripCommentsFlatJs(text);
  const lines = src.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    for (const n of WRAPPERS) {
      const re = new RegExp('\\b' + n + '\\s*\\(', 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        if (new RegExp('const\\s+' + n + '\\s*=').test(line)) continue;  // 定义行不算
        const stmt = ((lines[i - 1] || '') + ' ' + line.slice(0, m.index)).split(';').pop();
        if (/\bawait\b/.test(stmt) || /\breturn\b/.test(stmt) || /\.then\s*\(/.test(line)) continue;
        out.push({ line: i + 1, text: line.trim().slice(0, 140) });
      }
    }
  });
  return out;
}
const W1 = WRAPPERS[0];
const sample7 = {
  bad: 'const s = ' + W1 + '();',
  good: 'const s = await ' + W1 + '();',
  def: 'const ' + W1 + ' = () => { return 1; };',
};
t('⑦a 样本：漏 await 的包装函数调用必须被检出', wrapperMisses(sample7.bad).length === 1,
  `miss=${wrapperMisses(sample7.bad).length}`);
t('⑦b 样本：正常 await 不误报', wrapperMisses(sample7.good).length === 0);
t('⑦c 样本：定义行不计入', wrapperMisses(sample7.def).length === 0);
const wrapHits = [];
for (const p of files) {
  for (const m of wrapperMisses(readFileSync(p, 'utf8'))) {
    wrapHits.push(`${relative(ROOT, p).replace(/\\/g, '/')}:${m.line} ${m.text}`);
  }
}
t('⑦d 全仓台账包装函数调用点漏 await 为 0', wrapHits.length === 0,
  wrapHits.slice(0, 4).join(' | ') || `扫描 ${files.length} 个文件`);


console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
