/**
 * MCP create_folder 登记回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/mcp-create-folder-test.mjs，然后
 *         node plugins/project-group/mcp-create-folder-test.mjs
 *
 * S3：create_folder 此前只建目录、不登记到页签，而它的**工具描述里没说** ——
 * AI 建完以为完事了，结果界面上根本看不到。
 *
 * 这里守三件容易做错的事：
 *   · 越界**先查再建**（目录建出来就回滚不了了，序号填错不该留下孤儿）
 *   · 登记逻辑与 add_card **共用同一份**（两份实现迟早分叉：
 *     一个报越界、另一个静默改到别处）
 *   · 不传 kind 时保持旧行为（只建目录），不能悄悄改变语义
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '../../src-tauri/src/fpx/mcp.rs');
const { t, done } = makeT();

if (!fs.existsSync(RS)) {
  console.log('（跳过：未找到 mcp.rs）');
  done();
}
const rs = fs.readFileSync(RS, 'utf8');

/** 取 create_folder 分支的源码 */
const branch = rs.slice(rs.indexOf('"create_folder" => {'),
                        rs.indexOf('"add_card" => {'));
/** 取 add_card 分支的源码 */
const addCard = rs.slice(rs.indexOf('"add_card" => {'),
                         rs.indexOf('"set_lock" => {'));
/**
 * 取共用辅助函数区（tab_count_of / oob_msg / register_card）。
 * 边界用**稳定的命名锚点**，不用"下一个 let"这种会随插入顺序变的位置。
 */
const helpers = rs.slice(rs.indexOf('fn tab_count_of('), rs.indexOf('let within_raw'));
const reg = rs.slice(rs.indexOf('fn register_card('), rs.indexOf('let within_raw'));

console.log('\n=== 1. 共用同一份登记逻辑（核心）===');
t('register_card 存在', /fn register_card\(/.test(rs));
t('add_card 调 register_card', /register_card\(&dir, &kind, &path, tab_index\)/.test(addCard));
t('create_folder 也调 register_card', /register_card\(&dir, k, &p, tab_index\)/.test(branch));
{
  /* 反面证据：两个分支里都不该再有自己那份"越界判断 + push" */
  const dup = [...rs.matchAll(/\.items\.push\(/g)].length;
  t('items.push 只有一处（都在 register_card 里）', dup === 1, `${dup} 处`);
  const oob = [...rs.matchAll(/tab_index \{i\} 越界/g)].length;
  t('越界提示文案只有一处（共用 oob_msg）', oob === 1, `${oob} 处`);
}

console.log('\n=== 2. 越界先查再建（防孤儿目录）===');
{
  const createCall = branch.indexOf('core_create_folder');
  const preCheck = branch.indexOf('tab_count_of');
  /* 两端都判（>= 0 而非 > -1，写法统一）：createCall 找不到时
     `preCheck < -1` 恒假（脆断），少判 preCheck 那端则恒真（空跑） */
  t('建目录之前有预检', preCheck >= 0 && createCall >= 0 && preCheck < createCall,
    `预检@${preCheck} 建目录@${createCall}`);
  t('预检只在给了 kind 时才做', /if let \(Some\(k\), Some\(i\)\) = \(&kind, tab_index\)/.test(branch));
  t('预检失败直接返回、不往下建', branch.slice(preCheck, createCall).includes('return Err'));
  t('空清单按 1 个页签算（登记时会自动补「默认」）',
    /if n == 0 \{ 1 \} else \{ n \}/.test(helpers));
  t('预检与登记共用同一份越界文案', /oob_msg/.test(branch) && /oob_msg/.test(reg));
}

console.log('\n=== 3. kind 校验 ===');
{
  t('kind 只认 project / group',
    /"project" \| "group" => Some\(kind_raw\.clone\(\)\)/.test(branch));
  t('其它值报错而非静默当 project 处理',
    /kind 只能是 project 或 group/.test(branch));
  t('空串 = 不传（保持旧行为）', /"" => None,/.test(branch));
  t('不传 kind 时只建目录、返回路径',
    branch.trimEnd().endsWith('json!({ "content": [{ "type": "text", "text": p }] })\n        }')
    || /json!\(\{ "content": \[\{ "type": "text", "text": p \}\] \}\)/.test(branch));
}

console.log('\n=== 4. 登记失败要如实报出（目录已建是既成事实）===');
{
  t('登记失败时提示里带上已创建的路径',
    /已创建 \{p\}，但登记到页签失败：\{e\}/.test(branch));
  t('登记成功时说明加进了哪个页签',
    /已创建 \{p\} 并加入页签「\{tab_name\}」/.test(branch));
  t('已存在时不重复添加（提示措辞区分）',
    /已创建 \{p\}（它本就已在页签「\{tab_name\}」中）/.test(branch));
}

console.log('\n=== 5. 工具描述与参数 ===');
{
  const decl = rs.slice(rs.indexOf('tool("create_folder"'), rs.indexOf('tool("add_card"'));
  t('描述里说明"不传 kind 则不会出现在界面上"',
    /需再调 add_card 才会出现在界面上/.test(decl));
  t('schema 有 kind', /"kind": \{[^}]*"enum": \["project", "group"\]/.test(decl));
  t('schema 有 tab_index', /"tab_index"/.test(decl));
  t('tab_index 说明写了"仅在给了 kind 时有效"',
    /仅在给了 kind 时有效/.test(decl));
  t('必填仍只有 parent / name（不破坏旧调用）',
    /vec!\["parent", "name"\]/.test(decl));
  t('hierarchy 仍在（没被 kind 顶掉）', /"hierarchy"/.test(decl));
  /* kind 与 hierarchy 是两个不同的东西，混用会建出错误层级 */
  t('注释提醒 hierarchy 是页签名、不是 kind',
    /hierarchy 是页签名，不是 kind/.test(branch));
}

console.log('\n=== 6. add_card 行为未变 ===');
{
  t('add_card 仍要求 path 必填', /if path\.is_empty\(\)/.test(addCard));
  /* 先剥注释再看代码：add_card 的注释里就写着"as_i64 会收下负数"，
     不剥注释的话这条永远判失败 —— 注释里出现某个词不等于代码里用了它 */
  const addCardCode = addCard.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  t('add_card 仍用 as_u64 取 tab_index（挡掉负数）',
    /as_u64/.test(addCardCode) && !/as_i64/.test(addCardCode));
  t('add_card 的返回文案未变',
    /已在页签「\{tab_name\}」中，未重复添加/.test(addCard)
    && /已把 \{path\} 加入页签「\{tab_name\}」/.test(addCard));
}

console.log('\n=== 7. register_card 本身 ===');
{
  t('过黑名单（防止登记系统目录）', /reject_forbidden_raw/.test(reg));
  t('走事务（with_config）', /with_config/.test(reg));
  t('空清单自动补「默认」页签', /tabs\.is_empty\(\)/.test(reg));
  t('越界报错带有效范围', /有效范围 0\.\./.test(helpers));
  t('登记时的越界走 oob_msg（不另写一份）', /oob_msg\(kind, i, tabs\.len\(\)\)/.test(reg));
}

done();
