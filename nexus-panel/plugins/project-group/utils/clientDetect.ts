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
 * 区分「真装了 opencode」与「只是兜底」**只能靠 installed**：
 * `detect()` 在一个都没检出时塞进来的那个 opencode 带 `installed:false`，
 * 而真装了时它是 `installed:true`。两者在数量与名字上完全一样。
 *
 * 早先按「总数恰为 1 且就是它」判，两头都错：
 *   · `found` 已过滤掉 `installed:false`，兜底项根本不在里面 → 真兜底时永远判不出；
 *   · 真装了 opencode 时反而命中 → 界面告诉用户"这可能只是兜底，而非真的检测到它"，
 *     而他明明装了。这不是少给信息，是**主动给出一个与事实相反的判断**。
 */
export function summarizeDetection(list: ChainClient[]): DetectSummary {
  const found = (list ?? []).filter((c) => c.installed);
  const count = found.length;
  /* 写成三元而不是 `c.name || c.id`：测试要直接吃这份源码，
     而剥离器会把紧跟右括号的 `|| x` 当成类型联合给删掉（见 testkit.mjs）。 */
  const labels = found.map((c) => (c.name ? c.name : c.id));
  const names = labels.join('、');
  const fallback = (list ?? []).find((c) => c.id === FALLBACK_CLIENT_ID && !c.installed);
  const fallbackOnly = count === 0 && !!fallback;

  let hint = '';
  if (fallbackOnly) {
    hint = `一个都没检测到，列表里的 ${fallback?.name || FALLBACK_CLIENT_ID} 只是"一个都没检出"时的兜底项，并非真的检测到它。可点「自定义客户端」手动登记。`;
  } else if (count === 0) {
    hint = '一个都没检测到。可点「自定义客户端」手动登记，否则发送时会退回到 opencode。';
  }
  return { count, names, hint, fallbackOnly };
}
