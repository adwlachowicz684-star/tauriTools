import { useState } from 'react';
import type { CanvasMeta } from '../engine/canvasStore';
import type { CanvasGroup } from '../engine/canvasGroups';
import { buildSidebar, type SidebarEntry } from '../engine/canvasGroups';
import type { GlobalTrigger } from '../engine/triggerRegistry';

type Props = {
  canvases: CanvasMeta[];
  groups: CanvasGroup[];
  activeId: string | null;
  /** 全局触发器，用来标出"这张画布有后台监听在跑" */
  triggers: GlobalTrigger[];
  onSelect: (id: string) => void;
  onAdd: () => void;
  onAddGroup: () => void;
  onRenameGroup: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
  onDropToGroup: (groupId: string, canvasId: string) => void;
  onRemoveFromGroup: (canvasId: string) => void;
  onToggleCollapse: (groupId: string) => void;
  disabled?: boolean;
};

/**
 * 左侧画布库。
 *
 * ================= 为什么要在左边再来一列 =================
 *
 * 标签栏在画布多了之后就没法用了：横向挤成一团，看不出哪些是一套。
 * 一整套数值拆成几十张画布时尤其明显。
 *
 * 参考 mindmap 的文件列表做法，但**不做拖拽排序**：
 * 这里的顺序由分组决定，拖来拖去会和"拖进组"的交互打架。
 *
 * ================= 性能 =================
 *
 * 未激活的画布**不渲染节点** —— 这是这个面板最大的价值。
 * 几百个节点的画布同时挂载会让界面明显发涩，
 * 而现在只渲染 activeId 那一张，其余只是列表里的一行文字。
 */
export default function CanvasLibrary({
  canvases, groups, activeId, triggers,
  onSelect, onAdd, onAddGroup, onRenameGroup, onDeleteGroup,
  onDropToGroup, onRemoveFromGroup, onToggleCollapse, disabled,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverGroup, setHoverGroup] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const entries: SidebarEntry[] = buildSidebar(canvases, groups);
  const nameOf = (id: string) => canvases.find((c) => c.id === id)?.name ?? '未命名';

  /** 这张画布有几个后台监听在跑 */
  const bgCount = (canvasId: string) =>
    (triggers ?? []).filter((t) => t.canvasId === canvasId && t.background).length;

  const renderCanvas = (id: string) => {
    const bg = bgCount(id);
    const isActive = id === activeId;
    return (
      <div
        key={id}
        className={`af-lib-item${isActive ? ' is-active' : ''}`}
        draggable={!disabled}
        onDragStart={() => setDragId(id)}
        onDragEnd={() => { setDragId(null); setHoverGroup(null); }}
        onClick={() => !disabled && onSelect(id)}
        title={bg > 0 ? `${bg} 个后台监听在运行` : undefined}
      >
        <span className="af-lib-dot">{isActive ? '▸' : '·'}</span>
        <span className="af-lib-name">{nameOf(id)}</span>
        {bg > 0 && <span className="af-lib-bg" title={`${bg} 个后台监听在运行`}>◉{bg}</span>}
      </div>
    );
  };

  return (
    <div className="af-lib">
      <div className="af-lib-head">
        <span className="af-lib-title">画布</span>
        <span className="af-lib-spacer" />
        <button
          className="af-lib-btn"
          title="新建画布"
          disabled={disabled}
          onClick={onAdd}
        >＋</button>
        <button
          className="af-lib-btn"
          title="新建画布组"
          disabled={disabled}
          onClick={onAddGroup}
        >📁</button>
      </div>

      <div className="af-lib-body">
        {entries.length === 0 && (
          <div className="af-lib-empty">还没有画布，点上面的 ＋ 建一张</div>
        )}

        {entries.map((e) => {
          if (e.kind === 'canvas') return renderCanvas(e.canvasId);

          const g = e.group;
          const collapsed = g.collapsed === true;
          const hovered = hoverGroup === g.id && dragId !== null;
          return (
            <div
              key={g.id}
              className={`af-lib-group${hovered ? ' is-hover' : ''}`}
              onDragOver={(ev) => { if (dragId) { ev.preventDefault(); setHoverGroup(g.id); } }}
              onDragLeave={() => setHoverGroup((h) => (h === g.id ? null : h))}
              onDrop={(ev) => {
                ev.preventDefault();
                if (dragId) onDropToGroup(g.id, dragId);
                setDragId(null);
                setHoverGroup(null);
              }}
            >
              <div className="af-lib-group-head">
                <button
                  className="af-lib-fold"
                  title={collapsed ? '展开' : '折叠'}
                  onClick={() => onToggleCollapse(g.id)}
                >{collapsed ? '▸' : '▾'}</button>
                {editingGroup === g.id ? (
                  <input
                    className="af-lib-input"
                    value={draft}
                    autoFocus
                    onChange={(ev) => setDraft(ev.target.value)}
                    onBlur={() => {
                      if (draft.trim()) onRenameGroup(g.id, draft.trim());
                      setEditingGroup(null);
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') {
                        if (draft.trim()) onRenameGroup(g.id, draft.trim());
                        setEditingGroup(null);
                      } else if (ev.key === 'Escape') {
                        setEditingGroup(null);
                      }
                    }}
                  />
                ) : (
                  <span
                    className="af-lib-group-name"
                    onDoubleClick={() => { setEditingGroup(g.id); setDraft(g.name); }}
                  >{g.name}</span>
                )}
                <span className="af-lib-spacer" />
                <button
                  className="af-lib-btn"
                  title="删除这个组（画布不会被删）"
                  onClick={() => onDeleteGroup(g.id)}
                >×</button>
              </div>

              {!collapsed && (
                <div className="af-lib-group-body">
                  {e.canvases.map(renderCanvas)}
                </div>
              )}
              {!collapsed && e.canvases.length === 0 && (
                <div className="af-lib-empty">把画布拖进来</div>
              )}
            </div>
          );
        })}
      </div>

      {dragId && (
        <div className="af-lib-tip">
          拖到组上归类 · <button className="af-lib-link" onClick={() => onRemoveFromGroup(dragId)}>移出组</button>
        </div>
      )}
    </div>
  );
}
