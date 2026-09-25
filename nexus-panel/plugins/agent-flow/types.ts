import type { NodeParam } from './engine/params';
import type { LlmConfig } from './engine/llm';
import type { VaultMode } from './engine/credentialStore';

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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  label: string;
  cli: CliKind;
  /** 节点内编辑的提示词，支持 {{nodeId.output}} 引用上游输出 */
  prompt: string;
  model: string;
  /**
   * 模型清单从哪条凭据来。
   *
   * 只作**清单来源**：模型名仍存在 model 上、运行时照旧读 model。
   * 之所以还要记这一条，是为了下次打开面板时下拉框还是那一家的清单 ——
   * 不记的话换过凭据后，选中的模型会"跳回第一项"，
   * 界面与节点上实际存的值就对不上了。
   */
  credentialId?: string;
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

/**
 * 节点显示尺寸（只影响高度，宽度保持不变）。
 *
 * 存在的理由：模块组合后画布上会有很多"内部细节不重要"的节点，
 * 全用同样的高度会把关键节点淹没。矮卡片只留标题行，
 * 一眼就能看出主干；高卡片给关键节点更多展示空间。
 */
export type NodeSize = 'sm' | 'md' | 'lg';

/*
 * 三档的叫法。
 *
 * 以前叫「矮 / 中 / 高」—— 那是**描述长相**，不是描述用途，
 * 于是选档时只能靠"看着高不高"猜，看不出该给哪类节点用哪档。
 *
 * 改成说信息量：简（只留标题）/ 标（标准）/ 详（展开更多）。
 * 单字是为了让三个按钮宽度一致、挤在面板顶部不换行。
 */
export const NODE_SIZE_META: Record<NodeSize, { label: string; hint: string }> = {
  sm: { label: '简', hint: '只留标题行 —— 次要节点、模块内部用这个' },
  md: { label: '标', hint: '标准（默认）—— 标题 + 主要参数' },
  lg: { label: '详', hint: '展开更多内容 —— 关键节点用这个' },
};

/** 缺省 / 非法值一律按 'md' 处理 —— 老存档没有这个字段 */
export function normalizeSize(v: unknown): NodeSize {
  return v === 'sm' || v === 'lg' ? v : 'md';
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
   * 两端接在哪个端口上。
   *
   * 参数连线全靠它区分"这根线供哪个参数"：
   * targetHandle 是 `arg:xxx`（填进目标节点的 xxx 参数），
   * sourceHandle 是 `out:xxx`（取自来源节点的 xxx 输出）。
   *
   * 流程连线也可能带（分支/循环要分左右口），所以放在公共类型里，
   * 不单独给参数连线开一个子类型 —— 开子类型后，
   * 凡是收 GraphEdge[] 的函数都要先做一次类型窄化，漏一处就是静默失效。
   */
  sourceHandle?: string | null;
  targetHandle?: string | null;
  /**
   * 边的种类，供 React Flow 选渲染组件。
   *
   * 'param' = 参数连线（画成紫虚线带箭头），其余按流程连线渲染。
   * 不加这个字段的话参数连线会画成普通流程线，两种线长得一样，
   * "这根是供参数还是走流程"就得靠猜。
   */
  type?: string;
  /**
   * 箭头。React Flow 见到它会自动生成对应的 `<marker>` 定义。
   *
   * 参数连线必须带：它回答的是"谁的值给谁用"，
   * 两端节点看着对等时，方向只能靠箭头说出来。
   *
   * 字段名与结构都对齐 React Flow 的 EdgeMarker，
   * 这里不 import 那个类型（types.ts 要能在纯 node 环境里跑）。
   *
   * `type` 只能取这两个字面量，**不能写 string**：
   * GraphEdge 会直接喂给 React Flow 的 addEdge()，而它的 EdgeMarker.type
   * 是 'arrow' | 'arrowclosed' | MarkerType。写成 string 就赋不进去
   * （TS2345）。不用 MarkerType 枚举是因为那要 import @xyflow/react，
   * 而这两个字符串正是枚举成员的值，稳定公开。
   */
  markerEnd?: { type: 'arrow' | 'arrowclosed'; color?: string; width?: number; height?: number };
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
  /**
   * 边的附加数据（React Flow 的边靠它带自定义信息）。
   *
   * 参数连线：`kind: 'param'` + `targetArg`（要填上游产出到哪个参数）。
   *
   * 判据放这里而不是 handle：handle 的对应关系在连线建好之后就固定了，
   * 而 data 是**唯一随边一起存档**的东西 —— 重新载入画布后还能认出
   * "这条是参数连线、给的是哪个参数"，靠的就是它。
   */
  data?: { kind?: string; targetArg?: string };
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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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
  | GithubPushNodeData
  /* ---- 工具节点 ---- */
  | WaitNodeData
  | LogNodeData
  | BeepNodeData
  | PlayAudioNodeData
  | ClockNodeData
  | ConstNodeData
  | ModuleNodeData
  | FrameNodeData
  /* ---- 控制器 ---- */
  | JoinNodeData
  | GateNodeData
  | ThrottleNodeData
  | TimeoutNodeData
  | RetryNodeData
  /* ---- 运算 ---- */
  | OpNodeData
  | VarNodeData
  | StopNodeData
  | AskNodeData
  /* ---- 表格 ---- */
  | TableReadNodeData
  | DeriveNodeData
  | FilterNodeData
  | AggNodeData
  /* ---- 跨画布 ---- */
  | CanvasRefNodeData
  | CanvasInNodeData
  | CanvasOutNodeData;

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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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
  if (Array.isArray(raw)) {
    /*
     * 必须**逐项校验**，不能只看 length > 0。
     *
     * 曾经 nodes/defs/trigger.ts 的 create 把数据补丁当成第二个参数
     * 传给 makeTriggerNode（那个参数是**触发方式**，不是补丁），
     * 于是 triggers 里存的是 undefined（落盘后变成 null），
     * 甚至整个数据对象。
     *
     * 那时 `raw.length > 0` 为真，直接原样返回 ——
     * 属性面板第 105 行的 `TRIGGER_META[selected[0]].hint`
     * 于是当场抛 TypeError，整棵 React 树崩掉，
     * 表现为「把触发器拖进画布后，画布整个消失」。
     *
     * 过滤掉不认识的项：宁可退回 manual，
     * 也不要把一个非法值交给渲染层。
     */
    const ok = raw.filter(
      (k): k is TriggerKind => typeof k === 'string' && k in TRIGGER_META,
    );
    if (ok.length > 0) return ok;
  }
  const legacy = (d as TriggerNodeData).trigger;
  if (typeof legacy === 'string' && legacy in TRIGGER_META) return [legacy as TriggerKind];
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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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

/*
 * 监听目标的种类。
 *
 * 一个「更新检测」节点可以同时盯多个目标（B站 + 小红书 + 某个仓库），
 * 所以种类是**目标**的属性，不再是节点的属性 ——
 * 节点上那个 `source` 字段只为了让老存档继续能读（见 targetsOf）。
 */
export type UpdateSource =
  | 'bilibili'
  | 'wechat'
  | 'xiaohongshu'
  | 'weibo'
  | 'zhihu'
  | 'douyin'
  | 'kuaishou'
  | 'toutiao'
  | 'douban'
  | 'juejin'
  | 'csdn'
  | 'jianshu'
  | 'v2ex'
  | 'youtube'
  | 'twitter'
  | 'podcast'
  | 'github'
  /** 兜底：上面没有的平台，直接给一个订阅源地址 */
  | 'custom';

/** B站 的抓取方式 */
export type BiliMode =
  | 'api'   // 官方投稿列表接口，可能被风控，需要 Cookie
  | 'rss';  // RSS（如 RSSHub），稳定但要自备服务

export type UpdateNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'update';
  source: UpdateSource;
  label: string;

  /*
   * 监听目标（每个显示成一张卡）。
   *
   * 老存档没有这个字段，读时由 targetsOf() 合成一张 —— 见那里的说明。
   * 一旦任何一张卡被改动，这里就会有值，之后以它为准。
   */
  targets?: UpdateTarget[];

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
  /**
   * 订阅源地址示例，直接进输入框的 placeholder。
   *
   * ================= 为什么必须给 =================
   *
   * 除了 YouTube 与播客，这些平台都不提供官方订阅源，
   * 地址要靠 RSSHub（或 wechat2rss 之类）拼出来。
   * 不给示例的话，用户面对一个空输入框无从下手 ——
   * 而"填了主页地址却一直解析失败"正是最常见的一类困惑。
   */
  route?: string;
}> = {
  bilibili: {
    label: 'B站 UP 主',
    hint: '检测 UP 主是否有新投稿（订阅源模式需第三方源；接口模式填 UID 即可）',
    icon: '📺',
    color: '#fb7299',
    route: 'https://rsshub.app/bilibili/user/video/<UID>',
  },
  wechat: {
    label: '微信公众号',
    hint: '检测公众号是否有新推文（无官方接口，需第三方订阅源）',
    icon: '💬',
    color: '#07c160',
    route: 'https://wechat2rss.xlab.app/feed/xxxx.xml',
  },
  xiaohongshu: {
    /*
     * 小红书没有官方开放接口，与公众号同一条路：第三方桥接出的订阅源。
     * 把这一点写在 hint 里而不是等用户填了才发现 ——
     * "填了主页地址却一直报解析失败"是最常见的一类困惑。
     */
    label: '小红书',
    hint: '检测博主是否有新笔记（无官方接口，需第三方订阅源）',
    icon: '📕',
    color: '#ff2442',
    route: 'https://rsshub.app/xiaohongshu/user/<id>/notes',
  },
  weibo: {
    label: '微博',
    hint: '检测博主是否有新微博（无官方接口，需第三方订阅源；公共实例常需自备 Cookie）',
    icon: '🌐',
    color: '#e6162d',
    route: 'https://rsshub.app/weibo/user/<uid>',
  },
  zhihu: {
    label: '知乎',
    hint: '检测答主新回答 / 新文章 / 专栏更新（无官方接口，需第三方订阅源）',
    icon: '💡',
    color: '#0084ff',
    route: 'https://rsshub.app/zhihu/people/activities/<id>',
  },
  douyin: {
    label: '抖音',
    hint: '检测达人是否有新视频（无官方接口，需第三方订阅源）',
    icon: '🎵',
    color: '#111827',
    route: 'https://rsshub.app/douyin/user/<sec_uid>',
  },
  kuaishou: {
    label: '快手',
    hint: '检测达人是否有新视频（无官方接口，需第三方订阅源）',
    icon: '⚡',
    color: '#ff6600',
    route: 'https://rsshub.app/kuaishou/user/<id>',
  },
  toutiao: {
    label: '今日头条',
    hint: '检测头条号是否有新内容（无官方接口，需第三方订阅源）',
    icon: '📰',
    color: '#f04142',
    route: 'https://rsshub.app/toutiao/user/<id>',
  },
  douban: {
    label: '豆瓣',
    hint: '检测小组新帖 / 用户动态（小组讨论有官方源，用户动态需第三方）',
    icon: '📗',
    color: '#00b51d',
    route: 'https://www.douban.com/feed/group/<group>/discussion',
  },
  juejin: {
    label: '掘金',
    hint: '检测专栏 / 作者新文章（需第三方订阅源）',
    icon: '⛏️',
    color: '#1e80ff',
    route: 'https://rsshub.app/juejin/category/frontend',
  },
  csdn: {
    label: 'CSDN',
    hint: '检测博主是否有新文章（需第三方订阅源）',
    icon: '🅲',
    color: '#fc5531',
    route: 'https://rsshub.app/csdn/blog/<user>',
  },
  jianshu: {
    label: '简书',
    hint: '检测作者是否有新文章（需第三方订阅源）',
    icon: '✍️',
    color: '#ea6f5a',
    route: 'https://rsshub.app/jianshu/user/<id>',
  },
  v2ex: {
    label: 'V2EX',
    hint: '检测节点 / 主题更新（有官方源，也可走第三方）',
    icon: '🅥',
    color: '#a3a3a3',
    route: 'https://rsshub.app/v2ex/topics/latest',
  },
  youtube: {
    /*
     * YouTube 是极少数**提供官方订阅源**的平台：
     * 不需要 RSSHub，把 channel_id 填进去就能用。
     * 这一点必须在 hint 里说清楚，否则用户会去找第三方桥接，
     * 多绕一圈还多一个故障点。
     */
    label: 'YouTube',
    hint: '检测频道是否有新视频（YouTube 提供官方订阅源，无需第三方桥接）',
    icon: '▶️',
    color: '#ff0000',
    route: 'https://www.youtube.com/feeds/videos.xml?channel_id=<id>',
  },
  twitter: {
    label: 'X（Twitter）',
    hint: '检测博主是否有新推文（无官方接口，需第三方订阅源）',
    icon: '𝕏',
    color: '#e5e7eb',
    route: 'https://rsshub.app/twitter/user/<id>',
  },
  podcast: {
    label: '播客',
    hint: '检测播客是否有新单集（播客普遍自带官方 RSS 源，直接填即可）',
    icon: '🎙️',
    color: '#8b5cf6',
    route: 'https://.../podcast.xml',
  },
  github: {
    label: 'GitHub 仓库',
    hint: '检测仓库有没有新提交 / 新 Release（走 GitHub 拉取，不走网络抓取）',
    icon: '🐙',
    color: '#a78bfa',
  },
  custom: {
    /*
     * 兜底种类。
     *
     * 无论内置多少平台，总有覆盖不到的：某个独立博客、某个小众论坛、
     * 某台自建的 RSSHub 上挂的自建路由。
     * 与其让用户等我们加，不如给一个"直接给地址"的口子 ——
     * 而且它跑的是与内置平台完全相同的解析与判定代码，不是二等公民。
     */
    label: '自定义订阅源',
    hint: '任何 RSS 2.0 / Atom 源：独立博客、自建 RSSHub 路由、小众论坛都可',
    icon: '🔗',
    color: '#38bdf8',
    route: 'https://.../feed.xml',
  },
};

/** 全部种类，顺序即面板里的排列顺序 */
export const UPDATE_SOURCE_KEYS = Object.keys(UPDATE_SOURCE_META) as UpdateSource[];

/**
 * 需要订阅源地址的种类 —— 界面上按这个决定填哪一栏。
 *
 * ================= 为什么是推导出来的 =================
 *
 * 早先这里是一份手写清单 `['wechat','xiaohongshu']`。
 * 手抄清单的代价在加平台时集中爆发：新种类忘了登记，
 * 卡片上就**没有订阅源输入框**，用户只能干瞪眼 ——
 * 不报错、界面看着也挺完整，是最难发现的那一类损伤。
 *
 * 改成"全部种类减去两个特例"，加平台就自动生效。
 * 特例只有两个：
 *  - bilibili：自带接口/订阅源两种模式，订阅源框由它自己那一段画
 *  - github：走 GitHub 拉取通道，根本不抓 HTTP
 *
 * 若将来出现第三个不走订阅源的种类，必须同时改这里与
 * tests/updateSources.test.ts 里那条"特例只有两个"的断言。
 */
export const FEED_SOURCES: UpdateSource[] =
  UPDATE_SOURCE_KEYS.filter((k) => k !== 'bilibili' && k !== 'github');

/** 这一张卡该不该显示"订阅源地址"输入框 */
export function needsFeedUrl(kind: UpdateSource, biliMode: BiliMode = 'rss'): boolean {
  if (kind === 'github') return false;
  if (kind === 'bilibili') return (biliMode ?? 'rss') === 'rss';
  return true;
}

/**
 * 侧栏直接列出的种类。
 *
 * 全部 17 种都塞进侧栏会把那一段撑得很长，而真正高频的就这几个。
 * 其余的在面板「＋ 加一个监听目标」里同样能选到 ——
 * 少露一面不等于少一种能力，但必须让用户知道还有更多（见面板那句提示）。
 */
export const UPDATE_SIDEBAR_SOURCES: UpdateSource[] = [
  'bilibili', 'wechat', 'xiaohongshu', 'weibo', 'zhihu', 'douyin', 'youtube', 'github',
  /*
   * 兜底排最后：它是"上面都没有"时用的，
   * 放在平台中间会让人以为它是某个具体站点。
   */
  'custom',
];

/**
 * 一个监听目标。
 *
 * 以前"更新检测"就是一个源进一个节点：盯三个 UP 主要放三个节点，
 * 而它们共用同一份"上次检查时间"与"输出"，于是三个节点互相覆盖状态 ——
 * 表现为"明明 A 有更新，节点却显示无更新"。
 *
 * 现在每个目标自带基线，节点只负责聚合。
 */
export type UpdateTarget = {
  /** 卡片自身的 id —— 同一种类可以配多张（盯两个 UP 主） */
  id: string;
  kind: UpdateSource;
  /** 这张卡单独停用（不影响节点上其它卡） */
  enabled?: boolean;
  /** 这一张的备注名；空则用种类名 */
  name?: string;

  /* ---- B站 ---- */
  biliUid?: string;
  biliMode?: BiliMode;
  biliCookie?: string;

  /* ---- 公众号 / 小红书 ---- */
  feedUrl?: string;

  /* ---- GitHub ---- */
  owner?: string;
  repo?: string;
  branch?: string;
  /** 比对本地 HEAD：只关心"本地是否落后"时用 */
  base?: string;
  credentialId?: string;

  /* ---- 每个目标各自的基线 ---- */
  lastSeenId?: string;
  lastSeenTitle?: string;
  lastCheckedAt?: number | null;
  lastUpdated?: boolean | null;
  /** 上一次检查这一张卡自己的结果；失败时给个说法，不然卡片上只是空 */
  error?: string;
};

/**
 * 取一个节点的监听目标列表。
 *
 * ================= 为什么读时才算 =================
 *
 * 老存档里没有 `targets`（那时一个节点就是一个源），字段是平铺的
 * `source` / `biliUid` / `feedUrl`。重写存档去补 targets 风险太大，
 * 而"读时合成一张卡"既能让老节点立刻长出新界面，
 * 又在这一张卡被改动时才落 `targets`（自然的写时迁移）。
 */
export function targetsOf(d: UpdateNodeData): UpdateTarget[] {
  if (Array.isArray(d.targets)) return d.targets;
  return [{
    id: `${String((d as { id?: string }).id ?? '') || 'u'}0`,
    kind: d.source ?? 'bilibili',
    enabled: true,
    biliUid: d.biliUid,
    biliMode: d.biliMode,
    biliCookie: d.biliCookie,
    feedUrl: d.feedUrl,
    lastSeenId: d.lastSeenId,
    lastSeenTitle: d.lastSeenTitle,
    lastCheckedAt: d.lastCheckedAt,
    lastUpdated: d.lastUpdated,
  }];
}

/** 启用的目标。一张都没启用时返回空 —— 校验层据此报"缺项" */
export function activeTargets(d: UpdateNodeData): UpdateTarget[] {
  return targetsOf(d).filter((t) => t.enabled !== false);
}

export function isUpdate(d: NodeData): d is UpdateNodeData {
  return (d as UpdateNodeData).kind === 'update';
}

/** GitHub 拉取策略。默认顺序即兜底顺序 */
export type GithubStrategy = 'api' | 'atom' | 'cli';

/** 拉取：要不要走本地 git（cli 方案需要机器上有 git） */
export type GithubUpdateNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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
      /*
       * 直接落一份 targets。
       *
       * 不落的话新节点靠 targetsOf() 读时合成 —— 界面上看着有卡，
       * 但一改动才发现没有下标可写（老字段是平铺的）。
       * 这里落成数组，之后增删改卡都落在下标上，两条路径合一。
       */
      targets: partial.targets ?? [{
        id: `${id}0`,
        kind: source,
        enabled: true,
        biliUid: partial.biliUid ?? '',
        biliMode: partial.biliMode ?? 'rss',
        biliCookie: partial.biliCookie ?? '',
        feedUrl: partial.feedUrl ?? '',
        lastSeenId: partial.lastSeenId ?? '',
        lastSeenTitle: partial.lastSeenTitle ?? '',
        lastCheckedAt: partial.lastCheckedAt ?? null,
        lastUpdated: partial.lastUpdated ?? null,
      }],
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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
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
 * 三种存储方式的界面文案。
 *
 * 刻意写清每种"防得住什么、防不住什么" ——
 * 只写"更安全"会让人以为是无敌的。
 */
export const VAULT_MODE_META: Record<VaultMode, { label: string; hint: string }> = {
  oskeyring: {
    label: 'OS 凭据管理器',
    hint: '主密钥存在 Windows 凭据管理器 / macOS 钥匙串里，不在应用数据目录 —— '
      + '拷走整个数据目录也解不开，且不用每次输口令。'
      + '能登录这台机器的人仍可取到，要防那个请用口令模式',
  },
  auto: {
    label: '本机加密',
    hint: '主密钥由本机特征派生，自动解锁。盐明文存在数据目录里 —— '
      + '拿到整个目录的人仍能离线解开，只防"别的脚本顺手读"',
  },
  passphrase: {
    label: '口令加密',
    hint: '每次打开要输口令，钥匙只在你自己脑子里 —— 唯一能防"整台机器被拿走"的方式',
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


/* ================================================================== */
/* 工具节点：等待 / 日志标记 / 提示音 / 播放音频 / 当前时间 / 常量      */
/*                                                                    */
/* 这些节点都不依赖外部能力（不需要 CLI、凭据、文件系统通道），         */
/* 所以 engine/nodeRequires.ts 里没有它们 —— 也正因如此，             */
/* 浏览器模式下同样可用。                                              */
/* ================================================================== */

/**
 * 汇合（控制器）：等所有入边都到齐了才放行下游。
 *
 * 与"多入边节点默认的 OR 语义"的区别：
 *   普通节点 —— 只要有一条入边活着就跑（分支后汇合，走任一分支都能继续）
 *   汇合·宽松 —— 同上，但会把所有到齐的输入合并成一份输出
 *   汇合·严格 —— 任何一条入边没产出（被剪枝 / 跳过 / 失败）就算没收集全，
 *                 直接失败并让下游跳过
 */
/**
 * 判定方式 —— 闸门与重试共用。
 *
 * 单独抽出来是因为两者都在回答同一个问题："这份输出算不算合格"。
 * 各写一份的话，以后加一种判定方式要改两处。
 */
export type PassCheck =
  /** 非空即可 */
  | 'nonempty'
  /** 包含指定文本 */
  | 'contains'
  /** 不包含指定文本（如"响应里没有 error"） */
  | 'notContains'
  /** 匹配正则 */
  | 'regex';

/** 闸门：满足条件才放行下游 */
export type GateNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'gate';
  label: string;
  /** 等（轮询到超时）还是立刻判定（不满足直接失败） */
  mode: 'wait' | 'now';
  check: PassCheck;
  /** contains / notContains / regex 的比对值 */
  value?: string;
  /** wait 模式下的最长等待；到点仍未满足按 onTimeout 处理 */
  timeoutMs?: number;
  /** wait 模式的轮询间隔 */
  pollMs?: number;
  /** 等到超时仍未满足时：fail=失败并阻断下游，pass=照样放行 */
  onTimeout?: 'fail' | 'pass';
  status: NodeStatus;
  output: string;
  error: string;
};

/** 限流：控制放行的节奏 */
export type ThrottleNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'throttle';
  label: string;
  /** 两次放行之间的最小间隔（毫秒）。太快就等到够为止 */
  minIntervalMs: number;
  /** 本次运行最多放行几次；超出则失败。留空不限次 */
  maxPerRun?: number;
  status: NodeStatus;
  output: string;
  error: string;
};

/** 超时熔断：整条流程的预算超了就断在这里 */
export type TimeoutNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'timeout';
  label: string;
  /** 从**运行开始**算起的预算（毫秒），不是本节点自己的耗时 */
  budgetMs: number;
  /** 超预算时：fail=失败并阻断下游，pass=放行但记一条警告 */
  onExceed?: 'fail' | 'pass';
  status: NodeStatus;
  output: string;
  error: string;
};

/** 重试：上游成功了但内容不合格时，重跑它直到合格 */
export type RetryNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'retry';
  label: string;
  /** 要重跑的节点 id。通常填直接上游 */
  target: string;
  /** 最多重试几次（不含第一次） */
  times: number;
  /** 每次重试前的间隔 */
  intervalMs?: number;
  check: PassCheck;
  value?: string;
  status: NodeStatus;
  output: string;
  error: string;
};

export type JoinNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'join';
  label: string;
  /**
   * 严格程度。
   *   all    —— 宽松：活着的入边都到齐就放行（被剪枝的分支不算缺失）
   *   strict —— 严格：任何一条入边没产出都算没收集全
   */
  mode: 'all' | 'strict';
  /** 多个输入合并时的分隔符。支持 \n 之类的转义，默认换行 */
  joinBy?: string;
  status: NodeStatus;
  output: string;
  error: string;
};

export type WaitNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'wait';
  label: string;
  /** 等待毫秒数。支持模板，如 {{上游.output}} */
  ms: number;
  status: NodeStatus;
  output: string;
  error: string;
};

/** 日志标记：把一段文本写进运行日志，并把输出原样传给下游 */
export type LogNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'log';
  label: string;
  /** 支持模板。留空则输出上游内容 */
  text: string;
  /** 日志级别。warn / error 会带醒目标记，但都不会让流程失败 */
  level: 'info' | 'warn' | 'error';
  status: NodeStatus;
  output: string;
  error: string;
};

/**
 * 四种内置提示音。
 *
 * 刻意用 Web Audio **合成**而不是加载音频文件：
 *   · 不需要打包任何资源，也不依赖用户机器上有对应文件
 *   · 不读磁盘，因此不受 fs 授权目录限制
 *   · 浏览器与 Tauri 都能用（AudioContext 两边都有）
 */
export type BeepPreset = 'success' | 'fail' | 'notice' | 'alarm';

export const BEEP_PRESET_META: Record<BeepPreset, { label: string; hint: string }> = {
  success: { label: '成功', hint: '两声上行短音，跑完了听这个' },
  fail:    { label: '失败', hint: '两声下行低音，出错时听这个' },
  notice:  { label: '提醒', hint: '一声中音，需要你看一眼时用' },
  alarm:   { label: '警报', hint: '三声急促高音，别错过时用' },
};

export type BeepNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'beep';
  label: string;
  preset: BeepPreset;
  /** 音量 0~1 */
  volume: number;
  status: NodeStatus;
  output: string;
  error: string;
};

/** 播放本地音频文件。需要 fs 能力，浏览器模式下不可用 */
export type PlayAudioNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'play-audio';
  label: string;
  /** 支持模板，如 {{上游.output}} */
  path: string;
  volume: number;
  /** 播完再往下走；关掉则立即返回（声音继续放） */
  waitForEnd: boolean;
  status: NodeStatus;
  output: string;
  error: string;
};

export type ClockNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'clock';
  label: string;
  /**
   * 格式串。支持的占位符：
   *   YYYY MM DD HH mm ss SSS
   * 其它字符原样输出，所以 "YYYY-MM-DD" 直接可用。
   */
  format: string;
  status: NodeStatus;
  output: string;
  error: string;
};

export type ConstNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'const';
  label: string;
  /**
   * 常量种类。
   *
   * 老节点没有这个字段 —— 一律按 'text' 处理（那正是它当初的行为）。
   * 用 `=== false` 之类的写法在这里是错的：缺省该落到 text，不是别的。
   */
  valueType?: ConstValueType;
  /** 固定输出。支持模板（模板在运行时求值，所以"常量"也可以是动态拼出来的） */
  value: string;
  status: NodeStatus;
  output: string;
  error: string;
};

/**
 * 常量节点的种类。
 *
 * 三种不是"换个输入控件"这么简单 —— 它们**产出的值种类不同**：
 * 数字常量接到「大于」上合法，接到「包含」上才是错参；
 * 布尔常量接到条件判定上合法，接到加减乘除上是错参。
 * 所以种类必须参与参数类型校验（见 argTypes / paramLinks）。
 */
export type ConstValueType = 'text' | 'num' | 'bool';

/**
 * 三种常量的名字。
 *
 * 放在 types.ts（数据层）而不是节点定义里：makeConstNode 要用它当默认标签，
 * 而 defs/const.ts 反过来 import types.ts —— 表写在 defs 里就成环了。
 * 颜色属于界面，仍留在 defs/const.ts。
 */
export const CONST_TYPE_LABEL: Record<ConstValueType, string> = {
  text: '文本常量',
  num: '数字常量',
  bool: '布尔常量',
};

export function makeGateNode(id: string, partial: Partial<GateNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'gate',
      label: partial.label ?? '闸门',
      mode: partial.mode ?? 'wait',
      check: partial.check ?? 'nonempty',
      value: partial.value ?? '',
      timeoutMs: partial.timeoutMs ?? 10000,
      pollMs: partial.pollMs ?? 500,
      onTimeout: partial.onTimeout ?? 'fail',
      status: 'idle',
      output: '',
      error: '',
    } as unknown as GateNodeData,
  } as unknown as GraphNode;
}

export function makeThrottleNode(id: string, partial: Partial<ThrottleNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'throttle',
      label: partial.label ?? '限流',
      minIntervalMs: partial.minIntervalMs ?? 1000,
      maxPerRun: partial.maxPerRun,
      status: 'idle',
      output: '',
      error: '',
    } as unknown as ThrottleNodeData,
  } as unknown as GraphNode;
}

export function makeTimeoutNode(id: string, partial: Partial<TimeoutNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'timeout',
      label: partial.label ?? '超时熔断',
      budgetMs: partial.budgetMs ?? 60000,
      onExceed: partial.onExceed ?? 'fail',
      status: 'idle',
      output: '',
      error: '',
    } as unknown as TimeoutNodeData,
  } as unknown as GraphNode;
}

export function makeRetryNode(id: string, partial: Partial<RetryNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'retry',
      label: partial.label ?? '重试',
      target: partial.target ?? '',
      times: partial.times ?? 3,
      intervalMs: partial.intervalMs ?? 1000,
      check: partial.check ?? 'nonempty',
      value: partial.value ?? '',
      status: 'idle',
      output: '',
      error: '',
    } as unknown as RetryNodeData,
  } as unknown as GraphNode;
}

export function makeJoinNode(id: string, partial: Partial<JoinNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'join',
      label: partial.label ?? '汇合',
      mode: partial.mode ?? 'all',
      joinBy: partial.joinBy ?? '\\n',
      status: 'idle',
      output: '',
      error: '',
    } as unknown as JoinNodeData,
  } as unknown as GraphNode;
}

export function makeWaitNode(id: string, partial: Partial<WaitNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'wait',
      label: partial.label ?? '等待',
      ms: partial.ms ?? 2000,
      status: 'idle',
      output: '',
      error: '',
    } as WaitNodeData,
  };
}

export function makeLogNode(id: string, partial: Partial<LogNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'log',
      label: partial.label ?? '日志标记',
      text: partial.text ?? '',
      level: partial.level ?? 'info',
      status: 'idle',
      output: '',
      error: '',
    } as LogNodeData,
  };
}

export function makeBeepNode(id: string, partial: Partial<BeepNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'beep',
      label: partial.label ?? '提示音',
      preset: partial.preset ?? 'success',
      volume: partial.volume ?? 0.6,
      status: 'idle',
      output: '',
      error: '',
    } as BeepNodeData,
  };
}

export function makePlayAudioNode(id: string, partial: Partial<PlayAudioNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'play-audio',
      label: partial.label ?? '播放音频',
      path: partial.path ?? '',
      volume: partial.volume ?? 0.8,
      waitForEnd: partial.waitForEnd ?? true,
      status: 'idle',
      output: '',
      error: '',
    } as PlayAudioNodeData,
  };
}

export function makeClockNode(id: string, partial: Partial<ClockNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'clock',
      label: partial.label ?? '当前时间',
      format: partial.format ?? 'YYYY-MM-DD HH:mm:ss',
      status: 'idle',
      output: '',
      error: '',
    } as ClockNodeData,
  };
}

/**
 * 模块节点 —— 画布上一个模块的实例。
 *
 * 两种状态，二选一：
 *   · 跟随（moduleId 有值、inner 为空）：结构来自模块库，改库则所有实例跟着变
 *   · 脱钩（inner 有值）：自带一份结构副本，与模块库再无关系
 *
 * 为什么用"有 inner 就是脱钩"而不是再存一个 detached 布尔：
 * 两个标志位可能不同步（比如 inner 还在但 detached=false），
 * 而"有没有自带结构"本身就是脱钩的定义，不需要第二个真相。
 */
export type ModuleNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'module';
  label: string;
  /** 跟随的模块 id；脱钩后为空串 */
  moduleId: string;
  /** 脱钩后的自带结构；跟随状态下为 null */
  inner: { nodes: unknown[]; edges: unknown[] } | null;
  status: NodeStatus;
  output: string;
  error: string;
};

export function makeModuleNode(id: string, partial: Partial<ModuleNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'module',
      label: partial.label ?? '模块',
      moduleId: partial.moduleId ?? '',
      inner: partial.inner ?? null,
      status: 'idle',
      output: '',
      error: '',
    } as ModuleNodeData,
  };
}

export function isModule(d: NodeData): d is ModuleNodeData {
  return (d as ModuleNodeData).kind === 'module';
}

/* ------------------------------------------------------------------ */
/* 组合框                                                              */
/* ------------------------------------------------------------------ */

/**
 * 组合框的数据。
 *
 * 只有三样东西：判别式、名字、成员 id。
 * 它**没有** status / output / error —— 那三个是运行时字段，
 * 而组合框不参与执行（见 App 里 runNodes 的过滤）。
 * 给了它们反而会被当成"一个状态永远是 idle 的节点"，
 * 在各种统计里冒出来。
 *
 * members 存 id 而不是存节点副本：
 * 存副本的话成员改了参数，框里的那份不会跟着变，
 * 而界面上完全看不出有两份。
 */
export type FrameNodeData = {
  kind: 'frame';
  label: string;
  /** 成员节点 id；顺序只影响显示，不影响任何逻辑 */
  members: string[];
};

export function makeFrameNode(id: string, partial: Partial<FrameNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'frame',
      label: partial.label ?? '组合',
      members: partial.members ?? [],
    } as FrameNodeData,
  };
}

/* ------------------------------------------------------------------ */
/* 跨画布                                                              */
/* ------------------------------------------------------------------ */

/**
 * 画布引用节点 —— 调用另一张画布。
 *
 * 执行时会被目标画布的内部节点替换（见 engine/canvasRef.ts），
 * 所以它在画布上是"一个节点"，在引擎里是"一整张图"。
 */
export type CanvasRefNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'canvasRef';
  label: string;
  /** 要调用哪张画布 */
  canvasId: string;
  /**
   * 卡片上的显示名（用户可手填）。
   *
   * 空串 = 用目标画布的名字（并跟着改名）。
   * 有这个字段是因为同一张画布可能被多处引用，
   * 各引用节点想显示不同的名字来区分用途。
   */
  displayName?: string;
  status?: string;
  output?: string;
  error?: string;
};

/**
 * 画布输入节点 —— 显式标注"这里是这张画布的入口"。
 *
 * 不放也能用（自动推导无上游的节点），放它是为了自己定接口：
 * 比如画布内部其实有多个独立起点，只想暴露其中一部分。
 */
export type CanvasInNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'canvasIn';
  label: string;
  /** 端口名，多入口时用来区分 */
  portName?: string;
  status?: string;
  output?: string;
  error?: string;
};

export type CanvasOutNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'canvasOut';
  label: string;
  portName?: string;
  /** 没接上游时输出这个兜底值 */
  fallback?: string;
  status?: string;
  output?: string;
  error?: string;
};

export function makeCanvasRefNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'canvasRef', label: '调用画布', canvasId: '',
      status: 'idle', output: '', error: '', ...partial,
    } as CanvasRefNodeData,
  };
}

export function makeCanvasInNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'canvasIn', label: '画布输入', portName: '',
      status: 'idle', output: '', error: '', ...partial,
    } as CanvasInNodeData,
  };
}

export function makeCanvasOutNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'canvasOut', label: '画布输出', portName: '', fallback: '',
      status: 'idle', output: '', error: '', ...partial,
    } as CanvasOutNodeData,
  };
}

/* ------------------------------------------------------------------ */
/* 表格（数值推导）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 表格以 **CSV 文本** 在节点间流动，没有隐藏状态 ——
 * 理由见 engine/table.ts 文件头。
 */

export type TableReadNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'tableRead';
  label: string;
  /** CSV / TSV 文件路径 */
  path: string;
  /** 分隔符；留空自动判断 */
  delim?: string;
  status?: string;
  output?: string;
  error?: string;
};

export type DeriveNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'derive';
  label: string;
  /** 新列名 */
  newCol: string;
  /** 公式，用列名直接引用该行的值 */
  expr: string;
  /** 列名已存在时是否覆盖 */
  replace?: boolean;
  status?: string;
  output?: string;
  error?: string;
};

export type FilterNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'filter';
  label: string;
  /** 条件表达式；结果非 0 的行保留 */
  cond: string;
  status?: string;
  output?: string;
  error?: string;
};

export type AggNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'agg';
  label: string;
  col: string;
  op: 'sum' | 'avg' | 'min' | 'max' | 'count';
  status?: string;
  output?: string;
  error?: string;
};

export function makeTableReadNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'tableRead', label: '读表格', path: '', delim: '',
      status: 'idle', output: '', error: '', ...partial,
    } as TableReadNodeData,
  };
}

export function makeDeriveNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'derive', label: '推导列', newCol: '', expr: '', replace: false,
      status: 'idle', output: '', error: '', ...partial,
    } as DeriveNodeData,
  };
}

export function makeFilterNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'filter', label: '筛选行', cond: '',
      status: 'idle', output: '', error: '', ...partial,
    } as FilterNodeData,
  };
}

export function makeAggNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'agg', label: '汇总', col: '', op: 'sum',
      status: 'idle', output: '', error: '', ...partial,
    } as AggNodeData,
  };
}

/* ------------------------------------------------------------------ */
/* 运算、变量、停止、人工输入                                            */
/* ------------------------------------------------------------------ */

/** 四个运算节点共用的数据形状 */
export type OpNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'math' | 'text' | 'compare' | 'random';
  label: string;
  /** 具体运算 */
  op: string;
  /** 参与运算的值，都支持模板 */
  a?: string;
  b?: string;
  /** 只有文本运算用到第三个值（替换成什么 / 取到哪个位置） */
  c?: string;
  status?: string;
  output?: string;
  error?: string;
};

export type VarNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'var';
  label: string;
  /** 读还是写 */
  mode: 'get' | 'set';
  name: string;
  /** set 模式下的值；留空则用上游输出 */
  value?: string;
  status?: string;
  output?: string;
  error?: string;
};

export type StopNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'stop';
  label: string;
  /** 停整个流程还是只停这条分支 */
  mode: 'all' | 'branch';
  status?: string;
  output?: string;
  error?: string;
};

export type AskNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'ask';
  label: string;
  prompt: string;
  /** 预填内容 */
  value?: string;
  /** 是否必填 */
  required?: boolean;
  status?: string;
  output?: string;
  error?: string;
};

function mkOp(kind: 'math' | 'text' | 'compare' | 'random', id: string, label: string, op: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind, label, op,
      a: partial.a ?? '', b: partial.b ?? '', c: partial.c ?? '',
      status: 'idle', output: '', error: '',
    } as OpNodeData,
  };
}

export function makeMathNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return mkOp('math', id, '数学运算', 'add', partial);
}
export function makeTextNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return mkOp('text', id, '文本运算', 'concat', partial);
}
export function makeCompareNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return mkOp('compare', id, '比较', 'eq', partial);
}
export function makeRandomNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return mkOp('random', id, '随机', 'int', partial);
}

export function makeVarNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'var', label: '变量', mode: 'set', name: '',
      value: '', status: 'idle', output: '', error: '',
      ...partial,
    } as VarNodeData,
  };
}

export function makeStopNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'stop', label: '停止', mode: 'all',
      status: 'idle', output: '', error: '',
      ...partial,
    } as StopNodeData,
  };
}

export function makeAskNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'ask', label: '人工输入', prompt: '', value: '', required: true,
      status: 'idle', output: '', error: '',
      ...partial,
    } as AskNodeData,
  };
}

export function makeConstNode(id: string, partial: Partial<ConstNodeData> = {}): GraphNode {
  const vt: ConstValueType = partial.valueType ?? 'text';
  return {
    id,
    data: {
      kind: 'const',
      label: partial.label ?? CONST_TYPE_LABEL[vt],
      valueType: vt,
      /*
       * 布尔常量的默认值必须是 'true'，不能是空串。
       *
       * 空串输出空串，下游条件节点拿到空值既不等于 true 也不等于 false，
       * 判定结果取决于它自己的兜底 —— 而用户拖进来时想的是"给个 false"。
       */
      value: partial.value ?? (vt === 'bool' ? 'true' : ''),
      status: 'idle',
      output: '',
      error: '',
    } as ConstNodeData,
  };
}

export function isWait(d: NodeData): d is WaitNodeData {
  return (d as WaitNodeData).kind === 'wait';
}
export function isLog(d: NodeData): d is LogNodeData {
  return (d as LogNodeData).kind === 'log';
}
export function isBeep(d: NodeData): d is BeepNodeData {
  return (d as BeepNodeData).kind === 'beep';
}
export function isPlayAudio(d: NodeData): d is PlayAudioNodeData {
  return (d as PlayAudioNodeData).kind === 'play-audio';
}
export function isClock(d: NodeData): d is ClockNodeData {
  return (d as ClockNodeData).kind === 'clock';
}
export function isConst(d: NodeData): d is ConstNodeData {
  return (d as ConstNodeData).kind === 'const';
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

/**
 * 一个**触发条件卡片**。
 *
 * ================= 为什么要有条目 ====================
 *
 * 以前一个触发器节点是「一份共享 config + 一个 kind 数组」：
 * 选了周期和监听两种方式，两者共用同一份 `config`，
 * 界面上则挤成一个多选勾选组 + 一堆"选中才显示"的字段。
 *
 * 后果有两个：
 *   1. 改周期秒数会顺带改到别的触发方式用到的字段（它们共用一份）
 *   2. 看不出"这个节点到底配了几个触发条件"，因为它们没有各自的边界
 *
 * 现在每种触发方式是**一张独立的卡**，各带自己的 config。
 */
export type TriggerEntry = {
  /** 卡片自身的 id —— 同一个 kind 可以配多张（比如两个不同端口的调用触发） */
  id: string;
  kind: TriggerKind;
  /** 这张卡单独停用（不影响节点上其它卡） */
  enabled?: boolean;
  /** 只覆盖这张卡关心的字段，其余用节点默认 config 兜底 */
  config?: Partial<TriggerConfig>;
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

/*
 * 下拉里的顺序（manual 在最前：它是默认档，也是唯一不需要额外配置的一档）。
 *
 * **显式列出**而不是 `Object.keys(TRIGGER_META)`，两个原因：
 *   1. 后者返回 `string[]`，拿它去索引 `Record<TriggerKind, …>` 会报
 *      TS7053（用 any 索引），TriggerNode.tsx 里正是这么写的；
 *   2. 更要命的是**漏项不会报错** —— 少给一种方式，那一档就在下拉里
 *      悄然消失，用户根本没法选，而代码看上去完全正常。
 * 下面那两行是编译期兜底，漏任何一种即报错。
 */
export const TRIGGER_KINDS = [
  'manual', 'interval', 'cron', 'watch', 'webhook', 'chat',
] as const;

/* 顺序表必须覆盖 TriggerKind 的每一种：漏了 = 该方式在界面上选不到 */
type KindsComplete = Exclude<TriggerKind, (typeof TRIGGER_KINDS)[number]> extends never ? true : never;
const _kindsComplete: KindsComplete = true;
void _kindsComplete;

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
