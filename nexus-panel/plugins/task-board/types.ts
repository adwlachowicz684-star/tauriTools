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
  detail: string;
  status: TaskStatus;
  priority: Priority;
  tags: string[];
  reporter: string;
  assignee: string | null;
  createdAt: number;
  updatedAt: number;
  history: HistoryEntry[];
}

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
