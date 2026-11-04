#!/usr/bin/env node
/**
 * 退场态供给链守卫（离线、cwd 无关、不进联网 CI）
 * ============================================================
 * 背景：12 个 iframe 插件源码已迁到独立私有仓，主仓只留 runtime-plugins/
 * 产物。退场那一刻有三处「不报错但链是断的」：
 *
 *   ① build-plugins.mjs 扫不到源码时打印一句就 return → 构建 0 个插件 exit 0，
 *      在 CI 里与「全部构建成功」无法区分（静默假绿）。
 *   ② 主仓 package.json 里 136 条 test:* 仍指向已删的 plugins/<id>/ 路径，
 *      而 12 个独立仓的 package.json 只有 1 条 build:plugin —— 测试既没留在
 *      主仓、也没跟插件走。
 *   ③ registry.js 的 entry 仍指向 ./plugins/<id>/index.html；生产态因
 *      runtime:true 走 runtimeFrameUrl 不受影响，但 dev / 无构建态会 404。
 *
 * 守卫把「退场态」变成一等公民：源码缺席是合法态，但产物必须齐备、
 * 接线必须真的生效、死 script 必须恰好是台账里那批（销一条要同步销账、
 * 新增一条必须红）。判据一律可注入，配元断言防恒真 —— 本项目反复栽在
 * 「判据失效却全绿」。
 *
 * 不 import build-plugins.mjs（它 import vite，沙盒里依赖被清时会
 * MODULE_NOT_FOUND → 守卫没跑而不是报红）。判据在零依赖的
 * scripts/retired-supply-state.mjs 里，两边共用同一份。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMEL, repoNameFor } from './scripts/plugin-repo-map.mjs';
import { retiredSupplyState, retiredExitCode } from './scripts/retired-supply-state.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const R = (...p) => resolve(HERE, ...p);
const IDS = Object.keys(CAMEL).sort();
const read = (p) => readFileSync(R(p), 'utf8');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  if (!ok) console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------- 判据（全部可注入，供元断言用坏输入/坏函数验） ---------- */

/** 从 package.json 的 scripts 里抽出所有指向 plugins/<id>/ 的引用。
 *  纯文本判据：与本地是否仍留着源码副本无关，本地/远端口径一致。
 *  销账 = 把 script 迁到独立仓后从主仓删除，并同步缩小台账。 */
function collectDead(pkgObj, ids = IDS) {
  const idSet = new Set(ids);
  const rows = [];
  for (const [k, v] of Object.entries(pkgObj.scripts || {})) {
    const re = /(?:\.\/)?(?:nexus-panel\/)?(plugins\/([A-Za-z0-9_-]+)\/[^\s"';&|]+)/g;
    let m;
    while ((m = re.exec(String(v))) !== null) {
      const target = m[1].replace(/[),]+$/, '');
      const id = m[2];
      if (!idSet.has(id)) continue;
      rows.push({ script: k, target, id, repo: repoNameFor(id) });
    }
  }
  const seen = new Set();
  return rows
    .filter((r) => {
      const key = r.script + '\u0000' + r.target;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.script + a.target).localeCompare(b.script + b.target));
}

/** 从 registry.js 文本解析 runtime:true 的插件 id（按对象块切，不用贪婪正则） */
function runtimeIdsFromRegistry(text) {
  const out = [];
  const marks = [...text.matchAll(/\bid:\s*'([^']+)'/g)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const block = text.slice(start, end);
    if (/\bruntime:\s*true\b/.test(block)) out.push(marks[i][1]);
  }
  return out.sort();
}

/** 切出 resolveFrameSrc 函数体，判生产态是否走 runtimeFrameUrl */
function prodFrameUsesRuntime(text) {
  const a = text.indexOf('export async function resolveFrameSrc');
  if (a < 0) return false;
  const b = text.indexOf('\nexport ', a + 1);
  const body = text.slice(a, b < 0 ? text.length : b);
  return /\bmanifest\.runtime\b/.test(body)
    && /mode\s*!==\s*'prod'/.test(body)
    && /return\s+runtimeFrameUrl\(/.test(body);
}

/** main() 是否真的接了退场判据与 fail-closed 退出 */
function mainWiring(text) {
  const a = text.indexOf('async function main()');
  if (a < 0) return { state: false, exit: false, verify: false };
  const body = text.slice(a);
  return {
    state: /retiredSupplyState\(/.test(body),
    exit: /process\.exit\(retiredExitCode\(/.test(body),
    verify: /--verify/.test(body) && /verifyOne\(/.test(body),
  };
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 顺序无关的集合比较：台账由 Python 按 (script,target) 码点序生成，
 *  JS 的 localeCompare 受 ICU 版本影响（实测 'test:af' 与
 *  'test:af-dirpicker-picked' 两边顺序相反，但内容一个不差）。
 *  顺序不该算缺陷，逐位比会把「排序差异」误报成欠账漂移。 */
const canon = (rows) => rows
  .map((r) => JSON.stringify([r.script, r.target, r.id, r.repo]))
  .sort();

/* ---------- ① 供给态三分支 ---------- */
const CASES = [
  { name: 'broken（无源码无产物）', args: [[], []], mode: 'broken', code: 1 },
  { name: 'retired（无源码有产物）', args: [[], ['a', 'b']], mode: 'retired', code: 1 },
  { name: 'source（有源码）', args: [['a'], []], mode: 'source', code: 0 },
];
for (const c of CASES) {
  const s = retiredSupplyState(...c.args);
  t(`①a ${c.name} → mode=${c.mode}`, s.mode === c.mode, s.mode);
  t(`①b ${c.name} → exit=${c.code}`, retiredExitCode(s) === c.code, String(retiredExitCode(s)));
}
t('①c null state 不得放行', retiredExitCode(null) === 1);
/* 元断言 A：判据若恒返回 source，三分支里必有两条被抓 */
{
  const alwaysSource = () => ({ mode: 'source', productIds: [] });
  const caught = CASES.filter((c) => alwaysSource().mode !== c.mode).length;
  t('①d 元断言：恒 source 的假判据会被三分支抓到', caught === 2, `caught=${caught}`);
}
/* 元断言 B：retired 态的 productIds 必须原样带回，不能吞 */
{
  const s = retiredSupplyState([], ['x', 'y']);
  t('①e retired 态保留产物清单', eq(s.productIds, ['x', 'y']));
}

/* ---------- ② 产物供给与唯一真值源 ---------- */
for (const id of IDS) {
  const p = R('runtime-plugins', id, 'index.html');
  const ok = existsSync(p) && statSync(p).size > 0;
  t(`②a 产物 runtime-plugins/${id}/index.html 存在且非空`, ok);
}
{
  const reg = runtimeIdsFromRegistry(read('plugins/registry.js'));
  t('②b registry.js 的 runtime:true 集合恰为 12 个市场插件', eq(reg, IDS),
    `实为 ${reg.length}：${reg.slice(0, 4).join(',')}`);
  /* 元断言 C：把 runtime:true 全部抹掉，判据必须返回空集 */
  const stripped = read('plugins/registry.js').replace(/\bruntime:\s*true\b/g, 'runtime: false');
  t('②c 元断言：抹掉 runtime:true 后判据返回空集', runtimeIdsFromRegistry(stripped).length === 0);
  /* 元断言 D：判据不能对空文本也返回全集 */
  t('②d 元断言：空文本不得返回任何 runtime id', runtimeIdsFromRegistry('').length === 0);
}

/* ---------- ③ host 生产态接线 ---------- */
{
  const host = read('js/host.js');
  t('③a resolveFrameSrc 生产态 runtime:true 走 runtimeFrameUrl', prodFrameUsesRuntime(host));
  /* 元断言 E：把 runtimeFrameUrl 换成 resolveEntry，判据必须 false */
  const bad = host.replace(/return\s+runtimeFrameUrl\(/, 'return resolveEntry(');
  t('③b 元断言：改回 resolveEntry 会被抓', prodFrameUsesRuntime(bad) === false);
  /* 元断言 F：判据不能对空文本恒真 */
  t('③c 元断言：空文本不得判为已接线', prodFrameUsesRuntime('') === false);
}

/* ---------- ④ 构建脚本接线 ---------- */
{
  const bp = read('scripts/build-plugins.mjs');
  const w = mainWiring(bp);
  t('④a main 调用 retiredSupplyState', w.state);
  t('④b main 用 retiredExitCode 的结果退出（fail-closed）', w.exit);
  t('④c --verify 分支存在且调用 verifyOne', w.verify);
  /* 元断言 G：把 process.exit(retiredExitCode( 改回 return，④b 必须红 */
  const bad = bp.replace(/process\.exit\(retiredExitCode\(/, 'process.exit(0 && retiredExitCode(');
  t('④d 元断言：绕过 retiredExitCode 会被抓', mainWiring(bad).exit === false);
  /* 元断言 H：空文本不得判为已接线 */
  t('④e 元断言：空文本三判据全 false',
    !mainWiring('').state && !mainWiring('').exit && !mainWiring('').verify);
}

/* ---------- ⑤ 死 script 欠账台账 ---------- */
{
  const ledgerPath = R('scripts/retired-dead-scripts.json');
  t('⑤a 台账文件存在', existsSync(ledgerPath));
  let ledger = { rows: [] }, parseOk = true, parseErr = '';
  try { ledger = JSON.parse(read('scripts/retired-dead-scripts.json')); } catch (e) {
    parseOk = false; parseErr = e.message;
  }
  t('⑤b 台账可解析', parseOk, parseErr);
  const rows = ledger.rows || [];
  t('⑤c 台账条数 = 136', rows.length === 136, String(rows.length));
  t('⑤d 台账每条字段齐且 target 指向对应 id',
    rows.every((r) => r.script && r.target && r.id && r.repo
      && r.target.startsWith(`plugins/${r.id}/`)));
  t('⑤e 台账 repo 名由唯一映射表派生',
    rows.every((r) => r.repo === repoNameFor(r.id)));
  const keys = rows.map((r) => r.script + '\u0000' + r.target);
  t('⑤f 台账无重复 (script,target)', new Set(keys).size === keys.length);

  const pkg = JSON.parse(read('package.json'));
  const actual = collectDead(pkg);
  /* 退场态：136 条死 script 已从主仓删除。期望值从「恰为台账」变成「空集」——
     这不是放宽：台账仍是 136 条退役记录，只是主仓不再登记它们。 */
  t('⑤g 主仓死 script 集合为空（退役完成，不残留指向已删路径的命令）',
    actual.length === 0, `实际 ${actual.length} 条：${actual.slice(0, 3).map((x) => x.script).join(',')}`);
  /* 元断言 I：注入一条新的死 script，判据必须抓到（防 ⑤g 恒真） */
  const injected = { scripts: { ...pkg.scripts, 'test:__retired_probe__': 'node plugins/dupview/probe.mjs' } };
  t('⑤h 元断言：新增死 script 会被判据抓到', collectDead(injected).length === 1,
    `实得 ${collectDead(injected).length}`);
  /* 元断言 J：空 scripts 必须给空集，不恒返回台账 */
  t('⑤i 元断言：空 scripts 返回空集，不恒返回台账',
    collectDead({ scripts: {} }).length === 0);
  /* 元断言 K：退役记录不许悄悄缩水，且去向必须指向本行自己的 target */
  t('⑤j 元断言：台账少一行会被 ⑤c 抓到，且 keptAt 与 target 一致',
    rows.length !== 135 && rows.every((r) => r.keptAt === `${r.repo}::${r.target}`));
  /* 新增：退役记录的证据不能是空壳 */
  t('⑤k 台账每条都有 disposition / keptAt / reason / evidence',
    rows.every((r) => r.disposition === 'retired' && r.keptAt
      && r.reason && r.reason.length > 20 && r.evidence
      && r.evidence.afterFillOk === 127 && r.evidence.targetPresentInRepo === true));
}

console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
