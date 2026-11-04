#!/usr/bin/env node
/**
 * 退场态红项探针（联网，**不进 CI**）
 * ==========================================================================
 * 本地工作区留着 12 份插件源码副本，守卫在这里跑是全绿的；干净远端 clone
 * 上 5 个守卫里 4 个红。判断退场态只能拉远端 HEAD 实跑，不能信本地。
 *
 * 用法：
 *   node scripts/probe-retired-state.mjs            # 刷新 scripts/retired-guard-snapshot.json
 *   node scripts/probe-retired-state.mjs --check    # 只比对，漂移退出 1
 *
 * ⚠️ 网络失败/拉不到 tarball → exit 2，绝不写快照（失败不能冒充「没漂移」）。
 * ⚠️ 销账流程：先修守卫 → 跑本探针刷新快照 → 再改欠账台账 → 跑
 *    retired-guard-debt-test.mjs 验两边一致。顺序反了会红，这是刻意的。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = join(ROOT, 'scripts/retired-guard-snapshot.json');
const TOKEN_FILE = '/data/workspace/.gh_token';
const OWNER = 'adwlachowicz684-star';
const BASE = '/data/workspace/.main_remote_guards';
const TAR = '/data/workspace/.main_remote_guards.tar.gz';
const CHECK = process.argv.includes('--check');
const GUARDS = [
  'test-registry-test.mjs',
  'test-coverage-guard-test.mjs',
  'retired-supply-test.mjs',
  'orphan-modules-guard-test.mjs',
  'plugin-repo-sync-test.mjs',
];

let TOKEN = '';
try { TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { /* CI 无凭据时走匿名 */ }
const H = TOKEN
  ? { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'nexus-probe' }
  : { Accept: 'application/vnd.github+json', 'User-Agent': 'nexus-probe' };

/* 1. 拉远端 HEAD */
let buf;
try {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/tauriTools/tarball/main`, { headers: H });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  buf = Buffer.from(await r.arrayBuffer());
} catch (e) {
  console.error(`❌ 拉远端 tarball 失败：${e.message}（不写快照）`);
  process.exit(2);
}
mkdirSync(BASE, { recursive: true });
writeFileSync(TAR, buf);
execFileSync('rm', ['-rf', BASE]);
mkdirSync(BASE, { recursive: true });
execFileSync('tar', ['-xzf', TAR, '-C', BASE, '--strip-components=1'], { stdio: 'pipe' });
const NP = join(BASE, 'nexus-panel');
if (!existsSync(join(NP, 'package.json'))) { console.error('❌ 解压后缺 nexus-panel/package.json'); process.exit(2); }

/* 2. 实跑守卫，采集红项（断言名与 retired-guard-debt 台账同一规范化口径） */
const reds = [];
for (const g of GUARDS) {
  const r = spawnSync('node', [g], { cwd: NP, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const text = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
  const lines = text.split('\n').filter((l) => l.includes('❌'))
    .map((l) => l.replace(/^\s*❌\s*/, '').split(' — ')[0].split(' → ')[0].trim());
  for (const a of lines) reds.push(`${g}\u0000${a}`);
  const summary = text.split('\n').filter((l) => /通过\s*\d+\s*项/.test(l)).slice(-1)[0] || '(无汇总行)';
  console.log(`[${g}] exit=${r.status} 红 ${lines.length} 条 ${summary}`);
}
reds.sort();
console.log(`\n合计 ${reds.length} 条红项`);

if (CHECK) {
  const old = JSON.parse(readFileSync(SNAP, 'utf8'));
  const a = JSON.stringify(reds), b = JSON.stringify([...old.reds].sort());
  if (a !== b) { console.log('❌ 快照漂移：请刷新快照并同步销台账'); process.exit(1); }
  console.log('✅ 快照一致');
  process.exit(0);
}

const prev = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, 'utf8')) : {};
writeFileSync(SNAP, JSON.stringify({
  note: '由 scripts/probe-retired-state.mjs 生成；离线守卫只认这份快照，不联网。',
  capturedBy: 'probe-retired-state.mjs',
  reds,
}, null, 2) + '\n');
const before = (prev.reds || []).length;
console.log(`✅ 快照已刷新：${before} → ${reds.length} 条（销账请同步改 scripts/retired-guard-debt.json）`);
