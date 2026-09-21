/**
 * desktop.ini 里的图标路径要纯 ASCII（对齐原版 CopyIconToCache / GetStableName）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/shell-icon-ascii-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const rs = (n) => strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx', n), 'utf8'));
const mod = rs('mod.rs');

console.log('\n=== 1. 有稳定名副本机制 ===');
{
  t('有 stable_icon_ref', /fn stable_icon_ref\(/.test(mod));
  /* 只在 Windows 生效 —— 别的平台根本不写 desktop.ini */
  t('仅 windows 版本带 cfg', /#\[cfg\(windows\)\]\s*\npub\(crate\) fn stable_icon_ref\(/.test(mod));
  t('非 windows 原样返回', /#\[cfg\(not\(windows\)\)\]\s*\npub\(crate\) fn stable_icon_ref\([^)]*\) -> String \{\s*\n\s*icon_ref\.to_string\(\)\s*\n\}/.test(mod));
  /* 缓存目录固定名，副本路径稳定可复现 */
  t('副本落在 _shellcache', /join\("_shellcache"\)/.test(mod));
}

console.log('\n=== 2. 只在必要时才复制 ===');
{
  /*
   * 纯 ASCII 且无空格 → 原样返回。
   * 无条件复制会让每次换图标都多出一份副本，缓存目录只涨不清理。
   */
  t('ASCII 无空格则不动', /if file\.is_ascii\(\) && !file\.contains\(' '\) \{ return icon_ref\.to_string\(\); \}/.test(mod));
  /* 源不在就别折腾 —— 复制必然失败，不如早退 */
  t('源不是文件则不动', /if !src\.is_file\(\) \{ return icon_ref\.to_string\(\); \}/.test(mod));
}

console.log('\n=== 3. 名字只留 ASCII ===');
{
  /* 中文/空格/特殊符号统一换 _，与 SHA 前缀配合保证唯一 */
  t('非 ASCII 换成下划线', /if c\.is_ascii_alphanumeric\(\) \|\| c == '-' \|\| c == '_' \{ c \} else \{ '_' \}/.test(mod));
  t('保留原扩展名', /let ext = src\s*\n\s*\.extension\(\)/.test(mod));
  /* 哈希前缀：同一路径永远同一前缀（不引 sha1 依赖，用 FNV-1a） */
  t('有哈希前缀', /let prefix = format!\("\{:08x\}", h\);/.test(mod));
  t('哈希是 FNV-1a', /0xcbf29ce484222325/.test(mod));
}

console.log('\n=== 4. 失败要退回，不能让功能静默失效 ===');
{
  /*
   * 复制失败就退回原路径 —— 不能因为取不到副本就不写 desktop.ini，
   * 那会让"同步到资源管理器"整个功能悄悄失效。
   */
  t('复制失败退回原路径', /if std::fs::copy\(src, &dest\)\.is_err\(\) \{ return icon_ref\.to_string\(\); \}/.test(mod));
  t('建目录失败也退回', /if std::fs::create_dir_all\(&cache\)\.is_err\(\) \{ return icon_ref\.to_string\(\); \}/.test(mod));
}

console.log('\n=== 5. 两处写 desktop.ini 都接上了 ===');
{
  t('core_save_style 接上', /let shell_icon = stable_icon_ref\(&dir\.join\("icons"\), &icon\);\s*\n\s*with_unlock\(dir, path, \|\| sys::apply_icon\(path, &shell_icon\)\)\?;/.test(mod));
  t('set_style 接上', /let shell_icon = stable_icon_ref\(&dir\.join\("icons"\), &icon\);\s*\n\s*if let Err\(e\) = with_unlock\(&dir, &path, \|\| sys::apply_icon\(&path, &shell_icon\)\) \{/.test(mod));
  /* 不能再有直接把 icon 传进去的写法 */
  const left = (mod.match(/sys::apply_icon\(&?path, &icon\)/g) || []).length;
  t('没有遗留直传 icon 的调用', left === 0, `剩 ${left} 处`);
}

console.log('\n=== 6. MCP 那两处也要同步（否则表现随写入者而变）===');
{
  const mcp = rs('mcp.rs');
  /*
   * folder_icon_set 走 MCP、界面改图标走 mod.rs —— 两条路必须同一规则。
   * 不同步的话，MCP 设完再在界面里改一次，资源管理器里的表现
   * 会随"最后一次是谁写的"而变，用户查不出规律。
   */
  t('MCP folder_icon_set 接上',
    /let shell_icon = super::stable_icon_ref\(&dir\.join\("icons"\), &icon\);/.test(mcp));
  t('MCP 不再直传 icon', !/sys::apply_icon\(&path, &icon\)/.test(mcp));
  /* 恢复默认那处：要删的是 desktop.ini，没有图标路径，不必接 */
  t('恢复默认仍传空串', /sys::apply_icon\(&path, ""\)/.test(mcp));
  /* 可见性：mcp.rs 是 fpx 的子模块，要用必须 pub(crate) */
  t('函数可见性 pub(crate)', /pub\(crate\) fn stable_icon_ref\(/.test(mod));
  t('windows 版也是 pub(crate)', /#\[cfg\(windows\)\]\s*\npub\(crate\) fn stable_icon_ref\(/.test(mod));
}

done();
