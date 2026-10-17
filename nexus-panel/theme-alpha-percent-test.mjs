/**
 * 主题颜色的 alpha 必须认百分比
 * ============================================================
 * 要防的形状：**同一个 bug 在两份几乎相同的解析里各犯一次**。
 *
 * 主题颜色有两处解析：
 *   · js/theme-color.js 的 splitColor —— 设置页颜色编辑器（双模共用）
 *   · js/theme-manager.js 的 scaleAlpha —— 风格参数滑块（玻璃透明度 / 立体度）
 *
 * 早先它们各写一份，两份都处理了 RGB 通道的百分比（`rgb(50% 20% 10%)`），
 * 但 **alpha 的百分比都没处理**：`rgb(255 255 255 / 12%)` 被 parseFloat
 * 读成 12，再被 clamp 到 1 —— 于是**半透明被读成完全不透明**。
 *
 * 后果（两条路各一条）：
 *   · 设置页：alpha 滑块显示满格，用户点一下取色器就把 12% 写成不透明，
 *     **且不可恢复**（原值已被覆盖）。这正是 theme-color.js 开头那段注释
 *     警告的后果 —— 注释承诺了代码没做的事。
 *   · 玻璃透明度滑块：拖一下，本该更透的边框直接变实心。
 *
 * 判据一律**跑真身**：真 import theme-color.js 调 splitColor / parseCssColor，
 * scaleAlpha 从源码切出来注入 parseCssColor 实跑。不靠"源码里有没有 %
 * 这几个字" —— 后者证明不了 12% 到底被读成 0.12 还是 1。
 */
import { readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';
/* 剥注释走共用模块：内联副本的行注释判据是 `(^|[^:])\/\/`，会把 `a//b`
   （路径拼接、协议头）从斜杠处起整行后半截吞掉 —— 断言其实在检查一段
   被截断的文本，可能假绿。共用模块用 `(^|\s)`，只认真注释形态。 */
import { stripCommentsFlatJs as strip } from './test-scan-utils.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const tc = await import(new URL('js/theme-color.js', import.meta.url).href);
const read = (p) => readFileSync(pjoin(HERE, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
const fails = [];
const t = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log('  ✓ ' + name + (detail ? ' → ' + detail : '')); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
};

/* ------------------------------------------------------------------ */
console.log('\n[1] alpha 百分比（核心 BUG）');
/* ------------------------------------------------------------------ */

const pct = [
  ['rgb(0 0 0 / 50%)', 0.5],
  ['rgb(0 0 0/50%)', 0.5],
  ['rgba(0, 0, 0, 50%)', 0.5],
  ['rgb(255 255 255 / 12%)', 0.12],
  ['rgb(36 41 57 / 90%)', 0.9],
  ['rgb(0 0 0 / 100%)', 1],
  ['rgb(0 0 0 / 0%)', 0],
];
for (const [src, want] of pct) {
  const got = tc.splitColor(src);
  t(`★ ${src} 的 alpha 是 ${want}`,
    got != null && Math.abs(got.alpha - want) < 1e-9,
    got ? String(got.alpha) : 'null');
}

/* 非百分比写法行为不变 —— 修百分比不能把老写法改坏 */
const plain = [
  ['rgba(255,255,255,.12)', 0.12],
  ['rgba(0,0,0,0.5)', 0.5],
  ['rgb(0 0 0 / 0.5)', 0.5],
  ['rgb(0 0 0)', 1],
  ['rgba(0,0,0,1)', 1],
  ['#aabbcc', 1],
  ['#abc', 1],
];
for (const [src, want] of plain) {
  const got = tc.splitColor(src);
  t(`${src} 的 alpha 仍是 ${want}（未改坏）`,
    got != null && Math.abs(got.alpha - want) < 1e-9,
    got ? String(got.alpha) : 'null');
}

/* 8 位 hex 的 aa 是 0..255，不是百分比 */
const h8 = tc.splitColor('#aabbcc80');
t('#aabbcc80 按 0..255 换算 alpha（不是 80%）',
  h8 != null && Math.abs(h8.alpha - 128 / 255) < 1e-9, h8 ? String(h8.alpha) : 'null');

/* ------------------------------------------------------------------ */
console.log('\n[2] 认不出的值必须判 null，不能变黑');
/* ------------------------------------------------------------------ */

/* parseInt('GGG',16) 是 NaN，而 NaN >> 16 === 0 —— 不显式判非法字符的话，
   #GGG 会被当成纯黑返回，正是"点一下就把透明改成黑"那类问题 */
for (const bad of ['#GGG', '#12345', '#12ab-cd', 'red', 'linear-gradient(#fff,#000)', 'transparent', 'none', '']) {
  t(`★ ${JSON.stringify(bad)} → null（不是黑色）`, tc.splitColor(bad) === null,
    JSON.stringify(tc.splitColor(bad)));
}

/* 通道百分比仍然认（这是原有能力，不能回退） */
const ch = tc.splitColor('rgb(50% 20% 10%)');
t('rgb(50% 20% 10%) 通道百分比仍认', ch != null && ch.hex === '#80331a', ch ? ch.hex : 'null');

/* ------------------------------------------------------------------ */
console.log('\n[3] scaleAlpha 走同一份判据（不再自带一份）');
/* ------------------------------------------------------------------ */

const tmSrc = read('js/theme-manager.js');

/* 切出 scaleAlpha 真身：从函数签名起配平大括号 */
const anchor = 'function scaleAlpha(str, k) {';
const ai = tmSrc.indexOf(anchor);
t('★ 找得到 scaleAlpha', ai >= 0);
let depth = 0;
let end = -1;
for (let i = tmSrc.indexOf('{', ai); i < tmSrc.length; i += 1) {
  if (tmSrc[i] === '{') depth += 1;
  else if (tmSrc[i] === '}') {
    depth -= 1;
    if (depth === 0) { end = i + 1; break; }
  }
}
t('★ 切出的片段以完整函数结尾（大括号配平）', end > 0 && tmSrc.slice(ai, end).trim().endsWith('}'));
const fnSrc = tmSrc.slice(ai, end);

/* 注入 parseCssColor 后实跑 */
const parseCssColor = tc.parseCssColor;
let scaleAlpha;
try {
  scaleAlpha = new Function('parseCssColor', fnSrc + '\nreturn scaleAlpha;')(parseCssColor);
} catch (e) {
  t('scaleAlpha 能加载', false, String(e && e.message));
}
t('★ scaleAlpha 是可调用的函数', typeof scaleAlpha === 'function');

if (typeof scaleAlpha === 'function') {
  /* 100% = k=1，等于原值（不缩放），用来验"读对了" */
  const a50 = scaleAlpha('rgb(0 0 0 / 50%)', 1);
  t('★ 50% 被读成 0.5（旧代码读成 1）',
    /rgba\(0, 0, 0, 0\.5\)/.test(a50), a50);

  const a12 = scaleAlpha('rgb(255 255 255 / 12%)', 1);
  t('★ 12% 被读成 0.12（旧代码读成 1）',
    /rgba\(255, 255, 255, 0\.12\)/.test(a12), a12);

  /* 真缩放：k=2 时 0.12 → 0.24 */
  const scaled = scaleAlpha('rgb(255 255 255 / 12%)', 2);
  t('★ 12% 按倍率缩放到 0.24', /rgba\(255, 255, 255, 0\.24\)/.test(scaled), scaled);

  /* 认不出的一律原样返回，不能变成黑 */
  const keep = scaleAlpha('linear-gradient(#fff,#000)', 2);
  t('★ 渐变原样返回（不被改写成 rgba）', keep === 'linear-gradient(#fff,#000)', keep);
  const keepT = scaleAlpha('transparent', 2);
  t('transparent 原样返回', keepT === 'transparent', keepT);
  const keepG = scaleAlpha('#GGG', 2);
  t('★ #GGG 原样返回（不被当成纯黑）', keepG === '#GGG', keepG);

  /* hex 视作 alpha=1 参与缩放（glass 那半的原有能力，不能回退） */
  const hexScaled = scaleAlpha('#2b2f36', 0.5);
  t('hex 视作 alpha=1 参与缩放（不回退）', /rgba\(43, 47, 54, 0\.5\)/.test(hexScaled), hexScaled);
}

/* theme-manager.js 不再自带一份解析 */
const tmNoComment = strip(tmSrc);
/* clampAlphaMin 是第三处：旧版只按逗号切 + alpha 不认百分比，
   于是 `rgb(0 0 0 / 50%)` 被当成"不是 rgba"原样返回 —— 地板静默失效 */
const cmAnchor = 'function clampAlphaMin(str, floor) {';
const ci = tmSrc.indexOf(cmAnchor);
t('★ 找得到 clampAlphaMin', ci >= 0);
let cd = 0;
let cend = -1;
for (let i = tmSrc.indexOf('{', ci); i < tmSrc.length; i += 1) {
  if (tmSrc[i] === '{') cd += 1;
  else if (tmSrc[i] === '}') { cd -= 1; if (cd === 0) { cend = i + 1; break; } }
}
const cmSrc = tmSrc.slice(ci, cend);
let clampAlphaMin;
try {
  clampAlphaMin = new Function('parseCssColor', cmSrc + '\nreturn clampAlphaMin;')(parseCssColor);
} catch (e) { t('clampAlphaMin 能加载', false, String(e && e.message)); }
t('★ clampAlphaMin 是可调用的函数', typeof clampAlphaMin === 'function');
if (typeof clampAlphaMin === 'function') {
  /* 地板：低于 floor 要被抬起来 */
  const lo = clampAlphaMin('rgb(0 0 0 / 12%)', 0.5);
  t('★ 12% 低于地板时被抬到 0.5（空格分隔也认）',
    lo === 'rgba(0, 0, 0, 0.5)', lo);
  const hi = clampAlphaMin('rgb(0 0 0 / 80%)', 0.5);
  t('80% 高于地板时原样返回', hi === 'rgb(0 0 0 / 80%)', hi);
  /* hex 仍是刻意的例外：不能被强行套 alpha */
  const hexKeep = clampAlphaMin('#aabbcc', 0.5);
  t('★ hex 仍原样返回（不强行套 alpha）', hexKeep === '#aabbcc', hexKeep);
  const cmComma = clampAlphaMin('rgba(0, 0, 0, 0.2)', 0.5);
  t('逗号写法仍认（未改坏）', cmComma === 'rgba(0, 0, 0, 0.5)', cmComma);
}
t('★ scaleAlpha 调 parseCssColor（判据只有一份）',
  /parseCssColor\s*\(/.test(fnSrc));
t('★ theme-manager.js import 了 parseCssColor',
  /import\s*\{[^}]*\bparseCssColor\b[^}]*\}\s*from\s*'\.\/theme-color\.js'/.test(tmNoComment));
/* 旧的私有判据必须已经消失：它把 alpha 当纯数值 parseFloat 后 clamp */
t('★ 不再有 parseFloat\(parts\[3\]\) 那句私有 alpha 判据',
  !/parseFloat\(parts\[3\]\)/.test(tmNoComment));
/* 注意：这里不能用注释做锚点（顶部已剥注释），也不能只判 "theme-color"
   这几个字 —— import 语句本身就含它，那样断言恒真 */

/* ------------------------------------------------------------------ */
console.log('\n[4] 双模设置页仍共用同一份（不因改动漂移）');
/* ------------------------------------------------------------------ */

const tp = read('plugins/settings/ThemeParams.tsx');
const nb = read('plugins/settings/index.js');
t('React 版 import js/theme-color.js', /js\/theme-color\.js/.test(tp));
t('无构建版 import js/theme-color.js', /js\/theme-color\.js/.test(nb));
t('★ 两边都不再本地定义 splitColor',
  !/function splitColor/.test(strip(tp)) && !/function splitColor/.test(strip(nb)));
/* joinColor 同理：两边都只转发 */
t('两边都转发 joinColor（不是各写一份）',
  /joinColor/.test(tp) && /joinColor/.test(nb) &&
  !/function joinColor/.test(strip(tp)) && !/function joinColor/.test(strip(nb)));

/* ------------------------------------------------------------------ */
console.log('\n[5] joinColor 拼回（alpha 为 1 输出 hex）');
/* ------------------------------------------------------------------ */
t('alpha=1 → hex（不写成长串 rgba）', tc.joinColor('#ffffff', 1) === '#ffffff', tc.joinColor('#ffffff', 1));
t('alpha<1 → rgba', tc.joinColor('#ffffff', 0.12) === 'rgba(255, 255, 255, 0.12)', tc.joinColor('#ffffff', 0.12));
/* 往返：百分比 → 拆分 → 拼回，语义不丢 */
const rt = tc.splitColor('rgb(255 255 255 / 12%)');
t('★ 往返：12% 拆了再拼回仍是 0.12',
  rt != null && tc.joinColor(rt.hex, rt.alpha) === 'rgba(255, 255, 255, 0.12)',
  rt ? tc.joinColor(rt.hex, rt.alpha) : 'null');

/* ------------------------------------------------------------------ */
console.log('\n' + '─'.repeat(60));
if (fails.length) {
  console.log(`主题 alpha 百分比：${pass} 通过 / ${fails.length} 失败`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`主题 alpha 百分比：${pass} 通过 / 0 失败`);
