import { useState, useMemo, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import {
  type TableRow, type TableColumn, type TableColumnId,
  type TableQuery, type ColumnFilter,
  TABLE_COLUMNS, TABLE_ROW_HEIGHT,
  buildTableRows, applyTable, tableSlice, emptyFilter, emptyQuery,
  filterActive, activeFilterColumns, nextSort, formatEndedAt, ORIGIN_LABEL,
  priorityLabel, assigneeOptionsOf, sessionOptionsOf,
} from '../engine/taskTable';
import {
  type TaskRecord, progressOf, elapsedOf, formatDuration, SOURCE_LABEL,
} from '../engine/tasks';
import type { TaskBoard } from '../engine/taskBoard';
import { formatDateTime } from '../engine/history';
import {
  type BoardMeta, TAG_PALETTE,
  statusOf as statusOfMeta, tagOf as tagOfMeta,
} from '../engine/boardMeta';
import { shortId } from '../engine/session';
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
 * 三类行（计划 / 进行中 / 已归档）在这一处汇合 ——
 * 任务级列只有计划行有值，其余显示成"—"而不是空字符串：
 * 空白会被当成"加载中"或"渲染坏了"，而"—"明确表示"这类数据没有这个字段"。
 */
function Cell({ row, col, now, meta, counts, onToggleTag, onCreateTag, sessionId }: {
  row: TableRow;
  col: TableColumn;
  now: number;
  meta: BoardMeta;
  counts: Record<string, number>;
  onToggleTag: (taskId: string, tagId: string) => void;
  onCreateTag: (name: string, color: string) => string | null;
  sessionId: string;
}) {
  const t = row.record;
  const k = row.task;
  switch (col.id) {
    case 'origin':
      return (
        <span className={`ttb-origin ${row.origin}`} title={ORIGIN_HINT[row.origin]}>
          {ORIGIN_LABEL[row.origin]}
        </span>
      );
    case 'name': {
      const txt = k ? (k.title || '未命名任务') : t ? (t.canvasName || '未命名流程') : '';
      return <span className="ttb-text" title={txt}>{txt}</span>;
    }
    case 'status':
      return t ? <StatusPill status={t.status} /> : <span className="ttb-dim">—</span>;
    case 'source':
      return t ? <span className="ttb-src">{SOURCE_LABEL[t.source] || t.source}</span> : <span className="ttb-dim">—</span>;
    case 'started':
      return t ? <span className="ttb-time">{formatDateTime(t.startedAt)}</span> : <span className="ttb-dim">—</span>;
    case 'ended':
      return t ? <span className="ttb-time">{formatEndedAt(t.endedAt)}</span> : <span className="ttb-dim">—</span>;
    case 'elapsed':
      return t ? <span className="ttb-num">{formatDuration(elapsedOf(t, now))}</span> : <span className="ttb-dim">—</span>;
    case 'progress': {
      if (!t) return <span className="ttb-dim">—</span>;
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
      if (!t) return <span className="ttb-dim">—</span>;
      const p = progressOf(t);
      return (
        <span className="ttb-num">
          {Math.max(t.total, t.order.length)}
          {p.failed > 0 ? <span className="ttb-bad">-{p.failed}</span> : null}
        </span>
      );
    }
    /* ---------- 任务级 ---------- */
    case 'planStatus':
      return k ? <StatusTag meta={meta} id={k.status} /> : <span className="ttb-dim">—</span>;
    case 'desc':
      return k ? <span className="ttb-text" title={k.desc}>{k.desc || '—'}</span> : <span className="ttb-dim">—</span>;
    case 'note':
      return k ? <span className="ttb-text" title={k.note}>{k.note || '—'}</span> : <span className="ttb-dim">—</span>;
    case 'tags':
      return k
        ? <TagsCell
          meta={meta}
          ids={k.tags}
          taskId={row.ownerId}
          onToggle={onToggleTag}
          onCreateTag={onCreateTag}
        />
        : <span className="ttb-dim">—</span>;
    case 'created':
      return k ? <span className="ttb-time">{k.createdAt ? formatDateTime(k.createdAt) : '—'}</span> : <span className="ttb-dim">—</span>;
    case 'updated':
      return k ? <span className="ttb-time">{k.updatedAt ? formatDateTime(k.updatedAt) : '—'}</span> : <span className="ttb-dim">—</span>;
    case 'attach': {
      const n = counts[row.ownerId] ?? 0;
      return n > 0
        ? <span className="ttb-num ttb-attach" title={`${n} 个附件`}>📎 {n}</span>
        : <span className="ttb-dim">—</span>;
    }
    case 'priority': {
      if (!k || !k.priority) return <span className="ttb-dim">—</span>;
      return (
        <span className={PRIORITY_CLASS[k.priority] || 'ttb-pri'} title={priorityLabel(k.priority)}>
          {priorityLabel(k.priority)}
        </span>
      );
    }
    case 'assignee': {
      if (!k) return <span className="ttb-dim">—</span>;
      // 没人领也显示"未认领"，不留空白 —— 空白分不清是"没人"还是"没加载出来"
      return k.assignee
        ? <span className="ttb-text" title={k.assignee}>{k.assignee}</span>
        : <span className="ttb-dim">未认领</span>;
    }
    case 'session': {
      const sid = k ? (k.session || '') : t ? (t.session || '') : '';
      if (!sid) return <span className="ttb-dim">—</span>;
      const mine = sid === sessionId;
      /*
        自己的那条标出来。
        窗口号是 w_3f2a91 这种编号，几十行里找"哪个是我的"根本找不到 ——
        必须有个视觉锚点，否则"只看我的"这个能力等于没有。
      */
      const tip = mine
        ? '本窗口认领/发起的'
        : (k ? '别的窗口认领的' : '别的窗口发起的运行');
      return (
        <span className={`ttb-sid${mine ? ' is-mine' : ''}`} title={`${sid} · ${tip}`}>
          {mine ? '● ' : ''}{shortId(sid)}
        </span>
      );
    }
    default:
      return null;
  }
}

/*
  优先级档位的类名**查表**给，不写成 `p${n}`。

  理由同上面的 KIND_CLASS：类名检查只认得前缀 `p`，
  模板拼出来的每次都被判成"用了没定义"。
*/
const PRIORITY_CLASS: Record<number, string> = {
  1: 'ttb-pri p1',
  2: 'ttb-pri p2',
  3: 'ttb-pri p3',
  4: 'ttb-pri p4',
};

/** 归属列的悬浮说明。"计划"这一类要说清它为什么和运行记录混在一张表里 */
const ORIGIN_HINT: Record<string, string> = {
  live: '当前会话，关掉就没了',
  archived: '已归档，跨会话保留',
  board: '任务板上的计划条目（不是运行记录）',
};

/* ------------------------------------------------------------------ */
/* 标签化展示（状态 / 标签）                                            */
/* ------------------------------------------------------------------ */

/**
 * 彩色标签。
 *
 * 样式参考腾讯文档智能表的标签列：小圆角、**浅底深字**、描边同色 ——
 * 一眼能分类，又不像实心色块那样在窄列里糊成一片。
 *
 * 背景与描边都由同一个 hex 加透明度算出来，不另存一套"浅色版"：
 * 存两套的话，改颜色时只改了其中一套，标签会变成深底深字（看不清）。
 */
function tintStyle(color: string): CSSProperties {
  return {
    background: `${color}1f`,
    color,
    borderColor: `${color}59`,
  };
}

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
 * 一列上的标签。
 *
 * 「+」直接开在单元格里 —— 这是"在列上增减标签"的关键：
 * 弹到别处去改的话，改完要回来找刚才那一行在哪，几十行时根本找不到。
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

/**
 * 标签选择浮层：列上直接勾选、改色、新建。
 *
 * 与筛选面板里那套"只勾选"不同 —— 这里要能**新建并设置颜色**，
 * 否则加一个标签得先跑去设置页，用完再回来，
 * 而加标签往往是排期时临时想到的。
 */
function TagPicker({ meta, picked, onPick, onClose, onCreateTag }: {
  meta: BoardMeta;
  picked: string[];
  onPick: (id: string) => void;
  onClose: () => void;
  /** 新建标签。返回新标签 id 时顺手挂上 —— 省一次点击 */
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

/* ------------------------------------------------------------------ */
/* 筛选面板                                                            */
/* ------------------------------------------------------------------ */

/**
 * 某一列的筛选项。
 *
 * 抽成一份是因为**筛选面板**与**已生效筛选的摘要**都要用它 ——
 * 分开写的话，摘要那处（早期版本）拿的是 col.options，
 * 对动态列永远是空，于是 chip 上显示的是原始 id（"1"、"st_x"），
 * 而面板里显示的是"P1 最高"。同一个筛选，两个地方说法不一样。
 */
function optionsOf(
  col: TableColumn,
  meta: BoardMeta,
  assigneeOptions: { v: string; label: string }[],
  sessionOptions: { v: string; label: string }[] = [],
): { v: string; label: string }[] {
  if (col.dynamic === 'status') return meta.statuses.map((s) => ({ v: s.id, label: s.name }));
  if (col.dynamic === 'tags') return meta.tags.map((t) => ({ v: t.id, label: t.name }));
  if (col.dynamic === 'assignee') return assigneeOptions;
  if (col.dynamic === 'session') return sessionOptions;
  return col.options || [];
}

/** 动态列没有选项时的说明。空面板会被当成"这一列的筛选坏了" */
function emptyOptionsHint(col: TableColumn): string {
  if (col.dynamic === 'tags') return '还没有标签 —— 在标签列点「+」新建一个';
  if (col.dynamic === 'assignee') return '当前这批任务里还没有人认领';
  if (col.dynamic === 'session') return '当前这批里没有带窗口号的记录';
  if (col.dynamic === 'status') return '还没有配置状态';
  return '没有可选项';
}

/** 已生效筛选的一句摘要。chip 上写它，让人不用打开面板也知道当前筛了什么 */
function filterSummary(
  col: TableColumn,
  f: ColumnFilter,
  meta: BoardMeta,
  assigneeOptions: { v: string; label: string }[],
  sessionOptions: { v: string; label: string }[] = [],
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
  col: TableColumn;
  filter: ColumnFilter;
  onChange: (f: ColumnFilter) => void;
  onClear: () => void;
  /** 动态选项（自定义状态 / 标签）从这里取 */
  meta: BoardMeta;
  /** 「认领」列的选项：从当前数据去重得到，没有人员表可查 */
  assigneeOptions: { v: string; label: string }[];
  /** 「窗口」列的选项：同样从数据去重 */
  sessionOptions?: { v: string; label: string }[];
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
    /*
      选项来源：动态列（状态 / 标签）从 meta 现算，其余用列上写死的。
      ⛔ 不能用 col.options 兜底动态列 —— 那是空数组，
      会静默渲染出一个"没有任何选项"的面板，看着像功能坏了。
    */
    const options = optionsOf(col, meta, assigneeOptions, sessionOptions || []);
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
  live, archived, board, meta, attachCounts, now, selectedKey, onSelect,
  onToggleTag, onCreateTag, sessionId,
}: {
  /** 当前会话的运行记录（不落盘） */
  live: TaskRecord[];
  /** 已归档记录（跨会话） */
  archived: TaskRecord[];
  /**
   * 任务板。传了才会把**计划条目**并进表里 ——
   * 说明 / 标签 / 附件这些列的值在条目上，没有它这些列全是"—"。
   */
  board?: TaskBoard | null;
  /** 项目元数据：自定义状态与标签定义 */
  meta: BoardMeta;
  /** 每个条目挂了几个附件。按 ownerId 索引 */
  attachCounts: Record<string, number>;
  now: number;
  /** `live:xxx` / `archived:xxx` / `board:xxx` */
  selectedKey: string | null;
  onSelect: (row: TableRow) => void;
  /** 挂 / 摘标签 */
  onToggleTag: (taskId: string, tagId: string) => void;
  /** 新建标签并返回 id */
  onCreateTag: (name: string, color: string) => string | null;
  /** 本窗口的 sessionID。用于把"我的"标出来 */
  sessionId: string;
}) {
  const [query, setQuery] = useState<TableQuery>(() => emptyQuery());
  const [openCol, setOpenCol] = useState<TableColumnId | ''>('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const cellRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => buildTableRows(live, archived, board), [live, archived, board]);

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
    () => applyTable(rows, query, nowRef.current, attachCounts),
    [rows, query, attachCounts],
  );

  /*
    「认领」的选项从**当前这批行**里去重得到。

    ⛔ 用过滤后的结果而不是全量：选项里若出现已经被筛掉的人，
    勾选他只会得到零行 —— 那是"明明选了却什么都没有"。
  */
  const assigneeOptions = useMemo(() => assigneeOptionsOf(shown), [shown]);
  const sessionOptions = useMemo(() => sessionOptionsOf(shown), [shown]);

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
                    <Cell
                      row={row}
                      col={col}
                      now={now}
                      meta={meta}
                      counts={attachCounts}
                      onToggleTag={onToggleTag}
                      onCreateTag={onCreateTag}
                      sessionId={sessionId}
                    />
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
