import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 通用拖动分隔条（#54 #55 #56）。
 *
 * 栏宽、日志高度、浮层高度三处都要"拖一下调大小"，共用一个实现，
 * 免得三处各写一套 pointer 事件（那是典型的"改一处忘两处"温床）。
 *
 * 关键设计：
 *   · **拖动中只回调、不落盘**：由调用方决定何时写配置。
 *     布局是高频连续变化，拖一格写一次会把整份 config 反复重写
 *     （还要过跨进程文件锁），拖动本身也会卡。松手才写。
 *   · 用 **pointer 事件** 而非 mouse：触屏 / 触控板同样可用，
 *     且 setPointerCapture 能保证鼠标移出元素也不断连。
 *   · 拖动时给 body 加 `user-select: none`：否则会一路选中文字，
 *     视觉上像"整页被框选"，非常干扰。
 */

export type SplitDir = 'horizontal' | 'vertical';

export function Splitter({
  dir, onDelta, ariaLabel, onEnd,
}: {
  /** horizontal = 左右拖（调宽度）；vertical = 上下拖（调高度） */
  dir: SplitDir;
  /** 相对拖动起点的位移（px）。horizontal 右为正，vertical 下为正 */
  onDelta: (delta: number) => void;
  /** 无障碍标签：分隔条是纯装饰的话读屏软件会说不出它是什么 */
  ariaLabel: string;
  /** 松手时触发一次 —— 调用方在这里落盘 */
  onEnd?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  /** 起点累计量：onDelta 传的是"相对起点"的总位移，不是每帧增量。
      用帧增量会累积舍入误差，拖久了就漂。 */
  const startRef = useRef(0);
  const lastRef = useRef(0);

  const stop = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    document.body.classList.remove('fpx-no-select');
    onEnd?.();
  }, [dragging, onEnd]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const cur = dir === 'horizontal' ? e.clientX : e.clientY;
      lastRef.current = cur - startRef.current;
      onDelta(lastRef.current);
    };
    const onUp = () => stop();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // 拖到窗口外松手：pointercancel 也要收尾，否则一直处于拖动态
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dir, dragging, onDelta, stop]);

  return (
    <div
      className={`fpx-splitter ${dir}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-label={ariaLabel}
      aria-orientation={dir === 'horizontal' ? 'vertical' : 'horizontal'}
      title="拖动调整大小"
      onPointerDown={(e) => {
        // 只响应主键；右键拖不该触发resize
        if (e.button !== 0) return;
        e.preventDefault();
        startRef.current = dir === 'horizontal' ? e.clientX : e.clientY;
        lastRef.current = 0;
        setDragging(true);
        document.body.classList.add('fpx-no-select');
      }}
      /* 键盘可达性：方向键微调。没有它的话纯鼠标才能调，
         键盘用户完全用不了这个功能 */
      tabIndex={0}
      onKeyDown={(e) => {
        const dec = dir === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
        const inc = dir === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== dec && e.key !== inc) return;
        e.preventDefault();
        const step = (e.key === inc ? 1 : -1) * (e.shiftKey ? 24 : 8);
        onDelta(step);
        onEnd?.();
      }}
    />
  );
}
