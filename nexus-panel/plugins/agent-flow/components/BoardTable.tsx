import { useState, useMemo, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import {
  type BoardRow, type BoardColumn, type BoardColumnId,
  type BoardQuery, type BoardFilter,
  BOARD_COLUMNS, buildBoardRows, applyBoardQuery, boardActiveFilters,
  boardFilterActive, emptyBoardFilter, emptyBoardQuery, nextBoardSort,
  GROUP_SEP, priorityLabel, distinctOptionsOf,
} from '../engine/boardTable';
import { TABLE_ROW_HEIGHT, tableSlice } from '../engine/taskTable';
import { formatDateTime } from '../engine/history';
import {
  type BoardMeta, TAG_PALETTE,
  statusOf as statusOfMeta, tagOf as tagOfMeta,
} from '../engine/boardMeta';
import { shortId } from '../engine/session';
import type { TaskBoard } from '../engine/taskBoard';

/**
 * 任务板表格 —— 任务管理器的表格视图。
 *
 * ================= 为什么和运行记录表格是两套 =================
 *
 * 那边放的是"哪次跑怎么样"（耗时/进度/节点数），
 * 这边放的是"要做什么"（说明/优先级/标签/谁认领）。
 *
 * 两套数据的字段几乎不重叠。曾经并成一张表，结果同一行里互相留空 ——
 * 运行行在"说明"列空着、计划行在"耗时"列空着，一半格子是「—」。
 * 那不是功能更全，是两张表硬叠在一起。所以这里另起一份。
 *
 * ================= 为什么每列都能筛选和排序 =================
 *
 * "哪些任务该出现"由筛选决定 —— 表格覆盖全部任务，
 * 于是每列的筛选就是唯一的入口。
 * 只给状态做筛选的话，"找没人认领的高优先级任务"就做不了，
 * 而那两列明明就在屏幕上，看着能操作却点不动，比没有更难受。
 */

/** 一行的列宽布局。行与表头共用同一份，不对齐的话整列会错开一格 */
function colsExpr(): string {
  return BOARD_COLUMNS.map((c) => `${c.width}px`).join(' ');
}

/** 浅底深字 + 同色描边：一个 hex 现算，不另存一套浅色版 */
function tintStyle(color: string): CSSProperties {
  return {
    background: `${color}1f`,
    color,
    borderColor: `${color}59`,
  };
}

/* ------------------------------------------------------------------ */
/* 单元格                                                              */
/* ------------------------------------------------------------------ */

function StatusTag({ meta, id }: { meta: BoardMeta; id: string }) {
  const def = statusOfMeta(meta, id);
  if (!def) {
    /*
      状态被删了但任务上还挂着旧 id —— 显示成 id 而不是"未知"：
      至少能看出是哪个状态没了，好去修配置或改任务。
    */
    return <span className="af-tag af-tag-missing" title="这个状态已从流程配置里删掉">{id || '—'}</span>;
  }
  return (
    <span className="af-tag" style={tintStyle(def.color)} title={def.final ? '终态' : undefined}>
      {def.name}
    </span>
  );
}

/**
 * 标签列：列上直接增减。
 *
 * 「+」开在单元格里，不弹到设置页 —— 弹到别处改完要回来找
 * 刚才那一行在哪，几十行时根本找不到。
 */
function TagsCell({ meta, ids, taskId, onToggle, onCreateTag }: {
  meta: BoardMeta;
  ids: string[];
  taskId: string;
  onToggle: (taskId: string, tagId: string) => void;
  onCreateTag: (name: string, color: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="ttb-tags">
      {ids.map((id) => {
        const def = tagOfMeta(meta, id);
        if (!def) {
          return (
            <span key={id} className="af-tag af-tag-missing" title="这个标签已被删除">
              {id}
            </span>
          );
        }
        return (
          <button
            key={id}
            type="button"
            className="af-tag af-tag-btn"
            style={tintStyle(def.color)}
            title={`${def.name}（点击摘掉）`}
            onClick={(e) => { e.stopPropagation(); onToggle(taskId, id); }}
          >
            {def.name}
          </button>
        );
      })}
      <button
        type="button"
        className="ttb-tag-add"
        title="挂/摘一个标签"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        +
      </button>
      {open ? (
        <TagPicker
          meta={meta}
          picked={ids}
          onPick={(id) => onToggle(taskId, id)}
          onClose={() => setOpen(false)}
          onCreateTag={onCreateTag}
        />
      ) : null}
    </span>
  );
}

/** 标签浮层：勾选、改色、新建。新建完自动挂上，省一次点击 */
function TagPicker({ meta, picked, onPick, onClose, onCreateTag }: {
  meta: BoardMeta;
  picked: string[];
  onPick: (id: string) => void;
  onClose: () => void;
  onCreateTag: (name: string, color: string) => string | null;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(TAG_PALETTE[0]);
  return (
    <span className="ttb-tagpop" onClick={(e) => e.stopPropagation()}>
      <span className="ttb-tagpop-title">挂标签</span>
      {meta.tags.length === 0 ? (
        <span className="ttb-hint">还没有标签，在下面新建一个</span>
      ) : (
        meta.tags.map((t) => {
          const on = picked.indexOf(t.id) >= 0;
          return (
            <button
              key={t.id}
              type="button"
              className={`af-tag af-tag-btn${on ? ' is-on' : ''}`}
              style={tintStyle(t.color)}
              onClick={() => onPick(t.id)}
              title={on ? '点击摘掉' : '点击挂上'}
            >
              {t.name}
            </button>
          );
        })
      )}
      <span className="ttb-tagpop-new">
        <input
          className="p-input ttb-tagpop-name"
          value={name}
          placeholder="新标签名"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="ttb-swatches">
          {TAG_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              className={`ttb-swatch${c === color ? ' is-on' : ''}`}
              style={{ background: c }}
              title={c}
              onClick={() => setColor(c)}
            />
          ))}
        </span>
        <button
          type="button"
          className="mini"
          onClick={() => {
            const id = onCreateTag(name, color);
            if (id) { setName(''); onPick(id); }
          }}
          disabled={!name.trim()}
        >
          新建并挂上
        </button>
      </span>
      <span className="ttb-pop-foot">
        <button type="button" className="mini" onClick={onClose}>收起</button>
      </span>
    </span>
  );
}

/** 优先级类名**查表**给，不写成 `p${n}` —— 类名检查只认得前缀 `p` */
const PRIORITY_CLASS: Record<number, string> = {
  1: 'ttb-pri p1',
  2: 'ttb-pri p2',
  3: 'ttb-pri p3',
  4: 'ttb-pri p4',
};

function Cell({
  row, col, meta, attach, sessionId, onToggleTag, onCreateTag,
}: {
  row: BoardRow;
  col: BoardColumn;
  meta: BoardMeta;
  attach: Record<string, number>;
  /** 本窗口的 sessionID。用于把"我的"标出来 */
  sessionId: string;
  onToggleTag: (taskId: string, tagId: string) => void;
  onCreateTag: (name: string, color: string) => string | null;
}) {
  const t = row.task;
  switch (col.id) {
    case 'name':
      return <span className="ttb-text" title={t.title}>{t.title || '未命名任务'}</span>;
    /*
      所属组：显示完整路径并按深度缩进。
      光看文字，"登录"与"登录 › 接口"在扫视时差别不够明显。
    */
    case 'group': {
      if (!row.groupPath) return <span className="ttb-dim">—</span>;
      return (
        <span
          className="ttb-group"
          style={{ paddingLeft: Math.min(row.depth - 1, 4) * 8 }}
          title={row.groupPath}
        >
          {row.groupPath}
        </span>
      );
    }
    case 'status':
      return <StatusTag meta={meta} id={t.status} />;
    case 'priority': {
      if (!t.priority) return <span className="ttb-dim">—</span>;
      return (
        <span className={PRIORITY_CLASS[t.priority] || 'ttb-pri'} title={priorityLabel(t.priority)}>
          {priorityLabel(t.priority)}
        </span>
      );
    }
    case 'assignee':
      // 没人领也显示"未认领"，不留空白 —— 空白分不清是"没人"还是"没加载出来"
      return t.assignee
        ? <span className="ttb-text" title={t.assignee}>{t.assignee}</span>
        : <span className="ttb-dim">未认领</span>;
    case 'session': {
      if (!t.session) return <span className="ttb-dim">—</span>;
      const mine = t.session === sessionId;
      /*
        自己的那条标出来。
        窗口号是 w_3f2a91 这种编号，几十行里找"哪个是我的"根本找不到 ——
        必须有个视觉锚点，否则"只看我的"这个能力等于没有。
      */
      return (
        <span
          className={`ttb-sid${mine ? ' is-mine' : ''}`}
          title={`${t.session} · ${mine ? '本窗口认领的' : '别的窗口认领的'}`}
        >
          {mine ? '● ' : ''}{shortId(t.session)}
        </span>
      );
    }
    case 'tags':
      return (
        <TagsCell
          meta={meta}
          ids={t.tags}
          taskId={row.id}
          onToggle={onToggleTag}
          onCreateTag={onCreateTag}
        />
      );
    case 'desc':
      return t.desc
        ? <span className="ttb-text" title={t.desc}>{t.desc}</span>
        : <span className="ttb-dim">—</span>;
    case 'note':
      return t.note
        ? <span className="ttb-text" title={t.note}>{t.note}</span>
        : <span className="ttb-dim">—</span>;
    case 'created':
      return <span className="ttb-time">{t.createdAt ? formatDateTime(t.createdAt) : '—'}</span>;
    case 'updated':
      return <span className="ttb-time">{t.updatedAt ? formatDateTime(t.updatedAt) : '—'}</span>;
    case 'attach': {
      const n = attach[row.id] ?? 0;
      return n > 0
        ? <span className="ttb-num ttb-attach" title={`${n} 个附件`}>📎 {n}</span>
        : <span className="ttb-dim">—</span>;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* 筛选                                                                */
/* ------------------------------------------------------------------ */

/**
 * 某一列的选项。
 *
 * 抽成一份是因为**筛选面板**与**已生效筛选的摘要**都要用它 ——
 * 分开写的话，摘要那处拿的是 col.options，对动态列永远是空，
 * 于是 chip 上显示原始 id（"1"、"st_x"），面板里显示"P1 最高"。
 * 同一个筛选，两个地方说法不一样。
 */
function optionsOf(
  col: BoardColumn,
  meta: BoardMeta,
  assigneeOptions: { v: string; label: string }[],
  sessionOptions: { v: string; label: string }[],
): { v: string; label: string }[] {
  if (col.dynamic === 'status') return meta.statuses.map((s) => ({ v: s.id, label: s.name }));
  if (col.dynamic === 'tags') return meta.tags.map((t) => ({ v: t.id, label: t.name }));
  if (col.dynamic === 'assignee') return assigneeOptions;
  if (col.dynamic === 'session') return sessionOptions;
  return col.options || [];
}

/** 动态列没有选项时的说明。空面板会被当成"这一列的筛选坏了" */
function emptyOptionsHint(col: BoardColumn): string {
  if (col.dynamic === 'tags') return '还没有标签 —— 在标签列点「+」新建一个';
  if (col.dynamic === 'assignee') return '当前这批任务里还没有人认领';
  if (col.dynamic === 'session') return '当前这批里没有带窗口号的记录';
  if (col.dynamic === 'status') return '还没有配置状态';
  return '没有可选项';
}

/** 已生效筛选的一句摘要。chip 上写它，让人不用打开面板也知道当前筛了什么 */
function filterSummary(
  col: BoardColumn,
  f: BoardFilter,
  meta: BoardMeta,
  assigneeOptions: { v: string; label: string }[],
  sessionOptions: { v: string; label: string }[],
): string {
  switch (col.kind) {
    case 'enum': {
      const opts = optionsOf(col, meta, assigneeOptions, sessionOptions);
      const labels = f.values.map((v) => {
        const opt = opts.find((o) => o.v === v);
        return opt ? opt.label : v;
      });
      return labels.join('、');
    }
    case 'text':
      return f.text.trim();
    case 'number': {
      const lo = f.min.trim();
      const hi = f.max.trim();
      if (lo && hi) return `${lo} ~ ${hi}${col.unit || ''}`;
      if (lo) return `≥ ${lo}${col.unit || ''}`;
      return `≤ ${hi}${col.unit || ''}`;
    }
    case 'time': {
      const lo = f.min.trim();
      const hi = f.max.trim();
      if (lo && hi) return `${lo} ~ ${hi}`;
      if (lo) return `${lo} 起`;
      return `至 ${hi}`;
    }
    default:
      return '';
  }
}

function FilterPop({
  col, filter, onChange, onClear, anchorRight, meta, assigneeOptions, sessionOptions,
}: {
  col: BoardColumn;
  filter: BoardFilter;
  onChange: (f: BoardFilter) => void;
  onClear: () => void;
  /**
   * 面板贴单元格右边展开。
   *
   * 表比左栏宽得多（要横向滚动），末尾几列的面板若都从左边展开，
   * 大半会落到可视区外面 —— 得先横向滚一段才看得见，而滚动又会
   * 让面板跟着走。贴右边展开时，末尾几列正好落在看得见的地方。
   */
  anchorRight?: boolean;
  meta: BoardMeta;
  assigneeOptions: { v: string; label: string }[];
  sessionOptions: { v: string; label: string }[];
}) {
  const set = (patch: Partial<BoardFilter>) => onChange({ ...filter, ...patch });
  const popCls = `ttb-pop${anchorRight ? ' is-right' : ''}`;

  if (col.kind === 'enum') {
    const options = optionsOf(col, meta, assigneeOptions, sessionOptions);
    return (
      <div className={popCls}>
        <div className="ttb-pop-title">按{col.label}筛选</div>
        {options.length === 0 ? <div className="ttb-hint">{emptyOptionsHint(col)}</div> : null}
        {options.map((o) => {
          const on = filter.values.indexOf(o.v) >= 0;
          return (
            <label key={o.v} className="ttb-pop-item">
              <input
                type="checkbox"
                checked={on}
                onChange={() => set({
                  values: on ? filter.values.filter((x) => x !== o.v) : [...filter.values, o.v],
                })}
              />
              <span>{o.label}</span>
            </label>
          );
        })}
        <div className="ttb-pop-foot">
          <span className="ttb-hint">不选 = 不限</span>
          <button type="button" className="mini" onClick={onClear}>清除</button>
        </div>
      </div>
    );
  }

  if (col.kind === 'text') {
    return (
      <div className={popCls}>
        <div className="ttb-pop-title">按{col.label}筛选</div>
        <input
          className="p-input ttb-pop-input"
          value={filter.text}
          placeholder="包含关键词"
          onChange={(e) => set({ text: e.target.value })}
        />
        <div className="ttb-pop-foot">
          <span className="ttb-hint">不区分大小写</span>
          <button type="button" className="mini" onClick={onClear}>清除</button>
        </div>
      </div>
    );
  }

  if (col.kind === 'number') {
    return (
      <div className={popCls}>
        <div className="ttb-pop-title">按{col.label}筛选（{col.unit || '数值'}）</div>
        <div className="ttb-pop-row">
          <input
            className="p-input ttb-pop-num"
            type="number"
            value={filter.min}
            placeholder="最小"
            onChange={(e) => set({ min: e.target.value })}
          />
          <span className="ttb-hint">~</span>
          <input
            className="p-input ttb-pop-num"
            type="number"
            value={filter.max}
            placeholder="最大"
            onChange={(e) => set({ max: e.target.value })}
          />
        </div>
        <div className="ttb-pop-foot">
          <span className="ttb-hint">只填一边也行</span>
          <button type="button" className="mini" onClick={onClear}>清除</button>
        </div>
      </div>
    );
  }

  return (
    <div className={popCls}>
      <div className="ttb-pop-title">按{col.label}筛选</div>
      <div className="ttb-pop-row">
        <input
          className="p-input ttb-pop-date"
          type="date"
          value={filter.min}
          onChange={(e) => set({ min: e.target.value })}
        />
        <span className="ttb-hint">~</span>
        <input
          className="p-input ttb-pop-date"
          type="date"
          value={filter.max}
          onChange={(e) => set({ max: e.target.value })}
        />
      </div>
      <div className="ttb-pop-foot">
        <span className="ttb-hint">只填一边也行</span>
        <button type="button" className="mini" onClick={onClear}>清除</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 表格                                                                */
/* ------------------------------------------------------------------ */

export function BoardTable({
  board, meta, attach, sessionId, selectedId, onSelect,
  onToggleTag, onCreateTag, canWrite,
}: {
  board: TaskBoard;
  meta: BoardMeta;
  /** 每个任务挂了几个附件。按任务 id 索引 */
  attach: Record<string, number>;
  sessionId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleTag: (taskId: string, tagId: string) => void;
  onCreateTag: (name: string, color: string) => string | null;
  canWrite: boolean;
}) {
  const [query, setQuery] = useState<BoardQuery>(() => emptyBoardQuery());
  const [openCol, setOpenCol] = useState<BoardColumnId | ''>('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const cellRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => buildBoardRows(board), [board]);
  const shown = useMemo(() => applyBoardQuery(rows, query, attach), [rows, query, attach]);

  /*
    动态列的选项从**过滤后**的行里算。

    ⛔ 用过滤后的结果而不是全量：选项里若出现已经被筛掉的人，
    勾选他只会得到零行 —— 那是"明明选了却什么都没有"。
  */
  const assigneeOptions = useMemo(() => distinctOptionsOf(shown, 'assignee'), [shown]);
  const sessionOptions = useMemo(() => distinctOptionsOf(shown, 'session'), [shown]);

  const slice = useMemo(
    () => tableSlice(shown.length, scrollTop, viewportH),
    [shown.length, scrollTop, viewportH],
  );

  // 可视高度要扣掉表头，否则底部几行永远在视口外（它们被表头挡着）
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const head = headRef.current;
      setViewportH(Math.max(0, (wrap.clientHeight || 400) - (head ? head.offsetHeight : 0)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // 点面板外关闭。面板与漏斗按钮包在同一个单元格里，所以点按钮不算"外面"
  useEffect(() => {
    if (!openCol) return;
    const onDown = (e: MouseEvent) => {
      const el = cellRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setOpenCol('');
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openCol]);

  const onScroll = useCallback((e: { currentTarget: { scrollTop: number } }) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const setFilter = useCallback((id: BoardColumnId, f: BoardFilter) => {
    setQuery((q) => ({ ...q, filters: { ...q.filters, [id]: f } }));
  }, []);

  const clearFilter = useCallback((id: BoardColumnId) => {
    setQuery((q) => {
      const next = { ...q.filters };
      delete next[id];
      return { ...q, filters: next };
    });
  }, []);

  const clearAll = useCallback(() => setQuery(emptyBoardQuery()), []);

  const onSort = useCallback((id: BoardColumnId) => {
    setQuery((q) => ({ ...q, ...nextBoardSort({ sortKey: q.sortKey, sortDir: q.sortDir }, id) }));
  }, []);

  const active = useMemo(() => boardActiveFilters(query), [query, attach]);

  return (
    <aside className="side-pane">
      <div className="side-head">
        <span>全部任务</span>
        <span className="side-head-spacer" />
        <span className="task-count">
          {active.length > 0 || query.sortKey ? `${shown.length}/${rows.length}` : `${rows.length} 条`}
        </span>
        <button
          type="button"
          className="side-head-btn"
          onClick={clearAll}
          disabled={active.length === 0 && !query.sortKey}
        >
          重置
        </button>
      </div>

      {active.length > 0 ? (
        <div className="ttb-active">
          {active.map((id) => {
            const col = BOARD_COLUMNS.find((c) => c.id === id) as BoardColumn;
            const f = query.filters[id] as BoardFilter;
            return (
              <span key={id} className="ttb-chip">
                {col.label}：{filterSummary(col, f, meta, assigneeOptions, sessionOptions)}
                <button
                  type="button"
                  className="ttb-chip-x"
                  onClick={() => clearFilter(id)}
                  title={`清除「${col.label}」的筛选`}
                >
                  ✕
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

      <div
        className="ttb-wrap"
        ref={wrapRef}
        onScroll={onScroll}
        style={{ '--ttb-cols': colsExpr() } as CSSProperties}
      >
        <div className="ttb-head" ref={headRef}>
          <div className="ttb-grid ttb-hrow">
            {BOARD_COLUMNS.map((col, ci) => {
              const isOpen = openCol === col.id;
              const f = query.filters[col.id];
              const on = boardFilterActive(col, f);
              const sorted = query.sortKey === col.id;
              return (
                <div
                  key={col.id}
                  className={`ttb-th ${col.align === 'right' ? 'is-right' : ''}`}
                  ref={isOpen ? cellRef : null}
                >
                  <button
                    type="button"
                    className="ttb-th-label"
                    onClick={() => onSort(col.id)}
                    title="点击排序：降序 → 升序 → 不排序"
                  >
                    {col.label}
                    <span className="ttb-arrow">
                      {sorted ? (query.sortDir === 'desc' ? '▼' : '▲') : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`ttb-funnel ${on ? 'is-on' : ''} ${isOpen ? 'is-open' : ''}`}
                    onClick={() => setOpenCol(isOpen ? '' : col.id)}
                    title={`按${col.label}筛选`}
                  >
                    ⛏
                  </button>
                  {isOpen ? (
                    <FilterPop
                      col={col}
                      filter={f || emptyBoardFilter()}
                      onChange={(nf) => setFilter(col.id, nf)}
                      onClear={() => clearFilter(col.id)}
                      anchorRight={ci >= BOARD_COLUMNS.length - 3}
                      meta={meta}
                      assigneeOptions={assigneeOptions}
                      sessionOptions={sessionOptions}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="nx-empty ttb-empty">
            {rows.length === 0
              ? '还没有任务。在任务板里点「+ 任务」新建一条。'
              : '没有符合筛选条件的任务。点列头的漏斗图标调整或重置筛选。'}
          </div>
        ) : (
          <div className="ttb-body" style={{ height: slice.totalHeight }}>
            {shown.slice(slice.start, slice.end).map((row, i) => (
              <div
                key={row.key}
                className={`ttb-grid ttb-row ${selectedId === row.id ? 'is-active' : ''}`}
                style={{ top: (slice.start + i) * TABLE_ROW_HEIGHT }}
                onClick={() => onSelect(row.id)}
              >
                {BOARD_COLUMNS.map((col) => (
                  <div
                    key={col.id}
                    className={`ttb-cell ${col.align === 'right' ? 'is-right' : ''}`}
                  >
                    <Cell
                      row={row}
                      col={col}
                      meta={meta}
                      attach={attach}
                      sessionId={sessionId}
                      onToggleTag={onToggleTag}
                      onCreateTag={onCreateTag}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/*
        组不占行，但它是树的一部分 —— 这里说清为什么表格里看不到组，
        否则用户会以为"我的组丢了"。
      */}
      {rows.length > 0 ? (
        <div className="btb-foot">
          组不单独成行（它的状态由下面的任务决定），层级显示在「所属组」列
        </div>
      ) : null}
    </aside>
  );
}

/** 组路径分隔符。导出给需要拼路径的地方用 */
export { GROUP_SEP };
