import { useEffect, useRef, type ReactNode } from 'react';

/** 居中弹窗：点遮罩或右上角 ✕ 关闭 */
export function Modal({
  title, onClose, children, width = 440, footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="mask" onMouseDown={onClose}>
      <div
        className="dialog p-card"
        style={{ width, maxHeight: '86vh', overflow: 'auto' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="p-row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="p-btn" style={{ height: 30, padding: '0 12px' }} onClick={onClose}>✕</button>
        </div>
        {children}
        {footer && <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>{footer}</div>}
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
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
          key={it.label}
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
      if (e.key === 'Enter') onConfirm();
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
