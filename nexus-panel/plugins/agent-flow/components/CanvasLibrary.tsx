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
        /*
         * 条目用 .side-item —— 与节点库、模块库同一块底板
         * （同样的 padding、圆角、字号、hover）。
         *
         * 左边条用来表示"当前打开的是哪张"：
         * 画布没有"类型色"可言，但"正在看这个"在三库里是同一件事，
         * 所以复用同一个位置放状态色，而不是另起一个圆点。
         * 没打开时留 transparent —— 省掉的话整列文字会差 3px 对不齐。
         */
        className={`side-item${isActive ? ' is-active' : ''}`}
        style={isActive ? { borderLeftColor: 'var(--af-accent)' } : undefined}
        draggable={!disabled}
        onDragStart={() => setDragId(id)}
        onDragEnd={() => { setDragId(null); setHoverGroup(null); }}
        onClick={() => !disabled && onSelect(id)}
        title={bg > 0 ? `${bg} 个后台监听在运行` : undefined}
      >
        <span className="side-label">{nameOf(id)}</span>
        {bg > 0 && <span className="side-badge" title={`${bg} 个后台监听在运行`}>◉{bg}</span>}
      </div>
    );
  };

  return (
    <aside className="side-pane">
      <div className="side-head">
        画布库
        <span className="side-head-spacer" />
        <button
          type="button"
          className="side-head-btn"
          title="新建画布"
          disabled={disabled}
          onClick={onAdd}
        >＋画布</button>
        <button
          type="button"
          className="side-head-btn"
          title="新建画布组"
          disabled={disabled}
          onClick={onAddGroup}
        >＋组</button>
      </div>

      <div className="side-body">
        {entries.length === 0 && (
          <div className="side-empty">还没有画布，点右上「＋画布」建一张</div>
        )}

        {entries.map((e) => {
          if (e.kind === 'canvas') return renderCanvas(e.canvasId);

          const g = e.group;
          const collapsed = g.collapsed === true;
          const hovered = hoverGroup === g.id && dragId !== null;
          return (
            <div
              key={g.id}
              className={`side-group${hovered ? ' is-drop' : ''}`}
              onDragOver={(ev) => { if (dragId) { ev.preventDefault(); setHoverGroup(g.id); } }}
              onDragLeave={() => setHoverGroup((h) => (h === g.id ? null : h))}
              onDrop={(ev) => {
                ev.preventDefault();
                if (dragId) onDropToGroup(g.id, dragId);
                setDragId(null);
                setHoverGroup(null);
              }}
            >
              <div className="side-title">
                <button
                  type="button"
                  className="side-fold"
                  title={collapsed ? '展开' : '折叠'}
                  onClick={() => onToggleCollapse(g.id)}
                >{collapsed ? '▸' : '▾'}</button>
                {editingGroup === g.id ? (
                  <input
                    className="side-input"
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
                    className="side-label"
                    onDoubleClick={() => { setEditingGroup(g.id); setDraft(g.name); }}
                  >{g.name}</span>
                )}
                <span className="side-title-ops">
                  <button
                    type="button"
                    className="link-btn"
                    title="删除这个组（画布不会被删）"
                    onClick={() => onDeleteGroup(g.id)}
                  >删除</button>
                </span>
              </div>

              {!collapsed && (
                <div className="side-group-body">
                  {e.canvases.map(renderCanvas)}
                </div>
              )}
              {!collapsed && e.canvases.length === 0 && (
                <div className="side-empty">把画布拖进来</div>
              )}
            </div>
          );
        })}
      </div>

      {dragId && (
        <div className="side-tip">
          拖到组上归类 · <button type="button" className="link-btn" onClick={() => onRemoveFromGroup(dragId)}>移出组</button>
        </div>
      )}
    </aside>
  );
}
