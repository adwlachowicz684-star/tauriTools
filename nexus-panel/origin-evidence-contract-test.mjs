/**
 * 真实浏览器四象限「证据链契约」守卫
 * ============================================================
 * 运行：node origin-evidence-contract-test.mjs
 *
 * 第 61 轮落下三份文件：复现脚本 probe-origin-real-browser.mjs、证据
 * origin-evidence.json、结论文档 real-device-origin-evidence.md，并明确
 * 「不新增守卫、不改产品行为、不进 CI」。三份都看着自洽，但没人核过它们
 * 是不是同一套契约 —— 实测两处脱节：
 *
 *   ① 探针写出的字段名是 docReadable / ready / moduleDownloaded，
 *      证据文件里却是 contentDocumentReadable / readyReceived /
 *      externalModuleDownloaded。重跑探针会**覆盖**成另一套名字；任何按
 *      证据字段复核结论的工具会拿到满屏 undefined，把 PASS 抹成
 *      INCONCLUSIVE。证据文件不可能由当前探针产出，却没有判据发现。
 *   ② 「哪个插件是外链 bundle」在探针里写死 'project-group'（三处），
 *      证据里的 externalBundleId 也是手写常量。产物形态一变，第四象限
 *      换不了样本，verdict 却仍可能 PASS —— 实证悄悄失真且不报错。
 *
 * 这正是第 208 轮「手写台账冒充 12 仓实测」的形状：**结论文件与它的
 * 产出通道脱节，而体检单全绿**。
 *
 * 本守卫零依赖、不跑 playwright、不改产品行为：
 *   ① 键集合单向包含：证据里每个键，探针的 evidence 构造块都必须产出
 *      （探针多写逐插件 shape 明细是允许的，证据是精简快照）；
 *   ② verdictOf 从探针切真身，用 new Function 编译后喂落盘证据实跑，
 *      再喂 5 个反例（不是看源码里有没有那几个字）；
 *   ③ 外链 id 必须由真实 HTML 形态派生，不许写死、不许静默兜底；
 *   ④ 文档表格的数字必须与证据一致；
 *   ⑤ 证据数值自洽（数量、下载路径、rawMessages）；
 *   ⑥ 元断言：注释喂饱反例 / 防恒真 / 空文本 / 剥注释自检。
 *
 * 剥注释统一走 test-scan-utils.mjs，不新增内联副本。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsJs } from './test-scan-utils.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROBE = fs.readFileSync(path.join(ROOT, 'scripts', 'probe-origin-real-browser.mjs'), 'utf8');
const EVIDENCE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'origin-evidence.json'), 'utf8'));
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'real-device-origin-evidence.md'), 'utf8');
const CODE = stripCommentsJs(PROBE);

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const clone = (o) => JSON.parse(JSON.stringify(o));

/* 括号配平：切出 evidence 构造块 / verdictOf 真身 */
function extractBlock(code, start) {
  let depth = 0, begun = false;
  for (let j = start; j < code.length; j++) {
    if (code[j] === '{') { depth++; begun = true; }
    else if (code[j] === '}') {
      depth--;
      if (begun && depth === 0) return code.slice(start, j + 1);
    }
  }
  return null;
}
function extractFn(code, sig) {
  const i = code.indexOf(sig);
  if (i < 0) return null;
  const body = extractBlock(code, code.indexOf('{', i));
  return body ? code.slice(i, code.indexOf('{', i)) + body : null;
}

/* 收集「字段契约」键名：只走对象，数组是数据快照不进去挖元素键
   （否则 rawMessages 里的 who/type/origin 和数组下标会被当成契约字段）。 */
function keysOf(o, acc = []) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return acc;
  for (const k of Object.keys(o)) { acc.push(k); keysOf(o[k], acc); }
  return acc;
}
const EV_KEYS = [...new Set(keysOf(EVIDENCE))];

/* 纯判据：证据里每个键都必须在构造块里以 `键:` 形式产出 */
function keyContract(block, keys) {
  if (!block) return false;
  const missing = keys.filter((k) => !new RegExp('\\b' + k + '\\s*:').test(block));
  return missing.length === 0;
}
const EVIDENCE_BLOCK = extractBlock(CODE, CODE.indexOf('const evidence = {'));

console.log('\n=== 1. 证据 ↔ 探针字段契约（重跑不许改名）===\n');
const missing = EVIDENCE_BLOCK
  ? EV_KEYS.filter((k) => !new RegExp('\\b' + k + '\\s*:').test(EVIDENCE_BLOCK)) : EV_KEYS;
t('①a 证据里每个键探针都产出', EVIDENCE_BLOCK !== null && missing.length === 0,
  missing.length ? '缺: ' + missing.join(', ') : '构造块都没切到');
t('①b 证据 scenario 不含旧套字段名',
  !/\b(docReadable|moduleDownloaded)\s*:/.test(JSON.stringify(EVIDENCE.scenario))
  && !/"ready"\s*:/.test(JSON.stringify(EVIDENCE.scenario)));
t('①c 探针 evidence 构造不含旧套字段名',
  !!EVIDENCE_BLOCK && !/\b(docReadable|moduleDownloaded)\s*:/.test(EVIDENCE_BLOCK));
t('①d 探针额外写逐插件 shape 明细（证据是精简快照，单向包含）',
  !!EVIDENCE_BLOCK && /\bshape\s*[,}]/.test(EVIDENCE_BLOCK));

console.log('\n=== 2. verdict 判据跑真身（落盘证据 + 5 个反例）===\n');
const V_SRC = extractFn(CODE, 'function verdictOf(');
let verdict = null, compiled = false, compileErr = '';
if (V_SRC) {
  try { verdict = new Function(`${V_SRC}\nreturn verdictOf;`)(); compiled = true; }
  catch (e) { compileErr = String(e); }
}
t('②a 切得到 verdictOf 真身且能编译（编译失败要报红，不能崩在半路）', compiled, compileErr);
if (compiled) {
  t('②b 落盘证据本身判为 PASS', verdict(EVIDENCE) === true);
  const a = clone(EVIDENCE); a.scenario.crossOriginInlineBundle.readyReceived = false;
  t('②c 内联 bundle 没 ready → 不 PASS', verdict(a) === false);
  const b = clone(EVIDENCE); b.scenario.crossOriginExternalBundle.externalModuleDownloaded = 0;
  t('②d 外链 module 没下载 → 不 PASS', verdict(b) === false);
  const c = clone(EVIDENCE); c.scenario.crossOriginExternalBundle.readyReceived = true;
  t('②e 外链 bundle 竟 ready（CORS 没拦住）→ 不 PASS', verdict(c) === false);
  const d = clone(EVIDENCE); d.scenario.crossOriginInlineBundle.contentDocumentReadable = true;
  t('②f 内联跨源 DOM 竟可读 → 不 PASS', verdict(d) === false);
  const old = clone(EVIDENCE);
  delete old.scenario.sameOriginRuntime.readyReceived;
  old.scenario.sameOriginRuntime.ready = true;
  t('②g 字段名退回旧套时结论被抹掉 → 不 PASS', verdict(old) === false);
} else {
  for (const n of ['②b', '②c', '②d', '②e', '②f', '②g']) t(n + ' 编译闸门未过', false);
}

console.log('\n=== 3. 外链插件 id 由产物形态决定（不写死、不静默）===\n');
t('③a 剥注释后探针不含写死的插件 id', !/'project-group'/.test(CODE));
t('③b EXTERNAL_IDS 由真实 HTML 的 shape 统计派生',
  /const EXTERNAL_IDS = Object\.keys\(shape\)\.filter\(/.test(CODE));
t('③c 没有外链产物时显式抛错，不静默跑出 PASS',
  /if \(!EXTERNAL_ID\) throw new Error/.test(CODE));
t('③d 证据的 externalBundleId 取自实测变量而非手写常量',
  typeof EVIDENCE.productShape.externalBundleId === 'string'
  && !/externalBundleId:\s*'/.test(CODE));
t('③e 三处消费点都走 EXTERNAL_ID',
  (CODE.match(/EXTERNAL_ID/g) || []).length >= 4);

console.log('\n=== 4. 文档数字 ↔ 证据 ===\n');
const N = EVIDENCE.pluginCount;
const INL = EVIDENCE.productShape.inlineBundle;
const EXT = EVIDENCE.productShape.externalBundle;
const ID = EVIDENCE.productShape.externalBundleId;
const m1 = DOC.match(/HTML 自包含内联 bundle\s*\|\s*\*\*(\d+)\*\*/);
const m2 = DOC.match(/外链 bundle\s*\|\s*\*\*(\d+)\*\*/);
t('④a 文档内联数与证据一致', !!m1 && Number(m1[1]) === INL, m1 ? m1[1] : '表格没匹配到');
t('④b 文档外链数与证据一致', !!m2 && Number(m2[1]) === EXT, m2 ? m2[1] : '表格没匹配到');
t('④c 插件总数 12/12 与证据一致', DOC.includes(`${N}/12`) || DOC.includes(`**${N}**`));
t('④d 文档点名的外链插件与证据一致', DOC.includes(ID));
t('④e 文档写明复现脚本与证据文件路径',
  DOC.includes('probe-origin-real-browser.mjs') && DOC.includes('origin-evidence.json'));

console.log('\n=== 5. 证据数值自洽 ===\n');
const sc = EVIDENCE.scenario;
t('⑤a inline + external === pluginCount', INL + EXT === N);
t('⑤b externalModuleDownloaded === downloadedPaths 条数',
  sc.crossOriginExternalBundle.externalModuleDownloaded === sc.crossOriginExternalBundle.downloadedPaths.length);
t('⑤c 外链 JS 确实下载过且记了请求来源',
  sc.crossOriginExternalBundle.downloadedPaths.length > 0
  && sc.crossOriginExternalBundle.requestOrigins.length > 0);
const msgs = EVIDENCE.rawMessages;
t('⑤d same / installed / assetInline 各有 ready',
  ['same', 'installed', 'assetInline'].every((w) => msgs.some((m) => m.who === w && m.type === 'ready')));
t('⑤e assetExternal 没有 ready（CORS 拒绝执行）',
  !msgs.some((m) => m.who === 'assetExternal' && m.type === 'ready'));
t('⑤f readyOrigin 与 rawMessages 的 assetInline origin 对齐',
  sc.crossOriginInlineBundle.readyOrigin.every((o) =>
    msgs.some((m) => m.who === 'assetInline' && m.type === 'ready' && m.origin === o)));

console.log('\n=== 6. 元断言（注释喂饱 / 防恒真 / 空文本 / 剥注释自检）===\n');
const onlyComment = '/* contentDocumentReadable readyReceived externalBundleId */\nconst evidence = {};';
t('⑥a 字段名只写在注释里不算产出（防注释喂饱）',
  !keyContract(extractBlock(stripCommentsJs(onlyComment), stripCommentsJs(onlyComment).indexOf('const evidence = {')),
    ['contentDocumentReadable', 'readyReceived', 'externalBundleId']));
t('⑥b 键集合判据不是恒真（空构造块必须判不通过）',
  !keyContract('const evidence = {};', EV_KEYS));
t('⑥c 键集合判据不是恒假（完整构造块必须判通过）',
  keyContract(EVIDENCE_BLOCK, EV_KEYS));
t('⑥d 空文本零命中', !keyContract('', EV_KEYS));
t('⑥e 剥注释工具确实剥掉块注释',
  !stripCommentsJs('/* SENTINEL_X */\nconst a = 1;').includes('SENTINEL_X'));
t('⑥f 证据文件能解析且 scenario 四个象限齐',
  !!(sc.sameOriginRuntime && sc.installedSameOriginProjection
    && sc.crossOriginInlineBundle && sc.crossOriginExternalBundle));
t('⑥g 探针 verdict 判据引用的是证据字段（不是旧套）',
  !!V_SRC && /readyReceived/.test(V_SRC) && /contentDocumentReadable/.test(V_SRC)
  && !/\bdocReadable\b/.test(V_SRC));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exitCode = fail ? 1 : 0;
