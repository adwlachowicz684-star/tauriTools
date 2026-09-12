export type CliKind = 'traecli' | 'codebuddy';

/** 节点运行状态机 */
export type NodeStatus =
  | 'idle'      // 未运行
  | 'pending'   // 已排入本轮，等待上游
  | 'running'   // CLI 进程执行中
  | 'success'
  | 'failed'
  | 'skipped';  // 上游失败导致跳过

export type TaskNodeData = {
  label: string;
  cli: CliKind;
  /** 节点内编辑的提示词，支持 {{nodeId.output}} 引用上游输出 */
  prompt: string;
  model: string;
  workdir: string;
  /** 是否自动批准工具调用（traecli -y / codebuddy -y） */
  yolo: boolean;
  status: NodeStatus;
  output: string;
  error: string;
};

export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphNode = {
  id: string;
  data: NodeData;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  /**
   * 条件节点出边专属：标注这条边属于哪个分支。
   * - 值为某条 ConditionRule 的 id → 该规则命中时走这条边
   * - '__default__' → 兜底分支（所有规则都没命中时走）
   * - undefined → 普通边，无条件
   */
  branch?: string;
  /**
   * 循环节点出边专属：标注这条边是"循环体"还是"循环结束"。
   * - 'body' → 每轮迭代都执行的部分（默认，未标注时按 body 处理）
   * - 'done' → 全部迭代完成后才执行一次
   * - undefined → 非循环节点的普通边
   */
  loopRole?: 'body' | 'done';
};

export const CLI_META: Record<CliKind, { label: string; cmd: string; color: string }> = {
  traecli:   { label: 'TraeCode CLI', cmd: 'traecli',  color: '#f97316' },
  codebuddy: { label: 'WorkBuddy CLI', cmd: 'codebuddy', color: '#22c55e' },
};


/* ------------------------------------------------------------------ */
/* 条件分支节点                                                        */
/* ------------------------------------------------------------------ */

/** 画布上的节点种类：任务 / 条件分支 / 触发器 / 并发控制 / 循环 / 文件操作 */
export type NodeKind =
  | 'task' | 'condition' | 'trigger' | 'parallel' | 'loop' | 'fs';

export const DEFAULT_BRANCH = '__default__';

/** 条件判断方式 */
export type ConditionOp =
  | 'contains'      // 包含文本
  | 'notContains'   // 不包含文本
  | 'equals'        // 完全相等（去首尾空白后）
  | 'notEquals'
  | 'startsWith'
  | 'regex'         // 正则匹配（非法正则视为不匹配，并在界面报错）
  | 'nonEmpty'      // 非空
  | 'isEmpty'
  | 'always';       // 恒真，用作兜底/保底分支

export type ConditionRule = {
  id: string;
  /** 界面上显示的分支名 */
  label: string;
  op: ConditionOp;
  /** 比较值；nonEmpty / isEmpty / always 不需要 */
  value: string;
  /**
   * 判定哪个来源的文本：
   * - 某上游节点 id
   * - 'input' 表示全局输入
   * - 空字符串表示拼接全部上游输出
   */
  source: string;
};

export type ConditionNodeData = {
  kind: 'condition';
  label: string;
  /** 从上到下依次判定，命中第一条即走对应分支 */
  rules: ConditionRule[];
  /** 是否启用兜底分支（所有规则都未命中时走 __default__ 边） */
  defaultBranch: boolean;
  status: NodeStatus;
  output: string;
  error: string;
};

export type NodeData =
  | TaskNodeData
  | ConditionNodeData
  | TriggerNodeData
  | ParallelNodeData
  | LoopNodeData
  | FsNodeData;

export const OP_META: Record<ConditionOp, { label: string; needsValue: boolean }> = {
  contains:    { label: '包含',       needsValue: true },
  notContains: { label: '不包含',     needsValue: true },
  equals:      { label: '等于',       needsValue: true },
  notEquals:   { label: '不等于',     needsValue: true },
  startsWith:  { label: '开头是',     needsValue: true },
  regex:       { label: '正则匹配',   needsValue: true },
  nonEmpty:    { label: '非空',       needsValue: false },
  isEmpty:     { label: '为空',       needsValue: false },
  always:      { label: '总是',       needsValue: false },
};

let ruleSeq = 0;

export function makeRule(partial: Partial<ConditionRule> = {}): ConditionRule {
  ruleSeq += 1;
  return {
    id: partial.id ?? `r${ruleSeq}`,
    label: partial.label ?? '分支',
    op: partial.op ?? 'contains',
    value: partial.value ?? '',
    source: partial.source ?? '',
  };
}

export function makeConditionNode(id: string, partial: Partial<ConditionNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'condition',
      label: partial.label ?? '条件判断',
      rules: partial.rules ?? [makeRule({ label: '是', op: 'contains', value: '' })],
      defaultBranch: partial.defaultBranch ?? true,
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}


/* ------------------------------------------------------------------ */
/* 触发器节点（画在画布上的触发器）                                     */
/* ------------------------------------------------------------------ */

export type TriggerNodeData = {
  kind: 'trigger';
  label: string;
  /**
   * 触发方式 —— 可多选，同一节点上可以同时挂好几种。
   * 比如同时「周期 + 监听」：定时兜底，改文件立刻跑。
   *
   * 五种方式共用同一个 config，各取所需字段，互不冲突。
   */
  triggers: TriggerKind[];
  /**
   * 旧版单值字段，仅为兼容历史数据保留。
   * 读取一律走 triggerKindsOf()，不要直接用它。
   */
  trigger?: TriggerKind;
  config: TriggerConfig;
  /** 触发时注入的全局输入 */
  input: string;
  enabled: boolean;
  status: NodeStatus;
  output: string;
  error: string;
  lastFiredAt: number | null;
  /** 最近一次是哪个方式触发的；配合 lastFiredAt 展示 */
  lastFiredKind?: TriggerKind | null;
};

/**
 * 取出节点的触发方式列表，兼容旧的单值字段。
 *
 * 历史数据只有 trigger 没有 triggers —— 用它兜住，
 * 这样老画布打开后不会变成"一个都没选"而彻底不触发。
 */
export function triggerKindsOf(d: Pick<TriggerNodeData, 'triggers' | 'trigger'>): TriggerKind[] {
  const raw = (d as TriggerNodeData).triggers;
  if (Array.isArray(raw) && raw.length > 0) return raw;
  const legacy = (d as TriggerNodeData).trigger;
  if (legacy) return [legacy];
  return ['manual'];
}

/* ------------------------------------------------------------------ */
/* 并发节点                                                            */
/* ------------------------------------------------------------------ */

/** 并发度怎么定 */
export type ParallelMode =
  | 'fixed'       // 固定并发数
  | 'byRule'      // 按条件规则决定（从上到下第一条命中）
  | 'all';        // 不限制，全部并行

export type ParallelRule = {
  id: string;
  op: ConditionOp;
  value: string;
  /** 命中时的并发数 */
  concurrency: number;
  label?: string;
};

export type ParallelNodeData = {
  kind: 'parallel';
  label: string;
  mode: ParallelMode;
  /** fixed 模式下的并发数 */
  concurrency: number;
  /** byRule 模式下的规则 */
  rules: ParallelRule[];
  /** 未命中任何规则时的兜底并发数 */
  fallbackConcurrency: number;
  status: NodeStatus;
  output: string;
  error: string;
};

export function isTrigger(d: NodeData): d is TriggerNodeData {
  return (d as TriggerNodeData).kind === 'trigger';
}

export function isParallel(d: NodeData): d is ParallelNodeData {
  return (d as ParallelNodeData).kind === 'parallel';
}

export function makeTriggerNode(
  id: string,
  /**
   * 可传单个或多个。传 'manual' 与 ['manual'] 等价。
   * 保留单值入参是为了兼容既有调用点。
   */
  triggers: TriggerKind | TriggerKind[],
  partial: Partial<TriggerNodeData> = {},
): GraphNode {
  const list = Array.isArray(triggers) ? triggers : [triggers];
  return {
    id,
    data: {
      kind: 'trigger',
      label: partial.label ?? '触发器',
      triggers: list,
      config: partial.config ?? { ...DEFAULT_TRIGGER_CONFIG },
      input: partial.input ?? '',
      enabled: partial.enabled ?? true,
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
      lastFiredAt: partial.lastFiredAt ?? null,
      lastFiredKind: partial.lastFiredKind ?? null,
    },
  };
}

let prSeq = 0;
export function makeParallelRule(partial: Partial<ParallelRule> = {}): ParallelRule {
  prSeq += 1;
  return {
    id: partial.id ?? `pr${prSeq}`,
    op: partial.op ?? 'contains',
    value: partial.value ?? '',
    concurrency: partial.concurrency ?? 2,
    label: partial.label,
  };
}

export function makeParallelNode(id: string, partial: Partial<ParallelNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'parallel',
      label: partial.label ?? '并发控制',
      mode: partial.mode ?? 'fixed',
      concurrency: partial.concurrency ?? 2,
      rules: partial.rules ?? [],
      fallbackConcurrency: partial.fallbackConcurrency ?? 1,
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

/* ------------------------------------------------------------------ */
/* 循环节点                                                            */
/* ------------------------------------------------------------------ */

/** 迭代项从哪来 */
export type LoopMode =
  | 'times'   // 固定次数
  | 'list'    // 把上游输出按分隔符切成列表
  | 'glob';   // 文件通配符展开（配合文件节点用）

/** 循环体内某轮失败时的处理 */
export type LoopOnError = 'continue' | 'stop';

export type LoopNodeData = {
  kind: 'loop';
  label: string;
  mode: LoopMode;
  /** times: 迭代次数（1-1000） */
  times: number;
  /** list: 分隔符，支持 \n / , / ; / 自定义字符串 */
  separator: string;
  /** 取哪个上游的输出作为来源；空字符串表示拼接全部上游 */
  source: string;
  /** glob: 通配符，如 /tmp/**\/*.ts */
  pattern: string;
  /** 安全上限，超过则截断并在界面提示 */
  maxIterations: number;
  onError: LoopOnError;
  /** 是否把每轮输出收集进本节点 output（关掉可省内存） */
  collect: boolean;
  status: NodeStatus;
  output: string;
  error: string;
};

/** 循环体内可通过模板拿到的迭代上下文 */
export type LoopCtx = {
  /** 当前项文本 */
  item: string;
  /** 当前下标，从 0 开始 */
  index: number;
  /** 总轮数 */
  count: number;
};

export const LOOP_MODE_META: Record<LoopMode, { label: string; hint: string }> = {
  times: { label: '固定次数', hint: '重复执行 N 次，与上游内容无关' },
  list:  { label: '遍历列表', hint: '把上游输出按分隔符切成多项，逐项执行' },
  glob:  { label: '匹配文件', hint: '按通配符展开文件路径，逐文件执行' },
};

export const MAX_LOOP_ITERATIONS = 1000;

export function isLoop(d: NodeData): d is LoopNodeData {
  return (d as LoopNodeData).kind === 'loop';
}

export function makeLoopNode(id: string, partial: Partial<LoopNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'loop',
      label: partial.label ?? '循环',
      mode: partial.mode ?? 'list',
      times: partial.times ?? 3,
      separator: partial.separator ?? '\n',
      source: partial.source ?? '',
      pattern: partial.pattern ?? '',
      maxIterations: partial.maxIterations ?? 50,
      onError: partial.onError ?? 'continue',
      collect: partial.collect ?? true,
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}


/* ------------------------------------------------------------------ */
/* 文件 / 文件夹操作节点                                                */
/* ------------------------------------------------------------------ */

export type FsOp =
  | 'read'     // 读文件全文
  | 'write'    // 写文件（覆盖）
  | 'append'   // 追加到文件末尾
  | 'copy'     // 复制文件或目录
  | 'move'     // 移动 / 重命名
  | 'delete'   // 删除文件或目录
  | 'list'     // 列出目录条目
  | 'mkdir'    // 创建目录
  | 'exists'   // 是否存在
  | 'stat';    // 大小 / 修改时间等元信息

export type FsNodeData = {
  kind: 'fs';
  label: string;
  op: FsOp;
  /** 主路径，支持 {{模板变量}} */
  path: string;
  /** copy / move 的目标路径 */
  target: string;
  /** write / append 的内容，支持 {{模板变量}} */
  content: string;
  /** list: 是否递归 */
  recursive: boolean;
  /** delete: 是否允许删非空目录 */
  force: boolean;
  /** 只打印将执行的操作，不真正改动磁盘 */
  dryRun: boolean;
  /** read 最大字节数，超出截断 */
  maxBytes: number;
  /** list: 文件名过滤后缀，空数组表示全部 */
  exts: string[];
  status: NodeStatus;
  output: string;
  error: string;
};

export const FS_OP_META: Record<FsOp, {
  label: string;
  hint: string;
  needsTarget: boolean;
  needsContent: boolean;
  /** 会改动磁盘的操作，界面上标红提醒 */
  destructive: boolean;
}> = {
  read:   { label: '读文件',   hint: '读取文本文件内容',                 needsTarget: false, needsContent: false, destructive: false },
  write:  { label: '写文件',   hint: '写入内容，已存在则覆盖',           needsTarget: false, needsContent: true,  destructive: true  },
  append: { label: '追加内容', hint: '在文件末尾追加',                   needsTarget: false, needsContent: true,  destructive: true  },
  copy:   { label: '复制',     hint: '复制文件或整个目录',               needsTarget: true,  needsContent: false, destructive: true  },
  move:   { label: '移动',     hint: '移动或重命名',                     needsTarget: true,  needsContent: false, destructive: true  },
  delete: { label: '删除',     hint: '删除文件或目录',                   needsTarget: false, needsContent: false, destructive: true  },
  list:   { label: '列目录',   hint: '列出目录下的条目',                 needsTarget: false, needsContent: false, destructive: false },
  mkdir:  { label: '建目录',   hint: '创建目录（含父级）',               needsTarget: false, needsContent: false, destructive: true  },
  exists: { label: '判断存在', hint: '返回 true / false',                needsTarget: false, needsContent: false, destructive: false },
  stat:   { label: '查看信息', hint: '大小、类型、修改时间',             needsTarget: false, needsContent: false, destructive: false },
};

/** 这些路径绝不允许被删除——误删根目录或系统目录代价太大 */
export const FS_FORBIDDEN: string[] = [
  '/', '/etc', '/usr', '/bin', '/sbin', '/var', '/system', '/windows',
  'C:\\', 'C:\\Windows', 'C:\\Windows\\System32',
];

export function isFs(d: NodeData): d is FsNodeData {
  return (d as FsNodeData).kind === 'fs';
}

export function makeFsNode(id: string, partial: Partial<FsNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'fs',
      label: partial.label ?? '文件操作',
      op: partial.op ?? 'read',
      path: partial.path ?? '',
      target: partial.target ?? '',
      content: partial.content ?? '',
      recursive: partial.recursive ?? false,
      force: partial.force ?? false,
      dryRun: partial.dryRun ?? false,
      maxBytes: partial.maxBytes ?? 1_000_000,
      exts: partial.exts ?? [],
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

export function isCondition(d: NodeData): d is ConditionNodeData {
  return (d as ConditionNodeData).kind === 'condition';
}

export function makeNode(id: string, partial: Partial<TaskNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      label: partial.label ?? '新任务',
      cli: partial.cli ?? 'codebuddy',
      prompt: partial.prompt ?? '',
      model: partial.model ?? '',
      workdir: partial.workdir ?? '',
      yolo: partial.yolo ?? true,
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

/* ------------------------------------------------------------------ */
/* 触发器                                                              */
/* ------------------------------------------------------------------ */

export type TriggerKind = 'manual' | 'interval' | 'cron' | 'watch' | 'webhook';

/** 各类触发器的配置，按 kind 取用对应字段；未用到的字段留默认值即可 */
export type TriggerConfig = {
  /** interval: 间隔秒数，最小 10 */
  intervalSec: number;
  /** cron: 五段表达式，如 `0 9 * * 1-5`（分 时 日 月 周） */
  cronExpr: string;
  /** watch: 监听目录（绝对路径） */
  watchDir: string;
  /** watch: 只关心这些后缀，空数组表示全部 */
  watchExts: string[];
  /** watch: 防抖毫秒，事件合并窗口 */
  debounceMs: number;
  /** watch: 是否递归监听子目录 */
  watchRecursive: boolean;
  /** webhook: 监听端口 */
  port: number;
  /** webhook: 路径，如 /hooks/run */
  path: string;
  /** webhook: 可选的校验 token，校验 X-Token 或 Authorization: Bearer */
  token: string;
  /** webhook: 是否把请求体注入 {{input}} */
  payloadToInput: boolean;
};

export type Trigger = {
  /** 展开后的唯一标识：多选时形如 `${nodeId}:${kind}` */
  id: string;
  /**
   * 所属画布节点 id。
   * 一个节点可挂多种触发方式，会展开成多条 Trigger，
   * 调度器用 id 区分它们，而回写节点状态时要用它找回节点。
   */
  nodeId?: string;
  name: string;
  kind: TriggerKind;
  enabled: boolean;
  config: TriggerConfig;
  /** 触发时注入的全局输入，支持 {{input}} 之外还可写固定文本 */
  input: string;
  /** 上次触发时间（毫秒时间戳），仅用于界面展示 */
  lastFiredAt: number | null;
  /** 上次触发结果 */
  lastResult: 'success' | 'failed' | null;
};

export const TRIGGER_META: Record<TriggerKind, { label: string; hint: string; icon: string }> = {
  manual:   { label: '手动触发',   hint: '点击后立即执行一次工作流',                 icon: '▶' },
  interval: { label: '周期触发',   hint: '每隔固定秒数自动执行',                     icon: '⟳' },
  cron:     { label: '定时触发',   hint: '按 cron 表达式在指定时刻执行',             icon: '⏰' },
  watch:    { label: '监听触发',   hint: '监听目录内文件变化后执行（带防抖）',       icon: '👁' },
  webhook:  { label: '调用触发',   hint: '本地起 HTTP 服务，外部调用 URL 即触发',   icon: '🔗' },
};

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  intervalSec: 300,
  cronExpr: '0 9 * * 1-5',
  watchDir: '',
  watchExts: [],
  debounceMs: 2000,
  watchRecursive: true,
  port: 8787,
  path: '/hooks/run',
  token: '',
  payloadToInput: true,
};

let triggerSeq = 0;

export function makeTrigger(kind: TriggerKind, partial: Partial<Trigger> = {}): Trigger {
  triggerSeq += 1;
  return {
    id: partial.id ?? `trg${Date.now().toString(36)}${triggerSeq}`,
    name: partial.name ?? TRIGGER_META[kind].label,
    kind,
    enabled: partial.enabled ?? true,
    config: { ...DEFAULT_TRIGGER_CONFIG, ...(partial.config ?? {}) },
    input: partial.input ?? '',
    lastFiredAt: partial.lastFiredAt ?? null,
    lastResult: partial.lastResult ?? null,
  };
}
