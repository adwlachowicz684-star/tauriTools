import { useEffect, useRef, useState } from 'react';

/**
 * 内容区条目改名（agent / skill / rule）。
 *
 * 与文件夹改名分开：这里只动磁盘上的一个文件（或目录型 skill 的目录），
 * 不涉及页签登记与链接记录，也没有快照要并回。
 * 文件类条目保留扩展名 —— 用户填的是主名，不是完整文件名。
 */
export function RenameContentDialog({
  name, onClose, onSubmit, segment,
}: {
  /** 当前显示名（已去扩展名） */
  name: string;
  onClose: () => void;
  onSubmit: (newName: string) => Promise<boolean>;
  /**
   * #213 skill 虚拟层模式。
   *
   * 不另做一个组件：两种模式都是"填一个新名字 → 提交"，
   * 差别只在标题、说明与**校验规则**（层级名禁止 `_`）。
   * 分开写两份的话，校验规则改一处漏一处。
   */
  segment?: {
    /** 当前层级段名 */
    oldSeg: string;
    /** 受影响的条目数（必须让用户看见：一次改 N 个文件名不是小事） */
    count: number;
  };
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
    /*
     * 层级名禁止 `_`（原版 ValidateSegmentName）：skill 层级是靠 `_` 拆出来的，
     * 段名里再含 `_` 会把层级拆乱 —— 改完层级结构自己变了，且无从还原。
     * 必须在**提交前**挡掉，而不是交给后端报错：等后端返回时用户已经填完了。
     */
    if (segment && next.includes('_')) {
      setError('层级名不能包含下划线 _（会破坏层级拆分）');
      return;
    }
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
        <h2>{segment ? '重命名层级' : '改名'}</h2>

        <div className="fpx-field">
          <label>{segment ? '新层级名' : '新名称'}</label>
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
            placeholder={segment ? '层级名（不能含下划线）' : '条目名称（不含扩展名与路径分隔符）'}
          />
        </div>

        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-4, 8px)', lineHeight: 1.6 }}>
          {segment ? (
            <>
              会把「{segment.oldSeg}」层下 <b>{segment.count}</b> 个条目的物理名中对应段
              一起替换（skill 层级由名字里的 <code>_</code> 拆分而来）。
              任一目标名已存在则<b>整体取消</b>，不会改一半。
            </>
          ) : (
            '文件类条目会自动保留扩展名，只改主名；目录型 skill 改的是目录名。'
          )}
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
