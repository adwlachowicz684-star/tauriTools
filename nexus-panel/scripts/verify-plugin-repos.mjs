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
import {
  PRODUCT_REPOS, workflowContract, assetContract,
} from './release-chain-contract.mjs';
import {
  loadPluginRepoState, savePluginRepoState, stateDriftReport,
} from './plugin-repo-state.mjs';

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
const mirrorShas = new Map();            // ② 节顺手记下每仓 js/market-binding.js 的实测 sha，供 ⑦ 节用
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
    mirrorShas.set(repo, remote.get('js/market-binding.js') || '');
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
const loaded = loadPluginRepoState(STATE);
const state = loaded.state;
const rep = stateDriftReport({
  state, loadError: loaded.ok ? '' : loaded.reason,
  heads, fix: FIX_STATE, drift, netFail, expectedCount: IDS_TODO.length,
});
for (const line of rep.lines) console.log(line);
stateDrift = rep.stateDrift;
if (rep.fatal) {
  /* 损坏不是「状态落后」：--fix-state 拿空对象重写会把损坏洗白成合法状态，
   * 12 仓的 owned / scope / refreshedAt 历史一并丢失，输出还报 ✅。 */
  console.log('  ⛔ 状态文件损坏，核验不通过；请人工修复状态文件，不要跑 --fix-state');
  drift++;
} else if (stateDrift) {
  if (rep.canFix) {
    for (const [repo, head] of heads) {
      const old = state[repo] && state[repo].commit;
      state[repo] = { ...(state[repo] || {}), owned: true, done: true, commit: head };
      console.log(`  🔧 ${repo}: 状态 ${String(old).slice(0, 8)} → ${head.slice(0, 8)}`);
    }
    /* 原子写：临时文件 + rename，防 502 留下半份内容。父目录必须是真实
     * git 目录，共享模块不会替我们造一个出来。 */
    savePluginRepoState(STATE, state);
    console.log('  ✅ 状态已校准（原子写）');
    stateDrift = 0;
  } else if (FIX_STATE) {
    console.log('  ⛔ --fix-state 前置条件不满足（内容漂移 / 网络故障 / 仓数不齐），拒绝改状态');
  } else {
    console.log('  ℹ️  状态漂移未校准；确认内容一致后可加 --fix-state');
  }
}
/* ------------------------------------------------------------------ *
 * ⑤ 退场源码台账的归属仓可达性
 * ------------------------------------------------------------------ *
 * 主仓 retired-source-guard-test.mjs 把「哪些守卫还引用着已迁出的插件源码」
 * 记成欠账，每行写明该判据该迁往哪个私有仓。台账若填了不存在的仓名，
 * 那些欠账就永远销不掉、也没人发现 —— 归属仓清单必须与真实仓对齐。
 * 只验仓名与「本轮核验通过」，不逐文件：逐文件是迁移落地时那一轮的事。
 * --only 只核部分仓时，未核验的仓只提示、不算红。 */
let ledgerRepos = new Set(), ledgerErr = '';
try {
  const L = JSON.parse(fs.readFileSync(
    path.join(HERE, 'retired-source-guards.json'), 'utf8'));
  for (const row of L.rows || []) {
    for (const r of row.repos || []) {
      if (r !== '（合成样本，无归属仓）') ledgerRepos.add(r);
    }
  }
} catch (e) { ledgerErr = e.message; }
const knownRepos = new Set(IDS.map(repoNameFor));
const unknownRepos = [...ledgerRepos].filter((r) => !knownRepos.has(r));
const unverified = ONLY ? [] : [...ledgerRepos]
  .filter((r) => knownRepos.has(r) && !heads.has(r));
if (ledgerErr || unknownRepos.length || unverified.length) {
  console.log(`  ❌ 退场源码台账：解析失败「${ledgerErr || '无'}」`
    + ` / 未知归属仓 ${unknownRepos.length}${unknownRepos.length ? '（' + unknownRepos.join(', ') + '）' : ''}`
    + ` / 未核验通过 ${unverified.length}${unverified.length ? '（' + unverified.join(', ') + '）' : ''}`);
  drift++;
} else {
  console.log(`  ✅ 退场源码台账：${ledgerRepos.size} 个归属仓均在 12 仓清单内${ONLY ? '' : '且本轮核验通过'}`);
}

/* ------------------------------------------------------------------ *
 * ⑥ 产物链契约：13 个仓（12 可安装 + 已发版的外部工具型）
 * ------------------------------------------------------------------ *
 * 历史口径把 EXTERNAL_PLUGINS 写成「不参与产物链」，建仓 / 刷新 / 发布
 * 三条通道只遍历 IDS，主仓守卫还把这个「不覆盖」钉成契约。但
 * githubManager 仓已有 manifest、v0.1.0 release 与 tar.gz 资产，宿主按
 * 同一条 pickAsset / verifyAssetDigest / plugin-installer 链路安装，主仓
 * CSP 也为它放行了 api.github.com —— 它参与产物链，只是不该进共享镜像：
 * 把外部仓塞进 IDS 会把 js/ css/ src/ 推过去覆盖 Node CLI 的真实实现。
 *
 * 所以这里单独覆盖 13 个仓的**发版契约**，不动四条通道的遍历源。
 * 没有 release 的仓视为尚未发版，跳过资产校验（不算红）。
 */
let chainChecked = 0, chainSkipped = 0, chainDrift = 0;
const ONLY_IDS = ONLY ? new Set(ONLY.split(',')) : null;
for (const { id, repo } of PRODUCT_REPOS) {
  if (ONLY_IDS && !ONLY_IDS.has(id)) continue;
  try {
    const meta = await gh(`/repos/${OWNER}/${repo}`);
    if (!meta.private) {
      console.log(`  ❌ ${repo}: 产物链仓不是私有仓库`);
      chainDrift++;
      continue;
    }
    const wf = await gh(`/repos/${OWNER}/${repo}/contents/.github/workflows/release.yml`);
    const yml = Buffer.from(wf.content, 'base64').toString('utf8');
    const wc = workflowContract(yml);
    if (!wc.ok) {
      console.log(`  ❌ ${repo}: release.yml 违约（${wc.errors.join('；')}）`);
      chainDrift++;
    }
    const mfRaw = await gh(`/repos/${OWNER}/${repo}/contents/nexus.plugin.json`);
    const mf = JSON.parse(Buffer.from(mfRaw.content, 'base64').toString('utf8'));
    let rel = null;
    try {
      rel = await gh(`/repos/${OWNER}/${repo}/releases/latest`);
    } catch (e) {
      if (!/HTTP 404/.test(e.message)) throw e;
    }
    if (!rel) {
      chainSkipped++;
      console.log(`  ⏭  ${repo.padEnd(40)} 尚未发版，跳过资产校验${wc.ok ? '' : '（workflow 仍需修）'}`);
    } else {
      const ac = assetContract(rel, id, mf.version);
      if (!ac.ok) {
        console.log(`  ❌ ${repo}: release 资产违约（${ac.errors.join('；')}）`);
        chainDrift++;
      } else {
        console.log(`  ✅ ${repo.padEnd(40)} 发版契约 / state / digest / tag 一致`);
      }
    }
    chainChecked++;
  } catch (e) {
    console.log(`  ⚠️  ${repo}: 产物链无法核验（${e.message}）`);
    netFail++;
  }
}
drift += chainDrift;

/* ------------------------------------------------------------------ *
 * ⑦ 镜像台账逐仓实测交叉
 * ------------------------------------------------------------------ *
 * market-result-format-test.mjs 的 ⑩c 只比「主仓文件 vs 台账 sha」，台账
 * 本身从没拿 12 仓实测复核过：改主仓时顺手改台账，离线守卫就全绿，而
 * 12 仓还是旧文件（台账 why 里管这叫「把漂移洗白成基线」）。
 * ② 节守「主仓 vs 12 仓」，⑦ 节守「台账声明 vs 12 仓实测」——闭环里
 * 缺的正是这一环。台账解析失败 / 缺 perRepo 一律 fail-closed 报红，
 * --only 只核指定仓，未核的不算红。 */
let mirrorDrift = 0, mirrorChecked = 0;
const MIRROR_REL = 'js/market-binding.js';
let mirrorLedger = null, mirrorErr = '';
try {
  mirrorLedger = JSON.parse(fs.readFileSync(
    path.join(HERE, 'market-result-mirror.json'), 'utf8'));
} catch (e) { mirrorErr = e.message; }
const masterSha = gitBlobSha(fs.readFileSync(path.join(ROOT, MIRROR_REL)));
if (mirrorErr || !mirrorLedger || !mirrorLedger.perRepo
    || typeof mirrorLedger.perRepo !== 'object' || Array.isArray(mirrorLedger.perRepo)) {
  console.log(`  ❌ 镜像台账：解析失败「${mirrorErr || '无'}」或缺 perRepo 逐仓快照`);
  mirrorDrift++;
} else {
  if (masterSha !== mirrorLedger.sharedBlobSha) {
    console.log(`  ❌ 镜像台账：主仓 ${MIRROR_REL} sha 与台账 sharedBlobSha 不符`
      + `（主仓 ${masterSha.slice(0, 8)} / 台账 ${String(mirrorLedger.sharedBlobSha).slice(0, 8)}）`);
    mirrorDrift++;
  }
  const ledgerKeys = Object.keys(mirrorLedger.perRepo);
  const missingRepos = [...knownRepos].filter((r) => !ledgerKeys.includes(r));
  if (missingRepos.length) {
    console.log(`  ❌ 镜像台账：perRepo 缺 ${missingRepos.length} 仓（${missingRepos.join(', ')}）`);
    mirrorDrift++;
  }
  for (const id of IDS_TODO) {
    const repo = repoNameFor(id);
    const actual = mirrorShas.get(repo);
    if (!actual) continue;          // ② 节没取到（网络/API 故障已计入 netFail）
    const claimed = mirrorLedger.perRepo[repo];
    mirrorChecked++;
    if (claimed !== actual || claimed !== masterSha) {
      console.log(`  ❌ ${repo}: 镜像台账 sha 与实测不符`
        + `（台账 ${String(claimed).slice(0, 8)} / 12 仓 ${actual.slice(0, 8)}`
        + ` / 主仓 ${masterSha.slice(0, 8)}）`);
      mirrorDrift++;
    }
  }
  if (!mirrorDrift) {
    console.log(`  ✅ 镜像台账：${mirrorChecked} 仓逐仓实测与台账 / 主仓一致${ONLY ? '（--only）' : ''}`);
  }
}
drift += mirrorDrift;

console.log(`\n结果：${IDS_TODO.length} 仓 / ${checkedFiles} 文件 / 漂移 ${drift}`
  + ` / 状态漂移 ${stateDrift} / 网络故障 ${netFail} / 台账归属仓 ${ledgerRepos.size}`
  + ` / 产物链 ${chainChecked} 核验（未发版 ${chainSkipped} / 违约 ${chainDrift}）`
  + ` / 镜像台账 ${mirrorChecked} 核验（违约 ${mirrorDrift}）`);
if (netFail) process.exit(2);
if (drift || stateDrift) process.exit(1);
