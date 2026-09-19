/**
 * 日志区保留条数的取值规则（#32）。
 *
 * 与后端 `fpx/model.rs` 的 LOG_MAX_LINES_* 一一对应 —— 两边必须同数，
 * 否则会出现"设置里填 5000、后端存回 2000、界面显示 2000"这种对不上的情况。
 */

/** 下限：再少就失去"流水"的意义，出错时看不到前因 */
export const LOG_MAX_LINES_MIN = 10;
/** 上限：每条都带时间戳且界面一次全渲染，上万条会明显拖慢 */
export const LOG_MAX_LINES_MAX = 2000;
/** 默认：与改动前的显示条数一致（原先"存 200 显示 40"，用户实际看到的就是 40） */
export const LOG_MAX_LINES_DEFAULT = 40;

/**
 * 夹回合法区间。
 *
 * 为什么前端也要夹一遍（后端 load 时已夹过）：
 *   · 设置输入框允许自由输入，提交前就要给个合法值，不能等存盘才发现
 *   · 后端可能更旧（用户还没重新编译），此时后端不会夹，前端得自己兜住
 *
 * 三类输入要分开对待，不能一律 `Number(v)` 了事：
 *   · **"没填"**（null / undefined / 空串）→ 默认值。
 *     用户清空输入框是最常见的中间态，此时跳成"10"既突兀又挡着他继续输入。
 *   · **"填了但没法解析"**（NaN / 'abc'）→ 默认值，理由同上。
 *   · **"越界"**（0 / 负数 / 九万）→ 夹到边界，而不是默认值。
 *     用户填 0 的意图显然是"尽量少"，给下限比给默认 40 更贴合。
 *
 * Infinity 属前端独有（Rust 的 u32 没有这个取值），按"越界"处理：
 * 正无穷夹上限、负无穷夹下限，符合"上限就是天花板"的直觉。
 */
export function clampLogMax(v: unknown): number {
  if (v === null || v === undefined || v === '') return LOG_MAX_LINES_DEFAULT;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return LOG_MAX_LINES_DEFAULT;
  if (n === Infinity) return LOG_MAX_LINES_MAX;
  if (n === -Infinity) return LOG_MAX_LINES_MIN;
  return Math.min(LOG_MAX_LINES_MAX, Math.max(LOG_MAX_LINES_MIN, Math.trunc(n)));
}
