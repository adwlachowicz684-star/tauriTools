import { useState } from 'react';
import type { CardInfo } from '../types';
import { CardGrid, type DragPayload } from './CardGrid';
import { ContextMenu, type MenuItem } from './ui';

/**
 * 项目组栏：所有分类纵向堆叠、各自可折叠（对照 WPF 原版的 groupBoxes）。
 *
 * 与页签切换的区别：一次能看全所有分类，符合原版与截图里的形态
 * （创作 / 游戏设计 / 游戏开发 / 财务 / 政策 同时可见）。
 * 折叠状态只存组件内 state —— 这是纯粹的视图状态，不值得写进配置；
 * 原版 WPF 也是视图层状态。
 */
export function StackedGroups({
  tabs, cardsOf, selected, thumbs, onSelect, onOpen,
  onMove, onCrossDrop, menus, onRename, onRemove, onAdd, onMoveTab,
  emptyHint,
}: {
  tabs: { name: string; items: CardInfo[] }[];
  /** 取某个页签的卡片（含后端补齐的 exists / 链接状态等） */
  cardsOf: (index: number) => CardInfo[];
  selected: string | null;
  thumbs: Record<string, string>;
  onSelect: (p: string) => void;
  onOpen: (p: string) => void;
  onMove: (tabIndex: number, path: string, index: number) => void;
  onCrossDrop: (drag: DragPayload, target: CardInfo | null) => void;
  menus: (card: CardInfo) => MenuItem[];
  onRename: (i: number, name: string) => void;
  onRemove: (i: number) => void;
  /** 在指定分类下添加项目组（传分类索引，否则会落到 activeTab 那一个分类里） */
  onAdd: (tabIndex: number) => void;
  /** 分类框上下拖动重排（原版各分类可拖着换上下位置） */
  onMoveTab: (from: number, to: number) => void;
  emptyHint: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState(-1);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  /** 分类框重排：拖起的分类索引、当前落点索引（-1 为无） */
  const [dragFrom, setDragFrom] = useState(-1);
  const [overIdx, setOverIdx] = useState(-1);

  const toggle = (i: number) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(i)) n.delete(i); else n.add(i);
    return n;
  });

  const allCollapsed = collapsed.size === tabs.length && tabs.length > 0;

  return (
    <div className="fpx-stack">
      {tabs.map((t, i) => {
        const cards = cardsOf(i);
        const open = !collapsed.has(i);
        return (
          <div
            className={[
              'fpx-stack-box',
              dragFrom === i ? 'dragging' : '',
              overIdx === i && dragFrom !== -1 && dragFrom !== i ? 'over' : '',
            ].filter(Boolean).join(' ')}
            key={`${t.name}-${i}`}
            onDragOver={(e) => {
              // 只响应分类框自身的重排；卡片拖拽交给下面的 CardGrid
              if (dragFrom === -1) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
              setOverIdx(i);
            }}
            onDragLeave={() => setOverIdx((v) => (v === i ? -1 : v))}
            onDrop={(e) => {
              if (dragFrom === -1) return;
              e.preventDefault();
              e.stopPropagation();
              const from = dragFrom;
              setDragFrom(-1);
              setOverIdx(-1);
              if (from !== i) onMoveTab(from, i);
            }}
          >
            <div
              className="fpx-stack-head"
              // 只让头部可拖：整个框可拖会和里面的卡片拖拽抢事件
              draggable={editing !== i}
              onDragStart={(e) => {
                if (editing === i) return;
                e.dataTransfer.setData('text/plain', t.name);
                e.dataTransfer.effectAllowed = 'move';
                setDragFrom(i);
              }}
              onDragEnd={() => { setDragFrom(-1); setOverIdx(-1); }}
              title="拖动标题栏可调整分类顺序"
            >
              <button
                className="fpx-stack-arrow"
                title={open ? '折叠' : '展开'}
                onClick={() => toggle(i)}
              >
                {open ? '▾' : '▸'}
              </button>
              {editing === i ? (
                <input
                  className="p-input fpx-stack-edit"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    if (draft.trim()) onRename(i, draft.trim());
                    setEditing(-1);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { setDraft(t.name); setEditing(-1); }
                  }}
                />
              ) : (
                <button
                  className="fpx-stack-name"
                  title="双击重命名"
                  onClick={() => toggle(i)}
                  onDoubleClick={() => { setDraft(t.name); setEditing(i); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ i, x: e.clientX, y: e.clientY });
                  }}
                >
                  {t.name}
                  <span className="p-muted">（{cards.length}）</span>
                </button>
              )}
              <span className="fpx-stack-spacer" />
              <button
                className="fpx-stack-op"
                title={`在「${t.name}」下添加项目组`}
                onClick={() => onAdd(i)}
              >
                ＋
              </button>
            </div>

            {open && (
              <CardGrid
                kind="group"
                cards={cards}
                selected={selected}
                thumbs={thumbs}
                onSelect={onSelect}
                onOpen={onOpen}
                // 拖进某个分类：落到该分类末尾
                onMove={(path, index) => onMove(i, path, index)}
                onCrossDrop={onCrossDrop}
                menus={menus}
                emptyHint={emptyHint}
              />
            )}
          </div>
        );
      })}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: '重命名分类', onClick: () => { setDraft(tabs[menu.i]?.name ?? ''); setEditing(menu.i); } },
            {
              label: '删除分类',
              danger: true,
              disabled: tabs.length <= 1,
              onClick: () => onRemove(menu.i),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}

      {tabs.length > 1 && (
        <button className="p-btn fpx-stack-toggleall" onClick={() => setCollapsed(
          allCollapsed ? new Set() : new Set(tabs.map((_, i) => i)),
        )}>
          {allCollapsed ? '展开全部分类' : '收起全部分类'}
        </button>
      )}
    </div>
  );
}
