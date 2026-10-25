/**
 * 媒体探测「静默」守卫
 * ============================================================
 *
 * 守的是什么：
 *   jsdom 只给 DOM 壳子，不给解码能力。它的 `HTMLMediaElement.load/play`、
 *   `HTMLCanvasElement.getContext` 都是「未实现」桩，而这些桩
 *   **不抛异常** —— 是通过虚拟控制台往 stderr 打一条
 *
 *       Error: Not implemented: HTMLMediaElement.prototype.load
 *
 *   所以 try/catch 抓不住（旧注释里"jsdom 直接抛 Not implemented"是错的）。
 *
 * 为什么不值得忍：
 *   实测（本轮完整复现）mindmap 测试 **4880 项全过、退出码 0**，尾部却挂着
 *   这种红字。读报告的人据此判断「mindmap 崩在 media-info.js」，于是整轮
 *   拿来排查一个根本没崩的东西 ——
 *   **没崩但看起来像崩，和有崩一样费事**。
 *
 * 判据：能力检测（canPlayType）而不是 UA 字符串 —— 前者问的是能力本身。
 *
 * 用法：node media-probe-silence-test.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? ` → ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` → ${detail}` : ''}`); }
};

/* ---------------------------- 装一个最小 jsdom ---------------------------- */

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLMediaElement = dom.window.HTMLMediaElement;
globalThis.navigator = dom.window.navigator;
globalThis.URL = dom.window.URL;

const mi = await import('./js/media-info.js');

/* ------------------------- ① canDecodeMedia 判据本身 ------------------------- */

ok('★ jsdom 下 canDecodeMedia() 必须为 false（否则下面的守卫全部空转）',
  mi.canDecodeMedia() === false, `实测 ${mi.canDecodeMedia()}`);

ok('canDecodeMedia 有导出（共享层提供，插件不得自己另写一份）',
  typeof mi.canDecodeMedia === 'function');

/* -------------------- ② probeByElement：不建元素、不挂定时器 -------------------- */

{
  const t0 = Date.now();
  const r = await mi.probeByElement(
    new dom.window.Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }));
  const dt = Date.now() - t0;
  ok('★ 无解码能力时 probeByElement 立即返回 null（不挂 8 秒兜底定时器）',
    r === null && dt < 500, `返回 ${r}，耗时 ${dt}ms（修复前会挂满 8000ms）`);
}

/* --------------------- ③ 真的不再往 stderr 打「未实现」 --------------------- */

{
  const realErr = console.error;
  const seen = [];
  console.error = (...a) => { seen.push(String(a[0] ?? '')); };
  try {
    await mi.probeByElement(
      new dom.window.Blob([new Uint8Array([9, 9, 9])], { type: 'video/mp4' }));
    // 让任何"迟到的"定时器有机会触发
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    console.error = realErr;
  }
  const hit = seen.filter((s) => /Not implemented/i.test(s));
  ok('★ probeByElement 全程不得产生 Not implemented 上报',
    hit.length === 0, hit.length ? hit.join(' | ') : `0 条（捕获 ${seen.length} 条输出）`);
}

/* ---------------- ④ panels.js：两处 play 前都得有同一份守卫 ---------------- */

const panelsPath = join(HERE, 'plugins/mindmap/panels.js');
const panels = readFileSync(panelsPath, 'utf8');

/**
 * play 调用点是否**紧邻**着守卫。
 *
 * ⛔ 注意"紧邻"两字：只查"文件里有没有 canDecodeMedia"是不够的 ——
 *    panels.js 里有两处 play，改一处另一处照样打红字。
 *    所以判据必须**逐调用点**看，而不是看全文。
 */
function guardedNear(lineIdx, lines) {
  /*
   * 判据是**函数级**的，不是"往上数 8 行"。
   *
   * ⛔ 为什么不能数行：第二处 play 在 `p.catch(() => { ... })` 回调里，
   *    往上 8 行会先撞到 `if (!p || typeof p.catch !== 'function') return;`
   *    这行也有 `return;`，于是被当成"上一段的结尾"——**有守卫被判成没守卫**
   *    （本判据第二版正是这么错的）。而守卫在函数头，对整个函数（含回调）都生效。
   *
   * ⛔ 也不能只看"全文有没有 canDecodeMedia"：panels.js 里 play 有三处，
   *    改一处另两处照样打红字，全文判据会一路绿到底。
   */
  let head = 0;
  for (let i = lineIdx; i >= 0; i--) {
    if (/^\s{2}(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/.test(lines[i])
      || /^\s{2}(?:async\s+)?\w+\s*\([^)]*\)\s*\{/.test(lines[i])) { head = i; break; }
  }
  for (let i = lineIdx; i >= head; i--) {
    if (/canDecodeMedia\s*\(/.test(lines[i])) return true;
  }
  return false;
}

const lines = panels.split('\n');
const playSites = [];
lines.forEach((ln, i) => {
  // `v.play?.()` 的 `?.` 中间还有一个点，正则必须容得下可选链
  if (/\.play\??\.?\(\s*\)/.test(ln)) playSites.push(i);
});

ok('能定位到 panels.js 里的 play 调用点（定位不到=本节恒绿，等于没查）',
  playSites.length > 0, `${playSites.length} 处`);

const unguarded = playSites.filter((i) => !guardedNear(i, lines));
ok('★ 每处 play 调用前都必须有无解码能力守卫',
  unguarded.length === 0,
  unguarded.length ? unguarded.map((i) => `第 ${i + 1} 行`).join('、') : `${playSites.length} 处均已守卫`);

/* ---------------------------- ⑤ 自检：判据没失明 ---------------------------- */

{
  const sample = [
    'const start = () => {',
    '  video.controls = true;',
    '  const p = video.play();',
    '  if (p && p.catch) p.catch(() => {});',
    '};',
  ];
  const idx = sample.findIndex((l) => /\.play\??\(/.test(l));
  ok('自检：没有守卫的样本必须被判为「未守卫」（否则第 ④ 节恒绿）',
    idx >= 0 && guardedNear(idx, sample) === false);

  const sample2 = [
    'const start = () => {',
    '  if (!mi.canDecodeMedia()) return;',
    '  const p = video.play();',
    '};',
  ];
  const idx2 = sample2.findIndex((l) => /\.play\??\(/.test(l));
  ok('自检：有守卫的样本必须被判为「已守卫」',
    idx2 >= 0 && guardedNear(idx2, sample2) === true);
}

/* ------------------------------ 汇总 ------------------------------ */

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('媒体探测静默守卫未通过');
  process.exit(1);
}
console.log('媒体探测静默守卫全部通过');
