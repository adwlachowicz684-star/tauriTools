import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardInfo, CardKind, LinkDetail } from '../types';
import { isDark } from '../utils/color';
import { brushVars } from '../utils/visual';
import { ContextMenu, type MenuItem } from './ui';
import { useEdgeAutoScroll } from '../hooks/useEdgeAutoScroll';
import { canRemove } from '../utils/tabs';
import { displayIcon } from '../utils/icons';

export { DRAG_MIME, TAB_DRAG_MIME } from '../utils/dragSort';
/**
 * 拖拽的 MIME、载荷编解码、阈值、索引纠偏都收在 `utils/dragSort` 里 ——
 * 本插件有四套拖拽（卡片排序 / 跨栏建链 / 页签重排 / 分框重排），
 * 骨架相同、落点语义不同。公共部分只应有一份，否则兜底逻辑
 * （阈值、载荷校验、取消时清状态）改一处漏三处，而漏了恰好不报错。
 */
/* 下面同时 import 了两个类型：再导出语句（见文件顶部）**并不引入本地绑定** ——
   少了它们，正文里用到 DragPayload 的地方会编译失败。
   括号平衡检查抓不到这类错误，只有 tsc 会报。

   注意别把注释写进花括号里：花括号内的注释会把按逗号切分的静态检查搞乱，
   tsc 虽然没事，但检查脚本会误报（本轮踩到过）。 */
import {
  BOX_DRAG_MIME, DRAG_MIME, TAB_DRAG_MIME,
  DRAG_THRESHOLD, movedEnough,
  parseDragPayload, parseTabDrag,
  gapIndexAt, resolveMoveIndex,
  isExternalDrag, entriesOf,
  resolveExternalDrop,
  type DragPayload, type TabDragPayload, type DropItems, type DropNameFiles,
} from '../utils/dragSort';

/**
 * `dataTransfer.files` → dragSort 要的 `DropNameFiles`。
 *
 * 浏览器给的是 **FileList**：类数组，且标准 `File` 上**没有** `path`
 * —— 而 dragSort 那三个函数要的是 `{ name, path: string | null }[]`。
 * 直接传就是 TS2345（FileList 不能赋给 readonly DropNameFile[]）。
 *
 * `path` 是宿主开了 `dragDropEnabled` 之后 **Tauri 挂在 File 上的**
 * 磁盘绝对路径，标准浏览器里没有，所以读不到就是 `null`，
 * 交给 `dirPathOf` 判空后退回对话框 —— 与 dragSort 的约定一致。
 */
function dropFilesOf(files: FileList | null): DropNameFiles {
  if (!files || files.length === 0) return [];
  return Array.from(files).map((f) => {
    const p = (f as File & { path?: unknown }).path;
    return { name: f.name, path: typeof p === 'string' ? p : null };
  });
}

/**
 * 链接明细排序：**有问题的排前面**。
 *
 * 展开一个连了十几条的卡片时，用户要找的是"哪条坏了"，
 * 而不是从头看一遍。有效的那些按名字排序（稳定、可预期）。
 */
function sortedDetails(list: LinkDetail[]): LinkDetail[] {
  const rank = (s: string) => (s === 'conflict' ? 0 : s === 'broken' ? 1 : 2);
  return [...list].sort((a, b) =>
    rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

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
export type { TabDragPayload } from '../utils/dragSort';

export type { DragPayload } from '../utils/dragSort';

/** 页签条：切换 / 新增 / 双击重命名 / 右键删除 */
export function TabBar({
  tabs, active, onSelect, onAdd, onRename, onRemove, kind,
  editing: editingProp, onEditingDone, onDropCard, onMoveTab,
}: {
  /* items 是页签里的条目（App 传的是 TabInfo）。
     类型写窄成 { name: string } 会让下面读 t.items.length 报 TS2339 —— 页签上要显示
     「里面有几项」，这个字段是必须的。 */
  tabs: { name: string; items: CardInfo[] }[];
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
  /**
   * #14 / #360 从文件管理器拖进来的东西。
   *
   * 比卡片区多一个 `tabIndex`：**拖到哪个页签上就落到哪个页签**
   * （原版 `OnTabDrop` → `AddFavoriteToTab("project", idx, f2)`）。
   *
   * 此前这个 prop 声明了却**从没被 onDrop 调用过**（onDragOver/onDrop
   * 里只有内部 MIME 两个分支），拖文件夹到页签上会直接回弹、
   * 界面毫无变化。而外层 `externalDrop` 早就把 tabIndex 一路传到
   * `addCard` 了 —— 能力铺好了、入口没接上。
   *
   * 沉默地什么都不做是最糟的：用户拖了、松手了、界面毫无变化，
   * 他会以为这个功能坏了，而且下次还会再拖一次。
   */
  onExternalDrop?: (target: string, direct: boolean, tabIndex: number) => void;
  /** 拖的是文件或一段文字：一句话说清，不弹选目录框（弹了是误导） */
  onExternalNotice?: (kind: 'file' | 'empty', name: string) => void;
}) {
  const [selfEditing, setSelfEditing] = useState(-1);
  const [draft, setDraft] = useState('');
  /** 页签拖拽的插入位置（-1 无） */
  const [tabOver, setTabOver] = useState(-1);
  /**
   * #360 外部拖入正悬停在这个页签上（-1 无）。
   *
   * 要**单独一个状态**而不是复用 `dropTarget`：后者在卡片拖拽里
   * 表达"移到末尾"，而外部拖入要表达"加到这个页签" ——
   * 复用同一个状态的话，两种语义混在一个高亮上，用户看不出区别。
   */
  const [externalTab, setExternalTab] = useState(-1);

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
            externalTab === i ? 'external' : '',
            switchHint === i ? 'switch-hint' : '',
          ].filter(Boolean).join(' ')}
          onClick={() => onSelect(i)}
          onDoubleClick={() => startEdit(i)}
          /* 同样要先选中：页签右键菜单里的「重命名当前页签 / 删除当前页签」
             作用于**活动页签**。若右键非活动页签时不先切过去，
             删掉的就是用户没打算动的那一个 —— 比卡片那处更危险，
             因为删页签会连带清掉里面登记的所有卡片。 */
          onContextMenu={(e) => {
            e.preventDefault();
            onSelect(i);
            setMenu({ i, x: e.clientX, y: e.clientY });
          }}
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
            /*
             * #360 外部拖入（文件管理器拖文件夹过来）。
             *
             * 必须 preventDefault：不阻止的话浏览器会把这次 drop 判为
             * "未接受"，拖影弹回去、界面毫无变化 ——
             * 用户只会以为拖到页签上不支持。
             */
            if (isExternalDrag(e.dataTransfer.types)) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'copy';
              setExternalTab(i);
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
          onDragLeave={() => {
            setDropTarget(-1); setTabOver(-1); setExternalTab(-1); cancelHoverSwitch();
          }}
          onDrop={(e) => {
            /*
             * #360 外部拖入最优先：它的 types 里一个内部 MIME 都没有，
             * 不会与下面两个分支混淆，但**反过来**若放在后面，
             * 就会被 `onMoveTab` 里的 `rawTab` 判空逻辑挡住
             * （取不到内部数据 → 直接 return，外部分支永远走不到）。
             */
            if (isExternalDrag(e.dataTransfer.types)) {
              e.preventDefault();
              e.stopPropagation();
              setExternalTab(-1);
              const files = dropFilesOf(e.dataTransfer.files);
              const out = resolveExternalDrop(files, entriesOf(
                e.dataTransfer.items as unknown as DropItems | null,
              ));
              if (out.kind !== 'dir') {
                onExternalNotice?.(out.kind, out.name);
                return;
              }
              onExternalDrop?.(out.target, out.direct, i);
              return;
            }
            // 先看是不是页签重排
            if (onMoveTab) {
              const rawTab = e.dataTransfer.getData(TAB_DRAG_MIME);
              const t = parseTabDrag(rawTab);
              /* 同上：解析不出来就不 preventDefault，让浏览器回弹。
                 拖到自己身上（t.index === i）也不算放置成功，一并放过。 */
              if (rawTab) {
                setTabOver(-1);
                if (!t || t.kind !== kind || t.index === i) return;
                e.preventDefault();
                e.stopPropagation();
                onMoveTab(t.index, i);
                return;
              }
            }
            if (!onDropCard) return;
            const raw = e.dataTransfer.getData(DRAG_MIME);
            const drag = parseDragPayload(raw);
            setDropTarget(-1);
            /*
             * 回弹（A57）：**载荷无效时不要 preventDefault**。
             *
             * 浏览器只在 drop "被接受"时才不做回弹动画。先 preventDefault
             * 再校验的话，无效放置看起来和成功一模一样 —— 拖影直接消失、
             * 界面毫无变化，用户以为放下去了，其实什么也没发生。
             *
             * 所以把解析提到前面，确认有效后才 preventDefault。
             */
            if (!drag) return;
            e.preventDefault();
            e.stopPropagation();
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
                if (e.key === 'Escape') {
  /*
   * #250 必须 stopPropagation：这次 Esc 只想退出改名，
   * 若继续冒到 window，上面压着的浮层那层也会响应 ——
   * 于是"退一步"变成"连底下一层一起退"。
   */
  e.stopPropagation();
  endEdit(false);
}
              }}
            />
          ) : (
            <>
              {t.name}
              {/* #27 页签上的 × 关闭按钮。
                  此前只能走 ⋮ 右键菜单或页签管理面板 —— 删页签是常用操作，
                  每次都绕一层菜单很烦。

                  两个硬约束：
                  1. **平时不显形**（hover / 聚焦才出来）。删页签会连带清掉
                     里面登记的所有卡片，常显的 × 太容易误点。
                  2. **只剩一个页签时不显示**。点了会失败，按钮却在那儿，
                     用户会以为是坏了 —— 不如干脆不给。 */}
              {onRemove && canRemove(tabs.length) && editing !== i && (
                <button
                  type="button"
                  className="fpx-tab-x"
                  title={t.items.length > 0
                    ? `删除页签「${t.name}」（连同里面 ${t.items.length} 项）`
                    : `删除页签「${t.name}」`}
                  onClick={(e) => {
                    /* 必须阻止冒泡：否则会先触发页签的 onClick（选中），
                       双击时还会和 startEdit 抢 —— 表现为"点了 × 却进了重命名"。 */
                    e.stopPropagation();
                    onRemove(i);
                  }}
                  /* 拖动中不删：拖拽期间误触会把页签连同卡片一起删掉 */
                  onDragStart={(e) => e.preventDefault()}
                >
                  ×
                </button>
              )}
              {/* #297 页签上显示条目数。
                  此前只标 P/G（类别），看不出这个页签里有几张卡 ——
                  而"这个分类有多少东西"正是切页签前最想知道的：
                  空的页签点进去只有一句空提示，白点一次。 */}
              <span
                className={`fpx-tab-count${t.items.length === 0 ? ' zero' : ''}`}
                title={`${t.items.length} 项`}
              >{t.items.length}</span>
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
  onExternalDrop, onExternalNotice,
  emptyHint, onJumpToGroup, onEditLink, onAdd, addHint,
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
  /**
   * #14 从文件管理器拖进来的东西（只有名字，没有路径 —— 见 TabBar 同名注释）。
   * 沉默地什么都不做是最糟的：用户拖了、松手了、界面毫无变化。
   */
  /**
   * #14 从文件管理器拖入文件夹。
   *
   * @param target 绝对路径（拿得到时）或名字（拿不到时的兜底）
   * @param direct true = 拿到了真实路径，调用方应**直接导入**，不要再弹对话框
   */
  onExternalDrop?: (target: string, direct: boolean) => void;
  /**
   * 拖进来的东西**不是文件夹**时的告知（拖了单个文件，或拖了一段文字）。
   *
   * 与 onExternalDrop 分开：那边是"接到正规流程上"，这边是"说清楚为什么
   * 没接"。合成一个回调的话，调用方得靠参数自己分派，
   * 而这两件事的处理方式完全不同（弹框 vs 提示一句话）。
   */
  onExternalNotice?: (kind: 'file' | 'empty', name: string) => void;
  menus: (card: CardInfo) => MenuItem[];
  emptyHint: string;
  /* #287 卡片区末尾的「＋」虚线框。
     可选：不传就不渲染（内容区等不需要添加入口的地方不该多出一个框）。 */
  onAdd?: () => void;
  /** 虚线框上的文案；不传则用默认值 */
  addHint?: string;
  /**
   * 点卡片上的项目组名就跳过去选中它（对照 WPF 的 SelectLinkedGroupCommand）。
   * 传整张卡片而不是组名：CardInfo 里只有组**名**、没有组**路径**，
   * 而定位要的是路径，得由外层从链接记录里反查。
   */
  onJumpToGroup?: (card: CardInfo) => void;
  /**
   * #82 点链接名→编辑该项目的链接。
   *
   * 传的是「项目路径 + 这一行指向的项目组路径」，不是整张卡片：
   * 明细里每一行的 group 可能不同（一个项目可以有多条链接记录），
   * 只传卡片会拿到 `linkedGroup`（汇总值），编辑的就不是用户点的那一条。
   *
   * 不传就不渲染成可点 —— 比渲染一个点了没反应的按钮好。
   */
  onEditLink?: (project: string, group: string) => void;
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
   * #74 / #190 让位动画：被拖卡片的高度（含间距），决定其他卡让开多少。
   *
   * 在 dragStart 时量一次即可 —— 拖拽过程中它不会变。
   * 取 offsetHeight + gap：少算 gap 的话让开的缝会刚好卡住卡片，
   * 看着像"没完全让开"。
   */
  const [dragH, setDragH] = useState(0);
  /** 卡片间距，与 CSS 的 gap 保持一致（.fpx-cards 是 8px） */
  const CARD_GAP = 8;

  /**
   * 某张卡此刻该让开多少（正数下移、负数上移、0 不动）。
   *
   * 不真的重排数组 —— 重排会让 React 重建 DOM 顺序，
   * 而 CSS transition 对"DOM 顺序变了"是**不生效**的（要做 FLIP 才行，
   * 得逐项测量、补偿、再动画归零，成本高且易错）。
   * 用 transform 位移表达让位，视觉结果一样，且天然可过渡。
   */
  const shiftOf = (i: number): number => {
    if (!dragPath || dropAt === null || overCross || !dragH) return 0;
    const from = cards.findIndex((c) => c.path === dragPath);
    if (from < 0) return 0;
    const to = resolveMoveIndex(from, dropAt, cards.length);
    if (to === from) return 0;
    if (to < from && i >= to && i < from) return dragH + CARD_GAP;
    if (to > from && i > from && i <= to) return -(dragH + CARD_GAP);
    return 0;
  };
  /**
   * 已展开链接明细的卡片（#16）。
   *
   * 纯视图状态，不写进配置：折叠与否只影响当前这一次浏览，
   * 下次打开回到默认（收起）反而更好——否则卡片一多，展开态堆在一起更乱。
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 有链接明细的卡片数（决定要不要显示"展开全部"） */
  const linkableCount = cards.filter((c) => (c.linkDetails?.length ?? 0) > 0).length;
  /** 有失效 / 冲突链接的卡片数：不展开也要能看见有问题 */
  const badCount = cards.filter((c) => (c.linkDetails ?? []).some((d) => d.state === 'broken')).length;
  const conflictCount = cards.filter((c) => (c.linkDetails ?? []).some((d) => d.state === 'conflict')).length;
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
  /** 上半区插到它前面、下半区插到后面（算术在 utils/dragSort 里，那里有穷举测试） */
  const posOf = (e: React.DragEvent<HTMLElement>, i: number): number =>
    gapIndexAt(e.currentTarget.getBoundingClientRect(), e.clientY, i);

  /**
   * 同栏移动时的**索引修正**——最容易写错的一处。
   *
   * 后端 moveCard 是「先把卡片从所有页签里摘掉，再插入到目标下标」。
   * 所以在**当前数组**（还含被拖卡片）里算出的缝隙位置 k，
   * 摘卡之后要换算：若被拖卡片原本在 k 之前，它一走后面的都前移一位，k 要减 1。
   *
   * 不减的话，往上拖会稳定"落点偏后一格"——表现为"明明插在 A 前面，结果跑到 A 后面"。
   */
  /**
   * 同栏移动时的索引修正——算术在 `utils/dragSort::resolveMoveIndex` 里，
   * 与页签重排、分框重排共用同一份（这三处此前各写一套，必有漂移）。
   */
  const resolveIndex = (p: string, k: number): number =>
    resolveMoveIndex(cards.findIndex((c) => c.path === p), k, cards.length);

  /** #14 外部拖入悬停中：整区虚线高亮（不画插入竖条） */
  const [externalOver, setExternalOver] = useState(false);

  /** 拖拽结束（含被取消）一律清干净：拖到窗口外松手时 drop 不触发，
   *  不靠 dragend 兜底的话竖条会残留在屏幕上。 */
  const clearDrop = () => {
    setDropAt(null); setOverCross(false); setDragPath(null); setExternalOver(false);
  };

  /* 贴边自动滚动（#104）：拖到卡片区上下边缘时列表自己滚。
     卡片多的时候（几十项）不这样就没法把卡片拖到另一头。
     注意必须在 clearDrop 里一起 stop —— 忘了停的话容器会一直自己滚。 */
  const cardsRef = useRef<HTMLDivElement>(null);
  const { onDragOver: onEdgeDragOver, stop: stopEdgeScroll } =
    useEdgeAutoScroll(cardsRef, dragPath !== null);

  const clearDropWithScroll = () => {
    clearDrop();
    stopEdgeScroll();
  };

  return (
    <div
      /* #105 空列表时不画孤零零一条竖条，改为**整区高亮**：
         列表里一张卡都没有，竖条没有"插在哪两张之间"的参照，
         看着像界面坏了。整区高亮才能表达"会落到这里面"。 */
      /* shifting：只在拖拽中开过渡。平时不开 —— 否则任何 transform 变化
         （包括列表重排带来的）都会慢半拍地飘一下。 */
      className={`fpx-cards${cards.length === 0 && dropAt === 0 && draggingKind === kind ? ' empty-over' : ''}${
        dragPath && !overCross ? ' shifting' : ''}${externalOver ? ' external-over' : ''}`}
      ref={cardsRef}
      onDragOver={(e) => {
        /* 分类框重排时（BOX_DRAG_MIME）会经过这里的卡片区 ——
           此时不能显示卡片落点，否则用户只是在调分类顺序，
           界面却冒出一条"卡片要插到这儿"的竖条，看着像要误操作。
           这是把四套拖拽收进同一份内核时才发现的互相干扰。 */
        if (e.dataTransfer.types.includes(BOX_DRAG_MIME)) return;
        /*
         * #14 外部拖入：**只画整区高亮，不画插入竖条**。
         * 竖条表达"插在这两张之间"，而外面的文件夹不是卡片、
         * 没有"插到哪儿"这一说；画竖条会让用户以为拖的东西被插进了列表中间。
         */
        if (isExternalDrag(e.dataTransfer.types)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setExternalOver(true);
          return;
        }
        /* 记指针位置给贴边自动滚动（#104）。放在守卫**之后**：
           调分类框顺序时不该连带把卡片区滚起来。 */
        onEdgeDragOver(e);
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // 落在卡片区空白处：插到末尾（跨栏则是换栏，另有高亮，不画竖条）
        if (draggingKind === kind) setDropAt(cards.length);
      }}
      onDragLeave={(e) => {
        // 只有真正离开整个卡片区才清；移到子卡片上时 relatedTarget 仍在容器内
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          clearDropWithScroll();
          setExternalOver(false);
        }
      }}
      onDrop={(e) => {
        /*
         * #14 外部拖入：拿到的是 File 对象，**没有磁盘绝对路径**
         * （浏览器沙箱只给内容不给路径；要真路径得开宿主的
         * `dragDropEnabled`，那是宿主级配置，不由本插件改）。
         *
         * 所以这里不假装能加卡片，而是把用户"想加这个文件夹"的意图
         * 接到正规的选目录流程上，并把名字带过去当提示。
         * 什么都不做（现状）比这个糟得多 —— 拖了、松手了、毫无反应。
         */
        if (isExternalDrag(e.dataTransfer.types)) {
          e.preventDefault();
          setExternalOver(false);
          /*
           * 分类后再决定做什么 —— **不能**一律弹选目录框。
           *
           * 拖一段选中的文字进来也会命中 isExternalDrag（它的 types 里
           * 一个内部 MIME 都没有），files 却是空的。此时弹「选择目录」
           * 是纯粹的误导：用户拖的是文字，界面却问他要哪个目录。
           *
           * 拖单个文件同理 —— 他要加的是文件夹，弹框也接不上。
           * 这两种都给一句明确的话，而不是干脆静默（静默正是 #14 要修的）。
           */
          /*
           * 分类逻辑走 `resolveExternalDrop`（与页签条共用一份）。
           * 这里此前是内联的，页签条若各写一套就会漂移 ——
           * 表现为"拖到卡片区正常、拖到页签上却弹了个误导性的框"。
           */
          const files = dropFilesOf(e.dataTransfer.files);
          const out = resolveExternalDrop(files, entriesOf(
            e.dataTransfer.items as unknown as DropItems | null,
          ));
          if (out.kind !== 'dir') {
            /* 拖单个文件或一段文字：一句话说清，不弹框。
               弹「选择目录」在这种场景是纯粹的误导。 */
            onExternalNotice?.(out.kind, out.name);
            return;
          }
          /*
           * 是文件夹。拿到绝对路径就**直接导入**，不再让用户重选一次。
           *
           * 那次重选（`droppedName` 提示那段）是浏览器沙箱拿不到路径时
           * 被迫加的，不是本意 —— 现在宿主开了 dragDropEnabled，
           * 路径就在 File 上，能直接导入就该直接导入。
           *
           * 仍拿不到路径时（比如运行在纯浏览器里调试）才退回对话框，
           * 否则"拖了没反应"这个原痛点又会回来。
           */
          onExternalDrop?.(out.target, out.direct);
          return;
        }
        const raw = e.dataTransfer.getData(DRAG_MIME);
        const drag = parseDragPayload(raw);
        // 先取数再清状态：清早了就拿不到 data 了
        const k = dropAt;
        clearDropWithScroll();
        /*
         * 回弹（A57）：拖到**空白处**是最需要这个反馈的场景 ——
         * 用户拖到列表外/卡片之间的空地，什么都没发生。
         * 无条件 preventDefault 会让拖影直接消失，
         * 看着就像"放下去了"，而他下次还会往那儿拖。
         */
        if (!drag) return;
        e.preventDefault();
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
          <span className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>{linkableCount} 个有链接</span>
          {(badCount > 0 || conflictCount > 0) && (
            <span className="fpx-links-summary">
              {conflictCount > 0 && <span className="bad">{conflictCount} 冲突</span>}
              {badCount > 0 && <span className="warn">{badCount} 失效</span>}
            </span>
          )}
        </div>
      )}

      {cards.length === 0 && <div className="nx-empty fpx-empty">{emptyHint}</div>}

      {cards.map((c, i) => {
        /* 标签色的三态派生**只算一次**：派生结果既要写进 CSS 变量，
           又要给左边框用基色。算两次既浪费，也让"两处拿到不同值"
           成为可能 —— 正是要避免的那种漂移。 */
        const tag = brushVars(c.tagColor ?? '', 'tag');
        return (
        <div
          key={c.path}
          /* 给"跳转后滚到这张卡"用（#19）。
             用 data 属性而不是 ref：卡片在子组件里层层嵌套，
             App 层拿不到它们的 ref，而选择器在需要时查一次就够了。
             路径里可能含引号，用 CSS.escape 兜住。 */
          data-card-path={c.path}
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
          style={(() => {
            /*
             * 标签色：三态派生交给 `brushVars`（utils/visual）统一算 ——
             * 此前这里是两个内联魔数（0.18 / -0.12），而链接按钮完全没有
             * 派生，于是"卡片有悬停反馈、链接按钮没有"。
             * 收进一处后两者必然同步，改配色也只改一处。
             *
             * #74 让位位移：写在 transform 上，过渡时长由 CSS 给（#190）。
             * 合并成**一个** style 对象 —— React 里后写的 style 会整份覆盖，
             * 不能写两个 style 属性。
             */
            const sh = shiftOf(i);
            return {
              ...(c.tagColor ? { ...tag, borderLeft: `4px solid ${tag['--tag-base'] ?? c.tagColor}` } : null),
              ...(sh ? { transform: `translateY(${sh}px)` } : null),
            } as React.CSSProperties;
          })()}
          draggable
          onPointerDown={(e) => { pressAt.current = { x: e.clientX, y: e.clientY }; }}
          onDragStart={(e) => {
            // 阈值判定：抖动不够 → 取消这次拖拽，让它退化成普通点击
            if (!movedEnough(pressAt.current, e.clientX, e.clientY, DRAG_THRESHOLD)) {
              e.preventDefault();
              return;
            }
            e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind, path: c.path } satisfies DragPayload));
            e.dataTransfer.effectAllowed = 'move';
            draggingKind = kind;
            /* #74 量一次被拖卡片的高度，供让位位移用 */
            setDragH(e.currentTarget.offsetHeight);
            setDragPath(c.path);
          }}
          onDragEnd={() => {
            draggingKind = null;
            setDragPath(null);
            /* 清掉让位位移，否则松手后卡片停在让开的位置上不回来 */
            setDragH(0);
            clearDropWithScroll();
            setOver(-1);
          }}
          onDragOver={(e) => {
            // 同上：分类框重排经过时不参与
            if (e.dataTransfer.types.includes(BOX_DRAG_MIME)) return;
            e.preventDefault();
            e.stopPropagation();
            const cross = draggingKind !== null && draggingKind !== kind;
            setOverCross(cross);
            setOver(i);
            // 跨栏是"连上这张卡"，没有插入位置的概念
            setDropAt(cross ? null : posOf(e, i));
          }}
          onDrop={(e) => {
            e.stopPropagation();
            const raw = e.dataTransfer.getData(DRAG_MIME);
            const drag = parseDragPayload(raw);
            const k = dropAt;
            const cross = overCross;
            clearDropWithScroll();
            setOver(-1);
            /*
             * 回弹（对照 tab-drag 的 A57）：**数据无效时不要 preventDefault**。
             *
             * 浏览器只在 drop "被接受"时才不做回弹动画。无条件
             * preventDefault 会让无效放置看起来像成功 —— 拖影直接消失、
             * 没有任何反馈，用户以为放下去了，其实什么也没发生。
             *
             * 不 preventDefault 时浏览器会把拖影动画飞回原位，
             * 那正是"这次没生效"该有的反馈。
             *
             * 注意 dragover 的 preventDefault 必须保留（否则 drop 根本不触发），
             * 这里动的只是 drop 这一下。
             */
            if (!drag) return;
            e.preventDefault();
            if (cross || drag.kind !== kind) onCrossDrop(drag, c);
            else onMove(drag.path, resolveIndex(drag.path, k ?? i));
          }}
          onClick={() => onSelect(c.path)}
          onDoubleClick={() => onOpen(c.path)}
          /* #261 右键**先把这张卡选中**，再弹菜单。
             否则用户右键完看到的菜单里写着"改名/搬家/删除"，
             却不知道它作用于谁 —— 而卡片此时并没有任何选中反馈，
             一旦菜单项作用于另一张（上一次选中的）卡，就是删错了东西。
             先选中还顺带解决另一个问题：菜单项里不少是"对当前选中项操作"，
             不先选中的话它们会作用到一张用户没打算动的卡上。 */
          onContextMenu={(e) => {
            e.preventDefault();
            onSelect(c.path);
            setMenu({ card: c, x: e.clientX, y: e.clientY });
          }}
        >
          <div className="fpx-card-top">
            <span className="fpx-card-icon">
              {displayIcon(c) && thumbs?.[displayIcon(c) as string]
                ? <img src={thumbs[displayIcon(c) as string]} alt="" />
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
            {/*
              链接指示（视觉规范 #126 #127）：
              原版**项目卡片**是「圆点 + 数字」，圆点颜色随状态变
              （蓝有效 / 红破坏 / 黄冲突）；**项目组卡片**则是一个 8×8 小蓝点，
              有项目链接到它时才出现。
              此前两类都统一用 emoji「🔗 3」，既没有状态色，也分不出卡片类型。

              改回圆点的理由不只是"对齐原版"：emoji 在不同系统上字形与配色不同，
              且颜色无法随主题走；圆点是 CSS 画的，能跟随 --accent / --danger / --warn。
            */}
            {(c.linkDetails?.length ?? 0) > 0 ? (
              <button
                className="fpx-badge link expandable"
                title="展开 / 收起链接明细"
                onClick={(e) => { e.stopPropagation(); toggleLinks(c.path); }}
              >
                <span className={`fpx-link-dot ${
                  c.hasConflict ? 'conflict' : c.hasBroken ? 'broken' : 'valid'
                }`} />
                {c.linkCount}
                <span className={`fpx-link-arrow${expanded.has(c.path) ? ' open' : ''}`}>▸</span>
              </button>
            ) : (
              c.hasLink && (
                <span className="fpx-badge link" title="已建链接">
                  <span className={`fpx-link-dot ${
                    c.hasConflict ? 'conflict' : c.hasBroken ? 'broken' : 'valid'
                  }`} />
                  {c.linkCount}
                </span>
              )
            )}
            {/* 项目组卡片：有项目链接到它时显示一个小蓝点（#126）。
                项目卡片不显示——它的链接数徽标已经在上面了，重复反而干扰。 */}
            {kind === 'group' && c.hasLink && (
              <span className="fpx-group-dot" title="有项目链接到这里" />
            )}
            {/* 链接到哪个项目组：光有「🔗 3」看不出连的是谁，必须把组名写出来。
                只在项目卡片上显示——项目组卡片自己就是组，写自己没意义。 */}
            {kind === 'project' && c.linkedGroup && (c.hasLink || c.hasBroken) && (
              <span
                className={`fpx-badge group${onJumpToGroup ? ' jump' : ''}`}
                /* #293：链接按钮跟随所属项目组的颜色派生三态。
                   此前它是个普通 badge，卡片有颜色反馈而它没有 ——
                   用户会觉得这个"看起来能点的东西"点不动。
                   用的是本卡片的 tagColor：当 tagColorInherited 为真时
                   它正是所链接项目组的颜色，语义上刚好对。 */
                style={c.tagColor ? (brushVars(c.tagColor, 'grp') as React.CSSProperties) : undefined}
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
            {/* #84 / #128 锁与盾牌**互斥**：
                · 有 ACL → 盾牌 🛡（真的拦得住，是"硬"保护）
                · 仅账面固定、无 ACL → 小锁 🔒（只是登记在案）
                两者都显示的话，用户分不清哪个是真拦着 ——
                而"以为被拦着其实没有"比"以为没拦其实有"更危险：
                前者会让人放心去删，然后撞上一条看不见的权限。 */}
            {c.locked ? (
              <span className="fpx-badge lock" title="ACL 已保护·防删除/防写入">🛡</span>
            ) : (c.accountFixed ? (
              <span className="fpx-badge pin" title="账面固定（仅登记，无系统权限）">🔒</span>
            ) : null)}
            {!c.exists && <span className="fpx-badge warn" title="文件夹不存在">✗ 缺失</span>}
          </div>

          {expanded.has(c.path) && (c.linkDetails?.length ?? 0) > 0 && (
            <div className="fpx-links">
              {sortedDetails(c.linkDetails!).map((d) => {
                /*
                 * 逐行**真实**指向优先（后端按磁盘反查得到）。
                 *
                 * 一个项目可以有多条链接指向**不同的组**（用户手工建了多个
                 * junction 就会这样）。此前整卡共用一个 group，于是某些行
                 * 显示的组名是错的 —— 而它看起来完全正常。
                 * 更糟的是 #82「点链接名编辑那一条」拿 group 去编辑，
                 * 改的就成了另一条：改了不该改的地方，且没有任何提示。
                 *
                 * 真实值缺失时（读不到 junction）退回账本值：
                 * "当初登记到哪"仍比空着有用。
                 */
                const gName = d.realGroupName || d.groupName;
                const gPath = d.realGroup || d.group;
                return (
                <div className={`fpx-link-row ${d.state}`} key={d.name + gPath}>
                  {/*
                    #292 对齐原版 `LinkedTabBtn`：**状态标识与链接名合成一个按钮**。

                    此前状态点是按钮外的一个空 span，而给它定尺寸的只有
                    `.fpx-badge .fpx-link-dot`（徽章内的那一处）——
                    明细行里根本不匹配，于是它是 0×0、**完全不可见**。
                    而且它没带状态类（`.valid/.broken/.conflict` 全在 CSS 里
                    定义了却没人用），所以就算显示出来也永远是一个颜色，
                    用户看不出哪条链接失效了，只能一个个悬停看提示。

                    合成到一个按钮里还有个实际好处：用户看到那个点会以为
                    它可点，点它却没反应最别扭；现在点标识和点名字是同一件事。
                  */}
                  {onEditLink ? (
                    <button
                      className="fpx-link-name edit"
                      /* #82 点链接名直接编辑这条链接。
                         看清某一行不对（失效 / 链错组）时，
                         最短路径就是点那一行本身，而不是回到卡片菜单里找。 */
                      title={d.tip || `编辑这条链接：${d.name}${gName ? ` → ${gName}` : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditLink(c.path, gPath);
                      }}
                    >
                      {/* 逐行 tip 分四种：项目没了 / 项目组没了 / 冲突 / 失效。
                          只给笼统的"链接异常"不够 —— 前两种的补救方式完全不同，
                          用户看不出区别就只能瞎试。 */}
                      <span className={`fpx-link-dot ${d.state}`} aria-hidden />
                      <span className="fpx-link-text">{d.name}</span>
                    </button>
                  ) : (
                    <span className="fpx-link-name" title={d.tip || d.name}>
                      <span className={`fpx-link-dot ${d.state}`} aria-hidden />
                      <span className="fpx-link-text">{d.name}</span>
                    </span>
                  )}
                  {kind === 'project' && gName && (
                    <>
                      <span className="fpx-link-to">→</span>
                      <span className="fpx-link-group"
                        /* #293：同上，明细里的组名也跟随组色派生 */
                        style={c.tagColor ? (brushVars(c.tagColor, 'grp') as React.CSSProperties) : undefined}
                        title={gPath || gName}
                        onClick={(e) => {
                          if (!onJumpToGroup) return;
                          e.stopPropagation();
                          onJumpToGroup(c);
                        }}>{gName}</span>
                    </>
                  )}
                  {/* 项目组文件夹没了要单独标出来 ——
                      它与"链接失效"是两回事：前者是目标被删，后者是链接断了。 */}
                  {d.state === 'valid' && d.groupExists === false && gPath && (
                    <span className="fpx-link-state">组缺失</span>
                  )}
                  {d.state !== 'valid' && (
                    <span className="fpx-link-state">{STATE_TEXT[d.state]}</span>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
        );
      })}

      {/* 虚线添加框（#287）：放在列表末尾，手就在附近，不必跑到顶部工具栏。
          空列表时它还是唯一入口 —— 那时工具栏按钮很容易被忽略。 */}
      {onAdd && (
        <button
          type="button"
          className="fpx-add-card"
          onClick={(e) => { e.stopPropagation(); onAdd(); }}
          title={addHint ?? '添加'}
        >
          ＋ {addHint ?? '添加'}
        </button>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menus(menu.card)} onClose={() => setMenu(null)} />}
    </div>
  );
}

/* #13 显示图标的选取规则在 utils/icons.ts：缩略图与兜底字形共用同一份 */
/** 卡片图标：自定义图标路径取文件名首字，否则按类型兜底 emoji */
function iconOf(c: CardInfo): string {
  const icon = displayIcon(c);
  if (icon) {
    if (icon.length <= 2) return icon;              // emoji / 字形
    const base = icon.split(/[\\/]/).pop() ?? icon;
    return base.slice(0, 1).toUpperCase();
  }
  return c.name.startsWith('.') ? '⚙' : '📁';
}
