/**
 * 颜色工具（跨插件共用）。
 * ------------------------------------------------------------
 * **本文件已从 project-group/utils/color.ts 搬到 color-picker 下。**
 *
 * 为什么搬：内联色盘（project-group 的 ColorPicker）与取色服务
 * （plugins/color-picker）要共用同一份定义。此前两份各存一份 PRESET_COLORS，
 * 改一处忘一处就会漂移 —— 同一个"常用色"在两个界面显示成不同颜色。
 *
 * 依赖方向：project-group → color-picker（单向，无循环）。
 * 原路径保留转发（见 project-group/utils/color.ts），避免改一堆 import。
 *
 * 这里放**纯数据与纯函数**，不碰 DOM、不依赖插件运行时 ——
 * 这样 React 组件与 iframe 服务都能直接 import。
 */

/**
 * 颜色工具（跨组件共用）。
 *
 * 此前 ColorPicker 里有一份私有的 hexToRgb / rgbToHex / normalize，
 * 卡片标签色又要用到"派生色"和"明暗判定"。两份各写一份迟早漂移
 * （比如一处支持 #abc 简写、另一处不支持），所以收敛到这里。
 */

/**
 * 预设常用色 24 个（取自原 C# 版 ColorPickDialog 的 PresetColors，不可删改）。
 *
 * 放在这里而不是留在 ColorPicker 里，是因为取色服务（plugins/color-picker）
 * 也要用同一份 —— 两处各存一份迟早漂移（一边改了另一边没改，
 * 同一个"常用色"在两个界面里显示成不同颜色）。
 */
export const PRESET_COLORS = [
  '#E5484D', '#D9A441', '#F5A623', '#B7C94A',
  '#46A758', '#2FAE9B', '#12A594', '#0091FF',
  '#3E63DD', '#6E56CF', '#8E4EC6', '#BF4AC8',
  '#D6409F', '#E93D82', '#FF6B35', '#FFD23F',
  '#8FD14F', '#00C2A8', '#4098D7', '#5B5BD6',
  '#9D34DA', '#F472B6', '#B4B9C2', '#7C8698',
];

/**
 * 未设标签色时色盘的**起始色**。
 *
 * 它不代表"卡片是这个颜色"（没设色就是没设色，预览块上会标「默认」），
 * 只是给用户一个能看的起点：直接拖面板就是在它基础上调，
 * 不必先盲选一个预设色块再微调。
 *
 * 放在这里是因为内联用法与服务用法必须用**同一个**起始色 ——
 * 否则同一个"默认"在两个入口是两个颜色。
 */
export const DEFAULT_COLOR = '#7C8CFF';

/** 归一化成 `#RRGGBB`（大写）；支持省略 `#` 与三位简写；非法返回 null。 */
export function normalizeHex(hex: string): string | null {
  const s = (hex || '').trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return null;
  let t = m[1];
  if (t.length === 3) t = t.split('').map((c) => c + c).join('');
  return `#${t.toUpperCase()}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? '#000000';
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n) || 0)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/**
 * 派生色：`amount > 0` 变亮、`< 0` 变暗，取值 -1 ~ 1。
 *
 * 用于标签色的 hover / press 态（原版对自定义色卡片有派生色，
 * 缺了的话鼠标移上去毫无变化——看着像没选中）。
 * 按"离白/离黑各有余量"来算：亮化时向 255 靠、暗化时向 0 靠，
 * 而不是简单乘系数——后者对已经很亮/很暗的颜色几乎没效果。
 */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (v: number) => (amount >= 0
    ? v + (255 - v) * amount
    : v * (1 + amount));
  return rgbToHex(f(r), f(g), f(b));
}

/**
 * 感知亮度（0~1），用 ITU-R BT.601 权重。
 *
 * 用来决定叠在该颜色上的文字该用黑还是白。
 * 不用简单平均——人眼对绿色最敏感、蓝色最不敏感，平均会把
 * 亮蓝（如 #0091FF）误判为暗色，白字上去就糊了。
 */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** 该颜色算"深色"吗（叠白字才看得清）。 */
export function isDark(hex: string): boolean {
  return luminance(hex) < 0.5;
}

/* ---------------------------- HSV ---------------------------- */
/**
 * HSV 色彩模型（色相 / 饱和度 / 明度）。
 *
 * 色盘的二维面板必须用 HSV 而不是 RGB：面板的 X 轴是饱和度、Y 轴是明度，
 * 拖动时**色相保持不变**——这正是"在这块颜色里挑深浅"的直觉。
 * 用 RGB 表达就没有这两个正交的维度，拖动手感是错的。
 */
export interface Hsv {
  /** 色相 0~360 */
  h: number;
  /** 饱和度 0~1 */
  s: number;
  /** 明度 0~1 */
  v: number;
}

/** RGB → HSV。h 取 0~360；灰阶（s=0）时 h 保留为 0。 */
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

/** HSV → RGB（各分量 0~255 整数）。 */
export function hsvToRgb(hsv: Hsv): [number, number, number] {
  const { s, v } = hsv;
  //  hue 归一化到 0~360，防负数与超过一圈
  const h = ((hsv.h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

export function hexToHsv(hex: string): Hsv {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsv(r, g, b);
}

export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(...hsvToRgb(hsv));
}

/** 色相对应的**纯色**（饱和度和明度都拉满），面板底色与色相条游标都用它。 */
export function pureHueHex(h: number): string {
  return hsvToHex({ h, s: 1, v: 1 });
}
