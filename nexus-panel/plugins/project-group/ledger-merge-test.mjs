/**
 * 账本并入（#202）· deploy_skill renamed（#94）· 工具开关两列（#131）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/ledger-merge-test.mjs
 *
 * 这三项都是"核对后发现有问题"而修的，不是从零实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));
/* 上两级才是 nexus-panel：Rust 源码不在插件目录里 */
const RS = (rel) => strip(fs.readFileSync(path.join(HERE, '../..', rel), 'utf8'));

const mod = RS('src-tauri/src/fpx/mod.rs');
const mcp = RS('src-tauri/src/fpx/mcp.rs');
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));

console.log('\n=== 1. #202 新建链接名必须**并入**，不能覆盖 ===');
{
  /*
   * 覆盖会丢掉之前已建、且磁盘上仍然存在的链接 ——
   * junction 还在，账本里却查不到，界面显示"未链接"，且没有任何报错。
   * 首次建链时原清单为空，两种写法结果相同，所以只在补充建链时暴露。
   */
  t('有 merge_link_names', /pub\(crate\) fn merge_link_names\(/.test(mod));
  t('已有记录走并入', /merge_link_names\(&mut r\.names, names\);/.test(mod));
  t('新记录也走并入（去重）', /let mut acc: Vec<String> = Vec::new\(\);/.test(mod)
    && /merge_link_names\(&mut acc, names\);/.test(mod));
  t('不再整份覆盖', !/^\s*r\.names = names;\s*$/m.test(mod));
}

console.log('\n=== 2. 去重要大小写不敏感 ===');
{
  /* Windows 下 .OpenCode 与 .opencode 是同一个目录，精确比较会漏掉真重名 */
  /*
   * 必须**限定在 merge_link_names 块内**断言：文件里另一处（跨盘判定）
   * 也用了同一个方法，全文匹配的话"把这里改成精确比较"仍会命中那一处，
   * 断言形同虚设（反向验证时才发现）。
   */
  const i = mod.indexOf('pub(crate) fn merge_link_names');
  const blk = mod.slice(i, mod.indexOf('\n}', i));
  t('用 eq_ignore_ascii_case', /eq_ignore_ascii_case/.test(blk));
  t('重复才跳过', /if !dup \{/.test(mod));
}

console.log('\n=== 3. #94 deploy_skill 同名避让 + renamed 标志 ===');
{
  /* 避让：同名就加 2、3… 后缀 */
  t('有避让循环', /while p\.exists\(\) \{/.test(mcp));
  t('后缀递增', /n = format!\("\{base_name\}\{i\}"\);/.test(mcp));
  /* renamed：调用方推不准（名字经 sanitize_name 清洗过） */
  t('返回四元组', /Result<\(String, String, String, bool\), String>/.test(mcp));
  t('renamed 由比较得出', /let renamed = final_name != base_name;/.test(mcp));
  t('返回里带 renamed', /"renamed": r\.3,/.test(mcp));
}

console.log('\n=== 4. #131 MCP 工具开关两列 ===');
{
  const seg = css.slice(css.indexOf('.fpx-toollist {'));
  const b = seg.slice(0, seg.indexOf('/* min-width'));
  t('用 grid', /display: grid;/.test(b));
  t('auto-fill + 最小宽（窄屏退回单列）', /grid-template-columns: repeat\(auto-fill, minmax\(240px, 1fr\)\);/.test(b));
  /* 硬分两列的话窄屏每项只剩半宽，等宽工具名会被截断到看不清 */
  t('不是写死两列', !/repeat\(2,/.test(b));
  /* grid 项默认 min-width:auto，长名会把轨道撑开，两列变一列半 */
  t('子项 min-width:0', /\.fpx-toollist \.fpx-check \{[^}]*min-width: 0;/.test(css));
}

done();
