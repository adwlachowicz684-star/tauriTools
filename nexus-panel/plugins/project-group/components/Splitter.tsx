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
 *     移出元素也不断连靠 window 级监听（move/up/cancel 全挂在 window 上），
     而不是 setPointerCapture —— 本组件没有调用它，别照旧注释去"补"：
     一旦捕获，事件会改投到本元素，与 window 监听二选一，两套并存最容易出事。
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

  /** 与 state 同步的拖动标记：卸载清理要读它，而 cleanup 里读不到最新 state */
  const draggingRef = useRef(false);

  /*
   * 拖动中若本组件被卸载（弹窗被关掉、切到别的页面），`fpx-no-select`
   * 会**永久留在 body 上** —— 之后整个界面都选不中文字，且没有任何提示
   * 能指向这里。`stop()` 只在松手时跑，覆盖不到这条路径。
   *
   * 只在"自己正在拖"时才摘：本组件存在多个实例（三栏两条 + 弹窗里几条），
   * 无条件摘会让别的实例拖动中被自己卸载这一下顺手清掉，禁用失效。
   */
  useEffect(() => () => {
    if (draggingRef.current) document.body.classList.remove('fpx-no-select');
    draggingRef.current = false;
  }, []);

  const stop = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    draggingRef.current = false;
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
        draggingRef.current = true;
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
        /*
         * ⚠️ `onEnd` 是紧跟着**同步**调用的，此时 React 还没重渲染，
         * 调用方若在 onEnd 里读闭包里的当前值，读到的是**调整前**的旧值，
         * 于是"界面变了、落盘的还是旧值"，下次打开又回到原样，且不报错。
         *
         * 拖动路径没这个问题：pointermove 与 pointerup 是两次事件，
         * 中间必然已经重渲染过。
         *
         * 所以调用方的 onEnd 必须能拿到"刚刚 set 进去的新值"（读 ref），
         * 不能依赖闭包。见 useLayoutMemory 里的 colStarsRef / logHeightRef。
         */
        onDelta(step);
        onEnd?.();
      }}
    />
  );
}
