import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import {
  type TaskRecord, type TaskGroup,
  progressOf, elapsedOf, formatDuration, formatClock,
  STATUS_LABEL, SOURCE_LABEL,
  groupByCanvas, flattenRows, rowOffsets, windowSlice, defaultExpanded,
  GROUP_ROW_HEIGHT, TASK_ROW_HEIGHT,
} from '../engine/tasks';


/**
 * 任务列表 —— 占**左栏**（节点库那条栏），与节点库 / 模块库 / 画布库共用底板。
 *
 * ================= 为什么在左栏 ====================
 *
 * 以前任务 / 历史是"整块替换画布区"的独立视图，
 * 而左栏还留在那儿显示节点库 —— 那是一条死栏：
 * 画布都藏起来了，节点拖不出去，点它没有任何反应。
 *
 * 所以切过去时左栏换成任务列表：位置、宽度、底板全都一样，
 * 视觉上就是同一条栏换了内容。
 *
 * ================= 与流程窗口的区别 ====================
 *
 * 流程是设计态（我打算怎么跑），任务是运行态（此刻跑到哪了）。
 *
 * 数百个任务并发时，平铺列表既看不清也撑不住 —— 所以：
 *   1. 按流程分组，可展开收起
 *   2. 虚拟滚动，只渲染视口内的行
 *   3. 不限制记录条数（上限只受内存约束，不人为截断）
 */

function StatusPill({ status }: { status: string }) {
  return <span className={`task-pill st-${status}`}>{STATUS_LABEL[status as keyof typeof STATUS_LABEL] || status}</span>;
}

function GroupHead({
  group, expanded, onToggle, now,
}: {
  group: TaskGroup;
  expanded: boolean;
  onToggle: () => void;
  now: number;
}) {
  const running = group.tasks.filter((t) => t.status === 'running');
  const totalMs = running.length > 0
    ? running.reduce((sum, t) => sum + elapsedOf(t, now), 0) / running.length
    : 0;
  return (
    <div className="task-group-head" onClick={onToggle}>
      <span className="task-caret">{expanded ? '▾' : '▸'}</span>
      <span className="task-group-name">{group.canvasName}</span>
      <span className="task-group-count">{group.total}</span>
      {group.runningCount > 0 ? (
        <span className="task-tag run">运行 {group.runningCount}</span>
      ) : null}
      {group.failedCount > 0 ? (
        <span className="task-tag bad">失败 {group.failedCount}</span>
      ) : null}
      {running.length > 0 ? (
        <span className="task-group-dur">平均 {formatDuration(totalMs)}</span>
      ) : null}
    </div>
  );
}

export function TaskList({
  tasks, now, onClear, selectedId, onSelect,
}: {
  tasks: TaskRecord[];
  /** 当前时间。由外层定时传入，让耗时实时走秒 */
  now: number;
  onClear: () => void;
  /**
   * 选中项由外层持有。
   *
   * 列表在左栏、详情在中间 —— 两个组件各自 useState 的话，
   * 点左栏不会让中间跟着变，看着就是"点了没反应"。
   */
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const listRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo(() => groupByCanvas(tasks), [tasks]);

  /* 默认展开只在"组集合变化"时重算。
     放进依赖 tasks 的话，每来一个事件就会把用户手动折叠的组重新展开。 */
  const groupKeys = useMemo(() => groups.map((g) => g.canvasId).join(','), [groups]);
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(groups));
  const lastKeys = useRef(groupKeys);
  useEffect(() => {
    if (lastKeys.current !== groupKeys) {
      lastKeys.current = groupKeys;
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const g of groups) {
          // 新出现的组按默认规则决定；已存在的保持用户选择
          if (!next.has(g.canvasId) && g.runningCount > 0) next.add(g.canvasId);
        }
        return next;
      });
    }
  }, [groupKeys, groups]);

  const { rows, offsets } = useMemo(() => {
    const r = flattenRows(groups, expanded);
    return { rows: r, offsets: rowOffsets(r) };
  }, [groups, expanded]);

  const win = useMemo(
    () => windowSlice(rows, offsets, scrollTop, viewportH),
    [rows, offsets, scrollTop, viewportH],
  );

  // 测量视口高度。不测的话 windowSlice 只能按默认值切，行数会不对
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

  const toggle = useCallback((canvasId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(canvasId)) next.delete(canvasId);
      else next.add(canvasId);
      return next;
    });
  }, []);

  const runningCount = tasks.filter((t) => t.status === 'running').length;
  const activeId = selectedId ?? tasks[0]?.id ?? null;

  return (
    <aside className="side-pane">
      <div className="side-head">
        <span>任务</span>
        <span className="side-head-spacer" />
        <span className="task-count">
          {runningCount > 0 ? `${runningCount} 个运行中` : `${tasks.length} 条`}
        </span>
        <button
          type="button"
          className="side-head-btn"
          onClick={onClear}
          disabled={tasks.length === 0}
        >
          清空
        </button>
      </div>

      {tasks.length === 0 ? (
          <div className="nx-empty task-empty">
            还没有运行记录。回到流程窗口点「运行」，这里的进度会实时更新。
          </div>
        ) : (
          <div className="side-body side-body-flush task-scroll" ref={listRef} onScroll={onScroll}>
            <div style={{ height: win.totalHeight, position: 'relative' }}>
              <div style={{ transform: `translateY(${win.padTop}px)` }}>
                {rows.slice(win.start, win.end).map((row) =>
                  row.kind === 'group' ? (
                    <div key={row.key} style={{ height: GROUP_ROW_HEIGHT }}>
                      <GroupHead
                        group={row.group}
                        expanded={expanded.has(row.group.canvasId)}
                        onToggle={() => toggle(row.group.canvasId)}
                        now={now}
                      />
                    </div>
                  ) : (
                    <div
                      key={row.key}
                      style={{ height: TASK_ROW_HEIGHT }}
                      className={`task-row ${activeId === row.task.id ? 'is-active' : ''}`}
                      onClick={() => onSelect(row.task.id)}
                    >
                      <div className="task-item-top">
                        <span className="task-name">{row.task.canvasName}</span>
                        <StatusPill status={row.task.status} />
                      </div>
                      <div className="task-item-meta">
                        <span className="task-src">{SOURCE_LABEL[row.task.source] || row.task.source}</span>
                        <span>{formatClock(row.task.startedAt)}</span>
                        <span>{formatDuration(elapsedOf(row.task, now))}</span>
                      </div>
                      {(() => {
                        const p = progressOf(row.task);
                        return (
                          <>
                            <div className="task-bar">
                              <div className={`task-bar-in ${row.task.status}`} style={{ width: `${p.percent}%` }} />
                            </div>
                            <div className="task-item-meta">
                              <span>{p.percent}%</span>
                              <span>成功 {p.done}</span>
                              {p.failed ? <span className="task-bad">失败 {p.failed}</span> : null}
                              {p.running ? <span className="task-run">运行 {p.running}</span> : null}
                              {p.skipped ? <span className="task-mute">跳过 {p.skipped}</span> : null}
                            </div>
                          </>
                        );
                      })()}
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
