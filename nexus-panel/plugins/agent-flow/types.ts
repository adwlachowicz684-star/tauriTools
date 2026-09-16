import type { NodeParam } from './engine/params';
import type { LlmConfig } from './engine/llm';

export type CliKind = 'traecli' | 'codebuddy';

/** 节点运行状态机 */
export type NodeStatus =
  | 'idle'      // 未运行
  | 'pending'   // 已排入本轮，等待上游
  | 'running'   // CLI 进程执行中
  | 'success'
  | 'failed'
  | 'skipped';  // 上游失败导致跳过

/** 文件参数的产出方式 */
export type FileOutputMode = 'auto' | 'manual';

/**
 * 文件参数配置。
 *
 * auto：从 CLI 输出文本里识别路径（尽力而为，可能识别不全或混入噪声）
 * manual：识别不准时改为手动指定，路径一行一个
 */
export type TaskFileOutput = {
  /** 关闭后不再产出文件字段 */
  enabled: boolean;
  mode: FileOutputMode;
  /** manual 模式的路径列表，换行分隔 */
  manualPaths: string;
};

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

  /* ---------- 输出参数（新增） ---------- */
  /**
   * 文件参数。把"改了哪些文件"暴露给下游：
   * {{id.file}} {{id.files}} {{id.fileName}} 等。
   * 省略时按默认值处理（启用 + 自动识别）。
   */
  fileOutput?: TaskFileOutput;
  /** 自定义参数，下游用 {{id.参数名}} 引用 */
  params?: NodeParam[];
  /**
   * 上次运行时识别到的文件（回写字段，不需要用户配置）。
   * 存下来是为了让面板能显示上一次的结果，排查时不必重跑。
   */
  lastFiles?: string[];
};

/** 文件参数的默认配置 */
export function defaultFileOutput(): TaskFileOutput {
  return { enabled: true, mode: 'auto', manualPaths: '' };
}

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
  | 'task' | 'condition' | 'trigger' | 'parallel' | 'loop' | 'fs' | 'update';

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

/**
 * 一条原子条件。
 *
 * 规则（ConditionRule）可以包含多条 ConditionItem，用 AND / OR 组合。
 * 拆成独立对象后，每条都能单独开关 —— 调试时临时停掉一条条件，
 * 比删掉再重建省事得多。
 */
export type ConditionItem = {
  id: string;
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
  /** 关闭后这条条件不参与组合。默认视为启用（undefined 即启用） */
  enabled?: boolean;
};

/** 多条条件之间的组合方式 */
export type ConditionLogic = 'and' | 'or';

export const LOGIC_META: Record<ConditionLogic, {
  label: string;
  short: string;
  hint: string;
  color: string;
}> = {
  and: {
    label: '同时满足',
    short: 'AND',
    hint: '所有启用的条件都为真，这条规则才命中',
    color: '#06b6d4',
  },
  or: {
    label: '任一满足',
    short: 'OR',
    hint: '任意一个启用的条件为真，这条规则就命中',
    color: '#a855f7',
  },
};

export type ConditionRule = {
  id: string;
  /** 界面上显示的分支名 */
  label: string;

  /* ---------- 单条件字段（保证旧数据兼容） ---------- */
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

  /* ---------- 多条件（新增） ---------- */
  /**
   * 多条条件。存在且非空时以此为准；否则回退到 op/value/source 单条件。
   *
   * 之所以不直接把 op/value/source 换成数组：老画布已经存了大量单条件规则，
   * 迁移成本高于收益。归一化交给 ruleConditions() 处理。
   */
  conditions?: ConditionItem[];
  /** 条件间的组合方式，默认 and */
  logic?: ConditionLogic;
  /**
   * 规则开关。关闭后整条规则不参与判定（等同于不存在，会继续看下一条）。
   * undefined 视为启用。
   */
  enabled?: boolean;
};

/**
 * 归一化取一条规则的条件列表。
 *
 * 无论数据是新版多条件还是老版单条件，都返回统一结构，
 * 判定与界面渲染都只认这个结果 —— 避免两处各写一套兼容逻辑而悄悄分叉。
 */
export function ruleConditions(rule: ConditionRule): ConditionItem[] {
  if (rule.conditions && rule.conditions.length > 0) return rule.conditions;
  return [{
    id: `${rule.id}:0`,
    op: rule.op,
    value: rule.value ?? '',
    source: rule.source ?? '',
    enabled: true,
  }];
}

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
  | GenericHttpNodeData
  | ExtractNodeData
  | ConditionNodeData
  | TriggerNodeData
  | ParallelNodeData
  | LoopNodeData
  | FsNodeData
  | UpdateNodeData
  | OcrNodeData
  | TranslateNodeData
  | GithubUpdateNodeData
  | GithubPushNodeData;

/** 算子分类，用于面板里分组展示 */
export type OpCategory = 'text' | 'empty' | 'flow';

export const OP_CATEGORY_META: Record<OpCategory, { label: string; hint: string }> = {
  text:  { label: '文本比对', hint: '拿一段文本和给定值做比较' },
  empty: { label: '空值判断', hint: '只看文本是否为空，不需要比较值' },
  flow:  { label: '流程控制', hint: '不比对内容，直接决定走向' },
};

/**
 * 算子元信息。
 *
 * hint 写的是"精确语义"而不是泛泛而谈 —— 好几个算子有反直觉行为
 * （比较值为空时 contains 恒为真、equals 会先 trim），
 * 这些必须在界面上告诉用户，否则配出来的规则和自己想的不一样。
 */
export const OP_META: Record<ConditionOp, {
  label: string;
  needsValue: boolean;
  /** 单字符/双字符图标，面板与节点卡片共用 */
  icon: string;
  /** 精确语义，hover 与说明区显示 */
  hint: string;
  /** 展示用示例，形如「输出 包含 "error"」 */
  example: string;
  category: OpCategory;
  /** 算子配色，随分类走 */
  color: string;
}> = {
  contains: {
    label: '包含', needsValue: true, icon: '⊇', category: 'text', color: '#4c8dff',
    hint: '文本中能找到这个值即命中。注意：比较值留空时恒为真',
    example: '输出 包含 "error"',
  },
  notContains: {
    label: '不包含', needsValue: true, icon: '⊉', category: 'text', color: '#4c8dff',
    hint: '文本中找不到这个值才命中。注意：比较值留空时恒为真',
    example: '输出 不包含 "警告"',
  },
  equals: {
    label: '等于', needsValue: true, icon: '=', category: 'text', color: '#06b6d4',
    hint: '两端都去掉首尾空格后完全相同，区分大小写',
    example: '输出 等于 "true"',
  },
  notEquals: {
    label: '不等于', needsValue: true, icon: '≠', category: 'text', color: '#06b6d4',
    hint: '去掉首尾空格后不相同，区分大小写',
    example: '输出 不等于 "false"',
  },
  startsWith: {
    label: '开头是', needsValue: true, icon: '↦', category: 'text', color: '#818cf8',
    hint: '文本开头（已去首部空格）等于该值，区分大小写',
    example: '输出 开头是 "OK"',
  },
  regex: {
    label: '正则匹配', needsValue: true, icon: '.*', category: 'text', color: '#a855f7',
    hint: '用 JS 正则匹配，如 ^err.*。正则写错只会跳过这条规则，不会中断流程',
    example: '输出 匹配正则 "^ERR\d+"',
  },
  nonEmpty: {
    label: '非空', needsValue: false, icon: '●', category: 'empty', color: '#f59e0b',
    hint: '文本去掉首尾空格后仍有内容',
    example: '输出 非空',
  },
  isEmpty: {
    label: '为空', needsValue: false, icon: '○', category: 'empty', color: '#f59e0b',
    hint: '文本为空，或只有空格换行',
    example: '输出 为空',
  },
  always: {
    label: '总是', needsValue: false, icon: '✓', category: 'flow', color: '#22c55e',
    hint: '无条件命中。放在最后一条可当作兜底，或用于强制走某分支',
    example: '总是走这条分支',
  },
};

/** 按分类列出算子，供面板分组渲染 */
export function opsByCategory(): Array<{ category: OpCategory; ops: ConditionOp[] }> {
  const all = Object.keys(OP_META) as ConditionOp[];
  return (Object.keys(OP_CATEGORY_META) as OpCategory[]).map((c) => ({
    category: c,
    ops: all.filter((op) => OP_META[op].category === c),
  }));
}

let ruleSeq = 0;

export function makeRule(partial: Partial<ConditionRule> = {}): ConditionRule {
  ruleSeq += 1;
  return {
    id: partial.id ?? `r${ruleSeq}`,
    label: partial.label ?? '分支',
    op: partial.op ?? 'contains',
    value: partial.value ?? '',
    source: partial.source ?? '',
    // 不默认生成 conditions：单条件就够用时保持数据最简，
    // 需要多条件时由 UI 调 addCondition() 展开
    conditions: partial.conditions,
    logic: partial.logic ?? 'and',
    enabled: partial.enabled ?? true,
  };
}

/** 新建一条原子条件 */
let condSeq = 0;
export function makeCondition(partial: Partial<ConditionItem> = {}): ConditionItem {
  condSeq += 1;
  return {
    id: partial.id ?? `c${condSeq}_${Date.now().toString(36)}`,
    op: partial.op ?? 'contains',
    value: partial.value ?? '',
    source: partial.source ?? '',
    enabled: partial.enabled ?? true,
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

/* ------------------------------------------------------------------ */
/* 通用 HTTP 请求节点（参数型：填参数即可调任意接口，不用写代码）     */
/* ------------------------------------------------------------------ */

/** 请求方法。只列常用的，够用即止 —— 列全了反而不好选 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export type GenericHttpNodeData = {
  kind: 'generic-http';
  label: string;
  /** 请求地址，支持 {{模板变量}} */
  url: string;
  method: HttpMethod;
  /**
   * 请求头，每行一条 `Name: value`，支持 {{模板变量}}。
   * 用文本域而不是键值对编辑器：后者在面板里要占很多行，
   * 而多数请求只有 1~3 个头。
   */
  headersText: string;
  /** 请求体，仅 POST/PUT/PATCH 用；支持 {{模板变量}} */
  body: string;
  /** 请求体按 JSON 发送时自动补 Content-Type */
  bodyIsJson: boolean;
  timeoutSec: number;
  /** 响应最大字节数，防止一个异常大的响应把面板拖垮 */
  maxBytesKb: number;
  /** 从凭据库取令牌，自动加 Authorization: Bearer <token> */
  credentialId: string;
  /** 4xx/5xx 是否算节点失败。关掉则把错误响应也当正常输出，交给下游判断 */
  failOnHttpError: boolean;
};

/* ------------------------------------------------------------------ */
/* 数据提取节点（把上游一大段文本裁成下游能用的值）                    */
/* ------------------------------------------------------------------ */

export type ExtractMode = 'json' | 'regex' | 'line' | 'text';

export const EXTRACT_MODE_META: Record<ExtractMode, { label: string; spec: string; hint: string }> = {
  json: {
    label: 'JSON 路径',
    spec: '路径',
    hint: '如 data.items[0].title；也认 data.items.0.title 与 [0].title',
  },
  regex: {
    label: '正则表达式',
    spec: '正则',
    hint: '默认取第 1 个捕获组；没写捕获组则取整段匹配',
  },
  line: {
    label: '按行取',
    spec: '行规则',
    hint: 'first / last / 行号（0 起，负数倒数）/ 包含的文字',
  },
  text: {
    label: '原样输出',
    spec: '',
    hint: '不做处理，直接把上游文本传给下游',
  },
};

export type ExtractNodeData = {
  kind: 'extract';
  label: string;
  mode: ExtractMode;
  /** 各模式的参数：JSON 路径 / 正则 / 行规则 */
  spec: string;
  /** 正则模式下取第几个捕获组 */
  group: number;
  /** 提取失败时是否让节点失败。关掉则输出空串、流程继续 */
  failOnMiss: boolean;
  /** 去掉首尾空白 */
  trim: boolean;
};

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

/* ------------------------------------------------------------------ */
/* 更新检测节点（B站 UP 主 / 微信公众号）                               */
/*                                                                     */
/* 两种源共用一套数据结构：抓取 → 解析 → 与基线比对 → 输出 bool。      */
/* 差别只在"怎么抓"和"怎么解析"，由 source 字段区分。                  */
/* ------------------------------------------------------------------ */

export type UpdateSource = 'bilibili' | 'wechat';

/** B站 的抓取方式 */
export type BiliMode =
  | 'api'   // 官方投稿列表接口，可能被风控，需要 Cookie
  | 'rss';  // RSS（如 RSSHub），稳定但要自备服务

export type UpdateNodeData = {
  kind: 'update';
  source: UpdateSource;
  label: string;

  /* ---- B站 ---- */
  /** UID，或 space.bilibili.com 主页链接 */
  biliUid: string;
  biliMode: BiliMode;
  /**
   * 完整 Cookie 串，用于绕过风控。
   * 只填 SESSDATA 往往不够 —— B站 还会看 buvid3 / _uuid。
   * 直接把浏览器里复制的整条 Cookie 粘进来最省事。
   */
  biliCookie: string;

  /* ---- 公众号 ---- */
  /**
   * 订阅源地址（RSS/Atom）。
   * 公众号没有官方开放接口，必须用第三方桥接：
   * wechat2rss / RSSHub / Feeddd 等，把生成的订阅地址填到这里。
   */
  feedUrl: string;

  /* ---- 共用 ---- */
  /** 自定义 User-Agent。部分源会拒绝默认的非浏览器 UA */
  userAgent: string;
  /**
   * 首次运行（还没有基线）时算不算更新。
   * 默认 false：刚配好就触发一次下游通常是误报。
   */
  firstRunAsUpdate: boolean;
  /**
   * 输出格式：
   *  - bool   → 只输出 true / false，配合条件节点直接用
   *  - detail → 附带标题、链接、时间
   */
  outputFormat: 'bool' | 'detail';
  /** 请求超时秒数 */
  timeoutSec: number;

  /* ---- 运行时状态（随画布持久化，重启后仍记得基线） ---- */
  /** 上次见到的最新条目 id —— 判定"有无更新"的基线 */
  lastSeenId: string;
  lastSeenTitle: string;
  lastCheckedAt: number | null;
  /** 最近一次检查是否发现有更新，界面上直接显示 */
  lastUpdated: boolean | null;

  status: NodeStatus;
  output: string;
  error: string;
};

export const UPDATE_SOURCE_META: Record<UpdateSource, {
  label: string;
  hint: string;
  icon: string;
  color: string;
}> = {
  bilibili: {
    label: 'B站 UP 主',
    hint: '检测 UP 主是否有新投稿',
    icon: '📺',
    color: '#fb7299',
  },
  wechat: {
    label: '微信公众号',
    hint: '检测公众号是否有新推文（需第三方订阅源）',
    icon: '💬',
    color: '#07c160',
  },
};

export function isUpdate(d: NodeData): d is UpdateNodeData {
  return (d as UpdateNodeData).kind === 'update';
}

/** GitHub 拉取策略。默认顺序即兜底顺序 */
export type GithubStrategy = 'api' | 'atom' | 'cli';

/** 拉取：要不要走本地 git（cli 方案需要机器上有 git） */
export type GithubUpdateNodeData = {
  kind: 'github-update';
  label: string;
  owner: string;
  repo: string;
  /** 留空则用仓库默认分支 */
  branch: string;
  /** 本地 HEAD / 上次记录的 sha；留空表示只取远端状态 */
  base: string;
  /** 策略顺序，前面失败了自动换后面 */
  order: GithubStrategy[];
  /** 凭据 id；留空则用节点内联的 token */
  credentialId: string;
  /** 内联令牌（兼容旧画布；新配置请走凭据） */
  token: string;
  status: NodeStatus;
  output: string;
  error: string;
  /** 上次结果摘要，仅用于界面展示 */
  lastSha?: string;
  lastBranch?: string;
  lastVia?: string;
};

export type GithubPushNodeData = {
  kind: 'github-push';
  label: string;
  owner: string;
  repo: string;
  branch: string;
  /** 新建分支时基于此分支 */
  fromBranch: string;
  /** 提交信息，支持 {{上游.output}} */
  message: string;
  /** 要提交的文件，每行一条 `路径=内容来源`；内容来源支持模板 */
  filesText: string;
  /** cli 方案需要的本地仓库路径 */
  workdir: string;
  order: GithubStrategy[];
  credentialId: string;
  token: string;
  status: NodeStatus;
  output: string;
  error: string;
  lastCommit?: string;
  lastVia?: string;
};

export function isGithubUpdate(d: NodeData): d is GithubUpdateNodeData {
  return (d as GithubUpdateNodeData).kind === 'github-update';
}

export function isGithubPush(d: NodeData): d is GithubPushNodeData {
  return (d as GithubPushNodeData).kind === 'github-push';
}

export function makeGithubUpdateNode(
  id: string,
  partial: Partial<GithubUpdateNodeData> = {},
): GraphNode {
  return {
    id,
    data: {
      kind: 'github-update',
      label: partial.label ?? 'GitHub 更新',
      owner: partial.owner ?? '',
      repo: partial.repo ?? '',
      branch: partial.branch ?? '',
      base: partial.base ?? '',
      order: partial.order ?? ['api', 'atom', 'cli'],
      credentialId: partial.credentialId ?? '',
      token: partial.token ?? '',
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

export function makeGithubPushNode(
  id: string,
  partial: Partial<GithubPushNodeData> = {},
): GraphNode {
  return {
    id,
    data: {
      kind: 'github-push',
      label: partial.label ?? 'GitHub 推送',
      owner: partial.owner ?? '',
      repo: partial.repo ?? '',
      branch: partial.branch ?? 'main',
      fromBranch: partial.fromBranch ?? 'main',
      message: partial.message ?? 'chore: update via agent-flow',
      filesText: partial.filesText ?? '',
      workdir: partial.workdir ?? '',
      order: partial.order ?? ['api', 'cli'],
      credentialId: partial.credentialId ?? '',
      token: partial.token ?? '',
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

export function makeUpdateNode(
  id: string,
  source: UpdateSource,
  partial: Partial<UpdateNodeData> = {},
): GraphNode {
  return {
    id,
    data: {
      kind: 'update',
      source,
      label: partial.label ?? UPDATE_SOURCE_META[source].label,
      biliUid: partial.biliUid ?? '',
      biliMode: partial.biliMode ?? 'rss',
      biliCookie: partial.biliCookie ?? '',
      feedUrl: partial.feedUrl ?? '',
      userAgent: partial.userAgent ?? '',
      firstRunAsUpdate: partial.firstRunAsUpdate ?? false,
      outputFormat: partial.outputFormat ?? 'bool',
      timeoutSec: partial.timeoutSec ?? 15,
      lastSeenId: partial.lastSeenId ?? '',
      lastSeenTitle: partial.lastSeenTitle ?? '',
      lastCheckedAt: partial.lastCheckedAt ?? null,
      lastUpdated: partial.lastUpdated ?? null,
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

/* ================================================================== */
/* OCR / 翻译节点（调用大模型 API）                                    */
/* ================================================================== */

/** 图片来源：网络地址 / 本地文件 */
export type ImageSource = 'url' | 'file';

export const IMAGE_SOURCE_META: Record<ImageSource, { label: string; hint: string }> = {
  url:  { label: '网络地址', hint: '填 http(s) 图片地址，直接交给模型，不需要本地读取' },
  file: { label: '本地文件', hint: '读取本地图片转 base64 后发送。需要桌面端运行' },
};

export type OcrNodeData = {
  kind: 'ocr';
  label: string;
  /** 大模型配置（与翻译节点共用） */
  llm: LlmConfig;
  /** 凭据 id；留空则用 llm.apiKey 的内联值 */
  credentialId: string;
  imageSource: ImageSource;
  /** url 模式：图片地址；支持 {{上游.output}} */
  url: string;
  /** file 模式：本地路径 */
  path: string;
  /**
   * 识别要求。留空用默认提示。
   * 支持 {{上游.output}}，便于"先让 agent 说要识别哪张图"
   */
  prompt: string;
  /** 图片细节级别，影响 token 消耗 */
  detail: 'auto' | 'low' | 'high';
  status: NodeStatus;
  output: string;
  error: string;
  /** 上次识别出的字符数，仅用于界面展示 */
  lastChars?: number;
};

export type TranslateNodeData = {
  kind: 'translate';
  label: string;
  llm: LlmConfig;
  /** 凭据 id；留空则用 llm.apiKey 的内联值 */
  credentialId: string;
  /** 待翻译文本，支持 {{上游.output}} */
  text: string;
  /** 目标语言，可填预设 code 之外的任意说法 */
  targetLang: string;
  /** 源语言；auto 表示自动识别 */
  sourceLang: string;
  /** 术语表，每行一条，形如 "GPU=图形处理器" */
  glossary: string;
  status: NodeStatus;
  output: string;
  error: string;
  lastChars?: number;
};

export function isOcr(d: NodeData): d is OcrNodeData {
  return (d as OcrNodeData).kind === 'ocr';
}

export function isTranslate(d: NodeData): d is TranslateNodeData {
  return (d as TranslateNodeData).kind === 'translate';
}

export function makeOcrNode(id: string, partial: Partial<OcrNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'ocr',
      label: partial.label ?? '图片识别',
      llm: partial.llm ?? defaultLlmConfig(),
      imageSource: partial.imageSource ?? 'url',
      url: partial.url ?? '',
      path: partial.path ?? '',
      prompt: partial.prompt ?? defaultOcrPrompt(),
      detail: partial.detail ?? 'auto',
      credentialId: partial.credentialId ?? '',
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

export function makeTranslateNode(id: string, partial: Partial<TranslateNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'translate',
      label: partial.label ?? '翻译',
      llm: partial.llm ?? defaultLlmConfig(),
      text: partial.text ?? '',
      targetLang: partial.targetLang ?? 'zh',
      sourceLang: partial.sourceLang ?? 'auto',
      glossary: partial.glossary ?? '',
      credentialId: partial.credentialId ?? '',
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

/**
 * 节点里手填的 apiKey（区别于凭据中心里的凭据）怎么保存。
 *
 * device  —— 加密后存在本机，刷新后自动填回
 * session —— 只在内存里，关掉面板就没
 *
 * 两者的差别**不是**"安全 / 不安全"，而是"便利性 vs 落盘痕迹"：
 * device 只是把明文变成密文，属于抬成本；密钥派生的盐与本机特征都
 * 存在本机 / 是公开信息，拿到整个数据目录的人照样能复现钥匙
 * （见 engine/secretVault.ts 顶部）。要真挡住，用凭据中心 + 口令模式。
 */
export type SecretPolicy = 'device' | 'session';

/** 存策略的键。UI 与 App 共用同一个名字，免得两边各写一份字符串 */
export const SECRET_POLICY_KEY = 'agent-flow.secret-policy.v1';

export const SECRET_POLICY_META: Record<SecretPolicy, { label: string; hint: string }> = {
  device: {
    label: '存本机（加密）',
    hint: '加密后存在本机，刷新后自动填回。只是抬高偷看成本 —— 拿到整个数据目录的人仍能解开，'
      + '要真隔离请用凭据中心的口令模式',
  },
  session: {
    label: '仅本次会话',
    hint: '只留在内存里，关掉面板即清空，本机不留任何痕迹。代价是下次打开要重新填写',
  },
};

/** 默认识别提示：按原布局输出，不额外解释 */
export function defaultOcrPrompt(): string {
  return '识别图片中的所有文字，按原文的排列顺序输出。只输出识别到的文字本身，不要任何解释或描述。';
}

export function defaultLlmConfig(partial: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: partial.provider ?? 'openai',
    baseUrl: partial.baseUrl ?? '',
    model: partial.model ?? '',
    apiKey: partial.apiKey ?? '',
    timeoutSec: partial.timeoutSec ?? 60,
  };
}

export function isFs(d: NodeData): d is FsNodeData {
  return (d as FsNodeData).kind === 'fs';
}

export function makeGenericHttpNode(id: string, partial: Partial<GenericHttpNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'generic-http',
      label: partial.label ?? 'HTTP 请求',
      url: partial.url ?? '',
      method: partial.method ?? 'GET',
      headersText: partial.headersText ?? '',
      body: partial.body ?? '',
      bodyIsJson: partial.bodyIsJson ?? true,
      timeoutSec: partial.timeoutSec ?? 30,
      maxBytesKb: partial.maxBytesKb ?? 512,
      credentialId: partial.credentialId ?? '',
      failOnHttpError: partial.failOnHttpError ?? true,
    } as GenericHttpNodeData,
  };
}

export function makeExtractNode(id: string, partial: Partial<ExtractNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'extract',
      label: partial.label ?? '数据提取',
      mode: partial.mode ?? 'json',
      spec: partial.spec ?? '',
      group: partial.group ?? 1,
      failOnMiss: partial.failOnMiss ?? true,
      trim: partial.trim ?? true,
    } as ExtractNodeData,
  };
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

export type TriggerKind = 'manual' | 'interval' | 'cron' | 'watch' | 'webhook' | 'chat';

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

  /* ---- chat: 监听 AI 对话 ---- */
  /** 对话文件所在目录（绝对路径）。留空则用探测到的默认目录 */
  chatDir: string;
  /** 只关心这些后缀；留空时默认 jsonl */
  chatExts: string[];
  /** 关键词，一行一个；# 开头为注释 */
  chatKeywords: string;
  /** 匹配范围：只算用户说的，还是用户与 AI 都算 */
  chatScope: 'user' | 'both';
  /** 轮询间隔秒数，最小 2 */
  chatPollSec: number;
  /**
   * 命中后注入 {{input}} 的内容模板。
   * 支持 {{keyword}} {{role}} {{text}} {{excerpt}} {{file}} {{time}}
   */
  chatTemplate: string;
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
  chat:     { label: '对话触发',   hint: '监听 AI 对话，出现关键词时执行',          icon: '💬' },
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

  chatDir: '',
  chatExts: [],
  chatKeywords: '',
  chatScope: 'both',
  chatPollSec: 3,
  chatTemplate: '对话中出现「{{keyword}}」：\n{{excerpt}}',
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
