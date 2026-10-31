/**
 * task-board 界面守卫：输入法 + 未捕获 rejection
 * ============================================================
 * 运行：node task-board-ui-guard-test.mjs
 *
 * 背景：task-board 是本轮新同步进来的插件（看板 + HTTP API + MCP 端点），
 * 此前没被任何守卫扫过。它的两处静默失败形状，和本项目已经修过的
 * 几处是同一类，只是发生在新代码里：
 *
 *   ① **备注框回车没有输入法守卫**（ime-guard 兜底扫描已报红）
 *      中文输入时回车是「把候选词上屏」，不是「提交备注」。而这里回车
 *      直接 `onComment(note)` → 落盘 tasks.json。于是打一半的拼音被当成
 *      一条备注写进去，历史里多一条谁也看不懂的记录，**不报错**。
 *
 *   ② **「＋新建 → 创建」没有接住异常**
 *      `onCreate={async (draft) => { await S.createTask(...) ... }}` 一旦
 *      createTask 拒绝（写盘失败 / 目录未授权 / 乐观锁三次冲突），就是未捕获
 *      rejection：`setNewOpen(false)` 不执行 → **弹窗不关、不报错、任务没建成**，
 *      用户点了没反应，只会以为按钮坏了。而同一个文件里 `withErr` 就在旁边，
 *      其余动作（流转 / 认领 / 备注 / 删除）全走了它，唯独新建没走。
 *
 *   ③ 设置页「用默认」按钮 `onClick={async ...}` 无 catch → 取不到默认目录
 *      时静默无反应。
 *   ④ 设置页初始化 `loadConfig` 抛错无 catch → 界面**永远停在「加载中…」**。
 *
 * 本测试跑真身：从 .tsx 源码切出真实的处理块，注入桩后**实跑**，
 * 不是"看源码里有没有那几个字"。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { isComposing } from './js/ime.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

/* 未捕获 rejection 兜底：本项目反复栽在"反向验证时脚本崩在半路，
   后面十几条断言一条没跑，报告上看着只红几条"。这里把它变成一条可见失败。 */
process.on('unhandledRejection', (e) => {
  fail++;
  console.log(`❌ 未捕获 rejection（有分支没接住异常，界面会彻底没反应）★ — ${String(e?.message || e)}`);
});

/** 真跑一个可能拒绝的调用，把拒绝变成返回值而不是把脚本崩掉 */
async function awaitSafe(p) {
  try { await p; return null; } catch (e) { return e; }
}

let pass = 0;
let fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 括号配平：s[i] 必须是 '{'，返回匹配的 '}' 下标 */
function matchBrace(s, i) {
  let d = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (d === 0) return k; }
  }
  return -1;
}

/** JSX 属性 `xxx={` 的整个表达式（不含外层大括号） */
function attrExpr(src, marker) {
  const h = src.indexOf(marker);
  if (h < 0) return '';
  const open = h + marker.length - 1;
  const close = matchBrace(src, open);
  if (close < 0) return '';
  return src.slice(open + 1, close);
}

/** marker **必须以 '{' 结尾**：取这一对大括号的块体（不含大括号本身） */
function innerBrace(src, marker) {
  const h = src.indexOf(marker);
  if (h < 0) return '';
  const open = h + marker.length - 1;
  const close = matchBrace(src, open);
  if (close < 0) return '';
  return src.slice(open + 1, close);
}

/**
 * 取**满足条件**的那个块，而不是第一个。
 * ⛔ 直接取第一个会漂：上游在备注框之前又加了 onKeyDown，
 *    第一个匹配变成了别的输入框，切出来的块里压根没有 onComment ——
 *    于是"组合中不提交"看着是绿的，验的却是另一段代码。
 */
function innerBraceWhere(src, marker, pred) {
  let i = src.indexOf(marker);
  while (i >= 0) {
    const open = i + marker.length - 1;
    const close = matchBrace(src, open);
    if (close >= 0) {
      const body = src.slice(open + 1, close);
      if (pred(body)) return body;
    }
    i = src.indexOf(marker, i + 1);
  }
  return '';
}

function count(src, needle) {
  let n = 0, i = 0;
  for (;;) { const k = src.indexOf(needle, i); if (k < 0) break; n++; i = k + needle.length; }
  return n;
}

/** TS/TSX 片段转 JS（带泛型调用的片段必须转译，否则 new Function 语法错） */
function transpile(code, fn = 'snippet.tsx') {
  return ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.Preserve },
    fileName: fn,
  }).outputText;
}

const appSrc = rd('plugins/task-board/App.tsx');
const setSrc = rd('plugins/task-board/Settings.tsx');

/* ── 1. js/ime.js 真身（判据本身）───────────────────────────── */
console.log('\n=== 1. 输入法判据真身 ===');
{
  t('组合中（isComposing=true）→ true', isComposing({ isComposing: true }) === true);
  t('组合中（keyCode=229）→ true', isComposing({ keyCode: 229 }) === true);
  t('非组合（Enter）→ false', isComposing({ isComposing: false, keyCode: 13 }) === false);
  t('传 null → false（不抛）', isComposing(null) === false);
}

/* ── 2. 备注框 onKeyDown：真身实跑 ──────────────────────────── */
console.log('\n=== 2. 备注框回车（真身实跑）===');
/*
  ⛔ 取**满足条件**的那个块，不是第一个：上游在备注框之前又加了别的
  onKeyDown（带 setEditing 的那个），第一个匹配变成了它 ——
  切出来的块里没有 onComment，于是"组合中不提交"看着是绿的，
  验的其实是另一段代码（本轮实测：长度 221，且崩在 setEditing 未定义）。
*/
const kdBody = innerBraceWhere(appSrc, 'onKeyDown={(e) => {', (b) => b.includes('onComment'));
t('（前置）切到了备注框的 keydown 块', kdBody.includes('onComment') && kdBody.includes("'Enter'"), `长度 ${kdBody.length}`);
{
  let called = null;
  let cleared = 0;
  const run = (evt, note) => {
    called = null;
    cleared = 0;
    // eslint-disable-next-line no-new-func
    // ⛔ 必须转译：上游这段现在是 `(e.target as HTMLInputElement).blur()`，
    //    带 TS 断言直接塞给 new Function 会 SyntaxError，整份测试崩在半路。
    const fn = new Function('e', 'isComposing', 'note', 'onComment', 'setNote', transpile(kdBody));
    /*
      ⛔ 补上 target（防御）：别处那几个 onKeyDown 里有
      `(e.target as HTMLInputElement).blur()`。一旦定位漂过去（见上面的
      innerBraceWhere），桩里没有 target 就会抛 "Cannot read properties of
      undefined"，整份测试崩在半路 —— 崩掉的脚本一条断言都跑不到，
      在报告上只显示"崩了"，看不出底下压着多少条没验。
    */
    const e = Object.assign({ target: { blur() {} } }, evt);
    fn(e, isComposing, note, (v) => { called = v; }, () => { cleared++; });
    return { called, cleared };
  };
  const a = run({ key: 'Enter', nativeEvent: { isComposing: true } }, 'wo');
  t('组合中按回车 → 不提交（拼音不会落盘）★', a.called === null, `实际 ${JSON.stringify(a.called)}`);
  t('组合中按回车 → 输入框不清空', a.cleared === 0);

  const b = run({ key: 'Enter', nativeEvent: { keyCode: 229 } }, 'wo');
  t('keyCode=229（IME 吃掉按键）→ 不提交', b.called === null, `实际 ${JSON.stringify(b.called)}`);

  const c = run({ key: 'Enter', nativeEvent: { isComposing: false } }, '已修好');
  t('非组合按回车 → 提交', c.called === '已修好', `实际 ${JSON.stringify(c.called)}`);
  t('非组合按回车 → 提交后清空', c.cleared === 1);

  const d = run({ key: 'Enter', nativeEvent: { isComposing: false } }, '   ');
  t('非组合 + 空白 → 不提交', d.called === null);

  const e2 = run({ key: 'Escape', nativeEvent: { isComposing: false } }, 'x');
  t('按 Escape → 不提交', e2.called === null);
  // 两端先判存在：indexOf 取不到时是 -1，-1 < 任何下标都成立 ——
  // 那样"守卫根本没装"也会被判成"装了且在前面"（顺序断言的经典空跑）。
  const gi = kdBody.indexOf('isComposing');
  const ei = kdBody.indexOf("'Enter'");
  t('守卫写在 Enter 分支之前（否则等于没装）',
    gi >= 0 && ei >= 0 && gi < ei, `isComposing@${gi} Enter@${ei}`);
}
t('App.tsx 真的 import 了 js/ime.js（不是照抄一份判据）',
  /import\s*\{\s*isComposing\s*\}\s*from\s*'\.\.\/\.\.\/js\/ime\.js'/.test(appSrc));

/* ── 3. 新建任务 onCreate：withErr 真身 + 回调真身 ──────────── */
console.log('\n=== 3. 新建任务「创建」（真身实跑）===');
const weExpr = (() => {
  const h = appSrc.indexOf('const withErr =');
  if (h < 0) return '';
  const open = appSrc.indexOf('{', h);
  const close = matchBrace(appSrc, open);
  return appSrc.slice(h + 'const withErr ='.length, close + 1);
})();
t('（前置）切到了 withErr', weExpr.includes('setErr') && weExpr.includes('toast'), `长度 ${weExpr.length}`);
const weJs = transpile('let withErr =' + weExpr + ';');
t('（前置）withErr 转译掉了类型注解', !weJs.includes(': any'), weJs.slice(0, 80));
{
  const errs = [];
  const toasts = [];
  // eslint-disable-next-line no-new-func
  const withErr = new Function('setErr', 'ctx', weJs + '\nreturn withErr;')(
    (v) => errs.push(v),
    { toast: (m, k) => toasts.push([m, k]) },
  );
  const r = await withErr(async () => { throw new Error('写盘失败'); })();
  t('withErr 吞掉异常并重置错误态', r === undefined && errs.length === 2, `errs=${JSON.stringify(errs)}`);
  t('withErr 报 err 级 toast', toasts.length === 1 && toasts[0][1] === 'err', JSON.stringify(toasts));
}

const onCreateExpr = attrExpr(appSrc, 'onCreate={');
t('（前置）切到了新建弹窗的 onCreate', onCreateExpr.includes('createTask') && onCreateExpr.includes('withErr'), `长度 ${onCreateExpr.length}`);
{
  const mk = (mode) => {
    const log = { closed: 0, ok: 0, err: 0, errText: [], received: null, refreshed: 0 };
    const S = {
      createTask: async (_ctx, _dir, _me, draft) => {
        log.received = draft;
        if (mode === 'fail') throw new Error('TB_CONFLICT');
      },
    };
    const ctx = {
      toast: (m, k) => {
        if (k === 'ok') log.ok++;
        if (k === 'err') { log.err++; log.errText.push(m); }
      },
    };
    const cfg = { dataDir: 'D:/tb' };
    // withErr 与 onCreate 都跑真身，且共用同一个 ctx（否则 err toast 记到
    // 另一个桩上，断言会"看着在跑、其实没验到"）
    // eslint-disable-next-line no-new-func
    const withErr = new Function('setErr', 'ctx', weJs + '\nreturn withErr;')(
      () => {}, ctx,
    );
    // eslint-disable-next-line no-new-func
    const fn = new Function('withErr', 'S', 'ctx', 'cfg', 'me', 'setNewOpen', 'refresh',
      'return (' + onCreateExpr + ');')(withErr, S, ctx, cfg, 'dev-a',
      () => { log.closed++; }, async () => { log.refreshed++; });
    return { fn, log };
  };

  const ok = mk('ok');
  await awaitSafe(ok.fn({ title: '登录页样式错乱', detail: '', priority: 'P1', tags: ['bug'], assignee: '' }));
  t('成功 → 关闭弹窗', ok.log.closed === 1, `closed=${ok.log.closed}`);
  t('成功 → 报 ok', ok.log.ok === 1);
  t('成功 → 刷新列表', ok.log.refreshed === 1);
  t('成功 → 草稿真的传到了 createTask（withErr 转发入参）',
    ok.log.received && ok.log.received.title === '登录页样式错乱', JSON.stringify(ok.log.received));

  const bad = mk('fail');
  const threw = await awaitSafe(bad.fn({ title: 'x', detail: '', priority: 'P2', tags: [], assignee: '' }));
  t('失败 → 不往调用方抛（未捕获 rejection = 界面彻底没反应）★', threw === null, `抛出 ${String(threw?.message || threw)}`);
  t('失败 → 不关弹窗（东西还在，能改完重试）★', bad.log.closed === 0, `closed=${bad.log.closed}`);
  t('失败 → 报 err（不是静默无反应）★', bad.log.err === 1, `err=${bad.log.err}`);
  t('失败 → 不报 ok', bad.log.ok === 0);
  t('失败 → 有可见错误文案', bad.log.errText.some((m) => String(m).includes('TB_CONFLICT')), JSON.stringify(bad.log.errText));
}

/* ── 4. 设置页「用默认」按钮 ────────────────────────────────── */
console.log('\n=== 4. 设置页「用默认」（真身实跑）===');
{
  const marker = 'onClick={async () => {';
  /*
    ⛔ marker 现在出现多次（上游在设置页又加了别的 async onClick），
    取第一个会切到别的按钮：切出来的块里既没有 tb_default_dir 也没有
    try/catch，于是"失败有提示""提示带真原因"两条全红 —— 红的是别的按钮，
    而「用默认」真实的行为一条都没验到。必须按内容定位。
  */
  const nMarker = count(setSrc, marker);
  if (nMarker > 1) {
    t('（自检）朴素取第一个会漂到别的按钮 → 必须按内容定位',
      !innerBrace(setSrc, marker).includes('tb_default_dir'), `marker 出现 ${nMarker} 次`);
  }
  const body = innerBraceWhere(setSrc, marker, (b) => b.includes('tb_default_dir'));
  t('（前置）切到了「用默认」块体', body.includes('tb_default_dir') && body.includes('setMsg'), `长度 ${body.length}`);
  const js = transpile('(async () => {' + body + '})');
  const run = async (invokeImpl) => {
    const msgs = [];
    const cfgs = [];
    // eslint-disable-next-line no-new-func
    const fn = new Function('ctx', 'cfg', 'setCfg', 'setMsg', 'return ' + js + ';')(
      { invoke: invokeImpl }, { dataDir: 'old' }, (v) => cfgs.push(v), (v) => msgs.push(v));
    const threw = await awaitSafe(fn());
    return { msgs, cfgs, threw };
  };
  const a = await run(async () => 'D:/default');
  t('成功 → 填进目录', a.cfgs.length === 1 && a.cfgs[0].dataDir === 'D:/default', JSON.stringify(a.cfgs));
  const b = await run(async () => { throw new Error('命令未注册'); });
  t('失败 → 不往调用方抛（未捕获 rejection）★', b.threw === null, `抛出 ${String(b.threw?.message || b.threw)}`);
  t('失败 → 有可见提示（不是点了没反应）★', b.msgs.length === 1, JSON.stringify(b.msgs));
  t('失败 → 提示里带真原因', b.msgs[0] && b.msgs[0].includes('命令未注册'), JSON.stringify(b.msgs));
  t('失败 → 不把目录写成旧值', b.cfgs.length === 0);
}

/* ── 5. 设置页初始化：读不出配置不该永远「加载中」───────────── */
console.log('\n=== 5. 设置页初始化（真身实跑）===');
{
  const body = innerBrace(setSrc, '(async () => {');
  t('（前置）切到了初始化块体', body.includes('loadConfig'), `长度 ${body.length}`);
  const js = transpile('(async () => {' + body + '})');
  const run = async (loadImpl, healthImpl) => {
    const st = { loaded: 0, msg: [], cfg: null };
    // eslint-disable-next-line no-new-func
    const fn = new Function('ctx', 'alive', 'S', 'setCfg', 'setLoaded', 'setMsg', 'setServiceOn', 'return ' + js + ';')(
      { invoke: async () => 'x' }, true, { loadConfig: loadImpl, apiHealth: healthImpl || (async () => false) },
      (v) => { st.cfg = v; }, () => { st.loaded++; }, (v) => st.msg.push(v), () => {});
    st.threw = await awaitSafe(fn());
    return st;
  };
  const ok = await run(async () => ({ dataDir: 'D:/tb', port: 9911, token: '', notifyUrl: '', autoStart: false }));
  t('成功 → 标记已加载', ok.loaded === 1, `loaded=${ok.loaded}`);
  t('成功 → 不写错误提示', ok.msg.length === 0);

  const bad = await run(async () => { throw new Error('目录未授权'); });
  t('失败 → 不往调用方抛（未捕获 rejection）★', bad.threw === null, `抛出 ${String(bad.threw?.message || bad.threw)}`);
  t('失败 → 不再卡在「加载中…」★', bad.loaded === 1, `loaded=${bad.loaded}`);
  t('失败 → 有可见提示', bad.msg.length === 1 && bad.msg[0].includes('目录未授权'), JSON.stringify(bad.msg));
}

/* ── 6. 收尾：别再冒出第二份判据 ────────────────────────────── */
console.log('\n=== 6. 判据只有一份 ===');
{
  t('App.tsx 没有另写一份 isComposing 内联判据',
    !/isComposing\s*===\s*true\s*\|\|/.test(appSrc) && !/keyCode\s*===\s*229/.test(appSrc));
  const asyncOnClick = innerBrace(setSrc, 'onClick={async () => {');
  t('Settings.tsx 里没有未接住的裸 await onClick',
    asyncOnClick !== '' && asyncOnClick.includes('try {') && asyncOnClick.includes('catch'),
    `块体长度 ${asyncOnClick.length}`);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
