#!/usr/bin/env node
/**
 * 跨端契约联网探针（只读，不进 CI）
 * ------------------------------------------------------------
 * 12 个 iframe 插件源码退场后，TS 侧契约（api.ts / types.ts）已迁到
 * 独立私有仓，主仓只剩 Rust 侧。于是：
 *
 *   · `test:crossend-contract`（无 --ts-root）会 fail-closed 报
 *     「契约源缺失」—— 这是真实欠账，不假装绿；
 *   · 本探针从 nexusPanel_plugin_projectGroup 仓取真实 TS 契约，
 *     用 --ts-root 指过去，跑一次**真的**跨端比对。
 *
 * 为什么不进体检 / 不登记 npm script：网络失败不能冒充契约漂移，
 * 私有仓还需要凭据。混进 CI 会把「取不到」和「真的不一致」搅在一起，
 * 这正是本项目反复在防的假绿/假红。
 *
 * 用法：GITHUB_TOKEN=xxx node scripts/probe-crossend-repos.mjs
 * 退出码：0 契约一致 / 1 真的不一致 / 2 无法判定（缺凭据、网络、源缺失）
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const OWNER = process.env.CROSSEND_OWNER || 'adwlachowicz684-star';
const REPO = process.env.CROSSEND_REPO || 'nexusPanel_plugin_projectGroup';
const REF = process.env.CROSSEND_REF || 'main';
const FILES = ['plugins/project-group/api.ts', 'plugins/project-group/types.ts'];
const TOKEN = process.env.GITHUB_TOKEN || '';

const die = (msg, code = 2) => { console.error('❌ ' + msg); process.exit(code); };
if (!TOKEN) die('缺 GITHUB_TOKEN（私有仓需要凭据）；无法判定契约，不能当作一致');

const H = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'crossend-probe',
};
/* 用 Node 内置 fetch：本环境 curl 走代理会挂（实测 exit=null），
   而 fetch 能正常取到 tree。网络异常一律 exit 2，绝不冒充契约一致。 */
async function api(path) {
  const url = path.startsWith('http') ? path : `https://api.github.com/repos/${OWNER}/${REPO}/${path}`;
  let res;
  try {
    res = await fetch(url, { headers: H, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    die(`取不到 ${url}（${e.message}）：网络或代理异常，无法判定`);
  }
  if (!res.ok) die(`取不到 ${url}（HTTP ${res.status}）：仓名、ref 或权限问题`);
  return res.json();
}

const tree = await api(`git/trees/${encodeURIComponent(REF)}?recursive=1`);
if (tree.truncated) die('远端 tree 被截断（truncated=true），不能拿不完整清单做判定');
const byPath = new Map(tree.tree.filter((x) => x.type === 'blob').map((x) => [x.path, x]));
const missing = FILES.filter((f) => !byPath.has(f));
if (missing.length) die(`独立仓缺少契约文件：${missing.join(', ')}（仓 ${OWNER}/${REPO}@${REF}）`);

const tmp = mkdtempSync(join(tmpdir(), 'crossend-ts-'));
try {
  for (const f of FILES) {
    const meta = byPath.get(f);
    const blob = await api(`git/blobs/${meta.sha}`);
    if (blob.encoding !== 'base64') die(`${f} 的 blob 编码不是 base64，无法判定`);
    const buf = Buffer.from(blob.content.replace(/\n/g, ''), 'base64');
    if (buf.length !== meta.size) die(`${f} 长度不符（tree=${meta.size} 实取=${buf.length}），拒绝拿残缺内容比对`);
    writeFileSync(join(tmp, f.split('/').pop()), buf);
  }

  console.log(`契约源：${OWNER}/${REPO}@${REF}（${FILES.length} 个 TS 文件）`);
  console.log(`Rust 源：${join(REPO_ROOT, 'src-tauri/src')}\n`);

  const r = spawnSync('node',
    ['cross-end-check.mjs', '--strict', `--ts-root=${tmp}`],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  console.log(out.trimEnd());

  if (r.status === null) die(`被检脚本超时/被杀（${r.error?.message || '未知'}），判定不可信`);
  const m = /Rust 命令 (\d+) · 注册 (\d+) · 前端调用 (\d+)/.exec(out);
  if (!m) die('被检脚本没有标准统计行，判定不可信');
  if (Number(m[3]) === 0) die('前端调用解析为 0：契约源没读到，不能当作一致');
  if (r.status === 0 && !/全部一致/.test(out)) die('exit 0 却没有「全部一致」，判定不可信');
  if (r.status === 1 && !/失败 \d+ 项/.test(out)) die('exit 1 却没有汇总行，判定不可信');

  console.log(`\n探针结论：${r.status === 0 ? '✅ 真实契约一致' : '❌ 真实契约存在漂移（exit 1）'}`);
  process.exit(r.status === 0 ? 0 : 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

