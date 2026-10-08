/**
 * 连锁预览的「临时覆盖」分支：确认框看到的与发出去的必须是同一句
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/chain-preview-override-test.mjs
 *
 * ## 这一条为什么值得单开一个文件
 *
 * `fpx_chain_send_action` 有两个分支：`prompt`（临时覆盖）非空走 `fill_all`，
 * 否则走 `resolve_prompt`。而 `fpx_chain_preview` 此前**没有 prompt 参数**，
 * 一律只走 `resolve_prompt`；前端又写了
 *
 *     const text = override.trim() || await api.chainPreview(...)
 *
 * —— 用户一改动指令框，后端预览就被短路掉了，确认弹窗显示的是**没替换占位符
 * 的原文**。
 *
 * 而指令框的标签上明写着「{path} / {name} 会替换」，也就是**鼓励手写占位符**。
 * 于是：
 *   · 确认框里看到「请分析 {项目名称}」
 *   · 真发出去的是「请分析 我的项目」
 *
 * 这正是 #43 那条注释写明"等于没确认"的那一幕 —— 只不过这次的模板原文
 * 是他自己刚敲的。**确认的意义在于"看到的"与"发出的"是同一份**，
 * 两边只要有一边不走后端替换，这份保证就没了。
 *
 * ## 断言的写法要点
 *
 * 只断言"源码里有 prompt 这几个字"是不够的：
 *   · 它可能加了参数却**不用**（那等于没加）；
 *   · 它可能两个分支只写了一个（覆盖了走 fill_all，模板却走错路）；
 *   · 前端可能仍然短路（后端修了、界面照旧显示原文 —— 用户看到的还是错的）。
 * 所以既钉后端两个分支，也钉前端不再短路，还把**两侧判据逐字比对**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { stripCommentsFlatJs } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const { t, done } = makeT();

/**
 * 剥注释后再判：本文件自己的说明里就写着 `fill_all` / `override.trim()`
 * 这些字样，不剥的话"反面证据"那几条会被注释喂饱、恒真。
 */
const mod = stripCommentsFlatJs(fs.readFileSync(path.join(ROOT, 'src-tauri/src/fpx/mod.rs'), 'utf8'));
const apiSrc = stripCommentsFlatJs(fs.readFileSync(path.join(HERE, 'api.ts'), 'utf8'));
const panel = stripCommentsFlatJs(fs.readFileSync(path.join(HERE, 'components/ToolsPanel.tsx'), 'utf8'));

/** 按 `pub fn 名(` 起、下一个同级 `pub fn ` 止，切出函数体 */
function bodyOf(src, name) {
  const i = src.indexOf(`pub fn ${name}(`);
  if (i < 0) return '';
  const j = src.indexOf('\npub ', i + 1);
  return src.slice(i, j < 0 ? src.length : j);
}

const preview = bodyOf(mod, 'fpx_chain_preview');
const sendAction = bodyOf(mod, 'fpx_chain_send_action');

/* ---------------------- 1. 两个函数都切到了 ---------------------- */

t('切到了 fpx_chain_preview', preview.includes('pub fn fpx_chain_preview'));
t('切到了 fpx_chain_send_action', sendAction.includes('pub fn fpx_chain_send_action'));

/* ---------------- 2. 预览有 prompt 参数，且真的用了 ---------------- */

t('预览收 prompt 形参', /prompt:\s*Option<String>/.test(preview), preview.slice(0, 80));

/** 取出 `let text = match ... };` 这段（按大括号配平） */
function textBlock(body) {
  const i = body.indexOf('let text = match');
  if (i < 0) return '';
  let d = 0, j = body.indexOf('{', i);
  const from = j;
  for (; j < body.length; j++) {
    if (body[j] === '{') d++;
    else if (body[j] === '}' && --d === 0) return body.slice(i, j + 2);
  }
  return body.slice(i, from + 40);
}

const pvBlock = textBlock(preview);
const saBlock = textBlock(sendAction);

t('预览取到了 let text 块', pvBlock.startsWith('let text = match'), pvBlock.slice(0, 40));
t('发送取到了 let text 块', saBlock.startsWith('let text = match'), saBlock.slice(0, 40));

t('预览：覆盖非空走 fill_all', /=>\s*chain::fill_all\(/.test(pvBlock), pvBlock);
t('预览：否则走 resolve_prompt', /=>\s*chain::resolve_prompt\(/.test(pvBlock), pvBlock);
t('预览：判据是覆盖 trim 后非空', /!p\.is_empty\(\)/.test(pvBlock), pvBlock);

/* ---------------- 3. 两侧判据逐字相同（不是"看起来一样"） ---------------- */

/**
 * 归一化：先去掉借用符号 `&` 再比。
 *
 * 两处实参只有借用差别 —— 预览里 `item` 是 `&ChainActionItem`（取自 find），
 * 发送里是 clone 出来的值、要写 `&item`。那是 Rust 的借用，不是判据差别，
 * 不归一化的话这条会**恒假**（两侧明明同一套判据却永远对不上）。
 */
const norm = (s) => s.replace(/\s+/g, ' ').replace(/&(\w+)/g, '$1').trim();
t('预览与发送的解析块逐字相同（归一化借用后）', norm(pvBlock) === norm(saBlock),
  `pv=${norm(pvBlock).slice(0, 60)} | sa=${norm(saBlock).slice(0, 60)}`);

/* ---------------- 4. 预览仍要有路径收口 ---------------- */

t('预览仍有路径收口', /guard::must_be_under\(&path/.test(preview));

/* ---------------- 5. 真身：覆盖分支确实走 fill_all ---------------- */

/**
 * 机械改写：`match X { Some(p) if !p.is_empty() => A, _ => B };`
 * → JS 三元。改写本身若没匹配上就返回 null，测试会**响**，
 * 不会静默产出一段空代码（静默 = 假绿）。
 */
function toJs(block) {
  const m = block.match(
    /match\s+prompt\.as_deref\(\)\.map\(str::trim\)\s*\{\s*Some\(p\)\s+if\s+!p\.is_empty\(\)\s*=>\s*([\s\S]*?),\s*_\s*=>\s*([\s\S]*?),\s*\};?\s*$/
  );
  if (!m) return null;
  /* 去掉 Rust 的借用符号 `&`：JS 没有引用，留着直接 SyntaxError。
     （别用 replace 去改语义，这里只是把 `&x` 还原成 `x`。） */
  const bare = (s) => s.replace(/&(\w+)/g, '$1');
  return {
    fill: bare(m[1]).replace(/chain::fill_all\(/g, 'F('),
    tmpl: bare(m[2]).replace(/chain::resolve_prompt\(/g, 'R('),
  };
}

const arms = toJs(pvBlock);
t('改写匹配上了（没匹配上就是假绿的前兆）', arms !== null);
if (arms) {
  const run = new Function('prompt', 'item', 'kind', 'path', 'dir_str', 'F', 'R', `
    const p = prompt == null ? null : String(prompt).trim();
    return (p !== null && p !== '') ? (${arms.fill}) : (${arms.tmpl});
  `);
  const F = (tpl, p, d) => `F:${tpl}|${p}`;
  const R = (it, k, p, d) => `R:${it}|${k}`;
  /* run 的形参是 (prompt, item, kind, path, dir_str, F, R) —— F/R 是**替身**，
     必须一起传进去；漏传的话调用到 undefined，直接 TypeError 崩在半路，
     把后面几条断言全吃掉（这正是"会崩的测试脚本比写错的断言更危险"）。 */
  const go = (prompt) => run(prompt, 'itemA', 'group', '/x/y', 'D', F, R);
  t('有覆盖 → 走 fill_all（占位符会被替换）',
    go('请分析 {项目名称}') === 'F:请分析 {项目名称}|/x/y');
  t('无覆盖 → 走 resolve_prompt（模板原文）',
    go(null) === 'R:itemA|group');
  t('覆盖只有空格 → 仍走模板',
    go('   ') === 'R:itemA|group');
  t('覆盖为空串 → 仍走模板',
    go('') === 'R:itemA|group');
}

/* ---------------- 6. 前端：api.chainPreview 把覆盖传下去 ---------------- */

t('api.chainPreview 收 prompt 形参', /chainPreview:\s*\(actionId[^)]*prompt\?: string \| null/.test(apiSrc), apiSrc.slice(0, 60));
t('api.chainPreview 把 prompt 传进命令', /fpx_chain_preview',\s*\{[\s\S]{0,120}prompt:\s*prompt \?\? null/.test(apiSrc));

/* ---------------- 7. 前端：确认前不再短路后端预览 ---------------- */

t('ToolsPanel 不再用 override.trim() || 短路预览', !/override\.trim\(\)\s*\|\|/.test(panel), panel.slice(0, 60));
t('ToolsPanel 预览一律走后端', /await api\.chainPreview\(actionId,\s*kind,\s*target,\s*override \|\| null\)/.test(panel), panel.slice(0, 60));

/* ---------------- 8. 兜底：其它调用点（无覆盖）不被漏改 ---------------- */

const hook = stripCommentsFlatJs(fs.readFileSync(path.join(HERE, 'hooks/useChainActions.ts'), 'utf8'));
t('useChainActions 仍走后端预览（无覆盖分支）', /api\.chainPreview\(actionId,\s*kind,\s*path\)/.test(hook), hook.slice(0, 60));

/** 全仓扫：凡是调用 chainPreview 的地方，都不得出现在 `||` 短路里 */
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
})(HERE);
let callers = 0;
for (const f of files) {
  const s = stripCommentsFlatJs(fs.readFileSync(f, 'utf8'));
  for (const m of s.matchAll(/.{0,40}chainPreview\(/g)) {
    callers++;
    t(`调用点不在 || 短路里（${path.basename(f)}）`, !/(\|\||&&)\s*$/.test(m[0].slice(0, m[0].indexOf('chainPreview') === 0 ? 0 : m[0].indexOf('chainPreview'))),
      m[0]);
  }
}
t('至少找到 2 个 chainPreview 调用点', callers >= 2, `找到 ${callers}`);

done();
