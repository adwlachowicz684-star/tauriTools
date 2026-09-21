import { useEffect, useRef, useState } from 'react';
import type { CardInfo } from '../types';
import { CardGrid, type DragPayload } from './CardGrid';
import { swapIndexWithDeadZone } from '../utils/dragSort';
import { BOX_DRAG_MIME, parseBoxDrag } from '../utils/dragSort';
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
  emptyHint, reveal, onExternalDrop,
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
  /** #14 从文件管理器拖入（只有名字，没有路径） */
  onExternalDrop?: (name: string) => void;
  emptyHint: string;
  /**
   * 要"滚进视野"的卡片（#19）。由外层在跳转时设置。
   * `seq` 是自增序号：连着跳同一张卡时对象引用必变，effect 才会重跑。
   */
  reveal?: { path: string; seq: number } | null;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState(-1);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  /** 分类框重排：拖起的分类索引、当前落点索引（-1 为无） */
  const [dragFrom, setDragFrom] = useState(-1);
  const [overIdx, setOverIdx] = useState(-1);
  /** #251 待执行的"单击折叠"，见下方 clickTimer 的说明 */
  const clickTimer = useRef<number | null>(null);
  /* 卸载时必须清掉待执行的折叠：定时器晚于组件卸载触发会去 setState，
     表现为"切走之后回来，某个分类自己折叠了"，且 React 会告警。
     这类延迟执行的兜底最容易被漏 —— 漏了不报错，只是偶发地乱动一下。 */
  useEffect(() => () => {
    if (clickTimer.current !== null) { clearTimeout(clickTimer.current); clickTimer.current = null; }
  }, []);

  /**
   * 跳转后把这张卡滚进视野（#19，原版 BringIntoView）。
   *
   * 光"选中"是不够的：项目组栏是**所有分类纵向堆叠**，卡片一多，
   * 目标往往在折叠的分类里或屏幕外 —— 选中的高亮用户根本看不到，
   * 于是以为"跳转没反应"。
   *
   * 所以要做两件事，缺一不可：
   *   1. 目标所在分类若是折叠的，先展开（否则滚过去也只是一片空白）
   *   2. 等这一帧渲染完，再把它滚进视野
   */
  useEffect(() => {
    if (!reveal) return;
    const idx = tabs.findIndex((_, i) => cardsOf(i).some((c) => c.path === reveal.path));
    if (idx === -1) return;
    // 折叠着就先展开
    setCollapsed((s) => {
      if (!s.has(idx)) return s;
      const n = new Set(s);
      n.delete(idx);
      return n;
    });
    /* 必须等渲染完：展开是 state 变更，同一帧里 DOM 还没长出来，
       立刻 querySelector 会拿到 null，滚动静默失效。
       用 rAF 而不是 setTimeout(0)：后者在后台标签页会被节流到秒级。 */
    const id = requestAnimationFrame(() => {
      const sel = window.CSS && CSS.escape ? CSS.escape(reveal.path) : reveal.path;
      const el = document.querySelector<HTMLElement>(`[data-card-path="${sel}"]`);
      // block:'nearest' —— 已经可见时不要动，避免无谓地整页跳动
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
  }, [reveal, tabs, cardsOf]);

  const toggle = (i: number) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(i)) n.delete(i); else n.add(i);
    return n;
  });

  const allCollapsed = collapsed.size === tabs.length && tabs.length > 0;

  /** 各分类框的位置尺寸，供 #75 死区换位计算落点 */
  const boxRefs = useRef<(HTMLDivElement | null)[]>([]);

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
            ref={(el) => { boxRefs.current[i] = el; }}
            onDragOver={(e) => {
              // 只响应分类框自身的重排；卡片拖拽交给下面的 CardGrid
              if (dragFrom === -1 || !e.dataTransfer.types.includes(BOX_DRAG_MIME)) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
              /*
               * #75 落点由**指针位置 + 死区**算出，而不是"悬停哪个框就是哪个"。
               *
               * 直接取悬停项的话，手抖一两个像素落点就跳，看着像界面坏了 ——
               * 分类框高矮不一（有的展开很高、有的折叠只剩标题），
               * 指针在框内移动时最容易来回跳。
               *
               * 量不到尺寸时（首帧 / 尚未布局）退回"悬停即落点"，
               * 不至于变成"拖了没反应"。
               *
               * 不需要 `resolveMoveIndex` 那种缝隙换算：
               * `swapIndexWithDeadZone` 返回的本来就是**最终下标**，
               * 而 `moveTab` 是"先摘后插"，插入位置也是最终下标。
               */
              const rects: { top: number; height: number }[] = [];
              for (let k = 0; k < tabs.length; k++) {
                const r = boxRefs.current[k]?.getBoundingClientRect();
                if (!r) { rects.length = 0; break; }
                rects.push({ top: r.top, height: r.height });
              }
              setOverIdx(rects.length === tabs.length
                ? swapIndexWithDeadZone(
                    e.clientY,
                    rects.map((r) => r.top + r.height / 2),
                    rects.map((r) => r.height),
                    dragFrom,
                  )
                : i);
            }}
            onDragLeave={() => setOverIdx((v) => (v === i ? -1 : v))}
            onDrop={(e) => {
              if (dragFrom === -1) return;
              const raw = e.dataTransfer.getData(BOX_DRAG_MIME);
              // 先取数再清状态：清早了就拿不到 data 了
              const from = dragFrom;
              const to = overIdx;
              setDragFrom(-1);
              setOverIdx(-1);
              e.stopPropagation();
              /* 载荷同样来自"任意来源"，必须校验。
                 这里真正用的是组件内的 dragFrom（它是权威），
                 但校验能让"伪造载荷"与"状态意外残留"两种情况都落空而不是误动。 */
              const box = parseBoxDrag(raw);
              /* 同上（回弹）：校验不过就不 preventDefault，
                 让浏览器把拖影飞回原位 —— 否则这次无效放置
                 看起来和成功一模一样。 */
              if (!box || box.index !== from) return;
              /* 原地放下 = 无操作：不 preventDefault 才有回弹（与 #103 同源）。
                 落点现在是死区算出来的 target，而不是"当前悬停的框"。 */
              if (to < 0 || to === from) return;
              e.preventDefault();
              onMoveTab(from, to);
            }}
          >
            <div
              className="fpx-stack-head"
              // 只让头部可拖：整个框可拖会和里面的卡片拖拽抢事件
              draggable={editing !== i}
              onDragStart={(e) => {
                if (editing === i) return;
                /* 此前用 `text/plain`，隐患有两处：
                   ① 它是通用类型，从别的应用拖进来的文本也匹配，
                      只靠"组件内状态 != -1"守卫是脆弱的（状态会因重渲染丢失，MIME 不会）；
                   ② 标题双击会进内联重命名（那里有 <input>），
                      拖着 text/plain 经过输入框松手，浏览器默认行为是把文本插进去。 */
                e.dataTransfer.setData(BOX_DRAG_MIME, JSON.stringify({ index: i }));
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
                    if (e.key === 'Escape') {
  /*
   * #250 必须 stopPropagation：这次 Esc 只想退出改名，
   * 若继续冒到 window，上面压着的浮层那层也会响应 ——
   * 于是"退一步"变成"连底下一层一起退"。
   */
  e.stopPropagation();
  setDraft(t.name);
  setEditing(-1);
}
                  }}
                />
              ) : (
                <button
                  className="fpx-stack-name"
                  title="单击折叠 / 双击重命名"
                  /* #251 单击折叠要**延后**执行，好让双击有机会取消它。
                     不延后的话，双击改名会先折叠再展开 —— 两次 toggle
                     净效果为零，但界面明显闪一下；折叠着的分类更是
                     会展开又折回去，看着像界面在乱动。
                     代价是单击折叠慢 220ms，比闪烁好接受得多。 */
                  onClick={() => {
                    if (clickTimer.current !== null) clearTimeout(clickTimer.current);
                    const idx = i;
                    clickTimer.current = window.setTimeout(() => {
                      clickTimer.current = null;
                      toggle(idx);
                    }, 220);
                  }}
                  onDoubleClick={() => {
                    /* 双击：取消待执行的折叠，只进改名 */
                    if (clickTimer.current !== null) {
                      clearTimeout(clickTimer.current);
                      clickTimer.current = null;
                    }
                    setDraft(t.name);
                    setEditing(i);
                  }}
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
                onExternalDrop={onExternalDrop}
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
