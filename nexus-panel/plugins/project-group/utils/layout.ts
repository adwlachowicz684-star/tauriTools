/**
 * 布局记忆的取值规则（#54 #55 #56 #193 #247）。
 *
 * 与后端 model.rs 的 LAYOUT_* 常量一一对应 —— 两边必须同数，否则会出现
 * "这里拖到 800、存回去变成 500" 这类对不上（layout-test.mjs 会比对）。
 *
 * 全部抽成纯函数的原因与 utils/tabs.ts 相同：这类"夹取 + 归一化"的算术
 * 写错很隐蔽，表现是"拖到极限后布局突然跳变"或"存进去再读出来变了个数"，
 * 而在界面上复现要反复拖、还得刚好拖到边界。
 */

/* ---------------- 三栏宽度（star 值） ----------------
 * 本插件主区是三栏（项目 / 项目组 / 内容浏览），原版是四栏（多一个记录栏）。
 * 用 star 值（fr）而不是像素：窗口缩放时按比例走，不会某栏被挤成一条。
 */

/** 默认 star：与改动前 CSS 的 `1fr 1fr 1.4fr` 一致（内容栏最宽） */
export const COL_STARS_DEFAULT: readonly number[] = [1, 1, 1.4];
/** 单栏 star 下限：再小内容就没法看了（约 1/6 屏宽） */
export const COL_STAR_MIN = 0.4;
/** 单栏 star 上限：防止把某一栏拖到占满整行 */
export const COL_STAR_MAX = 4;

/* ---------------- 日志区高度 ---------------- */

/** 默认 132px：与改动前 `.fpx-logcard .fpx-log { max-height: 132px }` 一致 */
export const LOG_HEIGHT_DEFAULT = 132;
/** 下限 60px：约三行，再少就看不出"流水"了 */
export const LOG_HEIGHT_MIN = 60;
/** 上限 600px：日志区上方还有三栏，再高主内容就没地方了 */
export const LOG_HEIGHT_MAX = 600;

/* ---------------- 浮层面板高度 ---------------- */

/** 浮层高度下限（设置 / MCP / 使用说明三个面板共用） */
export const PANEL_HEIGHT_MIN = 200;
/** 上限交给 CSS 的 86vh，这里只给一个足够大的兜底（小屏时 CSS 会先顶到） */
export const PANEL_HEIGHT_MAX = 2000;
/*
 * 分隔条粗细 8px 只写在 style.css（`.fpx-splitter.horizontal { width: 8px }`）。
 *
 * 此前这里另有一个 `SPLITTER_HIT = 8` 常量，但**全库无人引用** ——
 * 真正在生效的是 CSS 里那个值。留着两个"真源"才是最坏的：
 * 以后改手感的人改了 JS 常量、界面纹丝不动，他会以为改坏了。
 * 单一真源留在 CSS，理由写在那边的注释里。
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 把任意输入夹成合法像素高度；非法（NaN / 空）返回默认值 */
function clampPx(v: unknown, def: number, lo: number, hi: number): number {
  if (v === null || v === undefined || v === '') return def;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.round(clamp(n, lo, hi));
}

export const clampLogHeight = (v: unknown): number =>
  clampPx(v, LOG_HEIGHT_DEFAULT, LOG_HEIGHT_MIN, LOG_HEIGHT_MAX);

export const clampPanelHeight = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : clampPx(v, 0, PANEL_HEIGHT_MIN, PANEL_HEIGHT_MAX);

/**
 * 三栏 star 值归一化：数量不对就整体回默认，逐项夹取。
 *
 * **为什么数量不对要整体回默认而不是补零**：栏数是布局结构的一部分，
 * 将来若真改成四栏，老配置里存的三栏 star 补一个 0 出来就是"内容栏消失"，
 * 而整体回默认只是"恢复到默认比例"，后者明显更可接受。
 */
export function normalizeColStars(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : null;
  if (!arr || arr.length !== COL_STARS_DEFAULT.length) return [...COL_STARS_DEFAULT];
  const out = arr.map((x) => {
    const n = typeof x === 'number' ? x : Number(x);
    return Number.isFinite(n) ? clamp(n, COL_STAR_MIN, COL_STAR_MAX) : COL_STAR_MIN;
  });
  // 全被夹到下限的极端情况也要能显示：不额外处理，交给 CSS 的 minmax 兜住
  return out;
}

/** star 数组 → CSS grid-template-columns */
export function starsToCss(stars: number[]): string {
  return normalizeColStars(stars).map((s) => `${s}fr`).join(' ');
}

/**
 * 拖动某一栏边界后的新 star 值。
 *
 * @param stars 当前 star
 * @param index 分隔条序号（0 = 第1/2栏之间，1 = 第2/3栏之间）
 * @param deltaPx 鼠标位移（右为正）
 * @param totalPx 三栏总宽度（用于把像素换算成 star）
 *
 * 只动分隔条两侧的两栏，其余不动 —— 符合"拖哪个边就调哪两栏"的直觉。
 */
export function resizeColStars(
  stars: number[], index: number, deltaPx: number, totalPx: number,
): number[] {
  const cur = normalizeColStars(stars);
  if (index < 0 || index >= cur.length - 1) return cur;
  if (!Number.isFinite(totalPx) || totalPx <= 0) return cur;

  // 1px 对应多少 star：star 总量 / 总像素
  const sum = cur.reduce((a, b) => a + b, 0);
  const perPx = sum / totalPx;
  let delta = deltaPx * perPx;

  const a = cur[index];
  const b = cur[index + 1];

  /**
   * 位移要同时受**两侧上下限**约束，只约束一侧会破坏守恒。
   *
   * 曾经只写了 `min(右栏可减量)`，漏了左栏的上限：当左栏已经顶到
   * COL_STAR_MAX 时，clamp 会把 `a + delta` 压回 MAX（实际没涨），
   * 而右栏照旧减了 delta —— 总 star 变少，表现是"继续拖，两栏一起变窄"。
   * 所以上下界各取两侧约束的**交集**。
   */
  const lo = Math.max(COL_STAR_MIN - a, b - COL_STAR_MAX); // 左减右增，各自的余量
  const hi = Math.min(COL_STAR_MAX - a, b - COL_STAR_MIN);
  delta = clamp(delta, lo, hi);

  const next = [...cur];
  next[index] = clamp(a + delta, COL_STAR_MIN, COL_STAR_MAX);
  next[index + 1] = clamp(b - delta, COL_STAR_MIN, COL_STAR_MAX);
  return next;
}

/**
 * 布局保存的防抖间隔（毫秒）。
 *
 * 原版用 `ScheduleLayoutSave` 防抖，避免每个 SizeChanged 都写盘。
 * 这里更进一步：**只在松手时写一次**，连防抖都不需要 ——
 * 拖动过程中改的是本地 state，松手才落盘。
 * 所以**不设防抖常量**：此前那个 `LAYOUT_SAVE_DEBOUNCE_MS = 300` 全库无人引用，
 * 且与"连防抖都不需要"这句注释自相矛盾 —— 留着只会让人以为有防抖。
 */
