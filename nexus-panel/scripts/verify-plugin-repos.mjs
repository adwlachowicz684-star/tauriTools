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
 * ⚠️ 源码退场后的口径（与 refresh 一致）
 * ------------------------------------------------------------
 * 12 个插件源码已移出主仓、各仓自治，主仓只还持有共享镜像 js/ css/ src/。
 * 因此核验范围严格限定为 sharedMirrorFiles()：插件源码 / README /
 * package.json 不再比（主仓无权威副本，比了就是拿旧留档冒充判据）。
 * 但**必须**额外验入口 plugins/<id>/index.html 存在、元数据齐全，
 * 否则「空仓 + 共享文件全对」会是一次假绿。
 *
 * ⚠️ 联网探针，刻意不登记 npm script：网络失败会让「内容漂移」和
 * 「GitHub 不可达」混成同一种红。CI 里只跑离线守卫，本脚本人工/联调时跑。
 *    node scripts/verify-plugin-repos.mjs
 *    node scripts/verify-plugin-repos.mjs --only mindmap,task-board
 *    node scripts/verify-plugin-repos.mjs --fix-state
 *
 * --fix-state：校准断点续跑状态里的 commit。
 *   状态文件记的是「初始化那次提交的 sha」，而后续我又给 12 个仓各推过
 *   一次 README 修正（commit message：共享镜像一致性守卫指向主仓真实脚本）。
 *   HEAD 变了、状态没变 → 下次任何刷新/续跑都会撞上防覆盖：
 *   「HEAD 与状态记录不一致，拒绝覆盖（可能有人推过）」。
 *   这不是别人推的，是我自己推的，但脚本分不出来。
 *   前置条件极严：**全部仓逐文件一致 + 零网络故障 + 仓数齐全**才允许改；
 *   有内容漂移时绝不改状态（否则会把漂移当成基线记下来）。
 *
 * 退出码：0 全部一致 / 1 存在漂移、非私有或未校准的状态 / 2 网络或 API 故障
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { IDS, sharedMirrorFiles, repoNameFor, ROOT, repoStatePath } from './build-plugin-repos.mjs';
import { wantFields, fieldDiffs } from './plugin-manifest-fields.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = '/data/user_persistent_data/tools/.git_token';
const OWNER = 'adwlachowicz684-star';
const API = 'https://api.github.com';
const registry = await import('../plugins/registry.js');
const arg = (k, def) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : def; };
const ONLY = arg('--only', null);
const IDS_TODO = ONLY ? ONLY.split(',').filter(x => IDS.includes(x)) : IDS;
const FIX_STATE = process.argv.includes('--fix-state');
const STATE = repoStatePath();

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

/* 共享镜像只取一次，空集合直接拒：0 文件全对是最完美的假绿 */
const MIRROR = sharedMirrorFiles();
if (!MIRROR.size) {
  console.error('⛔ 主仓共享镜像为空，拒绝空跑假绿');
  process.exit(1);
}
const expected = [...MIRROR].map(([rel, buf]) => [rel, gitBlobSha(buf)]);
const META_FILES = ['nexus.plugin.json', 'package.json', 'vite.config.mjs',
  '.gitignore', 'README.md', '.github/workflows/release.yml'];
console.log(`核验口径：共享镜像 ${expected.length} 文件 + 入口 + ${META_FILES.length} 元数据\n`);

let drift = 0, netFail = 0, checkedFiles = 0, stateDrift = 0;
const heads = new Map();                 // 只有「逐文件一致 + private」通过的仓才进这里
for (const id of IDS_TODO) {
  const repo = repoNameFor(id);
  try {
    // ① 仓库必须存在且私有 —— 用户要的是「全部私有」，这条不能只靠建仓时的参数
    const meta = await gh(`/repos/${OWNER}/${repo}`);
    if (!meta.private) { console.log(`  ❌ ${repo}: 不是私有仓库`); drift++; continue; }
    // ② 取 HEAD tree，共享镜像逐文件比 sha
    const head = await gh(`/repos/${OWNER}/${repo}/git/ref/heads/main`);
    const tree = await gh(`/repos/${OWNER}/${repo}/git/trees/${head.object.sha}?recursive=1`);
    if (tree.truncated) { console.log(`  ❌ ${repo}: tree 被截断，无法判定`); drift++; continue; }
    const remote = new Map(tree.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
    let diff = 0, missing = 0;
    for (const [rel, want] of expected) {
      if (!remote.has(rel)) missing++;
      else if (remote.get(rel) !== want) diff++;
    }
    const hasEntry = remote.has(`plugins/${id}/index.html`);
    const metaMissing = META_FILES.filter(x => !remote.has(x));
    if (diff || missing || !hasEntry || metaMissing.length) {
      console.log(`  ❌ ${repo}: 共享 ${expected.length} / 漂移 ${diff} / 缺失 ${missing}`
        + ` / 入口 ${hasEntry} / 元数据缺 ${metaMissing.length}${metaMissing.length ? '（' + metaMissing.join(', ') + '）' : ''}`);
      drift++;
    } else {
      console.log(`  ✅ ${repo.padEnd(40)} 共享 ${expected.length} 逐字节一致 / 入口在 / 元数据齐 / private / ${remote.size} blobs`);
      heads.set(repo, head.object.sha);
    }
    checkedFiles += expected.length;
    /* ③ 独立仓 manifest 与主仓 registry 逐字段交叉一致。
     * 主仓 12 份清单已随源码迁出，本地生成器的校验对象不存在了，职责随对象
     * 一起搬到插件仓。只验 repo 一个字段不够：name / icon / entry / kind /
     * description 漂了，两边各自都合法、界面却不一致，且不报错。
     * 期望值由独立算法给出，不 import 生成器（避免自己验自己）。 */
    const c = await gh(`/repos/${OWNER}/${repo}/contents/nexus.plugin.json`);
    const mf = JSON.parse(Buffer.from(c.content, 'base64').toString('utf8'));
    const p = registry.plugins.find((x) => x.id === id);
    const bad = p ? fieldDiffs(mf, wantFields(p, ROOT)) : ['registry 里没有该插件 id'];
    const repoBad = mf.repo !== `${OWNER}/${repo}`;
    if (bad.length || repoBad) {
      console.log(`  ❌ ${repo}: 清单漂移 ${bad.length} 项${bad.length ? '（' + bad.join('; ') + '）' : ''}`);
      if (!bad.length && repoBad) console.log(`  ❌ ${repo}: manifest.repo=${mf.repo}（应为 ${OWNER}/${repo}）`);
      drift++;
      /* 记过也要撤回：只有检查全过的仓才允许 --fix-state 把 HEAD
       * 当合法基线，否则漂移会被洗白成新基线。 */
      heads.delete(repo);
    }
  } catch (e) {
    console.log(`  ⚠️  ${repo}: 无法核验（${e.message}）—— 网络/API 故障，不算通过`);
    netFail++;
  }
}
/* ------------------------------------------------------------------ *
 * ④ 断点续跑状态里的 commit 是否还是当前 HEAD
 * ------------------------------------------------------------------ *
 * 状态落后时 create-plugin-repos.mjs 的防覆盖会把「我自己后来推的 README
 * 修正」当成「别人推过」而拒绝任何刷新。不修，下一轮改动就推不进去。 */
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* 无状态文件：只报告 */ }
for (const [repo, head] of heads) {
  const want = state[repo] && state[repo].commit;
  if (want !== head) {
    console.log(`  ⚠️  ${repo}: 状态 commit ${String(want).slice(0, 8)} != HEAD ${head.slice(0, 8)}`);
    stateDrift++;
  }
}
if (stateDrift) {
  const canFix = FIX_STATE && drift === 0 && netFail === 0 && heads.size === IDS_TODO.length;
  if (canFix) {
    for (const [repo, head] of heads) {
      const old = state[repo] && state[repo].commit;
      state[repo] = { ...(state[repo] || {}), owned: true, done: true, commit: head };
      console.log(`  🔧 ${repo}: 状态 ${String(old).slice(0, 8)} → ${head.slice(0, 8)}`);
    }
    /* 原子写：502 中断写到一半会留下非法 JSON，下次 loadState() 直接当空状态，
     * 12 个仓全被判成「别人的仓」而拒绝覆盖（本项目已栽过两次）。 */
    const tmp = STATE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, STATE);
    console.log('  ✅ 状态已校准（原子写）');
    stateDrift = 0;
  } else if (FIX_STATE) {
    console.log('  ⛔ --fix-state 前置条件不满足（内容漂移 / 网络故障 / 仓数不齐），拒绝改状态');
  } else {
    console.log('  ℹ️  状态漂移未校准；确认内容一致后可加 --fix-state');
  }
}
console.log(`\n结果：${IDS_TODO.length} 仓 / ${checkedFiles} 文件 / 漂移 ${drift}`
  + ` / 状态漂移 ${stateDrift} / 网络故障 ${netFail}`);
if (netFail) process.exit(2);
if (drift || stateDrift) process.exit(1);
