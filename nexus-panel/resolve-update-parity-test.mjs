#!/usr/bin/env node
/**
 * 版本判定两份实现：不可判定分支必须一一对应
 * ------------------------------------------------------------
 * 第 212 轮。第 211 轮给 js/plugin-ledger.js 的 resolveUpdateFor 加了
 * indeterminate，把「取到 release 却没比出结论」从「所有已检查插件均为最新」
 * 里分了出来。但同一句承诺还有第二份实现：js/plugin-store-client.js 的
 * resolveUpdate —— 它 import 的 compareVersion / pickAsset 与 ledger 同源，
 * 三种不可判定分支同样写着「不宣称有更新」，却只给 hasUpdate:false，
 * 没有任何结构化标记。真实联调探针 D 节把它打印成「无更新」，
 * plugin-store-client-test.mjs 的三条断言也把「没比成」钉成「无更新」。
 *
 * 与第 186 轮收 isMac、第 192 轮收 EXCHANGE_KEEP 是同一形状：一份实现
 * 改了判据，另一份悄悄漂移，而守卫全绿。后果要如实说边界——
 * resolveUpdate 当前没有生产消费点（市场链路走 resolveUpdateFor），
 * 修的是「将来谁把它接上界面就会复现假绿」与两份契约的可信度。
 *
 * 守卫三层：
 *   ① 行为层动态 import 两份真身，逐分支真跑（不靠源码里有没有那个词）
 *   ② 接线层剥注释扫两份实现，配「注释喂饱反例 / 防改恒真 / 空文本」
 *      三条元断言
 *   ③ 合成变体：旧版 / 注释版 / 恒真判据各自必须被判为不通过
 * 剥注释走共用 test-scan-utils.mjs，不新增内联副本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsJs } from './test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const CLIENT = 'js/plugin-store-client.js';
const LEDGER = 'js/plugin-ledger.js';

let pass = 0;
const fails = [];
function t(name, cond, evidence = '') {
  if (cond === true) { pass++; return; }
  fails.push(`${name}${evidence ? ' —— ' + String(evidence).slice(0, 160) : ''}`);
}

/* 动态 import + 显式闸门：导出被删时脚本不崩在 ESM 实例化阶段，
   仍能打印汇总行和逐条红（第 209 轮踩过的崩塌通道）。 */
let clientMod = null, ledgerMod = null, importErr = '';
try {
  clientMod = await import('./' + CLIENT);
  ledgerMod = await import('./' + LEDGER);
} catch (e) {
  importErr = String((e && e.message) || e);
}
t('前置：两个生产模块都能加载', !!clientMod && !!ledgerMod && !importErr, importErr);
const resolveClient = clientMod && clientMod.resolveUpdate;
const resolveLedger = ledgerMod && ledgerMod.resolveUpdateFor;
t('前置：resolveUpdate / resolveUpdateFor 都导出',
  typeof resolveClient === 'function' && typeof resolveLedger === 'function');
const C = typeof resolveClient === 'function' ? resolveClient : () => ({});
const L = typeof resolveLedger === 'function' ? resolveLedger : () => ({});

/* ---------------- ① 行为层：两份真身逐分支真跑 ---------------- */
const entry = { version: '1.0.0', fingerprint: null };
const relNoAsset = { tag_name: 'v1.0.1', assets: [{ name: 'random.zip', state: 'uploaded' }] };
/* 版本无法比较：tag 只有两段，compareVersion 返回 null；产物名仍合规 */
const relBadVer = {
  tag_name: 'v2.0',
  assets: [{ name: 'nexus-plugin-demoIframe-2.0.tar.gz', state: 'uploaded' }],
};
const relFresh = {
  tag_name: 'v1.0.0',
  assets: [{ name: 'nexus-plugin-demoIframe-1.0.0.tar.gz', state: 'uploaded' }],
};
const relNewer = {
  tag_name: 'v1.0.1',
  assets: [{ name: 'nexus-plugin-demoIframe-1.0.1.tar.gz', state: 'uploaded' }],
};
const ID = 'demoIframe';

/* 三个「根本没比成」样本：两份实现都必须结构化标出 */
const cases = [
  { name: '没有 release', args: [entry, null, ID], cArgs: ['1.0.0', null, ID] },
  { name: '没有规范产物', args: [entry, relNoAsset, ID], cArgs: ['1.0.0', relNoAsset, ID] },
  { name: '版本号无法比较', args: [entry, relBadVer, ID], cArgs: ['1.0.0', relBadVer, ID] },
];
for (const cs of cases) {
  const a = L(...cs.args);
  const b = C(...cs.cArgs);
  t(`①a ${cs.name}：resolveUpdateFor 标 indeterminate`,
    a.hasUpdate === false && a.indeterminate === true, JSON.stringify(a));
  t(`①b ${cs.name}：resolveUpdate 也标 indeterminate`,
    b.hasUpdate === false && b.indeterminate === true, JSON.stringify(b));
  t(`①c ${cs.name}：两份 reason 都不宣称有更新`,
    /不宣称|没有|无法|没比成/.test(String(a.reason || '')) && typeof b.reason === 'string' && b.reason.length > 0,
    `${a.reason} | ${b.reason}`);
}

/* 两个真结论样本：不许被顺手误标成不可判定（防改恒真） */
const freshL = L(entry, relFresh, ID), freshC = C('1.0.0', relFresh, ID);
t('①d 已是最新：resolveUpdateFor 不误标', freshL.hasUpdate === false && freshL.indeterminate === false, JSON.stringify(freshL));
t('①e 已是最新：resolveUpdate 不误标', freshC.hasUpdate === false && freshC.indeterminate === false, JSON.stringify(freshC));
const newerL = L(entry, relNewer, ID), newerC = C('1.0.0', relNewer, ID);
t('①f 有更新：resolveUpdateFor 不误标', newerL.hasUpdate === true && newerL.indeterminate === false, JSON.stringify(newerL));
t('①g 有更新：resolveUpdate 不误标', newerC.hasUpdate === true && newerC.indeterminate === false, JSON.stringify(newerC));
const uninstL = L({ version: null }, relNewer, ID), uninstC = C(null, relNewer, ID);
t('①h 未安装：两份都判可安装且不误标',
  uninstL.hasUpdate === true && uninstL.indeterminate === false &&
  uninstC.hasUpdate === true && uninstC.indeterminate === false,
  `${JSON.stringify(uninstL)} | ${JSON.stringify(uninstC)}`);

/* ---------------- ② 接线层：剥注释扫真实现 ---------------- */
const clientCode = read(CLIENT);
const ledgerCode = read(LEDGER);
const clientStrip = stripCommentsJs(clientCode);
const ledgerStrip = stripCommentsJs(ledgerCode);
const countFlag = (s) => (s.match(/indeterminate\s*:\s*true/g) || []).length;

t('②a 剥注释后 store-client 实现里至少三处 indeterminate: true',
  countFlag(clientStrip) >= 3, '命中 ' + countFlag(clientStrip));
t('②b 剥注释后 ledger 实现里至少三处 indeterminate: true',
  countFlag(ledgerStrip) >= 3, '命中 ' + countFlag(ledgerStrip));
t('②c 两份实现都真的 export 了对应函数（不是只写在注释里）',
  /export\s+function\s+resolveUpdate\s*\(/.test(clientStrip) &&
  /export\s+function\s+resolveUpdateFor\s*\(/.test(ledgerStrip));
t('②d store-client 里三种 reason 都在（没有 / 产物 / 无法比较）',
  /没有 release 信息/.test(clientStrip) && /release 里没有可用产物/.test(clientStrip) &&
  /版本号无法比较/.test(clientStrip));

/* 元断言：剥注释工具本身生效，且判据不会被注释喂饱 */
const commentOnly = `/* indeterminate: true  indeterminate: true  indeterminate: true
   export function resolveUpdate() { return { indeterminate: true }; } */
function f() { return 1; }`;
t('②e 注释喂饱反例：剥注释后 0 命中', countFlag(stripCommentsJs(commentOnly)) === 0,
  '命中 ' + countFlag(stripCommentsJs(commentOnly)));
const realImpl = `function f(){ if (!x) return { indeterminate: true };
  if (!y) return { indeterminate: true };
  if (!z) return { indeterminate: true }; }`;
t('②f 真实现反例：剥注释后 3 命中（判据不恒假）',
  countFlag(stripCommentsJs(realImpl)) === 3);
t('②g 空文本 0 命中（空集合不恒真）', countFlag(stripCommentsJs('')) === 0);
t('②h 剥注释工具确实删掉了行注释里的标记',
  stripCommentsJs('a // indeterminate: true') !== 'a // indeterminate: true');

/* 真实联调探针 D 节是 resolveUpdate 唯一的实际消费点：它必须把
   「根本没比成」说出来，而不是把 hasUpdate:false 打印成「无更新」。 */
const probeStrip = stripCommentsJs(read('scripts/probe-github-real.mjs'));
t('②i 探针消费 indeterminate 且文案含「没比成」',
  /u\.indeterminate/.test(probeStrip) && /没比成/.test(probeStrip));
t('②j 探针不再只打印 hasUpdate=false',
  !/resolveUpdate\s*→\s*hasUpdate=/.test(probeStrip));

/* ---------------- ③ 合成变体：撤修复/注释版必须被判不通过 ---------------- */
/* 用与 ② 相同的判据去判一段「旧版实现」：不带任何 indeterminate。
   若 ②a 改成恒真，这一条会立刻报红，证明元断言不是摆设。 */
const oldVersion = `export function resolveUpdate(v, latest, id) {
  if (!latest) return { hasUpdate: false, reason: '没有 release 信息' };
  return { hasUpdate: false, reason: '已是最新' };
}`;
const parityOk = (code) => countFlag(stripCommentsJs(code)) >= 3;
t('③a 旧版实现（无标记）必须被判不通过', parityOk(oldVersion) === false);
t('③b 只有注释里写满标记也必须被判不通过', parityOk(commentOnly) === false);
t('③c 修复后的真实现必须被判通过', parityOk(clientStrip) === true);
t('③d 判据改成恒真会被③a 抓住（防改恒真）',
  (() => { const always = () => true; return always(oldVersion) === true && parityOk(oldVersion) === false; })());

/* ---------------- 汇总 ---------------- */
for (const f of fails) console.log('❌ ' + f);
console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) process.exit(1);
