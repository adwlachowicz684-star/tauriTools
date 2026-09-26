/**
 * 快捷键设置的「已自定义 N 项」计数（零覆盖区域，本文件新建）
 * ------------------------------------------------------------------
 * 测的是**判据本身**，不是"源码里有这行"。
 *
 * 起因：`已自定义 N 项` 用的是 `normalizeCombo(draft[k])` 非空，
 * 而 commit（真正决定存什么）用的是"与默认不同" —— 两套判据，
 * 界面上两个信号互相矛盾：
 *   · 取消绑定（显式空串）→ 计数 0，但「全部恢复默认」仍可点；
 *   · 改回默认值 → 计数 1，但它根本不存，保存后重开变 0。
 *
 * 所以这里跑的是**真身**：从 .tsx 里切出 customizedKeys，
 * 注入 utils/hotkeys 的真 HOTKEYS / normalizeCombo 后实际执行。
 * 只钉"源码里出现 customizedKeys"是漏报的 —— 判据写错照样通过。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT, sliceWithDoc, stripTS } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMP = path.join(HERE, 'components/HotkeySettings.tsx');
const src = fs.readFileSync(COMP, 'utf8');
const { t, fail, done } = makeT();

/** 剥掉 /** *\/ 与 // 注释后剩下的**真实代码** —— 断言只认它，避免命中说明文字 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ---------- 真身：注入真实的 HOTKEYS / normalizeCombo 后执行 ---------- */
const hk = await loadTs(path.join(HERE, 'utils/hotkeys.ts'));
const body = sliceWithDoc(src, 'export function customizedKeys', '\n}');
const fnSrc = stripTS(body)
  .replace('export function', 'function')          // new Function 装的是函数体，不是模块
  .replace(/\(d:[^)]*\)\s*:\s*string\[\]/, '(d)'); // 参数/返回类型：剥离器不认 Record<...> 嵌套
const customizedKeys = new Function(
  'HOTKEYS',
  'normalizeCombo',
  // sliceWithDoc 停在 '\n}' 之前，收尾的 '}' 要自己补
  `${fnSrc}\n}\nreturn customizedKeys;`,
)(hk.HOTKEYS, hk.normalizeCombo);

/** 取一个真实动作的 id 与它的默认键位，避免断言里写死不存在的 id */
const sample = hk.HOTKEYS[0];
const other = hk.HOTKEYS.find((h) => h.combo && h.id !== sample.id) ?? hk.HOTKEYS[1];
const defOf = (id) => hk.HOTKEYS.find((h) => h.id === id)?.combo ?? '';

t('customizedKeys 是函数（切片没切空）', typeof customizedKeys === 'function');
t('空 draft 算 0 项', customizedKeys({}).length === 0);

// 改成一个**不同**的键 → 算 1 项
t('改成新键位算 1 项',
  customizedKeys({ [sample.id]: 'ctrl+alt+z' }).length === 1);

/* 等价但写法不同（大小写 + 顺序 + 空格）→ **不算**自定义。
   这是 commit 的判据（存出去时会被剔除），计数必须跟它一致，
   否则就是"显示已自定义 1 项、实际什么都不存"。 */
const shuffled = defOf(sample.id).toUpperCase().split('+').reverse().join(' + ');
t('写法不同但等价 → 不算自定义',
  defOf(sample.id) !== shuffled && customizedKeys({ [sample.id]: shuffled }).length === 0);

/* 关键：显式空串（取消绑定）**算**自定义。
   此前 `normalizeCombo('')` 为 falsy 被排除，于是用户取消 3 个绑定
   界面显示「已自定义 0 项」，而「全部恢复默认」按钮还能点 —— 自相矛盾。 */
t('取消绑定（显式空串）算自定义',
  customizedKeys({ [sample.id]: '' }).length === 1);

// 改回默认值 → 不算
t('改回默认值不算自定义',
  customizedKeys({ [sample.id]: defOf(sample.id) }).length === 0);

// 混合：取消绑定 + 真改 + 改回默认 → 只数前两个
t('混合场景只数真正改了的',
  customizedKeys({
    [sample.id]: '',
    [other.id]: 'ctrl+alt+z',
    [hk.HOTKEYS[2].id]: defOf(hk.HOTKEYS[2].id),
  }).length === 2);

// draft 里有键但全部等价于默认 → 0
t('全部等价默认 → 0 项',
  customizedKeys({ [sample.id]: defOf(sample.id), [other.id]: defOf(other.id) }).length === 0);

/* ---------- UI 两处判据必须同源 ---------- */
t('「已自定义」用 customizedKeys',
  /已自定义\s*\{customizedKeys\(draft\)\.length\}/.test(code));
t('「全部恢复默认」的置灰判据也用它',
  /disabled=\{customizedKeys\(draft\)\.length === 0\}/.test(code));
t('commit 走同一个判据（不另写一套）',
  /for \(const k of customizedKeys\(d\)\)/.test(code));

/* 反面证据：旧判据必须彻底消失。
   只钉"存在 customizedKeys"是漏报的 —— 旧写法留在别处照样生效。 */
t('不再残留旧的「非空即算」判据',
  !/normalizeCombo\(draft\[k\]\)/.test(code));
t('不再残留 Object.keys(draft).length 置灰判据',
  !/disabled=\{Object\.keys\(draft\)\.length === 0\}/.test(code));

/* ---------- 死代码：inputRef 从不 focus 却写着「把焦点吸过去」 ---------- */
t('inputRef 已移除（注释承诺了代码没做的事）', !/inputRef/.test(src));
t('不再渲染那个从不聚焦的空容器', !/tabIndex=\{-1\}/.test(code));

/* ---------- 显式空串必须真的存出去 ---------- */
t('commit 保留显式空串（取消绑定不能丢）',
  /for \(const k of customizedKeys\(d\)\) out\[k\] = d\[k\];/.test(code)
  && customizedKeys({ [sample.id]: '' })[0] === sample.id);

done(fail);
