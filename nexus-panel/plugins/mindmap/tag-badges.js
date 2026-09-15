/**
 * 优先级 / 进度徽章（A1 / A2 / A13 / A14）
 * ============================================================
 * 对应 WPF `BuildTagPage` + `BuildSpriteNumRow`
 * （`MindMapPanel.xaml.cs:178-218`）。
 *
 * WPF 用的是两张 20×200 的内嵌精灵图（`Assets/Icons/iconpriority.png`、
 * `iconprogress.png`），每格 20×20、共 10 格（1–9 + 第 10 格「清除」），
 * 由 `CropIcon` 逐格裁出来当按钮内容。
 *
 * Web 版**不复刻精灵图**，改用 CSS 直接画：**所有色值都是从这两张 PNG
 * 逐格采样得到的**，视觉与 C# 版一致，且不用裁剪、不依赖位图资源、
 * 在高 DPI 下也不会糊。
 */

/* ------------------------------------------------------------
   从 iconpriority.png 采样得到的配色
   ------------------------------------------------------------
   索引 0..8 对应优先级 1..9。
   1–5 各有品牌色（红/蓝/绿/橙/紫），6–9 同为灰色 —— 这是原图的设计，
   不是采样失败：低优先级统一用灰，避免画面太花。 */
export const PRIORITY_COLORS = [
  '#E60E07',  // 1 红
  '#006BE5',  // 2 蓝
  '#00A000',  // 3 绿
  '#F08825',  // 4 橙
  '#9156F3',  // 5 紫
  '#939393',  // 6 灰
  '#939393',  // 7
  '#939393',  // 8
  '#939393',  // 9
];

/* ------------------------------------------------------------
   从 iconprogress.png 采样得到的配色与填充比例
   ------------------------------------------------------------
   进度是「填充」语义：1/9 全黄、9/9 全绿，中间逐级过渡。
   实测每格的绿色像素占比（20×20 内 alpha>200 的像素统计）：
       0.00 / 0.10 / 0.21 / 0.31 / 0.43 / 0.56 / 0.70 / 0.87 / 1.00
   基本等于 (i-1)/8（略小是圆形边缘抗锯齿与数字占位所致）。
   用线性渐变复现，比逐格位图更平滑。 */
export const PROGRESS_BG = '#FFE98A';   // 底：黄（未完成部分）
export const PROGRESS_FG = '#6DB200';   // 填充：绿
export const PROGRESS_FILL = [0, 0.10, 0.21, 0.31, 0.43, 0.56, 0.70, 0.87, 1.00];

/** 两图第 10 格（清除）的配色：浅灰底 + 红叉 */
export const CLEAR_BG = '#E1E1E1';
export const CLEAR_FG = '#C1272D';

/** 数字色。优先级是彩色底配白字；进度是浅底配深灰字。 */
export const PRIORITY_TEXT = '#FFFFFF';
export const PROGRESS_TEXT = '#3A3A3A';

/** 徽章尺寸（对齐 WPF 的 20×20） */
export const BADGE_SIZE = 20;

/**
 * 优先级徽章的背景。v 为 1..9。
 * @returns {string} CSS background
 */
export function priorityBg(v) {
  const i = Math.min(8, Math.max(0, Number(v) - 1));
  return PRIORITY_COLORS[i];
}

/**
 * 进度徽章的背景。v 为 1..9。
 * 用横向渐变表示「填充了多少」：左边绿（已完成）、右边黄（未完成）。
 */
export function progressBg(v) {
  const i = Math.min(8, Math.max(0, Number(v) - 1));
  const pct = Math.round(PROGRESS_FILL[i] * 100);
  // 0% 与 100% 时不写渐变：两端是纯色，写渐变反而多一层无谓的渲染
  if (pct <= 0) return PROGRESS_BG;
  if (pct >= 100) return PROGRESS_FG;
  return `linear-gradient(to right, ${PROGRESS_FG} 0%, ${PROGRESS_FG} ${pct}%, ${PROGRESS_BG} ${pct}%, ${PROGRESS_BG} 100%)`;
}

/** 徽章上的数字色 */
export function badgeTextColor(kind, v) {
  if (!v) return CLEAR_FG;                       // 清除格：红
  return kind === 'priority' ? PRIORITY_TEXT : PROGRESS_TEXT;
}

/** 徽章背景（kind 为 'priority' | 'progress'，v 为 0..9，0 = 清除格） */
export function badgeBg(kind, v) {
  if (!v) return CLEAR_BG;
  return kind === 'priority' ? priorityBg(v) : progressBg(v);
}

/** 徽章上显示的字符：清除格显示 ✕，其余显示数字 */
export function badgeLabel(v) {
  return v ? String(v) : '✕';
}

/**
 * 一排徽章按钮的值序列（对齐 WPF 的两行：1–5 / 6–9 + 清除）。
 * 注意第 10 格是「清除」而不是 0 —— WPF 的 `values` 里 0 就代表清除，
 * 且它的图标取的是第 9 格（cell index 9）。
 */
export const BADGE_ROWS = [
  [1, 2, 3, 4, 5],
  [6, 7, 8, 9, 0],
];

/** Tooltip 文案（对齐 WPF 的 tipFormat / clearTip） */
export function badgeTitle(kind, v) {
  if (!v) return kind === 'priority' ? '移除优先级' : '移除进度';
  return kind === 'priority' ? `优先级 ${v}` : `进度 ${v}/9`;
}
