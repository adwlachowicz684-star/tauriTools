/**
 * 「刷新检测」的结果展示（#48）。
 *
 * 抽出来是因为这里有两条容易做错的判断，值得有测试钉住。
 *
 * 这里是本地的极简结构而非 `import type`：测试要直接吃这份源码
 * （见 testkit.mjs），import 语句剥离后无法解析。字段与 types.ts::ChainClient
 * 一致 —— 若那边改了字段，这里会同步失效，但编译期就能发现。
 */
export interface ChainClient {
  id: string;
  name: string;
  installed: boolean;
}

/* eslint-disable-next-line @typescript-eslint/no-unused-vars */

export interface DetectSummary {
  /** 检测到的数量 */
  count: number;
  /** 用于展示的名字串，如「opencode、Cursor、WorkBuddy」 */
  names: string;
  /**
   * 提示语。分三种情形：
   * · 一个都没检测到 → 引导去登记自定义客户端
   * · 只检测到 opencode → 这是后端的兜底项，要说明"可能没真检出"
   * · 正常 → 空串
   */
  hint: string;
  /** 是否只有兜底项（用于界面上是不是要特别提示） */
  fallbackOnly: boolean;
}

/**
 * 后端的兜底客户端：`detect()` 一个都没检出时会回退到它。
 * 见 chain.rs::detect 的注释。
 */
export const FALLBACK_CLIENT_ID = 'opencode';

/**
 * 汇总检测结果。
 *
 * 为什么"只剩 opencode"要单独提示：`detect()` 在**一个都没检出**时会强制把
 * opencode 塞进列表（原版同样处理）。所以列表里看到 opencode 有两种可能 ——
 * 真的装了，或者只是兜底。数量上无法区分，但"总数恰好为 1 且就是它"
 * 基本可以断定是兜底，此时不说清楚，用户会以为自己装好了。
 */
export function summarizeDetection(list: ChainClient[]): DetectSummary {
  const found = (list ?? []).filter((c) => c.installed);
  const count = found.length;
  /* 写成三元而不是 `c.name || c.id`：测试要直接吃这份源码，
     而剥离器会把紧跟右括号的 `|| x` 当成类型联合给删掉（见 testkit.mjs）。 */
  const labels = found.map((c) => (c.name ? c.name : c.id));
  const names = labels.join('、');
  const fallbackOnly = count === 1 && found[0]?.id === FALLBACK_CLIENT_ID;

  let hint = '';
  if (count === 0) {
    hint = '一个都没检测到。可点「自定义客户端」手动登记，否则发送时会退回到 opencode。';
  } else if (fallbackOnly) {
    hint = `只检出 ${found[0]?.name || FALLBACK_CLIENT_ID}，这很可能只是"一个都没检出"时的兜底项，而非真的检测到它。`;
  }
  return { count, names, hint, fallbackOnly };
}
