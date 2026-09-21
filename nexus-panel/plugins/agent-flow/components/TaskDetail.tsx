import { useState } from 'react';
import {
  type TaskRecord, type TaskNodeState,
  elapsedOf, formatDuration, formatClock,
  STATUS_LABEL, NODE_STATUS_LABEL,
} from '../engine/tasks';
import { formatDateTime } from '../engine/history';
import {
  layoutTaskFlow, flowSummary, FLOW_STATUS_META, type FlowStatus,
} from '../engine/taskFlow';

/**
 * 任务详情（右栏）—— 任务窗口与历史面板共用。
 *
 * 抽出来是为了避免两处各写一套：一旦分开维护，
 * "历史里看到的字段和运行时看到的对不上"只是时间问题。
 */

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

/**
 * 流程图 —— 任务窗口与历史的**默认视图**。
 *
 * ================= 为什么默认看图 ====================
 *
 * 详细列表能回答"这一步输出了什么"，
 * 但"卡在哪儿了"必须看图才答得出来：
 * 一列平铺的文本看不出谁在等谁，也就分不出「等待」和「阻断」。
 *
 * ================= 布局 ====================
 *
 * 横向分层（左 → 右）而不是照搬画布坐标：
 * 任务记录里没有坐标，而画布坐标在节点增删后早已对不上。
 * 分层图稳定，且"同一列 = 可以并行"一眼可见。
 */
export function TaskFlow({ task }: { task: TaskRecord }) {
  const { boxes, links, cols } = layoutTaskFlow(task);
  const sum = flowSummary(boxes);

  if (boxes.length === 0) {
    return <div className="task-mute">这次运行没有节点记录。</div>;
  }

  return (
    <div className="task-flow">
      <div className="task-flow-legend">
        {(Object.keys(FLOW_STATUS_META) as FlowStatus[]).map((k) => (
          <span key={k} className="task-flow-legend-item">
            <span className="task-flow-dot" style={{ background: FLOW_STATUS_META[k].color }} />
            {FLOW_STATUS_META[k].label} {sum[k]}
          </span>
        ))}
      </div>

      <div className="task-flow-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(96px, 1fr))` }}>
        {boxes.map((b) => (
          <div
            key={b.id}
            className={`task-flow-node st-${b.status}`}
            style={{ gridColumn: b.col + 1, borderLeftColor: FLOW_STATUS_META[b.status].color }}
            title={`${b.label} · ${FLOW_STATUS_META[b.status].label}`}
          >
            <span className="task-flow-node-name">{b.label}</span>
            <span className="task-flow-node-st" style={{ color: FLOW_STATUS_META[b.status].color }}>
              {FLOW_STATUS_META[b.status].label}
            </span>
          </div>
        ))}
      </div>

      {/*
        连线用文字标出来，不画 SVG。
        画 SVG 要算每个格子的实际像素位置（依赖测量），
        而分层图的**列**本身已经表达了顺序 ——
        把"谁 → 谁"列出来足够，还省掉一整套测量与重排。
      */}
      {links.length > 0 ? (
        <div className="task-flow-links">
          {links.map((e, i) => (
            <span key={i} className="task-flow-link">
              {task.labels?.[e.source] ?? e.source} → {task.labels?.[e.target] ?? e.target}
            </span>
          ))}
        </div>
      ) : null}
      {links.length === 0 && boxes.length > 1 ? (
        <div className="task-mute">这次运行没有记录连线，只能按执行顺序排。</div>
      ) : null}
    </div>
  );
}

export function TaskDetail({
  task, now, onCancel, onJumpToCanvas,
  /** 历史面板里显示完整日期，任务窗口里当天的事只需时钟 */
  showDate = false,
  /** 归档时内容被裁剪过，需要提示，否则会被当成"输出丢了" */
  archived = false,
}: {
  task: TaskRecord;
  now: number;
  onCancel?: (id: string) => void;
  onJumpToCanvas?: (canvasId: string) => void;
  showDate?: boolean;
  archived?: boolean;
}) {
  /*
   * 默认**流程图**，详细列表要切过去。
   *
   * 反过来（默认列表）的话，"卡在哪儿"永远要切一次才看得到 ——
   * 而那正是打开任务窗口最常见的目的。
   */
  const [tab, setTab] = useState<'flow' | 'list'>('flow');

  return (
    <>
      <div className="task-detail-head">
        <strong>{task.canvasName}</strong>
        <span className={`task-pill st-${task.status}`}>
          {STATUS_LABEL[task.status as keyof typeof STATUS_LABEL] || task.status}
        </span>
        <span className="task-mute">
          {showDate ? formatDateTime(task.startedAt) : formatClock(task.startedAt)}
          {task.endedAt
            ? ` → ${showDate ? formatDateTime(task.endedAt) : formatClock(task.endedAt)}`
            : ''}
          {' · '}
          {formatDuration(elapsedOf(task, now))}
        </span>
        <span className="task-grow" />
        {task.status === 'running' && onCancel ? (
          <button className="p-btn danger" onClick={() => onCancel(task.id)}>停止</button>
        ) : null}
        {onJumpToCanvas ? (
          <button className="p-btn" onClick={() => onJumpToCanvas(task.canvasId)}>
            打开所在流程
          </button>
        ) : null}
      </div>

      {archived ? (
        <div className="task-archived-tip">
          归档内容经过裁剪：长输出只保留末尾部分，日志只留最近若干条。
        </div>
      ) : null}

      {task.layerTotal > 0 ? (
        <div className="task-layer">第 {task.layerNow}/{task.layerTotal} 层</div>
      ) : null}

      <div className="task-view-switch">
        <button
          type="button"
          className={'side-head-btn' + (tab === 'flow' ? ' is-on' : '')}
          onClick={() => setTab('flow')}
        >
          流程图
        </button>
        <button
          type="button"
          className={'side-head-btn' + (tab === 'list' ? ' is-on' : '')}
          onClick={() => setTab('list')}
        >
          详细列表
        </button>
      </div>

      {tab === 'flow' ? <TaskFlow task={task} /> : null}

      <div className="task-nodes" hidden={tab !== 'list'}>
        {task.order.length === 0 ? (
          <div className="task-mute">还没有节点开始执行。</div>
        ) : (
          task.order.map((id) => (
            <NodeRow key={id} n={task.nodes[id]} now={now} />
          ))
        )}
      </div>

      <div className="task-logs" hidden={tab !== 'list'}>
        <div className="task-logs-title">日志</div>
        {task.logs.length === 0 ? (
          <div className="task-mute">暂无日志。</div>
        ) : (
          task.logs.map((l, i) => (
            <div key={i} className="task-log">
              <span className="task-log-at">{formatClock(l.at)}</span>
              {l.nodeId ? <span className="task-log-id">{l.nodeId}</span> : null}
              <span className="task-log-text">{l.text}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
