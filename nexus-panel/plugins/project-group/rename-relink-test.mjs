/**
 * 改名要重建 junction + 迁移 ACL + 同步备份目录（对齐原版 RelocateCard）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/rename-relink-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));
const rs = (n) => strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx', n), 'utf8'));

const mod = rs('mod.rs');
const model = rs('model.rs');
const hook = R('hooks/useFpx.ts');
const types = R('types.ts');

/** 取 core_rename_folder 函数块（截到下一个顶层 fn/pub fn） */
function block(src, head) {
  const i = src.indexOf(head);
  const j = src.indexOf('\nfn ', i + 1);
  const k = src.indexOf('\npub fn ', i + 1);
  const m = src.indexOf('\npub(crate) fn ', i + 1);
  const ends = [j, k, m].filter((x) => x > 0);
  return src.slice(i, Math.min(...ends));
}
const ren = block(mod, 'pub(crate) fn core_rename_folder');
const mov = block(mod, 'fn core_move_folder');
console.log(`（改名块 ${ren.length} 字符 / 搬家块 ${mov.length} 字符）`);
t('取到改名块', ren.length > 500 && ren.includes('rename_with_fallback'));
t('取到搬家块', mov.length > 500 && mov.includes('std::fs::rename'));

console.log('\n=== 1. 项目组改名要重建 junction ★★ ===');
{
  /*
   * 原版 RelocateCard 第 2 步：「项目组改名/搬家须把指向旧路径的所有
   * junction 重建到新路径」。只有**项目**搬家不重建（junction 是其子项）。
   *
   * 本版此前写死 relinked: 0，注释还写着"原版同样如此" —— 那条注释是错的。
   * 后果：改个名，指向它的链接全部断掉，界面链接图标变红而用户不知道为什么。
   */
  t('改名不再是 relinked: 0', !/relinked: 0/.test(ren));
  t('改名有重建循环', /if kind_is_group \{\s*\n\s*for r in guide\.iter\(\)/.test(ren));
  t('重建前先删旧的', /let _ = junction::remove\(&r\.project, &names\);/.test(ren));
  t('再建指向新路径的', /junction::create\(&r\.project, &new_path, &names\)/.test(ren));
  t('只重建项目组', /let kind_is_group = kind == "group";/.test(ren));
  t('项目不存在则跳过', /if !std::path::Path::new\(&r\.project\)\.is_dir\(\) \{ continue; \}/.test(ren));
  /* 失败不中断：记下来交给前端提示 */
  t('重建失败不中断', /Err\(e\) => relink_errors\.push/.test(ren));
}

console.log('\n=== 2. 耗时 IO 不进事务 ===');
{
  /*
   * junction 重建是实打实的磁盘 IO（项目组被十个项目引用就是二十次）。
   * 塞进 with_config 会占住跨进程锁好几秒，--mcp 实例会等锁超时。
   */
  const iJunc = ren.indexOf('for r in guide.iter()');
  const iWith = ren.indexOf('store::with_config(dir, |cfg| {');
  /*
   * 用 `>= 0` 而不是 `> 0`：后者把"索引恰好为 0"也判成不合法。
   * 且顺序断言**两端都要判存在** —— 只判一端的话，另一端锚点被改没了
   * 会让比较恒真/恒假，断言要么空跑要么无端报红。
   */
  t('重建在事务之外', iJunc >= 0 && iWith >= 0 && iJunc < iWith,
    `junc=${iJunc} with=${iWith}`);
  const iRename = ren.indexOf('rename_with_fallback');
  t('物理改名也在事务之外', iRename >= 0 && iWith >= 0 && iRename < iWith);
}

console.log('\n=== 3. 迁移后对新路径重建 ACL 保护 ★ ===');
{
  /*
   * 原版第 4 步：「原路径受 ACL 保护 → 对新路径重建保护
   * （WithUnlock 只在旧路径恢复，旧路径已消失）」。
   *
   * LockGuard 的 drop 恢复的是旧路径 —— 改名/搬家后旧路径已不存在，
   * 于是保护**静默丢失**：盾牌徽章还在（config 条目随后被 remap），
   * 实际磁盘上没锁。用户以为受着保护，一删就掉。
   */
  t('改名：先记下旧状态', /let lock_before = store::lock_of\(&cfg0, path\)/.test(ren));
  t('改名：对新路径重建', /sys::apply_lock\(&new_path, dd, dw\)/.test(ren));
  t('搬家：先记下旧状态', /let lock_before = store::lock_of\(&cfg0, path\)/.test(mov));
  t('搬家：对新路径重建', /sys::apply_lock\(&new_path, dd, dw\)/.test(mov));
  /* 状态要在动手之前读：摘锁窗口内读到的已经是"被摘掉"的状态 */
  const iRead = ren.indexOf('let lock_before');
  const iRename = ren.indexOf('rename_with_fallback');
  t('改名：读状态在动手之前', iRead > 0 && iRead < iRename);
  const iRead2 = mov.indexOf('let lock_before');
  const iRename2 = mov.indexOf('std::fs::rename(old');
  t('搬家：读状态在动手之前', iRead2 > 0 && iRead2 < iRename2);
  /* 只在真的受保护时才做 */
  t('未受保护则不动', /\.filter\(\|\(d, w\)\| \*d \|\| \*w\)/.test(ren));
}

console.log('\n=== 4. 备份目录同步改名 ===');
{
  /*
   * 原版 RenameBackupFolder：末级名对末级名。
   * 不同步的话，备份区里旧名字那份留着，下次备份新建一个新名字的目录 ——
   * 同一个项目躺两份，用户翻的时候分不清该恢复哪一个。
   */
  t('取备份根用 resolve_dir', /backup::resolve_dir\(&cfg0, dir, bkind\)/.test(ren));
  t('按类别取', /let bkind = if kind_is_group \{ "group" \} else \{ "project" \};/.test(ren));
  /* 目标已存在绝不覆盖：那是一份已有备份 */
  t('目标已存在则跳过', /old_bak\.is_dir\(\) && !new_bak\.exists\(\)/.test(ren));
  t('同名则不动作', /!old_seg\.eq_ignore_ascii_case\(&new_seg\)/.test(ren));
  /* 失败不回滚：目录已经改完了，回滚是二次破坏 */
  t('失败只记日志', /Err\(e\) => eprintln!\(.*备份目录改名失败/.test(ren));
  t('DTO 有 backup_note', /pub backup_note: String,/.test(model));
  t('前端类型有 backupNote', /backupNote\?: string;/.test(types));
}

console.log('\n=== 5. 前端如实报出结果 ===');
{
  t('报重建条数', /r\.relinked && r\.relinked > 0/.test(hook));
  t('报备份目录同步', /if \(r\.backupNote\) extra \+=/.test(hook));
  /* 失败要单独报出来，否则用户以为全成功了 */
  t('失败单独报错', /有 \$\{r\.relinkErrors\.length\} 个项目的链接重建失败/.test(hook));
}

done();
