/**
 * 右上角按钮 / 插件顺序：写入失败必须如实回答 测试
 * ============================================================
 * 存不下不是假设：设置页在 Vite 模式下是隔离 iframe（opaque origin），
 * localStorage 不可用 —— js/host.js、js/plugin-sdk.js 里同一段都有说明。
 *
 * 早先 `writeArr` 是 `catch { /* ignore *\/ }` 之后照常往下走，于是调用方
 * **没有任何办法知道**这次改动有没有落盘，只能无条件报成功。而
 * `notifyToolbarChanged()` 照发，界面**立刻**就有变化：
 *
 *   ① 点「加入」    → 右上角立刻多一个按钮、提示"已加到右上角"
 *                    → 重启后按钮不见了
 *   ② 点「隐藏」    → 右上角立刻少一个按钮（没有成功提示，唯一反馈就是它）
 *                    → 重启后按钮又回来了
 *   ③ 拖侧边栏排序  → 侧边栏立刻重排、提示"已保存插件顺序"
 *                    → 重启后顺序回到原样
 *
 * 三处共同点：**界面立刻变化，所以用户看不出差别**，直到下次重启才发现
 * 白忙一场；而提示里写着"已保存"，他就不会再去确认一次。
 *
 * 运行：node toolbar-persist-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const SRC = {
  tb: read('js/toolbar-plugin.js'),
  host: read('js/host.js'),
  hostD: read('js/host.d.ts'),
  setApp: read('plugins/settings/App.tsx'),
  setIdx: read('plugins/settings/index.js'),
};

/** 剥 /* *\/ 与 // 注释：注释里提到同名关键字会让"存在性"判定变成恒真。 */
function stripComments(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '/' && n === '/') {
      const j = s.indexOf('\n', i);
      i = j < 0 ? s.length : j;
      continue;
    }
    if (c === '/' && n === '*') {
      const j = s.indexOf('*/', i + 2);
      i = j < 0 ? s.length : j + 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}
const code = (k) => stripComments(SRC[k]);

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

/* ============================================================
 * 第 1 节：真模块跑真身（localStorage 可控抛错）
 * ============================================================ */

/** 可控的 localStorage：fail=true 时 setItem 抛（模拟隔离态 / 配额满） */
function makeStorage() {
  const st = new Map();
  return {
    _fail: false,
    _st: st,
    getItem: (k) => (st.has(k) ? st.get(k) : null),
    setItem(k, v) { if (this._fail) throw new Error('QuotaExceeded'); st.set(k, v); },
    removeItem(k) { if (this._fail) throw new Error('QuotaExceeded'); st.delete(k); },
  };
}

const store = makeStorage();
globalThis.localStorage = store;
globalThis.document = { dispatchEvent() { return true; } };
globalThis.window = { parent: { document: { dispatchEvent() { return true; } } } };
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class { constructor(n) { this.type = n; } };
}

const tb = await import(pathToFileURL(join(ROOT, 'js/toolbar-plugin.js')).href);

const ID = 'demo-app';
store._fail = false;
tb.resetToolbar();

/* --- 存得下时：如实回答 true，且真写进去了 --- */
t('写成功：addExtra 返回 true', tb.addExtra(ID) === true);
t('写成功：addExtra 真落盘（extraIds 读得回来）', tb.extraIds().includes(ID));
t('写成功：removeExtra 返回 true', tb.removeExtra(ID) === true);
t('写成功：removeExtra 真落盘', !tb.extraIds().includes(ID));

t('写成功：setHidden(true) 返回 true', tb.setHidden('e1', true) === true);
t('写成功：setHidden 真落盘', tb.hiddenIds().includes('e1'));
t('写成功：toggleHidden 返回 true', tb.toggleHidden('e1') === true);
t('写成功：toggleHidden 真的翻过来', !tb.hiddenIds().includes('e1'));

/* --- 存不下时：必须返回 false，而不是静默成功 --- */
store._fail = true;
t('写失败：addExtra 返回 false（不是静默成功）★', tb.addExtra(ID) === false);
t('写失败：setHidden 返回 false ★', tb.setHidden('e2', true) === false);
t('写失败：toggleHidden 返回 false ★', tb.toggleHidden('e2') === false);
t('写失败：removeExtra 返回 false ★', tb.removeExtra(ID) === false);
store._fail = false;

/*
 * 关键：写失败时通知**照发**（界面立刻变样）—— 这正是"看不出差别"的
 * 成因，也是界面必须报错而不是靠观察界面变化的理由。
 */
t('写失败时通知仍照发（界面会立刻变样，所以必须报错）★',
  /notifyToolbarChanged\(\);/.test(code('tb')));

/* ============================================================
 * 第 2 节：moveEntry / moveEntryTo 切片跑真身
 *   这两个要 defs 里有入口才走得动，而 defs 只在 loadToolbarPlugins
 *   里填 —— 为了不牵出整条加载链，这里把函数体切出来、注入桩实跑。
 * ============================================================ */
function sliceFn(src, name, exported = true) {
  const i = src.indexOf(`${exported ? 'export ' : ''}function ${name}(`);
  if (i < 0) return '';
  let j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return '';
}
const TB = code('tb');
const plain = (s) => s.replace(/^export /, '');
const fnMove = plain(sliceFn(TB, 'moveEntry'));
const fnMoveTo = plain(sliceFn(TB, 'moveEntryTo'));
const fnWrite = plain(sliceFn(TB, 'writeArr', false));

t('自检：moveEntry / moveEntryTo / writeArr 都切到了（不是空串）',
  fnMove.length > 80 && fnMoveTo.length > 80 && fnWrite.length > 30);

/*
 * 桩只有两样：可控抛错的 localStorage（与第 1 节同一口径）和 fixed 的
 * orderedIds；函数体本身是从源码切出来的原样代码。
 */
function build() {
  const src = `
const ORDER_KEY = 'nexus:toolbar-order';
let FAIL = false;
let stored = null;
const base = ['a', 'b', 'c'];
const localStorage = { setItem(k, v) { if (FAIL) throw new Error('x'); stored = v; } };
function writeArr(key, arr) {
  try { localStorage.setItem(key, JSON.stringify(arr)); return true; }
  catch { return false; }
}
/* 与 sortIds 同形：先按存过的顺序，没存过的保持原序 */
function orderedIds() {
  const saved = stored ? JSON.parse(stored) : [];
  const out = saved.filter((x) => base.includes(x));
  for (const k of base) if (!out.includes(k)) out.push(k);
  return out;
}
let notified = 0;
function notifyToolbarChanged() { notified++; }
${fnMove}
${fnMoveTo}
return { moveEntry, moveEntryTo, setFail(v) { FAIL = v; },
         get order() { return orderedIds(); }, get notified() { return notified; } };
`;
  return new Function(src)();
}
{
  const H = build();
  H.setFail(false);
  t('moveEntry 成功：返回 true', H.moveEntry('a', 1) === true);
  t('moveEntry 成功：顺序真变了', H.order.join() === 'b,a,c');
  t('moveEntry 成功：发了通知', H.notified === 1);
  H.setFail(true);
  const before = H.order.join();
  t('moveEntry 存不下：返回 false（早先无条件 true）★', H.moveEntry('a', 1) === false);
  t('moveEntry 存不下：顺序真的没变（重启后回到原样）★', H.order.join() === before);
  t('moveEntry 存不下：发了通知（界面会变样，必须报错）★', H.notified === 2);
}
{
  const H = build();
  H.setFail(false);
  t('moveEntry 越界：返回 false（没移动）', H.moveEntry('c', 1) === false);
  t('moveEntry 越界：不改顺序', H.order.join() === 'a,b,c');
}
{
  const H = build();
  H.setFail(false);
  t('moveEntryTo 成功：返回 true', H.moveEntryTo('a', 2) === true);
  t('moveEntryTo 成功：顺序真变了', H.order.join() === 'b,c,a');
  H.setFail(true);
  t('moveEntryTo 存不下：返回 false（早先无条件 true）★', H.moveEntryTo('a', 0) === false);
}
{
  const H = build();
  H.setFail(false);
  t('moveEntryTo 原位：返回 false（没移动，不算生效）', H.moveEntryTo('a', 0) === false);
}

/* ============================================================
 * 第 3 节：提示文案只有一份，且两版设置页都用同一句
 * ============================================================ */
t('唯一判据：导出 TOOLBAR_NOT_SAVED（各写一份迟早在某处漏掉）',
  /export const TOOLBAR_NOT_SAVED/.test(TB));
t('提示说清"重启后会回到原来的样子"（否则用户不知道要重设）★',
  /重启后会回到原来的样子/.test(SRC.tb));
t('无构建版：引用 TOOLBAR_NOT_SAVED', code('setIdx').includes('TOOLBAR_NOT_SAVED'));
t('React 版：引用 TOOLBAR_NOT_SAVED', code('setApp').includes('TOOLBAR_NOT_SAVED'));

t('无构建版：「加入」按落盘结果决定文案与类型 ★',
  /const ok = addExtra\(p\.id\)/.test(code('setIdx'))
  && /ok \? `已把/.test(code('setIdx')) && /ok \? 'ok' : 'err'/.test(code('setIdx')));
t('无构建版：「取消加入」按落盘结果决定文案与类型 ★',
  /const ok = removeExtra\(p\.id\)/.test(code('setIdx'))
  && /已把「\$?\{p\.name \|\| p\.id\}」移出右上角/.test(code('setIdx')));
t('无构建版：「隐藏 / 展示」存不下时报错 ★',
  (code('setIdx').match(/if \(!toggleHidden\(e\.id\)\) ctx\.toast\(TOOLBAR_NOT_SAVED, 'err'\)/g) || []).length === 2);

t('React 版：「加入」按落盘结果决定文案与类型 ★',
  /const ok = addExtra\(p\.id\)/.test(code('setApp')) && /ok \? 'ok' : 'err'/.test(code('setApp')));
t('React 版：「取消加入」按落盘结果决定文案与类型 ★',
  /const ok = removeExtra\(p\.id\)/.test(code('setApp')));
t('React 版：「隐藏 / 展示」存不下时报错 ★',
  (code('setApp').match(/if \(!toggleHidden\(e\.id\)\) ctx\?\.toast\?\.\(TOOLBAR_NOT_SAVED, 'err'\)/g) || []).length === 2);

/* ============================================================
 * 第 4 节：插件顺序（侧边栏拖拽）走落盘版
 * ============================================================ */
t('host.js：新增 savePluginOrder 并回 { saved } ★',
  /export function savePluginOrder\(ids\)/.test(code('host')) && /return \{ saved \}/.test(code('host')));
t('host.js：savePluginOrder 失败处置 false（不是静默）★',
  /catch \{\s*\n\s*saved = false;/.test(code('host')));
t('host.js：setPluginOrder 保留 void 旧形状（对外契约不改）',
  /export function setPluginOrder\(ids\)/.test(code('host')));
t('host.d.ts：两个声明都在，且写明"要报已保存的用 savePluginOrder"',
  /setPluginOrder\(ids: string\[\]\): void/.test(SRC.hostD)
  && /savePluginOrder\(ids: string\[\]\): \{ saved: boolean \}/.test(SRC.hostD));
t('React 版拖排序：改用 savePluginOrder（不是不回结果的旧版）★',
  /const \{ saved \} = savePluginOrder\(ids\)/.test(code('setApp')));
t('React 版拖排序：存不下时不说"已保存"，并说明会回到原顺序 ★',
  /saved \? '已保存插件顺序'/.test(code('setApp'))
  && /重启后会回到原来的顺序/.test(code('setApp')));

/* ============================================================
 * 第 5 节：自检 —— 判据没被写成恒真 / 没退化成 ignore
 * ============================================================ */
t('自检：writeArr 不再吞掉异常（无 `catch { /* ignore */ }` 包 setItem）★',
  !/catch \{ \/\* ignore \*\/ \};\s*\n\}/.test(code('tb').slice(code('tb').indexOf('function writeArr'))));
t('自检：writeArr 成功置 true、失败置 false 各一次',
  (TB.match(/return true;/g) || []).length >= 1 && (TB.match(/return false;/g) || []).length >= 1);
t('自检：五个写入口全部回"存没存成"（addExtra/removeExtra/setHidden/toggleHidden/moveEntry）★',
  ['addExtra', 'removeExtra', 'setHidden', 'toggleHidden', 'moveEntry', 'moveEntryTo']
    .every((n) => new RegExp(`export function ${n}\\([^)]*\\) \\{`).test(TB)
      && /return (saved|setHidden\(|toggleHidden\()/.test(sliceFn(TB, n, n !== 'writeArr'))));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
