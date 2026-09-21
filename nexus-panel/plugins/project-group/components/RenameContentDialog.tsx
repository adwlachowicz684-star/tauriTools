import { useEffect, useRef, useState } from 'react';

/**
 * 内容区条目改名（agent / skill / rule）。
 *
 * 与文件夹改名分开：这里只动磁盘上的一个文件（或目录型 skill 的目录），
 * 不涉及页签登记与链接记录，也没有快照要并回。
 * 文件类条目保留扩展名 —— 用户填的是主名，不是完整文件名。
 */
export function RenameContentDialog({
  name, onClose, onSubmit,
}: {
  /** 当前显示名（已去扩展名） */
  name: string;
  onClose: () => void;
  onSubmit: (newName: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    const next = value.trim();
    if (!next) { setError('名称不能为空'); return; }
    if (next === name) { onClose(); return; }
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
        style={{ width: 420 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>改名</h2>

        <div className="fpx-field">
          <label>新名称</label>
          <input
            ref={inputRef}
            className="p-input"
            value={value}
            disabled={busy}
            onChange={(e) => { setValue(e.target.value); setError(''); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
              if (e.key === 'Escape') onClose();
            }}
            placeholder="条目名称（不含扩展名与路径分隔符）"
          />
        </div>

        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-4, 8px)', lineHeight: 1.6 }}>
          文件类条目会自动保留扩展名，只改主名；目录型 skill 改的是目录名。
        </div>

        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-12, 12px)', marginTop: 'var(--sp-4, 8px)' }}>{error}</div>
        )}

        <div className="p-row" style={{ marginTop: 'var(--sp-8, 16px)', justifyContent: 'flex-end' }}>
          <button className="p-btn" disabled={busy} onClick={onClose}>取消</button>
          <button className="p-btn primary" disabled={busy || !value.trim()} onClick={() => void submit()}>
            {busy ? '改名中…' : '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
