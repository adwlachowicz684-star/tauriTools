/**
 * plugin-fs-bridge 测试
 * ============================================================
 * 钉三件事：
 *   1. 每个方法把**正确的 op 与参数**发给后端（发错 op = 静默做错事）
 *   2. `remove` **默认不带 force**（默认开 force 等于替用户确认了删目录）
 *   3. 后端失败时**抛错**，不吞成 {ok:false}
 *
 * 另配成对反向自检：把任一判据清空后主断言若仍绿，说明它是假绿。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createFs, fsOp, resolveDataDir,
  EMPTY_DIR_TEXT, STAT_TYPE_PREFIX, STAT_KIND_FILE, STAT_KIND_DIR,
  EXISTS_TRUE, EXISTS_FALSE,
} from './js/plugin-fs-bridge.js';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';
import { createPluginDataStore, STORE_VERSION } from './js/plugin-data-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

/**
 * 记下每次 invoke 的 (cmd, args)，按 op 回放固定结果。
 *
 * 🔴 这里必须模拟 Tauri v2 的**真实参数校验**：后端签名是
 *    pub fn fs_op(app: AppHandle, req: FsRequest)
 * 宏按参数名从 payload 取值，顶层缺 `req` 一律拒。
 * 旧版 mock 直接读 args.op、断言也按平铺写，于是「测试全绿、真机必挂」——
 * 2026-11-07 插件商店截图里的 "missing required key req" 就是这么漏掉的。
 */
function mockInvoke(replies = {}) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd !== 'fs_op') throw new Error(`未预期的命令: ${cmd}`);
    if (!args || typeof args.req !== 'object' || args.req === null) {
      throw new Error('invalid args `req` for command `fs_op`: command fs_op missing required key req');
    }
    const key = args.req.op;
    if (key in replies) {
      const r = replies[key];
      if (r instanceof Error) throw r;
      return r;
    }
    return { ok: true, text: '' };
  };
  return { invoke, calls };
}

console.log('— plugin-fs-bridge —');

/* ── 第 1 节：op 与参数正确性 ───────────────────────────── */

{
  const { invoke, calls } = mockInvoke({
    read: { ok: true, text: 'hello' },
    write: { ok: true, text: '已写入 5 字节' },
    append: { ok: true, text: '已追加 5 字节' },
    mkdir: { ok: true, text: '已确保目录存在' },
    delete: { ok: true, text: '已删除文件' },
    list: { ok: true, text: 'a.js\nb.js\n' },
    exists: { ok: true, text: 'true' },
    move: { ok: true, text: '已移动' },
    copy: { ok: true, text: '已复制' },
  });
  const fs = createFs(invoke);

  t('readText 发 op=read', (await fs.readText('/d/a.txt')).includes('hello'));
  t('readText 的 cmd 是 fs_op', calls[0].cmd === 'fs_op');
  t('readText 传了 path', calls[0].args.req.path === '/d/a.txt');

  await fs.writeText('/d/b.txt', 'world');
  t('writeText 发 op=write', calls.at(-1).args.req.op === 'write');
  t('writeText 传了 content', calls.at(-1).args.req.content === 'world');

  await fs.appendText('/d/c.txt', 'tail');
  t('appendText 发 op=append', calls.at(-1).args.req.op === 'append');

  await fs.mkdir('/d/sub');
  t('mkdir 发 op=mkdir', calls.at(-1).args.req.op === 'mkdir');

  await fs.remove('/d/a.txt');
  t('remove 发 op=delete', calls.at(-1).args.req.op === 'delete');

  const list = await fs.readdir('/d');
  t('readdir 解析成数组', Array.isArray(list) && list.length === 2, JSON.stringify(list));
  t('readdir 去掉空行与空白', list[0] === 'a.js' && list[1] === 'b.js', JSON.stringify(list));
  t('readdir 发 op=list', calls.at(-1).args.req.op === 'list');

  t('exists 返回布尔 true', (await fs.exists('/d/a.txt')) === true);
  t('exists 发 op=exists', calls.at(-1).args.req.op === 'exists');

  await fs.move('/d/a.txt', '/d/z.txt');
  t('move 发 op=move 且带 target', calls.at(-1).args.req.op === 'move' && calls.at(-1).args.req.target === '/d/z.txt');

  await fs.copy('/d/a.txt', '/d/y.txt');
  t('copy 发 op=copy 且带 target', calls.at(-1).args.req.op === 'copy' && calls.at(-1).args.req.target === '/d/y.txt');
}

/* ── 第 2 节：readdir 的三种回执 ───────────────────────── */

{
  const { invoke } = mockInvoke({ list: { ok: true, text: EMPTY_DIR_TEXT } });
  t('空目录回执解析为空数组', (await createFs(invoke).readdir('/d')).length === 0);
}
{
  // 常量必须与后端源码里的文案一致：后端改了文案而这里没跟，解析就会静默出错
  const rs = readFileSync(join(HERE, 'src-tauri/src/af_flow.rs'), 'utf8');
  t('空目录回执常量与后端文案一致', rs.includes(EMPTY_DIR_TEXT), EMPTY_DIR_TEXT);
}
{
  const { invoke } = mockInvoke({ list: { ok: true, text: 'one\n\n  two  \n' } });
  const r = await createFs(invoke).readdir('/d');
  t('readdir 过滤空行并 trim', r.length === 2 && r[1] === 'two', JSON.stringify(r));
}
{
  const { invoke } = mockInvoke({ list: { ok: true, text: '' } });
  t('空文本回执也解析为空数组', (await createFs(invoke).readdir('/d')).length === 0);
}
{
  const { invoke, calls } = mockInvoke({ list: { ok: true, text: '' } });
  await createFs(invoke).readdir('/d', { recursive: true, exts: ['js'] });
  t('readdir 透传 recursive/exts', calls.at(-1).args.req.recursive === true && calls.at(-1).args.req.exts[0] === 'js');
}

/* ── 第 3 节 🔴：exists 的 fail-closed 判定 ───────────────
 * 旧口径把「未知回执 → false」当成正确行为，还配了反向自检钉住它。
 * 但这条 false 正是 plugin-data-store.js「不存在 / 损坏」的分界点：
 * 静默 false 会让一份已存在的 store.json 被当成「没有数据」，
 * set() 随即把真数据覆盖成空。行为级证据见第 11 节。 */

{
  const { invoke } = mockInvoke({ exists: { ok: true, text: EXISTS_TRUE } });
  t('exists 真回执 → true', (await createFs(invoke).exists('/x')) === true);
}
{
  const { invoke } = mockInvoke({ exists: { ok: true, text: EXISTS_FALSE } });
  t('exists 假回执 → false', (await createFs(invoke).exists('/x')) === false);
}
{
  // 大小写异常、空串、错误文本、缺 text：全都必须喊，不能静默判成不存在
  for (const [label, reply] of [
    ['TRUE', { ok: true, text: 'TRUE' }],
    ['False', { ok: true, text: 'False' }],
    ['空串', { ok: true, text: '' }],
    ['中文文案', { ok: true, text: '存在' }],
    ['缺 text', { ok: true }],
  ]) {
    const { invoke } = mockInvoke({ exists: reply });
    let threw = false;
    try { await createFs(invoke).exists('/x'); } catch { threw = true; }
    t(`exists 未知回执「${label}」→ 抛错（不谎报不存在）`, threw);
  }
}
{
  // 后端文案互钉：JS 侧认的两种取值必须就是 Rust 侧写死的那两种。
  // 只认分支附近 4 行 —— 全文件扫 "true" 会被别处的字面量喂饱。
  const rs = readFileSync(join(HERE, 'src-tauri/src/af_flow.rs'), 'utf8');
  const lines = rs.split('\n');
  const idx = lines.findIndex((l) => /"exists"\s*=>/.test(l));
  const seg = idx >= 0 ? lines.slice(idx, idx + 4).join('\n') : '';
  const echoMatches = (s) => {
    const vals = [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return vals.includes(EXISTS_TRUE) && vals.includes(EXISTS_FALSE);
  };
  t('后端 exists 分支找得到', idx >= 0);
  t('后端写死 true/false 且与 JS 常量一致', echoMatches(seg));
  t('元断言：后端改掉文案后互钉判据会红（非恒真）',
    !echoMatches(seg.replace(/"true"/g, '"t"').replace(/"false"/g, '"f"')));
  t('JS 常量就是后端那两个字面量', EXISTS_TRUE === 'true' && EXISTS_FALSE === 'false');
}

/* ── 第 4 节 🔴：remove 默认不带 force ────────────────── */

{
  const { invoke, calls } = mockInvoke({ delete: { ok: true, text: 'ok' } });
  await createFs(invoke).remove('/d/dir');
  t('remove 默认 force=false（不替用户确认删目录）', calls.at(-1).args.req.force === false);
}
{
  const { invoke, calls } = mockInvoke({ delete: { ok: true, text: 'ok' } });
  await createFs(invoke).remove('/d/dir', { force: true });
  t('remove 显式 force 时透传', calls.at(-1).args.req.force === true);
}

/* ── 第 5 节 🔴：失败必须抛错，不吞 ───────────────────── */

{
  const { invoke } = mockInvoke({ read: new Error('不在授权范围内') });
  let threw = false;
  try {
    await createFs(invoke).readText('/etc/passwd');
  } catch {
    threw = true;
  }
  t('后端拒绝时抛错（不静默返回）', threw);
}
{
  const { invoke } = mockInvoke({ list: new Error('目录不存在') });
  let threw = false;
  try {
    await createFs(invoke).readdir('/nope');
  } catch {
    threw = true;
  }
  t('readdir 失败也抛错', threw);
}
{
  // 后端返回了非对象（异常形态）时也不能被当成成功
  const invoke = async () => 'weird';
  let threw = false;
  try {
    await fsOp(invoke, { op: 'read', path: '/x' });
  } catch {
    threw = true;
  }
  t('返回非对象时抛错', threw);
}
{
  let threw = false;
  try {
    await fsOp(null, { op: 'read', path: '/x' });
  } catch {
    threw = true;
  }
  t('invoke 缺失时抛错并点明原因', threw);
}

/* ── 第 6 节：dryRun 透传 ─────────────────────────────── */

{
  const { invoke, calls } = mockInvoke({ delete: { ok: true, text: '[演练] 删除目录' } });
  const txt = await createFs(invoke).dryRun({ op: 'delete', path: '/d/p', force: true });
  t('dryRun 透传 dryRun=true', calls.at(-1).args.req.dryRun === true);
  t('dryRun 回执原样返回（供只读报告用）', txt.includes('演练'));
}

/* ── 第 7 节：resolveDataDir 拿不到时返回 null，不抛 ──── */

{
  const r = await resolveDataDir();
  t('resolveDataDir 在 Node 下返回 null 而不抛', r === null, String(r));
}

/* ── 第 8 节：源码层的三条约束（改坏了要被抓到） ──────── */

{
  const src = readFileSync(join(HERE, 'js/plugin-fs-bridge.js'), 'utf8');

  // ① 前端不做自己的路径校验 —— 否则就是第三套规则
  t(
    '源码不含前端侧路径越界校验（一律交给后端）',
    !/\.\.\/|startsWith\(\s*['"]\//.test(src.replace(/^\s*\*.*$/gm, '')),
  );

  // ② remove 的默认必须是 force=false：源码里不能写 force: true
  t(
    '源码里 remove 未默认开 force',
    !/async remove\(path, opts = \{\}\)[\s\S]{0,200}force:\s*true/.test(src),
  );

  // ③ 失败抛错：源码里不能出现把 ok:false 当返回值吞掉的形态
  t('源码不返回 {ok:false} 形态（失败一律 throw）', !/return\s*\{\s*ok:\s*false/.test(src));

  // ④ 命令名必须是后端真实注册的那个
  t('invoke 的命令名是 fs_op', /invoke\(\s*'fs_op'/.test(src));

  // ⑤ 依赖的后端能力必须真的在 generate_handler 里
  const mainRs = readFileSync(join(HERE, 'src-tauri/src/af_flow.rs'), 'utf8');
  t('后端确实有 fs_op 命令', /pub fn fs_op\(/.test(mainRs));
  t('fs_op 支持 write（本桥依赖它）', /"write" \| "append"/.test(mainRs));
  t('fs_op 支持 delete/mkdir/list/exists', /"delete" =>/.test(mainRs) && /"mkdir" =>/.test(mainRs) && /"list" =>/.test(mainRs) && /"exists" =>/.test(mainRs));
}

/* ── 第 9 节：反向自检（判据失效时必须喊） ────────────── */

{
  // 判据 ①：若"默认不带 force"这条判据被拿掉，本节仍能靠源码断言兜住
  t(
    '反向：force 默认写成 true 会被第 8 节抓到',
    /async remove\(path, opts = \{\}\)[\s\S]{0,200}force:\s*opts\.force/.test(
      readFileSync(join(HERE, 'js/plugin-fs-bridge.js'), 'utf8'),
    ),
  );

  // 判据 ②：exists 必须显式判两种取值、其余 throw。
  // ⛔ 旧版这条反向自检钉的是「严格 === 'true'」—— 恰好把「不是 true 就
  //    静默 false」当成正确行为钉死了，正是第 3/11 节要抓的洞。
  // 剥注释走共用模块：源码注释里原样写着 EXISTS_TRUE / 'true' 这些字样，
  // 不剥会被注释喂饱（本项目反复栽的形状）。
  const fsSrc = stripCommentsFlatJs(readFileSync(join(HERE, 'js/plugin-fs-bridge.js'), 'utf8'));
  const exAt = fsSrc.indexOf('async exists(');
  const exBody = exAt >= 0 ? fsSrc.slice(exAt, exAt + 700) : '';
  t('反向：exists 函数体找得到（不是空集合恒绿）', exBody.length > 100);
  t('反向：exists 显式比较两种常量',
    /v\s*!==\s*EXISTS_TRUE\s*&&\s*v\s*!==\s*EXISTS_FALSE/.test(exBody));
  t('反向：未知回执分支里确实 throw',
    /EXISTS_FALSE[\s\S]{0,220}throw new Error/.test(exBody));
  t('反向：不残留「不是 true 就 false」的旧写法',
    !/return\s+String\(text\)\.trim\(\)\s*===\s*'true'/.test(exBody));
}

/* ── 第 10 节：isFile —— 扫描模块销账的前置能力 ──────────
 * installed-plugin-scan.js 的 statSync(entryPath).isFile() 是主判据之一。
 * 改成注入式异步 fs 时，这条判据若被静默丢掉，界面表现为「一个插件
 * 都不出现」却不报错。本节钉住：能力存在、只取一行、文案与后端互钉、
 * 失效时抛错而不是返回 false。 */

{
  const FILE_RECEIPT = `${STAT_TYPE_PREFIX}${STAT_KIND_FILE}\n大小: 123 字节\n修改时间(Unix 秒): 1\n只读: false`;
  const DIR_RECEIPT = `${STAT_TYPE_PREFIX}${STAT_KIND_DIR}\n大小: 0 字节\n修改时间(Unix 秒): 1\n只读: false`;

  {
    const { invoke, calls } = mockInvoke({ stat: { ok: true, text: FILE_RECEIPT } });
    const v = await createFs(invoke).isFile('/d/plugins/a/index.html');
    t('isFile 对文件回执返回 true', v === true);
    t('isFile 发 op=stat', calls[0].args.req.op === 'stat');
    t('isFile 传了 path', calls[0].args.req.path === '/d/plugins/a/index.html');
  }
  {
    const { invoke } = mockInvoke({ stat: { ok: true, text: DIR_RECEIPT } });
    t('isFile 对目录回执返回 false', (await createFs(invoke).isFile('/d/plugins/a')) === false);
  }
  {
    const { invoke } = mockInvoke({ stat: { ok: true, text: '大小: 1 字节\n只读: false' } });
    let threw = false;
    try { await createFs(invoke).isFile('/d/x'); } catch { threw = true; }
    t('缺类型行时抛错，不静默返回 false', threw);
  }
  {
    const { invoke } = mockInvoke({ stat: { ok: true, text: `${STAT_TYPE_PREFIX}未知类型\n大小: 1 字节` } });
    let threw = false;
    try { await createFs(invoke).isFile('/d/x'); } catch { threw = true; }
    t('类型取值未知时抛错', threw);
  }
  {
    const { invoke } = mockInvoke({ stat: new Error('后端拒绝') });
    let threw = false;
    try { await createFs(invoke).isFile('/d/x'); } catch { threw = true; }
    t('后端失败时抛错（不吞成 false）', threw);
  }

  // 后端文案互钉：JS 侧解析的字面量必须与 Rust 侧写死的一致
  const rs = readFileSync(join(HERE, 'src-tauri/src/af_flow.rs'), 'utf8');
  t('后端 stat 分支写死了「类型: {}」行', /"类型: \{\}\\n大小:/.test(rs));
  // 只认 stat 分支那一行 kind 的取值。「全文件里出现过这个字样」会被别处的
  // 同形字面量喂饱：改掉 stat 分支的 "文件" 后整文件仍有 "文件"，判据照样绿。
  const kindLine = rs.split('\n').find((l) => l.includes('let kind =') && l.includes('meta.is_dir()'));
  t('后端 stat 分支的 kind 行找得到（不是全文件扫字样）', typeof kindLine === 'string');
  const kinds = kindLine ? [...kindLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  t('kind 行取值恰为「目录」「文件」且与 JS 常量一致',
    kinds.length === 2 && kinds.includes(STAT_KIND_DIR) && kinds.includes(STAT_KIND_FILE));
  t('JS 前缀常量与后端字面量一致', rs.includes(`"${STAT_TYPE_PREFIX}`) && STAT_TYPE_PREFIX === '类型: ');
  t('后端确实有 stat 分支', /"stat" =>/.test(rs));

  // 反向自检：判据不能退化成恒真 / 恒假兜底
  const src = readFileSync(join(HERE, 'js/plugin-fs-bridge.js'), 'utf8');
  t('isFile 含「缺类型行即 throw」分支', /缺少类型行（后端文案变了？）/.test(src));
  t('isFile 含「取值未知即 throw」分支', /类型取值未知（后端文案变了？）/.test(src));
  t('isFile 返回值由 kind 比较得出，不是恒值', /return kind === STAT_KIND_FILE/.test(src));
}

/* ── 第 11 节 🔴：静默 false 会覆盖真数据（跨模块行为级） ─────
 * plugin-data-store.js 硬约束 2 承诺「文件不存在才返回空对象、文件
 * 损坏必须抛错」，而分界点就是 fs.exists()。把 createFs 真注入进去，
 * 让 exists 回执飘成未知文案、read 仍返回一份完好的 record ——
 * 也就是 store.json 明明在、里面明明有数据，只是回执形态变了。
 * 旧写法会把它判成「没有数据」，set() 随即拿空 record 写回覆盖。 */

{
  const before11 = pass + fail;
  const REC = JSON.stringify({ v: STORE_VERSION, data: { keep: 'YES' } });
  const base = {
    read: { ok: true, text: REC },
    write: { ok: true, text: 'ok' },
    move: { ok: true, text: 'ok' },
    delete: { ok: true, text: 'ok' },
  };

  const bad = mockInvoke({ ...base, exists: { ok: true, text: '存在' } });
  const ds = createPluginDataStore({ fs: createFs(bad.invoke), dataRoot: '/APPDATA' });
  const THREW = Symbol('threw');
  const runChain = async (fn) => { try { return await fn(); } catch { return THREW; } };
  // 四条链各一条独占判据：合起来数「抛了几个」会让某条链的静默降级
  // 被其它三条的抛错盖住，且「没有 delete 调用」在两种情况下都绿（恒真）。
  t('readAll 回执异常时抛错（不返回空数据）',
    (await runChain(() => ds.readAll('demo'))) === THREW);
  t('set 回执异常时抛错（不拿空 record 写回）',
    (await runChain(() => ds.set('demo', 'newKey', 1))) === THREW);
  t('purge 回执异常时抛错（不返回 removed:false 静默跳过删除）',
    (await runChain(() => ds.purge('demo'))) === THREW);
  t('report 回执异常时抛错（不谎报 exists:false）',
    (await runChain(() => ds.report('demo'))) === THREW);
  t('元断言：exists 真的被调用过（注入生效，不是空跑）',
    bad.calls.some((c) => c.args.req.op === 'exists'));
  t('set 未写回（真数据没被覆盖成空）',
    !bad.calls.some((c) => c.args.req.op === 'write' || c.args.req.op === 'move'));
  t('purge 未真去删（delete 没被调用）',
    !bad.calls.some((c) => c.args.req.op === 'delete'));

  // 正常存在路径：set 必须带着旧键写回，而不是拿空 record 覆盖
  const ok = mockInvoke({ ...base, exists: { ok: true, text: EXISTS_TRUE } });
  const ds2 = createPluginDataStore({ fs: createFs(ok.invoke), dataRoot: '/APPDATA' });
  await ds2.set('demo', 'newKey', 1);
  const writeCall = ok.calls.find((c) => c.args.req.op === 'write');
  t('正常路径 set 写回保留旧键 keep 且带上新键',
    !!writeCall && writeCall.args.req.content.includes('"keep"') &&
    writeCall.args.req.content.includes('YES') && writeCall.args.req.content.includes('newKey'));
  // 本条自身尚未计入 pass+fail，故此处是「前 8 条都在」（全节共 9 条）
  t('元断言：第 11 节前 8 条判据都在（防空集合恒绿）', (pass + fail) - before11 >= 8);
}

/* ── 第 12 节 🔴：Tauri 真机参数形状（截图报错的根因） ──────────
 * 后端签名 `pub fn fs_op(app: AppHandle, req: FsRequest)`。
 * Tauri v2 的 command 宏按**参数名**从 invoke payload 取值，前端必须传
 * `{ req: {...} }`；平铺 `{ op, path, ... }` 会真机报
 *   invalid args `req` for command `fs_op`: missing required key req
 * mock 若也按平铺断言，就是「测试全绿、真机必挂」。本节把
 * 「JS payload 顶层 key」与「Rust 命令参数名」互钉，并逐一对拍
 * FsRequest 的必填字段，杜绝再退化。 */

{
  const rs = readFileSync(join(HERE, 'src-tauri/src/af_flow.rs'), 'utf8');
  const sig = rs.match(/pub fn fs_op\([^)]*?,\s*(\w+):\s*FsRequest\s*\)/);
  t('后端 fs_op 签名里取得出 struct 参数名', !!sig);
  const paramName = sig ? sig[1] : '';
  t('后端 struct 参数名就是 req', paramName === 'req', paramName);

  const { invoke, calls } = mockInvoke({ exists: { ok: true, text: EXISTS_TRUE } });
  await createFs(invoke).exists('/x');
  const payload = calls[0].args;
  t('元断言：确实发出过一次调用（防空集合恒绿）', calls.length === 1);
  t('payload 顶层唯一 key == 后端参数名',
    Object.keys(payload).length === 1 && Object.keys(payload)[0] === paramName,
    JSON.stringify(Object.keys(payload)));
  t('字段在 req 内而非平铺在顶层',
    !!payload.req && payload.req.op === 'exists' && payload.req.path === '/x');
  t('顶层不再残留 op（平铺形态已消失）', !('op' in payload));

  /* FsRequest 只有 max_bytes / exts 带 serde(default)，其余必须给全，
   * 否则 Tauri 反序列化会报 "missing field `target`" 一类的错。 */
  const struct = rs.match(/pub struct FsRequest \{[\s\S]*?\n\}/);
  t('后端找得到 FsRequest 定义', !!struct);
  const fields = struct ? [...struct[0].matchAll(/pub (\w+):/g)].map((m) => m[1]) : [];
  const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
  const required = fields.filter((f) => !['max_bytes', 'exts'].includes(f));
  t('元断言：必填字段数固定为 7（防空集合恒绿）', required.length === 7, String(required.length));
  t('FsRequest 必填字段全部出现在 req 里',
    required.length > 0 && required.every((f) => camel(f) in payload.req),
    JSON.stringify(required));

  /* 反向自检：平铺必须被拒、包 req 必须能过，判据既不恒真也不恒假。 */
  let flatThrew = false;
  try { await invoke('fs_op', { op: 'exists', path: '/x' }); } catch { flatThrew = true; }
  t('反向：平铺 payload 被 Tauri 形状校验拒绝', flatThrew);
  let okThrew = false;
  try { await invoke('fs_op', { req: { op: 'exists' } }); } catch { okThrew = true; }
  t('反向：包了 req 就能过形状校验', !okThrew);

  /* host.js 的 purge 是另一处 fs_op 调用，形状与必填字段同样要对。 */
  const hostSrc = stripCommentsFlatJs(readFileSync(join(HERE, 'js/host.js'), 'utf8'));
  const purge = hostSrc.match(/purgePluginFiles[\s\S]{0,900}?tauri\.invoke\('fs_op',\s*(\{[\s\S]*?\})\);/);
  t('host.js purge 的 fs_op 调用找得到', !!purge);
  const purgeArgs = purge ? purge[1] : '';
  t('host.js purge 也包了 { req }', /req:\s*\{/.test(purgeArgs));
  t('host.js purge 补齐 target/content/recursive/force/dryRun',
    ['target', 'content', 'recursive', 'force', 'dryRun']
      .every((k) => new RegExp(`\\b${k}\\s*:`).test(purgeArgs)));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
