#!/usr/bin/env node
/**
 * 一键把 12 个插件骨架建成 12 个独立 GitHub 仓库。
 *
 * 命名：nexusPanel_plugin_<驼峰 id>（见 build-plugin-repos.mjs 的 CAMEL 表），
 *       全部 private。产物名前缀 `nexus-plugin-` 与仓库名无关，不跟着改。
 *
 * 断点续跑（这本身就是「断点续传」在推送侧的一层）：
 *   状态文件记录每个仓库 {done, commit, files}。502 / Ctrl-C / 网络断后重跑，
 *   已 done 的直接跳过，未完成的从整仓重推（tree 全量覆盖，幂等）。
 *
 * 防覆盖（本项目反复踩过）：
 *   仓库已存在且 HEAD 不等于状态里记录的我方 commit → 拒绝推送，不 force。
 *   只有「状态里记着我推过」才允许 PATCH ref。
 *
 * 用法：
 *   node scripts/create-plugin-repos.mjs --dry-run          # 权限预检 + 打印计划，不建仓
 *   node scripts/create-plugin-repos.mjs                    # 真正建 + 推
 *   node scripts/create-plugin-repos.mjs --only color-picker,dupview
 *   node scripts/create-plugin-repos.mjs --reset-state       # 清状态重新推（仓库已存在时仍防覆盖）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDS, skeletonFiles, sha, ROOT, repoNameFor } from './build-plugin-repos.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = fs.readFileSync('/data/user_persistent_data/tools/.git_token', 'utf8').trim();
const OWNER = 'adwlachowicz684-star';
// 与上一轮 nexus-plugin-* 的状态文件分开：key 换了，混用会把「新仓还没建」
// 误判成「旧仓已完成」，也会让 --reset-state 误删旧记录。
const STATE = path.resolve(ROOT, '.git', 'plugin-repos-v2-state.json');
const DRY = process.argv.includes('--dry-run');
const arg = (k, def) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : def; };
const ONLY = arg('--only', null);
const IDS_TODO = ONLY ? ONLY.split(',').filter(x => IDS.includes(x)) : IDS;

const API = 'https://api.github.com';
let remainingCalls = 0;

async function gh(method, url, body, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + url, {
        method,
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'nexus-panel-create-repos',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      remainingCalls++;
      if (r.status === 404) return { _404: true };
      if (r.status === 409) {
        const t409 = await r.text();
        // 空仓库：GitHub 对 /git/refs 与 /git/blobs 都返回 409 而非 404
        if (/Git Repository is empty/i.test(t409)) return { _404: true, _empty: true };
        throw new Error(`${method} ${url} → 409 ${t409.slice(0, 240)}`);
      }
      if (r.status === 403) {
        const t403 = await r.text();
        // 内容创建型 secondary limit：短时间建太多仓库/commit 会触发，
        // 与 x-ratelimit-remaining 无关（主限流还有余量也会中招）。等待后重试。
        if (/secondary rate limit|temporarily blocked/i.test(t403)) {
          // 连建 10+ 仓后短时内容创建会触发，固定 60s 连撞三次仍不够。
          const wait = 60000 * Math.min(i + 1, 3);
          console.log(`    ⏳ secondary rate limit，等待 ${wait / 1000}s 后重试…`);
          await new Promise(z => setTimeout(z, wait));
          continue;
        }
        if ((r.headers.get('x-ratelimit-remaining') || '1') === '0') {
          await new Promise(z => setTimeout(z, 20000)); continue;
        }
        throw new Error(`${method} ${url} → 403 ${t403.slice(0, 600)}`);
      }
      if (!r.ok) {
        const t = await r.text();
        const e = new Error(`${method} ${url} → ${r.status} ${t.slice(0, 600)}`);
        e.status = r.status;
        // 4xx 不重试（权限/校验类），5xx 与网络错误重试
        if (r.status < 500 && r.status !== 429) throw e;
        if (i === tries - 1) throw e;
        await new Promise(z => setTimeout(z, 1000 * (i + 1)));
        continue;
      }
      return await r.json();
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      if (i === tries - 1) throw e;
      await new Promise(z => setTimeout(z, 800 * (i + 1)));
    }
  }
  // 之前重试耗尽会 fall through 返回 undefined，调用方报
  // "Cannot read properties of undefined (reading 'name')"，把限流真因盖掉。
  throw new Error(`重试耗尽: ${method} ${url}`);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return {}; }
}
function saveState(s) {                       // 原子写：tmp + rename，防 502 写坏半份 JSON
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, STATE);
}

async function blob(repo, buf) {
  const r = await gh('POST', `/repos/${OWNER}/${repo}/git/blobs`,
    { content: buf.toString('base64'), encoding: 'base64' });
  if (!r.sha) throw new Error('blob 无 sha: ' + JSON.stringify(r).slice(0, 200));
  return r.sha;
}

/** 并发受限的 map，避免一次打满 API */
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function pushRepo(id, state) {
  const repo = repoNameFor(id);
  const files = skeletonFiles(id);
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  // done:true 同样是我方记录：第 263 行早期版本写入 {done:true,...} 时漏掉了 owned，
  // 于是已完成的仓在 dry-run / 状态重建后会被误判成「别人的仓」而拒绝覆盖。
  let owned = !!(state[repo] && (state[repo].owned || state[repo].done));

  // ① 仓库存在？
  const cur = await gh('GET', `/repos/${OWNER}/${repo}`);
  if (cur._404) {
    if (DRY) { console.log(`  [dry] 将创建 ${repo}`); }
    else {
      let r;
      try {
        r = await gh('POST', '/user/repos', {
          name: repo, private: true, auto_init: false,
          description: `nexus-panel 独立插件：${id}`,
          has_issues: false, has_projects: false, has_wiki: false,
        });
      } catch (e) {
        // 并发副本刚建好同名仓库 → 接管，不视为失败
        if (!/name already exists/i.test(e.message)) throw e;
        console.log(`  ${repo} 已被并发创建，接管`);
        r = { name: repo };
      }
      if (!r.name) throw new Error('创建仓库失败: ' + JSON.stringify(r).slice(0, 200));
      console.log(`  创建 ${repo} ✅`);
      owned = true;
      state[repo] = { owned: true, done: false };
      saveState(state);                    // 立刻落 owned，中断重跑才知道这是我们的仓库
    }
  } else {
    const head = await gh('GET', `/repos/${OWNER}/${repo}/git/ref/heads/main`);
    const isEmpty = !!head._404;
    // 防覆盖：非空仓库且不是我方建/我方接管 → 拒绝
    if (!isEmpty && !owned) {
      throw new Error(`${repo} 已存在且 HEAD=${head.object.sha.slice(0, 8)} 非我方记录，拒绝覆盖`);
    }
    // 已完成态还要比对 commit：owned 只说明「仓是我建的」，不能说明
    // 「之后没人往里推过」。HEAD 与我方记录不一致时一律拒绝 force。
    if (!isEmpty && state[repo] && state[repo].done && state[repo].commit
        && head.object.sha !== state[repo].commit) {
      throw new Error(`${repo} HEAD=${head.object.sha.slice(0, 8)} 与状态记录的 `
        + `${state[repo].commit.slice(0, 8)} 不一致，拒绝覆盖（可能有人推过）`);
    }
    // 空仓库没有任何内容可覆盖，可安全接管（兼容上一轮只建了仓没推成的情形）
    if (isEmpty) { owned = true; state[repo] = { owned: true, done: false }; saveState(state); }
  }
  if (DRY) return { repo, files: entries.length, dry: true };

  // ② 空仓库 GitHub 不允许 POST /git/blobs（409 Git Repository is empty）。
  //    先用 contents API 放 README.md 造出第一个 commit，仓库即「非空」。
  //    用清单里同一个 Buffer，后续 tree 里的 README 与之逐字节一致。
  let head = await gh('GET', `/repos/${OWNER}/${repo}/git/ref/heads/main`);
  let baseCommit = null;
  if (head._404) {
    const readme = files['README.md'];
    const seeded = await gh('PUT', `/repos/${OWNER}/${repo}/contents/README.md`, {
      message: 'chore: 初始化空仓库（种子提交，供 Git Data API 使用）',
      content: readme.toString('base64'),
    });
    if (!seeded.commit || !seeded.commit.sha) throw new Error('种子提交失败: ' + JSON.stringify(seeded).slice(0, 200));
    baseCommit = seeded.commit.sha;
    console.log(`  种子提交 ${baseCommit.slice(0, 8)} ✅`);
  } else {
    baseCommit = head.object.sha;
  }

  // ③ 逐文件建 blob
  const shas = await pooled(entries, 3, async ([, buf]) => blob(repo, buf));

  // ④ tree → commit → ref
  // 单次 create-tree 塞整棵大树会被 GitHub 拒（实测 516 文件 → 422
  // "input too large ... Consider building the tree incrementally"）。
  // 分批 + base_tree 增量：每批只带本批条目，上一批的 tree 作下一批的
  // base_tree，最终 sha 即完整树。批次大小是体积而非语义，改小不影响结果。
  const TREE_BATCH = 60;
  let treeSha = null;
  for (let start = 0; start < entries.length; start += TREE_BATCH) {
    const batch = entries.slice(start, start + TREE_BATCH);
    const body = {
      tree: batch.map(([rel], j) => ({
        path: rel, mode: '100644', type: 'blob', sha: shas[start + j],
      })),
    };
    if (treeSha) body.base_tree = treeSha;
    const t = await gh('POST', `/repos/${OWNER}/${repo}/git/trees`, body);
    if (!t.sha) throw new Error(`tree 失败（批次 ${Math.floor(start / TREE_BATCH) + 1}）`);
    treeSha = t.sha;
  }
  const tree = { sha: treeSha };
  const commit = await gh('POST', `/repos/${OWNER}/${repo}/git/commits`, {
    message: `chore: 独立插件仓库初始化（${id}，${entries.length} 文件）`,
    tree: tree.sha, parents: baseCommit ? [baseCommit] : [],
  });
  if (!commit.sha) throw new Error('commit 失败');
  await gh('PATCH', `/repos/${OWNER}/${repo}/git/refs/heads/main`, { sha: commit.sha, force: true });

  // ④ 独立核验：远端 tree 与本地清单逐文件 sha 一致
  const remoteTree = await gh('GET', `/repos/${OWNER}/${repo}/git/trees/${commit.sha}?recursive=1`);
  const remoteMap = new Map((remoteTree.tree || []).filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
  let diff = 0;
  for (const [rel, buf] of entries) {
    const want = gitBlobSha(buf);
    if (remoteMap.get(rel) !== want) { console.log(`    DIFF ${repo}/${rel}`); diff++; }
  }
  if (diff) throw new Error(`${repo} 远端核验 ${diff} 处不一致`);
  return { repo, files: entries.length, commit: commit.sha, tree: tree.sha, verified: true };
}

// git blob sha（与 gh_put.py 同口径）
import crypto from 'node:crypto';
function gitBlobSha(b) {
  return crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
}

// ---------- 主流程 ----------
(async () => {
  if (process.argv.includes('--reset-state') && fs.existsSync(STATE)) fs.unlinkSync(STATE);
  const me = await gh('GET', '/user');
  console.log(`身份：${me.login} | 计划 ${IDS_TODO.length} 个仓库 | ${DRY ? 'DRY-RUN（不写远端）' : '真实执行'}`);

  // 权限预检：GET /user 能过不代表能建仓；先探测一次「创建类权限」的响应头
  const probe = await fetch(API + '/user', { headers: { Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'nexus-panel' } });
  console.log(`  scopes: ${probe.headers.get('x-oauth-scopes') || '(fine-grained token / 无 scopes 头)'}`);

  const state = loadState();
  let ok = 0, skipped = 0, failed = [];
  for (const id of IDS_TODO) {
    const repo = repoNameFor(id);
    if (state[repo] && state[repo].done) {
      console.log(`  ${id}: 已完成，跳过（commit ${state[repo].commit.slice(0, 8)}）`);
      skipped++; continue;
    }
    try {
      console.log(`\n[${id}] 开始（${Object.keys(skeletonFiles(id)).length} 文件）`);
      const r = await pushRepo(id, state);
      if (!DRY) {
        state[repo] = { owned: true, done: true, commit: r.commit, files: r.files, at: new Date().toISOString() };
        saveState(state);                    // 每仓完成即落状态 → 断点续跑
        console.log(`  ${id}: ✅ ${r.files} 文件 / commit ${r.commit.slice(0, 8)} / 远端逐文件核验通过`);
      }
      ok++;
      if (!DRY) await new Promise(z => setTimeout(z, 5000));   // 仓间间隔，防内容创建限流
    } catch (e) {
      console.log(`  ${id}: ❌ ${e.message}`);
      failed.push({ id, err: e.message });
      // 权限类错误立刻停，不要连建 12 个半成品
      if (/403|401|Bad credentials|Resource not accessible|拒绝覆盖/.test(e.message)) break;
    }
  }
  console.log(`\n结果：成功 ${ok} / 跳过 ${skipped} / 失败 ${failed.length} / API 调用 ${remainingCalls}`);
  if (failed.length) { console.log('失败清单：', JSON.stringify(failed, null, 2)); process.exit(1); }
})().catch(e => { console.error('致命错误：', e); process.exit(2); });
