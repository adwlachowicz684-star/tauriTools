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

export type SortField = 'priority' | 'status' | 'assignee' | 'updatedAt' | 'createdAt' | 'title' | 'id';

/** 多字段排序；assignee 未认领恒排最后；同级按 updatedAt 倒序兜底 */
export declare function sortTasksBy(tasks: Task[], field: SortField, dir?: 'asc' | 'desc'): Task[];

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
  byPriority: Record<string, number>;
  byAssignee: { id: string; count: number }[];
  topTags: { tag: string; count: number }[];
  recent: RecentEntry[];
  stale: Task[];
  agents: Agent[];
}

/** 统计视图数据源；now 可注入保证可测 */
export declare function statsOf(store: TaskStore, now?: number): TbStats;
