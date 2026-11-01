/**
 * 单文件内联测试
 * ============================================================
 * 为什么必须测
 * ------------------------------------------------------------
 * 单文件内联是「插件装到 $APPDATA 后用 asset 协议加载」这条路的唯一
 * 非侵入式绕法（坑①：路径 %2F 编码导致 ./assets/*.js 解析到协议根 → 403）。
 * 它一旦失效，表现是：
 *
 *   · 半内联（js 内联了、css 没内联）→ 插件能开、样式全丢，**无任何报错**
 *   · 转义漏了 → JS 里一个 `</script>` 字面量把标签提前闭合，
 *     剩下的源码变成页面正文 —— 白屏 + 页面上出现一段代码
 *   · 动态 import 没查出来 → 主 chunk 内联了，按需 chunk 没进产物，
 *     点某个功能才 404
 *
 * 三种都不报错、不崩。所以本测试的重点不是「正常能内联」，
 * 而是**每条判据都确实抓得住它该抓的东西**，以及
 * **复查函数独立于内联器**（不复用它的中间结果，见模块文件头约束 3）。
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyUrl, findExternalRefs, escapeForScript, escapeForStyle,
  inlineHtml, checkSingleFile,
} from './scripts/single-file.mjs';

let pass = 0, fail = 0, skip = 0, note = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (name, extra = '') => { note++; console.log(`ℹ️ ${name}${extra ? ' → ' + extra : ''}`); };

/* ============================================================
   1. classifyUrl —— URL 分类
   ============================================================ */
t('相对路径 ./assets/a.js 判为 relative', classifyUrl('./assets/a.js') === 'relative');
t('父级路径 ../b.css 判为 relative', classifyUrl('../b.css') === 'relative');
t('无前缀 assets/a.js 判为 relative', classifyUrl('assets/a.js') === 'relative');
t('根绝对路径 /assets/a.js 判为 abs-path',
  classifyUrl('/assets/a.js') === 'abs-path',
  'asset 协议下同样解析到协议根，必须一起内联');
t('http 判为 remote', classifyUrl('http://x.com/a.js') === 'remote');
t('协议相对 //x.com/a.js 判为 remote', classifyUrl('//x.com/a.js') === 'remote');
t('data: 判为 inline', classifyUrl('data:image/png;base64,AAA') === 'inline');
t('asset: 判为 other', classifyUrl('asset://localhost/a.js') === 'other');

/* ============================================================
   2. findExternalRefs —— 扫描
   ============================================================ */
const sampleHtml = `<!DOCTYPE html><html><head>
  <title>T</title>
  <script type="module" crossorigin src="./assets/index-AAA.js"></script>
  <link rel="stylesheet" crossorigin href="./assets/index-BBB.css">
  <link rel="modulepreload" href="./assets/vendor-CCC.js">
  <img src="./assets/logo.png">
</head><body><div id="root"></div></body></html>`;

const refs = findExternalRefs(sampleHtml);
t('扫出 4 条外部引用', refs.length === 4, `实际 ${refs.length}`);
t('script 被识别为 script', refs.some((r) => r.kind === 'script'));
t('stylesheet 被识别为 stylesheet', refs.some((r) => r.kind === 'stylesheet'));
t('modulepreload 被识别为 modulepreload', refs.some((r) => r.kind === 'modulepreload'));
t('img 被识别为 image', refs.some((r) => r.kind === 'image'));
t('全部判为 relative', refs.every((r) => r.cls === 'relative'));

/* 独占样本：只坏在这一条上 —— 远程引用不得被当成可内联的本地引用 */
const remoteOnly = `<script src="https://cdn.example.com/x.js"></script>`;
const remoteRefs = findExternalRefs(remoteOnly);
t('远程 script 被识别且判为 remote',
  remoteRefs.length === 1 && remoteRefs[0].cls === 'remote',
  remoteRefs.map((r) => r.cls).join(','));

/* 独占样本：data: 不进 remaining */
const dataOnly = `<img src="data:image/png;base64,AAAA">`;
t('data: 图片不计为外部引用',
  findExternalRefs(dataOnly).length === 1
  && findExternalRefs(dataOnly)[0].cls === 'inline');

/* ============================================================
   3. 转义（约束 2）
   ============================================================ */
const jsWithClose = `const s = "</script>"; // 注释里也有 </SCRIPT>`;
const escaped = escapeForScript(jsWithClose);
t('</script> 被转义', !escaped.includes('</script'));
t('</SCRIPT> 大写也被转义', !/<\/script/i.test(escaped));
t('转义后仍含 <\\/script 形式', escaped.includes('<\\/script'));
t('转义不改变其它内容', escaped.includes('const s = '));
t('CSS 的 </style> 被转义', !/<\/style/i.test(escapeForStyle('a{} /* </style> */')));

/* ============================================================
   4. inlineHtml —— 内联
   ============================================================ */
const files = {
  'assets/index-AAA.js': 'import "./x";\nconsole.log(1);',
  'assets/index-BBB.css': 'body{margin:0}',
  'assets/vendor-CCC.js': 'export const v=1',
  'assets/logo.png': 'PNG-PLACEHOLDER',
};
const readFromDict = (abs) => {
  for (const [k, v] of Object.entries(files)) {
    if (abs.endsWith(k)) return v;
  }
  return null;
};

const inlined = inlineHtml(sampleHtml, { dir: '/out/demo', readFile: readFromDict });
t('内联了 2 项（script + stylesheet）', inlined.inlined.length === 2,
  `实际 ${inlined.inlined.length}`);
t('modulepreload 被整条删除', inlined.removed.length === 1);
t('img 默认不内联，进 skipped', inlined.skipped.length === 1
  && inlined.skipped[0].kind === 'image');
/* 只断言「阻塞类引用」没了：img 默认不内联，src 仍在，属预期 */
t('产物里不再有 <script src=', !/<script[^>]*src=/.test(inlined.html));
t('产物里不再有 <link href=', !/<link[^>]*href=/.test(inlined.html));
t('未内联的 img 仍在（默认不内联图片）', inlined.html.includes('./assets/logo.png'));
t('JS 内容真的进去了', inlined.html.includes('console.log(1)'));
t('CSS 内容真的进去了', inlined.html.includes('body{margin:0}'));
t('type="module" 被保留', /<script type="module">/.test(inlined.html));
t('crossorigin 已去掉（内联后无意义）', !inlined.html.includes('crossorigin'));
t('内联后 checkSingleFile 只剩 img 一条',
  checkSingleFile(inlined.html).remaining.length === 1,
  JSON.stringify(checkSingleFile(inlined.html).remaining.map((r) => r.kind)));

/* 显式要求连图片一起内联 */
const inlinedImg = inlineHtml(sampleHtml, {
  dir: '/out/demo', readFile: readFromDict, inlineImages: true,
});
t('inlineImages 时图片也内联', inlinedImg.inlined.length === 3);
t('图片以 data: 形式落地', inlinedImg.html.includes('data:image/png;base64,'));

/* 读不到文件必须抛错，不许降级放行（约束 1） */
let threw = false;
try {
  inlineHtml(sampleHtml, { dir: '/out/demo', readFile: () => null });
} catch (e) {
  threw = true;
  t('读不到脚本时抛错且点名', /single-file/.test(e.message) && /index-AAA/.test(e.message),
    e.message);
}
t('读不到脚本时抛错', threw);

/* 独占样本：script 里有 </script> 字面量时，内联后不得提前闭合 */
const trickyHtml = `<script src="./a.js"></script><div>after</div>`;
const tricky = inlineHtml(trickyHtml, {
  dir: '/o',
  readFile: () => 'var s = "</script><div>evil</div>";',
});
/* 判据必须能区分：转义生效时字面量 `</script` 只应出现 1 次（真正的闭合标签）；
   若按位置比较（evil 是否在 after 之前），转义与否都会通过 —— 那是假判据。 */
const closeCount = (tricky.html.match(/<\/script/gi) || []).length;
t('含 </script> 字面量的 JS 内联后，字面量闭合序列只剩 1 处（真闭合标签）',
  closeCount === 1, `实际 ${closeCount} 处`);
t('含 </script> 字面量的 JS 内联后 evil 不在标签外',
  !/<script[^>]*>[\s\S]*<\/script>\s*<div>evil/.test(tricky.html));

/* ============================================================
   5. checkSingleFile —— 复查（独立于内联器）
   ============================================================ */
const clean = `<html><head><script>console.log(1)</script>
<style>body{margin:0}</style></head><body></body></html>`;
const cleanR = checkSingleFile(clean);
t('完全自包含 → ok', cleanR.ok, JSON.stringify(cleanR.remaining.map((r) => r.url)));
t('完全自包含 → 无 remaining', cleanR.remaining.length === 0);
t('完全自包含 → 无 warning', cleanR.warnings.length === 0);

/* 每条 warning 用独占样本测：只该触发一条判据 */
const wDyn = checkSingleFile(`<script>load(()=>import("./assets/lazy.js"))</script>`);
t('动态 import 被查出来', wDyn.warnings.some((w) => w.kind === 'dynamic-import'),
  JSON.stringify(wDyn.warnings));
t('动态 import 样本不触发其它 warning 类型',
  wDyn.warnings.every((w) => w.kind === 'dynamic-import'),
  JSON.stringify(wDyn.warnings));

const wStat = checkSingleFile(`<script>import x from "./assets/y.js"; console.log(x)</script>`);
t('残留静态 import 被查出来', wStat.warnings.some((w) => w.kind === 'static-import'),
  JSON.stringify(wStat.warnings));

const wCss = checkSingleFile(`<style>.a{background:url(./img/bg.png)}</style>`);
t('CSS 里的相对 url() 被查出来', wCss.warnings.some((w) => w.kind === 'css-url'),
  JSON.stringify(wCss.warnings));
t('data: 的 CSS url() 不算问题',
  checkSingleFile(`<style>.a{background:url(data:image/png;base64,AAA)}</style>`).warnings.length === 0);

/* 远程依赖必须报出来（供应链面），不能因为「不影响单文件」就沉默 */
const wRemote = checkSingleFile(`<script src="https://cdn.x.com/a.js"></script>`);
t('远程 script 进 remaining', wRemote.remaining.length === 1
  && wRemote.remaining[0].cls === 'remote');
t('有远程引用时 ok=false', wRemote.ok === false);

/* ============================================================
   6. 真磁盘：走一遍真实读文件路径
   ============================================================ */
const tmpRoot = resolve(tmpdir(), `singlefile-test-${process.pid}`);
let diskDone = false;
try {
  mkdirSync(resolve(tmpRoot, 'assets'), { recursive: true });
  writeFileSync(resolve(tmpRoot, 'index.html'),
    '<html><head><script type="module" src="./assets/m.js"></script>'
    + '<link rel="stylesheet" href="./assets/s.css"></head><body></body></html>');
  writeFileSync(resolve(tmpRoot, 'assets/m.js'), 'document.title="ok"');
  writeFileSync(resolve(tmpRoot, 'assets/s.css'), '#a{color:red}');

  const realRead = (abs) => (existsSync(abs) ? readFileSync(abs, 'utf8') : null);
  const html0 = readFileSync(resolve(tmpRoot, 'index.html'), 'utf8');
  t('磁盘样本内联前不是单文件', checkSingleFile(html0).ok === false);
  const r = inlineHtml(html0, { dir: tmpRoot, readFile: realRead });
  t('磁盘样本内联了 2 项', r.inlined.length === 2, `实际 ${r.inlined.length}`);
  const chk = checkSingleFile(r.html);
  t('磁盘样本内联后是单文件', chk.ok,
    JSON.stringify([...chk.remaining.map((x) => x.url), ...chk.warnings.map((x) => x.url)]));
  diskDone = true;
} catch (e) {
  t('真磁盘用例跑通', false, e.message);
} finally {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
t('真磁盘用例确实执行了（防止整节空跑）', diskDone);

/* ============================================================
   7. 真实产物抽样：只作告知（形态随上次构建模式变，不钉死）
   ============================================================ */
const realDir = resolve(dirname(new URL(import.meta.url).pathname), 'runtime-plugins');
const candidates = ['demo-react', 'color-picker', 'dupview', 'icon-picker'];
let sampled = 0, allNotSingle = true;
for (const id of candidates) {
  const p = resolve(realDir, id, 'index.html');
  if (!existsSync(p)) continue;
  sampled++;
  const chk = checkSingleFile(readFileSync(p, 'utf8'));
  if (chk.ok) allNotSingle = false;
}
if (sampled === 0) {
  info('未找到现网产物，跳过抽样', 'runtime-plugins 下无可用 index.html');
} else {
  /*
   * ⛔ 这里**不能**断言产物是单文件还是非单文件 —— 那取决于上次用什么模式构建
   * （`build-plugins.mjs` 加不加 `--single-file`），不是代码对错。
   * 原写法钉的是「均为非单文件」这个**当时的现状**，
   * 于是 2026-11-02 全量 `--single-file` 构建之后它立刻变红 ——
   * 而那次变红不代表任何缺陷，只是构建模式换了。
   *
   * 所以状态只作告知；「扫描器不是空转」由下面 `抽样数量大于 0` 守住
   * （扫不到任何产物时那一条会红）。
   */
  info(`现网 ${sampled} 个产物抽样：${allNotSingle ? '均为非单文件' : '均为单文件'}`,
    '随上次构建模式变化，只作告知');
  t('抽样数量大于 0', sampled > 0, `${sampled}`);
}

/* ============================================================
   8. 元断言：判据不得恒真
   ============================================================ */
t('元断言：findExternalRefs 对空串返回空（不是恒非空）',
  findExternalRefs('').length === 0);
t('元断言：checkSingleFile 对空串 ok（不是恒假）',
  checkSingleFile('').ok === true);
t('元断言：inlineHtml 对无引用 html 原样返回（不是必然改动）',
  inlineHtml('<html></html>', { dir: '/o', readFile: () => null }).html === '<html></html>');
t('元断言：classifyUrl 不会把空串判成 relative',
  classifyUrl('') !== 'relative');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skip} 项，告知 ${note} 条`);
process.exit(fail ? 1 : 0);
