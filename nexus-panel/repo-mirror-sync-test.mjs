#!/usr/bin/env node
/**
 * 12 仓共享镜像口径守卫（离线、cwd 无关、不联网）
 * ============================================================
 * 背景：12 个 iframe 插件源码退场后，build-plugin-repos.mjs 的 IDS 仍靠
 * 扫 plugins/<id>/nexus.plugin.json 得到 —— 那个目录只剩 module 外壳，
 * IDS 变空数组，骨架 / 刷新 / 核验整套工具链「空跑报 0」，不报错不崩不红。
 *
 * 同时主仓不再持有插件源码的权威副本，刷新与核验的口径必须收紧到
 * **共享镜像 js/ css/ src/**；插件源码、README、package.json 归各仓自治。
 * 但「只比共享文件」天然容易退化成假绿（空仓共享文件全对也通过），
 * 所以入口 / 元数据 / private / 总数不变这些判据一条都不能少。
 *
 * 本守卫把上面两条口径钉死，并用独立算法反推期望值：
 *   · 期望 IDS 由 CAMEL 的键独立算出，不复用被测的 IDS
 *   · 期望共享路径集合由本文件自己遍历 js/ css/ src/ 算出，
 *     不复用 collectShared()（拿生成器验生成器，两边一起错照样绿）
 *   · 每个判据都配元断言测坏输入，防恒真 / 恒假
 *
 * 不 import 任何联网或 vite 依赖；联网核验由
 * scripts/verify-plugin-repos.mjs 承担（刻意不进 CI）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stripCommentsJs } from './test-scan-utils.mjs';
import { CAMEL } from './scripts/plugin-repo-map.mjs';
import { IDS, SHARED, sharedMirrorFiles, skeletonFiles } from './scripts/build-plugin-repos.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const R = (...p) => resolve(HERE, ...p);
const read = p => readFileSync(R(p), 'utf8');
const sha256 = b => createHash('sha256').update(b).digest('hex');
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  if (!ok) console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------- 独立期望值算法（不复用被测模块） ---------- */
function expectedRels() {
  const out = [];
  for (const base of ['js', 'css', 'src']) {
    const root = R(base);
    if (!existsSync(root)) continue;
    const walk = d => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'assets', '__pycache__'].includes(e.name)) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) out.push(relative(HERE, p).replace(/\\/g, '/'));
      }
    };
    walk(root);
  }
  return out.sort();
}

/* ---------- 可注入判据（元断言测的就是这些） ---------- */
const idsOk = (ids, camelKeys) => ids.length === 12
  && ids.length === camelKeys.length
  && eq(ids, [...camelKeys].sort());

const idsFromMap = src => src.includes('export const IDS = Object.keys(CAMEL).sort()')
  && !src.includes("readdirSync(path.join(ROOT, 'plugins'))");

const hasConflict = s => s.includes('<<<<<<< ') || s.includes('>>>>>>> ')
  || /\n=======\n/.test(s);

const usesSharedOnly = src => src.includes('sharedMirrorFiles')
  && !/\bskeletonFiles\s*\(/.test(src);

const isRetiredErr = msg => typeof msg === 'string' && /退场/.test(msg);

/* ---------- ① IDS 来源 ---------- */
const camelKeys = Object.keys(CAMEL);
t('①a IDS 恰为 12 且等于唯一映射表的键', idsOk(IDS, camelKeys),
  `IDS=${IDS.length} CAMEL=${camelKeys.length}`);
t('①b 元断言：IDS 为空数组会被判据抓到', !idsOk([], camelKeys));
t('①c 元断言：IDS 少一项会被判据抓到', !idsOk(IDS.slice(1), camelKeys));
t('①d 元断言：映射表加一项而 IDS 没跟上会红', !idsOk(IDS, [...camelKeys, 'ghost']));
t('①e 元断言：IDS 顺序错会被判据抓到', !idsOk([...IDS].reverse(), camelKeys));

/* ---------- ② 生成器源码锚点 ---------- */
const gen = stripCommentsJs(read('scripts/build-plugin-repos.mjs'));
t('②a IDS 定义来自 CAMEL、不再扫 plugins/ 目录', idsFromMap(gen));
t('②b 生成器导出 sharedMirrorFiles()', /export function sharedMirrorFiles\s*\(/.test(gen));
t('②c 生成器对缺席的插件源码 fail-closed', gen.includes('插件源码已退场'));
t('②d 元断言：旧扫目录写法会被判据拒绝', !idsFromMap(
  "export const IDS = fs.readdirSync(path.join(ROOT, 'plugins'))\n  .sort();"));
t('②e 元断言：空文本不会被当成合规', !idsFromMap(''));
t('②f 元断言：新定义与旧扫目录写法并存也不合规',
  !idsFromMap('export const IDS = Object.keys(CAMEL).sort()\n'
    + "const leftover = fs.readdirSync(path.join(ROOT, 'plugins'));"));

/* ---------- ③ 共享镜像集合与内容 ---------- */
const expRels = expectedRels();
const mirror = sharedMirrorFiles();
t('③a 共享镜像集合与独立算法逐项一致', eq(SHARED, expRels),
  `SHARED=${SHARED.length} 独立=${expRels.length}`);
t('③b 内容源条目数等于集合数', mirror.size === SHARED.length,
  `mirror=${mirror.size}`);
t('③c 内容源逐文件与磁盘字节一致',
  [...mirror].every(([rel, buf]) => sha256(buf) === sha256(readFileSync(R(rel)))));
t('③d 共享镜像非空（防空跑假绿）', SHARED.length > 0);
t('③e 元断言：集合被清空会红', !eq([], expRels));
t('③f 元断言：集合多一个幽灵路径会红', !eq([...SHARED, 'js/__ghost__.js'], expRels));

/* ---------- ④ 主仓共享文件不得带冲突标记 ---------- */
const conflicted = [...mirror]
  .filter(([, buf]) => hasConflict(buf.toString('utf8')))
  .map(([rel]) => rel);
t('④a 主仓共享镜像 0 个文件带合并冲突标记', conflicted.length === 0,
  conflicted.join(', '));
t('④b 元断言：注入冲突标记会被判据抓到',
  hasConflict('let a = 1;\n<<<<<<< 本地\nlet a = 2;\n=======\nlet a = 3;\n>>>>>>> 远端\n'));
t('④c 元断言：URL 里的双斜杠不被误判',
  !hasConflict('const url = "https://x.dev/a";\n'));
t('④d 元断言：空文本不被误判', !hasConflict(''));

/* ---------- ⑤ 刷新通道口径 ---------- */
const rf = stripCommentsJs(read('scripts/refresh-plugin-repos.mjs'));
t('⑤a 刷新用共享镜像、不再重建整仓骨架', usesSharedOnly(rf));
t('⑤b 刷新仍验私有仓', rf.includes('不是私有仓库，拒绝刷新'));
t('⑤c 刷新对共享路径缺失 fail-closed', rf.includes('共享镜像在远端缺失'));
t('⑤d 刷新检查插件入口存在', rf.includes('插件入口'));
t('⑤e 刷新复验核对 blob 总数不变', rf.includes('remote2.size !== remote.size'));
t('⑤f 刷新带 sha 乐观锁', /sha:\s*cur\.sha/.test(rf));
t('⑤g 刷新对空共享镜像直接拒', rf.includes('拒绝空跑假绿'));
t('⑤h 元断言：含 skeletonFiles 调用的旧版不合规',
  !usesSharedOnly('import { skeletonFiles } from "./x.mjs";\nconst files = skeletonFiles(id);'));
t('⑤i 元断言：空文本不合规', !usesSharedOnly(''));

/* ---------- ⑥ 核验探针口径 ---------- */
const vf = stripCommentsJs(read('scripts/verify-plugin-repos.mjs'));
t('⑥a 核验用共享镜像、不再重建整仓骨架', usesSharedOnly(vf));
t('⑥b 核验验插件入口存在', vf.includes('`plugins/${id}/index.html`'));
t('⑥c 核验验元数据齐全', vf.includes('META_FILES'));
t('⑥d 核验仍验 private 与 manifest.repo',
  vf.includes('不是私有仓库') && vf.includes('manifest.repo='));
t('⑥e 核验保留 --fix-state 的漂移前置', vf.includes('drift === 0'));
t('⑥f 元断言：不含 sharedMirrorFiles 的文本不合规', !usesSharedOnly('const x = 1;'));

/* ---------- ⑦ 骨架在退场态必须抛错 ---------- */
let thrown = null;
try { skeletonFiles(IDS[0]); } catch (e) { thrown = e; }
t('⑦a 源码退场时 skeletonFiles 明确抛错而非空跑', isRetiredErr(thrown && thrown.message),
  thrown ? thrown.message.slice(0, 90) : '未抛错');
t('⑦b 元断言：ENOENT 这类信息不会被当成合规', !isRetiredErr('ENOENT: no such file or directory'));
t('⑦c 元断言：无错误信息不会被当成合规', !isRetiredErr(null));

console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
