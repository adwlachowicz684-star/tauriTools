/**
 * 内联剥注释实现欠账守卫（P0-3）
 * ============================================================
 * 要防的形状：**「把 16 份内联实现合并成一份」看起来是纯整理，其实会改判据**。
 *
 * 全仓实测至少 5 种语义不同的形态：
 *   · 块注释压成 ''（stripCommentsFlat）与留 ' '（stripComments）——
 *     后者不会把相邻 token 粘成一个不存在的记号，扫 CSS/类名必须用留空格版
 *   · 行注释 `(^|\s)`（安全）/ `(^|[^:])`（分歧）/ 裸 `\/\/`（吞 https://）
 * 机械统一后，判据变松 → 假绿，变紧 → 误报，两者都未必表现为「红几条」。
 *
 * 所以这里不合并，只做三件事：
 *   ① 台账 = 欠账清单，实际集合必须**恰为**台账：修好一条 → 红（逼销账），
 *      新写一份 → 红。每条带 kinds / why / unblock。
 *   ② DONE 里的文件必须真的 import 公共设施 —— 防「把 strip 删掉改成恒等」
 *      这种假销账：内联实现消失了，判据也没了，① 反而会绿。
 *   ③ 分类函数的元断言：判据恒真 / 恒假 / 分错形态都要喊得出声。
 *
 * ⚠ 固有边界（与 orphan-modules-guard 同形）：纯静态守卫挡不住「把断言删掉」，
 *   这层靠每次改动的破坏验证兜，不靠守卫自己。
 *
 * 用法：node inline-strip-audit-test.mjs（cwd 无关）
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanInlineStrip, classifyInlineStrip } from './scripts/scan-inline-strip.mjs';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';
import { isRetired, sourceResidue } from './scripts/retired-guard-baseline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const read = (p) => readFileSync(resolve(HERE, p), 'utf8');

let pass = 0;
const fails = [];
const t = (name, ok, extra = '') => {
  if (ok) pass++;
  else fails.push(`${name}${extra ? ` —— ${extra}` : ''}`);
};

/* ------------------------------------------------------------------ *
 * 欠账台账：每条都要能回答「为什么还不能换成公共设施」「怎么才能换」
 * kinds 与实际扫描结果必须逐项一致，否则说明形态变了、结论要重下。
 * ------------------------------------------------------------------ */
/**
 * 退场态口径：12 个 iframe 插件连同它们的测试一起迁到 12 个独立仓，
 * 主仓 `plugins/<id>/` 下不再有文件。原台账 10 条里 8 条、DONE 7 条里
 * 6 条随之消失 —— 留着只会永久报红。它们不是「修好了」，是**换了宿主**，
 * 由各仓自己的 CI 继续盯；主仓只钉仍在本地的 2 条。
 */
const LEDGER = {
  'scripts/scan-commands.mjs': {
    kinds: ['flat', 'line-bare', 'space'],
    why: '同一份文件里同时用了空串版与留空格版两种块注释剥离，需分别确认适用场景',
    unblock: '按 CSS / JS 分别选 stripComments 与 stripCommentsFlat',
  },
  'scripts/scan-coupling.mjs': {
    kinds: ['block-other', 'line-safe'],
    why: '块注释正则不是标准 [\\s\\S]*? 形态，需先确认是否保偏移',
    unblock: '对照 stripCommentsKeep 的语义确认后替换',
  },
  /* 第 49/50 轮上游新增的守卫与扫描脚本，各自带了一份内联实现。
     这是登记欠账，不是收口：line-colon / line-safe / block-other 三种
     行注释判据语义不同（本项目第 187 轮已栽过「机械替换改坏断言」），
     先如实记着，逐文件确认后再换公共设施。 */
  'market-binding-guard-test.mjs': {
    kinds: ['flat', 'line-colon'],
    why: '第 50 轮接线守卫自带剥注释实现，判据是 (^|[^:])//，与公共设施 (^|\\s)// 不同；需确认 URL 形态与注释内实例化样本不会被误判',
    unblock: '用两套样本比对两种判据的结论后，改为 import ./test-scan-utils.mjs 的 stripCommentsFlatJs 并从台账销账',
  },
  'plugin-repo-state-test.mjs': {
    kinds: ['flat', 'line-safe'],
    why: '第 49 轮状态守卫自带剥注释实现，用于扫三个脚本的接线；未确认与公共设施语义完全等价',
    unblock: '对照 stripCommentsFlatJs 逐项比对后替换并销账',
  },
  'retired-source-guard-test.mjs': {
    kinds: ['flat', 'line-safe'],
    why: '退场源码守卫自带剥注释实现，替换前需逐项确认是否与公共设施语义等价',
    unblock: '对照 stripCommentsFlatJs / stripCommentsKeep 逐项比对后替换并销账',
  },
  'scan-admit-selfcheck-test.mjs': {
    kinds: ['flat', 'line-safe'],
    why: '上游新增的自检守卫自带剥注释实现，形态与公共设施未逐项比对',
    unblock: '比对后改为公共设施并销账',
  },
  'scripts/scan-market-runtime.mjs': {
    kinds: ['block-other', 'line-safe'],
    why: '上游新增的市场运行时扫描器自带块注释剥离，形态不是标准 [\\s\\S]*?，需先确认是否保偏移',
    unblock: '对照 stripCommentsKeep 确认后替换并销账',
  },
  /* 第 53 / 54 轮新增的两个守卫：远端 main 上 market-result-format 一直未登记
     （基线 27/2 红）；installed-registry 是第 54 轮落地时新增的第 3 条红。
     两者都是**登记欠账，不是销账** —— 行注释判据带 [^:] 左边界，与公共设施
     (^|\s)// 不同，机械替换会让「注释里的历史说明」被算成真调用或把 a//b 吞掉，
     症状是守卫假绿而不是报红。逐文件比对样本前保持现形态。 */
  'market-result-format-test.mjs': {
    kinds: ['block-other', 'line-colon'],
    why: '第 206/53 轮面板结果守卫自带剥注释实现，块注释形态不是标准 [\\s\\S]*?、行注释用 (^|[^:])//；两项与公共设施语义均未逐项比对',
    unblock: '用含 URL / 行内 // / 注释内正则的三套样本比对两种判据结论后，改为 import ./test-scan-utils.mjs 并从台账销账',
  },
  'installed-registry-guard-test.mjs': {
    kinds: ['flat', 'line-colon'],
    why: '第 54 轮已安装注册表守卫自带剥注释实现；它必须剥掉文件头「mergeInstalled 早就写好」这句历史说明，否则 ④e 会把注释算成真调用，行注释判据与公共设施不同',
    unblock: '比对 (^|[^:])// 与 (^|\\s)// 在 http:// 与 a//b 两类样本上的结论后，改为公共设施并销账',
  },
};

/* 已销账：换成公共设施、且仍在主仓的文件。必须真的 import，且不再有内联实现。 */
const DONE = {
  'native-assets-test.mjs': './test-scan-utils.mjs',
};

/* 随插件源码迁出的 14 份文件。用途不是"记个名字"，是防止有人靠
   **直接删文件**把 ①a 销账：销账必须伴随「整个插件目录确实迁出」，
   而不是把守卫看不顺眼的文件抹掉。 */
const MOVED = [
  'plugins/mindmap/mm-export-name-test.mjs',
  'plugins/mindmap/mm-shrink-name-test.mjs',
  'plugins/task-board/task-board-test.mjs',
  'plugins/project-group/saveguard-test.mjs',
  'plugins/project-group/config-corrupt-notice-test.mjs',
  'plugins/project-group/mcp-addcard-guard-test.mjs',
  'plugins/project-group/mcp-string-args-test.mjs',
  'plugins/project-group/mcp-typed-args-test.mjs',
  'plugins/project-group/backup-interval-test.mjs',
  'plugins/project-group/mcp-enum-args-test.mjs',
  'plugins/project-group/shell-icon-notify-test.mjs',
  'plugins/project-group/stack-reveal-once-test.mjs',
  'plugins/project-group/watch-scope-test.mjs',
  'plugins/project-group/watch-toggle-test.mjs',
];

/* ------------------------------------------------------------------ */
console.log('\n=== 1. 实际内联集合恰为台账 ===');
const actual = scanInlineStrip(ROOT);
const actualMap = new Map(actual.map((h) => [h.file, h.kinds.join(',')]));
const wantSet = new Set(Object.keys(LEDGER));
const gotSet = new Set(actualMap.keys());

for (const f of [...gotSet].sort()) {
  if (!wantSet.has(f)) t(`①a 多出未登记的内联实现：${f}`, false, actualMap.get(f));
}
for (const f of [...wantSet].sort()) {
  if (!gotSet.has(f)) t(`①a 台账项已销账但没从台账移除：${f}`, false);
}
t('①b 实际内联集合与台账完全一致', gotSet.size === wantSet.size && [...gotSet].every((f) => wantSet.has(f)),
  `实际 ${gotSet.size} / 台账 ${wantSet.size}`);
for (const [f, e] of Object.entries(LEDGER)) {
  if (!gotSet.has(f)) continue;
  t(`①c ${f} 形态未漂移`, actualMap.get(f) === e.kinds.join(','),
    `实际=${actualMap.get(f)} 台账=${e.kinds.join(',')}`);
  t(`①d ${f} 有 why 与 unblock`, !!e.why && !!e.unblock);
}

/* ①e / ①f：销账只能靠「整个插件源码迁出」，不能靠删文件。
   空台账上的 every 恒真，所以另要一条「集合规模正常」把判据钉住。 */
t('①e 迁出台账恰为 14 条（少一条 = 有人顺手删了断言对象）',
  MOVED.length === 14, `实为 ${MOVED.length}`);
t('①f 14 份文件确实不在主仓（是迁出，不是被删后蒙混过关）',
  MOVED.every((f) => !existsSync(resolve(ROOT, f))),
  MOVED.filter((f) => existsSync(resolve(ROOT, f))).join(', '));
t('①g 主仓 12 个插件源码目录均已迁出（防双份权威）',
  isRetired(ROOT), sourceResidue(ROOT).join(', '));

console.log('\n=== 2. 已销账文件确实接上了公共设施（防假销账）===');
for (const [f, util] of Object.entries(DONE)) {
  let src = '';
  try { src = read(f); } catch { /* 缺失由下面统一报 */ }
  t(`②a ${f} 存在且 import 了 ${util}`, src.includes(`from '${util}'`) || src.includes(`from "${util}"`));
  t(`②b ${f} 不再出现在内联集合里`, !gotSet.has(f));
  t(`②c ${f} 里仍保留剥注释调用`, /stripCommentsFlat(?:Js)?\b/.test(src));
}

console.log('\n=== 3. 分类判据元断言（防恒真 / 恒假 / 分错形态）===');
const S = String.raw;
const samples = [
  { name: '③a 空串块注释 → flat', code: S`const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');`, want: 'flat' },
  { name: '③b 空串块注释 + 安全行注释 → flat,line-safe',
    code: S`const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');`,
    want: 'flat,line-safe' },
  { name: '③c 空串块注释 + 冒号排除行注释 → flat,line-colon',
    code: S`const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');`,
    want: 'flat,line-colon' },
  { name: '③d 空串块注释 + 裸行注释 → flat,line-bare',
    code: S`const CODE = MCP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');`,
    want: 'flat,line-bare' },
  { name: '③e 留空格块注释 → space',
    code: S`const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, ' ');`,
    want: 'space' },
];
for (const s of samples) {
  const got = classifyInlineStrip(s.code);
  t(s.name, got !== null && got.join(',') === s.want, `实际=${got ? got.join(',') : 'null'} 期望=${s.want}`);
}
t('③f 无剥注释实现 → null（判据不恒真）', classifyInlineStrip('const a = fs.readFileSync(p,"utf8");') === null);
t('③g 注释里引用正则不算实现（调用方先剥注释再分类）',
  classifyInlineStrip(stripCommentsFlatJs(
    "/* const strip = (x) => x.replace(/\\/\\*[\\s\\S]*?\\*\\//g, ''); */\nconst x = 1;")) === null);

/* ------------------------------------------------------------------ */
const fail = fails.length;
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { for (const f of fails) console.log(`  ❌ ${f}`); process.exitCode = 1; }
