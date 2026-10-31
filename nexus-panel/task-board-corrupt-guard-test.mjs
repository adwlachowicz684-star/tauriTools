/**
 * 清单文件损坏守卫：任务板 tasks-*.json / 附件 attachments-*.json
 * ============================================================
 * 运行：node task-board-corrupt-guard-test.mjs
 *
 * 背景：两份清单并排放在同一个导出目录里（AI 只读自己那份）。
 * 文件被手改坏 / 写一半中断时，旧路径是这样把它**整份盖掉**的：
 *
 *   readBoardFile → 拿到坏 JSON
 *   parseBoard    → 解不出来就退成空清单（这个契约本身对"单条解析"是对的：
 *                   手改坏了也不至于让整个面板崩掉）
 *   commit 三方合并 → theirs = 空 → 合并结果只剩 mine
 *   writeBoardFile → **整份覆盖**
 *
 * 而损坏的 JSON 往往手改几行就能救回来，一盖就永远没了。
 * 更糟的是界面上写的是「暂无任务 / 没有附件」——**这是一句假话**，
 * 用户照着"空的"去添加第一条，正好触发上面那条覆盖链。
 *
 * 所以"能不能解析"必须是一个**独立于解析结果**的 observable 信号
 * （isParseableJson），commit / load 两条路径都先看它：
 *   - commit：坏了就抛错、**一个字节都不写**（原文件保持不动）
 *   - load：坏了就抛错，绝不退化成"空清单"
 *
 * 本测试跑真身：把 engine 的 .ts 真编译出来，接上可控的文件系统桩，
 * 实跑 commitBoard / loadBoard / commitAttachments / loadAttachments；
 * 两个 hook 的 apply 也是切出真实函数体、注入桩后实跑。
 * 不是"看源码里有没有那几个字"。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const ROOT = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

/* 未捕获 rejection 兜底：本项目反复栽在"反向验证时脚本崩在半路，
   后面十几条断言一条没跑，报告上看着只红几条"。这里把它变成一条可见失败。 */
process.on('unhandledRejection', (e) => {
  fail++;
  console.log(`❌ 未捕获 rejection（有分支没接住异常，界面会彻底没反应）★ — ${String(e?.message || e)}`);
});

let pass = 0;
let fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ------------------------------------------------------------------ */
/* 脚手架：把 engine 的 .ts 真编译出来，接上可控的文件系统            */
/* ------------------------------------------------------------------ */

const SCRATCH = join(ROOT, '.rt', 'tbcorrupt');
const ENGINE = 'plugins/agent-flow/engine';
/*
  写死清单会随上游加文件而失效：attachmentFile 现在引了 textFile，
  而清单里没有 → 整份测试崩在 import 上（崩掉的脚本一条断言都跑不到）。
  改成从入口递归展开相对 import：上游再加被引用的文件也不会崩。
*/
const ENTRY = [
  `${ENGINE}/taskBoard.ts`,
  `${ENGINE}/kv.ts`,
  `${ENGINE}/exportDir.ts`,
  `${ENGINE}/taskBoardFile.ts`,
  `${ENGINE}/attachmentStore.ts`,
  `${ENGINE}/attachmentFile.ts`,
];
const SRC = new Set(ENTRY);
{
  const queue = [...ENTRY];
  while (queue.length) {
    const rel = queue.pop();
    let src = '';
    try {
      src = rd(rel);
    } catch {
      continue;
    }
    for (const m of src.matchAll(/from\s+'(\.[^']*)'/g)) {
      let p = m[1];
      if (!p.endsWith('.ts')) p += '.ts';
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), p));
      // 只收 engine 内、确实存在的；lib/tauri 之类外部依赖走桩，不转译
      if (!dep.startsWith(ENGINE + '/')) continue;
      if (!existsSync(join(ROOT, dep))) continue;
      if (!SRC.has(dep)) {
        SRC.add(dep);
        queue.push(dep);
      }
    }
  }
}

rmSync(SCRATCH, { recursive: true, force: true });

function transpile(rel, src) {
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  // Node ESM 要求带扩展名；TS 源码里的相对导入不带，补上
  return out.replace(/from '(\.[^']*)'/g, (m, p) => (p.endsWith('.js') ? m : `from '${p}.js'`));
}

for (const rel of SRC) {
  const dst = join(SCRATCH, 'm', rel.replace('plugins/agent-flow/', '').replace(/\.ts$/, '.js'));
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, transpile(rel, rd(rel)));
}

/*
  自检：转译产物的相对 import 必须全部能解析。
  缺一个文件，整份测试会崩在 import 上 —— 而崩掉的脚本一条断言都跑不到，
  在体检报告上只显示"崩了"，看不出底下压着多少条没验。
*/
{
  const miss = [];
  for (const rel of SRC) {
    const dst = join(SCRATCH, 'm', rel.replace('plugins/agent-flow/', '').replace(/\.ts$/, '.js'));
    const code = readFileSync(dst, 'utf8');
    for (const m of code.matchAll(/from '(\.[^']*)'/g)) {
      if (!existsSync(join(dirname(dst), m[1]))) miss.push(`${rel} → ${m[1]}`);
    }
  }
  t('自检：转译产物的相对 import 全部可解析', miss.length === 0 ? true : `缺失 ${miss.join('; ')}`);
}

/* lib/tauri 是唯一的外层依赖（真身要 Tauri 后端），用桩替换。
   桩是**可控**的：能造出"文件不存在""内容是坏的""写入"三种情形。 */
mkdirSync(join(SCRATCH, 'm', 'lib'), { recursive: true });
writeFileSync(join(SCRATCH, 'm', 'lib', 'tauri.js'), `
export const __fs = new Map();
export const __writes = [];
export function __reset() { __fs.clear(); __writes.length = 0; }
export function canExportToFile() { return true; }
export async function ensureDir() { return { ok: true, text: '已存在' }; }
export async function fileOp(a) {
  if (a.op === 'read') {
    if (!__fs.has(a.path)) return { ok: false, text: '文件不存在' };
    return { ok: true, text: __fs.get(a.path) };
  }
  return { ok: false, text: 'unsupported op' };
}
export async function writeTextFile(p, c) {
  __writes.push({ path: p, content: c });
  __fs.set(p, c);
  return { ok: true, text: '' };
}
`);

const imp = (rel) => import('file://' + join(SCRATCH, 'm', rel));

const tbf = await imp('engine/taskBoardFile.js');
const aff = await imp('engine/attachmentFile.js');
const tb = await imp('engine/taskBoard.js');
const as = await imp('engine/attachmentStore.js');
const stub = await imp('lib/tauri.js');

const { __fs, __writes } = stub;
const reset = () => stub.__reset();

/* 一个好清单 / 一个坏清单 */
const P = '/out/tasks-项目甲.json';
const PA = '/out/attachments-项目甲.json';
const BAD = '{"nodes": {"a": {"kind": "task", "title": "甲"';  // 写一半被中断
const goodBoard = () => {
  const b = tb.emptyBoard('p1', '项目甲');
  const r = tb.addNode(b, null, { kind: 'task', title: '老任务', status: 'todo', deps: [], assignee: '', note: '' });
  return r.board;
};

/* ------------------------------------------------------------------ */
/* ① 判据本身（跑真身）                                                */
/* ------------------------------------------------------------------ */

console.log('\n— ① isParseableJson：能不能解析必须是独立于解析结果的信号 —\n');

t('空文件不算损坏（第一次用本来就是空的）', tbf.isParseableJson('') === true);
t('纯空白不算损坏', tbf.isParseableJson('   \n  ') === true);
t('好 JSON 不算损坏', tbf.isParseableJson('{"nodes":{}}') === true);
t('完全不是 JSON → 损坏', tbf.isParseableJson('不是 json') === false);
t('写一半被中断（括号没闭）→ 损坏', tbf.isParseableJson(BAD) === false);
t('JSON.parse 出 null → 损坏（不是对象）', tbf.isParseableJson('null') === false);
t('JSON.parse 出数字 → 损坏', tbf.isParseableJson('123') === false);
t('尾巴上多一块 → 损坏', tbf.isParseableJson('{"a":1}多余') === false);

/* ------------------------------------------------------------------ */
/* ② 两份清单共用同一份判据（不能各抄一份）                            */
/* ------------------------------------------------------------------ */

console.log('\n— ② 同一份判据：两个面板不能一个报"读不出来"、一个当"没有" —\n');

t('attachmentFile 的判据与 taskBoardFile 是**同一个函数**', aff.isParseableJson === tbf.isParseableJson);
t('同一份坏内容，两处判据给出同一结论',
  aff.isParseableJson(BAD) === tbf.isParseableJson(BAD) && tbf.isParseableJson(BAD) === false);

/* ------------------------------------------------------------------ */
/* ③ commitBoard：坏了就一个字节都不写                                  */
/* ------------------------------------------------------------------ */

console.log('\n— ③ commitBoard：坏文件不许整份覆盖 —\n');

async function tryCommit(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

{
  reset();
  __fs.set(P, JSON.stringify(goodBoard()));
  let e = await tryCommit(() => tbf.commitBoard(P, goodBoard(), goodBoard()));
  t('好文件：正常落盘（不误伤正常路径）', e === null && __writes.length === 1, String(e?.message || ''));
}
{
  reset();
  __fs.set(P, BAD);
  const before = __fs.get(P);
  const mine = goodBoard();
  const r = tb.addNode(mine, null, { kind: 'task', title: '新加的', status: 'todo', deps: [], assignee: '', note: '' });
  let e = await tryCommit(() => tbf.commitBoard(P, mine, r.board));
  t('坏文件：commit 抛错（不是静默写回）', e instanceof Error, '没抛错');
  t('坏文件：**一次都没写**（原文件保持不动）', __writes.length === 0, `写了 ${__writes.length} 次`);
  t('坏文件：磁盘内容原样保留（手改几行还能救回来）', __fs.get(P) === before);
  t('抛出的原因说清是"损坏"且"原文件未改动"',
    /损坏/.test(String(e?.message)) && /原文件未改动/.test(String(e?.message)), String(e?.message));
}
{
  reset();
  // 文件不存在 → 第一次用，不该被当成损坏
  let e = await tryCommit(() => tbf.commitBoard(P, tb.emptyBoard('p1', '项目甲'), goodBoard()));
  t('文件不存在（第一次用）：不被判成损坏，正常落盘', e === null && __writes.length === 1, String(e?.message || ''));
}
{
  reset();
  __fs.set(P, '   ');  // 空文件
  let e = await tryCommit(() => tbf.commitBoard(P, tb.emptyBoard('p1', '项目甲'), goodBoard()));
  t('空文件：不算损坏，正常落盘', e === null && __writes.length === 1, String(e?.message || ''));
}

/* ------------------------------------------------------------------ */
/* ④ loadBoard：坏了要说"坏了"，不许说"没有"                             */
/* ------------------------------------------------------------------ */

console.log('\n— ④ loadBoard：不许把"读不出来"说成"暂无任务" —\n');

{
  reset();
  const b = await tbf.loadBoard(P, 'p1', '项目甲');
  t('文件不存在 → 空板（第一次用，不报错）', Object.keys(b.nodes).length === 0);
}
{
  reset();
  __fs.set(P, BAD);
  let e = await tryCommit(() => tbf.loadBoard(P, 'p1', '项目甲'));
  t('坏文件：load 抛错（不退化成空板）', e instanceof Error, '没抛错 → 界面会写「暂无任务」');
  t('抛出的原因说清是"损坏"且"未读取/原文件未改动"',
    /损坏/.test(String(e?.message)) && /原文件未改动/.test(String(e?.message)), String(e?.message));
}
{
  reset();
  __fs.set(P, JSON.stringify(goodBoard()));
  const b = await tbf.loadBoard(P, 'p1', '项目甲');
  t('好文件：正常读出老任务', Object.values(b.nodes).some((n) => n.title === '老任务'));
}

/* ------------------------------------------------------------------ */
/* ⑤ 附件清单同一口径                                                   */
/* ------------------------------------------------------------------ */

console.log('\n— ⑤ 附件清单：与任务板同一口径（不能一处严一处松） —\n');

const attachWith = () => {
  const f = as.emptyAttachments('p1', '项目甲');
  return f;
};

{
  reset();
  __fs.set(PA, BAD);
  const before = __fs.get(PA);
  let e = await tryCommit(() => aff.commitAttachments(PA, attachWith(), attachWith()));
  t('坏文件：附件 commit 同样抛错', e instanceof Error, '没抛错');
  t('坏文件：附件同样一次都没写', __writes.length === 0, `写了 ${__writes.length} 次`);
  t('坏文件：附件原文件同样原样保留', __fs.get(PA) === before);
  t('附件抛错文案与任务板同一口径（都说损坏 / 原文件未改动）',
    /损坏/.test(String(e?.message)) && /原文件未改动/.test(String(e?.message)), String(e?.message));
}
{
  reset();
  __fs.set(PA, BAD);
  let e = await tryCommit(() => aff.loadAttachments(PA, 'p1', '项目甲'));
  t('坏文件：附件 load 同样抛错（不退化成"没有附件"）', e instanceof Error, '没抛错');
}
{
  reset();
  const f = await aff.loadAttachments(PA, 'p1', '项目甲');
  t('文件不存在 → 空附件清单（第一次用）', Object.keys(f.items || {}).length === 0);
}

/* ------------------------------------------------------------------ */
/* ⑥ 界面回滚：失败要退回原样，不许停在"没落盘的值"上                   */
/* ------------------------------------------------------------------ */

console.log('\n— ⑥ 两个 hook 的 apply：失败要退回原样（跑真身） —\n');

/** 括号配平：s[i] 必须是 '{'，返回匹配的 '}' 下标 */
function matchBrace(s, i) {
  let d = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (d === 0) return k; }
  }
  return -1;
}

/**
 * 从 .ts 源码里切出 apply 的真实函数体，注入桩后实跑。
 * 返回 run（写入队列里的那个 Promise）。
 */
function makeApply(relFile, anchor, argNames, bodyEnd) {
  const src = ts.transpileModule(rd(relFile), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`找不到锚点：${anchor} @ ${relFile}`);
  const open = src.indexOf('{', src.indexOf('=>', at));
  const close = matchBrace(src, open);
  const body = src.slice(open + 1, close);
  return new Function(...argNames, body + '\n return run;');
}

const HOOK_TB = 'plugins/agent-flow/hooks/useTaskBoard.ts';
const HOOK_AF = 'plugins/agent-flow/hooks/useAttachments.ts';

{
  const mk = makeApply(HOOK_TB, 'const apply = useCallback(',
    ['next', 'canWrite', 'path', 'boardRef', 'setBoardBoth', 'queueRef', 'setState', 'commitBoard', 'baseRef', 'setExpanded']);

  const base = goodBoard();
  const boardRef = { current: base };
  let shown = base;
  const setBoardBoth = (b) => { boardRef.current = b; shown = b; };
  let state = { kind: 'idle' };
  const setState = (s) => { state = s; };
  const queueRef = { current: Promise.resolve() };
  const baseRef = { current: base };

  const run = mk((b) => tb.addNode(b, null, { kind: 'task', title: '新加的', status: 'todo', deps: [], assignee: '', note: '' }).board,
    true, P, boardRef, setBoardBoth, queueRef, setState,
    async () => { throw new Error('清单文件已损坏，已中止写入（原文件未改动）：' + P); },
    baseRef, (f) => f);
  await run.catch(() => undefined);

  t('失败后：界面退回原样（新加那条不在了）',
    !Object.values(shown.nodes).some((n) => n.title === '新加的'),
    '还留着 → 看着像"报了错但其实加上了"');
  t('失败后：状态是 error 且带出"损坏"原因',
    state.kind === 'error' && /损坏/.test(String(state.message)), JSON.stringify(state));
}
{
  // 乐观阶段确实先加上了 —— 否则上面那条"退回原样"是空跑（没加过就无所谓退不退）
  const mk = makeApply(HOOK_TB, 'const apply = useCallback(',
    ['next', 'canWrite', 'path', 'boardRef', 'setBoardBoth', 'queueRef', 'setState', 'commitBoard', 'baseRef', 'setExpanded']);

  const base = goodBoard();
  const boardRef = { current: base };
  let optimistic = null;
  const setBoardBoth = (b) => { boardRef.current = b; if (optimistic === null) optimistic = b; };
  const queueRef = { current: Promise.resolve() };
  let state = { kind: 'idle' };

  const run = mk((b) => tb.addNode(b, null, { kind: 'task', title: '新加的', status: 'todo', deps: [], assignee: '', note: '' }).board,
    true, P, boardRef, setBoardBoth, queueRef, (s) => { state = s; },
    async () => { throw new Error('损坏'); },
    { current: base }, (f) => f);
  await run.catch(() => undefined);

  t('自检：乐观阶段确实先把新任务放进去了（否则"退回原样"是空跑）',
    optimistic !== null && Object.values(optimistic.nodes).some((n) => n.title === '新加的'),
    '乐观阶段没加 → 上一条断言恒真，等于没验');
}
{
  const mk = makeApply(HOOK_AF, 'const apply = useCallback(',
    ['next', 'canWrite', 'path', 'fileRef', 'setBoth', 'queueRef', 'setState', 'commitAttachments', 'baseRef']);

  const base = attachWith();
  const fileRef = { current: base };
  let shown = base;
  const setBoth = (f) => { fileRef.current = f; shown = f; };
  let state = { kind: 'idle' };
  const queueRef = { current: Promise.resolve() };

  const run = mk((f) => ({ ...f, touched: true }),
    true, PA, fileRef, setBoth, queueRef, (s) => { state = s; },
    async () => { throw new Error('清单文件已损坏，已中止写入（原文件未改动）：' + PA); },
    { current: base });
  await run.catch(() => undefined);

  t('附件 hook 失败后同样退回原样', shown === base, '界面停在没落盘的值上');
  t('附件 hook 失败后状态是 error 且带出原因',
    state.kind === 'error' && /损坏/.test(String(state.message)), JSON.stringify(state));
}

/* ------------------------------------------------------------------ */

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}\n`);
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
