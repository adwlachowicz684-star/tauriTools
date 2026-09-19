/**
 * 视觉规范的共用件（零依赖，纯逻辑）
 * ------------------------------------------------------------------
 * 视觉规范散在清单的约 20 个编号里（#230-237 卡片视觉、#276-298 拟态规范），
 * 但它们本质是**同一件事**：
 *
 *   · 给定一个基色，派生出「常态 / 悬停 / 按下」三态所需的全部画刷（#294）
 *   · 三态共用**同一套几何**、只改方向，看起来才像同一块材料被按下去
 *
 * 在此之前，卡片的三态派生色是**内联的魔数**（`shade(c, 0.18)` /
 * `shade(c, -0.12)` 直接写在 JSX 里），而链接按钮完全没有派生（#293）。
 * 于是"卡片有悬停反馈、链接按钮没有"——用户会觉得后者点不动。
 *
 * 收在这里之后：改配色只需改这一处，且链接按钮与卡片必然同步。
 */

import { isDark, normalizeHex, shade } from './color';

/* ---------------------------------- 幅度 ---------------------------------- */

/**
 * 悬停 / 按下的明暗幅度。
 *
 * **为什么是两个不同的数**：悬停是"被光照亮一点"，按下是"凹进去变暗"。
 * 人眼对变暗更敏感（暗部细节少），所以按下的幅度要**更小**才不显得脏。
 *
 * 取值的来由：0.18 是原版 WPF 里 `Lighten` 的比例，实测在深色与浅色底上
 * 都能看出变化而不刺眼；-0.12 是它的 2/3，与上面那条"变暗幅度更小"一致。
 *
 * 别写成对称的 ±0.15：那样按下态在深色底上会糊成一团黑。
 */
export const HOVER_AMOUNT = 0.18;
export const PRESS_AMOUNT = -0.12;

/* -------------------------------- 派生画刷 -------------------------------- */

/** 一个「色组」在三态下各自该用什么颜色。 */
export interface Brush {
  /** 基色（已归一化，形如 `#RRGGBB`） */
  base: string;
  /** 悬停：照亮一点 */
  hover: string;
  /** 按下：压暗一点 */
  press: string;
  /** 叠在这个颜色上的文字该用黑还是白（#294 的 IsBright） */
  textOn: string;
  /** 描边：比基色再暗一档，让色块在浅色底上也有轮廓 */
  edge: string;
}

/** 叠在深色底上的文字色 */
const ON_DARK = '#ffffff';
/** 叠在浅色底上的文字色 */
const ON_LIGHT = '#1a1a1a';

/**
 * 由一个基色派生出三态画刷（#294 的 Lighten / Darken / IsBright）。
 *
 * **无效色值返回 null**（#295），绝不返回一个"看起来能用"的近似色——
 * 那样用户设了错误颜色后界面**不会报错**，只是显示得不对，
 * 于是他会以为是别的地方出了问题。返回 null 让调用方退回默认样式，
 * 至少行为是可预期的。
 *
 * 归一化的意义：`#abc`、`#aabbcc`、`AABBCC` 都应得出同一个结果，
 * 否则同一张卡片因为配置里写法不同就显示成两种颜色。
 */
export function deriveBrush(raw: string): Brush | null {
  const base = normalizeHex(raw);
  if (!base) return null;
  return {
    base,
    hover: shade(base, HOVER_AMOUNT),
    press: shade(base, PRESS_AMOUNT),
    textOn: isDark(base) ? ON_DARK : ON_LIGHT,
    edge: shade(base, isDark(base) ? HOVER_AMOUNT : PRESS_AMOUNT),
  };
}

/**
 * 把派生的三态写进 CSS 变量，供样式表按状态切换。
 *
 * **为什么用 CSS 变量而不是直接给每个状态写内联样式**：
 * 三态由 CSS 的 `:hover` / `:active` 决定，JS 拿不到"当前是悬停还是按下"
 * （除非再挂一堆状态），交给 CSS 做状态切换才是对的。
 *
 * @param prefix 变量名前缀，如 `tag` → `--tag-base` / `--tag-hover` / …
 */
export function brushVars(raw: string, prefix = 'tag'): Record<string, string> {
  const b = deriveBrush(raw);
  if (!b) return {};
  return {
    [`--${prefix}-base`]: b.base,
    [`--${prefix}-hover`]: b.hover,
    [`--${prefix}-press`]: b.press,
    [`--${prefix}-on`]: b.textOn,
    [`--${prefix}-edge`]: b.edge,
  };
}

/* -------------------------------- 三态几何 -------------------------------- */

/**
 * 三态阴影的"档位"。
 *
 * 清单 #278 要求「常态 / 悬停 / 按下」三态。此前卡片各自写了三行 box-shadow，
 * 而链接按钮一行都没有 —— 加新控件时必然漏。
 *
 * 这里只给出**档位名**，具体值由主题（`--sh-out-sm` 等）提供：
 * 硬编码阴影值会让本插件在主窗口换主题时"穿"成另一套，
 * 那比没有阴影更糟。
 */
export const SHADOW = {
  /** 常态：外凸，小而紧 */
  rest: 'var(--sh-out-sm)',
  /** 悬停：抬升，更大更散 */
  hover: 'var(--sh-out-md)',
  /** 按下：内凹（同一块材料被压进去，而不是"阴影消失"） */
  press: 'var(--sh-in-sm)',
  /** 选中：保持内凹并加强，表示"已经按下去了" */
  selected: 'var(--sh-in-md)',
} as const;

/** 三态位移：悬停微微抬起，按下归位。 */
export const LIFT = {
  rest: 'translateY(0)',
  hover: 'translateY(-1px)',
  press: 'translateY(0)',
} as const;

/* ------------------------------ 描边多段过渡 ------------------------------ */

/**
 * 外凸描边的多段过渡（#277）。
 *
 * 原版在色块边缘用了「亮边在上、暗边在下」的两段描边，
 * 让它看起来是被光从左上照着的实体，而不是一个平面色块。
 *
 * 这里只**给出过渡串**，不写死颜色 —— 颜色必须跟随派生色，
 * 写死的话自定义标签色的卡片会有一圈与自身颜色冲突的固定描边。
 */
export function bevelEdge(edge: string, light: string): string {
  return `inset 0 1px 0 ${light}, inset 0 -1px 0 ${edge}`;
}

/**
 * 等宽条目标题（#282）：把名字补齐到指定视觉宽度。
 *
 * 为什么需要：卡片名长短不一时，右侧的操作按钮会左右跳动，
 * 鼠标要跟着挪。补齐后按钮位置稳定。
 *
 * 用 `ch`（字符宽）而不是 `px`：字号变了仍然对齐，
 * 写死 px 的话用户放大字号后对齐就失效了。
 */
export const MONO_TITLE_WIDTH = 18;
