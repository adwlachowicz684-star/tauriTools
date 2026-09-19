import { useCallback, useEffect, useRef } from 'react';
import { edgeScrollSpeed } from '../utils/dragSort';

/**
 * 拖拽到容器边缘时自动滚动（#104）。
 *
 * 为什么必须自己起 `requestAnimationFrame` 循环，而不是在 `onDragOver` 里滚：
 * **`dragover` 只在指针移动时触发**。用户把卡片拖到底边后停住不动等它滚，
 * 恰恰是那时 `dragover` 不再来了 —— 滚动立刻停住，
 * 用户以为功能坏了而松手，前功尽弃。
 * 这正好是"最需要它的时候它不动"，是这类功能最容易做错的一处。
 *
 * 所以：dragover 只负责**记下指针位置**，滚动由 rAF 持续推进。
 *
 * 另一个硬约束：**拖拽结束必须停**。
 * 循环忘了停的话，容器会一直自己滚下去 —— 用户松手了界面还在动，
 * 而且越滚越快（因为指针位置还停在边缘）。
 */
export function useEdgeAutoScroll(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
) {
  /** 指针的**视口**坐标（clientY）；dragover 里更新，rAF 里读 */
  const pointerY = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  const onDragOver = useCallback((e: React.DragEvent) => {
    pointerY.current = e.clientY;
  }, []);

  /** 停止：拖拽结束 / 取消 / 组件卸载都要调 */
  const stop = useCallback(() => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    pointerY.current = null;
  }, []);

  useEffect(() => {
    if (!active) { stop(); return; }

    const el = ref.current;
    if (!el) return;

    const step = () => {
      raf.current = requestAnimationFrame(step);
      const y = pointerY.current;
      /* 指针还没进来（或已离开）→ 不滚，但要继续轮询，
         否则用户重新贴边时循环已经结束了。 */
      if (y == null) return;
      const r = el.getBoundingClientRect();
      const dy = edgeScrollSpeed(y, r.top, r.bottom);
      if (dy === 0) return;
      /* 用 scrollTop 直接加，而不是 scrollBy：
         scrollBy 带平滑滚动时会被连续调用打断，表现为"越滚越慢"。 */
      const before = el.scrollTop;
      el.scrollTop = before + dy;
      /* 已经到头了还接着排帧是白耗电；指针位置留着，等容器内容变化再滚 */
      if (el.scrollTop === before) return;
    };
    raf.current = requestAnimationFrame(step);

    /* 卸载 / active 变假时停 —— 漏了这条容器会一直自己滚 */
    return stop;
  }, [active, ref, stop]);

  return { onDragOver, stop };
}
