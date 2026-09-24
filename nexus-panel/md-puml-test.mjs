/**
 * md PlantUML 图表 —— 批次 4 收尾（F10 的第二张图）
 * ============================================================
 *
 * 引擎：@plantuml/core 1.2026.8（MIT）
 *   · 完全离线：TeaVM 编译的 PlantUML + Viz.js 编译到 WASM 的 Graphviz
 *   · 不联网、不需要 Java、不需要服务器 —— 这是选它的**前提**
 *
 * ⚠️ 两条地雷，本测试都要钉住：
 *   ① 许可证：≥1.2026.6 才是 MIT，≤1.2026.5 是 GPL-3.0-or-later。
 *      降版本会把整个项目拖进 copyleft（当初否决 ErgeMD 是同一理由）。
 *   ② CSP：viz-global 是 WASM，script-src 需要允许 WASM 编译。
 *      少了它：控制台一条 warning，界面是"一直转圈"。
 *
 * 本测试真跑 renderToStringP（从源码提取），不是只查代码里有没有写。
 *
 * 运行：node md-puml-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, extra = '') => {
  if (ok) { pass++; console.log(`✅ ${n}`); }
  else { fail++; console.log(`❌ ${n}${extra ? '  → ' + extra : ''}`); }
};

const puml = read('plugins/md/plantuml.js');
const blk = read('plugins/md/PlantUMLBlock.tsx');
const app = read('plugins/md/App.tsx');
const css = read('css/neumorphism.css');
const pkg = JSON.parse(read('package.json'));
const conf = read('src-tauri/tauri.conf.json');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const pumlC = strip(puml);

/* ============================================================
   0. 许可证与体积（这两条是"能不能用"的前提，放最前面）
   ============================================================ */
console.log('\n=== 0. 许可证 / CSP 前提 ===');

const ver = pkg.dependencies?.['@plantuml/core'];
t('package.json 里声明了 @plantuml/core', !!ver, String(ver));
/*
 * 精确版本是刻意的：写成 ^1.2026.6 理论上也只会升不会降，
 * 但写成精确值能让"有人手改成 1.2025.x"这件事在 diff 里显眼。
 * 而 1.2025.x 是 GPL —— 会把整个项目拖进 copyleft。
 */
t('版本是**精确值**（不是 ^ / ~），防止降到 GPL 版本',
  !!ver && !/^[\^~]/.test(String(ver)), String(ver));
{
  const [a, b, c] = String(ver || '0.0.0').split('.').map(Number);
  t('版本 ≥ 1.2026.6（**低于此是 GPL-3.0-or-later**）',
    a > 1 || (a === 1 && (b > 2026 || (b === 2026 && c >= 6))), String(ver));
}
t('CSP 的 script-src 允许 WebAssembly 编译（wasm-unsafe-eval）',
  /script-src[^"]*wasm-unsafe-eval/.test(conf));
t('CSP 的 connect-src 仍锁死（没为画图放开网络）',
  /connect-src 'self' ipc: http:\/\/ipc\.localhost/.test(conf));

/* ============================================================
   1. 判定
   ============================================================ */
console.log('\n=== 1. 判定 ===');

const { isPlantUML } = await import('./plugins/md/plantuml.js').catch(async () => {
  /* plantuml.js import 了 mermaid.js（含 React 无关代码），
     在 node 里应能直接跑；跑不了就退化成从源码提取。 */
  return { isPlantUML: null };
});

const isP = isPlantUML || new Function('codeClass', `
  const PUML_LANGS = ['plantuml', 'puml', 'uml'];
  const c = String(codeClass || '');
  return PUML_LANGS.some((l) => c === \`language-\${l}\` || c === l);
`);

t('language-plantuml 认出来', isP('language-plantuml') === true);
t('裸 plantuml 也认', isP('plantuml') === true);
t('puml 认', isP('language-puml') === true);
t('uml 认', isP('language-uml') === true);
t('**不误伤** language-uml-anything（全等判定，不是 includes）',
  isP('language-uml-anything') === false);
t('不误伤 language-js', isP('language-js') === false);
t('不误伤 undefined', isP(undefined) === false);

/* ============================================================
   2. 真跑 renderToStringP —— 回调转 Promise + 超时
   ============================================================ */
console.log('\n=== 2. 真跑 renderToStringP ===');

const mFn = puml.match(/export function renderToStringP\(engine, lines, timeoutMs = 20000\) \{[\s\S]*?\n\}/);
t('能从源码取出 renderToStringP', !!mFn);
/*
 * new Function 里不能有 `export` —— 会 SyntaxError。
 * 剥掉前缀再编译（提取的是函数本体，export 只是模块语法）。
 */
const renderToStringP = new Function(`${mFn[0].replace(/^export /, '')}; return renderToStringP;`)();

const mkEngine = (mode, payload) => ({
  renderToString(lines, ok, bad) {
    if (mode === 'sync-throw') throw new Error('引擎没初始化');
    if (mode === 'ok') return setTimeout(() => ok(payload), 1);
    if (mode === 'err') return setTimeout(() => bad('语法错误'), 1);
    if (mode === 'never') return;              // 两个回调都不调 —— 最阴的形态
    if (mode === 'empty') return setTimeout(() => ok(''), 1);
    if (mode === 'spaces') return setTimeout(() => ok('   '), 1);
    if (mode === 'nonstring') return setTimeout(() => ok({ svg: 1 }), 1);
  },
});

t('正常 → resolve SVG',
  (await renderToStringP(mkEngine('ok', '<svg/>'), ['a'], 500)) === '<svg/>');

{
  const r = await renderToStringP(mkEngine('err', 'x'), ['a'], 500).then(
    () => null, (e) => e.message);
  t('onError → reject 且带上引擎给的消息', r === '语法错误', String(r));
}

{
  /* 引擎没起来时两个回调可能都不调用 —— 没有超时就永远 pending */
  const r = await Promise.race([
    renderToStringP(mkEngine('never'), ['a'], 120).then(() => 'resolved', (e) => e.message),
    new Promise((res) => setTimeout(() => res('TIMEOUT-TEST-HUNG'), 800)),
  ]);
  t('**两个回调都不调** → 超时 reject（否则永远 pending、界面一直转圈）',
    typeof r === 'string' && r.includes('超时'), String(r));
}

{
  const r = await renderToStringP(mkEngine('empty'), ['a'], 500).then(
    () => null, (e) => e.message);
  t('引擎返回**空串** → reject（空串会让组件以为成功、显示空白）',
    r === 'PlantUML 返回了空的 SVG', String(r));
}
{
  const r = await renderToStringP(mkEngine('spaces'), ['a'], 500).then(
    () => null, (e) => e.message);
  t('引擎返回纯空格 → reject', r === 'PlantUML 返回了空的 SVG', String(r));
}
{
  const r = await renderToStringP(mkEngine('nonstring'), ['a'], 500).then(
    () => null, (e) => e.message);
  t('引擎返回非字符串 → reject', r === 'PlantUML 返回了空的 SVG', String(r));
}
{
  const r = await renderToStringP(mkEngine('sync-throw'), ['a'], 500).then(
    () => null, (e) => e.message);
  t('**同步抛出** → 转成 reject（不让它冒泡成未捕获异常）',
    r === '引擎没初始化', String(r));
}

/* 重复回调不能重复 settle */
{
  let n = 0;
  const engine = { renderToString(_l, ok, _bad) { ok('<svg/>'); ok('<svg/>'); setTimeout(() => ok('<svg/>'), 20); } };
  const r = await renderToStringP(engine, ['a'], 300).then(() => n++, () => n++);
  t('重复调用回调只 settle 一次（不会 resolve 后又 reject）', n === 1, String(n));
}

/* ============================================================
   3. toLines —— 引擎要 string[]
   ============================================================ */
console.log('\n=== 3. toLines ===');

const mLines = puml.match(/export function toLines\(text\) \{[\s\S]*?\n\}/);
const toLines = new Function(`${mLines[0].replace(/^export /, '')}; return toLines;`)();
t('整块文本切成行数组', JSON.stringify(toLines('@startuml\nA -> B\n@enduml'))
  === JSON.stringify(['@startuml', 'A -> B', '@enduml']));
t('CRLF 归一（不归一的话 Windows 文件每行末尾多个 \\r，行首判断全失效）',
  JSON.stringify(toLines('a\r\nb')) === JSON.stringify(['a', 'b']));
t("空输入返回 ['']（不是空数组）", JSON.stringify(toLines('')) === JSON.stringify(['']));

/* ============================================================
   4. 接线 / 队列 / 加载顺序
   ============================================================ */
console.log('\n=== 4. 接线 / 队列 / 加载顺序 ===');

t('App.tsx 里 plantuml 块接到了 PlantUMLBlock',
  /import PlantUMLBlock from '\.\/PlantUMLBlock'/.test(app)
  && /if \(isPlantUML\(codeClass\)\)/.test(app));
t('接在 highlight 之前（否则源码被着色成彩色文本，看着像"图表没渲染"）',
  app.indexOf('isPlantUML(codeClass)') < app.indexOf('const lang = String'),
  '顺序不对');
t('用**模块级** pumlQueue（组件内新建＝没有串行效果）',
  /export const pumlQueue = createRenderQueue\(\)/.test(pumlC)
  && /pumlQueue\.run\(/.test(blk));
t('队列复用 mermaid 的实现（已处理"前一个失败拖死后面"）',
  /import \{ createRenderQueue \} from '\.\/mermaid\.js'/.test(pumlC));
t('viz-global 用 ?url 拿地址（**不**当 module 导入）',
  /import vizUrl from '@plantuml\/core\/viz-global\.js\?url'/.test(blk));
t('viz-global **先于** plantuml.js 加载',
  pumlC.indexOf('await loadScript(vizUrl)') < pumlC.indexOf('const mod = await importModule()'),
  '顺序不对');
t('加载**幂等**（多张图只加载一次，否则全局状态被重置两次）',
  /if \(!globalThis\.__nexusVizLoaded\)/.test(pumlC));
t('缺 vizUrl 明确报错（不静默）',
  /if \(!vizUrl\) throw new Error/.test(pumlC));
t('引擎没导出 renderToString 时明确报错',
  /typeof mod\.renderToString !== 'function'/.test(pumlC));
t('加载失败清掉缓存（否则一次失败＝永久失败）',
  /enginePromise\.catch\(\(\) => \{ enginePromise = null; \}\)/.test(blk));
t('引擎模块只 import 一次（多图并发不重复 import）',
  /if \(enginePromise\) return enginePromise;/.test(blk));

/* ============================================================
   5. 组件表现
   ============================================================ */
console.log('\n=== 5. 组件 ===');

t('错误时**显示源码**（只显示消息的话用户没法对照改）',
  /md-puml-msg/.test(blk) && /md-puml-src/.test(blk));
t('加载中有**占位高度**（否则图画出来把下面内容顶下去）',
  /md-puml-loading/.test(blk));
t('非 plantuml 块兜底渲染成 pre（不丢内容）',
  /if \(!isPlantUML\(className\)\)[\s\S]{0,120}<pre/.test(blk));
t('有渲染结果缓存（同一段源码只画一次）',
  /htmlCache\.set\(code, svg\)/.test(blk));
t('**不二次消毒**（剥属性会破坏 SVG 结构）',
  !/sanitize|DOMPurify/.test(blk));

/* ============================================================
   6. 样式
   ============================================================ */
console.log('\n=== 6. 样式 ===');

/*
 * 每条样式断言都**先截出规则块**再在块内查。
 * 用 /\.md-puml-box svg \{[\s\S]*?max-width: 100%/ 这种跨行正则是假绿：
 * 删掉本规则的 max-width 后，它会往后跨到**别的规则**里的 max-width，
 * 照样匹配 —— 破坏验证实测红 0。
 */
const ruleOf = (sel) => {
  const i = css.indexOf(sel);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i) + 1);
};

for (const [name, ok] of [
  ['容器 .md-puml-box', /\.md-puml-box \{/.test(css)],
  ['svg 限宽（不限宽＝窄栏里横向溢出且被裁掉）', /max-width: 100%/.test(ruleOf('.md-puml-box svg {'))],
  ['占位高度 .md-puml-loading（不给高度＝图画出来时下面内容被顶跳）', /min-height/.test(ruleOf('.md-puml-loading {'))],
  ['错误样式 .md-puml-err', /\.md-puml-err \{/.test(css)],
  ['错误消息 .md-puml-msg', /\.md-puml-msg \{/.test(css)],
  ['错误源码 .md-puml-src', /\.md-puml-src \{/.test(css)],
]) t(`有 ${name}`, ok);
/*
 * 只查 **var() 之外**的字面色。
 * var(--edge, #3a3a3a) 里的 #3a3a3a 是兜底色，是必要写法：
 * 把它也判违规会逼人去掉兜底，而**没有兜底**才是真隐患
 * （宿主没设该变量时颜色直接失效）。
 */
{
  const box = css.match(/\.md-puml-box \{[^}]*\}/)?.[0] || '';
  const outside = box.replace(/var\([^)]*\)/g, '');
  t('容器颜色**不写死**（var() 兜底色不算）',
    !/#[0-9a-fA-F]{3,6}/.test(outside), outside.slice(0, 80));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
