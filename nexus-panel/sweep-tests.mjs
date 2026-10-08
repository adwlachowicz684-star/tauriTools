/**
 * 全量测试体检：找出「看起来在跑、其实一条断言都没守」的测试
 * ============================================================
 * 起因（本项目反复出现的同一类失效）：
 *   · 测试崩在半路 → 进程非零退出看着像"有红"，实际后面的断言一条都没跑
 *   · 前置条件不满足就提前 return → 退出码 0、断言 0 条，比崩了更隐蔽
 *   · 断言恒真（查存在性不查那一处）→ 永远绿
 *
 * 这里只做**机械可判定**的那一层：
 *   ① 退出码
 *   ② 有没有打印「通过 N 项」这种汇总行
 *   ③ N 是否为 0（0 条断言 = 没有守任何东西）
 * 不做语义判定（恒真断言得靠人读，或者靠破坏验证）。
 *
 * 运行：node sweep-tests.mjs [--only=关键字] [--slice=1/6]
 *
 * ⚠ 两个不能省的设计（都是踩过的坑）：
 *  A. 必须把自己排除在待跑列表之外。
 *     entries 取自 package.json 的 test:* 脚本，而 test:sweep 指向的正是
 *     本文件 —— 不排除就会 spawn 自己，自己再 spawn 178 个……
 *     表现为"跑不完 / 机器被拖死"，而报错只会指向超时，看不出是递归。
 *  B. 必须能分片。178 个脚本一次跑完远超单次命令的时长上限，
 *     跑到一半被掐断 = 前面的结果全部丢失（明细只在最后才写盘）。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
// 分片：--slice=1/6 表示把排序后的列表均分 6 份、跑第 1 份（1-based）。
const sliceArg = (process.argv.find(a => a.startsWith('--slice=')) || '').split('=')[1] || '';
const SELF = 'sweep-tests.mjs';

let entries = Object.entries(pkg.scripts)
  .filter(([k, v]) => k.startsWith('test:') && /\.mjs|\.cjs|\.tsx?/.test(v))
  // A. 排除自己：test:sweep 指向本文件，不过滤就是无限 fork。
  .filter(([, v]) => !v.includes(SELF))
  .filter(([k]) => !only || k.includes(only))
  .sort();

let sliceTag = '';
if (sliceArg) {
  const m = sliceArg.match(/^(\d+)\/(\d+)$/);
  if (!m) { console.error('--slice 需写成 i/n，例如 --slice=1/6'); process.exit(2); }
  const i = Number(m[1]), n = Number(m[2]);
  const per = Math.ceil(entries.length / n);
  entries = entries.slice((i - 1) * per, i * per);
  sliceTag = `[${i}/${n}]`;
}

// 汇总行的几种写法（项目里不统一，全列出来；少一种就会把正常测试误判成"没汇总"）
//
// ⚠️ 曾经漏掉「数字在前」那一族（"依赖清单：59 通过 / 0 失败"），后果不是漏报——
//    退出码 0 却解析不出汇总行 → 被判成「可疑」。把 246 条断言的 runtime-deps、
//    59 条的 deps-manifest 一起列进"可疑"，真可疑项就淹没在假警报里，
//    体检单从此没人看。所以下面每种写法都配 FIXTURES 钉住（第 B 条已有教训）。
const SUMMARY = [
  /通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/,
  /(\d+)\s*passed\s*,\s*(\d+)\s*failed/i,
  /通过\s*(\d+)\s*\/\s*失败\s*(\d+)/,
  /通过\s*(\d+)\s*项/,
  /(\d+)\s*\/\s*(\d+)\s*(?:通过|通过项)/,
  /(\d+)\s*通过\s*\/\s*(\d+)\s*失败/,   // 数字在前：deps-manifest / runtime-deps / theme-tokens / publish-update
  /(\d+)\s*项通过/,                      // 只报通过数：md-render
];

function parseSummary(out) {
  for (const re of SUMMARY) {
    const m = out.match(re);
    if (m) return { pass: Number(m[1]), fail: m[2] !== undefined ? Number(m[2]) : 0 };
  }
  return { pass: null, fail: null };
}

// B. 自检：汇总格式是"约定"不是"代码"，改一行就能让体检单失明。
//    这里把每种写法的真实样本列成 fixture，认不出就直接算失败项。
const FIXTURES = [
  { s: '通过 12 项，失败 0 项', pass: 12, fail: 0, why: '主流写法' },
  { s: '通过 3 项，失败 2 项', pass: 3, fail: 2, why: '主流写法（有失败）' },
  { s: '12 passed, 0 failed', pass: 12, fail: 0, why: '英文写法' },
  { s: '通过 30 / 失败 0', pass: 30, fail: 0, why: '斜杠分隔（md-render）' },
  { s: '依赖清单：59 通过 / 0 失败', pass: 59, fail: 0, why: '数字在前（deps-manifest）' },
  { s: '运行时依赖：246 通过 / 0 失败', pass: 246, fail: 0, why: '数字在前（runtime-deps）' },
  { s: '— 结果：50 通过 / 0 失败 —', pass: 50, fail: 0, why: '数字在前（publish-update）' },
  { s: '✅ 全部 30 项通过', pass: 30, fail: 0, why: '只报通过数（md-render）' },
];

const isBad = (r) => r.status !== 0 || r.pass === null || r.pass === 0;

const selfFails = [];
console.log('=== 0. 自检：汇总行格式必须认得全（认不出＝体检单失明）===');
for (const f of FIXTURES) {
  const got = parseSummary(f.s);
  const good = got.pass === f.pass && got.fail === f.fail;
  console.log(`${good ? '✅' : '❌'} ${f.why} → ${JSON.stringify(f.s)}`);
  if (!good) selfFails.push(`${f.why}：期望 ${f.pass}/${f.fail}，实得 ${got.pass}/${got.fail}`);
}
// 「0 条断言」是本项目最贵的一类失效（崩≠红、空跑），必须判为可疑而不是放过
const zeroOk = isBad({ status: 0, pass: 0, fail: 0 }) === true;
const fiveOk = isBad({ status: 0, pass: 5, fail: 0 }) === false;
console.log(`${zeroOk ? '✅' : '❌'} 0 条断言判为可疑（不能当正常放过）`);
console.log(`${fiveOk ? '✅' : '❌'} 有断言且退出码 0 判为正常（不能误伤）`);
if (!zeroOk) selfFails.push('0 条断言未判为可疑');
if (!fiveOk) selfFails.push('正常测试被误判为可疑');

const rows = [];
for (const [name, cmd] of entries) {
  const r = spawnSync('bash', ['-lc', cmd], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const { pass, fail } = parseSummary(out);
  const crashed = r.status !== 0 && pass === null;
  rows.push({ name, cmd, status: r.status, pass, fail, crashed, out });
}

const bad = rows.filter(isBad);
const ok = rows.filter(r => r.status === 0 && r.pass !== null && r.pass > 0);

console.log(`\n共 ${rows.length} 个测试脚本${sliceTag}`);
console.log(`✅ 正常（有汇总行且断言数 > 0）：${ok.length}`);
console.log(`⚠️  可疑：${bad.length}\n`);

for (const r of bad) {
  const why = r.crashed ? '崩在半路（无汇总行，退出码非 0）'
    : r.pass === null ? '退出码 ' + r.status + ' 但无汇总行'
    : r.pass === 0 ? '0 条断言（等于没守任何东西）'
    : '失败 ' + r.fail + ' 项';
  console.log(`  ${r.status === 0 && r.pass === 0 ? '⚠️' : '❌'} ${r.name} — ${why}`);
  const tail = r.out.trim().split('\n').slice(-3).join('\n     ');
  if (tail) console.log(`     ${tail}`);
}

for (const s of selfFails) console.log(`  ❌ 自检：${s}`);

// 明细落到分片各自的文件：一次跑不完，跑到一半被掐断时前面的结果不能丢。
// ⚠️ 输出目录必须**落在项目内**（ROOT 下），不能写死绝对路径。
//    这里原先写的是 /data/workspace/.tool_output —— 那是某台开发机上的
//    路径，换台机器要么没权限建（在 / 下 mkdir 直接 EACCES），要么把结果
//    写到一个谁都找不到的地方，表现为"跑了但看不到明细"。
const fs = await import('node:fs');
const outDir = join(ROOT, '.tool_output');
const outFile = join(outDir, `sweep${sliceTag.replace(/\W/g, '') || '_all'}.txt`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile,
  rows.map(r => `${r.status}\t${r.pass}\t${r.fail}\t${r.name}\t${r.cmd}`).join('\n'));
console.log(`\n明细已写入 ${outFile}`);
// 标准汇总行：本文件自己也在 package.json 的 test:* 里（已排除自跑），
// 但别人拿通用规则体检它时，没有这行就会被判成"0 条断言"。
const totalFail = bad.length + selfFails.length;
console.log(`通过 ${ok.length + (FIXTURES.length + 2 - selfFails.length)} 项，失败 ${totalFail} 项`);
// 可疑项 + 自检失败都要以非 0 退出：体检单本身必须能被 CI 判红，
// 否则"体检跑了但没人看退出码"又是一次静默。
process.exit(totalFail ? 1 : 0);
