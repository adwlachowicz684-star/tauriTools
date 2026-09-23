/**
 * SV 面板 / 色相条
 * ------------------------------------------------------------
 * **已从 project-group/components/SvPanel.tsx 搬到 color-picker 下**，
 * 与取色服务同住一屋 —— 内联色盘与服务弹窗共用同一份实现。
 */

import { useCallback, useRef } from 'react';
import { pureHueHex, type Hsv } from './color';

/**
 * 饱和度 / 明度二维面板（色盘主体）。
 *
 * 用 HSV 而不是 RGB 的理由：面板的 X 轴是饱和度、Y 轴是明度，
 * **拖动时色相保持不变** —— 这正是"在这块颜色里挑深浅"的直觉。
 * 用 RGB 表达就没有这两个正交维度，拖动手感是错的。
 *
 * 背景用两层 CSS 渐变叠出来，不引 canvas：
 *   上层（后写）：to top 的黑色渐变 —— 下方 V=0（黑），上方 V=1（透明）
 *   下层（先写）：to right 的白色→纯色 —— 左端 S=0（白），右端 S=1（纯色）
 * 四角因此正好是 白 / 纯色 / 黑 / 黑，与 HSV 的定义一致。
 */
export function SvPanel({
  hsv, onChange, height,
}: {
  hsv: Hsv;
  onChange: (next: Hsv) => void;
  /**
   * 固定高度（可选）。
   *
   * **不传才是推荐用法**：此时高度交给 CSS（父级 stretch + 弹性布局），
   * 面板会跟着容器大小走 —— 服务弹窗高就面板大、矮就面板小。
   *
   * 传像素值的老毛病：它写在 inline style 上，优先级压过 CSS，
   * 于是容器再矮也不会压缩，内容被顶出可视区 → 弹窗出现滚动条。
   * 保留这个参数只为兼容需要写死的调用方。
   */
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /** 指针位置 → HSV。面板外也要能用（拖动到边缘时不跳变），故做钳制。 */
  const update = useCallback((clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    // 左→右 = 饱和度 0→1；上→下 = 明度 1→0（所以 y 要反过来）
    onChange({ h: hsv.h, s: x, v: 1 - y });
  }, [hsv.h, onChange]);

  return (
    <div
      ref={ref}
      className="fpx-sv"
      style={{
        height,
        backgroundImage: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, ${pureHueHex(hsv.h)})`,
      }}
      onPointerDown={(e) => {
        // 捕获指针：拖到面板外（甚至窗口外）仍持续收到 move，
        // 否则一出手就丢事件，表现为"拖到边上就不动了"。
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        // 没按着键就只是划过，不该改颜色
        if (e.buttons === 0) return;
        update(e.clientX, e.clientY);
      }}
    >
      <div
        className="fpx-sv-cursor"
        style={{
          left: `${hsv.s * 100}%`,
          top: `${(1 - hsv.v) * 100}%`,
        }}
      />
    </div>
  );
}

/**
 * 色相条（**竖直**，贴在 SV 面板右侧）
 * ------------------------------------------------------------
 * 布局照搬原版 WPF（src/Views/ColorPickDialog.cs）：
 *   SV 面板占满剩余宽度，色相条定宽 16 贴右，两者**等高并排**。
 *
 * 此前这里是**横向**色相条压在 SV 面板下方。换方向的理由不是审美：
 *   · 竖直条的刻度方向与 SV 面板的明度轴一致（都是纵向），
 *     横向条会让"选色区"被切成"上大块 + 下细条"两个不等高的部分；
 *   · 并排后整个选色区是**一块方形**，与右侧色条构成一个整体，
 *     而不是上下两截各带自己的光标，视觉上更像一个控件。
 *
 * 高度由外层容器给（与 SV 面板等高），所以不再收 height 参数。
 */
export function HueBar({
  hsv, onChange, width = 16,
}: {
  hsv: Hsv;
  onChange: (next: Hsv) => void;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const update = useCallback((clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.height === 0) return;
    const y = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    // 只改色相，保留当前饱和度与明度 —— 换色不该顺手把深浅也重置了
    onChange({ h: y * 360, s: hsv.s, v: hsv.v });
  }, [hsv.s, hsv.v, onChange]);

  return (
    <div
      ref={ref}
      className="fpx-hue"
      style={{ width }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0) return;
        update(e.clientY);
      }}
    >
      {/* 指示器是**横条**（上下白边）而不是圆点：
          竖直条上用圆点会看不出它指的是一条色带上的哪个高度。 */}
      <div
        className="fpx-hue-cursor"
        style={{ top: `${(hsv.h / 360) * 100}%`, background: pureHueHex(hsv.h) }}
      />
    </div>
  );
}
