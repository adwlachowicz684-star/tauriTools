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
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanInlineStrip, classifyInlineStrip } from './scripts/scan-inline-strip.mjs';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';

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
const LEDGER = {
  'plugins/mindmap/mm-export-name-test.mjs': {
    kinds: ['flat', 'line-colon'],
    why: '行注释判据是 (^|[^:])，与公共 (^|\\s) 不同：a//b 会被吞掉后半截',
    unblock: '实测被扫内容里无此形态后，改为 stripCommentsFlatJs 并逐项比对断言结果',
  },
  'plugins/mindmap/mm-shrink-name-test.mjs': {
    kinds: ['flat', 'line-colon'],
    why: '同 mm-export-name，(^|[^:]) 判据语义不同',
    unblock: '同上，两个文件一起改、一起验证',
  },
  'plugins/task-board/task-board-test.mjs': {
    kinds: ['flat', 'line-colon'],
    why: '第 2711 行 src.replace 用 (^|[^:]) 行注释判据，与公共 (^|\\s) 不同：a//b 会被吞掉后半截',
    unblock: '实测被扫内容里无此形态后，改为 stripCommentsFlatJs 并逐项比对断言结果',
  },
  'plugins/project-group/saveguard-test.mjs': {
    kinds: ['flat', 'line-safe'],
    why: 'strip 定义本身等价于 stripCommentsFlatJs，但第 4 节还有一处 strip(lm).replace(/\\/\\/[^\\n]*/g, \'\') 的裸行注释二次剥离',
    unblock: '先确认 useLayoutMemory.ts 里无 URL，再一并换成 stripCommentsFlatJs；两处一起换、一起逐项比对',
  },
  'plugins/project-group/config-corrupt-notice-test.mjs': {
    kinds: ['flat', 'line-bare'],
    why: '裸行注释正则会吞 https:// 与 file://，公共判据 (^|\\s) 不会',
    unblock: '核实被扫文件无 URL 后换 stripCommentsFlatJs，并保留逐项结果比对',
  },
  'plugins/project-group/mcp-addcard-guard-test.mjs': {
    kinds: ['flat', 'line-bare'],
    why: '块注释 + 逐行 split 剥行注释的混合写法，不是同一个函数',
    unblock: '先确认逐行写法是否等价于 stripCommentsFlatJs，再合并',
  },
  'plugins/project-group/mcp-string-args-test.mjs': {
    kinds: ['flat', 'line-bare'],
    why: '裸行注释正则，语义与公共判据不同',
    unblock: '同 config-corrupt-notice',
  },
  'plugins/project-group/mcp-typed-args-test.mjs': {
    kinds: ['flat', 'line-bare'],
    why: '裸行注释正则，语义与公共判据不同',
    unblock: '同 config-corrupt-notice',
  },
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
};

/* 已销账：换成公共设施的文件。必须真的 import，且不再有内联实现。 */
const DONE = {
  'native-assets-test.mjs': './test-scan-utils.mjs',
  'plugins/project-group/backup-interval-test.mjs': '../../test-scan-utils.mjs',
  'plugins/project-group/mcp-enum-args-test.mjs': '../../test-scan-utils.mjs',
  'plugins/project-group/shell-icon-notify-test.mjs': '../../test-scan-utils.mjs',
  'plugins/project-group/stack-reveal-once-test.mjs': '../../test-scan-utils.mjs',
  'plugins/project-group/watch-scope-test.mjs': '../../test-scan-utils.mjs',
  'plugins/project-group/watch-toggle-test.mjs': '../../test-scan-utils.mjs',
};

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
