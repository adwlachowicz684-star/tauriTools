/**
 * 单个节点的执行超时。
 *
 * 为什么要有这个
 * --------------
 * 以前只有整条流程的 `AbortSignal`（用户点停止 / 关页面）。
 * 它的粒度太粗：一个节点卡住（请求没响应、脚本死循环、等待条件永远不成立），
 * 整条流程就一直悬在那里，而界面上**看不出是哪一个卡住**——
 * 所有未开跑的节点都是"等待"，正在跑的那个也还是"进行中"。
 *
 * 有了节点级超时，卡住的那个会在超时那一刻变成红色，并写明"执行超时"。
 *
 * 必须说清楚的一件事：这是**软超时**
 * ------------------------------------
 * JavaScript 的 Promise 不能被外部强制取消。这里做的是：
 *
 *   定时器先到 → 判定该节点失败 → 下游照"上游失败"的规则跳过
 *
 * 而**底层的那次操作并没有被杀掉**，它仍在后台跑（请求可能在 3 分钟后才返回）。
 * 所以它不是"到点掐断"，而是"到点不再等它"。
 *
 * 这已经解决了真正的问题：流程不会永久悬停，用户能立刻看到是谁卡住。
 * 而真正的强制中断（杀进程 / 断开连接）需要执行器配合 AbortSignal，
 * 那是下一步的事，不要在这里假装有。
 *
 * 因为底层还在跑，就必须处理两件事（否则是 bug）：
 *  1. 它后来抛异常时不能变成 unhandled rejection（会污染整次运行）
 *  2. 它后来写回的状态必须作废，否则出现"先报失败、后又成功"的矛盾状态
 */

/** 节点级超时字段的名字 */
export const TIMEOUT_FIELD = 'timeoutSec';

/** 0 / 负数 / 非数字 一律表示"不限时" */
export const NO_TIMEOUT = 0;

/**
 * 归一化超时秒数 → 毫秒。
 *
 * 返回 0 表示不限时。
 *
 * 为什么"非法值"按不限时而不是按报错：节点数据是用户手填的，
 * 填个 "abc" 就让整条流程跑不起来太粗暴；而按不限时只是这一个节点
 * 少了一层保护，行为与加这个功能之前完全一致。
 */
export function timeoutMsOf(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return NO_TIMEOUT;
  return Math.round(n * 1000);
}

/**
 * 取这个节点的超时（毫秒）。0 = 不限时。
 *
 * 节点级优先，其次全局默认。
 *
 * 节点级要能覆盖全局，而且是**能覆盖成"不限时"**——
 * 如果只认 > 0 的覆盖值，那么"全局设了 60 秒、这个节点就是要等 10 分钟"
 * 就表达不出来，用户只能把全局调大，等于全局保护失效。
 */
export function nodeTimeoutMsOf(
  data: Record<string, unknown> | undefined,
  fallbackSec?: number,
): number {
  if (data && Object.prototype.hasOwnProperty.call(data, TIMEOUT_FIELD)) {
    const raw = data[TIMEOUT_FIELD];
    /*
     * 只有**填对了**才覆盖全局。
     *
     * 填了 'x' 这种值不能按"不限时"算 —— 那是把错误的输入解释成
     * 最宽松的行为：用户本意是"给这个节点加个限制"，
     * 结果比不填还松（不填起码还有全局兜着）。
     *
     * 所以非法值视同没填，回落全局。这既没有让流程跑不起来
     * （全局值仍是合法的），也没有静默削弱保护。
     *
     * 0 是合法值，它表示"这个节点明确不限时"，要能盖掉全局。
     */
    if (Number.isFinite(Number(raw))) return timeoutMsOf(raw);
  }
  return timeoutMsOf(fallbackSec);
}

/** 超时提示文案。带上秒数，否则用户不知道该去调哪个值 */
export function timeoutMessageOf(ms: number): string {
  const sec = ms / 1000;
  const shown = Number.isInteger(sec) ? String(sec) : sec.toFixed(1);
  return `执行超时（超过 ${shown}s）——这一步没在规定时间内跑完`;
}
