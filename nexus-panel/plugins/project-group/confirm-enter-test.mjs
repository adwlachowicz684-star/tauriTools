/**
 * 确认弹窗的回车（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/confirm-enter-test.mjs
 *
 * ConfirmDialog 在 window 上监听 Enter，无条件调 `onConfirm(); onClose();`。
 * 而**回车对按钮自带默认行为**（激活 = 触发它的 click），且 window 上的监听
 * 在这一步**之前**就跑完了。于是：
 *
 *   · 焦点在「取消」上按回车 → window 那次已经把删除跑了，随后才关窗；
 *     用户按的是取消，执行的却是标着 danger 的那个动作；
 *   · 焦点在「确定」上按回车 → window 一次 + 按钮默认激活一次，跑两遍。
 *
 * 两种都不报错：前者是"按了取消却真删了"，后者是"一次操作做了两遍"，
 * 而用户无从把这两件事归到"焦点当时在哪"上。
 *
 * 文本断言只能证明"源码里有 closest 这几个字"，证明不了
 * 「焦点在取消上时 onConfirm 真的没被调用」—— 所以这里把 onKey 抽出来真跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const raw = fs.readFileSync(path.join(HERE, 'components/ui.tsx'), 'utf8');
const ui = strip(raw);

/* ---------------- 1. 抽出 onKey 真身 ---------------- */

/** 从 `const onKey = (e: KeyboardEvent) => {` 起做括号配对，取到函数体结束 */
function sliceFn(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  let depth = 0;
  let j = src.indexOf('{', i);
  if (j < 0) return '';
  for (; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return src.slice(i);
}

/*
 * 锚点必须**限定在 ConfirmDialog 内**：全文件里 `const onKey = (e: KeyboardEvent) => {`
 * 首个命中是 useEscapeLayer 那份（Esc 处理），切到它会得到
 * `if (e.key !== 'Escape') return;` —— Enter 一律直接返回，
 * 于是"焦点在取消上不确认"**恒真**、而"焦点在 body 上要确认"恒假。
 * 这正是"锚点取到别处"那类空跑：看着全绿，验的根本不是这个弹窗。
 */
const cdRaw = raw.slice(raw.indexOf('export function ConfirmDialog'));
const fnSrcRaw = sliceFn(cdRaw, 'const onKey = (e: KeyboardEvent) => {');
t('切到的是确认框那份 onKey（含 onConfirm）',
  fnSrcRaw.startsWith('const onKey') && /onConfirm\(\);/.test(fnSrcRaw),
  `${fnSrcRaw.length} 字符`);

/* 可交互元素清单在组件外层（模块级），也要带过来，否则注入后会 ReferenceError */
const mInter = raw.match(/const INTERACTIVE = '([^']+)'/);
t('有可交互元素清单', !!mInter);
const INTERACTIVE = mInter ? mInter[1] : '';

/* 剥 TS：(e: KeyboardEvent) / as HTMLElement | null —— new Function 不认类型注解 */
const fnSrc = fnSrcRaw
  .replace('(e: KeyboardEvent)', '(e)')
  .replace(/e\.target as [^;,\n]+/, 'e.target');
t('剥离后没有类型注解', !/:\s*(KeyboardEvent|HTMLElement)/.test(fnSrc));

/* 组装成可执行的模块：onConfirm / onClose 从外部注入 */
let makeOnKey = null;
try {
  // eslint-disable-next-line no-new-func
  makeOnKey = new Function('INTERACTIVE', `
    return function (onConfirm, onClose) {
      ${fnSrc}
      return onKey;
    };
  `)(INTERACTIVE);
} catch (e) {
  t('onKey 可执行', false, String(e));
}
t('onKey 可执行', typeof makeOnKey === 'function');

/* ---------------- 2. 极简 DOM（够用即可）---------------- */

/** 只支持两类选择器：标签名、`[attr]` 存在性 —— 与本文件里的清单写法对应 */
function matches(el, sel) {
  const s = sel.trim();
  if (s.startsWith('[')) {
    const name = s.slice(1, -1).replace(/=.*$/, '');
    return Object.prototype.hasOwnProperty.call(el.attrs || {}, name);
  }
  return el.tag === s;
}
function closestSel(el, selector) {
  const sels = String(selector).split(',').map((x) => x.trim()).filter(Boolean);
  let cur = el;
  while (cur) {
    if (sels.some((s) => matches(cur, s))) return cur;
    cur = cur.parent;
  }
  return null;
}

let onConfirmCalls = 0;
let onCloseCalls = 0;
const win = [];
function mount(tag, parent, attrs) {
  /*
   * `closest` 要按**方法**挂：源码里是 `el?.closest?.(INTERACTIVE)`，
   * 调用时元素在 `this` 上、选择器才是唯一实参。
   * 直接把上面的两参函数挂上去的话，实参会把元素那个参数顶掉、
   * selector 拿到 undefined —— 表现为 TypeError 崩在这一行。
   */
  return {
    tag,
    parent: parent || null,
    attrs: attrs || {},
    closest(sel) { return closestSel(this, sel); },
  };
}

/** 模拟浏览器：keydown 冒泡到 window（监听器全部跑完）→ 再执行默认激活行为 */
function pressEnter(target) {
  const ev = { key: 'Enter', target, defaultPrevented: false };
  for (const fn of win) fn(ev);
  if (!ev.defaultPrevented && target.tag === 'button' && typeof target.onclick === 'function') {
    target.onclick();
  }
}

function fresh() {
  onConfirmCalls = 0;
  onCloseCalls = 0;
  win.length = 0;
  const onKey = makeOnKey(() => { onConfirmCalls += 1; }, () => { onCloseCalls += 1; });
  win.push(onKey);
  return onKey;
}

console.log('\n=== 3. 焦点在按钮上时，回车交给按钮的默认行为 ===');
{
  fresh();
  const cancel = mount('button');
  cancel.onclick = () => onCloseCalls += 1;      // 「取消」
  pressEnter(cancel);
  t('焦点在「取消」：不执行确认', onConfirmCalls === 0, `onConfirm=${onConfirmCalls}`);
  t('焦点在「取消」：只关窗一次', onCloseCalls === 1, `onClose=${onCloseCalls}`);

  fresh();
  const ok = mount('button');
  ok.onclick = () => { onConfirmCalls += 1; onCloseCalls += 1; };   // 「确定」
  pressEnter(ok);
  t('焦点在「确定」：只执行一遍', onConfirmCalls === 1, `onConfirm=${onConfirmCalls}`);
  t('焦点在「确定」：只关窗一次', onCloseCalls === 1, `onClose=${onCloseCalls}`);

  /* ✕ 只关窗，不该顺带确认 */
  fresh();
  const x = mount('button');
  x.onclick = () => onCloseCalls += 1;
  pressEnter(x);
  t('焦点在 ✕：不执行确认', onConfirmCalls === 0, `onConfirm=${onConfirmCalls}`);

  /* 目标常常是按钮内部的 <span>，不是按钮本身 —— 必须往上找 */
  fresh();
  const btn = mount('button');
  btn.onclick = () => onCloseCalls += 1;
  pressEnter(mount('span', btn));
  t('目标是按钮内的子元素：同样不接管', onConfirmCalls === 0, `onConfirm=${onConfirmCalls}`);
}

console.log('\n=== 4. 焦点不在可激活元素上时，回车仍是快捷确认 ===');
{
  fresh();
  pressEnter(mount('body'));
  t('焦点在 body：确认一次', onConfirmCalls === 1, `onConfirm=${onConfirmCalls}`);
  t('焦点在 body：关窗一次', onCloseCalls === 1, `onClose=${onCloseCalls}`);

  /* 弹窗内若有输入框，回车属于输入行为，不能拿去确认 */
  fresh();
  pressEnter(mount('textarea'));
  t('焦点在输入框：不确认', onConfirmCalls === 0, `onConfirm=${onConfirmCalls}`);
}

console.log('\n=== 5. 源码形态 ===');
{
  const cd = ui.slice(ui.indexOf('export function ConfirmDialog'));
  const next = cd.indexOf('export function', 10);
  const seg = next > 0 ? cd.slice(0, next) : cd;

  t('有可交互元素清单', /const INTERACTIVE = 'button,/.test(seg));
  t('清单含 textarea（弹窗内输入框不该被当成确认）', /textarea/.test(INTERACTIVE));
  t('判据用 closest（往上找，按钮内的子元素也算）', /closest\?\.\(INTERACTIVE\)/.test(seg));
  t('命中就直接返回', /closest\?\.\(INTERACTIVE\)\) return;/.test(seg));

  /* 顺序断言两端都要判存在：只写 `a < b` 的话，把守卫删掉仍恒真 */
  const iGuard = seg.indexOf('closest?.(INTERACTIVE)');
  const iConfirm = seg.indexOf('onConfirm();');
  t('守卫写在 onConfirm 之前', iGuard >= 0 && iConfirm > 0 && iGuard < iConfirm,
    `guard=${iGuard} confirm=${iConfirm}`);

  /* 反面证据：仍然是同一个 window 监听、仍然要关窗 */
  t('仍监听 window keydown', /window\.addEventListener\('keydown', onKey\)/.test(seg));
  t('卸载时摘监听', /window\.removeEventListener\('keydown', onKey\)/.test(seg));
  t('仍只认回车', /if \(e\.key !== 'Enter'/.test(seg));
}

done();
