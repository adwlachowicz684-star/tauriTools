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
 * 所以这里只做一件事：**把主仓共享镜像（js/ css/ src/）与远端 tree
 * 逐文件比对出的内容差异，用 contents API 带 sha 乐观锁逐文件替换**。
 *
 * ⚠️ 源码退场后的口径变更（不是放宽）
 * ------------------------------------------------------------
 * 12 个插件源码已从主仓移出，各仓自治。主仓不再持有它们的权威副本，
 * 因此**不再重建整仓骨架** —— 那会把各仓自己的 README / package.json /
 * 插件源码一并判成「该改」，而主仓根本无从判断对错。刷新范围严格限定
 * 在 SHARED 路径集合；其它文件一律不碰，复验还会核对 blob 总数不变。
 *
 * 防覆盖（三层，缺一不可）
 * ------------------------------------------------------------
 *  ① 只有 private 仓才刷新；非私有视为异常，不碰
 *  ② 远端必须**已存在全部** SHARED 路径（本通道不支持新增，缺失即拒绝）
 *  ③ 每个待替换文件 PUT 时带远端当前 blob sha：期间被改过 → 412 拒绝
 * 复验另核对远端 blob 总数不变，防 PUT 误删/误加别的文件。
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
import { IDS, sharedMirrorFiles, repoNameFor, ROOT, repoStatePath } from './build-plugin-repos.mjs';

const TOKEN = fs.readFileSync('/data/user_persistent_data/tools/.git_token', 'utf8').trim();
const OWNER = 'adwlachowicz684-star';
const API = 'https://api.github.com';
const STATE = repoStatePath();
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

/* 共享镜像只取一次：12 仓用的是同一份主仓权威字节。
 * 空集合必须直接拒 —— 否则「0 文件、全部一致」会是一次完美的假绿。 */
const MIRROR = sharedMirrorFiles();
if (!MIRROR.size) {
  console.error('⛔ 主仓共享镜像为空（js/ css/ src/ 都不存在？），拒绝空跑假绿');
  process.exit(1);
}
const expected = new Map([...MIRROR].map(([rel, buf]) => [rel, { buf, want: gitBlobSha(buf) }]));
console.log(`共享镜像：${expected.size} 文件；刷新范围严格限定于此，其余文件一律不碰\n`);

for (const id of IDS_TODO) {
  const repo = repoNameFor(id);
  try {
    const meta = await gh('GET', `/repos/${OWNER}/${repo}`);
    if (!meta.private) { console.log(`  ⛔ ${repo}: 不是私有仓库，拒绝刷新`); rejected++; continue; }

    const head = await gh('GET', `/repos/${OWNER}/${repo}/git/ref/heads/main`);
    const tree = await gh('GET', `/repos/${OWNER}/${repo}/git/trees/${head.object.sha}?recursive=1`);
    if (tree.truncated) { console.log(`  ⛔ ${repo}: tree 被截断，无法判定`); rejected++; continue; }
    const remote = new Map(tree.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));

    /* 插件入口必须在：空仓 / 误删源码时拒绝，不能只对着共享文件刷完报绿 */
    const entry = `plugins/${id}/index.html`;
    if (!remote.has(entry)) {
      console.log(`  ⛔ ${repo}: 插件入口 ${entry} 不存在，拒绝刷新`);
      rejected++; continue;
    }

    /* ② 远端必须已有全部 SHARED 路径。缺一个都拒绝：本通道不支持新增，
     * 静默跳过会让「新共享文件没进仓」表现为全绿。 */
    const missing = [...expected.keys()].filter(rel => !remote.has(rel));
    if (missing.length) {
      console.log(`  ⛔ ${repo}: 共享镜像在远端缺失 ${missing.length} 文件，拒绝增量刷新`);
      console.log(`     示例: ${missing.slice(0, 3).join(', ')}`);
      rejected++; continue;
    }
    const changed = [...expected.keys()].filter(rel => remote.get(rel) !== expected.get(rel).want);
    if (!changed.length) {
      console.log(`  ✅ ${repo.padEnd(40)} ${expected.size} 共享文件已一致，无需刷新`);
      already++; continue;
    }
    console.log(`  🔄 ${repo}: 待刷新 ${changed.length} 共享文件 → ${changed.join(', ')}`);
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

    /* 复验：共享文件逐字节对齐 + 远端 blob 总数不变（证明没碰别的文件），
     * 不能只信 PUT 的返回。 */
    const head2 = await gh('GET', `/repos/${OWNER}/${repo}/git/ref/heads/main`);
    const tree2 = await gh('GET', `/repos/${OWNER}/${repo}/git/trees/${head2.object.sha}?recursive=1`);
    if (tree2.truncated) throw Object.assign(new Error('复验 tree 被截断'), { fatal: true });
    const remote2 = new Map(tree2.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
    const bad = [...expected.keys()].filter(rel => remote2.get(rel) !== expected.get(rel).want);
    if (bad.length || remote2.size !== remote.size) {
      throw Object.assign(new Error(
        `复验失败：共享不一致 ${bad.length} 处 / blob 总数 ${remote.size}→${remote2.size}`), { fatal: true });
    }

    /* 状态同步：新 HEAD 才是我方最新提交，不写回去下次刷新会被防覆盖拦住 */
    state[repo] = {
      ...(state[repo] || {}), owned: true, done: true,
      commit: head2.object.sha,
      refreshedAt: new Date().toISOString(),
      scope: 'shared-only',
      refreshedFiles: changed,
    };
    saveState(state);
    refreshed++;
    console.log(`     ✅ 复验通过（共享 ${expected.size} 文件对齐 / blob 总数 ${remote.size} 不变）`
      + `，状态 commit → ${head2.object.sha.slice(0, 8)}`);
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
