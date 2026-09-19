/**
 * desktop.ini 图标行的回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/ini-icon-test.mjs，然后
 *         node plugins/project-group/ini-icon-test.mjs
 *
 * #304 / #512（清单标 `[险]`）：`IconResource=` 这一行的路径
 * **含空格或逗号时必须用双引号包裹**，否则 Shell 按空格截断，
 * 图标静默失效 —— 不报错、不提示，用户只会看到"图标没换"。
 *
 * 而含空格的路径恰恰是常态（`C:\Users\张三\My Projects\…`），
 * 也就是说这个 bug 影响的是**大多数真实用户**，不是边缘情况。
 *
 * 这里守三件容易做错的事：
 *   · 需要引号时才加 —— 不带空格/逗号的路径必须与修复前字节一致
 *   · 逗号也要加引号（否则哪个逗号是索引分隔符取决于解析方式）
 *   · 拼接只有**一处** —— 抄两份的话改引号规则会只改一处
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, sliceWithDoc } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '../../src-tauri/src/fpx');
const { t, done } = makeT();

const sys = fs.readFileSync(path.join(RS, 'sys.rs'), 'utf8');

console.log('\n=== 1. 拼接函数存在且唯一 ===');
{
  t('定义 build_icon_resource_line', /fn build_icon_resource_line\(file: &str, index: i32\)/.test(sys));
  t('标了 cfg(windows)', /#\[cfg\(windows\)\]\s*fn build_icon_resource_line/.test(sys));
  /* 抄两份的话，改引号规则必然只改一处 —— 同一个 bug 会在另一个入口复活 */
  const naked = (sys.match(/IconResource=\{file\},\{index\}/g) || []).length;
  t('裸拼接只剩函数内那一处', naked === 1, `找到 ${naked} 处`);
  /* 函数内恰好两个分支：带引号 / 不带引号。写成 1 会误判 ——
     而"函数外还有裸拼接"才是真问题，那由上一条断言守着。 */
  t('函数内恰好两个分支（带引号 / 不带引号）',
    (sys.match(/format!\("IconResource=/g) || []).length === 2);
}

console.log('\n=== 2. 引号规则 ===');
{
  /* 注释写在函数**前面**，从 `fn` 起切会把注释切掉、断言静默失败。
     用 testkit 的 sliceWithDoc（它专门治这个坑，往上回溯到注释块起点）。 */
  const fn = sliceWithDoc(
    sys,
    'fn build_icon_resource_line',
    '#[cfg(windows)]',
  );
  t('空格触发引号', /file\.contains\(' '\)/.test(fn));
  t('逗号也触发引号', /file\.contains\(','\)/.test(fn));
  t('带引号格式 = "path",index', /IconResource=\\"\{file\}\\",\{index\}/.test(fn));
  t('不带引号格式 = path,index', /IconResource=\{file\},\{index\}/.test(fn));
  t('注释说明"静默失效"', /静默失效/.test(fn));
  t('注释说明"只在需要时才加引号"', /只在需要时才加引号/.test(fn));
  t('注释说明逗号为何也要加引号', /加了引号后分隔符就是最后一个逗号/.test(fn));
}

console.log('\n=== 3. 两个入口都走了这个函数 ===');
{
  /* 入口一：ini 不存在时新建整份 */
  t('新建分支调用它', /None => format!\(\s*"\[\.ShellClassInfo\]\\r\\n\{\}\\r\\n",\s*build_icon_resource_line/.test(sys));
  /* 入口二：ini 已存在时合并进 [.ShellClassInfo] */
  t('合并分支调用它', /merge_icon_line\(text, Some\(&build_icon_resource_line\(file, index\)\)\)/.test(sys));
}

console.log('\n=== 4. 原有的保护没被改坏 ===');
{
  t('仍保留合并式修改（不吃掉 [LocalizedFileNames]）',
    /保留其余所有内容/.test(sys));
  t('读取失败仍放弃写入（#510）', /宁可什么都不做，也不覆盖未知内容/.test(sys));
  t('文件夹只清 +s、绝不动 +h（#515）', /绝不动 \+h/.test(sys));
  t('仍按 BOM 精确判定编码（#521）', /按 BOM \*\*精确\*\*判定编码/.test(sys));
  t('ini 本身仍 +h +s（隐藏它）', /attrib", &\["\+h".*, "\+s"/.test(sys) || /\+"\.\.\." \+h/.test(sys) || /\+h/.test(sys));
}

done();
