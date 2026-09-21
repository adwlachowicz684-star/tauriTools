import type { TaskEdge, TaskNodeState, TaskRecord } from './tasks';
import { topoLayers } from './topo';

/**
 * 任务流程图 —— 把一次运行画成图，而不是一列。
 *
 * ================= 为什么默认看图而不是看列表 ====================
 *
 * 节点的详细日志是一行行的，能回答"这一步输出了什么"；
 * 但"卡在哪儿了"必须看图才答得出来 ——
 * 一列平铺的文本看不出谁在等谁，也就分不出"等待"和"阻断"。
 *
 * ================= 四种状态 ====================
 *
 *   完成（绿）  跑完了
 *   进行（黄）  正在跑
 *   等待（蓝）  上游还没到它
 *   阻断（红）  上游失败 / 被跳过 / 已取消 —— 这一步根本没机会跑
 *
 * ================= 布局 ====================
 *
 * 横向分层（左 → 右）而不是照搬画布坐标：
 * 任务记录里没有坐标，而画布坐标在节点增删后早已对不上；
 * 分层图稳定，且"同一层 = 可以并行"这件事一眼可见。
 */

export type FlowStatus = 'done' | 'running' | 'waiting' | 'blocked';

export const FLOW_STATUS_META: Record<FlowStatus, { label: string; color: string }> = {
  done: { label: '完成', color: '#22c55e' },
  running: { label: '进行', color: '#f59e0b' },
  waiting: { label: '等待', color: '#3b82f6' },
  blocked: { label: '阻断', color: '#ef4444' },
};

/**
 * 一个节点在图上的状态。
 *
 * 只看自己是不够的：上游失败而自己还没被调度时，
 * 自己的 status 仍是 idle，看上去"什么都没发生"，
 * 实际是**被上游掐断了** —— 这正是最该一眼看出来的。
 */
export function flowStatusOf(
  task: TaskRecord,
  id: string,
): FlowStatus {
  const n: TaskNodeState | undefined = task.nodes[id];

  if (!n) {
    // 从没出现过：要么还没轮到（等待），要么上游断了（阻断）
    return upstreamBroken(task, id) ? 'blocked' : 'waiting';
  }

  switch (n.status) {
    case 'success':
      return 'done';
    case 'running':
      return 'running';
    case 'failed':
      return 'blocked';
    case 'skipped':
      // 被跳过的要分两种：上游断了才是阻断，用户主动关掉的不算失败
      return upstreamBroken(task, id) ? 'blocked' : 'done';
    default:
      // idle / pending：还没轮到
      if (task.status === 'cancelled' || task.status === 'failed') {
        return upstreamBroken(task, id) ? 'blocked' : 'waiting';
      }
      return 'waiting';
  }
}

function upstreamBroken(task: TaskRecord, id: string): boolean {
  for (const e of task.edges ?? []) {
    if (e.target !== id) continue;
    const up = task.nodes[e.source];
    if (!up) continue;
    if (up.status === 'failed') return true;
    if (up.status === 'skipped' && upstreamBroken(task, e.source)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 布局                                                                */
/* ------------------------------------------------------------------ */

export type FlowNodeBox = {
  id: string;
  label: string;
  status: FlowStatus;
  /** 列（层），从 0 开始 */
  col: number;
  /** 行，从 0 开始 */
  row: number;
};

export type FlowLayout = {
  boxes: FlowNodeBox[];
  /** 连线（两端都在 boxes 里） */
  links: TaskEdge[];
  cols: number;
  rows: number;
};

/**
 * 分层布局。
 *
 * 孤立节点（没有任何连线）也要画出来 ——
 * 不画的话"这个流程里还有一步"就看不到了，而它恰恰可能是没配好的那一步。
 */
export function layoutTaskFlow(task: TaskRecord): FlowLayout {
  const ids: string[] = task.order.length > 0 ? [...task.order] : Object.keys(task.nodes ?? {});
  const edges: TaskEdge[] = (task.edges ?? []).filter(
    (e) => ids.includes(e.source) && ids.includes(e.target),
  );

  const { layers } = topoLayers({
    nodes: ids.map((id) => ({ id, data: {} as never })),
    edges: edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
  });

  const boxes: FlowNodeBox[] = [];
  layers.forEach((layer, col) => {
    layer.forEach((id, row) => {
      boxes.push({
        id,
        label: task.labels?.[id] ?? id,
        status: flowStatusOf(task, id),
        col,
        row,
      });
    });
  });

  const seen = new Set(boxes.map((b) => b.id));
  // 成环时 topoLayers 会丢节点 —— 补进来，放在最后一列
  for (const id of ids) {
    if (seen.has(id)) continue;
    boxes.push({
      id,
      label: task.labels?.[id] ?? id,
      status: flowStatusOf(task, id),
      col: layers.length,
      row: boxes.filter((b) => b.col === layers.length).length,
    });
  }

  const cols = boxes.reduce((m, b) => Math.max(m, b.col), 0) + 1;
  const rows = boxes.reduce((m, b) => Math.max(m, b.row), 0) + 1;
  return { boxes, links: edges, cols, rows };
}

/** 各状态各有多少 —— 顶上那一行汇总用 */
export function flowSummary(boxes: FlowNodeBox[]): Record<FlowStatus, number> {
  const out: Record<FlowStatus, number> = { done: 0, running: 0, waiting: 0, blocked: 0 };
  for (const b of boxes) out[b.status] += 1;
  return out;
}
