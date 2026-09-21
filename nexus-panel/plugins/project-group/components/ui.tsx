import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Splitter } from './Splitter';
import { clampPanelHeight } from '../utils/layout';

/**
 * 菜单图层：所有右键菜单 / 「⋯」菜单统一渲染到这里，而不是留在各自的卡片里。
 *
 * 为什么必须这样：外壳主题给 `.p-card` 加了 `backdrop-filter`（css/neumorphism.css），
 * 而 backdrop-filter 只要不是 none 就会 **同时** 造成两件事——
 *   1. 该元素成为一个层叠上下文；
 *   2. 该元素成为其 `position: fixed` 后代的包含块。
 * 三栏都是 `.p-card`，于是「项目」栏里那个 z-index:1000 的菜单被关在本栏的层叠上下文里，
 * 它的 1000 只在栏内排序、不再参与全局比较；而「项目组」栏是 DOM 里的后一个兄弟，
 * 同处 z-index:auto，按文档顺序画在上面 —— 表现就是菜单被项目组栏盖住。
 * 副作用还牵连定位：菜单的 fixed 变成相对「项目」栏定位，left/top 用的是
 * 视口坐标，于是菜单整体偏移到右边一栏去。
 *
 * 把菜单挪出 `.p-card` 后两个问题一起消失。图层本身用 position:relative
 * （不产生 fixed 包含块）并给 z-index 20：高于三栏（auto），低于弹窗遮罩
 * （.mask 是 900），这样弹窗打开时仍能盖住未关闭的菜单。
 */
export const MenuLayerContext = createContext<HTMLElement | null>(null);

/* ------------------------- Esc 层级栈（#250）------------------------- */
/*
 * 浮层叠着开时（弹窗里再开弹窗、编辑态上压着菜单），按一次 Esc
 * **只关最上面那一层**。
 *
 * 此前每层各自 `window.addEventListener('keydown', ...)`，
 * 于是按一次 Esc 所有层一起关 —— 用户只想退出当前这一步，
 * 结果连底下正在填的表单一起没了。这类"退一步变成退到底"没有报错，
 * 只是让人不敢再按 Esc，而 Esc 恰恰是最常用的退出键。
 *
 * 注意 `e.stopPropagation()` 挡不住：多个监听器挂在**同一个** window 上，
 * 同目标的监听器互不影响（那要用 stopImmediatePropagation，
 * 而它会连不相干的监听器一起挡掉）。所以只能靠栈判"谁在最上面"。
 */
const escStack: symbol[] = [];

/**
 * 注册一个 Esc 层；只有**栈顶**那层的回调会执行。
 * 回调每次渲染刷新，避免闭包读到过期的 state（例如"正在确认关闭"这个标志）。
 */
export function useEscapeLayer(handler: () => void) {
  const h = useRef(handler);
  h.current = handler;
  useEffect(() => {
    const token = Symbol('esc-layer');
    escStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (escStack[escStack.length - 1] !== token) return;   // 不是最上层就不处理
      h.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = escStack.indexOf(token);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, []);
}

/**
 * 居中弹窗：点遮罩或右上角 ✕ 关闭。
 *
 * `guardClose` = 有未保存改动。此时点遮罩 / 按 Esc 不会直接关，
 * 而是弹确认 —— 编辑到一半误点遮罩会丢掉全部改动，这个代价太高。
 * 注意：确认框本身要阻止冒泡，否则它自己也会被"点外部关闭"的逻辑吃掉。
 */
export function Modal({
  title, onClose, children, width = 440, footer, guardClose = false,
  height, onHeightCommit, modeless = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
  guardClose?: boolean;
  /**
   * 非模态（#8）：**不拦截背后的界面**。
   *
   * 图标面板要常驻：给一批卡片连续设图标时，
   * 每设一张就开关一次弹窗是不可接受的。开着面板点别的卡片，
   * 目标跟着换（`UpdateTarget`）。
   *
   * 两个必须一起改的地方，缺一个就还是模态：
   *   · 遮罩 `pointer-events: none` —— 否则点不到背后的卡片
   *   · **点遮罩不再关闭** —— 否则点背后卡片时面板直接没了
   */
  modeless?: boolean;
  /**
   * 受控高度（#56 浮层高度记忆）。给了就能拖底边调高。
   * null = 自适应内容高度（此时底边不可拖 —— 拖了也不知道该存什么基准）。
   */
  height?: number | null;
  /** 松手时的最终高度；调用方在这里落盘 */
  onHeightCommit?: (h: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const ask = useCallback(() => {
    if (guardClose) setConfirming(true);
    else onClose();
  }, [guardClose, onClose]);

  /* 拖动中的高度。起点在 pointerdown 时记下，onDelta 给的是相对起点的总位移 ——
     逐帧累加会舍入漂移，拖久了数字对不上。 */
  const baseRef = useRef(height ?? 0);
  const [dragH, setDragH] = useState<number | null>(null);
  const shownH = dragH ?? height ?? null;

  useEffect(() => {
  /* #250 走 Esc 层级栈：叠着开时只有最上面那层响应。
     且"有未保存改动"时先撤确认、再关 —— 一次 Esc 退一步。 */
  useEscapeLayer(() => {
    if (confirming) setConfirming(false);
    else ask();
  });
  }, [ask, confirming]);

  return (
    <div
      className={`mask${modeless ? ' modeless' : ''}`}
      /* 非模态时点背景不关闭 —— 面板要常驻，点了背后的卡片就没了是不对的 */
      onMouseDown={modeless ? undefined : ask}
    >
      <div
        className="dialog p-card"
        style={{
          width,
          // 拖过之后就是固定高度；没拖过时留 maxHeight 让它自适应内容
          ...(shownH ? { height: shownH } : { maxHeight: '86vh' }),
          overflow: 'auto',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="p-row" style={{ justifyContent: 'space-between', marginBottom: 'var(--sp-7, 14px)' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="p-btn" style={{ height: 30, padding: '0 12px' }} onClick={ask}>✕</button>
        </div>
        {children}
        {footer && <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-9, 18px)' }}>{footer}</div>}

        {/* 底边拖动把手（#56）。只有受控高度时才渲染 ——
            自适应高度的弹窗不存在"当前高度"这个基准，拖了存什么都不对。 */}
        {height != null && onHeightCommit && (
          <Splitter
            dir="vertical"
            ariaLabel="调整面板高度"
            onDelta={(d) => setDragH(clampPanelHeight(baseRef.current + d) ?? baseRef.current)}
            onEnd={() => {
              const next = dragH;
              setDragH(null);
              if (next != null) {
                baseRef.current = next;
                onHeightCommit(next);
              }
            }}
          />
        )}
      </div>

      {confirming && (
        <div
          className="mask"
          style={{ zIndex: 1001 }}
          onMouseDown={(e) => { e.stopPropagation(); setConfirming(false); }}
        >
          <div className="dialog p-card" style={{ width: 340 }} onMouseDown={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 10px' }}>放弃未保存的改动？</h2>
            <div className="p-muted">当前有改动尚未保存，关闭后将丢失。</div>
            <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-8, 16px)' }}>
              <button className="p-btn" onClick={() => setConfirming(false)}>继续编辑</button>
              <button className="p-btn primary" onClick={onClose}>放弃并关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** React key。多个菜单项 label 相同时必须给，否则 React 会警告且可能渲染错乱 */
  key?: string;
}

/** 右键菜单：自动定位在视口内，点外部关闭 */
export function ContextMenu({
  x, y, items, onClose,
}: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const layer = useContext(MenuLayerContext);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', close);
    return () => { window.removeEventListener('mousedown', close); };
  }, [onClose]);

  /* #250 同上：右键菜单也占一层，Esc 只关最上面那个 */
  useEscapeLayer(onClose);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x; let top = y;
    if (x + r.width > window.innerWidth) left = window.innerWidth - r.width - 8;
    if (y + r.height > window.innerHeight) top = window.innerHeight - r.height - 8;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }, [x, y]);

  const box = (
    <div className="fpx-menu" ref={ref}>
      {items.map((it) => (
        <button
          key={it.key ?? it.label}
          className={`fpx-menu-item${it.danger ? ' danger' : ''}`}
          disabled={it.disabled}
          onClick={() => { it.onClick(); onClose(); }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
  // 图层还没挂载好（首帧）时就地渲染，挂在好之后再 portal，避免菜单闪一下位置
  return layer ? createPortal(box, layer) : box;
}

/**
 * 二次确认弹窗。
 *
 * 原版 WPF 里「快速链接」关着时，跨栏拖放会先问一句再建链；
 * 这里用真弹窗而不是 window.confirm——沙箱 iframe 里系统对话框的表现
 * 各平台不一致，且视觉与外壳割裂。
 */
export function ConfirmDialog({
  title, message, confirmText = '确定', danger, onConfirm, onClose,
}: {
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  /*
   * 回车：和下面那个「确定」按钮走同一条路径 —— 确认 + 关闭。
   * 只调 onConfirm 的话弹窗不会消失，用户再点一次按钮就重复执行了
   * （对建链这类操作意味着连着建两次）。
   *
   * Esc **不在这里处理**：本组件渲染的就是 Modal，Esc 交给 Modal 那层
   * （#250）。这里再监听一次的话，同一个 Esc 会被两个层各处理一遍。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      onConfirm();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onConfirm]);

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="p-btn" onClick={onClose}>取消</button>
          <button
            className={`p-btn ${danger ? 'danger' : 'primary'}`}
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmText}
          </button>
        </>
      }
    >
      {/* 文案里带换行，用 pre-wrap 保留，否则路径会挤成一团认不出来 */}
      <div className="p-muted" style={{ lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {message}
      </div>
    </Modal>
  );
}

/** 开关样式的小勾选项 */
export function CheckLine({
  checked, onChange, title, subtitle,
}: { checked: boolean; onChange: (v: boolean) => void; title: string; subtitle?: string }) {
  return (
    <label className="fpx-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="fpx-check-box">{checked ? '✓' : ''}</span>
      <span>
        <span className="fpx-check-title">{title}</span>
        {subtitle && <span className="fpx-check-sub">{subtitle}</span>}
      </span>
    </label>
  );
}
