/**
 * 连锁动作面板的两个输入相关判据（新增，此前零覆盖）。
 *
 *   1. 快捷键录入框：不许把裸键录成应用级热键
 *   2. 占位符插入：没聚焦过的模板框，插入要落到末尾而不是开头
 *
 * 两处都**跑真身**：录入处理函数从 ChainActionsPanel.tsx 里按括号配平切出来实际执行；
 * 只做"源码里有这几个字"的文本断言证明不了 Backspace 到底会不会被吃掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('❌', m); } };

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 从 `open` 处（该字符本身是 `{`）按括号配平切出函数体，返回不含外层大括号的内容 */
function sliceBody(src, open) {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(open + 1, i); }
  }
  return null;
}

/** 去掉块注释与行尾注释，避免"注释里的字样把断言喂饱" */
function stripComments(s) {
  return strip(s).replace(/^\s*\/\/.*$/gm, '');
}

/* ------------------------------------------------------------------ */
/* 1. 快捷键录入：裸键 / 退格 / 删除 / Esc 一律不录                      */
/* ------------------------------------------------------------------ */

const cap = read('components/ChainActionsPanel.tsx');

/* 修饰键名单取 utils/hotkeys.ts 的真实字面量（那里注明"全项目只此一份"） */
const hk = read('utils/hotkeys.ts');
const mkM = /export const MODIFIER_KEYS\s*=\s*(\[[\s\S]*?\]);/.exec(hk);
ok(!!mkM, 'hotkeys.ts 里应能取到 MODIFIER_KEYS');
const MODIFIER_KEYS = eval(mkM[1]);

const anchor = cap.indexOf('const parts: string[] = [];');
ok(anchor > 0, 'ChainActionsPanel 里应能定位到快捷键录入那段');
const kd = cap.lastIndexOf('onKeyDown={(e) => {', anchor);
ok(kd > 0, '应能定位到快捷键录入框的 onKeyDown');
const open = kd + 'onKeyDown={(e) => '.length;   // 指向箭头函数体的 '{'
const body = sliceBody(cap, open);
ok(!!body && body.includes('parts.join'), '切出来的应当是快捷键录入那段（含 parts.join）');

const handler = new Function(
  'e', 'patch', 'cur', 'isComposing', 'MODIFIER_KEYS',
  body.replace('const parts: string[] = [];', 'const parts = [];'),
);

/** 造一个键盘事件；返回 { patched, prevented } */
const fire = (ev) => {
  const rec = { patched: [], prevented: 0 };
  const e = {
    key: ev.key,
    ctrlKey: !!ev.ctrlKey, altKey: !!ev.altKey, shiftKey: !!ev.shiftKey, metaKey: !!ev.metaKey,
    nativeEvent: { isComposing: !!ev.composing },
    preventDefault() { rec.prevented++; },
  };
  handler(e, (id, p) => rec.patched.push(p), { id: 'a1' },
    (ne) => !!ne.isComposing, MODIFIER_KEYS);
  return rec;
};

{
  const r = fire({ key: '1', ctrlKey: true });
  ok(r.patched.length === 1 && r.patched[0].shortcut === 'Ctrl+1', `Ctrl+1 应录成 Ctrl+1（实际 ${JSON.stringify(r.patched)}）`);
}
{
  const r = fire({ key: '1', ctrlKey: true, shiftKey: true });
  ok(r.patched[0]?.shortcut === 'Ctrl+Shift+1', `Ctrl+Shift+1 应带修饰键顺序（实际 ${r.patched[0]?.shortcut}）`);
}
{
  const r = fire({ key: 'Backspace' });
  ok(r.patched.length === 0, '退格不得录成快捷键（否则任何输入框里按退格都会发一次 AI）');
  ok(r.prevented === 0, '退格必须交回输入框：preventDefault 会让它清不掉这一栏');
}
{
  const r = fire({ key: 'Delete' });
  ok(r.patched.length === 0, '删除键不得录成快捷键');
  ok(r.prevented === 0, '删除键同样要交回输入框');
}
{
  const r = fire({ key: 'Escape' });
  ok(r.patched.length === 0, 'Esc 不得录成快捷键（否则关弹窗会顺带发一次 AI）');
  ok(r.prevented === 0, 'Esc 要能继续关弹窗，不能被 preventDefault 吃掉');
}
{
  const r = fire({ key: 'a' });
  ok(r.patched.length === 0, '不带修饰键的字母键不得录成快捷键');
}
{
  const r = fire({ key: 'Control', ctrlKey: true });
  ok(r.patched.length === 0, '只按下修饰键（组合没按完）不得录成 "Ctrl"');
}
{
  const r = fire({ key: 'Tab' });
  ok(r.patched.length === 0 && r.prevented === 0, 'Tab 应放行（跳焦点）');
}
{
  const r = fire({ key: 'a', ctrlKey: true, composing: true });
  ok(r.patched.length === 0 && r.prevented === 0, '输入法组合中一律放行');
}

/* ------------------------------------------------------------------ */
/* 2. 占位符插入：没聚焦过 → 追加到末尾                                  */
/* ------------------------------------------------------------------ */

/* insertAtCursor 的真身（从 placeholders.ts 切出来剥类型后执行） */
const ph = read('utils/placeholders.ts');
const pStart = ph.indexOf('export function insertAtCursor(');
ok(pStart > 0, 'placeholders.ts 里应能定位到 insertAtCursor');
/* 注意：签名末尾带返回类型 `): { next: string; caret: number } {`，
   第一个 `{` 是返回类型而不是函数体 —— 从它后面那个 `{` 起切 */
const rb = ph.indexOf('}', ph.indexOf('{', pStart));
const pBody = sliceBody(ph, ph.indexOf('{', rb));
const insertAtCursor = new Function('value', 'selStart', 'selEnd', 'text', pBody);
ok(typeof insertAtCursor === 'function', 'insertAtCursor 应能剥类型后跑起来');
{
  const r = insertAtCursor('abc', null, null, '{p}');
  ok(r.next === 'abc{p}', `没有光标信息时应追加到末尾（实际 ${r.next}）`);
  ok(r.caret === 6, `追加后光标应在末尾（实际 ${r.caret}）`);
}
{
  const r = insertAtCursor('abc', 0, 0, '{p}');
  ok(r.next === '{p}abc', '光标在开头时确实插到开头（这是"有光标信息"的取值，不能混淆）');
}

/* PlaceholderBar：必须自己记住"聚焦过没有"，不能直接吃 selectionStart */
const pb = stripComments(read('components/PlaceholderBar.tsx'));
ok(/everFocused/.test(pb), 'PlaceholderBar 应记录"是否被聚焦过"');
ok(/addEventListener\('focus'/.test(pb), '应挂 focus 监听来得知用户点进过输入框');
ok(pb.includes('known ? el?.selectionStart ?? null : null'),
  '没聚焦过必须按 insertAtCursor 的约定传 null（追加到末尾）');
ok(pb.includes('known ? el?.selectionEnd ?? null : null'), 'selectionEnd 同样要走这个判据');
ok(!/insertAtCursor\(\s*\n?\s*value,\s*\n?\s*el\?\.selectionStart \?\? null/.test(pb),
  '不得再把 selectionStart 无条件传给 insertAtCursor（没聚焦过时它是 0，会把 token 插到开头）');

/* ------------------------------------------------------------------ */
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
