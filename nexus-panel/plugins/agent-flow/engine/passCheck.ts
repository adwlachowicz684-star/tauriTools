/**
 * "这份输出算不算合格" —— 闸门与重试共用。
 *
 * 抽出来的直接原因：两者在回答同一个问题，各写一份的话
 * 以后加一种判定方式要改两处，迟早分叉。
 *
 * ============ 这里是判定方式的唯一定义处 ============
 *
 * 以前这份清单分散在五处各写一遍：
 *   types.ts（类型）、本文件的类型与 PASS_CHECK_LABEL、
 *   paramCards.ts 的 `cmp.check` options、nodeValidate.ts 里**两处**硬编码数组。
 *
 * 于是加一种判定方式要改五处，漏一处的表现是：
 *   面板上下拉里能选，圆点却报「条件取值不对」；
 *   或者节点卡片上直接显示原始英文名（因为那份标签表还没加）。
 *
 * 已经发生过一次可见的分叉：**同一取值两个中文名** ——
 * 面板下拉写「正则」（paramCards 那一份），节点卡片上写「匹配正则」
 * （PASS_CHECK_LABEL 那一份）。用户会以为是两个不同的判定方式。
 *
 * 现在全部从 PASS_CHECK_OPTIONS 派生：选项、标签、取值清单、
 * 校验用的判定、报错文案里的中文名。
 */

import type { PassCheck } from '../types';

export const PASS_CHECK_OPTIONS: { value: PassCheck; label: string; hint: string }[] = [
  { value: 'nonempty', label: '非空', hint: '有内容就行' },
  { value: 'contains', label: '包含', hint: '含有指定文本' },
  { value: 'notContains', label: '不包含', hint: '不含指定文本（如响应里没有 error）' },
  { value: 'regex', label: '正则', hint: '用正则表达式匹配' },
];

/** 取值清单（校验用） */
export const PASS_CHECK_VALUES: readonly PassCheck[] = PASS_CHECK_OPTIONS.map((o) => o.value);

/** 取值 → 中文名（节点卡片上的 tag 用） */
export const PASS_CHECK_LABEL: Record<string, string> = Object.fromEntries(
  PASS_CHECK_OPTIONS.map((o) => [o.value, o.label]),
);

/** 这个取值是不是合法判定方式 */
export function isPassCheck(v: unknown): v is PassCheck {
  return PASS_CHECK_VALUES.includes(String(v ?? '') as PassCheck);
}

/**
 * 报错文案里用的中文名。
 *
 * 以前校验器直接把 `notContains` 拼进提示里，用户看到的是
 * 「选了「notContains」但没填比对值」—— 那是内部取值，不是界面上的说法。
 */
export function passCheckLabel(v: unknown): string {
  return PASS_CHECK_LABEL[String(v ?? '')] ?? String(v ?? '');
}

export type CheckResult = { ok: boolean; reason: string | null };

/**
 * 判定。
 *
 * 正则写错时**不抛异常** —— 那是用户填的表达式，
 * 抛了会变成一个看不懂的失败；这里当成"不匹配"，并在 reason 里说清。
 */
export function checkPass(text: string, check: string, value: string): CheckResult {
  const t = text ?? '';

  if (check === 'nonempty') {
    return t.trim().length > 0
      ? { ok: true, reason: null }
      : { ok: false, reason: '内容为空' };
  }

  if (check === 'contains') {
    if (!value) return { ok: false, reason: '没填要比对的文本' };
    return t.includes(value)
      ? { ok: true, reason: null }
      : { ok: false, reason: `不包含「${value}」` };
  }

  if (check === 'notContains') {
    if (!value) return { ok: false, reason: '没填要比对的文本' };
    return !t.includes(value)
      ? { ok: true, reason: null }
      : { ok: false, reason: `包含了「${value}」` };
  }

  // regex
  if (!value) return { ok: false, reason: '没填正则表达式' };
  let re: RegExp;
  try {
    re = new RegExp(value);
  } catch {
    return { ok: false, reason: `正则写错了：${value}` };
  }
  return re.test(t)
    ? { ok: true, reason: null }
    : { ok: false, reason: `不匹配正则 ${value}` };
}
