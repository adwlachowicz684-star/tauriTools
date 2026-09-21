/**
 * 通用弹窗的 React 包装
 * ============================================================
 * 底层是 js/dialog.js（框架无关、命令式、返回 Promise）。
 * React 侧**直接复用那份实现** —— 命令式 API 在事件处理里用起来最顺手：
 *
 *   if (await confirm({ message: '确定删除？', danger: true })) { ... }
 *
 * 这里额外提供命令式做不了、但 React 场景需要的东西：
 *   1. <Dialog> 组件 —— 内容本身就是 JSX（表单、列表这类复杂内容
 *      用命令式拼 DOM 会很痛苦）
 *
 * ⚠️ 不要在这里另写一套弹窗样式。两份实现的观感会随时间漂移，
 *    这正是这次要解决的问题。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  confirm as _confirm, alert as _alert, prompt as _prompt, isOpen,
} from '../../js/dialog.js';

/* 命令式 API 原样透出：React 里照样能用，且和插件里的原生 JS 是同一份实现 */
export { _confirm as confirm, _alert as alert, _prompt as prompt, isOpen };

export interface DialogAction {
  label: string;
  /** 点这个按钮后 resolve 的值 */
  value?: unknown;
  /** 主按钮（实底强调色） */
  primary?: boolean;
  /** 'danger' = 危险操作，用状态色 --danger */
  variant?: 'danger' | '';
  /** 返回 false 阻止关闭（校验未过等），可以是 async */
  onClick?: () => boolean | Promise<boolean>;
  disabled?: boolean;
}

/**
 * 通用弹窗组件。
 *
 * 与 js/dialog.js 共用同一套 CSS（.nx-mask / .nx-dlg / .nx-btn），
 * 所以观感天然一致 —— 唯一的差别是内容由 JSX 提供。
 *
 * @param onClose 参数为命中按钮的 value；点遮罩 / Esc 时为 undefined
 */
export function Dialog({
  title, children, actions, onClose, width = 420, dismissOnMask = true,
}: {
  title?: string;
  children?: ReactNode;
  actions?: DialogAction[];
  onClose: (value?: unknown) => void;
  width?: number | string;
  dismissOnMask?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // 与命令式版同理：先挂载再加 .on，否则同一帧内 transition 不触发
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (dismissOnMask) onClose(undefined);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [dismissOnMask, onClose]);

  const list: DialogAction[] = actions?.length ? actions : [{ label: '关闭' }];

  return createPortal(
    <div
      className={'nx-mask' + (shown ? ' on' : '')}
      onMouseDown={(e) => { if (e.target === e.currentTarget && dismissOnMask) onClose(undefined); }}
    >
      <div
        ref={ref}
        className="nx-dlg"
        role="dialog"
        aria-modal="true"
        style={{ width: typeof width === 'number' ? `${width}px` : width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title ? <div className="nx-dlg-head"><h2 className="nx-dlg-title">{title}</h2></div> : null}
        <div className="nx-dlg-body">{children}</div>
        <div className="nx-dlg-foot">
          {list.map((a, i) => (
            <button
              key={a.label + i}
              type="button"
              disabled={a.disabled}
              className={'nx-btn'
                + (a.primary ? ' primary' : '')
                + (a.variant === 'danger' ? ' danger' : '')}
              onClick={async () => {
                if (a.onClick && (await a.onClick()) === false) return;
                onClose(a.value);
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 确认框组件（声明式写法）。
 * 需要"确认框跟着某个状态走"时用这个；事件处理里还是 confirm() 更顺手。
 */
export function ConfirmDialog({
  title = '确认', message, okText = '确定', cancelText = '取消', danger, onResolve,
}: {
  title?: string;
  message: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  onResolve: (ok: boolean) => void;
}) {
  return (
    <Dialog
      title={title}
      width={400}
      actions={[
        { label: cancelText, value: false },
        { label: okText, value: true, primary: true, variant: danger ? 'danger' : '' },
      ]}
      onClose={(v) => onResolve(v === true)}
    >
      <div className="nx-dlg-msg">{message}</div>
    </Dialog>
  );
}
