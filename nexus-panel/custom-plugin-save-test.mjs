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
const getSrc = sliceFn(SRC.host, 'export function getCustomPlugins()');
/*
 * 键名常量从源码抽，不在这里抄一份：抄了就等于给"改键名"开了口子
 * —— 实现改了、测试还认旧串，判据会静默失明。
 */
const KEY_CUSTOM_PLUGINS = (SRC.host.match(/export const KEY_CUSTOM_PLUGINS = '([^']+)'/) || [])[1];

t('（前置）四个函数都切到了', takeSrc && msgSrc && saveSrc && getSrc);
t('（前置）键名常量抽到了', !!KEY_CUSTOM_PLUGINS, String(KEY_CUSTOM_PLUGINS));

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

const build = (ls) => new Function('localStorage', 'KEY_CUSTOM_PLUGINS', `
  /* 这两个是 host.js 的模块级状态，切片里没有，必须显式补上。
     名字与实现保持一致 —— 那边一改名，这里直接 ReferenceError，
     不会像"抄一份常量"那样静默失明。 */
  let lastCustomPluginWriteError = null;
  let lastCustomPluginReadError = null;
  ${getSrc.replace(/^export function/m, 'function')}
  ${takeSrc.replace(/^export function/m, 'function')}
  ${msgSrc.replace(/^export function/m, 'function')}
  ${saveSrc.replace(/^export function/m, 'function')}
  return { getCustomPlugins, saveCustomPlugins, takeCustomPluginWriteError, customPluginWriteFailMsg };
`)(ls, KEY_CUSTOM_PLUGINS);

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
  /*
   * 契约是 { ok, mcp } 而非裸 boolean：host.removePlugin 是 async，
   * 且要顺带把 MCP 网关的注销结局（cleaned / failed）透给调用方。
   * 判据跟着对象是刻意的 —— 钉 `return false` 会在契约改成对象后
   * 变成"实现明明改对了、测试却红"，把人往错的方向引。
   */
  t('removePlugin 没存下就 return { ok: false }', /if \(!ok\) return \{ ok: false \};/.test(seg));
  const anchor = 'if (!ok) return { ok: false };';
  t('（前置）失败返回锚点命中（锚点丢了下面那条会退化成恒真）',
    seg.indexOf(anchor) > 0);
  const before = seg.slice(0, seg.indexOf(anchor));
  t('没存下时不撤授权（避免留下"插件在、外链全被拦"的半截状态）',
    !/revokeAllGrants/.test(before));
  t('存下了才撤授权', /revokeAllGrants/.test(seg));
  t('removePlugin 返回成败', /return \{ ok: true/.test(seg));
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
  /* 同样是对象契约：必须先 await 再判 r?.ok。
     钉 `if (!host.removePlugin(id))` 会在 async 化后恒假 ——
     移除失败照样弹「已移除插件」，而这条断言却一直绿。 */
  t('原生壳：移除先看落盘结果', /const r = await host\.removePlugin\(id\)/.test(seg)
    && /if \(!r\?\.ok\)/.test(seg));
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

  /* host.removePlugin 自 412c7f59（卸载残留五路收口）起是 **async** 且返回
     { ok, mcp } —— Promise 永不等于 false，旧 `=== false` 判据已作废：
     存储不可用时它会谎报「已移除插件」，且 MCP 注销结局被彻底丢掉。
     这里改钉新契约：await 取值 + !r.ok 才判失败 + MCP 结局两条分支。 */
  const rmSeg = sliceFn(c, 'const r = await hostRef.current?.removePlugin(id)');
  t('（前置）React 移除分支切到了', !!rmSeg);
  t('React：移除走 await 新契约（{ok,mcp}，Promise 永不等于 false）',
    /const r = await hostRef\.current\?\.removePlugin\(id\)/.test(c)
    && !/removePlugin\(id\) === false/.test(c));
  t('React：连不上外壳（!r）→ 报 err 并 return',
    /pushToast\(/.test(rmSeg) && /'err'/.test(rmSeg) && /return/.test(rmSeg));
  t('React：没存下（!r.ok）→ 报 err 并 return',
    /if \(!r\.ok\)/.test(c));
  t('React：MCP 网关结局说清（cleaned / failed 各有一条 toast）',
    /r\.mcp\?\.status === 'cleaned'/.test(c) && /r\.mcp\?\.status === 'failed'/.test(c));
}

/* ================================================================
 * 第 5 节：读不出来时**不许**落盘
 * ------------------------------------------------------------
 * 三个调用点全是 read-modify-write（`getCustomPlugins()` 读出来 →
 * 改一下 → `saveCustomPlugins()` 存回）。读失败返回 []，[] 一经
 * 写回就把用户装过的插件**全清掉并落盘**，而界面照旧提示「已添加」。
 * 这份清单**没有备份**，覆盖即不可恢复。
 * ================================================================ */
{
  /* 损坏数据：存得进去，但 parse 不出来（真实成因：被别处写坏、
     旧版本格式不兼容……） */
  const ls = makeLS(false);
  ls._store.set(KEY_CUSTOM_PLUGINS, '{oops');
  const m = build(ls);

  const got = m.getCustomPlugins();
  t('读不出来 → 降级返回 []（读侧不能往外抛）', Array.isArray(got) && got.length === 0);
  t('读不出来 → 落盘被拒（返回 false）', m.saveCustomPlugins([{ id: 'custom-new' }]) === false);
  /* 这一条是本节的要害：**数据还在**。
     被覆盖的话，用户装过的插件就永久没了。 */
  t('读不出来 → 原数据**没被覆盖**',
    ls._store.get(KEY_CUSTOM_PLUGINS) === '{oops',
    `现在是 ${JSON.stringify(ls._store.get(KEY_CUSTOM_PLUGINS))}`);
  t('拒绝时原因说得清（不是空原因）',
    /读不出来/.test(m.takeCustomPluginWriteError() || ''));
  t('（静态）saveCustomPlugins 里确有这道闸',
    /if \(lastCustomPluginReadError\)/.test(saveSrc));
}

/* 反向：读**成功**时，空写入必须放行 ——
   否则"移除最后一个插件"会被这道闸误伤，变成删不掉。 */
{
  const ls = makeLS(false);
  ls._store.set(KEY_CUSTOM_PLUGINS, '[]');
  const m = build(ls);
  t('存的是空数组 → 属于读成功（不是读失败）', Array.isArray(m.getCustomPlugins()));
  t('读成功 → 存回空数组放行（删最后一个插件不被误伤）',
    m.saveCustomPlugins([]) === true);
}

/* 非数组同样算读不出来：'null' / '{}' 能 parse 成功，
   但后面的 .filter / 展开会崩，且一样是"存的东西不对"。 */
{
  const ls = makeLS(false);
  ls._store.set(KEY_CUSTOM_PLUGINS, '{"a":1}');
  const m = build(ls);
  m.getCustomPlugins();
  t('存的是对象（不是数组）→ 也判读失败并拒写',
    m.saveCustomPlugins([{ id: 'x' }]) === false);
}

/* 键名只认常量那一处。再写裸字面量，就是"两处各写一半"的开端：
   改了一处另一处不跟着变，读写的就不是同一个键，且不报错。 */
{
  const litCount = (code('host').match(/'nexus:custom-plugins'/g) || []).length;
  t('裸字面量只剩常量定义那一处（键名不许各写一份）', litCount === 1, `出现 ${litCount} 次`);
}

/* ================================================================
 * 汇总
 * ================================================================ */
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
