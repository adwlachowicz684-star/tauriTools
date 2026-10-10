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

// ⚠️ 曾经漏掉「失败数 > 0 但退出码 0」这一组合：
//    原判据只管 status!==0 / pass===null / pass===0，于是"通过 30 项、失败 2 项、
//    末尾 process.exit(0)"会被算进 ok，体检单照样报全绿 —— 而 CI 只看退出码，
//    这种测试等于永远不红。
//    更能说明问题的是：下面打印 why 时本来就写了 '失败 N 项' 这一档，
//    却因为根本进不了 bad 而从未生效过（死分支）。
//    它本想抓的正是这一档，写的人以为抓到了，实际一次都没跑过。
const isBad = (r) => r.status !== 0 || r.pass === null || r.pass === 0
  || (r.fail !== null && r.fail > 0);

// 「挂起」要与「崩」分开：两者在体检单上都是"无汇总行 + 退出码异常"，
// 但**处置完全不同** —— 崩是测试自己的问题，挂起多半是环境（依赖半残、
// 等外部资源）。实测案例：jsdom 本体在、它的依赖（cssstyle / parse5 /
// rrweb-cssom / tough-cookie / ws）被环境裁掉时，require('jsdom') 既不
// 报错也不返回，进程**静默挂起**——连一行输出都没有。体检单上它长得很像
// "崩在半路"，于是排查方向被引到测试本身，而真因在依赖。
//   两种信号都要认：外层用 `timeout N bash -c` 时退出码是 124；spawnSync
// 自己的 timeout 到点则是 status=null + signal=SIGTERM（没有 124）。
const isHung = (r) => r.status === null || r.status === 124;

// 归类的判据只写一份：循环里和自检里调的是同一个函数。
// 分着写两份，改了一处另一处不动，体检单就会把"挂起"报成"崩"。
const whyOf = (r) => {
  const noOutput = r.noOutput !== undefined ? r.noOutput : (r.out || '').trim() === '';
  // ⚠️ 顺序要紧，两条都是：
  //   · hung 必须在 crashed 之前 —— 超时被杀时 status=null 同样满足 crashed
  //     的判据（null !== 0 且 pass===null），会被"崩在半路"吃掉（死分支）。
  //   · '失败 N 项' 必须在 'pass===0' 之前 —— 能走到那里的只剩 pass===0
  //     已被前面吃掉的情况，排最后就永远打不出来（同样是死分支）。
  if (isHung(r)) return noOutput
    ? '挂起（超时被杀，且**一行输出都没有** → 多半是依赖半残或等外部资源，不是测试自己的问题）'
    : '超时（跑太慢，或有输出但未跑完）';
  if (r.status !== 0 && r.pass === null) return '崩在半路（无汇总行，退出码非 0）';
  if (r.pass === null) return '退出码 ' + r.status + ' 但无汇总行';
  if (r.fail !== null && r.fail > 0) return '失败 ' + r.fail + ' 项，但退出码 ' + r.status + '（CI 只看退出码，看不出来）';
  if (r.pass === 0) return '0 条断言（等于没守任何东西）';
  return '未归类';
};

const selfFails = [];
// 自检项数必须随实际条数走：这里原先写死成 FIXTURES.length + 2，
// 后来新增了 2 条自检（failOk / noFalseAlarm）却没同步这个公式，
// 于是"通过 N 项"永远少算 2 —— 自检增加了、报告看不出增加，
// 等于新加的守卫不在账上。改成实际计数，以后再加自检自动计入。
let selfTotal = 0;
console.log('=== 0. 自检：汇总行格式必须认得全（认不出＝体检单失明）===');
for (const f of FIXTURES) {
  const got = parseSummary(f.s);
  const good = got.pass === f.pass && got.fail === f.fail;
  selfTotal++;
  console.log(`${good ? '✅' : '❌'} ${f.why} → ${JSON.stringify(f.s)}`);
  if (!good) selfFails.push(`${f.why}：期望 ${f.pass}/${f.fail}，实得 ${got.pass}/${got.fail}`);
}
// 「0 条断言」是本项目最贵的一类失效（崩≠红、空跑），必须判为可疑而不是放过
const zeroOk = isBad({ status: 0, pass: 0, fail: 0 }) === true;
const fiveOk = isBad({ status: 0, pass: 5, fail: 0 }) === false;
// 「失败 N 项但退出码 0」必须判为可疑：CI 只看退出码，不判这一档就等于
// 这类测试永远绿。这条自检正是上面那个死分支缺的那一环。
const failOk = isBad({ status: 0, pass: 30, fail: 2 }) === true;
// 反向：失败 0 项、退出码 0 不能误伤
const noFalseAlarm = isBad({ status: 0, pass: 30, fail: 0 }) === false;
selfTotal++;
console.log(`${zeroOk ? '✅' : '❌'} 0 条断言判为可疑（不能当正常放过）`);
selfTotal++;
console.log(`${fiveOk ? '✅' : '❌'} 有断言且退出码 0 判为正常（不能误伤）`);
selfTotal++;
console.log(`${failOk ? '✅' : '❌'} 失败 2 项但退出码 0 判为可疑（CI 只看退出码）`);
selfTotal++;
console.log(`${noFalseAlarm ? '✅' : '❌'} 失败 0 项且退出码 0 不误伤`);
if (!zeroOk) selfFails.push('0 条断言未判为可疑');
if (!fiveOk) selfFails.push('正常测试被误判为可疑');
if (!failOk) selfFails.push('失败数 > 0 但退出码 0 未判为可疑');
if (!noFalseAlarm) selfFails.push('失败 0 项被误判为可疑');
// 「挂起」不能被「崩在半路」吃掉：超时被杀时 status=null，crashed 的判据
// （status !== 0 && pass === null）对 null 同样成立，顺序错了这档就是死分支，
// 体检单会把"依赖半残导致的挂起"报成"测试自身崩溃"，排查方向整个被引跑。
const hungOk = isHung({ status: null }) && isHung({ status: 124 })
  && whyOf({ status: null, pass: null, out: '' }).includes('挂起')
  && whyOf({ status: 124, pass: null, out: '' }).includes('挂起');
const hungNoFalse = !isHung({ status: 0 }) && !isHung({ status: 1 })
  && whyOf({ status: 1, pass: null, out: 'boom' }).includes('崩在半路');
selfTotal++;
console.log(`${hungOk ? '✅' : '❌'} 超时被杀判为「挂起」，且不被「崩在半路」吃掉`);
selfTotal++;
console.log(`${hungNoFalse ? '✅' : '❌'} 真崩溃仍判为「崩在半路」（挂起判据不误伤）`);
if (!hungOk) selfFails.push('挂起未被正确归类（会被当成崩溃，排查方向被引跑）');
if (!hungNoFalse) selfFails.push('挂起判据误伤了真崩溃');

const rows = [];
for (const [name, cmd] of entries) {
  const r = spawnSync('bash', ['-lc', cmd], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const { pass, fail } = parseSummary(out);
  const crashed = r.status !== 0 && pass === null;
  rows.push({ name, cmd, status: r.status, pass, fail, crashed, out,
    hung: isHung(r), noOutput: out.trim() === '' });
}

const bad = rows.filter(isBad);
const ok = rows.filter(r => !isBad(r));

console.log(`\n共 ${rows.length} 个测试脚本${sliceTag}`);
console.log(`✅ 正常（有汇总行且断言数 > 0）：${ok.length}`);
console.log(`⚠️  可疑：${bad.length}\n`);

for (const r of bad) {
  const why = whyOf(r);
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
console.log(`通过 ${ok.length + (selfTotal - selfFails.length)} 项，失败 ${totalFail} 项`);
// 可疑项 + 自检失败都要以非 0 退出：体检单本身必须能被 CI 判红，
// 否则"体检跑了但没人看退出码"又是一次静默。
process.exit(totalFail ? 1 : 0);
