import { useState } from 'react';
import {
  type TaskRecord, type TaskNodeState,
  progressOf, elapsedOf, formatDuration, formatClock,
  STATUS_LABEL, NODE_STATUS_LABEL, SOURCE_LABEL,
} from '../engine/tasks';

/**
 * 任务窗口 —— 看"正在跑什么"，而不是"流程长什么样"。
 *
 * 与流程窗口的区别：流程是设计态（我打算怎么跑），任务是运行态（此刻跑到哪了）。
 * 两者分开，运行时才不会把画布上的节点状态改得面目全非。
 */

function StatusPill({ status }: { status: string }) {
  return <span className={`task-pill st-${status}`}>{STATUS_LABEL[status as keyof typeof STATUS_LABEL] || status}</span>;
}

function NodeRow({ n, now }: { n: TaskNodeState; now: number }) {
  const [open, setOpen] = useState(false);
  const dur = n.startedAt ? elapsedOf({ startedAt: n.startedAt, endedAt: n.endedAt } as TaskRecord, now) : 0;
  const hasBody = n.output || n.error || n.rendered;
  return (
    <div className={`task-node st-${n.status}`}>
      <div className="task-node-head" onClick={() => hasBody && setOpen(!open)}>
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
  const runningCount = tasks.filter((t) => t.status === 'running').length;
  const active = tasks.find((t) => t.id === sel) || tasks[0] || null;

  return (
    <div className="task-view">
      <div className="task-list">
        <div className="task-list-head">
          <strong>任务</strong>
          <span className="task-count">
            {runningCount > 0 ? `${runningCount} 个运行中` : `${tasks.length} 条记录`}
          </span>
          <button className="mini" onClick={onClear} disabled={tasks.length === 0}>清空</button>
        </div>

        {tasks.length === 0 ? (
          <div className="task-empty">
            还没有运行记录。回到流程窗口点「运行」，这里的进度会实时更新。
          </div>
        ) : (
          tasks.map((t) => {
            const p = progressOf(t);
            return (
              <div
                key={t.id}
                className={`task-item ${active && active.id === t.id ? 'is-active' : ''}`}
                onClick={() => setSel(t.id)}
              >
                <div className="task-item-top">
                  <span className="task-name">{t.canvasName}</span>
                  <StatusPill status={t.status} />
                </div>
                <div className="task-item-meta">
                  <span className="task-src">{SOURCE_LABEL[t.source] || t.source}</span>
                  <span>{formatClock(t.startedAt)}</span>
                  <span>{formatDuration(elapsedOf(t, now))}</span>
                </div>
                <div className="task-bar">
                  <div
                    className={`task-bar-in ${t.status}`}
                    style={{ width: `${p.percent}%` }}
                  />
                </div>
                <div className="task-item-meta">
                  <span>{p.percent}%</span>
                  <span>成功 {p.done}</span>
                  {p.failed ? <span className="task-bad">失败 {p.failed}</span> : null}
                  {p.running ? <span className="task-run">运行 {p.running}</span> : null}
                  {p.skipped ? <span className="task-mute">跳过 {p.skipped}</span> : null}
                </div>
              </div>
            );
          })
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
              <div className="task-layer">
                第 {active.layerNow}/{active.layerTotal} 层
              </div>
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
