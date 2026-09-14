/**
 * 任务记录 —— 任务窗口的数据模型与归约逻辑。
 *
 * 全部写成纯函数：输入旧记录 + 一个 RunEvent，输出新记录。
 * 这样"运行过程长什么样"可以脱离 React 单测，
 * 也避免状态更新散落在组件的各处回调里。
 */

import type { RunEvent } from './runner';

export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled';

/** 触发来源。用于区分"我手动点的"和"半夜自己跑的" */
export type TaskSource = 'manual' | 'interval' | 'cron' | 'watch' | 'webhook' | 'unknown';

export const SOURCE_LABEL: Record<TaskSource, string> = {
  manual: '手动',
  interval: '周期',
  cron: '定时',
  watch: '监听',
  webhook: '调用',
  unknown: '自动',
};

export type TaskNodeState = {
  id: string;
  status: 'idle' | 'running' | 'success' | 'failed' | 'skipped';
  output: string;
  error: string;
  startedAt?: number;
  endedAt?: number;
  /** 渲染后的提示词，便于事后看"当时到底发了什么" */
  rendered?: string;
  /** 条件节点走的分支名 */
  branch?: string;
  /** 并发节点解析出的并发度 */
  concurrency?: number;
  /** 循环节点的总轮数与已完成轮数 */
  loopTotal?: number;
  loopDone?: number;
  /** 本轮迭代值 */
  loopItem?: string;
};

export type TaskLogLine = {
  at: number;
  text: string;
  /** 归属节点；没有则是流程级日志 */
  nodeId?: string;
};

export type TaskRecord = {
  id: string;
  canvasId: string;
  canvasName: string;
  startedAt: number;
  endedAt?: number;
  status: TaskStatus;
  source: TaskSource;
  /** 节点出现顺序，保证列表稳定不跳 */
  order: string[];
  nodes: Record<string, TaskNodeState>;
  logs: TaskLogLine[];
  layerNow: number;
  layerTotal: number;
  /** 总节点数，用于算进度 */
  total: number;
};

export const MAX_OUTPUT_CHARS = 20000;
export const MAX_LOGS = 500;

/** 输出截断。跑一晚上的任务可能累积几十 MB，全留着会拖垮界面 */
export function clampOutput(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `…（已截断，仅保留最后 ${MAX_OUTPUT_CHARS} 字）\n${s.slice(-MAX_OUTPUT_CHARS)}`;
}

let seq = 0;

export function makeTask(init: {
  id?: string;
  canvasId: string;
  canvasName: string;
  source?: TaskSource;
  total?: number;
  now?: number;
}): TaskRecord {
  seq += 1;
  const now = init.now ?? Date.now();
  return {
    id: init.id || `task_${now}_${seq}`,
    canvasId: init.canvasId,
    canvasName: init.canvasName,
    startedAt: now,
    status: 'running',
    source: init.source ?? 'unknown',
    order: [],
    nodes: {},
    logs: [],
    layerNow: 0,
    layerTotal: 0,
    total: init.total ?? 0,
  };
}

function touch(task: TaskRecord, id: string, now: number): TaskNodeState {
  const exist = task.nodes[id];
  if (exist) return exist;
  const fresh: TaskNodeState = { id, status: 'idle', output: '', error: '' };
  if (task.order.indexOf(id) < 0) task.order.push(id);
  task.nodes[id] = fresh;
  return fresh;
}

function log(task: TaskRecord, at: number, text: string, nodeId?: string): void {
  task.logs.push(nodeId ? { at, text, nodeId } : { at, text });
  if (task.logs.length > MAX_LOGS) {
    task.logs.splice(0, task.logs.length - MAX_LOGS);
  }
}

/**
 * 把一个运行事件归约进任务记录。
 *
 * 就地修改传入对象并返回它 —— 调用方负责复制（见 applyEvent）。
 */
function reduce(task: TaskRecord, e: RunEvent, now: number): void {
  switch (e.type) {
    case 'layer-start':
      task.layerNow = e.layer + 1;
      task.layerTotal = e.total;
      log(task, now, `第 ${e.layer + 1}/${e.total} 层：${e.ids.join(', ')}`);
      break;

    case 'node-start': {
      const n = touch(task, e.id, now);
      n.status = 'running';
      n.startedAt = n.startedAt ?? now;
      n.rendered = e.rendered;
      log(task, now, `开始：${e.id}`, e.id);
      break;
    }

    case 'node-chunk': {
      const n = touch(task, e.id, now);
      // 追加而非覆盖：这是"实时输出"的关键
      n.output = clampOutput(n.output + e.chunk);
      break;
    }

    case 'node-done': {
      const n = touch(task, e.id, now);
      n.status = e.ok ? 'success' : 'failed';
      n.endedAt = now;
      // done 事件带的是完整输出，直接取代；没有才保留已累积的
      if (e.output) n.output = clampOutput(e.output);
      n.error = e.error ?? '';
      log(task, now, `${e.ok ? '完成' : '失败'}：${e.id}${e.error ? ` — ${e.error}` : ''}`, e.id);
      break;
    }

    case 'node-fields': {
      const n = touch(task, e.id, now);
      if (e.files.length > 0) {
        log(task, now, `识别到 ${e.files.length} 个文件：${e.files.slice(0, 3).join(', ')}${e.files.length > 3 ? ' …' : ''}`, e.id);
      }
      break;
    }

    case 'node-status': {
      const n = touch(task, e.id, now);
      n.status = e.status;
      if (e.status === 'skipped') n.endedAt = n.endedAt ?? now;
      break;
    }

    case 'branch-taken': {
      const n = touch(task, e.id, now);
      n.branch = e.label;
      n.status = 'success';
      log(task, now, `条件走向：${e.label}`, e.id);
      if (e.pruned.length > 0) log(task, now, `剪枝 ${e.pruned.length} 个节点：${e.pruned.join(', ')}`, e.id);
      break;
    }

    case 'parallel-resolved': {
      const n = touch(task, e.id, now);
      n.concurrency = e.concurrency;
      log(task, now, `并发度 ${e.concurrency}（${e.reason}）`, e.id);
      break;
    }

    case 'loop-resolved': {
      const n = touch(task, e.id, now);
      n.loopTotal = e.count;
      n.loopDone = 0;
      log(task, now, `循环开始：${e.reason}（${e.count} 轮）`, e.id);
      for (const w of e.warnings) log(task, now, `⚠ ${w}`, e.id);
      break;
    }

    case 'loop-iteration': {
      const n = touch(task, e.id, now);
      n.loopDone = e.index + 1;
      n.loopItem = e.item;
      log(task, now, `第 ${e.index + 1}/${e.count} 轮：${e.item.slice(0, 60)}`, e.id);
      break;
    }

    case 'loop-done': {
      const n = touch(task, e.id, now);
      n.endedAt = now;
      n.status = e.failed > 0 ? 'failed' : 'success';
      log(task, now, `循环结束：${e.rounds} 轮，失败 ${e.failed}`, e.id);
      break;
    }

    case 'update-checked': {
      const n = touch(task, e.id, now);
      log(task, now, `${e.baseline ? '记录基线' : e.updated ? '有更新' : '无更新'}：${e.reason}`, e.id);
      break;
    }

    case 'run-error': {
      log(task, now, `✗ ${e.message}`);
      break;
    }

    default:
      break;
  }
}

/** 应用事件，返回新记录（不改原对象） */
export function applyEvent(task: TaskRecord, e: RunEvent, now: number = Date.now()): TaskRecord {
  const next: TaskRecord = {
    ...task,
    nodes: { ...task.nodes },
    order: [...task.order],
    logs: [...task.logs],
  };
  reduce(next, e, now);
  return next;
}

/** 结束任务。cancelled 优先于 failed —— 用户主动停的不该显示成失败 */
export function finishTask(
  task: TaskRecord,
  ok: boolean,
  now: number = Date.now(),
): TaskRecord {
  if (task.status === 'cancelled') return task;
  return { ...task, endedAt: now, status: ok ? 'success' : 'failed' };
}

export function cancelTask(task: TaskRecord, now: number = Date.now()): TaskRecord {
  if (task.status !== 'running') return task;
  const nodes: Record<string, TaskNodeState> = {};
  for (const k of Object.keys(task.nodes)) {
    const n = task.nodes[k];
    nodes[k] = n.status === 'running' ? { ...n, status: 'failed', error: '已取消', endedAt: now } : n;
  }
  return { ...task, status: 'cancelled', endedAt: now, nodes };
}

export type TaskProgress = {
  done: number;
  failed: number;
  running: number;
  skipped: number;
  pending: number;
  total: number;
  /** 0~100，用于进度条 */
  percent: number;
};

export function progressOf(task: TaskRecord): TaskProgress {
  let done = 0, failed = 0, running = 0, skipped = 0, pending = 0;
  for (const id of task.order) {
    const n = task.nodes[id];
    if (!n) continue;
    if (n.status === 'success') done += 1;
    else if (n.status === 'failed') failed += 1;
    else if (n.status === 'running') running += 1;
    else if (n.status === 'skipped') skipped += 1;
    else pending += 1;
  }
  const total = Math.max(task.total, task.order.length);
  // 已终结的数量才计入分母分子，pending 不计 —— 否则一开始就是 0% 且长时间不动
  const settled = done + failed + skipped;
  const percent = total === 0 ? 0 : Math.min(100, Math.round((settled / total) * 100));
  return { done, failed, running, skipped, pending, total, percent };
}

/** 耗时（毫秒）。未结束的任务用 now 算，能实时走秒 */
export function elapsedOf(task: TaskRecord, now: number = Date.now()): number {
  return Math.max(0, (task.endedAt ?? now) - task.startedAt);
}

/** 格式化耗时：1.2s / 3m05s / 1h02m */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** 时钟时间 HH:MM:SS */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
};

export const NODE_STATUS_LABEL: Record<string, string> = {
  idle: '等待',
  running: '运行中',
  success: '成功',
  failed: '失败',
  skipped: '跳过',
};

/* ------------------------------------------------------------------ */
/* 分组与虚拟滚动                                                      */
/* ------------------------------------------------------------------ */

/**
 * 按流程分组。
 *
 * 数百个任务并发时，平铺列表根本没法看 —— 同一个流程的几十条记录
 * 会把其它流程的运行状态挤到看不见的地方。分组后每个流程一个头，
 * 汇总"几条在跑、共几条"，折叠起来就只剩一行。
 */
export type TaskGroup = {
  canvasId: string;
  canvasName: string;
  /** 按开始时间倒序，最新的在最上面 */
  tasks: TaskRecord[];
  runningCount: number;
  failedCount: number;
  total: number;
  /** 组内最新一条的开始时间，用于组间排序 */
  latestAt: number;
};

export function groupByCanvas(tasks: TaskRecord[]): TaskGroup[] {
  const byId = new Map<string, TaskRecord[]>();
  for (const t of tasks) {
    const key = t.canvasId || '__unknown__';
    const list = byId.get(key);
    if (list) list.push(t);
    else byId.set(key, [t]);
  }
  const groups: TaskGroup[] = [];
  for (const [canvasId, list] of byId) {
    // 先按开始时间倒序，之后取名字与 latestAt 都基于排好的第一条
    list.sort((a, b) => b.startedAt - a.startedAt);
    groups.push({
      canvasId,
      // 流程可能改过名，用最新一条记录上的名字
      canvasName: (list[0] && list[0].canvasName) || '未命名流程',
      tasks: list,
      runningCount: list.filter((t) => t.status === 'running').length,
      failedCount: list.filter((t) => t.status === 'failed').length,
      total: list.length,
      latestAt: list[0] ? list[0].startedAt : 0,
    });
  }
  // 有任务在跑的组排最前，其次按最新开始时间
  groups.sort((a, b) => {
    if (a.runningCount !== b.runningCount) return b.runningCount - a.runningCount;
    return b.latestAt - a.latestAt;
  });
  return groups;
}

/** 扁平行：虚拟滚动需要把"分组头 + 任务行"拉平成一维数组来切片 */
export type TaskRow =
  | { kind: 'group'; key: string; group: TaskGroup; index: number }
  | { kind: 'task'; key: string; task: TaskRecord; index: number };

/**
 * 拉平。折叠的组只贡献一个头。
 * index 是行在扁平数组里的位置，虚拟滚动靠它定位。
 */
export function flattenRows(groups: TaskGroup[], expanded: Set<string>): TaskRow[] {
  const rows: TaskRow[] = [];
  let i = 0;
  for (const g of groups) {
    rows.push({ kind: 'group', key: `g:${g.canvasId}`, group: g, index: i });
    i += 1;
    if (expanded.has(g.canvasId)) {
      for (const t of g.tasks) {
        rows.push({ kind: 'task', key: `t:${t.id}`, task: t, index: i });
        i += 1;
      }
    }
  }
  return rows;
}

export const GROUP_ROW_HEIGHT = 40;
export const TASK_ROW_HEIGHT = 76;
/** 视口外多渲染几行，避免快速滚动时露白 */
export const OVERSCAN = 3;

export function rowHeightOf(row: TaskRow): number {
  return row.kind === 'group' ? GROUP_ROW_HEIGHT : TASK_ROW_HEIGHT;
}

/** 每一行的顶部偏移。行数上千时这是 O(n)，但只在数据变化时算一次 */
export function rowOffsets(rows: TaskRow[]): number[] {
  const out: number[] = [];
  let y = 0;
  for (const r of rows) {
    out.push(y);
    y += rowHeightOf(r);
  }
  return out;
}

export type WindowSlice = {
  start: number;
  end: number;
  /** 上方留白高度，撑起滚动条 */
  padTop: number;
  padBottom: number;
  totalHeight: number;
};

/**
 * 算出应该渲染哪几行。
 *
 * 用二分查找定位起始行，避免上千行时逐行累加。
 */
export function windowSlice(
  rows: TaskRow[],
  offsets: number[],
  scrollTop: number,
  viewportH: number,
  overscan: number = OVERSCAN,
  /** 自定义行高。历史面板的行类型不同，靠这个复用同一套切片逻辑 */
  heightOf: (row: TaskRow) => number = rowHeightOf,
): WindowSlice {
  const n = rows.length;
  if (n === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 };
  const totalHeight = offsets[n - 1] + heightOf(rows[n - 1]);

  // 二分：找最后一个 offset <= scrollTop 的行
  let lo = 0, hi = n - 1, start = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= scrollTop) { start = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const bottom = scrollTop + viewportH;
  let end = start;
  while (end < n && offsets[end] < bottom) end += 1;
  end = Math.min(n, end + 1);

  const s = Math.max(0, start - overscan);
  const e = Math.min(n, end + overscan);
  return {
    start: s,
    end: e,
    padTop: offsets[s] ?? 0,
    padBottom: Math.max(0, totalHeight - ((offsets[e - 1] ?? 0) + heightOf(rows[e - 1] ?? rows[n - 1]))),
    totalHeight,
  };
}

/** 默认展开哪些组：有任务在跑的自动展开，否则全展开（只有一个组时没必要折叠） */
export function defaultExpanded(groups: TaskGroup[]): Set<string> {
  const s = new Set<string>();
  const running = groups.filter((g) => g.runningCount > 0);
  if (running.length > 0) {
    for (const g of running) s.add(g.canvasId);
    return s;
  }
  if (groups.length <= 1) {
    for (const g of groups) s.add(g.canvasId);
  }
  return s;
}
