#!/usr/bin/env node
/**
 * 主仓插件源码退场：一次提交完成「产物落地 + 源码删除」
 * ============================================================
 *
 * 为什么必须是**一次 commit**、而不是「先删后补」两步
 * ------------------------------------------------------------
 * 远端主仓原本只有 plugins/<id>/ 源码，runtime-plugins/ 一个文件都没有
 * （实测 1481 blob，runtime-plugins/ 下 0）。分两步会留下一个中间态：
 * clone 下来既没有源码、也没有产物 → 构建链彻底断，且不报错。
 * 一次 tree 提交把 291 个产物加进去、969 个源码删掉，HEAD 始终是可用态。
 *
 * 防覆盖（本项目反复踩过）
 * ------------------------------------------------------------
 *   · 取 HEAD sha，创建 commit 时 parent 指向它，PATCH ref 带 sha 乐观锁；
 *     期间有人推过 → 422，整个提交不落地，不会静默覆盖。
 *   · 只对 12 个明确 id 的目录动手，且逐条核对远端 tree 里确实存在。
 *   · --dry-run 只打印计划，不创建 blob、不写 ref。
 *
 * 为什么源码可以删
 * ------------------------------------------------------------
 * 12 个私有仓里已逐文件 git blob sha 比对过，948 个文件缺失 0 /
 * 内容不一致 0（scripts/verify-plugin-repos.mjs 同口径），另有本地留档 zip。
 * 删的是**重复的副本**，不是唯一一份。
 *
 * 用法： node scripts/retire-plugin-sources.mjs --dry-run
 *        node scripts/retire-plugin-sources.mjs --apply
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMEL } from './plugin-repo-map.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const TOKEN_FILE = '/data/user_persistent_data/tools/.git_token';
const OWNER = 'adwlachowicz684-star';
const REPO = 'tauriTools';
const API = 'https://api.github.com';
const PREFIX = 'nexus-panel/';

/* 名单只用唯一真值源：新增插件只需补 CAMEL 表，本脚本自动跟上。
   硬编码第二份名单 = 改了一处漏一处，而漏的那个插件源码会留在主仓里
   （或被误删），scope 与守卫都看不出来。 */
const IDS = Object.keys(CAMEL).sort();
if (IDS.length !== 12) throw new Error(`插件名单数量异常：${IDS.length}（应为 12）`);

const DRY = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply');
if (DRY === APPLY) { console.error('必须且只能指定 --dry-run 或 --apply 之一'); process.exit(2); }
if (!existsSync(TOKEN_FILE)) { console.error('缺凭据'); process.exit(2); }

const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'nexus-retire',
  'X-GitHub-Api-Version': '2022-11-28',
};
async function api(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { ...H, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch { /* 非 JSON */ }
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${txt.slice(0, 200)}`);
  return { status: r.status, j };
}

/* ---------- 1. 取 HEAD 与完整 tree ---------- */
const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`);
const headSha = ref.j.object.sha;
const commit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${headSha}`);
const baseTreeSha = commit.j.tree.sha;
const tree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${baseTreeSha}?recursive=1`);
if (tree.j.truncated) throw new Error('远端 tree 被截断，拒绝在不确定状态下删除');
const blobs = tree.j.tree.filter(x => x.type === 'blob' && x.path.startsWith(PREFIX));

/* ---------- 2. 收集本地产物 ---------- */
const prodRoot = join(ROOT, 'runtime-plugins');
const prodFiles = [];
const walk = (d) => {
  for (const n of readdirSync(d).sort()) {
    const f = resolve(d, n);
    if (statSync(f).isDirectory()) walk(f);
    else {
      const rel = relative(prodRoot, f).replace(/\\/g, '/');
      if (!IDS.includes(rel.split('/')[0])) continue;   // 只带 12 个市场插件
      prodFiles.push({ path: `${PREFIX}runtime-plugins/${rel}`, abs: f });
    }
  }
};
walk(prodRoot);

/* ---------- 3. 删除集合：12 个插件目录，逐条确认远端存在 ---------- */
const delPaths = blobs
  .filter(x => IDS.some(id => x.path.startsWith(`${PREFIX}plugins/${id}/`)))
  .map(x => x.path);
const missingExpected = IDS.filter(id => !delPaths.some(p => p.startsWith(`${PREFIX}plugins/${id}/`)));
if (missingExpected.length) throw new Error(`这些插件在远端没有源码，状态异常：${missingExpected.join(', ')}`);

/* 守卫：registry.js / README-services.md 绝不能在删除集合里 */
const protectedPaths = [`${PREFIX}plugins/registry.js`, `${PREFIX}plugins/README-services.md`];
for (const p of protectedPaths) {
  if (delPaths.includes(p)) throw new Error(`拒绝删除外壳文件 ${p}`);
}

console.log(`HEAD           : ${headSha}`);
console.log(`远端 blob 总数 : ${blobs.length}（nexus-panel/ 下）`);
console.log(`待删源码文件   : ${delPaths.length}`);
console.log(`待加产物文件   : ${prodFiles.length}`);
console.log(`保留外壳文件   : ${protectedPaths.filter(p => blobs.some(b => b.path === p)).length}/2`);
for (const id of IDS) {
  const d = delPaths.filter(p => p.startsWith(`${PREFIX}plugins/${id}/`)).length;
  const a = prodFiles.filter(p => p.path.startsWith(`${PREFIX}runtime-plugins/${id}/`)).length;
  console.log(`  ${id.padEnd(14)} 删 ${String(d).padStart(4)} | 加产物 ${String(a).padStart(4)}`);
}
if (DRY) { console.log('\n[dry-run] 未创建 blob、未写 ref。'); process.exit(0); }

/* ---------- 4. 建 blob（并发，带重试） ---------- */
const withRetry = async (fn, n = 3) => {
  let last;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  throw last;
};
const created = [];
const CHUNK = 12;
for (let i = 0; i < prodFiles.length; i += CHUNK) {
  const batch = prodFiles.slice(i, i + CHUNK);
  const rs = await Promise.all(batch.map(f => withRetry(async () => {
    const content = readFileSync(f.abs).toString('base64');
    const r = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content, encoding: 'base64' });
    return { path: f.path, mode: '100644', type: 'blob', sha: r.j.sha };
  })));
  created.push(...rs);
  if ((i / CHUNK) % 5 === 0) console.log(`  blob ${created.length}/${prodFiles.length}`);
}
console.log(`  blob 完成 ${created.length}/${prodFiles.length}`);

/* ---------- 5. 一次 tree：删 + 加 ---------- */
const entries = [
  ...delPaths.map(path => ({ path, mode: '100644', type: 'blob', sha: null })),
  ...created,
];
const nt = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
  base_tree: baseTreeSha, tree: entries,
});
console.log(`新 tree: ${nt.j.sha}`);

/* ---------- 6. commit + PATCH ref（sha 乐观锁） ---------- */
const nc = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message: '插件源码迁出至 12 个独立私有仓；主仓改由 runtime-plugins 产物供给',
  tree: nt.j.sha, parents: [headSha],
});
const patched = await fetch(`${API}/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
  method: 'PATCH',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sha: nc.j.sha, force: false }),
});
/* 乐观锁靠 force:false 本身：新 commit 以 headSha 为 parent，若期间有人把
   ref 推到别的提交，本次写入就不是 fast-forward → 422 拒绝，不会覆盖。
   提交后再复核 HEAD 的 parent 是否仍等于记录值，把「并发插入」显式报出来。 */
if (patched.status >= 400) throw new Error(`PATCH ref 失败 ${patched.status} ${await patched.text()}`);
console.log(`新 commit: ${nc.j.sha}`);

/* ---------- 7. 复核：HEAD 的 parent 必须是我们记录的 headSha（无人插队） ---------- */
const now = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`);
const nowCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${now.j.object.sha}`);
const parentOk = nowCommit.j.parents?.[0]?.sha === headSha;
console.log(`复核 HEAD parent == 记录值: ${parentOk}`);
if (!parentOk) {
  console.error('⚠️ 期间有并发提交，本次 commit 仍是直线历史但需人工确认顺序');
  process.exit(3);
}

/* ---------- 8. 复核删干净、产物齐 ---------- */
const after = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/main?recursive=1`);
const ap = after.j.tree.filter(x => x.type === 'blob' && x.path.startsWith(PREFIX));
const left = ap.filter(x => IDS.some(id => x.path.startsWith(`${PREFIX}plugins/${id}/`))).length;
const prod = ap.filter(x => x.path.startsWith(`${PREFIX}runtime-plugins/`)).length;
console.log(`复核：残留源码 ${left}，产物文件 ${prod}，registry.js 在 ${ap.some(x => x.path === `${PREFIX}plugins/registry.js`)}`);
console.log(left === 0 && prod === prodFiles.length ? '\n✅ 退场完成' : '\n❌ 复核不通过');
process.exit(left === 0 && prod === prodFiles.length ? 0 : 1);
