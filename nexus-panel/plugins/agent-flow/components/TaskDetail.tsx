import { useState, useRef } from 'react';
import {
  type TaskRecord, type TaskNodeState,
  elapsedOf, formatDuration, formatClock,
  STATUS_LABEL, NODE_STATUS_LABEL,
} from '../engine/tasks';
import { formatDateTime } from '../engine/history';
import {
  layoutTaskFlow, flowSummary, errorNodesOf, layersOf,
  linkEndsOf, linkPathOf, BOX_W, BOX_H,
  FLOW_STATUS_META, type FlowStatus,
} from '../engine/taskFlow';

/**
 * 任务详情（右栏）—— 任务窗口与历史面板共用。
 *
 * 抽出来是为了避免两处各写一套：一旦分开维护，
 * "历史里看到的字段和运行时看到的对不上"只是时间问题。
 */

function NodeRow({ n, now, label }: { n: TaskNodeState; now: number; label?: string }) {
  const [open, setOpen] = useState(false);
  const dur = n.startedAt ? elapsedOf({ startedAt: n.startedAt, endedAt: n.endedAt } as TaskRecord, now) : 0;
  /*
   * 判据也要算进"有没有可展开的内容"。
   *
   * 只输出 true / false 的节点（比较、条件）输出本身就那么一两个字，
   * 判据才是要看的东西 —— 不算进来的话这一行根本展不开。
   */
  const hasBody = Boolean(n.output || n.error || n.rendered || n.detail);
  return (
    <div className={`task-node st-${n.status}`}>
      <div
        className="task-node-head"
        onClick={() => { if (hasBody) setOpen(!open); }}
        style={hasBody ? undefined : { cursor: 'default' }}
      >
        <span className={`dot ${n.status === 'success' ? 'ok' : n.status === 'failed' ? 'bad' : n.status === 'running' ? 'run' : ''}`} />
        <span className="task-node-id">{label ?? n.id}</span>
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
          {/*
            判据排在输出**前面**：比较 / 条件这类节点的输出只有 true/false，
            先看到它反而不知道在看什么。先说"拿什么比出来的"，再说结论。
          */}
          {n.detail ? (
            <div className="task-field">
              <div className="task-field-k">判据</div>
              <pre className="task-pre detail">{n.detail}</pre>
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
 * 有坐标快照时按**画布当时的样子**摆 —— 认得出"这是我那张图"。
 * 没有（老记录、模块展开出来的节点缺坐标）就退回分层网格，
 * 而不是把缺坐标的那几个画到 (0,0) 叠成一团。
 */
/**
 * 流程图上的变量标注。
 *
 * 节点框上只显示**名字**（框太窄，摊开内容会把图挤散），
 * 点开浮层再显示「名字 = 值」。
 *
 * 与画布卡片上的三档（简不显示 / 标名字 / 详内容）同源：
 * 这里没有"简"档 —— 流程图上没有任何变量标注的节点本来就是空白，
 * 不需要额外一档来表达"不显示"。
 */
function FlowVars({ vars, full = false }: {
  vars: { name: string; summary: string }[];
  /** true = 摊开成「名字 = 值」；false = 只显示名字（节点框上） */
  full?: boolean;
}) {
  if (vars.length === 0) return null;
  return (
    <span className="task-flow-vars">
      {vars.map((v, i) => (
        <span key={`${v.name}-${i}`} className="task-flow-var" title={v.summary ? `${v.name} = ${v.summary}` : v.name}>
          <span className="task-flow-var-name">{v.name}</span>
          {full && v.summary ? <span className="task-flow-var-sum">{v.summary}</span> : null}
        </span>
      ))}
    </span>
  );
}

export function TaskFlow({ task, now }: { task: TaskRecord; now: number }) {
  const { boxes, links, cols, mode, bounds } = layoutTaskFlow(task);
  const sum = flowSummary(boxes);
  /*
   * 浮层：悬停预览、点击钉住。
   *
   * 两个态必须分开 —— 合成一个开关的话，
   * 要么悬停后浮层赖着不走，要么点开的浮层鼠标一移就没了。
   */
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const shown = pinned ?? hover;

  if (boxes.length === 0) {
    return <div className="task-mute">这次运行没有节点记录。</div>;
  }

  const byId = new Map(boxes.map((b) => [b.id, b]));
  const stateOf = (id: string) => task.nodes[id];
  const legend = (
    <div className="task-flow-legend">
      {(Object.keys(FLOW_STATUS_META) as FlowStatus[]).map((k) => (
        <span key={k} className="task-flow-legend-item">
          <span className="task-flow-dot" style={{ background: FLOW_STATUS_META[k].color }} />
          {FLOW_STATUS_META[k].label} {sum[k]}
        </span>
      ))}
    </div>
  );

  if (mode === 'layered') {
    return (
      <div className="task-flow">
        {legend}
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
              <FlowVars vars={b.vars} />
            </div>
          ))}
        </div>
        {links.length > 0 ? (
          <div className="task-flow-links">
            {links.map((e, i) => (
              <span key={i} className="task-flow-link">
                {task.labels?.[e.source] ?? e.source} → {task.labels?.[e.target] ?? e.target}
              </span>
            ))}
          </div>
        ) : null}
        <div className="task-mute">
          这次运行没有记录坐标，按执行层排列。
        </div>
      </div>
    );
  }

  const pad = 24;
  const vb = bounds!;
  const svgW = vb.w + pad * 2;
  const svgH = vb.h + pad * 2;
  const off = (v: number, min: number) => v - min + pad;

  return (
    <div className="task-flow">
      {legend}
      <div className="task-flow-canvas" style={{ height: Math.min(svgH + 8, 460) }}>
        <svg
          className="task-flow-svg"
          viewBox={`0 0 ${svgW} ${svgH}`}
          width={svgW}
          height={svgH}
        >
          {links.map((e, i) => {
            const a = byId.get(e.source);
            const b = byId.get(e.target);
            if (!a || !b) return null;
            const ends = linkEndsOf(
              { x: off(a.x!, vb.x), y: off(a.y!, vb.y) },
              { x: off(b.x!, vb.x), y: off(b.y!, vb.y) },
            );
            return (
              <path
                key={i}
                d={linkPathOf(ends)}
                className={`task-flow-edge st-${b.status}`}
                fill="none"
                markerEnd="url(#tf-arrow)"
              />
            );
          })}
          <defs>
            <marker id="tf-arrow" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
        </svg>

        {boxes.map((b) => {
          const st = stateOf(b.id);
          const meta = FLOW_STATUS_META[b.status];
          return (
            <div
              key={b.id}
              className={`task-flow-node abs st-${b.status}${shown === b.id ? ' is-active' : ''}`}
              style={{
                left: off(b.x!, vb.x),
                top: off(b.y!, vb.y),
                width: BOX_W,
                minHeight: BOX_H,
                borderLeftColor: meta.color,
              }}
              onMouseEnter={() => setHover(b.id)}
              onMouseLeave={() => setHover((h) => (h === b.id ? null : h))}
              onClick={() => setPinned((p) => (p === b.id ? null : b.id))}
            >
              <span className="task-flow-node-name">{b.label}</span>
              <span className="task-flow-node-st" style={{ color: meta.color }}>
                {meta.label}
                {st?.startedAt ? ` · ${formatDuration(elapsedOf({ startedAt: st.startedAt, endedAt: st.endedAt } as TaskRecord, now))}` : ''}
              </span>
              <FlowVars vars={b.vars} />
              {shown === b.id ? (
                <div className="task-flow-pop" onClick={(e) => e.stopPropagation()}>
                  <div className="task-flow-pop-head">
                    <strong>{b.label}</strong>
                    <span style={{ color: meta.color }}>{meta.label}</span>
                    <span className="task-grow" />
                    <button className="side-head-btn" onClick={() => setPinned(null)}>关闭</button>
                  </div>
                  <FlowVars vars={b.vars} full />
                  {st?.error ? <pre className="task-pre err">{st.error}</pre> : null}
                  {/* 图上点开也要看到判据：只显示 true/false 的节点，光看输出等于没看 */}
                  {st?.detail ? <pre className="task-pre detail">{st.detail}</pre> : null}
                  {st?.output ? <pre className="task-pre">{st.output.slice(0, 400)}</pre> : null}
                  {!st?.error && !st?.output ? (
                    <div className="task-mute">
                      {b.status === 'waiting' ? '上游还没到它，这一步没有输出。' : '这一步没有记录输出。'}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TaskDetail({
  task, now, onCancel, onJumpToCanvas, onLocateNode,
  /** 历史面板里显示完整日期，任务窗口里当天的事只需时钟 */
  showDate = false,
  /** 归档时内容被裁剪过，需要提示，否则会被当成"输出丢了" */
  archived = false,
}: {
  task: TaskRecord;
  now: number;
  onCancel?: (id: string) => void;
  onJumpToCanvas?: (canvasId: string) => void;
  /** 定位到画布上的某个节点（切画布 + 选中 + 滚过去） */
  onLocateNode?: (canvasId: string, nodeId: string) => void;
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

  /*
   * 「定位错误」的游标。
   *
   * ================= 为什么用 ref 而不是 findIndex ====================
   *
   * 用「当前节点在错误列表里的下标」每次重算的话，
   * 第 N 次点击永远定位到**同一个**（第一个）错误 ——
   * 按钮上的计数也永不变，点三次都在原地打转。
   *
   * ================= 为什么每次点击都重新收集 ====================
   *
   * 运行中节点状态一直在变：点第二次时第一个错误可能已经修好了。
   * 用旧列表推进游标会停在已经不存在的错误上。
   */
  const cursor = useRef<{ taskId: string; i: number }>({ taskId: task.id, i: -1 });

  const onLocate = () => {
    if (!onLocateNode) return;
    const ids = errorNodesOf(task);
    if (ids.length === 0) return;
    if (cursor.current.taskId !== task.id) cursor.current = { taskId: task.id, i: -1 };
    cursor.current.i = (cursor.current.i + 1) % ids.length;
    onLocateNode(task.canvasId, ids[cursor.current.i]);
  };

  // 无错误时置灰 —— 不要等到点了才告诉用户"没有"
  const errCount = errorNodesOf(task).length;

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
        {onLocateNode ? (
          <button
            className="p-btn"
            onClick={onLocate}
            disabled={errCount === 0}
            title={errCount === 0
              ? '这次运行没有失败或被阻断的节点'
              : `依次定位出问题的节点（共 ${errCount} 个）`}
          >
            定位错误{errCount > 0 ? ` ${cursor.current.taskId === task.id ? (cursor.current.i + 1) || 1 : 1}/${errCount}` : ''}
          </button>
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

      {tab === 'flow' ? <TaskFlow task={task} now={now} /> : null}

      {/*
        列表按**层**分组，不按执行先后平铺。
        平铺的话与流程图的列对不上 —— 图上看到的第二列，
        在列表里可能散落在第 3、7、11 行，切过去就找不着了。
      */}
      <div className="task-nodes" hidden={tab !== 'list'}>
        {task.order.length === 0 ? (
          <div className="task-mute">还没有节点开始执行。</div>
        ) : (
          layersOf(task).map(([layer, ids]) => (
            <div key={layer} className="task-layer-group">
              <div className="task-layer-head">
                第 {layer + 1} 层 · {ids.length} 个（同一层可以并行）
              </div>
              {ids.map((id) => (
                <NodeRow
                  key={id}
                  n={task.nodes[id] ?? { id, status: 'idle' as const, output: '', error: '' }}
                  now={now}
                  label={task.labels?.[id]}
                />
              ))}
            </div>
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
