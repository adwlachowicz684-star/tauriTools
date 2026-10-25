import { useState, useMemo, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import {
  type TableRow, type TableColumn, type TableColumnId,
  type TableQuery, type ColumnFilter,
  TABLE_COLUMNS, TABLE_ROW_HEIGHT,
  buildTableRows, applyTable, tableSlice, emptyFilter, emptyQuery,
  filterActive, activeFilterColumns, nextSort, formatEndedAt, ORIGIN_LABEL,
} from '../engine/taskTable';
import {
  type TaskRecord, progressOf, elapsedOf, formatDuration, SOURCE_LABEL,
} from '../engine/tasks';
import { formatDateTime } from '../engine/history';

import { StatusPill } from './TaskPanel';

/**
 * 任务表格 —— 任务视图左栏的**第二个视图**（与分组列表并列，可切）。
 *
 * ================= 与列表视图的分工 =================
 *
 * 列表按流程分组、带进度条和实时耗时，适合"盯正在跑的这几条"；
 * 表格一行一条、进行中与已归档一视同仁，适合"找某一条"：
 *   上周那次失败的在哪、某个流程跑了多久、手动跑的比定时跑的多不多。
 * 这些问题的答案都在**列**里，而列表视图没有列，只能一条条点开看。
 *
 * ================= 为什么每列都能筛选和排序 =================
 *
 * "哪些数据该出现"由筛选决定，不由入口决定 ——
 * 表格覆盖所有记录，于是筛选就是唯一的入口。
 * 只给状态和时间做筛选的话，"找耗时超过 5 分钟的那次"就做不了，
 * 而那一列明明就在屏幕上，看着能操作却点不动，比没有这列更难受。
 */

/** 一行的列宽布局。行与表头共用同一份，不对齐的话整列会错开一格 */
function colsExpr(): string {
  return TABLE_COLUMNS.map((c) => `${c.width}px`).join(' ');
}

/* ------------------------------------------------------------------ */
/* 单元格                                                              */
/* ------------------------------------------------------------------ */

/**
 * 单元格。
 *
 * 每一行都是一条运行记录，所有列都有值 ——
 * 这里不再需要"这类数据没有这个字段"的占位分支。
 */
function Cell({ row, col, now }: { row: TableRow; col: TableColumn; now: number }) {
  const t = row.record;
  switch (col.id) {
    case 'origin':
      return (
        <span className={`ttb-origin ${row.origin}`} title={ORIGIN_HINT[row.origin]}>
          {ORIGIN_LABEL[row.origin]}
        </span>
      );
    case 'name':
      return <span className="ttb-text" title={t.canvasName}>{t.canvasName || '未命名流程'}</span>;
    case 'status':
      return <StatusPill status={t.status} />;
    case 'source':
      return <span className="ttb-src">{SOURCE_LABEL[t.source] || t.source}</span>;
    case 'started':
      return <span className="ttb-time">{formatDateTime(t.startedAt)}</span>;
    case 'ended':
      return <span className="ttb-time">{formatEndedAt(t.endedAt)}</span>;
    case 'elapsed':
      return <span className="ttb-num">{formatDuration(elapsedOf(t, now))}</span>;
    case 'progress': {
      const p = progressOf(t);
      return (
        <span className="ttb-prog">
          <span className="ttb-bar">
            <span className={`ttb-bar-in ${t.status}`} style={{ width: `${p.percent}%` }} />
          </span>
          <span className="ttb-num">{p.percent}%</span>
        </span>
      );
    }
    case 'nodes': {
      const p = progressOf(t);
      return (
        <span className="ttb-num">
          {Math.max(t.total, t.order.length)}
          {p.failed > 0 ? <span className="ttb-bad">-{p.failed}</span> : null}
        </span>
      );
    }
    default:
      return null;
  }
}

/** 归属列的悬浮说明 */
const ORIGIN_HINT: Record<string, string> = {
  live: '当前会话，关掉就没了',
  archived: '已归档，跨会话保留',
};

/**
 * 已生效筛选的一句摘要。chip 上写它，让人不用打开面板也知道当前筛了什么。
 *
 * 取显示文案走 col.options —— 与筛选面板同一处来源，
 * 否则同一个筛选在 chip 上显示原始值、在面板里显示文案，说法不一致。
 */
function filterSummary(col: TableColumn, f: ColumnFilter): string {
  switch (col.kind) {
    case 'enum': {
      const labels = f.values.map((v) => {
        const opt = (col.options || []).find((o) => o.v === v);
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

/* ------------------------------------------------------------------ */
/* 筛选面板                                                            */
/* ------------------------------------------------------------------ */

function FilterPop({
  col, filter, onChange, onClear, anchorRight,
}: {
  col: TableColumn;
  filter: ColumnFilter;
  onChange: (f: ColumnFilter) => void;
  onClear: () => void;
  /**
   * 面板贴单元格右边展开。
   *
   * 表比左栏宽得多（要横向滚动），末尾几列的面板若都从左边展开，
   * 大半会落到可视区外面 —— 得先横向滚一段才看得见，而滚动又会
   * 让面板跟着走。贴右边展开时，末尾几列正好落在看得见的地方。
   */
  anchorRight?: boolean;
}) {
  const set = (patch: Partial<ColumnFilter>) => onChange({ ...filter, ...patch });
  const popCls = `ttb-pop${anchorRight ? ' is-right' : ''}`;

  if (col.kind === 'enum') {
    const options = col.options || [];
    return (
      <div className={popCls}>
        <div className="ttb-pop-title">按{col.label}筛选</div>
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
        <span className="ttb-hint">未结束的不参与</span>
        <button type="button" className="mini" onClick={onClear}>清除</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 表格                                                                */
/* ------------------------------------------------------------------ */

export function TaskTable({
  live, archived, now, selectedKey, onSelect,
}: {
  /** 当前会话的运行记录（不落盘） */
  live: TaskRecord[];
  /** 已归档记录（跨会话） */
  archived: TaskRecord[];
  now: number;
  /** `live:xxx` / `archived:xxx` */
  selectedKey: string | null;
  onSelect: (row: TableRow) => void;
}) {
  const [query, setQuery] = useState<TableQuery>(() => emptyQuery());
  const [openCol, setOpenCol] = useState<TableColumnId | ''>('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const cellRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => buildTableRows(live, archived), [live, archived]);

  /*
    排序**不能**跟着 now 重算。

    耗时的排序键每秒都在变，若把 now 放进依赖，正在跑的那条会每秒
    往前挪一格 —— 鼠标底下那行一直在换，点不中。
    筛选同理：填的是"≥300 秒"，指的是填的时候的值。
    now 只影响**显示**（耗时列实时走秒），不参与排序与筛选。
  */
  const nowRef = useRef(now);
  nowRef.current = now;
  const shown = useMemo(
    () => applyTable(rows, query, nowRef.current),
    [rows, query],
  );

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

  const setFilter = useCallback((id: TableColumnId, f: ColumnFilter) => {
    setQuery((q) => ({ ...q, filters: { ...q.filters, [id]: f } }));
  }, []);

  const clearFilter = useCallback((id: TableColumnId) => {
    setQuery((q) => {
      const next = { ...q.filters };
      delete next[id];
      return { ...q, filters: next };
    });
  }, []);

  const clearAll = useCallback(() => setQuery(emptyQuery()), []);

  const onSort = useCallback((id: TableColumnId) => {
    setQuery((q) => ({ ...q, ...nextSort({ sortKey: q.sortKey, sortDir: q.sortDir }, id) }));
  }, []);

  const active = useMemo(() => activeFilterColumns(query), [query]);

  return (
    <aside className="side-pane">
      <div className="side-head">
        <span>全部记录</span>
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
            const col = TABLE_COLUMNS.find((c) => c.id === id) as TableColumn;
            const f = query.filters[id] as ColumnFilter;
            return (
              <span key={id} className="ttb-chip">
                {col.label}：{filterSummary(col, f)}
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
            {TABLE_COLUMNS.map((col, ci) => {
              const isOpen = openCol === col.id;
              const f = query.filters[col.id];
              const on = filterActive(col, f);
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
                      filter={f || emptyFilter()}
                      onChange={(nf) => setFilter(col.id, nf)}
                      onClear={() => clearFilter(col.id)}
                      anchorRight={ci >= TABLE_COLUMNS.length - 3}
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
              ? '还没有任何记录。回到流程窗口点「运行」，这里会实时出现。'
              : '没有符合筛选条件的记录。点列头的漏斗图标调整或重置筛选。'}
          </div>
        ) : (
          <div className="ttb-body" style={{ height: slice.totalHeight }}>
            {shown.slice(slice.start, slice.end).map((row, i) => (
              <div
                key={row.key}
                className={`ttb-grid ttb-row ${selectedKey === row.key ? 'is-active' : ''}`}
                style={{ top: (slice.start + i) * TABLE_ROW_HEIGHT }}
                onClick={() => onSelect(row)}
              >
                {TABLE_COLUMNS.map((col) => (
                  <div
                    key={col.id}
                    className={`ttb-cell ${col.align === 'right' ? 'is-right' : ''}`}
                  >
                    <Cell row={row} col={col} now={now} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
