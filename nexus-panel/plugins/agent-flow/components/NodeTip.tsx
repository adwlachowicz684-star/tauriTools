import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 节点说明悬浮窗。
 *
 * ================= 为什么不在条目下方展开 =================
 *
 * 说明块原先**撑在侧栏里**：点开一条，下面的条目整体往下推，
 * 收起时又跳回来。扫列表时这种位移很烦 —— 好不容易找到的位置被顶走了。
 *
 * 而且侧栏只有 260px 宽，结构化说明（产出/接受/需要/参数）挤在里面
 * 要折好几行，读起来比不展开还累。
 *
 * 浮层不影响列表布局，宽度也不受侧栏限制。
 *
 * ================= 为什么用 portal =================
 *
 * 侧栏滚动区（.side-body）有 overflow-y:auto。
 * 浮层若渲染在条目下面，哪怕 position:fixed 也会被它裁剪 ——
 * 表现为"浮层只露出侧栏内那一条"。
 *
 * 所以挂到 document.body，完全避开祖先的裁剪。
 */

/** 锚点用视口坐标（getBoundingClientRect() 的直接结果） */
export type TipAnchor = { top: number; bottom: number; left: number; right: number };

type Props = {
  anchor: TipAnchor;
  /** 标题行（节点名） */
  title: string;
  /**
   * 钉住态（点击打开）与悬停态（鼠标掠过）行为不同：
   *  - 钉住：鼠标移开不关，要点外面或 Esc
   *  - 悬停：鼠标移开即关
   */
  pinned: boolean;
  onClose: () => void;
  /** 鼠标移入浮层时通知（取消"移出条目即关"的倒计时） */
  onEnter?: () => void;
  onLeave?: () => void;
  children: React.ReactNode;
};

/** 与视口的间距 */
const M = 8;

export default function NodeTip({
  anchor, title, pinned, onClose, onEnter, onLeave, children,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  /*
   * 定位用 useLayoutEffect 而不是 useEffect：
   * 后者会在浏览器画完之后才改位置，宽内容会看到一次明显的跳动。
   *
   * 依赖里只放 anchor 的三条边 —— 放整个对象的话，
   * 每次渲染拿到的都是新对象，会无限重测。
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    /*
     * 首选放在锚点**右侧**（侧栏在左，右边才有空间）。
     * 右侧放不下就翻到左边；两边都放不下就贴右边界。
     */
    let left = anchor.right + M;
    if (left + w > vw - M) {
      left = anchor.left - w - M;
      if (left < M) left = Math.max(M, vw - w - M);
    }

    /*
     * 垂直：与锚点顶对齐，底部超出视口就上移，顶部再兜回边界内。
     * 说明很长时会顶到上边界，此时内容区自己滚（见 CSS 的 max-height）。
     */
    let top = anchor.top;
    if (top + h > vh - M) top = vh - h - M;
    if (top < M) top = M;

    setPos({ left, top });
  }, [anchor.top, anchor.left, anchor.right]);

  /* 钉住态才监听"点外面关闭" —— 悬停态本来就随鼠标移开消失 */
  const onDocDown = useCallback(
    (e: MouseEvent) => {
      // 点在浮层内部不算（里面有可点、可滚的内容）
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned, onDocDown, onClose]);

  /*
   * 滚动时锚点失效。
   *
   * 用 capture 捕获：侧栏滚动区不是 window，冒泡阶段收不到它的滚动事件；
   * 捕获阶段能收到任意后代的滚动。
   */
  useEffect(() => {
    const onScroll = () => onClose();
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [onClose]);

  const body = (
    <div
      ref={ref}
      className="node-tip"
      /*
       * 位置测出来之前先藏起来。
       * 不藏的话会先在左上角闪一下再跳到位 —— 每次打开都闪，很扎眼。
       */
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="node-tip-head">
        <span className="node-tip-title">{title}</span>
        <button
          type="button"
          className="node-tip-close"
          title="关闭（Esc）"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="node-tip-body">{children}</div>
    </div>
  );

  return createPortal(body, document.body);
}
