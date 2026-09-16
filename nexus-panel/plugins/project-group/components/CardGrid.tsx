import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardInfo, CardKind } from '../types';
import { isDark, shade } from '../utils/color';
import { ContextMenu, type MenuItem } from './ui';

export const DRAG_MIME = 'application/x-fpx-card';

/** 链接状态 → 说明 */
const STATE_TITLE: Record<string, string> = {
  valid: '链接有效',
  broken: '链接失效（已建过但目标没了）',
  conflict: '同名位置被普通目录 / 文件占用',
};
const STATE_TEXT: Record<string, string> = {
  broken: '失效',
  conflict: '冲突',
};

/**
 * 当前正在拖的卡片属于哪一栏（模块级临时量）。
 *
 * `dragover` 事件**读不到** dataTransfer 里的数据（浏览器安全限制），
 * 只能读 types。于是跨栏落点无法在 dragover 时判断来源，
 * 而"同栏=排序 / 跨栏=建链"的视觉必须在这时给出。
 * 解法：dragstart 时（这里能拿到 kind）记到模块级，dragend 清掉。
 * 同一时刻只可能有一个拖拽，不存在并发问题。
 */
let draggingKind: CardKind | null = null;

/**
 * 拖拽阈值（像素）—— #107。
 *
 * HTML5 的 `draggable` 由浏览器自行决定何时开始拖（Chrome 大约 4~5px），
 * 我们**无法直接设定**，但可以在 `dragstart` 里**取消**它：
 * 按下点与 dragstart 触发点的距离小于阈值就 `preventDefault()`。
 *
 * 为什么要这么做：**点击时手抖 2~3px 会被判定成拖拽**，
 * 而一旦开始拖，`click` 就不会再触发 —— 用户点卡片想选中它，
 * 结果既没选中、卡片还被拖走一点。这种"点了没反应又不是完全没反应"
 * 正是"用起来别扭但说不出哪别扭"的典型。
 *
 * 取消 dragstart 后因为没有拖拽发生，mouseup 会正常触发 click，一切回到预期。
 *
 * 阈值取 5：略高于浏览器自带阈值，只拦真实的抖动，不干扰刻意拖拽。
 */
const DRAG_THRESHOLD = 5;
/** 页签自身的拖拽，与卡片拖拽分开：两者落点语义完全不同（一个移动卡片、一个重排页签） */
export const TAB_DRAG_MIME = 'application/x-fpx-tab';

export interface TabDragPayload {
  kind: CardKind;
  index: number;
}

/** 解析页签拖拽载荷（同样是任意来源，必须做结构校验）。 */
export function parseTabDrag(raw: string | null | undefined): TabDragPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { kind, index } = parsed as Partial<TabDragPayload>;
  if (!isCardKind(kind)) return null;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  return { kind, index };
}

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
  editing: editingProp, onEditingDone, onDropCard, onMoveTab,
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
  /** 页签拖到另一个页签上：重排页签顺序（原版页签可拖动排序） */
  onMoveTab?: (from: number, to: number) => void;
}) {
  const [selfEditing, setSelfEditing] = useState(-1);
  const [draft, setDraft] = useState('');
  /** 页签拖拽的插入位置（-1 无） */
  const [tabOver, setTabOver] = useState(-1);

  /**
   * 悬停自动切页签（原版：拖着卡片悬停在页签上一会儿，自动切过去）。
   *
   * 只切页签**不够**：原本只能把卡片丢到页签上（= 放到该页签末尾），
   * 没法指定位置。切换之后目标页签的卡片列表直接铺开在眼前，就能拖到具体位置了。
   *
   * 延迟 600ms：立刻切会让"从页签上方扫过"变成一连串闪烁。
   */
  const hoverTimer = useRef<number | null>(null);
  const [switchHint, setSwitchHint] = useState(-1);

  const cancelHoverSwitch = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setSwitchHint(-1);
  }, []);

  /**
   * 拖拽被取消（按 Esc、拖到窗口外松手）时 **dragleave 不一定触发**，
   * 只靠 leave 清理会留下一个待触发的切换，过一会儿页面自己翻了。
   * 挂全局 dragend / drop 兜底。
   */
  useEffect(() => {
    const clear = () => cancelHoverSwitch();
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
      clear();
    };
  }, [cancelHoverSwitch]);
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
          className={[
            'fpx-tab',
            i === active ? 'active' : '',
            dropTarget === i ? 'drop' : '',
            tabOver === i ? 'tab-over' : '',
            switchHint === i ? 'switch-hint' : '',
          ].filter(Boolean).join(' ')}
          onClick={() => onSelect(i)}
          onDoubleClick={() => startEdit(i)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ i, x: e.clientX, y: e.clientY }); }}
          // 页签自身可拖动排序；编辑中不拖（否则拖动会和输入框抢事件）
          draggable={editing !== i && !!onMoveTab}
          onDragStart={(e) => {
            if (editing === i || !onMoveTab) return;
            e.dataTransfer.setData(TAB_DRAG_MIME, JSON.stringify({ kind, index: i }));
            e.dataTransfer.effectAllowed = 'move';
            // 不阻止冒泡：外面没有卡片区监听页签拖拽，两种 MIME 互不干扰
          }}
          onDragOver={(e) => {
            // 页签重排
            if (onMoveTab && e.dataTransfer.types.includes(TAB_DRAG_MIME)) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
              setTabOver(i);
              return;
            }
            const has = e.dataTransfer.types.includes(DRAG_MIME);
            if (!has) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            setDropTarget(i);
            // 悬停够久就切过去（拖到页签上仍是"移到末尾"，两者不冲突）
            if (onSelect && i !== active && hoverTimer.current === null) {
              setSwitchHint(i);
              hoverTimer.current = window.setTimeout(() => {
                hoverTimer.current = null;
                setSwitchHint(-1);
                onSelect(i);
              }, 600);
            }
          }}
          onDragLeave={() => { setDropTarget(-1); setTabOver(-1); cancelHoverSwitch(); }}
          onDrop={(e) => {
            // 先看是不是页签重排
            if (onMoveTab) {
              const rawTab = e.dataTransfer.getData(TAB_DRAG_MIME);
              if (rawTab) {
                e.preventDefault();
                e.stopPropagation();
                setTabOver(-1);
                const t = parseTabDrag(rawTab);
                // 只接受同栏的页签，且拖到自己身上无意义
                if (t && t.kind === kind && t.index !== i) onMoveTab(t.index, i);
                return;
              }
            }
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
  /**
   * 插入位置（对应原版"两卡缝隙处的竖条"）：**插到第 k 张之前**，取值 0..cards.length。
   *
   * 用"缝隙"而不是"悬停哪张卡"表达落点：整卡高亮只能告诉你"跟这张有关"，
   * 说不清是插到它前面还是后面，松手前没法预判结果。
   *
   * null = 当前没有落点。
   */
  const [dropAt, setDropAt] = useState<number | null>(null);
  /** 当前悬停的卡片索引（跨栏建链时用来整卡高亮） */
  const [over, setOver] = useState(-1);
  /** 正在被拖走的卡片：给它半透明，否则分不清哪张在动 */
  const [dragPath, setDragPath] = useState<string | null>(null);
  /** 按下时的指针位置，用于拖拽阈值判定（见 DRAG_THRESHOLD） */
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  /**
   * 已展开链接明细的卡片（#16）。
   *
   * 纯视图状态，不写进配置：折叠与否只影响当前这一次浏览，
   * 下次打开回到默认（收起）反而更好——否则卡片一多，展开态堆在一起更乱。
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 有链接明细的卡片数（决定要不要显示"展开全部"） */
  const linkableCount = cards.filter((c) => (c.linkDetails?.length ?? 0) > 0).length;
  const allExpanded = linkableCount > 0 && expanded.size >= linkableCount;

  const toggleLinks = (path: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(path)) n.delete(path); else n.add(path);
    return n;
  });
  /**
   * 悬停的这张卡片是不是**跨栏**拖来的。
   * 跨栏语义是建链（落在卡片上），不是插入缝隙，所以此时不画竖条。
   */
  const [overCross, setOverCross] = useState(false);

  /** 依据指针在卡片上的上下半区，算出插到它前面还是后面 */
  const posOf = (e: React.DragEvent<HTMLElement>, i: number): number => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? i : i + 1;
  };

  /**
   * 同栏移动时的**索引修正**——最容易写错的一处。
   *
   * 后端 moveCard 是「先把卡片从所有页签里摘掉，再插入到目标下标」。
   * 所以在**当前数组**（还含被拖卡片）里算出的缝隙位置 k，
   * 摘卡之后要换算：若被拖卡片原本在 k 之前，它一走后面的都前移一位，k 要减 1。
   *
   * 不减的话，往上拖会稳定"落点偏后一格"——表现为"明明插在 A 前面，结果跑到 A 后面"。
   */
  const resolveIndex = (dragPath: string, k: number): number => {
    const from = cards.findIndex((c) => c.path === dragPath);
    return from >= 0 && from < k ? k - 1 : k;
  };

  /** 拖拽结束（含被取消）一律清干净：拖到窗口外松手时 drop 不触发，
   *  不靠 dragend 兜底的话竖条会残留在屏幕上。 */
  const clearDrop = () => { setDropAt(null); setOverCross(false); setDragPath(null); };

  return (
    <div
      className="fpx-cards"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // 落在卡片区空白处：插到末尾（跨栏则是换栏，另有高亮，不画竖条）
        if (draggingKind === kind) setDropAt(cards.length);
      }}
      onDragLeave={(e) => {
        // 只有真正离开整个卡片区才清；移到子卡片上时 relatedTarget 仍在容器内
        if (!e.currentTarget.contains(e.relatedTarget as Node)) clearDrop();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const raw = e.dataTransfer.getData(DRAG_MIME);
        // 先取数再清状态：清早了就拿不到 data 了
        const k = dropAt;
        clearDrop();
        if (!raw) return;
        const drag = parseDragPayload(raw);
        if (!drag) return;
        if (drag.kind === kind) onMove(drag.path, resolveIndex(drag.path, k ?? cards.length));
        else onCrossDrop(drag, null);
      }}
    >
      {linkableCount > 0 && (
        <div className="fpx-links-bar">
          <button className="p-btn fpx-links-toggle"
            onClick={() => {
              // 只要还有没收起的，这一下就是"全部展开"；全都展开了才是"收起"
              setExpanded(allExpanded ? new Set() : new Set(
                cards.filter((c) => (c.linkDetails?.length ?? 0) > 0).map((c) => c.path),
              ));
            }}>
            {allExpanded ? '收起全部链接' : '展开全部链接'}
          </button>
          <span className="p-muted" style={{ fontSize: 11 }}>{linkableCount} 个有链接</span>
        </div>
      )}

      {cards.length === 0 && <div className="nx-empty fpx-empty">{emptyHint}</div>}
      {cards.length === 0 && dropAt === 0 && draggingKind === kind && (
        <div className="fpx-drop-line" />
      )}

      {cards.map((c, i) => (
        <div
          key={c.path}
          className={[
            'fpx-card',
            selected === c.path ? 'selected' : '',
            !c.exists ? 'missing' : '',
            dragPath === c.path ? 'dragging' : '',
            // 跨栏：整卡高亮（建链）；同栏：在缝隙处画竖条（插入）
            overCross && over === i ? 'over-link' : '',
            !overCross && dropAt === i ? 'drop-before' : '',
            !overCross && dropAt === cards.length && i === cards.length - 1 ? 'drop-after' : '',
          ].filter(Boolean).join(' ')}
          style={c.tagColor ? ({
            borderLeft: `4px solid ${c.tagColor}`,
            // hover / press 用派生色：自定义色的卡片原先移上去毫无变化，
            // 看着像没选中。派生色算好存进 CSS 变量，交给 CSS 做状态切换。
            '--tag-hover': shade(c.tagColor, 0.18),
            '--tag-press': shade(c.tagColor, -0.12),
          } as React.CSSProperties) : undefined}
          draggable
          onPointerDown={(e) => { pressAt.current = { x: e.clientX, y: e.clientY }; }}
          onDragStart={(e) => {
            // 阈值判定：抖动不够 → 取消这次拖拽，让它退化成普通点击
            const p = pressAt.current;
            if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) {
              e.preventDefault();
              return;
            }
            e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind, path: c.path } satisfies DragPayload));
            e.dataTransfer.effectAllowed = 'move';
            draggingKind = kind;
            setDragPath(c.path);
          }}
          onDragEnd={() => {
            draggingKind = null;
            setDragPath(null);
            clearDrop();
            setOver(-1);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const cross = draggingKind !== null && draggingKind !== kind;
            setOverCross(cross);
            setOver(i);
            // 跨栏是"连上这张卡"，没有插入位置的概念
            setDropAt(cross ? null : posOf(e, i));
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const raw = e.dataTransfer.getData(DRAG_MIME);
            const k = dropAt;
            const cross = overCross;
            clearDrop();
            setOver(-1);
            if (!raw) return;
            const drag = parseDragPayload(raw);
            if (!drag) return;
            if (cross || drag.kind !== kind) onCrossDrop(drag, c);
            else onMove(drag.path, resolveIndex(drag.path, k ?? i));
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
                style={{
                  background: c.tagColor,
                  // 深色标签在深色背景上会糊成一团、看不出边界，
                  // 按自身明暗给一圈对比边框（原版按底色明暗选黑白的同款思路）。
                  borderColor: isDark(c.tagColor) ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.25)',
                }}
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
            {/* 链接数兼展开开关：点一下展开逐条明细。
                只在有明细可展时才可点——老版本后端不返回 linkDetails，
                那时给一个不带按钮的普通徽标，点了没反应更糟。 */}
            {(c.linkDetails?.length ?? 0) > 0 ? (
              <button
                className="fpx-badge link expandable"
                title="展开 / 收起链接明细"
                onClick={(e) => { e.stopPropagation(); toggleLinks(c.path); }}
              >
                🔗 {c.linkCount}
                <span className={`fpx-link-arrow${expanded.has(c.path) ? ' open' : ''}`}>▸</span>
              </button>
            ) : (
              c.hasLink && <span className="fpx-badge link" title="已建链接">🔗 {c.linkCount}</span>
            )}
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

          {expanded.has(c.path) && (c.linkDetails?.length ?? 0) > 0 && (
            <div className="fpx-links">
              {c.linkDetails!.map((d) => (
                <div className={`fpx-link-row ${d.state}`} key={d.name + d.group}>
                  <span className="fpx-link-dot" title={STATE_TITLE[d.state]} />
                  <span className="fpx-link-name" title={d.name}>{d.name}</span>
                  {kind === 'project' && d.groupName && (
                    <>
                      <span className="fpx-link-to">→</span>
                      <span className="fpx-link-group"
                        title={d.group || d.groupName}
                        onClick={(e) => {
                          if (!onJumpToGroup) return;
                          e.stopPropagation();
                          onJumpToGroup(c);
                        }}>{d.groupName}</span>
                    </>
                  )}
                  {d.state !== 'valid' && (
                    <span className="fpx-link-state">{STATE_TEXT[d.state]}</span>
                  )}
                </div>
              ))}
            </div>
          )}
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
