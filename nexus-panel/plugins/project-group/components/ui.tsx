import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 居中弹窗：点遮罩或右上角 ✕ 关闭。
 *
 * `guardClose` = 有未保存改动。此时点遮罩 / 按 Esc 不会直接关，
 * 而是弹确认 —— 编辑到一半误点遮罩会丢掉全部改动，这个代价太高。
 * 注意：确认框本身要阻止冒泡，否则它自己也会被"点外部关闭"的逻辑吃掉。
 */
export function Modal({
  title, onClose, children, width = 440, footer, guardClose = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
  guardClose?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const ask = useCallback(() => {
    if (guardClose) setConfirming(true);
    else onClose();
  }, [guardClose, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (confirming) setConfirming(false);
      else ask();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ask, confirming]);

  return (
    <div className="mask" onMouseDown={ask}>
      <div
        className="dialog p-card"
        style={{ width, maxHeight: '86vh', overflow: 'auto' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="p-row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="p-btn" style={{ height: 30, padding: '0 12px' }} onClick={ask}>✕</button>
        </div>
        {children}
        {footer && <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>{footer}</div>}
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
            <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

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

  return (
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // 回车要和下面那个「确定」按钮走同一条路径：确认 + 关闭。
      // 只调 onConfirm 的话弹窗不会消失，用户再点一次按钮就重复执行了
      // （对建链这类操作意味着连着建两次）。
      if (e.key === 'Enter') { onConfirm(); onClose(); }
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
