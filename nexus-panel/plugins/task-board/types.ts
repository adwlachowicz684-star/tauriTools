// task-board 数据模型（与 Rust task_board.rs 的双端约定）

/*
  状态清单与 core.mjs 的 STATUSES **逐项同序**（守卫第 22 节盯着）。
  状态不再写死 —— 用户可以在界面上增删改，这里只是默认值。
  挂起（hold）与已取消（cancelled）是默认就给的两种：
  挂起 = 还要做但推不动；取消 = 不做了。合成一个"不推进"的话，
  复盘时根本分不清哪些是暂时卡住、哪些已经放弃。
*/
export type TaskStatus =
  | 'todo' | 'claimed' | 'doing' | 'hold' | 'review' | 'done' | 'cancelled';

export const STATUS_ORDER: TaskStatus[] = [
  'todo', 'claimed', 'doing', 'hold', 'review', 'done', 'cancelled',
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待办',
  claimed: '已认领',
  doing: '进行中',
  hold: '挂起',
  review: '待审查',
  done: '已完成',
  cancelled: '已取消',
};

/** 默认状态色。用户可在流程设置里改 —— 这里是初始值 */
export const STATUS_COLOR: Record<TaskStatus, string> = {
  todo: '#78716c',
  claimed: '#0ea5e9',
  doing: '#3b82f6',
  hold: '#f59e0b',
  review: '#a855f7',
  done: '#22c55e',
  cancelled: '#ef4444',
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

/**
 * 单值 或 多值。
 *
 * 用户在列设置里给这一列勾上「多选」之后，值就变成数组
 * （一条任务可以同时属于多个类型 / 分组 / 认领人）。
 * 两种形态**长期共存**：老数据是字符串，关掉多选会压回字符串。
 * 所以读写都要兼容这两者，不能假设一定是一种。
 */
export type MultiVal = string | string[];

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
  /** 预估工作量，单位人日，允许小数（0.5 = 半天）。0 = 没估 */
  estimate: number;
/**
 * 单值 或 多值。
 *
 * 用户在列设置里给这一列勾上「多选」之后，值就变成数组
 * （一条任务可以同时属于多个类型 / 分组 / 认领人）。
 * 两种形态**长期共存**：老数据是字符串，关掉多选会压回字符串。
 * 所以读写都要兼容这两者，不能假设一定是一种。
 */
  /** 任务类型，存的是 typeDefs 里的 id（'dev'/'bug'…）。'' = 未分类 */
  type: MultiVal;
  /**
   * 分组名。留空 = 不分组。
   *
   * 相当于以前的"手动分组"，但只是一列**值**：不再有组记录、也不再有父子层级，
   * 归拢完全由通用的"按列分组"机制表达（在分组设置里选这一列即可）。
   */
  group: MultiVal;
  tags: string[];
  reporter: string;
  assignee: MultiVal | null;
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
  /*
    定义表：**一张按 defKey 索引的表**，不再是四个平级字段。

    ⛔ 重构前是 tagDefs / typeDefs / groupDefs / assigneeDefs 四个 ——
    于是"给定义表加个能力"要在四处各做一遍，
    "新增一个带定义表的列"要改类型、改归一化、改候选、改 UI（同样四处）。
    **列是无限的，而它们是按列硬编码的四份** —— 这就是代码混乱的来源。

    现在列的 defKey 声明在列注册表里（core.LIST_COLUMNS），
    取用一律走 defsOf(store, field)。加一列 = 注册表加一项，类型不用动。

    defKey 与列的对应关系：
      tag → tags 列，type → type 列，group → group 列，assignee → assignee 列

    ⚠️ 老文件里是四个平级字段，读盘时由 mergeLegacyDefs 迁移进来
    （新格式优先，不会被老字段冲掉）。
  */
  defs: Record<string, TagDef[]>;
  /** 流程配置：自定义状态 / 流转 / 边的文案。缺省为默认那套 */
  flow: TaskFlow;
}

/** 一个状态的定义 */
export interface StatusDef {
  id: string;
  name: string;
  color: string;
  /** 进入这个状态的按钮文案（"认领"/"开始"…） */
  enter: string;
  /** 算不算"完成"（依赖解锁与陈旧判定都看它） */
  done: boolean;
}

/** 流程配置。transitions 双端都认；edges 只影响界面 */
export interface TaskFlow {
  statuses: StatusDef[];
  transitions: Record<string, string[]>;
  edges: Record<string, { label: string; note: boolean }>;
}

/** 一个项目 = 一份独立任务库 + 自己的文档路径 */
export interface TbProject {
  id: string;
  name: string;
  /** 该项目的 tasks.json 所在目录（绝对路径），项目之间互相独立 */
  dataDir: string;
  /**
   * 该项目的文档路径（绝对路径）。'' = 还没设。
   * 改这里时文档会被**整体搬过去**（旧位置不留），不是复制。
   */
  docsDir: string;
}

export interface TbConfig {
  /** 项目列表。至少一项（老配置迁移后是"默认项目"） */
  projects: TbProject[];
  /** 当前项目 id */
  currentId: string;
  /**
   * 当前项目的 tasks.json 目录 —— **派生**自 projects[currentId]。
   * 存它是因为全仓调用点都写 cfg.dataDir；由 normalizeConfig 双向同步，
   * 改它等于改当前项目的 dataDir。
   */
  dataDir: string;
  /** 当前项目的文档路径 —— 同样是派生字段 */
  docsDir: string;
  /** 本地 HTTP API 端口 */
  port: number;
  /** 访问令牌（留空不校验） */
  token: string;
  /** 打开插件时自动启动 HTTP 服务 */
  autoStart: boolean;
  /** 任务提交审查时 POST 通知的目标（如 agent-flow webhook） */
  notifyUrl: string;
  /**
   * 流转到**哪个状态**时发通知。默认 'review'。
   *
   * ⛔ 原来这个判据写死在代码里（`to === 'review'`），
   * 自定义流程里"审查"那一步可能叫别的（'待审'、's4'…），
   * 于是配了 notifyUrl 却**永远收不到通知**，而且没有任何提示 ——
   * 用户只会在对端排查，想不到是这边压根没发。
   *
   * 做成配置而不是猜状态名：猜（匹配"审查"字样）对"复核""验收"就失效了。
   */
  notifyStatus: string;
}

export const DEFAULT_CONFIG: TbConfig = {
  projects: [{ id: 'p1', name: '默认项目', dataDir: '', docsDir: '' }],
  currentId: 'p1',
  dataDir: '',
  docsDir: '',
  port: 9911,
  token: '',
  autoStart: false,
  notifyUrl: '',
  notifyStatus: 'review',
};

/** 一次状态流转的展示信息 */
export interface Transition {
  to: TaskStatus;
  label: string;
  /** 需要填备注（打回时必须写原因） */
  needNote?: boolean;
}
