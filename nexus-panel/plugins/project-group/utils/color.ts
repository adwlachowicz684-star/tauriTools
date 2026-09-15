/**
 * 颜色工具（跨组件共用）。
 *
 * 此前 ColorPicker 里有一份私有的 hexToRgb / rgbToHex / normalize，
 * 卡片标签色又要用到"派生色"和"明暗判定"。两份各写一份迟早漂移
 * （比如一处支持 #abc 简写、另一处不支持），所以收敛到这里。
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
