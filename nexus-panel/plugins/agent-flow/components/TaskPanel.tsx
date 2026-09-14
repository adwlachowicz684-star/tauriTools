import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import {
  type TaskRecord, type TaskNodeState, type TaskGroup,
  progressOf, elapsedOf, formatDuration, formatClock,
  STATUS_LABEL, NODE_STATUS_LABEL, SOURCE_LABEL,
  groupByCanvas, flattenRows, rowOffsets, windowSlice, defaultExpanded,
  GROUP_ROW_HEIGHT, TASK_ROW_HEIGHT,
} from '../engine/tasks';

/**
 * 任务窗口 —— 看"正在跑什么"，而不是"流程长什么样"。
 *
 * 与流程窗口的区别：流程是设计态（我打算怎么跑），任务是运行态（此刻跑到哪了）。
 *
 * 数百个任务并发时，平铺列表既看不清也撑不住 —— 所以：
 *   1. 按流程分组，可展开收起
 *   2. 虚拟滚动，只渲染视口内的行
 *   3. 不限制记录条数（上限只受内存约束，不人为截断）
 */

function StatusPill({ status }: { status: string }) {
  return <span className={`task-pill st-${status}`}>{STATUS_LABEL[status as keyof typeof STATUS_LABEL] || status}</span>;
}

function NodeRow({ n, now }: { n: TaskNodeState; now: number }) {
  const [open, setOpen] = useState(false);
  const dur = n.startedAt ? elapsedOf({ startedAt: n.startedAt, endedAt: n.endedAt } as TaskRecord, now) : 0;
  const hasBody = Boolean(n.output || n.error || n.rendered);
  return (
    <div className={`task-node st-${n.status}`}>
      <div
        className="task-node-head"
        onClick={() => { if (hasBody) setOpen(!open); }}
        style={hasBody ? undefined : { cursor: 'default' }}
      >
        <span className={`dot ${n.status === 'success' ? 'ok' : n.status === 'failed' ? 'bad' : n.status === 'running' ? 'run' : ''}`} />
        <span className="task-node-id">{n.id}</span>
        <span className="task-node-status">{NODE_STATUS_LABEL[n.status] || n.status}</span>
        {n.branch ? <span className="task-tag">分支 {n.branch}</span> : null}
        {n.concurrency !== undefined ? <span className="task-tag">并发 {n.concurrency}</span> : null}
        {n.loopTotal !== undefined ? (
          <span className="task-tag">循环 {n.loopDone ?? 0}/{n.loopTotal}</span>
        ) : null}
        <span className="task-node-dur">{n.startedAt ? formatDuration(dur) : '—'}</span>
        {hasBody ? <span className="task-caret">{open ? '▾' : '▸'}</span> : null}
      </div>
      {open ? (
        <div className="task-node-body">
          {n.rendered ? (
            <div className="task-field">
              <div className="task-field-k">提示词</div>
              <pre className="task-pre">{n.rendered}</pre>
            </div>
          ) : null}
          {n.output ? (
            <div className="task-field">
              <div className="task-field-k">输出</div>
              <pre className="task-pre">{n.output}</pre>
            </div>
          ) : null}
          {n.error ? (
            <div className="task-field">
              <div className="task-field-k">错误</div>
              <pre className="task-pre err">{n.error}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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

export function TaskPanel({
  tasks, now, onCancel, onClear, onJumpToCanvas,
}: {
  tasks: TaskRecord[];
  /** 当前时间。由外层定时传入，让耗时实时走秒 */
  now: number;
  onCancel: (id: string) => void;
  onClear: () => void;
  onJumpToCanvas?: (canvasId: string) => void;
}) {
  const [sel, setSel] = useState<string | null>(null);
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
  const active = tasks.find((t) => t.id === sel) || tasks[0] || null;

  return (
    <div className="task-view">
      <div className="task-list">
        <div className="task-list-head">
          <strong>任务</strong>
          <span className="task-count">
            {runningCount > 0 ? `${runningCount} 个运行中` : `${tasks.length} 条`}
          </span>
          <button className="mini" onClick={onClear} disabled={tasks.length === 0}>清空</button>
        </div>

        {tasks.length === 0 ? (
          <div className="task-empty">
            还没有运行记录。回到流程窗口点「运行」，这里的进度会实时更新。
          </div>
        ) : (
          <div className="task-scroll" ref={listRef} onScroll={onScroll}>
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
                      className={`task-row ${active && active.id === row.task.id ? 'is-active' : ''}`}
                      onClick={() => setSel(row.task.id)}
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
      </div>

      <div className="task-detail">
        {!active ? (
          <div className="task-empty">选一条任务看细节。</div>
        ) : (
          <>
            <div className="task-detail-head">
              <strong>{active.canvasName}</strong>
              <StatusPill status={active.status} />
              <span className="task-mute">
                {formatClock(active.startedAt)}
                {active.endedAt ? ` → ${formatClock(active.endedAt)}` : ''}
                {' · '}
                {formatDuration(elapsedOf(active, now))}
              </span>
              <span className="task-grow" />
              {active.status === 'running' ? (
                <button className="p-btn danger" onClick={() => onCancel(active.id)}>停止</button>
              ) : null}
              {onJumpToCanvas ? (
                <button className="p-btn" onClick={() => onJumpToCanvas(active.canvasId)}>
                  打开所在流程
                </button>
              ) : null}
            </div>

            {active.layerTotal > 0 ? (
              <div className="task-layer">第 {active.layerNow}/{active.layerTotal} 层</div>
            ) : null}

            <div className="task-nodes">
              {active.order.length === 0 ? (
                <div className="task-mute">还没有节点开始执行。</div>
              ) : (
                active.order.map((id) => (
                  <NodeRow key={id} n={active.nodes[id]} now={now} />
                ))
              )}
            </div>

            <div className="task-logs">
              <div className="task-logs-title">日志</div>
              {active.logs.length === 0 ? (
                <div className="task-mute">暂无日志。</div>
              ) : (
                active.logs.map((l, i) => (
                  <div key={i} className="task-log">
                    <span className="task-log-at">{formatClock(l.at)}</span>
                    {l.nodeId ? <span className="task-log-id">{l.nodeId}</span> : null}
                    <span className="task-log-text">{l.text}</span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
