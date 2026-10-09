/**
 * 连锁动作「模板为空」：预览与发送必须用同一道判据（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/chain-preview-empty-test.mjs
 *
 * 自定义动作（builtin 为空）且 project / group 两侧模板都没写时，
 * `resolve_prompt` 返回**空串**。
 *
 * 发送侧（`fpx_chain_send_action`）拦住了：空文本 → Err「该动作还没有指令模板」。
 * 而预览侧（`fpx_chain_preview`）此前**没有这道守卫**，于是同一个动作在两个入口
 * 给出两种说法：
 *
 *   · 右键菜单（走发送）→ 明确提示「还没有指令模板，请先在设置里填写」
 *   · 侧边栏 / 快捷键（走预览）→ 预览成功返回一个**空串**，
 *     确认框打开就是一片空白，而「确认发送」按钮因 `!draft.trim()` 灰着
 *     —— 用户不知道为什么点不了，也不知道该去哪儿补。
 *
 * 两个入口在界面上看起来毫无区别，说法却不一样；而预览那段代码顶上的注释
 * 还写着「与 fpx_chain_send_action 用同一套解析」—— 注释承诺了代码没做的事。
 *
 * 这一节专门钉住：**判据只有一份**（常量 + 共用函数），两处都调它。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { stripCommentsJs as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const { t, done } = makeT();

const R = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const chainSrc = strip(R('src-tauri/src/fpx/chain.rs'));
const modSrc = strip(R('src-tauri/src/fpx/mod.rs'));
const dlg = strip(R('plugins/project-group/components/ChainConfirmDialog.tsx'));

/* ---------- 1. 判据只有一份：常量 + 共用函数，两处都调它 ---------- */

const MSG_RE = /const EMPTY_TEMPLATE_ERR:\s*&str\s*=\s*"([^"]*)"/;
const mMsg = chainSrc.match(MSG_RE);
t('chain.rs 里定义了模板为空的统一文案常量', !!mMsg, mMsg ? mMsg[1] : '(没找到)');
const MSG = mMsg ? mMsg[1] : '';

/* 文案字面量在整份 Rust 里只能出现一次（就在那个常量上）。
   两处各写一遍字符串的话，改一处漏一处的表现就是"确认框与实发对不上"。 */
const allRust = ['src-tauri/src/fpx/chain.rs', 'src-tauri/src/fpx/mod.rs']
  .map((p) => strip(R(p))).join('\n');
const hits = allRust.split(MSG).length - 1;
t(`文案字面量在 Rust 侧只出现一次（当前 ${hits}）`, hits === 1, `命中 ${hits} 次`);

t('mod.rs 里不再内联这句文案（反面证据）', !modSrc.includes(MSG), modSrc.includes(MSG) ? '仍在' : '已移除');

const calls = chainSrc === undefined ? 0 : modSrc.split('chain::non_empty_text(').length - 1;
t(`mod.rs 两个入口都调 chain::non_empty_text（当前 ${calls} 处）`,
  calls === 2, `调用 ${calls} 处`);

/* 两个调用点各自包住哪个 match：发送侧与预览侧必须**都**被守卫包住。
   只按"文件里有两次调用"判，撤掉其中一处仍能凑够两次（另一处重复调用），
   所以这里按"守卫包住的文本分支"分别定位。 */
const sendFn = (() => {
  const i = modSrc.indexOf('pub fn fpx_chain_send_action');
  const j = modSrc.indexOf('pub fn fpx_chain_preview');
  return i >= 0 && j > i ? modSrc.slice(i, j) : '';
})();
const prevFn = (() => {
  const i = modSrc.indexOf('pub fn fpx_chain_preview');
  return i >= 0 ? modSrc.slice(i, i + 4000) : '';
})();
t('能定位到 fpx_chain_send_action', sendFn.includes('fpx_chain_send_action'));
t('能定位到 fpx_chain_preview', prevFn.includes('fpx_chain_preview'));
t('发送侧的空文本走共用守卫', /chain::non_empty_text\(match prompt/.test(sendFn));
t('预览侧的空文本也走共用守卫', /chain::non_empty_text\(match prompt/.test(prevFn));

/* ---------- 2. 守卫跑真身 ---------- */

const guardBody = (() => {
  const i = chainSrc.indexOf('pub fn non_empty_text');
  if (i < 0) return '';
  const m = chainSrc.slice(i).match(/pub fn non_empty_text\([^)]*\)\s*->\s*Result<String,\s*String>\s*\{([\s\S]*?)\n\}/);
  return m ? m[1] : '';
})();
t('切到 non_empty_text 的函数体', guardBody.length > 0 && guardBody.includes('EMPTY_TEMPLATE_ERR'));

const guardJs = guardBody
  /* Rust 的 `if 条件 {` 没有括号，JS 必须有 —— 只补这一处形状 */
  .replace(/if\s+([^{}\n]+?)\s*\{/g, 'if ($1) {')
  .replace(/text\.trim\(\)\.is_empty\(\)/g, "text.trim() === ''")
  .replace(/return Err\(EMPTY_TEMPLATE_ERR\.to_string\(\)\);/g, 'return { err: EMPTY_TEMPLATE_ERR };')
  .replace(/Ok\(text\)/g, 'return { ok: text };');

/* 改写后不该再有 Rust 残留：留着的话 new Function 要么崩、要么静默少判一步 */
t('守卫改写后没有 Rust 残留',
  !/is_empty|to_string|Err\(|Ok\(|::|&str|->/.test(guardJs), guardJs.trim().slice(0, 80));

if (guardJs && !/is_empty|to_string|Err\(|Ok\(|::|->/.test(guardJs)) {
  // eslint-disable-next-line no-new-func
  const guard = new Function('text', 'EMPTY_TEMPLATE_ERR', guardJs);
  const r1 = guard('', MSG);
  t('空串被拦下，且给的是统一文案', r1 && r1.err === MSG, JSON.stringify(r1));
  const r2 = guard('   \n\t ', MSG);
  t('纯空白也被拦下（不是只判 length===0）', r2 && r2.err === MSG, JSON.stringify(r2));
  const r3 = guard('请处理 {项目路径}', MSG);
  t('非空文本原样放行', r3 && r3.ok === '请处理 {项目路径}', JSON.stringify(r3));
}

/* ---------- 3. 什么输入才会走到这道守卫（跑真身） ---------- */

/*
 * 只有**自定义动作**（builtin 为空）且两侧模板都没写，才会解析出空串。
 * 内置动作即使没自定义模板，也会回落到内置默认 —— 所以这道守卫
 * 不会误伤内置动作。这一点必须验：判据放宽一点就会把内置动作也拦掉。
 */
const rpBody = (() => {
  const i = chainSrc.indexOf('pub fn resolve_prompt');
  if (i < 0) return '';
  const m = chainSrc.slice(i).match(/pub fn resolve_prompt\([^)]*\)\s*->\s*String\s*\{([\s\S]*?)\n\}/);
  return m ? m[1] : '';
})();
t('切到 resolve_prompt 的函数体', rpBody.length > 0 && rpBody.includes('resolve_prompt') === false && rpBody.includes('fill_all'));

/*
 * 机械改写（不是手写一遍判据 —— 那样验的就是我的译文而不是源码了）。
 * 逐条替换后由"没有 Rust 残留"那条兜底：源形状一变，替换就落空，
 * 残留物会被抓出来，不会静默跑一个空壳。
 */
const rpJs = rpBody
  /* `let custom = if … {} else {};` —— Rust 里 if 是表达式，JS 不是，
     换成三元（这一处只有两个分支，够用） */
  .replace(
    /let custom = if kind == "group" \{ item\.group\.as_deref\(\) \} else \{ item\.project\.as_deref\(\) \};/,
    "let custom = (kind === 'group' ? (item.group ?? '') : (item.project ?? ''));",
  )
  .replace(/custom\.unwrap_or\(""\)\.trim\(\)/g, 'custom.trim()')
  /* Rust 允许同名 `let` 遮蔽，JS 的 `let` 不行 —— 第二处改成赋值 */
  .replace(/let custom = custom\.trim\(\);/, 'custom = custom.trim();')
  /* `let tpl = if … else if … else …;` 有三个分支，换成 IIFE */
  .replace(/let tpl = if !custom\.is_empty\(\) \{/, "let tpl = (() => { if (custom !== '') {")
  .replace(/^\s*custom\s*\n(\s*)\} else if !item\.builtin\.is_empty\(\) \{/m,
    "        return custom;\n$1} else if ((item.builtin ?? '') !== '') {")
  .replace(
    /if kind == "group" \{ default_group\(&item\.builtin\) \} else \{ default_project\(&item\.builtin\) \}/,
    "return (kind === 'group' ? default_group(item.builtin) : default_project(item.builtin));",
  )
  /*
   * `return String::new();` 在 Rust 里是**从函数提前返回**（不会走到 fill_all）。
   * 换成 IIFE 后它只会从箭头函数返回，语义就变了 —— 所以这里再造一次提前返回，
   * 否则这条断言会把"返回空串"验成"返回填好的空模板"，静默跑偏。
   */
  .replace(/return String::new\(\);\s*\};/,
    "return null;\n    } })();\n    if (tpl === null) return '';")
  .replace(/fill_all\(tpl, path, data_dir\)/g, 'return fill_all(tpl, path, data_dir);');

t('resolve_prompt 改写后没有 Rust 残留',
  !/as_deref|unwrap_or|is_empty|&item|String::new|::/.test(rpJs), rpJs.trim().slice(0, 80));

if (rpJs && !/as_deref|unwrap_or|is_empty|&item|String::new|::/.test(rpJs)) {
  /* 只验"选了哪条分支"，替换细节由 fill_all 自己那一节负责，故用桩 */
  const fill = (tpl) => `FILLED<${tpl}>`;
  const default_project = (b) => `默认项目模板(${b})`;
  const default_group = (b) => `默认项目组模板(${b})`;
  // eslint-disable-next-line no-new-func
  const rp = new Function(
    'item', 'kind', 'path', 'data_dir', 'fill_all', 'default_project', 'default_group',
    rpJs,
  );
  const run = (item, kind) => rp(item, kind, 'D:/p', 'DD', fill, default_project, default_group);

  t('自定义动作两侧都空 → 解析出空串（正是要拦的那种输入）',
    run({ builtin: '', project: null, group: null }, 'project') === '');
  t('自定义动作仅 project 侧有模板 → 非空',
    run({ builtin: '', project: 'A', group: null }, 'project') === 'FILLED<A>');
  t('自定义动作 kind=group 时取 group 侧',
    run({ builtin: '', project: 'A', group: 'B' }, 'group') === 'FILLED<B>');
  t('内置动作即使没自定义模板也回落到默认（守卫不会误伤）',
    run({ builtin: 'review', project: null, group: null }, 'project') === 'FILLED<默认项目模板(review)>');
  t('内置动作 group 侧用组结构版默认',
    run({ builtin: 'review', project: null, group: null }, 'group') === 'FILLED<默认项目组模板(review)>');
}

/* ---------- 4. 后端不拦的话，用户面对的是什么 ---------- */

/*
 * 确认框的「确认发送」按钮在 draft 为空时是**灰着**的。
 * 也就是说后端一旦让空串通过预览，用户拿到的是一个空白输入框
 * 加一个点不动的按钮，全程没有一句话解释原因 —— 他只会以为按钮失灵。
 * 这条不是判据，是记录"为什么要拦"。
 */
t('确认框在文本为空时禁用发送（故空串绝不能走进弹窗）',
  /disabled=\{busy \|\| !draft\.trim\(\)\}/.test(dlg));

done();
