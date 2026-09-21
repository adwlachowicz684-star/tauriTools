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

function upstreamBroken(task: TaskRecord, id: string, seen: Set<string> = new Set()): boolean {
  /*
   * 成环时不能无限递归 —— 任务记录里的边来自运行时图，
   * 循环节点会把它自己的出口边也记进来。
   */
  if (seen.has(id)) return false;
  seen.add(id);

  for (const e of task.edges ?? []) {
    if (e.target !== id) continue;
    const up = task.nodes[e.source];
    /*
     * 上游自己也没出现过 —— 必须继续往上追。
     *
     * 在这里 `continue` 掉的话，链会在第一个"没跑到"的节点处断掉：
     * a 失败 → b 从未出现 → c 判成"等待"，
     * 而 c 其实早就被掐断了，根本不会跑。
     */
    if (!up) {
      if (upstreamBroken(task, e.source, seen)) return true;
      continue;
    }
    if (up.status === 'failed') return true;
    if (up.status === 'skipped' && upstreamBroken(task, e.source, seen)) return true;
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
  /** 列（层），从 0 开始。分层模式下用来摆格子 */
  col: number;
  /** 行，从 0 开始 */
  row: number;
  /** 画布坐标。缺省表示这条没有坐标，要退回分层 */
  x?: number;
  y?: number;
};

export type FlowLayout = {
  boxes: FlowNodeBox[];
  /** 连线（两端都在 boxes 里） */
  links: TaskEdge[];
  cols: number;
  rows: number;
  /**
   * canvas = 按画布坐标摆（有坐标时），layered = 分层网格。
   *
   * 有**任意一个**节点缺坐标就整张退回分层：
   * 一半按坐标、一半按格子会画成两块互不相干的图。
   */
  mode: 'canvas' | 'layered';
  /** canvas 模式下的画布包围盒，用来定 SVG 视口 */
  bounds?: { x: number; y: number; w: number; h: number };
};

/** 卡片默认尺寸。没有 measured 时用它算包围盒与连线端点 */
export const BOX_W = 200;
export const BOX_H = 72;

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

  /*
   * 有坐标就按画布摆。
   *
   * 少数节点缺坐标（比如模块展开出来的）时**整张退回分层** ——
   * 一半按坐标一半按格子会画成两块互不相干的图。
   */
  const pos = task.positions;
  const allPosed = pos
    && boxes.length > 0
    && boxes.every((b) => typeof pos[b.id]?.x === 'number' && typeof pos[b.id]?.y === 'number');

  if (!allPosed || !pos) {
    return { boxes, links: edges, cols, rows, mode: 'layered' as const };
  }

  for (const b of boxes) {
    b.x = pos[b.id].x;
    b.y = pos[b.id].y;
  }

  const xs = boxes.map((b) => b.x!);
  const ys = boxes.map((b) => b.y!);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const bounds = {
    x: minX,
    y: minY,
    w: Math.max(...xs) - minX + BOX_W,
    h: Math.max(...ys) - minY + BOX_H,
  };
  return { boxes, links: edges, cols, rows, mode: 'canvas' as const, bounds };
}

/**
 * 一条连线在 SVG 里的两端（都在卡片的**边缘中点**上）。
 *
 * 从中心连到中心会让线穿过卡片上的字 ——
 * 而这一步的名字恰恰是要看清的东西。
 */
export function linkEndsOf(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x1: number; y1: number; x2: number; y2: number } {
  const fc = { x: from.x + BOX_W / 2, y: from.y + BOX_H / 2 };
  const tc = { x: to.x + BOX_W / 2, y: to.y + BOX_H / 2 };
  // 主要朝右走：出口在右边、入口在左边
  const rightward = tc.x >= fc.x;
  return {
    x1: rightward ? from.x + BOX_W : from.x,
    y1: fc.y,
    x2: rightward ? to.x : to.x + BOX_W,
    y2: tc.y,
  };
}

/** 贝塞尔控制点 —— 与画布上的边同一套画法 */
export function linkPathOf(e: { x1: number; y1: number; x2: number; y2: number }): string {
  const dx = Math.abs(e.x2 - e.x1) * 0.5;
  return `M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1}, ${e.x2 - dx} ${e.y2}, ${e.x2} ${e.y2}`;
}

/** 各状态各有多少 —— 顶上那一行汇总用 */
export function flowSummary(boxes: FlowNodeBox[]): Record<FlowStatus, number> {
  const out: Record<FlowStatus, number> = { done: 0, running: 0, waiting: 0, blocked: 0 };
  for (const b of boxes) out[b.status] += 1;
  return out;
}

/* ------------------------------------------------------------------ */
/* 定位错误                                                            */
/* ------------------------------------------------------------------ */

/**
 * 这次运行里"出了问题"的节点，按**执行顺序**排列。
 *
 * ================= 为什么包含 skipped ====================
 *
 * 被跳过的节点几乎都是上游失败导致的，而那往往才是根因位置。
 * 只看 failed 的话，会被带到下游那个"什么都没干"的节点上 ——
 * 真正的断点在它前面。
 *
 * ================= 为什么按 order 而不是按类型 ====================
 *
 * 按类型分组（先所有失败、再所有跳过）会让跳转顺序
 * 与图上从左到右的顺序对不上：按按钮跳，图上的高亮却乱跳。
 */
export function errorNodesOf(task: TaskRecord): string[] {
  const ids = task.order.length > 0 ? task.order : Object.keys(task.nodes ?? {});
  return ids.filter((id) => flowStatusOf(task, id) === 'blocked');
}

/**
 * 按层分组的节点 id —— 列表视图用。
 *
 * 与流程图的列同源（都是 topoLayers），
 * 所以"图上第二列"就是"列表第二组"，切过去能对上。
 */
export function layersOf(task: TaskRecord): Array<[number, string[]]> {
  const { boxes, cols } = layoutTaskFlow(task);
  const out: Array<[number, string[]]> = [];
  for (let c = 0; c < cols; c += 1) {
    const ids = boxes.filter((b) => b.col === c).map((b) => b.id);
    if (ids.length > 0) out.push([c, ids]);
  }
  return out;
}
