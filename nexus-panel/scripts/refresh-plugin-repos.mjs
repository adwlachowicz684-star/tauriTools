#!/usr/bin/env node
/**
 * 12 个插件仓库的**增量刷新**通道（补上断点续跑缺的那半边）。
 *
 * 为什么需要它
 * ------------------------------------------------------------
 * create-plugin-repos.mjs 的状态是「done 就跳过」：改了主仓的共享文件、
 * 或改了某份 manifest 之后，已完成的仓永远不会再刷新，而界面/构建
 * 照样正常 —— 漂移静默发生。全量重推 1872 个文件既慢又容易撞限流，
 * 且会覆盖别人可能推过的东西。
 *
 * 所以这里只做一件事：**把「远端 tree 与本地骨架」逐文件比对出的
 * 内容差异，用 contents API 带 sha 乐观锁逐文件替换**。
 *
 * 防覆盖（三层，缺一不可）
 * ------------------------------------------------------------
 *  ① 远端 tree 不得有骨架里没有的文件（有人往仓里加过东西 → 拒绝）
 *  ② 骨架里不得有远端缺失的文件（本通道不支持新增，报告后拒绝）
 *  ③ 每个待替换文件 PUT 时带远端当前 blob sha：期间被改过 → 412 拒绝
 * 另：只有 private 仓才刷新；非私有视为异常，不碰。
 *
 * 状态同步
 * ------------------------------------------------------------
 * 每次 PUT 都会产生一个新 commit，HEAD 随之变化。若不同步更新状态里的
 * commit，create-plugin-repos.mjs 的防覆盖会把「我自己刚推的」判成
 * 「别人推过」而拒绝后续任何刷新。所以刷新成功并复验后，原子写回
 * .git/plugin-repos-v2-state.json（tmp + rename，防 502 留下半份 JSON）。
 *
 * 用法：
 *   node scripts/refresh-plugin-repos.mjs --dry-run
 *   node scripts/refresh-plugin-repos.mjs [--only mindmap,task-board]
 *
 * 退出码：0 全部刷新/已一致 / 1 有仓被拒绝或复验失败 / 2 网络/API 故障
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { IDS, skeletonFiles, repoNameFor, ROOT } from './build-plugin-repos.mjs';

const TOKEN = fs.readFileSync('/data/user_persistent_data/tools/.git_token', 'utf8').trim();
const OWNER = 'adwlachowicz684-star';
const API = 'https://api.github.com';
const STATE = path.join(ROOT, '.git', 'plugin-repos-v2-state.json');
const arg = (k, def) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : def; };
const ONLY = arg('--only', null);
const DRY = process.argv.includes('--dry-run');
const IDS_TODO = ONLY ? ONLY.split(',').filter(x => IDS.includes(x)) : IDS;

const gitBlobSha = b => crypto.createHash('sha1')
  .update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');

async function gh(method, p, body, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + p, {
        method,
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'nexus-panel-refresh-repos',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r.ok) return await r.json();
      const txt = await r.text();
      if (r.status === 412 || r.status === 409 || r.status === 422) {
        /* sha 乐观锁命中 / 冲突：绝不重试，直接把真因抛出去 */
        throw Object.assign(new Error(`${method} ${p} → ${r.status} ${txt.slice(0, 240)}`), { fatal: true });
      }
      if (r.status === 403 && /secondary rate limit/i.test(txt)) {
        await new Promise(z => setTimeout(z, 30000 * (i + 1))); continue;
      }
      if (r.status >= 500 || r.status === 429) {
        if (i === tries - 1) throw new Error(`${method} ${p} → ${r.status} ${txt.slice(0, 240)}`);
        await new Promise(z => setTimeout(z, 1000 * (i + 1))); continue;
      }
      throw Object.assign(new Error(`${method} ${p} → ${r.status} ${txt.slice(0, 240)}`), { fatal: true });
    } catch (e) {
      if (e.fatal || i === tries - 1) throw e;
      await new Promise(z => setTimeout(z, 800 * (i + 1)));
    }
  }
  throw new Error(`重试耗尽: ${method} ${p}`);
}

/* contents API 的 path：斜杠要保留，只编码各段（中文文件名等） */
const cpath = rel => rel.split('/').map(encodeURIComponent).join('/');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, STATE);
}

let rejected = 0, netFail = 0, refreshed = 0, already = 0;
let state = loadState();

for (const id of IDS_TODO) {
  const repo = repoNameFor(id);
  const files = skeletonFiles(id);
  const expected = new Map(Object.entries(files).map(([rel, buf]) => [rel, { buf, want: gitBlobSha(buf) }]));
  try {
    const meta = await gh('GET', `/repos/${OWNER}/${repo}`);
    if (!meta.private) { console.log(`  ⛔ ${repo}: 不是私有仓库，拒绝刷新`); rejected++; continue; }

    const head = await gh('GET', `/repos/${OWNER}/${repo}/git/ref/heads/main`);
    const tree = await gh('GET', `/repos/${OWNER}/${repo}/git/trees/${head.object.sha}?recursive=1`);
    if (tree.truncated) { console.log(`  ⛔ ${repo}: tree 被截断，无法判定`); rejected++; continue; }
    const remote = new Map(tree.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));

    const extra = [...remote.keys()].filter(rel => !expected.has(rel));
    const missing = [...expected.keys()].filter(rel => !remote.has(rel));
    const changed = [...expected.keys()].filter(rel => remote.has(rel) && remote.get(rel) !== expected.get(rel).want);

    /* ① ② 前置：不认识的文件 / 新增文件一律不碰，避免把别人的提交洗掉 */
    if (extra.length || missing.length) {
      console.log(`  ⛔ ${repo}: 远端独有 ${extra.length} / 本地独有 ${missing.length}，拒绝增量刷新`);
      if (extra.length) console.log(`     远端独有示例: ${extra.slice(0, 3).join(', ')}`);
      if (missing.length) console.log(`     本地独有示例: ${missing.slice(0, 3).join(', ')}`);
      rejected++; continue;
    }
    if (!changed.length) {
      console.log(`  ✅ ${repo.padEnd(40)} ${expected.size} 文件已一致，无需刷新`);
      already++; continue;
    }
    console.log(`  🔄 ${repo}: 待刷新 ${changed.length} 文件 → ${changed.join(', ')}`);
    if (DRY) { refreshed++; continue; }

    /* ③ 逐文件 PUT，带远端当前 blob sha 作乐观锁 */
    let lastCommit = null;
    for (const rel of changed) {
      const cur = await gh('GET', `/repos/${OWNER}/${repo}/contents/${cpath(rel)}?ref=main`);
      if (cur.sha !== remote.get(rel)) {
        throw Object.assign(new Error(`${rel}: 乐观锁前置不一致（读取时 ${cur.sha}，比树时 ${remote.get(rel)}）`), { fatal: true });
      }
      const put = await gh('PUT', `/repos/${OWNER}/${repo}/contents/${cpath(rel)}`, {
        message: `chore: 增量刷新 ${rel}（与主仓骨架对齐）`,
        content: expected.get(rel).buf.toString('base64'),
        sha: cur.sha,
        branch: 'main',
      });
      if (!put.commit || !put.commit.sha) {
        throw Object.assign(new Error(`${rel}: PUT 未返回 commit`), { fatal: true });
      }
      lastCommit = put.commit.sha;
      console.log(`     · ${rel} → ${lastCommit.slice(0, 8)}`);
    }

    /* 复验：刷新后整棵树必须与骨架逐文件一致，不能只信 PUT 的返回 */
    const head2 = await gh('GET', `/repos/${OWNER}/${repo}/git/ref/heads/main`);
    const tree2 = await gh('GET', `/repos/${OWNER}/${repo}/git/trees/${head2.object.sha}?recursive=1`);
    if (tree2.truncated) throw Object.assign(new Error('复验 tree 被截断'), { fatal: true });
    const remote2 = new Map(tree2.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
    const bad = [...expected.keys()].filter(rel => remote2.get(rel) !== expected.get(rel).want);
    if (bad.length || remote2.size !== expected.size) {
      throw Object.assign(new Error(`复验失败：${bad.length} 处不一致 / 文件数 ${remote2.size}≠${expected.size}`), { fatal: true });
    }

    /* 状态同步：新 HEAD 才是我方最新提交，不写回去下次刷新会被防覆盖拦住 */
    state[repo] = {
      ...(state[repo] || {}), owned: true, done: true,
      commit: head2.object.sha,
      refreshedAt: new Date().toISOString(),
      refreshedFiles: changed,
    };
    saveState(state);
    refreshed++;
    console.log(`     ✅ 复验通过，状态 commit → ${head2.object.sha.slice(0, 8)}`);
    await new Promise(z => setTimeout(z, 1500));
  } catch (e) {
    if (e.fatal || /412|409|422|乐观锁|复验|拒绝/.test(e.message)) {
      console.log(`  ⛔ ${repo}: ${e.message}`);
      rejected++;
    } else {
      console.log(`  ⚠️  ${repo}: 网络/API 故障（${e.message}）—— 不算通过`);
      netFail++;
    }
  }
}

console.log(`\n结果：${IDS_TODO.length} 仓 / 刷新 ${refreshed} / 已一致 ${already}`
  + ` / 拒绝 ${rejected} / 网络故障 ${netFail}${DRY ? ' / DRY-RUN' : ''}`);
if (netFail) process.exit(2);
if (rejected) process.exit(1);
