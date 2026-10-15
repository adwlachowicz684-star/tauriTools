import type { Task, TaskStore } from './types';

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
