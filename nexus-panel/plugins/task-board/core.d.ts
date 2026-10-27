import type { Task, TaskStore, HistoryEntry, Agent } from './types';

export declare const STATUSES: string[];
export declare const PRIORITIES: string[];

export declare function canTransition(from: string, to: string): boolean;
export declare function actionsFor(status: string): { to: string; label: string; needNote?: boolean }[];
export declare function normalizeTask(raw: any): Task;
export declare function normalizeStore(raw: any): TaskStore;
export declare function sortTasks<T extends { priority: string; updatedAt: number }>(tasks: T[]): T[];
export declare function filterTasks<T extends { id: string; title: string; detail: string; tags: string[]; assignee: string | null; priority: string }>(
  tasks: T[],
  f: { priority?: string; tag?: string; assignee?: string; q?: string },
): T[];
export declare function allTags(tasks: { tags: string[] }[]): string[];

/* ---------------------------------------------------- 任务组嵌套 */

export declare function indexTasks(tasks: Task[]): {
  byId: Record<string, Task>;
  parentOf: Record<string, string | undefined>;
};

export declare function ancestorChain(id: string, parentOf: Record<string, string | undefined>, limit?: number): string[];

export interface FlatRow {
  task: Task;
  depth: number;
  path: string[];
  groupPath: string;
}

/** 摊平成表格行：组不占行，层级显示在 path 上 */
export declare function flattenTasks(tasks: Task[]): FlatRow[];

/** 组的状态由下面推导；空组返回 null */
export declare function groupStatus(groupId: string, tasks: Task[]): TaskStatus | null;

/* ---------------------------------------------------- 前置任务 */

export interface LockInfo {
  locked: boolean;
  pending: string[];
  missing: string[];
  cyclic: boolean;
}

/* ---------------------------------------------------- 合并 / 拆组 */

export declare function mergeIntoGroup(
  tasks: Task[], ids: string[], title: string, parentId?: string | null,
): { tasks: Task[]; groupId: string };

export declare function createGroup(
  tasks: Task[], title: string, parentId?: string | null,
): { tasks: Task[]; groupId: string };

/** 拆成一个组 + 若干子任务。原任务变成组（保留原 id） */
export declare function splitTask(
  tasks: Task[], id: string, titles: string[],
): { tasks: Task[]; groupId: string; childIds: string[] };

/** 拆组：组删掉，下面的任务上提一层（不是连任务一起删） */
export declare function dissolveGroup(tasks: Task[], groupId: string): { tasks: Task[] };

export declare function isAncestor(
  a: string, b: string,
  parentOf: Record<string, string | undefined>,
  byId: Record<string, Task>,
): boolean;

/** 锁定状态是算出来的，不存字段 */
export declare function lockOf(task: Task, tasks: Task[]): LockInfo;

/* ---------------------------------------------------- 流程配置 */

export interface StatusDef {
  id: string;
  name: string;
  color: string;
  enter: string;
  done: boolean;
}

export interface TaskFlow {
  statuses: StatusDef[];
  transitions: Record<string, string[]>;
  edges: Record<string, { label: string; note: boolean }>;
}

export declare const DEFAULT_FLOW: TaskFlow;

/** 解析流程配置；坏/缺 → 默认那套（不会让整份文件打不开） */
export declare function normalizeFlow(raw: unknown): TaskFlow;

/** 状态 id → 显示名。没配过的原样显示 id */
export declare function statusName(flow: TaskFlow | null | undefined, id: string): string;

export declare function statusColor(flow: TaskFlow | null | undefined, id: string): string;

/** 这个状态算不算"完成"（已取消不算） */
export declare function statusDone(flow: TaskFlow | null | undefined, id: string): boolean;

/** 初始状态 = 列表第一个 */
export declare function initialStatus(flow: TaskFlow | null | undefined): string;

/** 按配置判断能否流转 */
export declare function canTransitionIn(flow: TaskFlow | null | undefined, from: string, to: string): boolean;

/** 当前状态下界面上的操作按钮（由流转表推导） */
export declare function actionsForIn(
  flow: TaskFlow | null | undefined, status: string,
): { to: string; label: string; needNote?: boolean }[];

/* ---------------------------------------------------- 列级筛选 */

/** 列表视图的列定义。kind 决定这一列配什么筛选控件 */
export interface ListColumn {
  field: SortField;
  label: string;
  kind: 'enum' | 'text' | 'time' | 'num';
}

export declare const LIST_COLUMNS: ListColumn[];

/** 一列的筛选条件（四种字段合一，换来一份判空、一份清空） */
export interface ColFilter {
  text: string;
  values: string[];
  min: string;
  max: string;
}

export declare function emptyColFilter(): ColFilter;

/** 该列的筛选是否生效。判空只写一处，UI 与过滤共用 */
export declare function colFilterActive(col: ListColumn, f: ColFilter | undefined): boolean;

/** 该列用于筛选的原始值（标签是多值） */
export declare function colRawValues(task: Task, field: SortField): string[];

/** 按列筛选（作用在摊平行上）；q 是跨 id/标题/详情/说明的全局关键词 */
export declare function filterTasksByColumns(
  rows: FlatRow[],
  filters: Partial<Record<SortField, ColFilter>>,
  q?: string,
): FlatRow[];

/** 生效的筛选列（按列序） */
export declare function activeColFilters(filters: Partial<Record<SortField, ColFilter>>): ListColumn[];

/** 某一列的候选值（原始值，显示文案由 UI 用 types.ts 映射） */
/* ---------------------------------------------------- 预估工作量（人日） */

/** 数值列里代表「没估」的选项。是"缺失"，不是 0 */
export declare const UNESTIMATED: string;

export declare function numOrNull(v: unknown): number | null;

/** 人日显示：去掉浮点尾巴。0 → ''（没估 ≠ 0 人日） */
export declare function fmtEstimate(n: number): string;

/** 组的预估 = 下面所有层叶子任务的和（组自己不存预估） */
export declare function groupEstimate(groupId: string, tasks: Task[]): number;

/** 全部叶子任务的工作量合计 */
export declare function totalEstimate(tasks: Task[]): number;

export declare function colFilterValues(
  field: SortField, rows: FlatRow[] | Task[], statusIds?: string[],
): string[];
export declare function nextTaskId(store: { nextId: number }): string;
export declare function pushHistory(task: any, by: string, action: string, note: string, at?: number): any;
export declare function applyTransition(task: any, to: string, by: string, note?: string, at?: number): any;
export declare function fmtTime(ms: number): string;
export declare function relTime(ms: number): string;

export declare const UNASSIGNED: '__none__';
export declare const NOTAG: '__notag__';

export type GroupKey = 'status' | 'priority' | 'assignee' | 'tag';

export interface TaskGroup<K extends string = string> {
  key: K;
  tasks: Task[];
}

/** 分组（只返回 key，label 由 UI 映射 types.ts 的 STATUS_LABEL / PRIORITY_LABEL） */
export declare function groupTasks(tasks: Task[], key: GroupKey): TaskGroup[];

export type SortField =
  | 'priority' | 'status' | 'assignee' | 'tags' | 'groupPath' | 'summary' | 'estimate'
  | 'updatedAt' | 'createdAt' | 'title' | 'id';

/** 多字段排序；assignee 未认领恒排最后；同级按 updatedAt 倒序兜底 */
export declare function sortTasksBy(tasks: Task[], field: SortField, dir?: 'asc' | 'desc'): Task[];

/** 按列排序（作用在摊平行上）：认 groupPath，且同组的挨在一起 */
export declare function sortRowsBy(rows: FlatRow[], field: SortField, dir?: 'asc' | 'desc'): FlatRow[];

export interface RecentEntry extends HistoryEntry {
  taskId: string;
  title: string;
}

export interface TbStats {
  total: number;
  open: number;
  active: number;
  done: number;
  byStatus: Record<string, number>;
  /** 每个状态下叶子任务的工作量合计（人日） */
  estimateByStatus: Record<string, number>;
  /** 全部叶子任务的工作量合计（人日） */
  estimateTotal: number;
  byPriority: Record<string, number>;
  byAssignee: { id: string; count: number; est: number }[];
  topTags: { tag: string; count: number }[];
  recent: RecentEntry[];
  stale: Task[];
  agents: Agent[];
}

/** 统计视图数据源；now 可注入保证可测 */
export declare function statsOf(store: TaskStore, now?: number): TbStats;
