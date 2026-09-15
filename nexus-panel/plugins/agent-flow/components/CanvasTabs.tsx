import { useEffect, useRef, useState } from 'react';
import type { CanvasMeta } from '../engine/canvasStore';

type Props = {
  canvases: CanvasMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  disabled?: boolean;
};

/**
 * 多画布标签栏。
 *
 * 改名交互：双击标签进入编辑态，回车确认、Esc 取消、失焦也确认。
 * 失焦确认（而不是取消）是刻意的——用户点别处通常意味着"改完了"。
 */
export default function CanvasTabs({
  canvases, activeId, onSelect, onAdd, onRename, onDelete, disabled,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startEdit = (id: string, name: string) => {
    if (disabled) return;
    setEditingId(id);
    setDraft(name);
  };

  const commit = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };

  return (
    <div className="canvas-tabs">
      <div className="tabs-scroll">
        {canvases.map((c) => (
          <div
            key={c.id}
            className={`tab ${c.id === activeId ? 'is-active' : ''}`}
            onClick={() => c.id !== activeId && onSelect(c.id)}
            onDoubleClick={() => startEdit(c.id, c.name)}
            title="单击切换，双击改名"
          >
            {editingId === c.id ? (
              <input
                ref={inputRef}
                className="tab-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEditingId(null);
                }}
              />
            ) : (
              <>
                <span className="tab-name">{c.name}</span>
                <span className="tab-count">{c.nodeCount}</span>
                {canvases.length > 1 && (
                  <button
                    className="tab-close"
                    disabled={disabled}
                    title="删除这个工作流"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`确定删除「${c.name}」？该工作流的节点和连线将一并移除。`)) {
                        onDelete(c.id);
                      }
                    }}
                  >
                    ×
                  </button>
                )}
              </>
            )}
          </div>
        ))}

        {/*
          新建按钮放在滚动容器**内部**，靠 sticky 决定它停在哪：
            标签没占满 → 紧跟最后一个标签（普通流位置）
            标签溢出    → 粘在右边缘，滚动时始终可见
          放在容器外的话，它会永远钉在最右边，标签少时孤零零悬在半空。
        */}
        <button className="tab-add" onClick={onAdd} disabled={disabled} title="新建工作流">
          + 新建
        </button>
      </div>
    </div>
  );
}
