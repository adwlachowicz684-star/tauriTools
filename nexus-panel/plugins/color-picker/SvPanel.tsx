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
  hsv, onChange, height = 160,
}: {
  hsv: Hsv;
  onChange: (next: Hsv) => void;
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
 * 色相条。
 *
 * 七个色标（红黄绿青蓝品红）均分，首尾都是红以便循环。
 * 与 SV 面板共用同一套拖动逻辑。
 */
export function HueBar({
  hsv, onChange, height = 14,
}: {
  hsv: Hsv;
  onChange: (next: Hsv) => void;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const update = useCallback((clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    // 只改色相，保留当前饱和度与明度 —— 换色不该顺手把深浅也重置了
    onChange({ h: x * 360, s: hsv.s, v: hsv.v });
  }, [hsv.s, hsv.v, onChange]);

  return (
    <div
      ref={ref}
      className="fpx-hue"
      style={{ height }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0) return;
        update(e.clientX);
      }}
    >
      <div
        className="fpx-hue-cursor"
        style={{ left: `${(hsv.h / 360) * 100}%`, background: pureHueHex(hsv.h) }}
      />
    </div>
  );
}
