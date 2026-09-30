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
 * 运行：node sweep-tests.mjs [--only=关键字]
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';

const entries = Object.entries(pkg.scripts)
  .filter(([k, v]) => k.startsWith('test:') && /\.mjs|\.cjs|\.tsx?/.test(v))
  .filter(([k]) => !only || k.includes(only))
  .sort();

// 汇总行的几种写法（项目里不统一，全列出来；少一种就会把正常测试误判成"没汇总"）
const SUMMARY = [
  /通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/,
  /(\d+)\s*passed\s*,\s*(\d+)\s*failed/i,
  /通过\s*(\d+)\s*\/\s*失败\s*(\d+)/,
  /通过\s*(\d+)\s*项/,
  /(\d+)\s*\/\s*(\d+)\s*(?:通过|通过项)/,
];

const rows = [];
for (const [name, cmd] of entries) {
  const r = spawnSync('bash', ['-lc', cmd], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const out = (r.stdout || '') + (r.stderr || '');
  let pass = null, fail = null;
  for (const re of SUMMARY) {
    const m = out.match(re);
    if (m) { pass = Number(m[1]); fail = m[2] !== undefined ? Number(m[2]) : 0; break; }
  }
  const crashed = r.status !== 0 && pass === null;
  rows.push({ name, cmd, status: r.status, pass, fail, crashed, out });
}

const bad = rows.filter(r => r.status !== 0 || r.pass === null || r.pass === 0);
const ok = rows.filter(r => r.status === 0 && r.pass !== null && r.pass > 0);

console.log(`\n共 ${rows.length} 个测试脚本`);
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

console.log(`\n明细已写入 /data/workspace/_sweep_r117.txt`);
const fs = await import('node:fs');
fs.writeFileSync('/data/workspace/_sweep_r117.txt',
  rows.map(r => `${r.status}\t${r.pass}\t${r.fail}\t${r.name}\t${r.cmd}`).join('\n'));
process.exit(0);
