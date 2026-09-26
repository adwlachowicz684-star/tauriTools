/**
 * 颜色工具 —— 已搬到 plugins/color-picker/color.ts
 * ------------------------------------------------------------
 * 这里只保留转发，避免改动一堆 import 路径。
 *
 * 此前 ColorPicker 里有一份私有的 hexToRgb / rgbToHex / normalize，
 * 卡片标签色又要用到"派生色"和"明暗判定"。两份各写一份迟早漂移
 * （比如一处支持 #abc 简写、另一处不支持），所以收敛到这里。
 */

/**
 * 预设常用色 24 个 —— 唯一定义在 plugins/color-picker/color.ts，
 * 这里靠文件末尾的 `export * from` 转发，不再自带一份。
 *
 * 此前两处各存一份（值恰好相同），但 `export *` 与本地同名导出并存时
 * 本地优先，等于"改了共享那份这边也不动" —— 同一个常用色会在两个界面
 * 里显示成不同颜色，且不会报错。已核对两份 24 色逐项一致后才删本地这份。
 */

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
 * 依赖方向：project-group → color-picker（单向，无循环）。
 */

export * from '../../color-picker/color';
