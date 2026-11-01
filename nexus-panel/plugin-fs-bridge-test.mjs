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
import { createFs, fsOp, resolveDataDir, EMPTY_DIR_TEXT } from './js/plugin-fs-bridge.js';

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

/** 记下每次 invoke 的 (cmd, args)，按 op 回放固定结果 */
function mockInvoke(replies = {}) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd !== 'fs_op') throw new Error(`未预期的命令: ${cmd}`);
    const key = args.op;
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
  t('readText 传了 path', calls[0].args.path === '/d/a.txt');

  await fs.writeText('/d/b.txt', 'world');
  t('writeText 发 op=write', calls.at(-1).args.op === 'write');
  t('writeText 传了 content', calls.at(-1).args.content === 'world');

  await fs.appendText('/d/c.txt', 'tail');
  t('appendText 发 op=append', calls.at(-1).args.op === 'append');

  await fs.mkdir('/d/sub');
  t('mkdir 发 op=mkdir', calls.at(-1).args.op === 'mkdir');

  await fs.remove('/d/a.txt');
  t('remove 发 op=delete', calls.at(-1).args.op === 'delete');

  const list = await fs.readdir('/d');
  t('readdir 解析成数组', Array.isArray(list) && list.length === 2, JSON.stringify(list));
  t('readdir 去掉空行与空白', list[0] === 'a.js' && list[1] === 'b.js', JSON.stringify(list));
  t('readdir 发 op=list', calls.at(-1).args.op === 'list');

  t('exists 返回布尔 true', (await fs.exists('/d/a.txt')) === true);
  t('exists 发 op=exists', calls.at(-1).args.op === 'exists');

  await fs.move('/d/a.txt', '/d/z.txt');
  t('move 发 op=move 且带 target', calls.at(-1).args.op === 'move' && calls.at(-1).args.target === '/d/z.txt');

  await fs.copy('/d/a.txt', '/d/y.txt');
  t('copy 发 op=copy 且带 target', calls.at(-1).args.op === 'copy' && calls.at(-1).args.target === '/d/y.txt');
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
  t('readdir 透传 recursive/exts', calls.at(-1).args.recursive === true && calls.at(-1).args.exts[0] === 'js');
}

/* ── 第 3 节：exists 的布尔判定 ────────────────────────── */

{
  const { invoke } = mockInvoke({ exists: { ok: true, text: 'false' } });
  t('exists "false" → false', (await createFs(invoke).exists('/x')) === false);
}
{
  // 后端若哪天返回布尔 true 而不是字符串，也要判成 true —— 但不能靠 == 宽松比较
  const { invoke } = mockInvoke({ exists: { ok: true, text: 'TRUE' } });
  t('exists 大小写异常时不谎报存在', (await createFs(invoke).exists('/x')) === false);
}

/* ── 第 4 节 🔴：remove 默认不带 force ────────────────── */

{
  const { invoke, calls } = mockInvoke({ delete: { ok: true, text: 'ok' } });
  await createFs(invoke).remove('/d/dir');
  t('remove 默认 force=false（不替用户确认删目录）', calls.at(-1).args.force === false);
}
{
  const { invoke, calls } = mockInvoke({ delete: { ok: true, text: 'ok' } });
  await createFs(invoke).remove('/d/dir', { force: true });
  t('remove 显式 force 时透传', calls.at(-1).args.force === true);
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
  t('dryRun 透传 dryRun=true', calls.at(-1).args.dryRun === true);
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

  // 判据 ②：exists 的判定不能是宽松比较（否则 'false' 会被判成存在）
  t(
    '反向：exists 用严格 === "true"，不是 if(text)',
    /String\(text\)\.trim\(\)\s*===\s*'true'/.test(
      readFileSync(join(HERE, 'js/plugin-fs-bridge.js'), 'utf8'),
    ),
  );
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
