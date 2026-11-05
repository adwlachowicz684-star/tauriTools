#!/usr/bin/env node
/**
 * 跨端契约 CI 联网探针（只读，不进体检 / 不登记 npm script）
 * ------------------------------------------------------------
 * 离线守卫 crossend-ci-guard-test.mjs 只能验主仓模板与台账；
 * 「12 仓真的按台账装了 workflow」「CI 真的跑绿了」必须联网验。
 *
 * 退出码：0 全部通过 / 1 真的不一致（缺装、错装、内容漂移、run 非绿）
 *         2 无法判定（缺凭据、网络、权限、tree 截断）—— 绝不冒充通过
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/probe-crossend-ci.mjs
 *   GITHUB_TOKEN=xxx node scripts/probe-crossend-ci.mjs --refresh-scan
 *     ↑ 重新扫 12 仓的 api.ts / types.ts 分布并写回 crossend-ci-scan.json；
 *       写完只打印「已刷新，请复核后提交」，不自动声明守卫已通过。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const R = (p) => join(ROOT, p);
const OWNER = process.env.CROSSEND_OWNER || 'adwlachowicz684-star';
const TOKEN = process.env.GITHUB_TOKEN || '';
const REF = 'main';
const WF = '.github/workflows/contract.yml';
const TEMPLATE = 'templates/plugin-repo/contract.yml';

const die = (msg, code = 2) => { console.error('❌ ' + msg); process.exit(code); };
if (!TOKEN) die('缺 GITHUB_TOKEN（12 仓均为私有仓）；无法判定，不能当作通过');

const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json',
            'User-Agent': 'crossend-ci-probe' };
async function api(repo, path) {
  const url = `https://api.github.com/repos/${OWNER}/${repo}/${path}`;
  let res;
  try { res = await fetch(url, { headers: H, signal: AbortSignal.timeout(60000) }); }
  catch (e) { die(`取不到 ${url}（${e.message}）：网络异常，无法判定`); }
  if (res.status === 404) return null;
  if (!res.ok) die(`取不到 ${url}（HTTP ${res.status}）：权限或仓名问题，无法判定`);
  return res.json();
}

const gitBlobSha = (buf) => createHash('sha1')
  .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');

const tplBuf = readFileSync(R(TEMPLATE));
const tplSha = gitBlobSha(tplBuf);
const scan = JSON.parse(readFileSync(R('scripts/crossend-ci-scan.json'), 'utf8'));
const ledger = JSON.parse(readFileSync(R('scripts/crossend-ci-applicable.json'), 'utf8'));
const allRepos = Object.keys(scan.repos).sort();
const applicable = new Set(ledger.rows.map((r) => r.repo));
const problems = [];

/* ---------- 1. 逐仓 tree：workflow 装没装、内容对不对 ---------- */
const nextScan = {};
for (const repo of allRepos) {
  const tree = await api(repo, `git/trees/${encodeURIComponent(REF)}?recursive=1`);
  if (!tree) die(`${repo} 的 tree 取不到（404）：仓可能被删或权限不足`);
  if (tree.truncated) die(`${repo} 的 tree 被截断（truncated=true），不能拿不完整清单判定`);
  const blobs = tree.tree.filter((x) => x.type === 'blob');
  const byPath = new Map(blobs.map((x) => [x.path, x]));

  /* 刷新快照：只记录 api.ts / types.ts 结尾的路径 */
  nextScan[repo] = {
    api: blobs.map((x) => x.path).filter((p) => p.endsWith('/api.ts') || p === 'api.ts').sort(),
    types: blobs.map((x) => x.path).filter((p) => p.endsWith('/types.ts') || p === 'types.ts').sort(),
  };

  const wf = byPath.get(WF);
  if (applicable.has(repo)) {
    if (!wf) problems.push(`[缺装] ${repo} 应装 ${WF}，远端没有`);
    else if (wf.sha !== tplSha) problems.push(`[内容漂移] ${repo} 的 ${WF} 与主仓模板不一致（远端 ${wf.sha.slice(0, 8)} / 模板 ${tplSha.slice(0, 8)}）`);
  } else if (wf) {
    problems.push(`[错装] ${repo} 不在适用台账却装了 ${WF}：该仓缺 api.ts，装上去必然 fail-closed 报红`);
  }
  console.log(`  ${repo}: workflow=${wf ? wf.sha.slice(0, 8) : '无'} | api.ts=${nextScan[repo].api.length} types.ts=${nextScan[repo].types.length}`);
}

/* ---------- 2. 适用仓的 CI 真的跑绿了吗 ---------- */
for (const repo of applicable) {
  const runs = await api(repo, `actions/workflows/contract.yml/runs?per_page=5`);
  if (!runs) { problems.push(`[CI 无记录] ${repo} 查不到 contract.yml 的 workflow runs`); continue; }
  const list = runs.workflow_runs || [];
  if (!list.length) { problems.push(`[CI 未跑] ${repo} 没有任何 run`); continue; }
  const head = await api(repo, `commits/${REF}`);
  if (!head) die(`${repo} 的 HEAD 取不到，无法判定 run 是否对应当前版本`);
  const done = list.find((r) => r.status === 'completed');
  if (!done) { problems.push(`[CI 未完成] ${repo} 最近 5 次 run 没有 completed`); continue; }
  if (done.conclusion !== 'success') {
    problems.push(`[CI 非绿] ${repo} run #${done.run_number} conclusion=${done.conclusion}`);
  }
  if (done.head_sha !== head.sha) {
    problems.push(`[CI 过期] ${repo} 最近绿 run 的 head=${(done.head_sha || '').slice(0, 8)}，仓 HEAD=${head.sha.slice(0, 8)}：不能拿旧版本的绿代表当前`);
  }
  console.log(`  ${repo} CI: run #${done.run_number} conclusion=${done.conclusion} head=${(done.head_sha || '').slice(0, 8)} / HEAD ${head.sha.slice(0, 8)}`);
}

/* ---------- 3. --refresh-scan：写回实测快照 ---------- */
if (process.argv.includes('--refresh-scan')) {
  scan.repos = nextScan;
  scan.scannedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(R('scripts/crossend-ci-scan.json'), JSON.stringify(scan, null, 2) + '\n');
  console.log('已刷新 crossend-ci-scan.json（请复核后提交；本次不自动声明守卫通过）');
}

/* ---------- 汇总 ---------- */
console.log(`\n探针结论：通过 ${allRepos.length + applicable.size - problems.length} 项，失败 ${problems.length} 项`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
