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
};

export const CLI_META: Record<CliKind, { label: string; cmd: string; color: string }> = {
  traecli:   { label: 'TraeCode CLI', cmd: 'traecli',  color: '#f97316' },
  codebuddy: { label: 'WorkBuddy CLI', cmd: 'codebuddy', color: '#22c55e' },
};


/* ------------------------------------------------------------------ */
/* 条件分支节点                                                        */
/* ------------------------------------------------------------------ */

/** 画布上的节点种类：任务 / 条件分支 / 触发器 / 并发控制 */
export type NodeKind = 'task' | 'condition' | 'trigger' | 'parallel';

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
  | ParallelNodeData;

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
  /** 触发器类型 */
  trigger: TriggerKind;
  config: TriggerConfig;
  /** 触发时注入的全局输入 */
  input: string;
  enabled: boolean;
  status: NodeStatus;
  output: string;
  error: string;
  lastFiredAt: number | null;
};

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
  trigger: TriggerKind,
  partial: Partial<TriggerNodeData> = {},
): GraphNode {
  return {
    id,
    data: {
      kind: 'trigger',
      label: partial.label ?? (TRIGGER_META[trigger]?.label ?? '触发器'),
      trigger,
      config: partial.config ?? { ...DEFAULT_TRIGGER_CONFIG },
      input: partial.input ?? '',
      enabled: partial.enabled ?? true,
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
      lastFiredAt: partial.lastFiredAt ?? null,
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
  id: string;
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
