/**
 * "这份输出算不算合格" —— 闸门与重试共用。
 *
 * 抽出来的直接原因：两者在回答同一个问题，各写一份的话
 * 以后加一种判定方式要改两处，迟早分叉。
 */

export type PassCheck =
  | 'nonempty'
  | 'contains'
  | 'notContains'
  | 'regex';

export const PASS_CHECK_LABEL: Record<PassCheck, string> = {
  nonempty: '非空',
  contains: '包含',
  notContains: '不包含',
  regex: '匹配正则',
};

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
