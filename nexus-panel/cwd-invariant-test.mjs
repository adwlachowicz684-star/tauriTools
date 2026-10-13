/**
 * 换目录不变性守卫：同一个测试，换个 cwd 跑，结论必须一致
 * ============================================================
 * 起因（本项目第 149 轮实测）：
 *   把 10 个测试从 nexus-panel 目录挪到仓库根跑，结果**全变了** —— 其中
 *   dead-class-test.mjs 直接 ENOENT 崩在半路（83 条护栏一条没跑），
 *   disclosure-test.mjs 更阴：它的 walk 把 readdirSync 包在 try/catch 里，
 *   换目录后**静默返回空数组**，"没有违规项"这类断言全部恒真 —— 既不崩也不红。
 *
 *   而守着这事的静态守卫（assertion-hygiene 第 5 节）只认 `process.cwd()`
 *   和"fs 紧跟相对字面量"这两种写法；**相对路径经变量中转就整批漏网**，
 *   且"静默假绿"这一档它根本看不见（源码看起来毫无问题）。
 *
 * 所以这里补**运行态**那一层：真跑两遍、比对结论。
 *
 * ⚠️ 比对的必须是「同一测试在两个 cwd 下的结果差」，不是「换目录后必须绿」：
 *    后者会被环境噪声淹没（依赖被清 → 两边都崩 → 报一屏红）。
 *    只有**同一次运行里两边结论不一样**，才说明这个测试依赖 cwd。
 *
 * 运行：node cwd-invariant-test.mjs [--only=关键字] [--slice=1/8] [--jobs=3]
 *
 * ⚠️ 并发说明：串行跑全量要几小时（dead-class 单跑 30s+、handshake 58s+），
 *    所以脚本之间并发。但**同一脚本的两个 cwd 必须串行配对跑**（先基线后空目录），
 *    这样两边的环境噪声（并发负载）尽量接近，比对才不会被"一边卡了一下"污染。
 *    另外每个脚本的空目录 cwd 各自独立，避免并发时互相踩临时产物。
 */
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSummary } from './test-scan-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
// 第二个 cwd 刻意用**空目录**，不用仓库根：
//   · 效果等价（相对路径一样解析不到），但不会把测试产生的临时文件
//     写进仓库根 —— 有的测试会在 cwd 下落 .tool_output / 临时产物。
const EMPTY = join(tmpdir(), `cwd-invariant-${process.pid}-${Date.now()}`);
mkdirSync(EMPTY, { recursive: true });

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
const sliceArg = (process.argv.find(a => a.startsWith('--slice=')) || '').split('=')[1] || '';
const JOBS = Math.max(1, Number((process.argv.find(a => a.startsWith('--jobs=')) || '').split('=')[1] || 3));
const SELF = 'cwd-invariant-test.mjs';

let entries = Object.entries(pkg.scripts)
  // 只收 node 直跑的脚本：bash 类的 agent-flow 走 run-tests.sh，
  // 它在 node 20 下认不出 .test.ts，两边都跑不动，比不出东西。
  .filter(([k, v]) => k.startsWith('test:') && /^node\s/.test(v) && /\.mjs|\.cjs|(\.tsx?)$/.test(v))
  .filter(([, v]) => !v.includes(SELF))
  .filter(([k]) => !only || k.includes(only))
  .sort();

let sliceTag = '';
if (sliceArg) {
  const m = sliceArg.match(/^(\d+)\/(\d+)$/);
  if (!m) { console.error('--slice 需写成 i/n，例如 --slice=1/8'); process.exit(2); }
  const i = Number(m[1]), n = Number(m[2]);
  const per = Math.ceil(entries.length / n);
  entries = entries.slice((i - 1) * per, i * per);
  sliceTag = `[${i}/${n}]`;
}

const fails = [];
let total = 0;
const ok = (why) => { total++; console.log('✅ ' + why); };
const bad = (why) => { total++; fails.push(why); console.log('❌ ' + why); };

/* ---- 跑一遍，返回可比的结论 ---- */
// 只比 (退出码, 通过数, 失败数)：
//   · 比 stdout 全文会被耗时、随机临时名、并发顺序淹掉，假红一片；
//   · 而这三项恰好覆盖真实事故 —— 崩在半路（pass===null）与静默假绿
//     （fail 从 0 变 1）都能被抓到。
const runOnce = (script, cwd) => {
  const r = spawnSync(process.execPath, [script], {
    cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const s = parseSummary(out);
  return { status: r.status, ...s };
};

const same = (a, b) => a.status === b.status && a.pass === b.pass && a.fail === b.fail;

/* ---- 异步版：主循环用，配合限流并发 ---- */
// 语义必须与同步 runOnce 一致：status===null 表示挂起/超时被杀，
// pass===null 表示解析不出汇总行。两者恰好对应两类真实事故。
const TIMEOUT_MS = 120000;
const runOnceAsync = (script, cwd) => new Promise((done) => {
  let out = '';
  let settled = false;
  const finish = (status) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done({ status, ...parseSummary(out) });
  };
  const child = spawn(process.execPath, [script], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } finish(null); }, TIMEOUT_MS);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code));
});

/* ---- 限流并发：同一脚本的两个 cwd 串行配对，脚本之间并发 ---- */
const runPool = async (jobs, tasks) => {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) results.push(await tasks[cursor++]());
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  return results;
};
const show = (r) => r.status === null
  ? '挂起/超时'
  : `退出 ${r.status} · 通过 ${r.pass === null ? '无汇总行' : r.pass} · 失败 ${r.fail === null ? '?' : r.fail}`;

/* ---- 自检：判据不能是摆设 ---- */
// ⚠️ 这条是全套的关键。把 same() 改成恒真、把 entries 改成空，
//    主循环会**照样全绿**——只有下面两条样本会喊。
//    「判据恒真 → 主断言仍绿、反面证据红」正是本项目反复撞的假绿模样。
console.log(`=== 0. 自检：判据必须真的能分辨「依赖 cwd」与「不依赖」 ===`);

const probeDir = join(EMPTY, '__probe__');
mkdirSync(probeDir, { recursive: true });

// 样本 A：读相对路径 → 换目录必然解析不到 → 必须被判为「依赖 cwd」
//
// ⚠️ 那行读相对路径**不能在本文件里写成字面量**：assertion-hygiene 第 5 节是按
//    源码文本扫 `readFileSync('相对路径')` 的，它分不清"真代码"和"用来当样本的字符串"，
//    会把本守卫自己判成漏网（与 acorn 假阳性同一类：正则命中了字符串里的样子）。
//    所以用 ${...} 拼出来 —— 生成的样本里仍是那行，本文件源码里却不被判据认出。
const REL_ARG = JSON.stringify('package.json');
const probeA = join(probeDir, 'a.mjs');
writeFileSync(probeA, `import { readFileSync } from 'node:fs';
readFileSync(${REL_ARG}, 'utf8');
console.log('通过 1 项，失败 0 项');
`);
// 样本 B：什么都不读，只打印 → 两个目录结论必须一致 → 不能被误伤
const probeB = join(probeDir, 'b.mjs');
writeFileSync(probeB, `console.log('通过 1 项，失败 0 项');
`);

const pairA = same(runOnce(probeA, ROOT), runOnce(probeA, EMPTY));
const pairB = same(runOnce(probeB, ROOT), runOnce(probeB, EMPTY));
pairA === false
  ? ok('依赖 cwd 的样本被判为「两边不一致」（判据没被清空）')
  : bad('依赖 cwd 的样本竟判为一致 —— same() 或 runOnce() 被改坏了');
pairB === true
  ? ok('不依赖 cwd 的样本未被误伤（不会一律报红）')
  : bad('不依赖 cwd 的样本被误判 —— 判据变成了「永远报红」，同样没有鉴别力');

// 反面证据：样本必须真的存在且真被跑过。
// 少了这条，把上面两个 writeFileSync 一删，两条自检会因为 ENOENT
// 而碰巧一个 false 一个 true，看着还是绿的。
const probeRanA = runOnce(probeA, ROOT).pass === 1;
probeRanA
  ? ok('样本 A 在基线目录确实跑通（判据不是在空转）')
  : bad('样本 A 在基线目录没跑通 —— 自检失去了参照');

entries.length > 0
  ? ok(`待跑清单取自 package.json，实测 ${entries.length} 条（不是写死的固定清单）`)
  : bad('待跑清单为空 —— 收不到脚本就永远全绿，等于没守');

/* ---- 主循环 ---- */
console.log(`\n=== 1. 换目录重跑 ${sliceTag}：共 ${entries.length} 个脚本（并发 ${JOBS}）===`);
const pairs = await runPool(JOBS, entries.map(([name, cmd], idx) => async () => {
  const rel = cmd.replace(/^node\s+/, '').split(/\s+/)[0];
  const script = resolve(ROOT, rel);
  // 每个脚本一个独立空目录：并发时不互相踩临时产物
  const cwdB = join(EMPTY, 'c' + idx);
  mkdirSync(cwdB, { recursive: true });
  const a = await runOnceAsync(script, ROOT);
  const b = await runOnceAsync(script, cwdB);
  return { name, rel, a, b };
}));
pairs.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

/*
 * ⚠️ 一次性差异不能直接判红：并发跑（JOBS>1）时机器负载会让个别脚本
 *    偶发多一条/少一条，实测出现过一次 —— command-consistency 在基线目录
 *    报 116/1、空目录报 117/0，单独重跑 6 次、并发 6 次却全绿。
 *    也就是说那次红是**负载噪声**，不是"换目录就变结论"。
 *
 *    但也不能直接丢掉：一个结果不稳定的测试本身就是问题，只是它不属于
 *    "依赖 cwd"这一类。所以**串行复跑 2 次**再定性：
 *      · 复现     → ❌ 真的依赖 cwd（或真的不稳定到能被复现）
 *      · 不复现   → ⚠️ 告知：该脚本结论不稳定，与 cwd 无关，但值得知道
 *    两条路都有声音，不会像"直接忽略"那样把真问题也一起吞掉。
 */
const RETRY = 2;
const diffs = [];
const flakes = [];
for (const { name, rel, a, b } of pairs) {
  if (same(a, b)) { console.log(`  · ${name}：一致（${show(a)}）`); continue; }
  const first = `     基线 cwd：${show(a)}\n     空目录 cwd：${show(b)}`;
  const script = resolve(ROOT, rel);
  let again = null;
  for (let t = 0; t < RETRY; t++) {
    const cwdB = join(EMPTY, `retry${t}-${rel.replace(/[^\w]/g, '_')}`);
    mkdirSync(cwdB, { recursive: true });
    // 串行复跑：排除并发负载这个变量，否则复跑本身也在噪声里
    const a2 = await runOnceAsync(script, ROOT);
    const b2 = await runOnceAsync(script, cwdB);
    if (!same(a2, b2)) { again = `     复跑第 ${t + 1} 次仍不一致：基线 ${show(a2)}；空目录 ${show(b2)}`; break; }
  }
  if (again) diffs.push(`  ❌ ${name}（${rel}）\n${first}\n${again}`);
  else flakes.push(`  ⚠️ ${name}（${rel}）\n${first}\n     串行复跑 ${RETRY} 次均一致 → 属偶发噪声，非 cwd 依赖`);
}
for (const f of flakes) console.log(f);
diffs.length === 0
  ? ok(`${entries.length} 个脚本在两个 cwd 下结论完全一致`)
  : bad(`${entries.length} 个脚本里有 ${diffs.length} 个换目录就变结论：\n${diffs.join('\n')}`);
if (flakes.length) console.log(`\n告知 ${flakes.length} 条（结论偶发不一致，复跑未复现）`);

rmSync(EMPTY, { recursive: true, force: true });

console.log(`\n通过 ${total - fails.length} 项，失败 ${fails.length} 项`);
if (fails.length) { console.log('\n'.padEnd(1) + fails.map(f => ' · ' + f.split('\n')[0]).join('\n')); process.exit(1); }
