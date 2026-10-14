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
import { readFileSync, existsSync } from 'node:fs';
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

failWrite = true;
tm.saveCustomColors('accent', ['#123456']);
is('saveCustomColors 写不进去 → 取得到', tm.takePersistError() instanceof Error, 'saveCustomColors 没走统一判据');

/* 成功要能把上一次的失败清掉 —— 否则一次失败之后永远报红 */
failWrite = true;
tm.setAccent('#111111');
failWrite = false;
tm.setAccent('#222222');
is('成功会把上一次的失败清掉', tm.takePersistError() === null, '写成功之后仍在报上一次的失败');

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

/* ---------------- 汇总 ---------------- */
console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('\n失败明细：');
  fails.forEach((f) => console.log('  · ' + f));
  process.exitCode = 1;
}
