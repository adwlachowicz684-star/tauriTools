#!/usr/bin/env node
/**
 * 查更新：取到 release 但没比出结论，不许报「均为最新」
 * ------------------------------------------------------------
 * 第 211 轮。编排层 resolveUpdateFor 有三种结论是「根本没比成」：
 *   · 没有 release 信息
 *   · release 里没有本插件的规范命名产物
 *   · 版本号无法比较（reason 明写「不宣称有更新」）
 * 而市场层 checkUpdates 只按 checked（是否取到 release）分流，界面
 * formatCheckUpdates 只数 errors / checked:false / fingerprintChanged /
 * hasUpdate —— 这三类条目四项全不沾，于是报「所有已检查插件均为最新」
 * 且带成功色。远端 v1.0.1、本地 v1.0.0，只因产物名不合规就永远报最新。
 *
 * 守卫分两层：
 *   行为层真跑 resolveUpdateFor + formatCheckUpdates（不靠源码里有没有
 *   那个词）；接线层剥注释扫两个生产文件，并配「注释喂饱反例」「防改恒假」
 *   「空文本不恒真」三条元断言 —— 本项目第 187 轮起反复栽的形状。
 * 剥注释走共用 test-scan-utils.mjs，不新增内联副本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsJs } from './test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const LEDGER = 'js/plugin-ledger.js';
const BINDING = 'js/market-binding.js';

let pass = 0;
const fails = [];
function t(name, cond, evidence = '') {
  if (cond === true) { pass++; return; }
  fails.push(`${name}${evidence ? ' —— ' + String(evidence).slice(0, 160) : ''}`);
}

/* 动态 import + 显式闸门：导出被删时脚本不崩在 ESM 实例化阶段，
   仍能打印汇总行和逐条红（第 209 轮踩过的崩塌通道）。 */
let ledgerMod = null, bindingMod = null, importErr = '';
try {
  ledgerMod = await import('./' + LEDGER);
  bindingMod = await import('./' + BINDING);
} catch (e) {
  importErr = String((e && e.message) || e);
}
t('前置：两个生产模块都能加载', !!ledgerMod && !!bindingMod && !importErr, importErr);
const resolve = ledgerMod && ledgerMod.resolveUpdateFor;
const format = bindingMod && bindingMod.formatCheckUpdates;
t('前置：resolveUpdateFor / formatCheckUpdates 都导出', typeof resolve === 'function' && typeof format === 'function');
const R = typeof resolve === 'function' ? resolve : () => ({});
const F = typeof format === 'function' ? format : () => ({ tone: 'ok', text: '占位' });

/* ---------------- ① 行为层：真跑编排层结论 ---------------- */
const entry = { version: '1.0.0', fingerprint: null };
const relNoAsset = { tag_name: 'v1.0.1', assets: [{ name: 'random.zip', state: 'uploaded' }] };
const relBadVer = { tag_name: 'v2.0', assets: [{ name: 'nexus-plugin-demoLight-2.0.tar.gz', state: 'uploaded' }] };
const relOk = { tag_name: 'v1.0.0', assets: [{ name: 'nexus-plugin-demoIframe-1.0.0.tar.gz', state: 'uploaded' }] };

const cNoRelease = R(entry, null, 'demoIframe');
const cNoAsset = R(entry, relNoAsset, 'demoIframe');
const cBadVer = R({ version: 'nightly' }, relBadVer, 'demoLight');
const cFresh = R(entry, relOk, 'demoIframe');

t('①a 没有 release → indeterminate', cNoRelease.indeterminate === true, JSON.stringify(cNoRelease));
t('①b 无规范产物 → indeterminate（且远端版本确实比本地新）',
  cNoAsset.indeterminate === true && cNoAsset.to === '1.0.1' && cNoAsset.from === '1.0.0',
  JSON.stringify(cNoAsset));
t('①c 版本号无法比较 → indeterminate 且 reason 明说「不宣称有更新」',
  cBadVer.indeterminate === true && /不宣称有更新/.test(cBadVer.reason || ''),
  JSON.stringify(cBadVer));
t('①d 正常已是最新 → indeterminate=false（防改恒真）',
  cFresh.indeterminate === false && cFresh.hasUpdate === false, JSON.stringify(cFresh));

/* ---------------- ② 行为层：界面不许报绿 ---------------- */
const wrap = (u, id) => Object.assign({ id, checked: true }, u);
const three = [wrap(cNoRelease, 'a'), wrap(cNoAsset, 'b'), wrap(cBadVer, 'c')];
const out3 = F({ results: three, errors: [] });
t('②a 三条不可判定 → tone=err', out3.tone === 'err', JSON.stringify(out3));
t('②b 文案说清「没法判定」', /没法判定/.test(out3.text || ''), out3.text);
t('②c 不许再出现「均为最新」', !/均为最新/.test(out3.text || ''), out3.text);

const outMixed = F({
  results: [wrap(cNoAsset, 'b'), wrap(R({ version: '0.9.0' }, relNoAsset, 'd'), 'd')],
  errors: [],
});
t('②d 单条不可判定也不许被数量淹没', outMixed.tone === 'err' && /没法判定/.test(outMixed.text || ''), JSON.stringify(outMixed));

const outHit = F({
  results: [wrap(cNoAsset, 'b'), { id: 'e', checked: true, hasUpdate: true, indeterminate: false }],
  errors: [],
});
t('②e 有真更新 + 有不可判定 → 两句都在且 err',
  outHit.tone === 'err' && /没法判定/.test(outHit.text || '') && /有更新/.test(outHit.text || ''),
  JSON.stringify(outHit));

const outClean = F({ results: [wrap(cFresh, 'a')], errors: [] });
t('②f 全正常且无更新 → 仍是「均为最新」ok（防改恒假）',
  outClean.tone === 'ok' && /均为最新/.test(outClean.text || ''), JSON.stringify(outClean));

/* ②g 钉住缺陷本身：把结构化标记拿掉，旧界面确实会报绿。
   钉的是「为什么需要这个字段」，以后换任何正确实现都不用改断言。 */
const oldShape = three.map(({ indeterminate, ...rest }) => rest);
const outOld = F({ results: oldShape, errors: [] });
t('②g 去掉 indeterminate 后旧形状确实报「均为最新」（缺陷实证）',
  outOld.tone === 'ok' && /均为最新/.test(outOld.text || ''), JSON.stringify(outOld));

/* ---------------- ③ 接线层：剥注释扫实现 ---------------- */
const ledgerCode = stripCommentsJs(read(LEDGER));
const bindingCode = stripCommentsJs(read(BINDING));

/* 判据抽成纯函数，便于元断言反例验证；只看剥注释后的实现文本。 */
const hasIndeterminateFlag = (code) => /indeterminate\s*:\s*true/.test(code);
const consumesIndeterminate = (code) =>
  /indeterminate\s*=\s*results\.filter/.test(code) &&
  /indeterminate\.length\s*>\s*0/.test(code);

t('③a ledger 实现里至少三处 indeterminate: true',
  (ledgerCode.match(/indeterminate\s*:\s*true/g) || []).length >= 3,
  '命中 ' + (ledgerCode.match(/indeterminate\s*:\s*true/g) || []).length);
t('③b market-binding 实现里真的消费 indeterminate（filter + broken）',
  consumesIndeterminate(bindingCode));
t('③c ledger 里 resolveUpdateFor 的不可判定分支不是只写在注释里',
  hasIndeterminateFlag(ledgerCode));

/* ---------------- ④ 元断言：防注释喂饱 / 防恒真 / 防恒假 ---------------- */
const commentOnly = `/* indeterminate: true  indeterminate = results.filter  indeterminate.length > 0 */\nfunction f() { return 1; }`;
t('④a 只有注释含这些词 → 判据必须判 false（注释喂饱反例）',
  !hasIndeterminateFlag(stripCommentsJs(commentOnly)) &&
  !consumesIndeterminate(stripCommentsJs(commentOnly)));
const realImpl = `function f(){ const indeterminate = results.filter(x => x.indeterminate === true); if (indeterminate.length > 0) return 1; }`;
t('④b 真实实现文本 → 判据必须判 true（防改恒假）',
  consumesIndeterminate(stripCommentsJs(realImpl)));
t('④c 空文本 → 判据不恒真',
  !hasIndeterminateFlag('') && !consumesIndeterminate(''));
t('④d 剥注释模块确实剥得掉行注释（公共设施没坏）',
  stripCommentsJs('a // indeterminate: true') !== 'a // indeterminate: true');

/* ---------------- 汇总 ---------------- */
for (const f of fails) console.log('❌ ' + f);
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
process.exit(fails.length ? 1 : 0);
