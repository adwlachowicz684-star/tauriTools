/**
 * 首屏防闪 <style> 必须被撤掉（否则切主题后底色卡在首屏那一版）
 * ================================================================
 * 起因：
 *   index.html / index.react.html 各自有一段首屏脚本，读 localStorage 里
 *   缓存的底色，注入一只 `<style id="nexus-preload-bg">`，内容是
 *   `html,body{background:<定值>;color:<定值>}`，用来避免白闪。
 *
 *   它**不会被后加载的样式表覆盖**（那句注释是错的，已改正）：
 *     · <link rel=stylesheet> 在 <head> 里、位于首屏脚本之前；
 *     · appendChild 把它放在 head **末尾**，即样式表之后；
 *     · 与 neumorphism.css 的 `body{background:var(--bg)}` 特异性相同，
 *       同特异性时后来者胜 → 是它压住样式表。
 *
 *   于是 theme-manager 的 applyTo 只改 --bg / --text 变量，算出来的值被
 *   这只 style 的定值压住 → **切完主题底色不变**，要刷新才生效。
 *   深色切浅色最明显：背景卡在深色那一版，浅色文字压在深底上。
 *
 * 这里钉三件事：
 *   ① 三处 id 字面量必须一致（两个 html 各一份 + theme-manager 一份）
 *   ② theme-manager 必须真去 remove 它
 *   ③ 两个 html 确实是 appendChild（放末尾）—— 这是"必须 remove"的前提，
 *      若哪天改成插到样式表之前，第 ② 条就可以退场，本节要能看出来
 *
 * 运行：node preload-style-test.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/* 剥注释走共用模块：注释里会原样举出 id 与写法，不剥会把"已改掉"判成"还在" */
import { stripCommentsFlatJs as strip } from './test-scan-utils.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
const fails = [];
const t = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log('  ✓ ' + name + (detail ? ' → ' + detail : '')); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
};

const TM = strip(read('js/theme-manager.js'));
const HTML_A = strip(read('index.html'));
const HTML_B = strip(read('index.react.html'));
const CSS = strip(read('css/neumorphism.css'));

/* ==================== ① 三处 id 必须一致 ==================== */
console.log('\n=== ① 首屏 style 的 id：三个文件必须同一个 ===');
/*
 * 为什么只能是"跨文件字面量一致"这种笨办法：
 *   首屏脚本是 index.html 里的内联 <script>，跑在主题模块之前、
 *   也 import 不了本模块的常量 —— 三处注定各写一份。
 *   与「两个外壳的 CSP」「Rust 常量」是同一族：两份都对，但互不知情。
 */
const ID_RE = /nexus-preload-bg/;
const idA = HTML_A.match(ID_RE);
const idB = HTML_B.match(ID_RE);
const idT = TM.match(ID_RE);
/* 存在性判定：先确认三处都真的写了这个 id，再谈"一致"。
   少了这一步，把 ID_RE 改成永不匹配的正则，下面那条"一致"会恒真。 */
t('两个 html 都写了首屏 style 的 id', !!idA && !!idB,
  `index.html=${!!idA} index.react.html=${!!idB}`);
t('theme-manager 也点名了同一个 id', !!idT, `theme-manager=${!!idT}`);
t('三处 id 字面量完全一致（不等就 remove 找不到、底色继续卡住）',
  !!idA && !!idB && !!idT && idA[0] === idB[0] && idB[0] === idT[0],
  [idA?.[0], idB?.[0], idT?.[0]].join(' / '));

/* ==================== ② 必须真去 remove ==================== */
console.log('\n=== ② 主题就绪后必须主动 remove（靠层叠盖不掉） ===');
const REMOVE_RE = /getElementById\(\s*PRELOAD_STYLE_ID\s*\)\s*\?\.\s*remove\s*\(\s*\)/;
const removeHit = REMOVE_RE.test(TM);
t('applyTo 里按该 id 移除首屏 style', removeHit,
  removeHit ? 'getElementById(PRELOAD_STYLE_ID)?.remove()' : '没找到移除调用');
/* 常量本身必须有定义，否则上面那条匹配的是个不存在的名字 */
const DEF_RE = /const\s+PRELOAD_STYLE_ID\s*=\s*'nexus-preload-bg'/;
t('PRELOAD_STYLE_ID 常量有定义且指向该 id', DEF_RE.test(TM));
/* 判据自检：写成别的调用形式（比如只 remove 变量）必须被认出来 */
t('移除判据确能命中（反面证据）',
  REMOVE_RE.test("document.getElementById(PRELOAD_STYLE_ID)?.remove();"),
  '标准写法命中');
t('不移除的写法不被误判为已移除',
  !REMOVE_RE.test("document.getElementById(PRELOAD_STYLE_ID)?.textContent = '';"),
  '只改内容不算移除');

/* ==================== ③ 确实是 appendChild（放末尾）==================== */
console.log('\n=== ③ 注入位置在样式表之后 —— 这才是"必须 remove"的原因 ===');
for (const [name, html] of [['index.html', HTML_A], ['index.react.html', HTML_B]]) {
  const iLink = html.indexOf('<link rel="stylesheet"');
  const iAppend = html.indexOf('appendChild(st)');
  t(`${name}：确实注入了首屏 style（appendChild）`, iAppend >= 0, `appendChild@${iAppend}`);
  if (iLink >= 0) {
    /* 有样式表 link 的一侧：顺序能定死，必须钉住。
       顺序断言缺存在性判定时 `-1 < x` 恒真，会伪装成通过 —— 故上面先判存在。 */
    t(`${name}：首屏 style 追加在样式表之后（所以盖不掉它，只能 remove）`,
      iAppend > iLink, `link@${iLink} < appendChild@${iAppend}`);
  } else {
    /*
     * 没有样式表 link 的一侧（Vite 模式：CSS 由 JS import 注入）。
     * 这时**顺序定不死** —— dev 下 CSS 是 main.tsx 执行时才注入的 <style>，
     * 排在首屏那只之后，恰好能盖掉；而生产构建会把 CSS 变成 <link> 放在
     * head 里，又排到首屏那只之前，盖不掉。
     *
     * 也就是说：这一侧"会不会卡住"取决于构建方式。不能靠运气 —— 第 ② 节
     * 那次 remove 对两种情况都对，所以仍然是唯一稳的做法。
     * 这里钉的是"确实没有 link"这个事实，免得哪天加了 link 而没人重估。
     */
    t(`${name}：无样式表 link（CSS 由构建注入，顺序不定 → 更不能靠层叠）`,
      iLink === -1, `link@${iLink}（无）`);
  }
}

/* ==================== ④ 被压住的那条规则确实存在 ==================== */
console.log('\n=== ④ 被压住的一方：body 的底色来自变量 ===');
const BODY_BG = /body\s*\{[^}]*background:\s*var\(--bg\)/;
t('neumorphism.css 里 body 的底色确实是 var(--bg)（所以能被定值压住）',
  BODY_BG.test(CSS), BODY_BG.test(CSS) ? '命中' : '没找到 body{background:var(--bg)}');
/* 同特异性才有"后来者胜"这回事：定值那条是 html,body，变量这条是 body */
t('两条规则特异性相同（都是元素级，故顺序决定胜负）',
  /html\s*,\s*body\s*\{/.test(HTML_A) && /html\s*,\s*body\s*\{/.test(HTML_B),
  '注入的是 html,body{…}');

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) { for (const f of fails) console.log('  ❌ ' + f); }
process.exit(fails.length ? 1 : 0);
