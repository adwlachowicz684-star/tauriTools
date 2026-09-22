/**
 * 图标写入后通知 Shell + ini 兼容旧格式（对齐 FolderIconService）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/shell-icon-notify-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const sys = strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/sys.rs'), 'utf8'));

const blk = (src, head) => {
  const i = src.indexOf(head);
  if (i < 0) return '';
  const ends = ['\npub fn ', '\nfn ', '\nconst ', '\npub(crate) fn ']
    .map((p) => src.indexOf(p, i + 1)).filter((x) => x > 0);
  return src.slice(i, ends.length ? Math.min(...ends) : src.length);
};

console.log('\n=== 1. 通知 Shell 三步（此前完全没有）★ ===');
{
  t('有 notify_shell_icon_changed', /pub fn notify_shell_icon_changed\(dir: &str\)/.test(sys));
  const b = blk(sys, 'pub fn notify_shell_icon_changed');
  /* 三步都要有：原版注释写明各自作用，缺一步都会残留缓存 */
  t('第1步 UPDATEDIR（重读 ini）', /SHCNE_UPDATEDIR/.test(b));
  t('第2步 UPDATEITEM（刷新该目录项）', /SHCNE_UPDATEITEM/.test(b));
  t('第3步 ASSOCCHANGED（清图像缓存）', /SHCNE_ASSOCCHANGED/.test(b));
  t('常量 UPDATEDIR = 0x1000', /SHCNE_UPDATEDIR: i32 = 0x0000_1000/.test(sys));
  t('常量 UPDATEITEM = 0x2000', /SHCNE_UPDATEITEM: i32 = 0x0000_2000/.test(sys));
  t('常量 ASSOCCHANGED = 0x08000000', /SHCNE_ASSOCCHANGED: i32 = 0x0800_0000/.test(sys));
  /* 路径用 PATHW（Unicode），用 IDLIST 传字符串会不生效 */
  t('前两步带 PATHW', (b.match(/SHCNF_PATHW \| SHCNF_FLUSH/g) || []).length === 2);
  /* 第三步不带路径：两个指针都 null，传路径字符串会被当成 IDLIST 解释 */
  t('第三步用 IDLIST + null 指针',
    /SHCNE_ASSOCCHANGED, SHCNF_IDLIST \| SHCNF_FLUSH, std::ptr::null\(\), std::ptr::null\(\)/.test(b));
  /* 宽字符串必须以 0 结尾 */
  t('宽串以 NUL 结尾', /\.chain\(std::iter::once\(0\)\)/.test(b));
  /* 非 Windows 空操作：不能因为缺符号编译不过 */
  t('非 Windows 为空操作', /#\[cfg\(not\(windows\)\)\]\s*\n\s*\{\s*\n\s*let _ = dir;/.test(b));
}

console.log('\n=== 2. 两处入口都要通知（设置与清除）★ ===');
{
  const i = sys.indexOf('pub fn apply_icon');
  const b = sys.slice(i, sys.indexOf('\npub fn ', i + 1));
  const n = (b.match(/notify_shell_icon_changed\(dir\)/g) || []).length;
  /*
   * 清除分支也要通知：不通知的话图标**仍显示旧的**，
   * 用户以为"恢复默认"没生效 —— 与设置分支是同一个坑的两面。
   */
  t('两处都调用了通知', n === 2, `实际 ${n} 处`);
  /* 消息不再让用户自己 F5 */
  t('不再写"需要按 F5"', !/F5/.test(b));
}

console.log('\n=== 3. ini 兼容旧格式 IconFile（此前只认 IconResource）★ ===');
{
  const b = blk(sys, 'pub fn icon_resource_in');
  t('认 IconResource', /strip_prefix\("IconResource="\)/.test(b));
  t('认 iconresource', /strip_prefix\("iconresource="\)/.test(b));
  /* 旧格式：XP 时代或别的工具写的 ini 里是这个 */
  t('认 IconFile', /strip_prefix\("IconFile="\)/.test(b));
  t('认 iconfile', /strip_prefix\("iconfile="\)/.test(b));
  /* 仍只认 [.ShellClassInfo] 段 */
  t('仍限定 ShellClassInfo 段', /in_sec = t\.eq_ignore_ascii_case\("\[\.ShellClassInfo\]"\)/.test(b));
  /* 无索引按 0，不整条放弃 */
  t('无索引按 0', /let idx = if idx\.is_empty\(\) \{ "0" \} else \{ idx \};/.test(b));
  /* 仍从最后一个逗号切：路径本身可能含逗号 */
  t('仍从最后逗号切', /v\.rfind\(','\)/.test(b));
}

console.log('\n=== 4. 原有行为没被改坏 ===');
{
  t('apply_icon 仍在', /pub fn apply_icon\(/.test(sys));
  t('仍只清 +s 不动 +h', /绝不动 \+h/.test(sys));
  t('ini 仍加 +h +s', /"\+h".*?\+s/.test(sys));
  t('lock_state 仍在', /pub fn lock_state\(/.test(sys));
  t('两条 ACE 仍在', /for perm in \[format!\(/.test(sys));
}

done();
