/**
 * 上 / 左中右 三段布局的面板标签状态（纯逻辑层）。
 *
 * ================= 为什么抽出来 =================
 *
 * 这些是**界面状态**，但它们有必须守住的规则：
 *
 *   · 切到「任务 / 历史」视图时左边栏没有意义（画布藏起来了，节点拖不出去），
 *     不跟着切就会留一条死栏 —— 而"点了没反应"是最难自查的一类问题
 *   · 存进 localStorage 的值可能是任意形状（老版本写的、手改的），
 *     不归一就会渲染出一个谁都不认识的标签，**点了没反应**
 *
 * 规则能被测，所以放 engine 而不是散在组件里各判一次 ——
 * 各判一次迟早分叉（这个项目的老问题）。
 */

/** 左边栏的两个标签 */
export type LeftTab = 'library' | 'canvas';

/**
 * 右栏的两个标签。
 *
 * 做成**可切标签**而不是上下平分：
 * 分栏的话每栏都只有一半高 —— 属性面板挤到看不全，日志只看得到几行。
 * 切换的代价是"看日志时看不到属性"，但用「运行时自动切到日志」
 * 补上了这个代价：跑起来自然就看到日志，不用手动切。
 */
export type RightTab = 'inspector' | 'log';

export const RIGHT_TABS: RightTab[] = ['inspector', 'log'];

export const RIGHT_TAB_LABEL: Record<RightTab, string> = {
  inspector: '设置',
  log: '日志',
};

/** 主视图 */
export type MainView = 'flow' | 'tasks' | 'history';

export const LEFT_TABS: LeftTab[] = ['library', 'canvas'];

export const LEFT_TAB_LABEL: Record<LeftTab, string> = {
  library: '节点库',
  canvas: '画布',
};

/* ------------------------------------------------------------------ */
/* 右栏日志高度                                                        */
/* ------------------------------------------------------------------ */

/** 日志区高度的可调范围（px） */
export const LOG_H_MIN = 80;
export const LOG_H_MAX = 600;
export const LOG_H_DEFAULT = 200;

/**
 * 把任意值归一成合法日志高度。
 *
 * 存进 localStorage 的值可能是任意形状（老版本写的、手改的），
 * 直接拿来当 style.height 会渲染出一个 NaNpx —— 面板凭空消失。
 */
export function normalizeLogHeight(v: unknown): number {
  /*
   * "没值"必须先单独挡掉，不能交给下面的夹取 ——
   * Number(null) 是 0，会被夹成 LOG_H_MIN，于是日志区缩成一条缝。
   * 那是**看起来像设过、其实是脏值**的状态，比直接给默认值更难发现。
   */
  if (v == null || v === '') return LOG_H_DEFAULT;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return LOG_H_DEFAULT;
  return Math.min(LOG_H_MAX, Math.max(LOG_H_MIN, Math.round(n)));
}

/* ------------------------------------------------------------------ */
/* 归一                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把任意值归一成合法标签。
 *
 * 未知值一律退回默认 —— 存了不认识的值时，最坏结果是显示默认标签，
 * 而不是渲染出一个点不动的空面板。
 */
export function normalizeLeftTab(v: unknown): LeftTab {
  return v === 'canvas' ? 'canvas' : 'library';
}

export function normalizeRightTab(v: unknown): RightTab {
  return v === 'log' ? 'log' : 'inspector';
}

/* ------------------------------------------------------------------ */
/* 可见性                                                              */
/* ------------------------------------------------------------------ */

/**
 * 左边栏在当前视图下是否有意义。
 *
 * 任务 / 历史是**查看态**：画布都藏起来了，节点拖不出去。
 * 留着节点库就是一条死栏。
 */
export function leftPaneVisible(view: MainView): boolean {
  return view === 'flow';
}

/**
 * 画布置于左边栏时，是否在画布标签上也能编辑。
 *
 * 只有流程视图能编辑 —— 与画布区本身的可见性保持一致，
 * 否则会出现"左边能改、中间看不见"的割裂状态。
 */
export function leftPaneEditable(view: MainView): boolean {
  return view === 'flow';
}

/**
 * 切视图时自动纠正标签。
 *
 * 从流程切到历史时如果正停在「节点库」，不纠正的话
 * 用户看到的是一个显示着节点库、但什么都拖不动的侧栏。
 */
export function coerceForView(view: MainView, left: LeftTab): { left: LeftTab; visible: boolean } {
  if (!leftPaneVisible(view)) return { left, visible: false };
  return { left, visible: true };
}
