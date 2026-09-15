import { useState } from 'react';
import type { CardInfo, CardKind } from '../types';
import { shade } from '../utils/color';
import { ContextMenu, type MenuItem } from './ui';

export const DRAG_MIME = 'application/x-fpx-card';

export interface DragPayload {
  kind: CardKind;
  path: string;
}

function isCardKind(v: unknown): v is CardKind {
  return v === 'project' || v === 'group';
}

/**
 * 解析拖拽载荷，失败返回 null。
 *
 * `raw` 取自 dataTransfer，内容可以是**任意文本**（从别的应用拖进来，或人为伪造）：
 * 直接 JSON.parse 会抛异常中断拖拽处理；更隐蔽的是解析成功但结构不对（没有 kind / path），
 * 后续 `drag.path` 为 undefined 会造成静默错乱。所以这里既要兜住解析异常，也要做结构校验。
 */
export function parseDragPayload(raw: string | null | undefined): DragPayload | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { kind, path } = parsed as Partial<DragPayload>;
  if (!isCardKind(kind)) return null;
  if (typeof path !== 'string' || path === '') return null;
  return { kind, path };
}

/** 页签条：切换 / 新增 / 双击重命名 / 右键删除 */
export function TabBar({
  tabs, active, onSelect, onAdd, onRename, onRemove, kind,
  editing: editingProp, onEditingDone, onDropCard,
}: {
  tabs: { name: string }[];
  active: number;
  onSelect: (i: number) => void;
  onAdd: () => void;
  onRename: (i: number, name: string) => void;
  onRemove: (i: number) => void;
  kind: CardKind;
  /** 外部（如「⋯」菜单）请求进入内联重命名的页签索引，-1 为无 */
  editing?: number;
  onEditingDone?: () => void;
  /** 卡片拖到页签上时触发：把卡片移动到该页签末尾 */
  onDropCard?: (path: string, tabIndex: number) => void;
}) {
  const [selfEditing, setSelfEditing] = useState(-1);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState(-1);

  // 外部请求优先；自身双击编辑作为兜底
  const editing = editingProp != null && editingProp >= 0 ? editingProp : selfEditing;

  const startEdit = (i: number) => { setDraft(tabs[i]?.name ?? ''); setSelfEditing(i); };
  const endEdit = (commit: boolean) => {
    if (commit) onRename(editing, draft);
    setSelfEditing(-1);
    onEditingDone?.();
  };

  const items: MenuItem[] = menu
    ? [
        { label: '重命名', onClick: () => startEdit(menu.i) },
        { label: '删除页签', danger: true, disabled: tabs.length <= 1, onClick: () => onRemove(menu.i) },
      ]
    : [];

  return (
    <div className="fpx-tabs">
      {tabs.map((t, i) => (
        <button
          key={`${t.name}-${i}`}
          className={`fpx-tab${i === active ? ' active' : ''}${dropTarget === i ? ' drop' : ''}`}
          onClick={() => onSelect(i)}
          onDoubleClick={() => startEdit(i)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ i, x: e.clientX, y: e.clientY }); }}
          onDragOver={(e) => {
            if (!onDropCard) return;
            const has = e.dataTransfer.types.includes(DRAG_MIME);
            if (!has) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            setDropTarget(i);
          }}
          onDragLeave={() => setDropTarget(-1)}
          onDrop={(e) => {
            if (!onDropCard) return;
            const raw = e.dataTransfer.getData(DRAG_MIME);
            setDropTarget(-1);
            if (!raw) return;
            e.preventDefault();
            e.stopPropagation();
            const drag = parseDragPayload(raw);
            if (!drag) return;
            // 只接同栏卡片：跨栏拖拽的语义是「分配」，交给卡片区处理
            if (drag.kind !== kind) return;
            onDropCard(drag.path, i);
          }}
        >
          {editing === i ? (
            <input
              className="fpx-tab-input"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => endEdit(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') endEdit(true);
                if (e.key === 'Escape') endEdit(false);
              }}
            />
          ) : (
            <>
              {t.name}
              <span className="fpx-tab-kind">{kind === 'project' ? 'P' : 'G'}</span>
            </>
          )}
        </button>
      ))}
      <button className="fpx-tab add" title="新增页签" onClick={onAdd}>＋</button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** 卡片网格：选中 / 打开 / 右键菜单 / 拖拽（跨栏=分配，同栏=排序） */
export function CardGrid({
  kind, cards, selected, thumbs, onSelect, onOpen, onMove, onCrossDrop, menus,
  emptyHint, onJumpToGroup,
}: {
  kind: CardKind;
  cards: CardInfo[];
  selected: string | null;
  /** 图标路径 → data URI；没有对应项时退回首字母占位 */
  thumbs?: Record<string, string>;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onMove: (dragPath: string, index: number) => void;
  onCrossDrop: (drag: DragPayload, target: CardInfo | null) => void;
  menus: (card: CardInfo) => MenuItem[];
  emptyHint: string;
  /**
   * 点卡片上的项目组名就跳过去选中它（对照 WPF 的 SelectLinkedGroupCommand）。
   * 传整张卡片而不是组名：CardInfo 里只有组**名**、没有组**路径**，
   * 而定位要的是路径，得由外层从链接记录里反查。
   */
  onJumpToGroup?: (card: CardInfo) => void;
}) {
  const [menu, setMenu] = useState<{ card: CardInfo; x: number; y: number } | null>(null);
  const [over, setOver] = useState(-1);

  return (
    <div
      className="fpx-cards"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
      onDrop={(e) => {
        e.preventDefault();
        const raw = e.dataTransfer.getData(DRAG_MIME);
        setOver(-1);
        if (!raw) return;
        const drag = parseDragPayload(raw);
        if (!drag) return;
        if (drag.kind === kind) onMove(drag.path, cards.length);
        else onCrossDrop(drag, null);
      }}
    >
      {cards.length === 0 && <div className="p-muted fpx-empty">{emptyHint}</div>}

      {cards.map((c, i) => (
        <div
          key={c.path}
          className={[
            'fpx-card',
            selected === c.path ? 'selected' : '',
            !c.exists ? 'missing' : '',
            over === i ? 'over' : '',
          ].filter(Boolean).join(' ')}
          style={c.tagColor ? ({
            borderLeft: `4px solid ${c.tagColor}`,
            // hover / press 用派生色：自定义色的卡片原先移上去毫无变化，
            // 看着像没选中。派生色算好存进 CSS 变量，交给 CSS 做状态切换。
            '--tag-hover': shade(c.tagColor, 0.18),
            '--tag-press': shade(c.tagColor, -0.12),
          } as React.CSSProperties) : undefined}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind, path: c.path } satisfies DragPayload));
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(i); }}
          onDragLeave={() => setOver(-1)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(-1);
            const raw = e.dataTransfer.getData(DRAG_MIME);
            if (!raw) return;
            const drag = parseDragPayload(raw);
            if (!drag) return;
            if (drag.kind === kind) onMove(drag.path, i);
            else onCrossDrop(drag, c);
          }}
          onClick={() => onSelect(c.path)}
          onDoubleClick={() => onOpen(c.path)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ card: c, x: e.clientX, y: e.clientY }); }}
        >
          <div className="fpx-card-top">
            <span className="fpx-card-icon">
              {c.icon && thumbs?.[c.icon]
                ? <img src={thumbs[c.icon]} alt="" />
                : iconOf(c)}
            </span>
            {c.tagColor && (
              <span
                className="fpx-color-dot"
                style={{ background: c.tagColor }}
                title={c.tagColorInherited ? `继承自项目组：${c.tagColor}` : c.tagColor}
              />
            )}
            <span className="fpx-card-name" title={c.path}>{c.name}</span>
            {c.tagColor && c.tagColorInherited && (
              <span className="fpx-badge dim" title="颜色继承自所链接的项目组">继承</span>
            )}
          </div>
          <div className="fpx-card-path" title={c.path}>{c.path}</div>
          <div className="fpx-card-badges">
            {c.hasLink && <span className="fpx-badge link" title="已建链接">🔗 {c.linkCount}</span>}
            {/* 链接到哪个项目组：光有「🔗 3」看不出连的是谁，必须把组名写出来。
                只在项目卡片上显示——项目组卡片自己就是组，写自己没意义。 */}
            {kind === 'project' && c.linkedGroup && (c.hasLink || c.hasBroken) && (
              <span
                className={`fpx-badge group${onJumpToGroup ? ' jump' : ''}`}
                title={`链接到项目组：${c.linkedGroup}${onJumpToGroup ? '（点击定位）' : ''}`}
                onClick={(e) => {
                  if (!onJumpToGroup) return;
                  e.stopPropagation();          // 别顺带把卡片选中态改了
                  onJumpToGroup(c);
                }}
              >
                → {c.linkedGroup}
              </span>
            )}
            {c.hasConflict && <span className="fpx-badge warn" title="同名位置被普通目录/文件占用">⚠ 冲突</span>}
            {c.hasBroken && !c.hasLink && <span className="fpx-badge dim" title="链接失效">∅ 未链接</span>}
            {c.locked && <span className="fpx-badge lock" title="ACL 已保护">🔒</span>}
            {!c.exists && <span className="fpx-badge warn" title="文件夹不存在">✗ 缺失</span>}
          </div>
        </div>
      ))}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menus(menu.card)} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** 卡片图标：自定义图标路径取文件名首字，否则按类型兜底 emoji */
function iconOf(c: CardInfo): string {
  if (c.icon) {
    if (c.icon.length <= 2) return c.icon;          // emoji / 字形
    const base = c.icon.split(/[\\/]/).pop() ?? c.icon;
    return base.slice(0, 1).toUpperCase();
  }
  return c.name.startsWith('.') ? '⚙' : '📁';
}
