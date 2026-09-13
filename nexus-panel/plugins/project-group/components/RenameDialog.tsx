import { useEffect, useRef, useState } from 'react';
import type { CardInfo, CardKind } from '../types';

/**
 * 改名对话框：改的是磁盘上的真实文件夹名，不是界面上的显示名。
 *
 * 提交交给外层的 s.renameFolder（它负责应用快照、把选中项修正到新路径），
 * 这里只负责收名字、校验非空、展示影响范围与错误。
 */
export function RenameDialog({
  card, kind, onClose, onSubmit,
}: {
  card: CardInfo;
  kind: CardKind;
  onClose: () => void;
  /** 返回 true 表示成功（由调用方决定后续动作，本组件只关窗） */
  onSubmit: (newName: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(card.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    const next = name.trim();
    if (!next) { setError('名称不能为空'); return; }
    if (next === card.name) { onClose(); return; }
    setBusy(true);
    setError('');
    try {
      const ok = await onSubmit(next);
      if (ok) onClose();
      else setError('改名未成功，请查看日志');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mask" onMouseDown={onClose}>
      <div
        className="dialog p-card"
        style={{ width: 460 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>改名{kind === 'project' ? '项目' : '项目组'}</h2>

        <div className="p-muted" style={{ fontSize: 11.5, marginBottom: 10, wordBreak: 'break-all' }}>
          {card.path}
        </div>

        <div className="fpx-field">
          <label>新名称</label>
          <input
            ref={inputRef}
            className="p-input"
            value={name}
            disabled={busy}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
              if (e.key === 'Escape') onClose();
            }}
            placeholder="文件夹名称（不含路径分隔符）"
          />
        </div>

        <div className="p-muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
          会同时更新页签登记、链接记录、图标与标签色、ACL 保护记录里对应的路径。
          指向它的链接在改名后会失效，需要重新分配一次。
        </div>

        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{error}</div>
        )}

        <div className="p-row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="p-btn" disabled={busy} onClick={onClose}>取消</button>
          <button className="p-btn primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? '改名中…' : '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
