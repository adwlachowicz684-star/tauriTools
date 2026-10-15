/**
 * 自定义插件清单：四个「说了存/删其实没落盘」的入口 测试
 * ============================================================
 * `saveCustomPlugins()` 原先是无条件 `localStorage.setItem(...)`、
 * **什么都不返回**。写不进去时（配额满、隐私模式、Vite 模式下设置页是
 * 隔离 iframe 拿不到存储）它直接抛异常，而四个调用点全是
 * 「save → 紧接着 toast 已添加 / 已移除」：
 *
 *   ① 原生壳「添加」：异常把整个 async onclick 打断在半路 ——
 *      `mask.remove()` 没跑（**遮罩留在屏幕上，界面卡住**）、
 *      `toast('已添加')` 也没跑（**一句提示都没有**）。
 *      点了没反应、还退不出去，是最糟的一种。
 *   ② store 插件「移除」/「添加」：异常往上抛、没人接，静默失败。
 *   ③ React 壳 addPlugin / removePlugin：同上。
 *
 * 这与 theme-manager / fav-dirs / recent.js 是同一类问题，那里都已改成
 * 「落盘结果单独给出来」，这里漏了 —— 而它是最外层（宿主）的一处：
 * 存不下就等于这个插件根本没装，后面 navigate 过去必然落空。
 *
 * 运行：node custom-plugin-save-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripCommentsJs } from './test-scan-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const SRC = {
  host: read('js/host.js'),
  shell: read('js/shell.js'),
  store: read('plugins/store/index.js'),
  app: read('src/App.tsx'),
};

/* 剥注释：本轮踩过一次 —— Assert 直接匹配 `if (!saved) {` 时命中了
   说明注释里原样写的那串代码，"已删除"被判成"还存在"。 */
const code = (k) => stripCommentsJs(SRC[k]);

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

/** 从锚点起按大括号配平切出函数 / 块源码。 */
function sliceFn(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const start = src.indexOf('{', i + anchor.length - 1);
  if (start < 0) return '';
  let d = 0;
  for (let k = start; k < src.length; k++) {
    const c = src[k];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return '';
}

/* ================================================================
 * 第 1 节：判据跑真身（切片 + 注入会抛错的存储桩）
 * ================================================================ */
const takeSrc = sliceFn(SRC.host, 'export function takeCustomPluginWriteError()');
const msgSrc = sliceFn(SRC.host, 'export function customPluginWriteFailMsg(kind, name, err)');
const saveSrc = sliceFn(SRC.host, 'export function saveCustomPlugins(list)');

t('（前置）三个函数都切到了', takeSrc && msgSrc && saveSrc);

/** 造一个可切换"写入抛错"的存储桩。 */
function makeLS(throwOnSet) {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (throwOnSet) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      store.set(k, String(v));
    },
    _store: store,
  };
}

const build = (ls) => new Function('localStorage', `
  let lastCustomPluginWriteError = null;
  ${takeSrc.replace(/^export function/m, 'function')}
  ${msgSrc.replace(/^export function/m, 'function')}
  ${saveSrc.replace(/^export function/m, 'function')}
  return { saveCustomPlugins, takeCustomPluginWriteError, customPluginWriteFailMsg };
`)(ls);

{
  const ls = makeLS(false);
  const m = build(ls);
  const ok = m.saveCustomPlugins([{ id: 'custom-a', name: '日志查看器' }]);
  t('写进去 → 返回 true', ok === true);
  t('写进去 → take 为 null（没失败）', m.takeCustomPluginWriteError() === null);
  t('写进去 → 存储里真有这一条', /custom-a/.test(ls.getItem('nexus:custom-plugins') || ''));
}

{
  const ls = makeLS(true);
  const m = build(ls);
  const ok = m.saveCustomPlugins([{ id: 'custom-b' }]);
  t('写不进去 → 返回 false（不再抛异常打断调用方）', ok === false);
  const err = m.takeCustomPluginWriteError();
  t('写不进去 → take 给出真原因', typeof err === 'string' && /Quota/i.test(err));
  t('写不进去 → 原因取一次后清空（不会污染下一次）', m.takeCustomPluginWriteError() === null);
}

{
  /* 先失败、再成功：错误必须被清掉，否则下一次成功也会被误报成失败。 */
  const m = build(makeLS(true));
  m.saveCustomPlugins([{ id: 'x' }]);
  const m2 = build(makeLS(false));
  void m;
  const ok = m2.saveCustomPlugins([{ id: 'x' }]);
  t('同一模块内：失败后重写成功 → 返回 true 且错误清空',
    ok === true && m2.takeCustomPluginWriteError() === null);
}

{
  const m = build(makeLS(true));
  const add = m.customPluginWriteFailMsg('添加', '日志查看器', '配额已满');
  const rm = m.customPluginWriteFailMsg('移除', '', '配额已满');
  t('添加失败文案：不说「已添加」，且说清重启后不会出现',
    !/已添加/.test(add) && /添加失败/.test(add) && /重启后不会出现/.test(add));
  t('移除失败文案：后半句说「还会回来」（说反了会让人往错的方向找）',
    /移除失败/.test(rm) && /重启后它还会回来/.test(rm) && !/不会出现/.test(rm));
  t('文案带上名字（两处都失败时得分清是哪一条）',
    /日志查看器/.test(add));
}

/* ================================================================
 * 第 2 节：host.removePlugin —— 没存下就不撤授权
 * ================================================================ */
{
  const c = code('host');
  const seg = sliceFn(c, 'removePlugin(id) {');
  t('（前置）removePlugin 段切到了', !!seg);
  t('removePlugin 先看落盘结果', /const ok = saveCustomPlugins\(/.test(seg));
  t('removePlugin 没存下就 return false', /if \(!ok\) return false;/.test(seg));
  const before = seg.slice(0, seg.indexOf('if (!ok) return false;'));
  t('没存下时不撤授权（避免留下"插件在、外链全被拦"的半截状态）',
    !/revokeAllGrants/.test(before));
  t('存下了才撤授权', /revokeAllGrants/.test(seg));
  t('removePlugin 返回成败', /return true;/.test(seg));
}

/* ================================================================
 * 第 3 节：原生壳 —— 添加流程（遮罩卡住那处）
 * ================================================================ */
{
  const c = code('shell');
  const seg = sliceFn(c, "box.querySelector('#p-ok').onclick = async () => {");
  t('（前置）原生壳「添加」onclick 段切到了', !!seg);
  t('原生壳：先看落盘结果再说话', /const saved = saveCustomPlugins\(/.test(seg));
  const failSeg = sliceFn(seg, 'if (!saved) {');
  t('（前置）失败分支切到了', !!failSeg);
  t('原生壳：存不下 → 先收遮罩（否则界面卡在这一屏、还退不出去）',
    /mask\.remove\(\)/.test(failSeg));
  t('原生壳：存不下 → 报 err 且把真原因说出来',
    /customPluginWriteFailMsg\(/.test(failSeg) && /'err'/.test(failSeg));
  t('原生壳：存不下 → 不往下走（不 navigate 到一个没装上的插件）',
    /return/.test(failSeg) && !/navigate\(p\.id\)/.test(failSeg));
  t('原生壳：存下了才报「已添加」', /toast\(`已添加/.test(seg));
}

/* ================================================================
 * 第 4 节：原生壳 —— 移除流程
 * ================================================================ */
{
  const c = code('shell');
  const seg = sliceFn(c, 'window.__nexusRemovePlugin = async (id) => {');
  t('（前置）原生壳「移除」段切到了', !!seg);
  t('原生壳：移除先看落盘结果', /if \(!host\.removePlugin\(id\)\)/.test(seg));
  t('原生壳：移除失败 → 报 err 并 return（不照报「已移除」）',
    /customPluginWriteFailMsg\('移除'/.test(seg) && /return/.test(seg));
  t('原生壳：移除成功才报「已移除插件」', /toast\('已移除插件', 'ok'\)/.test(seg));
}

/* ================================================================
 * 第 5 节：store 插件面板 —— 移除 / 添加
 * ================================================================ */
{
  const c = code('store');
  const rmSeg = sliceFn(c, 'if (!saveCustomPlugins(next)) {');
  t('（前置）store 移除分支切到了', !!rmSeg);
  t('store：移除没存下 → 报 err 并 return（不刷新、不报已移除）',
    /ctx\.toast\?\.\(/.test(rmSeg) && /'err'/.test(rmSeg) && /return/.test(rmSeg) && !/refreshShell/.test(rmSeg));

  const addSeg = sliceFn(c, 'if (!saveCustomPlugins([...getCustomPlugins(), item])) {');
  t('（前置）store 添加分支切到了', !!addSeg);
  t('store：添加没存下 → 报 err 并 return（不照报「已添加」）',
    /ctx\.toast\?\.\(/.test(addSeg) && /'err'/.test(addSeg) && /return/.test(addSeg) && !/已添加/.test(addSeg));
  /*
   * 守卫必须在 try **之外**：写在里面就成了
   * 「try { if (!save) return; await refreshShell() }」—— 一样能挡住，
   * 但外面那句 `try/catch` 是给 refreshShell 用的，守卫混进去之后
   * 以后有人改异常路径会一起改到它。
   *
   * 取法注意：不能拿 `c.indexOf('await refreshShell')` 直接比 ——
   * 文件里**移除**分支更早出现同一句，比出来的是它，断言会失真。
   * 必须从守卫自身那一行往后看。
   */
  const guardAt = c.indexOf('if (!saveCustomPlugins([...getCustomPlugins(), item]))');
  const afterGuard = guardAt >= 0 ? c.slice(guardAt, guardAt + 600) : '';
  const ti = afterGuard.indexOf('try {');
  const ri = afterGuard.indexOf('refreshShell');
  t('store：守卫写在 try 之外（混进 try 里会跟着异常路径一起被改）',
    ti >= 0 && ri > ti);
}

/* ================================================================
 * 第 6 节：React 壳 —— addPlugin / removePlugin
 * ================================================================ */
{
  const c = code('app');
  const addSeg = sliceFn(c, 'if (!saveCustomPlugins([...getCustomPlugins(), item])) {');
  t('（前置）React 添加分支切到了', !!addSeg);
  t('React：添加没存下 → 报 err', /pushToast\(/.test(addSeg) && /'err'/.test(addSeg));
  t('React：添加没存下 → 也把对话框收掉（界面不能停在那一屏）',
    /setDialogOpen\(false\)/.test(addSeg) && /return/.test(addSeg));
  t('React：添加成功才报「已添加」', /已添加/.test(c));

  const rmSeg = sliceFn(c, 'if (hostRef.current?.removePlugin(id) === false) {');
  t('（前置）React 移除分支切到了', !!rmSeg);
  t('React：移除用 === false（hostRef 没挂上时是 undefined，不该被当成失败）',
    /=== false/.test(c));
  t('React：移除没存下 → 报 err 并 return', /pushToast\(/.test(rmSeg) && /'err'/.test(rmSeg) && /return/.test(rmSeg));
}

/* ================================================================
 * 汇总
 * ================================================================ */
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
