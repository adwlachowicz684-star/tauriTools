/**
 * 历史面板 —— 跨会话保留运行记录。
 *
 * 和任务窗口的分工：
 *   任务窗口 = 当前会话的实时运行态（不落盘，关掉就没了）
 *   历史面板 = 跨会话的归档（落盘，下次打开还在）
 *
 * 结构上刻意让 HistoryEntry 与 TaskRecord 兼容 ——
 * 这样分组、虚拟滚动、详情渲染全都能复用，不用写第二套。
 * 差别只在"内容被裁剪过"：历史存的是摘要，不是完整输出。
 */

import { type TaskRecord, type TaskNodeState, clampOutput } from './tasks';

/** localStorage 里通常只有 5MB，历史必须限量，否则会把画布存档一起挤掉 */
export const HISTORY_STORE_KEY = 'agent-flow.history.v1';
export const HISTORY_VERSION = 1;

export const MAX_ENTRIES = 200;
/** 总字符预算。JSON 里中文转义后体积会膨胀，这里按"字符数"保守估算 */
export const MAX_TOTAL_CHARS = 1_500_000;
export const MAX_NODE_OUTPUT = 2000;
export const MAX_NODE_RENDERED = 800;
export const MAX_LOGS_PER_ENTRY = 60;
export const MAX_NODES_PER_ENTRY = 60;

export type HistoryEntry = TaskRecord;

export type HistoryFile = {
  v: number;
  entries: HistoryEntry[];
};

export function emptyHistory(): HistoryFile {
  return { v: HISTORY_VERSION, entries: [] };
}

/* ------------------------------------------------------------------ */
/* 裁剪                                                                */
/* ------------------------------------------------------------------ */

/**
 * 估算一条记录占多少字符。
 * 用估算而非 JSON.stringify —— 后者在几百条时每次都要全量序列化，太慢。
 */
export function sizeOfEntry(e: HistoryEntry): number {
  let n = 0;
  n += (e.canvasName || '').length + (e.canvasId || '').length + 64;
  n += e.logs.reduce((s, l) => s + l.text.length + 24, 0);
  for (const id of e.order) {
    const nd = e.nodes[id];
    if (!nd) continue;
    n += (nd.output || '').length + (nd.error || '').length + (nd.rendered || '').length + 48;
  }
  return n;
}

/**
 * 把运行记录裁剪成可归档的形态。
 *
 * 为什么要裁：一个任务可能有几十个节点、每个节点上万字输出。
 * 全量存的话十几条就把 localStorage 撑爆，届时连画布存档都写不进去。
 */
export function compactTask(task: TaskRecord): HistoryEntry {
  const order = task.order.slice(0, MAX_NODES_PER_ENTRY);
  const nodes: Record<string, TaskNodeState> = {};
  for (const id of order) {
    const n = task.nodes[id];
    if (!n) continue;
    nodes[id] = {
      ...n,
      output: clampLen(n.output, MAX_NODE_OUTPUT),
      rendered: n.rendered ? clampLen(n.rendered, MAX_NODE_RENDERED) : undefined,
    };
  }
  const logs = task.logs.slice(-MAX_LOGS_PER_ENTRY);
  /*
    会话被强制关闭时，任务可能还是 running。
    存进历史不该永远显示"运行中" —— 那会让人以为它还活着。
    异常终止统一记为 cancelled，与用户主动停止区分开：
    这里没法知道是哪种，但至少不该冒充"进行中"。
  */
  const status = task.status === 'running' ? 'cancelled' : task.status;
  return {
    ...task,
    status: status as TaskRecord['status'],
    endedAt: task.endedAt ?? task.startedAt,
    order,
    nodes,
    logs,
  };
}

function clampLen(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…（归档时截断，仅保留最后 ${max} 字）\n${s.slice(-max)}`;
}

export { clampOutput };

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

/** 解析存储文件。手改过、旧版本、缺字段都要能兜住，否则 UI 会崩在渲染阶段 */
export function parseHistory(raw: string | null): HistoryFile {
  if (!raw) return emptyHistory();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyHistory();
  }
  if (!parsed || typeof parsed !== 'object') return emptyHistory();
  const o = parsed as Record<string, unknown>;
  const list = Array.isArray(o.entries) ? o.entries : [];
  const entries: HistoryEntry[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const e = x as Record<string, unknown>;
    if (typeof e.id !== 'string') continue;
    const nodes: Record<string, TaskNodeState> = {};
    const rawNodes = (e.nodes && typeof e.nodes === 'object') ? e.nodes as Record<string, unknown> : {};
    for (const k of Object.keys(rawNodes)) {
      const nd = rawNodes[k] as Record<string, unknown>;
      if (!nd || typeof nd !== 'object') continue;
      nodes[k] = {
        id: typeof nd.id === 'string' ? nd.id : k,
        status: (typeof nd.status === 'string' ? nd.status : 'idle') as TaskNodeState['status'],
        output: typeof nd.output === 'string' ? nd.output : '',
        error: typeof nd.error === 'string' ? nd.error : '',
        startedAt: typeof nd.startedAt === 'number' ? nd.startedAt : undefined,
        endedAt: typeof nd.endedAt === 'number' ? nd.endedAt : undefined,
        rendered: typeof nd.rendered === 'string' ? nd.rendered : undefined,
        branch: typeof nd.branch === 'string' ? nd.branch : undefined,
        concurrency: typeof nd.concurrency === 'number' ? nd.concurrency : undefined,
        loopTotal: typeof nd.loopTotal === 'number' ? nd.loopTotal : undefined,
        loopDone: typeof nd.loopDone === 'number' ? nd.loopDone : undefined,
        loopItem: typeof nd.loopItem === 'string' ? nd.loopItem : undefined,
      };
    }
    entries.push({
      id: e.id,
      canvasId: typeof e.canvasId === 'string' ? e.canvasId : '',
      canvasName: typeof e.canvasName === 'string' && e.canvasName ? e.canvasName : '未命名流程',
      startedAt: typeof e.startedAt === 'number' ? e.startedAt : Date.now(),
      endedAt: typeof e.endedAt === 'number' ? e.endedAt : undefined,
      status: (['running', 'success', 'failed', 'cancelled'].indexOf(e.status as string) >= 0
        ? e.status : 'cancelled') as TaskRecord['status'],
      source: (typeof e.source === 'string' ? e.source : 'unknown') as TaskRecord['source'],
      order: Array.isArray(e.order) ? e.order.filter((x2): x2 is string => typeof x2 === 'string') : Object.keys(nodes),
      nodes,
      logs: Array.isArray(e.logs) ? e.logs.filter((l): l is { at: number; text: string; nodeId?: string } =>
        !!l && typeof l === 'object' && typeof (l as { at?: unknown }).at === 'number'
        && typeof (l as { text?: unknown }).text === 'string') : [],
      layerNow: typeof e.layerNow === 'number' ? e.layerNow : 0,
      layerTotal: typeof e.layerTotal === 'number' ? e.layerTotal : 0,
      total: typeof e.total === 'number' ? e.total : 0,
    });
  }
  return { v: HISTORY_VERSION, entries };
}

export function serializeHistory(file: HistoryFile): string {
  return JSON.stringify(file);
}

/* ------------------------------------------------------------------ */
/* 配额                                                                */
/* ------------------------------------------------------------------ */

export type PruneResult = {
  entries: HistoryEntry[];
  removed: number;
};

/**
 * 按"最旧的先淘汰"裁剪。
 *
 * 两条限制同时生效：条数上限 + 字符预算。
 * 只看条数不够 —— 几十个超长任务照样能把 5MB 撑爆。
 */
export function pruneHistory(entries: HistoryEntry[]): PruneResult {
  // 新的在前
  const sorted = [...entries].sort((a, b) => b.startedAt - a.startedAt);
  const kept: HistoryEntry[] = [];
  let chars = 0;
  let removed = 0;
  for (const e of sorted) {
    if (kept.length >= MAX_ENTRIES) { removed += 1; continue; }
    const sz = sizeOfEntry(e);
    if (chars + sz > MAX_TOTAL_CHARS) { removed += 1; continue; }
    kept.push(e);
    chars += sz;
  }
  return { entries: kept, removed };
}

/** 追加一条并裁剪。返回新文件与被淘汰的条数 */
export function addToHistory(file: HistoryFile, task: TaskRecord): { file: HistoryFile; removed: number } {
  const entry = compactTask(task);
  const merged = [entry, ...file.entries];
  const r = pruneHistory(merged);
  return { file: { v: HISTORY_VERSION, entries: r.entries }, removed: r.removed };
}

export function removeFromHistory(file: HistoryFile, id: string): HistoryFile {
  return { ...file, entries: file.entries.filter((e) => e.id !== id) };
}

/** 清空某个流程的全部历史 */
export function clearCanvasHistory(file: HistoryFile, canvasId: string): HistoryFile {
  return { ...file, entries: file.entries.filter((e) => e.canvasId !== canvasId) };
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

export type HistoryStats = {
  total: number;
  success: number;
  failed: number;
  cancelled: number;
  chars: number;
  /** 占用百分比，按 MAX_TOTAL_CHARS 计算 */
  usage: number;
  oldestAt?: number;
  newestAt?: number;
};

export function historyStats(entries: HistoryEntry[]): HistoryStats {
  let success = 0, failed = 0, cancelled = 0, chars = 0;
  /*
    刻意拆成两行单独声明：
    类型剥离脚本会把 `let a: T, b: T;` 的多变量声明里第二个之后的名字丢掉
    （后面的 newest 就没了，运行时报 "newest is not defined"）。
  */
  let oldest: number | undefined;
  let newest: number | undefined;
  for (const e of entries) {
    if (e.status === 'success') success += 1;
    else if (e.status === 'failed') failed += 1;
    else if (e.status === 'cancelled') cancelled += 1;
    chars += sizeOfEntry(e);
    if (oldest === undefined || e.startedAt < oldest) oldest = e.startedAt;
    if (newest === undefined || e.startedAt > newest) newest = e.startedAt;
  }
  return {
    total: entries.length,
    success, failed, cancelled,
    chars,
    usage: Math.min(100, Math.round((chars / MAX_TOTAL_CHARS) * 100)),
    oldestAt: oldest, newestAt: newest,
  };
}

/** 人类可读的体积 */
export function formatSize(chars: number): string {
  if (chars < 1024) return `${chars} 字`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} K字`;
  return `${(chars / 1024 / 1024).toFixed(2)} M字`;
}

/* ------------------------------------------------------------------ */
/* 筛选与搜索                                                          */
/* ------------------------------------------------------------------ */

export type RangeKey = 'today' | '7d' | '30d' | 'all';

export const RANGE_LABEL: Record<RangeKey, string> = {
  today: '今天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部',
};

const DAY_MS = 86400000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function withinRange(ts: number, now: number, range: RangeKey): boolean {
  if (range === 'all') return true;
  if (range === 'today') return ts >= startOfDay(now);
  if (range === '7d') return ts >= now - 7 * DAY_MS;
  if (range === '30d') return ts >= now - 30 * DAY_MS;
  return true;
}

export type HistoryFilter = {
  range?: RangeKey;
  /** 只留某个状态；空则不限 */
  status?: '' | 'success' | 'failed' | 'cancelled';
  keyword?: string;
  canvasId?: string;
};

export function filterHistory(
  entries: HistoryEntry[],
  f: HistoryFilter,
  now: number = Date.now(),
): HistoryEntry[] {
  const kw = (f.keyword || '').trim().toLowerCase();
  return entries.filter((e) => {
    if (f.range && !withinRange(e.startedAt, now, f.range)) return false;
    if (f.status && e.status !== f.status) return false;
    if (f.canvasId && e.canvasId !== f.canvasId) return false;
    if (kw) {
      const parts: string[] = [e.canvasName, e.source, ...e.order];
      for (const l of e.logs) parts.push(l.text);
      /*
        节点输出也参与搜索 —— 用户找"上次生成的那个函数名"时，
        关键词多半在输出里而不在日志里。
        但每个节点只取前 400 字、整条上限 8000 字：
        几百条 × 几万字会在每次按键时把输入卡住。
      */
      for (const id of e.order) {
        const nd = e.nodes[id];
        if (nd && nd.output) parts.push(nd.output.slice(0, 400));
      }
      let hay = parts.join(' ').toLowerCase();
      if (hay.length > 8000) hay = hay.slice(0, 8000);
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  });
}

/** 时间桶，用于列表里插入"今天/昨天/更早"分隔 */
export type TimeBucket = '今天' | '昨天' | '本周' | '更早';

export function timeBucketOf(ts: number, now: number = Date.now()): TimeBucket {
  const today = startOfDay(now);
  if (ts >= today) return '今天';
  if (ts >= today - DAY_MS) return '昨天';
  if (ts >= today - 7 * DAY_MS) return '本周';
  return '更早';
}

/** 按时间桶分组，保持桶内倒序。历史面板默认按时间看，比按流程更符合"回顾"的习惯 */
export function groupByTime(entries: HistoryEntry[], now: number = Date.now()): { bucket: TimeBucket; entries: HistoryEntry[] }[] {
  const order: TimeBucket[] = ['今天', '昨天', '本周', '更早'];
  const map = new Map<TimeBucket, HistoryEntry[]>();
  for (const e of entries) {
    const b = timeBucketOf(e.startedAt, now);
    const list = map.get(b);
    if (list) list.push(e);
    else map.set(b, [e]);
  }
  const out: { bucket: TimeBucket; entries: HistoryEntry[] }[] = [];
  for (const b of order) {
    const list = map.get(b);
    if (!list || list.length === 0) continue;
    list.sort((x, y) => y.startedAt - x.startedAt);
    out.push({ bucket: b, entries: list });
  }
  return out;
}

/** 日期时间：M月D日 HH:MM */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 写不进去时裁掉一半最旧的 —— 抽出来是为了能单测。
 *
 * ================= 为什么要给"裁不动"一个明确的返回值 ====================
 *
 * 只剩一条时再裁还是它自己，会陷进"裁了再写、写了再裁"的死循环。
 * 返回 null 让调用方知道"救不了了"，去提示用户而不是反复重试。
 *
 * ================= 为什么不能静默 ====================
 *
 * localStorage 通常只有 5MB。写失败却什么都不说的话，
 * 用户以为归档好了，下次打开却是空的 —— 那种丢失无从查起。
 */
export function planHistoryRetry(file: HistoryFile): HistoryFile | null {
  if (file.entries.length <= 1) return null;
  const keep = file.entries.slice(0, Math.max(1, Math.floor(file.entries.length / 2)));
  return { v: file.v, entries: keep };
}
