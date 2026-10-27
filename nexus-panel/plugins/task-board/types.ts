// task-board 数据模型（与 Rust task_board.rs 的双端约定）

export type TaskStatus = 'todo' | 'claimed' | 'doing' | 'review' | 'done';

export const STATUS_ORDER: TaskStatus[] = ['todo', 'claimed', 'doing', 'review', 'done'];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待办',
  claimed: '已认领',
  doing: '进行中',
  review: '待审查',
  done: '已完成',
};

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export const PRIORITY_ORDER: Priority[] = ['P0', 'P1', 'P2', 'P3'];

export const PRIORITY_LABEL: Record<Priority, string> = {
  P0: '紧急',
  P1: '高',
  P2: '中',
  P3: '低',
};

export interface HistoryEntry {
  at: number;
  by: string;
  action: string;
  note: string;
}

export interface Task {
  id: string;
  title: string;
  /*
    任务说明 —— 一句话说清"这条要做什么"。

    与 detail（备注）刻意分开：
      说明 = 原始要求（做完也不该改）
      备注 = 过程中记的（随时加）
    混成一个字段的话，做完之后没人去清理说明，
    下次看到这条分不清哪些是原始要求、哪些是后来的补充。
  */
  summary: string;
  /** 备注：过程中随手记的，可长可短 */
  detail: string;
  /** 'task' 普通任务；'group' 任务组（只作归拢，本身不算一条活） */
  kind: 'task' | 'group';
  /** 所属任务组的 id。null = 不在任何组里。组自己也可以有 parent（可嵌套） */
  parent: string | null;
  /**
   * 前置任务 id。全部完成才解锁。
   * 指向组 = 等这个组里所有任务完成。
   */
  deps: string[];
  status: TaskStatus;
  priority: Priority;
  tags: string[];
  reporter: string;
  assignee: string | null;
  createdAt: number;
  updatedAt: number;
  history: HistoryEntry[];
}

/** 标签定义（名字 + 颜色）。颜色只影响显示，不影响筛选 */
export interface TagDef {
  id: string;
  name: string;
  color: string;
}

/**
 * 标签调色板。
 *
 * 取色范围刻意收在这几档：用户随手配的颜色在浅色主题下会看不清，
 * 而状态色（ok/danger/warn）要留给状态本身，不该被标签占用。
 */
export const TAG_COLORS: string[] = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16',
  '#22c55e', '#14b8a6', '#3b82f6', '#6366f1',
  '#a855f7', '#ec4899', '#78716c', '#0ea5e9',
];

export interface Agent {
  id: string;
  name: string;
  role: string;
  lastSeen: number;
}

export interface TaskStore {
  v: number;
  nextId: number;
  tasks: Task[];
  agents: Agent[];
  /** 标签定义表。任务上只存 id，颜色统一在这里改 */
  tagDefs: TagDef[];
}

export interface TbConfig {
  /** tasks.json 所在目录（绝对路径） */
  dataDir: string;
  /** 本地 HTTP API 端口 */
  port: number;
  /** 访问令牌（留空不校验） */
  token: string;
  /** 打开插件时自动启动 HTTP 服务 */
  autoStart: boolean;
  /** 任务提交审查时 POST 通知的目标（如 agent-flow webhook） */
  notifyUrl: string;
}

export const DEFAULT_CONFIG: TbConfig = {
  dataDir: '',
  port: 9911,
  token: '',
  autoStart: false,
  notifyUrl: '',
};

/** 一次状态流转的展示信息 */
export interface Transition {
  to: TaskStatus;
  label: string;
  /** 需要填备注（打回时必须写原因） */
  needNote?: boolean;
}
