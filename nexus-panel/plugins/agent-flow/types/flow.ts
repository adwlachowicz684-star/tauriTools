/**
 * types.ts 第 3 卷：flow。
 *
 * 实现按域分卷，types.ts 只留 re-export 入口；外部 175 处 import 路径不变。
 * 卷内代码按原文件行序原样保留（含私有辅助与初始化顺序），不要重排。
 */
import type { ConditionOp, NodeData } from './condition';
import type { GraphNode, NodeSize, NodeStatus } from './core';
import type { TriggerConfig, TriggerKind } from './trigger';
import { DEFAULT_TRIGGER_CONFIG, TRIGGER_META } from './trigger';

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
