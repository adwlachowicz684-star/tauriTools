import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import {
  type HistoryEntry, type RangeKey, type TimeBucket,
  filterHistory, groupByTime, historyStats, formatSize,
  removeFromHistory, clearCanvasHistory, RANGE_LABEL,
} from '../engine/history';
import { progressOf, elapsedOf, formatDuration, STATUS_LABEL, SOURCE_LABEL } from '../engine/tasks';
import { windowSlice, rowOffsets } from '../engine/tasks';

/**
 * 历史列表 —— 占**左栏**，与节点库共用底板（同 TaskList，见那边的说明）。
 *
 * 与任务窗口的区别：那边是当前会话的实时态，这边是落盘的归档。
 * 归档内容经过裁剪（见 engine/history.ts 的 compactTask），
 * 所以详情顶部会提示"内容被裁剪过"，避免被当成输出丢了。
 */

const BUCKET_H = 28;
const ENTRY_H = 68;

type HistRow =
  | { kind: 'bucket'; key: string; bucket: TimeBucket; count: number }
  | { kind: 'entry'; key: string; entry: HistoryEntry };

function heightOf(r: HistRow): number {
  return r.kind === 'bucket' ? BUCKET_H : ENTRY_H;
}

type StatusKey = '' | 'success' | 'failed' | 'cancelled';

const STATUS_OPTIONS: { v: StatusKey; label: string }[] = [
  { v: '', label: '全部状态' },
  { v: 'success', label: '成功' },
  { v: 'failed', label: '失败' },
  { v: 'cancelled', label: '已取消' },
];

export function HistoryList({
  entries, now, onDelete, onClearAll, clearAllLabel, onClearCanvas, selectedId, onSelect,
}: {
  entries: HistoryEntry[];
  now: number;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  /**
   * 「清空全部」的文案，由外层按当前项目范围给。
   * 切到某个项目下时它清的是本项目，写死「清空全部」就在骗人
   * （理由同 TaskList 的 clearLabel）。
   */
  clearAllLabel?: string;
  onClearCanvas: (canvasId: string) => void;
  /** 选中项由外层持有 —— 列表在左栏、详情在中间，两边必须同步 */
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [range, setRange] = useState<RangeKey>('all');
  const [status, setStatus] = useState<StatusKey>('');
  const [kw, setKw] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(
    () => filterHistory(entries, { range, status, keyword: kw }, now),
    [entries, range, status, kw, now],
  );

  const rows = useMemo<HistRow[]>(() => {
    const groups = groupByTime(filtered, now);
    const out: HistRow[] = [];
    for (const g of groups) {
      out.push({ kind: 'bucket', key: `b:${g.bucket}`, bucket: g.bucket, count: g.entries.length });
      for (const e of g.entries) {
        out.push({ kind: 'entry', key: `e:${e.id}`, entry: e });
      }
    }
    return out;
  }, [filtered, now]);

  const offsets = useMemo(() => rowOffsets(rows as never), [rows]);
  const win = useMemo(
    () => windowSlice(rows as never, offsets, scrollTop, viewportH, 3, heightOf as never),
    [rows, offsets, scrollTop, viewportH],
  );

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight || 600);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback((e: { currentTarget: { scrollTop: number } }) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const stats = useMemo(() => historyStats(entries), [entries]);
  const activeId = selectedId ?? filtered[0]?.id ?? null;

  return (
    <aside className="side-pane">
      <div className="side-head">
        <span>历史</span>
        <span className="side-head-spacer" />
        <button
          type="button"
          className="side-head-btn"
          onClick={onClearAll}
          disabled={entries.length === 0}
          title={entries.length === 0 ? undefined : `只清掉当前项目下的 ${entries.length} 条归档`}
        >
          {clearAllLabel || '清空全部'}
        </button>
      </div>

      <div className="hist-filter">
          <div className="hist-filter-row">
            <select className="p-input hist-sel" value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
              {(Object.keys(RANGE_LABEL) as RangeKey[]).map((k) => (
                <option key={k} value={k}>{RANGE_LABEL[k]}</option>
              ))}
            </select>
            <select className="p-input hist-sel" value={status} onChange={(e) => setStatus(e.target.value as StatusKey)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>{o.label}</option>
              ))}
            </select>
          </div>
          <input
            className="p-input hist-search"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="搜索流程名或日志内容"
          />
          <div className="hist-stats">
            <span>共 {stats.total} 条</span>
            <span className="task-run">成功 {stats.success}</span>
            {stats.failed ? <span className="task-bad">失败 {stats.failed}</span> : null}
            {stats.cancelled ? <span className="task-mute">取消 {stats.cancelled}</span> : null}
            <span className="task-grow" />
            <span title="归档占用的字符预算">占用 {stats.usage}%</span>
          </div>
          <div className="hist-stats">
            <span className="task-mute">{formatSize(stats.chars)}</span>
            <span className="task-grow" />
            <button className="mini danger" onClick={onClearAll} disabled={entries.length === 0}>
              {clearAllLabel || '清空全部'}
            </button>
          </div>
          {entries.length > 0 ? (
            /*
             * 归档的是**原始运行结果**（节点输出与日志），不做脱敏 ——
             * 那正是历史的价值：回看上次到底跑出了什么。
             *
             * 而"不脱敏"必须有代价可见：输出里如果被 echo 出令牌（脚本里
             * echo $TOKEN、接口把凭据回显了），它会明文躺在这里，且跨会话保留。
             * 不写这句的话，用户会以为这里和节点配置一样是挖过密钥的。
             *
             * 不反过来去挖输出里的"疑似令牌"：输出是任意文本，判据必然误伤
             * （一段讲 apiKey 用法的文档就会被挖空），而误伤是"能看但缺了一块"，
             * 比明文躺着更难发现。所以选择明说，并保留清空入口。
             */
            <div className="hist-stats">
              <span className="task-mute" title="节点输出与日志按原样归档。若运行结果里回显过令牌，它也会在这里 —— 用上面的清空按钮可以彻底清掉">
                归档的是原始输出，不做脱敏
              </span>
            </div>
          ) : null}
        </div>

        {rows.length === 0 ? (
          <div className="nx-empty task-empty">
            {entries.length === 0
              ? '还没有历史记录。运行过的任务会自动归档到这里，下次打开还在。'
              : '没有符合筛选条件的记录。换个时间范围或清空搜索词试试。'}
          </div>
        ) : (
          <div className="side-body side-body-flush task-scroll" ref={listRef} onScroll={onScroll}>
            <div style={{ height: win.totalHeight, position: 'relative' }}>
              <div style={{ transform: `translateY(${win.padTop}px)` }}>
                {rows.slice(win.start, win.end).map((row) =>
                  row.kind === 'bucket' ? (
                    <div key={row.key} className="hist-bucket" style={{ height: BUCKET_H }}>
                      <span>{row.bucket}</span>
                      <span className="task-mute">{row.count} 条</span>
                    </div>
                  ) : (
                    <div
                      key={row.key}
                      className={`hist-row ${activeId === row.entry.id ? 'is-active' : ''}`}
                      style={{ height: ENTRY_H }}
                      onClick={() => onSelect(row.entry.id)}
                    >
                      <div className="task-item-top">
                        <span className="task-name">{row.entry.canvasName}</span>
                        <span className={`task-pill st-${row.entry.status}`}>
                          {STATUS_LABEL[row.entry.status as keyof typeof STATUS_LABEL] || row.entry.status}
                        </span>
                      </div>
                      <div className="task-item-meta">
                        <span className="task-src">{SOURCE_LABEL[row.entry.source] || row.entry.source}</span>
                        <span>{formatDuration(elapsedOf(row.entry, now))}</span>
                        <span>{progressOf(row.entry).percent}%</span>
                        <span className="task-grow" />
                        <button
                          className="mini"
                          onClick={(ev) => { ev.stopPropagation(); onDelete(row.entry.id); }}
                          title="删除这条记录"
                        >
                          删除
                        </button>
                        <button
                          className="mini"
                          onClick={(ev) => { ev.stopPropagation(); onClearCanvas(row.entry.canvasId); }}
                          title="清空该流程的全部历史"
                        >
                          清空流程
                        </button>
                      </div>
                    </div>
                  ),
                )}
              </div>
            </div>
          </div>
        )}
    </aside>
  );
}
