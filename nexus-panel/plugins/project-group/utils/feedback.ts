/**
 * 面板内操作反馈条（#9）。
 *
 * 为什么不能只靠 toast：
 *   · toast **一闪而过**，稍长一点的反馈根本看不完（比如列了一串失败项）
 *   · 连着操作几次，前一次的结果就被后一次顶掉了，无从回看
 *   · 最关键的是**它没有上下文** —— 用户滚到面板底部操作时，
 *     弹出来的 toast 与操作位置无关，容易当成别处的提示
 *
 * 但**错误仍要 toast**：反馈条固定在面板顶部，而操作可能发生在底部
 * （比如「服务」那一块），此时反馈条在屏幕外 —— 等于没反馈。
 * 错误必须立刻被看见，所以两者并存，各管一段。
 */

export interface FeedbackItem {
  id: number;
  /** 反馈正文 */
  text: string;
  /** 是否为错误（决定配色与是否额外 toast） */
  isError: boolean;
  /** 时间戳，显示用 */
  at: number;
}

/**
 * 最多保留多少条。
 *
 * 不是越大越好：这个条子是为了"刚做的几件事能看到结果"，
 * 攒几百条就变成了第二个日志区，反而把当前面板内容挤下去。
 * 主界面已有完整日志区，这里不该复刻一份。
 */
export const FEEDBACK_MAX = 5;

let seq = 0;

/**
 * 追加一条反馈。
 *
 * **最新的在最上面**：面板可能很长，用户操作后视线在操作处附近，
 * 追加在末尾的话新反馈要滚到底才看得到 —— 那还不如 toast。
 *
 * 超出上限时丢**最旧的**（在数组末尾），保留最近的几条。
 *
 * @param prev 既有列表
 * @param text 正文
 * @param isError 是否错误
 */
export function pushFeedback(
  prev: FeedbackItem[], text: string, isError = false,
): FeedbackItem[] {
  const item: FeedbackItem = { id: ++seq, text, isError, at: Date.now() };
  return [item, ...prev].slice(0, FEEDBACK_MAX);
}

/** 关掉某一条（id 不匹配则原样返回） */
export function dismissFeedback(prev: FeedbackItem[], id: number): FeedbackItem[] {
  return prev.filter((f) => f.id !== id);
}

/** 清空全部 */
export function clearFeedback(): FeedbackItem[] {
  return [];
}

/**
 * 反馈条的显示时间（HH:MM:SS）。
 *
 * 用本地时间而不是 ISO 串：这里只需要"刚才几点做的"，
 * 给一长串 2026-09-18T13:24:11 反而要费劲读。
 */
export function feedbackTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
