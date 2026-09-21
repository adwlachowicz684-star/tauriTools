import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * 测量「可用高度」= 外层可视区高 − 上方固定占用 − 底部留白（#146 / #147）。
 *
 * 两处原本各写死一个数（图标网格 340px、模板框 6 行），
 * 于是面板拉高时它们**不会跟着变高**，白白留一大块空白；
 * 面板压扁时又撑出外层滚动条（#146 明确要求"只保留内层滚动条"）。
 *
 * 两者是同一件事，故合成一个 hook —— 各写一份的话，
 * 改了其中一处的底部留白规则，另一处就会悄悄不一致。
 *
 * ## 为什么向上找容器而不是让调用方传 ref
 *
 * 弹窗体（`.dialog`）的 ref 在 Modal 内部，这两个内容组件拿不到。
 * 让调用方层层透传 ref 会污染一堆 props；
 * 从内容元素 `closest()` 上去即可，找不到就返回 null（**保持原行为**）。
 */
export function useAvailableHeight(
  contentRef: RefObject<HTMLElement | null>,
  opts?: {
    /** 最扁不低于这个值（#147 明确要求模板框不低于 140） */
    minHeight?: number;
    /** 底部留白 */
    bottomGap?: number;
    /** 外层可视区选择器，默认 `.dialog` */
    containerSelector?: string;
  },
): number | null {
  const { minHeight = 0, bottomGap = 12, containerSelector = '.dialog' } = opts ?? {};
  const [h, setH] = useState<number | null>(null);
  /** 上一次算出的值：ResizeObserver 里只在真的变了才 setState，见下方说明 */
  const lastRef = useRef<number | null>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const box = el.closest(containerSelector) as HTMLElement | null;
    if (!box) return;   // 不在弹窗里（例如内联渲染）→ 保持组件自己的默认高度

    const measure = () => {
      /*
       * 用两个 rect 的 top 之差，而不是 el.offsetTop。
       * offsetTop 相对的是 offsetParent —— 中间任何一层设了 position
       * 都会让参照物变成那一层，算出来的"上方占用"是错的。
       */
      const boxRect = box.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const used = elRect.top - boxRect.top;
      const avail = box.clientHeight - used - bottomGap;
      const next = Math.max(minHeight, Math.floor(avail));

      /*
       * 只在真的变了才 setState。
       * ResizeObserver 观察的是外层弹窗体，而我们改的是内容块的高度 ——
       * 内容块用了 max-height + overflow:auto，理论上不影响外层尺寸；
       * 但外层若是自适应高度（Modal 的 height 为 null 时），
       * 就可能形成"改高度 → 触发观察 → 再改"的循环。
       * 值相等时不 setState 能把这个环断掉。
       */
      if (lastRef.current !== null && Math.abs(lastRef.current - next) < 1) return;
      lastRef.current = next;
      setH(next);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    /* 内容块自己也可能变（例如切换分组后行数变了），一并观察 */
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentRef, minHeight, bottomGap, containerSelector]);

  /*
   * 首帧还没量到时返回 null，调用方此时**不要**应用高度 ——
   * 返回 0 会把内容压没，表现为"图标列表空白一下"；
   * 这一点在弹窗刚打开的那一帧最明显。
   */
  return h;
}
