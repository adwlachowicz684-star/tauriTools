#!/usr/bin/env node
/**
 * 12 个独立插件仓库的「共享镜像有没有漂移」核验探针。
 *
 * 为什么需要它：骨架把主仓的 js/ css/ src/ 整目录镜像进每个插件仓库
 * （见 build-plugin-repos.mjs），一份实现变成 12 份拷贝。改了主仓却没
 * 刷新某个仓库时，那个仓库照样能构建、界面照样能开，漂移静默发生。
 * 只有逐文件比对远端 tree 才能发现。
 *
 * 判据不是「文件数相等」：文件数相等但某个 js/ 内容旧了一版，照样会通过。
 * 这里用 git blob sha1 逐文件比，与 create-plugin-repos.mjs 推送时的
 * gitBlobSha() 同口径。
 *
 * ⚠️ 联网探针，刻意不登记 npm script：网络失败会让「内容漂移」和
 * 「GitHub 不可达」混成同一种红。CI 里只跑离线守卫，本脚本人工/联调时跑。
 *    node scripts/verify-plugin-repos.mjs
 *    node scripts/verify-plugin-repos.mjs --only mindmap,task-board
 *
 * 退出码：0 全部一致 / 1 存在漂移或仓库不私有 / 2 网络或 API 故障（不算通过）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { IDS, skeletonFiles, repoNameFor, ROOT } from './build-plugin-repos.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = '/data/user_persistent_data/tools/.git_token';
const OWNER = 'adwlachowicz684-star';
const API = 'https://api.github.com';
const arg = (k, def) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : def; };
const ONLY = arg('--only', null);
const IDS_TODO = ONLY ? ONLY.split(',').filter(x => IDS.includes(x)) : IDS;

const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const gitBlobSha = b => crypto.createHash('sha1')
  .update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');

async function gh(p) {
  const r = await fetch(API + p, {
    headers: {
      Authorization: 'Bearer ' + token,
      'User-Agent': 'nexus-panel-verify-repos',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${p}`);
  return r.json();
}

let drift = 0, netFail = 0, checkedFiles = 0;
for (const id of IDS_TODO) {
  const repo = repoNameFor(id);
  const files = skeletonFiles(id);
  const expected = Object.entries(files).map(([rel, buf]) => [rel, gitBlobSha(buf)]);
  try {
    // ① 仓库必须存在且私有 —— 用户要的是「全部私有」，这条不能只靠建仓时的参数
    const meta = await gh(`/repos/${OWNER}/${repo}`);
    if (!meta.private) { console.log(`  ❌ ${repo}: 不是私有仓库`); drift++; continue; }
    // ② 取 HEAD tree，逐文件比 sha
    const head = await gh(`/repos/${OWNER}/${repo}/git/ref/heads/main`);
    const tree = await gh(`/repos/${OWNER}/${repo}/git/trees/${head.object.sha}?recursive=1`);
    if (tree.truncated) { console.log(`  ❌ ${repo}: tree 被截断，无法判定`); drift++; continue; }
    const remote = new Map(tree.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
    let diff = 0;
    for (const [rel, want] of expected) if (remote.get(rel) !== want) diff++;
    if (diff || remote.size !== expected.length) {
      console.log(`  ❌ ${repo}: 本地 ${expected.length} / 远端 ${remote.size} / sha 不一致 ${diff}`);
      drift++;
    } else {
      console.log(`  ✅ ${repo.padEnd(40)} ${expected.length} 文件逐字节一致 / private`);
    }
    checkedFiles += expected.length;
    // ③ manifest 的 repo 字段必须指向本仓，不能留着旧名
    const c = await gh(`/repos/${OWNER}/${repo}/contents/nexus.plugin.json`);
    const mf = JSON.parse(Buffer.from(c.content, 'base64').toString('utf8'));
    if (mf.repo !== `${OWNER}/${repo}`) {
      console.log(`  ❌ ${repo}: manifest.repo=${mf.repo}（应为 ${OWNER}/${repo}）`);
      drift++;
    }
  } catch (e) {
    console.log(`  ⚠️  ${repo}: 无法核验（${e.message}）—— 网络/API 故障，不算通过`);
    netFail++;
  }
}
console.log(`\n结果：${IDS_TODO.length} 仓 / ${checkedFiles} 文件 / 漂移 ${drift} / 网络故障 ${netFail}`);
if (netFail) process.exit(2);
if (drift) process.exit(1);
