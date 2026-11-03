/**
 * 主题设置「说了保存其实没保存」
 * ============================================================
 * 要防的形状：写入静默失败 + 界面**无条件**报成功。
 *
 * js/theme-manager.js 里此前有二十来处
 *   `try { localStorage.setItem(...) } catch {}`
 * 写不进去时（配额、隐私模式、Vite 模式下设置页是隔离 iframe 拿不到存储）
 * 异常被吞掉；而调用方 plugins/settings/App.tsx **紧接着就 toast「已保存 /
 * 已应用 / 已恢复」**。界面当场确实变了（内存里已改、也已通知监听者重绘），
 * 于是用户看到「强调色：#xxx」就以为稳了 —— 重启后悄悄回到原来的配色，
 * 全程一句提示都没有，只会以为这功能不记事儿。
 *
 * 同文件里 setBgImage 是**判了但判不准**的那一半：它返回的是 resetOne()
 * 的结果（applied，恒为真），所以调用方 `if (!setBgImage(...))` 只判得出
 * 「主题不支持背景图」，**判不出没落盘** —— 于是照样 toast「背景图已应用」。
 * 一个文件里三种形状：没判、判不准、以及（setBgImage 之外）干脆静默。
 *
 * 修法：写入收进 writeLS / removeLS 一份判据，写完由调用方
 * takePersistError() 决定怎么说。落盘失败**不代表这次没生效**，
 * 所以提示用 warn（做成了但没记住）而不是 err（没做成）。
 *
 * 判据一律跑真身：真 import theme-manager.js，把 localStorage 换成
 * 会抛错的桩，看 takePersistError() 到底返不返回东西。不靠"源码里有没有
 * takePersistError 这几个字" —— 后者证明不了失败真能被取到。
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const read = (p) => readFileSync(pjoin(HERE, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
const fails = [];
const ok = (name) => { pass += 1; console.log('  ✓ ' + name); };
const bad = (name, msg) => { fails.push(name + ' — ' + msg); console.log('  ✗ ' + name + ' — ' + msg); };
const is = (name, cond, msg) => (cond ? ok(name) : bad(name, msg));

/* ---------------- 环境：jsdom + 可控抛错的 localStorage ---------------- */
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const store = new Map();
let failWrite = false;
const quotaErr = () => {
  const e = new Error('配额超出：设置页在隔离 iframe 里拿不到本地存储');
  e.name = 'QuotaExceededError';
  return e;
};
const lsStub = {
  getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
  setItem: (k, v) => {
    if (failWrite) throw quotaErr();
    store.set(String(k), String(v));
  },
  removeItem: (k) => {
    if (failWrite) throw quotaErr();
    store.delete(String(k));
  },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};
globalThis.localStorage = lsStub;
try { Object.defineProperty(dom.window, 'localStorage', { value: lsStub, configurable: true }); } catch {}

const tm = await import(new URL('js/theme-manager.js', import.meta.url).href);

/* ---------------- 第 1 节：源码形态 ---------------- */
console.log('\n[1] 写入判据只有一份');
const tmRaw = read('js/theme-manager.js');
const { stripComments } = await import(new URL('test-scan-utils.mjs', import.meta.url).href);
const tmCode = stripComments(tmRaw);

const nWrite = (tmCode.match(/\bwriteLS\s*\(/g) || []).length;
const nRemove = (tmCode.match(/\bremoveLS\s*\(/g) || []).length;
const nBareSet = (tmCode.match(/localStorage\.setItem\s*\(/g) || []).length;
const nBareDel = (tmCode.match(/localStorage\.removeItem\s*\(/g) || []).length;

is('writeLS 已定义', /function writeLS\s*\(/.test(tmCode), 'theme-manager.js 里没有 writeLS');
is('removeLS 已定义', /function removeLS\s*\(/.test(tmCode), 'theme-manager.js 里没有 removeLS');
is('takePersistError 已导出', /export function takePersistError\s*\(/.test(tmCode), '没有导出 takePersistError');
is('写入点都走了统一判据',
  nWrite >= 15 && nRemove >= 10,
  `writeLS 调用 ${nWrite} 处 / removeLS ${nRemove} 处，看着不像全量收口`);
is('没有绕开判据的裸写入',
  nBareSet <= 1 && nBareDel <= 1,
  `还剩裸 localStorage.setItem ${nBareSet} 处、removeItem ${nBareDel} 处（应只存在于 helper 内）`);

/* ---------------- 第 2 节：真身 —— 失败要能取到 ---------------- */
console.log('\n[2] 真身：写不进去时 takePersistError() 必须拿得到');

failWrite = false;
tm.setAccent('#ff0000');
is('落盘成功时取不到错误', tm.takePersistError() === null, '写入成功却报了错');

failWrite = true;
tm.setAccent('#00ff00');
const e1 = tm.takePersistError();
is('setAccent 写不进去 → 取得到', e1 instanceof Error, `取到的是 ${String(e1)}（不是异常）`);
is('取到的是真原因', !!e1 && /配额|Quota|存储/.test(String(e1?.message || e1)), `原因不明：${String(e1?.message || e1)}`);

is('取走后不串味', tm.takePersistError() === null, '取了一次还在，会污染下一个操作的判断');

failWrite = true;
tm.setEnvColor('#0000ff');
is('setEnvColor 写不进去 → 取得到', tm.takePersistError() instanceof Error, 'setEnvColor 没走统一判据');

failWrite = true;
tm.setStyleParam(tm.STYLE_PARAMS.glass[0].key, 50);
is('setStyleParam 写不进去 → 取得到', tm.takePersistError() instanceof Error, 'setStyleParam 没走统一判据');

failWrite = true;
tm.resetStyleParam(tm.STYLE_PARAMS.glass[0].key);
is('resetStyleParam 写不进去 → 取得到', tm.takePersistError() instanceof Error, 'resetStyleParam 没走统一判据');

/* 偏移「归零」：与拖动滑块是同一组控件、同一个落盘键。
   归零只是把值写成 0，写不进去的后果与拖滑块**完全一样** ——
   重启后偏移原样回来，界面却说「已归零」。 */
failWrite = true;
tm.resetHueShift();
is('resetHueShift 写不进去 → 取得到', tm.takePersistError() instanceof Error, 'resetHueShift 没走统一判据');
failWrite = true;
tm.resetLightShift();
is('resetLightShift 写不进去 → 取得到', tm.takePersistError() instanceof Error, 'resetLightShift 没走统一判据');

failWrite = true;
tm.saveCustomColors('accent', ['#123456']);
is('saveCustomColors 写不进去 → 取得到', tm.takePersistError() instanceof Error, 'saveCustomColors 没走统一判据');

/* 跨操作不串味：调用方**取走**本次失败之后，下一次成功不该再报上一次的。
   判据的语义是「自上次取走以来，任一写入失败」—— 设置页每个操作后都会经
   toastPersist / warnNotPersisted 取走，不存在「没取就做下一个操作」的正常路径。
   旧断言钉的是「没取走也会被下一次成功清掉」，那等于允许一个操作内**中间**
   那次失败被后面的成功抹掉 —— 正是下面第 7 节要防的形状，故改为取走后再验。 */
failWrite = true;
tm.setAccent('#111111');
is('先取走本次的失败', tm.takePersistError() instanceof Error, '本次失败没被记录');
failWrite = false;
tm.setAccent('#222222');
is('取走后成功不再串味', tm.takePersistError() === null, '取走之后仍在报上一次的失败');

/* ---------------- 第 3 节：setBgImage「判了但判不准」 ---------------- */
console.log('\n[3] setBgImage 的返回值判不出落盘失败');
/* 默认主题多半不带 --bg-image（supportsBgImage 为 false），
   先切到一个带背景图的主题，否则这一节根本验不到东西。 */
failWrite = false;
const bgTheme = tm.listThemes().find((t) => tm.supportsBgImage(t));
if (!bgTheme) {
  bad('setBgImage 前置条件', '内置主题里没有一个支持背景图，第 3 节无法在真身上验');
} else {
  tm.applyTheme(bgTheme.id);
  tm.takePersistError();
  failWrite = true;
  const r = tm.setBgImage('data:image/png;base64,AAAA');
  const e2 = tm.takePersistError();
  is('写不进去时它仍然返回真值（所以调用方 if(!…) 判不出来）',
    !!r, `返回了 ${String(r)}`);
  is('同一时刻 takePersistError() 确实有东西', e2 instanceof Error, '返回真值且没有错误 → 说明失败根本没被记录');

  failWrite = true;
  tm.setBgPreset('');
  is('setBgPreset 写不进去 → 取得到', tm.takePersistError() instanceof Error, 'setBgPreset 没走统一判据');
}

/* ---------------- 第 4 节：设置页不再无条件报成功 ---------------- */
console.log('\n[4] 设置页：改成先看落盘结果再说话');
const appCode = stripComments(read('plugins/settings/App.tsx'));

is('导入了 takePersistError', /takePersistError/.test(appCode), '设置页没导入落盘判据');
is('定义了 toastPersist', /const toastPersist\s*=/.test(appCode), '没有统一的成功/未记住说法');
is('定义了 warnNotPersisted', /const warnNotPersisted\s*=/.test(appCode), '没有「只在没落盘时说一句」的入口');

/* 光有这两个入口不够 —— 入口**里面**必须真去看落盘结果。
   否则把它改成无条件 ctx.toast(okMsg,'ok')，13 处调用点会一起退回谎报，
   而下面那几条"定义了"的检查照样全绿（这就是断言绿但没在把关）。 */
const helperBody = (name) => (appCode.match(new RegExp(`const ${name}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{([\\s\\S]*?)\\n  \\};`)) || [])[1] || '';
is('toastPersist 真在看落盘结果',
  /takePersistError\(\)/.test(helperBody('toastPersist')),
  'toastPersist 不调 takePersistError —— 所有走它的点都会无条件报成功');
is('warnNotPersisted 真在看落盘结果',
  /takePersistError\(\)/.test(helperBody('warnNotPersisted')),
  'warnNotPersisted 不调 takePersistError —— 滑块/收藏色改了存不下也不吭声');

const nToastPersist = (appCode.match(/\btoastPersist\s*\(/g) || []).length;
const nWarn = (appCode.match(/\bwarnNotPersisted\s*\(/g) || []).length;
is('会说话的入口都改了', nToastPersist >= 11, `toastPersist 只用了 ${nToastPersist} 处（应覆盖全部主题 toast 点）`);
is('静默入口也补了提示', nWarn >= 5, `warnNotPersisted 只用了 ${nWarn} 处`);

/* 关键：这几个曾经无条件 toast('ok') 的点，不再直接写 'ok' */
const stillOk = [
  ['切换主题', /applyTheme\(t\.id\);\s*ctx\.toast\(/],
  ['强调色', /setAccent\(c\);\s*ctx\.toast\(/],
  ['环境色', /setEnvColor\(c\);\s*ctx\.toast\(/],
  ['恢复强调色', /resetAccent\(\);\s*ctx\.toast\(/],
  ['恢复环境色', /resetEnvColor\(\);\s*ctx\.toast\(/],
  ['恢复风格参数', /resetStyleParam\(p\.key\);\s*ctx\.toast\(/],
  ['恢复背景', /resetBgImage\(\);\s*ctx\.toast\(/],
  ['背景图已应用', /ctx\.toast\('背景图已应用'/],
  /* 偏移「归零」按钮：与上面的滑块是**同一组控件**，滑块改值已经说了，
     归零那两条此前仍是裸 ctx.toast(…, 'ok') —— 写不进去时照样报「已归零」。 */
  ['归零色相', /resetHueShift\(\);\s*ctx\.toast\(/],
  ['归零明暗', /resetLightShift\(\);\s*ctx\.toast\(/],
];
for (const [label, re] of stillOk) {
  is(`「${label}」不再无条件报成功`, !re.test(appCode), `${label} 仍在直接 ctx.toast(…，'ok')`);
}

/* ---------------- 第 5 节：warn 这一档真的存在 ---------------- */
console.log('\n[5] warn 这一档：类型、渲染、样式三处都要有');
const sdkDts = read('js/plugin-sdk.d.ts');
const hostDts = read('js/host.d.ts');
const toastsTsx = read('src/components/Toasts.tsx');
const css = read('css/controls.css');

is('plugin-sdk.d.ts 认 warn', /toast\(msg: string, type\?:[^)]*'warn'/.test(sdkDts), '插件调 ctx.toast(msg,"warn") 会类型报错');
is('host.d.ts 认 warn', /'warn'/.test(hostDts), 'host.d.ts 的 toast 联合类型没有 warn');
is('Toasts.tsx 认 warn', /'warn'/.test(toastsTsx), 'React 壳的 ToastItem 没有 warn');
is('CSS 有 .warn 这条规则', /\.toast\.warn/.test(css), '提示条没有 warn 的颜色规则');

/* 原生壳把非 info 的 type 直接拼成类名 —— warn 才能落到 CSS 上 */
const shellCode = stripComments(read('js/shell.js'));
is('原生壳会把类型拼进类名',
  /'nx-toast toast'\s*\+\s*\(\s*type\s*===\s*'info'\s*\?\s*''\s*:\s*'\s*'\s*\+\s*type\s*\)/.test(shellCode),
  '原生壳不再把 type 拼成类名 → warn 显示不出来');

/* ---------------- 第 6 节：清理链路 + 相邻模块 ---------------- */
console.log('\n[6] 清理链路与相邻模块');

/* theme-manager 文件头注释记过一次事故：deleteCustomTheme 的 try 里有一行
   抛错被 catch {} 吞掉，清理从那行起**全部中断**（风格参数、偏移键一个没删），
   而界面照报「已删除」。这里钉住它不再复发。 */
failWrite = false;
const tmpTheme = tm.saveAsCustom('落盘测试主题');
tm.applyTheme(tmpTheme.id);
tm.setStyleParam(tm.STYLE_PARAMS.glass[0].key, 120, tmpTheme.id);
tm.takePersistError();
tm.deleteCustomTheme(tmpTheme.id);
const left = tm.getStyleParam(tm.STYLE_PARAMS.glass[0].key, tmpTheme.id);
is('删除自定义主题会连风格参数一起清掉',
  left === null,
  `还剩 ${String(left)} —— 清理被中断（界面却照报「已删除」）`);

const normPath = 'js/theme-normalizer.js';
if (existsSync(pjoin(HERE, normPath))) {
  const normCode = stripComments(read(normPath));
  const bare = (normCode.match(/localStorage\.(setItem|removeItem)\s*\(/g) || []).length;
  const uses = /\bwriteLS\b|\bremoveLS\b/.test(normCode);
  is('theme-normalizer 的写入走同一份判据',
    bare === 0 && uses,
    `还有 ${bare} 处裸写入${uses ? '' : '，且没用 writeLS/removeLS'} —— 同一件事两边各写一份会各改各的`);
}


/* ---------------- 第 7 节：一次操作写多个键 ---------------- */
console.log('\n[7] 一次操作写多个键：中间那次失败不许被后面的成功抹掉');

/* 「最近一次写入」这层判据有个盲区：applyTheme 一次写 6 个键，
   setAccent 经 applyTo 也会先写 3 个首屏防闪键。第一个键写失败、
   后面几个成功时，旧写法把错误清成 null —— 界面照样 toast「已应用」，
   而重启后只有那个键悄悄回到旧值（有的记住了、有的没记住，最难查）。

   桩支持两种投失败方式：failKey 精确投到某个键、failNext 只让**下一次**
   写入失败。后者用来造「中间失败、后续全成功」，不依赖对键名的猜测，
   也避免内层恰好也失败时把判据喂成假绿。 */
let failKey = null;
let failNext = false;
let writeCount = 0;
let failCount = 0;
const origSet = lsStub.setItem;
const origDel = lsStub.removeItem;
const guardWrite = (k, fn) => {
  writeCount += 1;
  if (String(k) === failKey || failNext) {
    failNext = false;
    failCount += 1;
    throw quotaErr();
  }
  return fn();
};
lsStub.setItem = (k, v) => guardWrite(k, () => origSet(k, v));
lsStub.removeItem = (k) => guardWrite(k, () => origDel(k));
const resetProbe = () => { failKey = null; failNext = false; writeCount = 0; failCount = 0; };

failWrite = false;
const other = tm.listThemes().find((x) => x.id !== tm.getCurrent()?.id) || tm.listThemes()[0];
resetProbe();
failKey = 'nexus:theme';
tm.applyTheme(other.id);
const batchErr = tm.takePersistError();
is('applyTheme 第一个键失败、后面成功 → 仍取得失败',
  batchErr instanceof Error,
  `取到 ${String(batchErr)} —— 中间失败被后面的成功抹掉了，界面会谎报「已应用」`);
is('磁盘上那个键确实没写进去（不是全成功）',
  store.get('nexus:theme') !== other.id,
  '前置条件不成立：nexus:theme 居然写成功了，这一节没验到东西');
is('失败原因还是真实原因',
  /配额|Quota|存储/.test(String(batchErr?.message || batchErr)),
  `原因不明：${String(batchErr?.message || batchErr)}`);
is('这一段是「中间失败 + 后面还有成功写入」',
  failCount >= 1 && writeCount > failCount,
  `失败 ${failCount} 次 / 共写 ${writeCount} 次 —— 不是中间失败的形状，判据会空跑`);

/* 偏移是两条键一组：只让第一次写失败、第二次成功，同样不许被抹掉。
   用 failNext 而不是猜键名（键按主题 id 派生，猜错就会全成功 → 假绿）。 */
resetProbe();
failNext = true;
tm.setThemeShift(30, 0);
is('setThemeShift 两键写入，中间失败仍取得到',
  tm.takePersistError() instanceof Error,
  '两组偏移键之间也会互相抹掉');
is('偏移这段确实只失败一次、后面还有写入',
  failCount === 1 && writeCount >= 2,
  `失败 ${failCount} 次 / 共写 ${writeCount} 次 —— 没造出「中间失败」`);

/* 静态守卫：所有会写入的导出函数都得先划边界，漏一个就漏一类操作。
   内部函数（applyTo / resetOne / clearShift …）不划，靠外层批次覆盖。 */
const tmSrc = stripComments(read('js/theme-manager.js'));
const fnHeads = [...tmSrc.matchAll(/(?:^|\n)(export\s+)?function\s+(\w+)\s*\(/g)];
const writers = [];
for (let i = 0; i < fnHeads.length; i++) {
  const m = fnHeads[i];
  if (!m[1] || m[2] === 'writeLS' || m[2] === 'removeLS' || m[2] === 'beginPersist') continue;
  const end = i + 1 < fnHeads.length ? fnHeads[i + 1].index : tmSrc.length;
  const body = tmSrc.slice(m.index, end);
  if (/\b(?:writeLS|removeLS)\s*\(/.test(body)) writers.push([m[2], body]);
}
is('存在会写入的导出函数（守卫范围非空）', writers.length >= 10,
  `只找到 ${writers.length} 个，扫描本身可能失效`);
const noBoundary = writers.filter(([, body]) => !/\bbeginPersist\s*\(/.test(body)).map(([n]) => n);
is('每个会写入的导出函数都调 beginPersist',
  noBoundary.length === 0,
  `漏了：${noBoundary.join(' / ')} —— 这个操作里中间失败仍会被抹掉`);
const beginBody = (tmSrc.match(/export function beginPersist\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
is('beginPersist 只在批次外清零（嵌套不重置）',
  /if\s*\(\s*persistDepth\s*===\s*0\s*\)/.test(beginBody),
  '嵌套调用会清掉外层已经记下的失败（resetColors → applyTheme）');

/* 嵌套的行为证据：resetColors 先删 4 个键，再调 applyTheme 写 6 个。
   只让**外层第一次**写入失败，内层全部成功。若内层边界无条件清零，
   外层那次失败就被抹掉 —— 界面照样报「已恢复」。 */
resetProbe();
failNext = true;
tm.resetColors();
is('嵌套调用不清掉外层已记下的失败',
  tm.takePersistError() instanceof Error,
  'resetColors → applyTheme 的边界把前半段的失败抹掉了（界面照样报「已恢复」）');
is('嵌套这段确实只失败一次、后面还有写入',
  failCount === 1 && writeCount > 1,
  `失败 ${failCount} 次 / 共写 ${writeCount} 次 —— 内层也失败了会喂出假绿`);

/* 反向验证：把 beginPersist 边界整段撤掉，同一场景必须重新变成「谎报」。
   不靠"源码里有没有这几个字"，而是造一份去掉边界的真模块跑一遍。 */
const probePath = pjoin(HERE, 'js', '_tm_no_batch_probe.js');
const noBatchSrc = read('js/theme-manager.js').replace(/^  beginPersist\(\);\n/gm, '');
writeFileSync(probePath, noBatchSrc);
try {
  const bad = await import(new URL('js/_tm_no_batch_probe.js', import.meta.url).href + '?v=' + Date.now());
  resetProbe();
  bad.takePersistError();
  failKey = 'nexus:theme';
  bad.applyTheme(other.id);
  is('撤掉边界后：中间失败被后面的成功抹掉（反向验证）',
    bad.takePersistError() === null,
    '反向验证没复现缺陷 —— 说明第 7 节的判据可能恒绿，没在把关');
} finally {
  unlinkSync(probePath);
}
resetProbe();

/* ---------------- 汇总 ---------------- */
console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('\n失败明细：');
  fails.forEach((f) => console.log('  · ' + f));
  process.exitCode = 1;
}
