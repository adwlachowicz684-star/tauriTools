/**
 * Esc 的输入法（IME）组合守卫：会吞掉用户已填内容的那几处
 * ============================================================
 * 运行：node ime-esc-guard-test.mjs
 *
 * `js/ime.js` 里那份说明的**第 4 条**早就写明了这个后果：
 *
 *   组合期按 Esc 只是取消候选词，界面却把它当成「取消整个操作」——
 *   打了一半的内容连带输入框一起没了。
 *
 * 但前两轮的守卫是按「回车」那条线装的（`ime-guard-cross-plugin-test.mjs`
 * 的兜底扫描只扫含 `'Enter'` 的 keydown 块），**Esc 这条线一直没人扫**。
 * 于是下面六处 —— 每一处里面都是插件自己的输入框 —— 全部裸奔：
 *
 *   1. js/shell.js：原生壳的插件设置抽屉（window 级，顺带吃掉壳快捷键）
 *   2. src/components/PluginSettingsDrawer.tsx：React 壳的同一个抽屉
 *   3. src/components/AddPluginDialog.tsx：添加插件（插件名称多半就是中文）
 *   4. src/components/Dialog.tsx：React 通用弹窗（捕获阶段，罩住所有 <Dialog>）
 *   5. plugins/agent-flow/components/ArgCell.tsx：卡片上的参数编辑格
 *   6. plugins/folder-picker/module.js：选目录浮层的 Esc（→ cancel）
 *
 * 共同点是**不报错**：用户以为自己在退候选词，界面却把整个操作取消了，
 * 他只会觉得"刚填的东西怎么没了"。第 6 处更隐蔽——浮层关掉、Promise
 * resolve 成 null，调用方于是"什么都不做、也不提示"。
 *
 * 本测试分三层：
 *   1. 源码形态：六处都有守卫，且守卫在 Escape 分支**之前**；
 *   2. 真身：把守卫那条语句抽出来，注入 `js/ime.js` 的真判据实跑
 *      （含"必须读 nativeEvent"这一条——读错对象守卫会静默失效）；
 *   3. 兜底扫描：全仓每个 `key === 'Escape'` 分支，除显式列出的
 *      「这处没有输入框」清单外都必须有守卫。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { stripCommentsJs as strip } from './test-scan-utils.mjs';
import { isComposing } from './js/ime.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const rd = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } };
const code = (p) => strip(rd(p));

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

/* ── 工具：从源码里切出含 isComposing 的那条语句 ─────────────── */
function sliceStmt(src, idx) {
  // 形式 A：`if (isComposing(e)) return;` —— 单行即整条语句
  const ls = src.lastIndexOf('\n', idx) + 1;
  const le = src.indexOf(';', idx);
  if (le > 0 && src.slice(ls, le + 1).trim().startsWith('if (')) {
    return { src: src.slice(ls, le + 1).trim(), form: 'A' };
  }
  // 形式 B：守卫写进 `if (!isComposing(e) && ...)` —— 取外层箭头函数
  const start = src.lastIndexOf('const ', idx);
  if (start < 0) return { src: '', form: '?' };
  let i = src.indexOf('(', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '{' && depth === 0) break;
  }
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return { src: src.slice(start, j + 1), form: 'B' }; }
  }
  return { src: '', form: '?' };
}

/* 剥掉 TS 类型标注（`: KeyboardEvent` 等），让语句能直接进 new Function */
const detype = (s) => s.replace(/:\s*KeyboardEvent\b/g, '').replace(/:\s*any\b/g, '');

/** 把守卫语句变成可实跑的函数；返回 null 表示切不出来 */
function makeFn(stmtSrc, form) {
  /*
   * 两种形态切出来的东西不同，都得补上"调用"这一截，否则：
   *   · A 只有守卫那一行 —— 后面真正关闭的那句不在切片里，非组合时
   *     永远测不到"关闭了"；
   *   · B 切出来的是箭头函数**定义** —— 不调它，onClose 一次都不会跑，
   *     于是"非组合的 Esc 照常关闭"恒假（看着在跑，其实没验到）。
   */
  const name = (/const\s+(\w+)\s*=/.exec(stmtSrc) || [])[1];
  const body = form === 'A'
    ? detype(stmtSrc).replace(/return\s*;/, "return 'G';") + "\n onClose();\n return 'P';"
    : detype(stmtSrc) + `\n ${name}(e);\n return 'P';`;
  try {
    return new Function('isComposing', 'e', 'onClose', 'cancel', 'setDraft', body);
  } catch { return null; }
}

/* ── 1. 源码形态：有守卫、且在 Escape 分支之前 ────────────────── */
console.log('\n=== 1. 六处调用点：守卫存在且位于 Escape 分支之前 ===');

const TARGETS = [
  { file: 'js/shell.js', label: '原生壳抽屉（window keydown）' },
  { file: 'src/components/PluginSettingsDrawer.tsx', label: 'React 壳插件设置抽屉' },
  { file: 'src/components/AddPluginDialog.tsx', label: '添加插件对话框' },
  { file: 'src/components/Dialog.tsx', label: 'React 通用弹窗' },
  { file: 'plugins/agent-flow/components/ArgCell.tsx', label: 'agent-flow 参数编辑格' },
  /*
   * 这一处必须给锚点：module.js 里前面还有三处 isComposing（新建子目录、
   * 地址栏、改名），只按"第一次出现"取会切到它们身上 —— 于是撤掉 onEsc
   * 的守卫，四条守卫断言照样全绿（只有兜底扫描会红）。这类"锚点落在
   * 另一处同形状代码上"是最会装作通过的一类。
   */
  { file: 'plugins/folder-picker/module.js', label: 'folder-picker 选目录浮层 Esc', anchor: 'const onEsc =' },
];

const sliced = {};
for (const tg of TARGETS) {
  const src = code(tg.file);
  t(`${tg.label}：文件可读`, src.length > 0);
  /* 必须是**调用点**的 isComposing —— 用 indexOf('isComposing') 会先命中
     import 那一行，于是"有守卫"恒真、切片落在 import 上（本项目第 N 次
     栽在"锚点命中注释/导入"） */
  const from = tg.anchor ? src.indexOf(tg.anchor) : 0;
  t(`${tg.label}：锚点找得到`, from >= 0);
  const gm = /\bisComposing\s*\(/.exec(src.slice(from));
  const gi = gm ? from + gm.index : -1;
  t(`${tg.label}：有守卫（调用点）`, gi >= 0);
  const ei = src.indexOf("'Escape'", from);
  t(`${tg.label}：守卫在 Escape 分支之前`, gi >= 0 && ei >= 0 && gi < ei);
  const st = gi >= 0 ? sliceStmt(src, gi) : { src: '', form: '?' };
  t(`${tg.label}：守卫语句切得出来`, st.src.length > 0 && st.form !== '?');
  sliced[tg.file] = st;
}

/* ── 2. 真身：注入真判据实跑守卫 ──────────────────────────────── */
console.log('\n=== 2. 真身行为：组合中的 Esc 不得触发关闭 ===');

/* 组合中的两种形态：标准属性 / 只有 keyCode 229 */
const COMPOSED = [
  { isComposing: true, key: 'Escape', nativeEvent: { isComposing: true, key: 'Escape' } },
  { keyCode: 229, key: 'Escape', nativeEvent: { keyCode: 229, key: 'Escape' } },
];
/* 非组合：这一下才真的归界面 */
const PLAIN = { isComposing: false, keyCode: 27, key: 'Escape', nativeEvent: { isComposing: false, keyCode: 27, key: 'Escape' } };

for (const tg of TARGETS) {
  const st = sliced[tg.file];
  const fn = st.src ? makeFn(st.src, st.form) : null;
  t(`${tg.label}：守卫可实跑`, !!fn);
  if (!fn) continue;

  for (const [i, ev] of COMPOSED.entries()) {
    let hit = false;
    const r = fn(isComposing, ev, () => { hit = true; }, () => { hit = true; }, () => { hit = true; });
    t(`${tg.label}：组合中 #${i + 1} → 不关闭`, hit === false && (st.form === 'B' ? r === 'P' : r === 'G'));
  }
  let hit = false;
  const r = fn(isComposing, PLAIN, () => { hit = true; }, () => { hit = true; }, () => { hit = true; });
  t(`${tg.label}：非组合的 Esc → 照常关闭`, hit === true && (st.form === 'B' ? r === 'P' : r === 'P'));
}

/* React 合成事件不转发 isComposing：读错对象守卫就静默失效。
   给一个「外层 isComposing=false、nativeEvent 组合中」的事件，
   读 nativeEvent 的那一处必须仍然拦住。 */
{
  const st = sliced['plugins/agent-flow/components/ArgCell.tsx'];
  const fn = st.src ? makeFn(st.src, st.form) : null;
  t('ArgCell：守卫写的是 e.nativeEvent', !!fn && st.src.includes('e.nativeEvent'));
  if (fn) {
    let hit = false;
    fn(isComposing, { isComposing: false, key: 'Escape', nativeEvent: { isComposing: true, key: 'Escape' } },
      () => { hit = true; }, () => { hit = true; }, () => { hit = true; });
    t('ArgCell：外层 false / nativeEvent 组合中 → 仍拦住（读的不是外层）', hit === false);
  }
}

/* ── 3. 兜底扫描：全仓 Esc 分支的守卫情况 ─────────────────────── */
console.log('\n=== 3. 兜底扫描：其余 Esc 分支 ===');

/* 显式列出「这处没有输入框，Esc 时不可能在组合中」的清单。
   写死而不是留空：谁再往里加一处，测试立刻红，逼他先判断一次。 */
const NO_INPUT_OK = [
  'js/theme-picker.js',               // 主题选择器：只有列表，没有输入框
  'js/toolbar-plugin.js',             // 下拉菜单：点开的，菜单里没有输入框
  'plugins/agent-flow/components/NodeTip.tsx', // 浮动提示：只读文案
  'plugins/color-picker/ColorPicker.tsx',      // 仅「取色待命」时挂 Esc，此时焦点不在 hex 输入框
  'plugins/md/App.tsx',               // 右键菜单
  'plugins/mindmap/tab-drag.js',      // 拖拽中按 Esc 取消拖拽
];

const exts = new Set(['.ts', '.tsx', '.js']);
const BAD = ['node_modules', '.git', 'dist', 'runtime-plugins', 'target', '.tool_output'];
const found = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (BAD.includes(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!exts.has(extname(e.name))) continue;
    /* 测试文件里出现 'Escape' 多数是断言本身，不参与 */
    if (e.name.includes('-test') || e.name.includes('.test.')) continue;
    let s = '';
    try { s = strip(readFileSync(p, 'utf8')); } catch { continue; }
    const lines = s.split('\n');
    lines.forEach((l, i) => {
      if (!/key\s*===?\s*['"]Escape['"]/.test(l)) return;
      const w = lines.slice(Math.max(0, i - 12), Math.min(lines.length - 1, i + 6)).join('\n');
      if (!w.includes('isComposing')) found.push(p.slice(ROOT.length + 1) + ':' + (i + 1));
    });
  }
})(ROOT);

const unexpected = found.filter((x) => !NO_INPUT_OK.some((k) => x.startsWith(k)));
t(`兜底：没有清单之外的裸 Esc（当前裸 ${found.length} 处，全在清单内）`, unexpected.length === 0);
if (unexpected.length) console.log('   →', unexpected.join('\n   → '));
for (const k of NO_INPUT_OK) {
  t(`清单仍在：${k} 确实无输入框（未误加守卫）`, !found.some((x) => x.startsWith(k)) === false);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
