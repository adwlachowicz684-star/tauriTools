/**
 * types.ts 第 2 卷：condition。
 *
 * 实现按域分卷，types.ts 只留 re-export 入口；外部 175 处 import 路径不变。
 * 卷内代码按原文件行序原样保留（含私有辅助与初始化顺序），不要重排。
 */
import type { AggNodeData, ApiPaneNodeData, CanvasInNodeData, CanvasOutNodeData, CanvasRefNodeData, DeriveNodeData, FilterNodeData, FrameNodeData, TableReadNodeData, TaskPaneNodeData } from './canvas';
import type { GraphNode, NodeSize, NodeStatus, TaskNodeData } from './core';
import type { LoopNodeData, ParallelNodeData, TriggerNodeData } from './flow';
import type { ExtractNodeData, FsNodeData, GenericHttpNodeData } from './io';
import type { LlmChatNodeData, OcrNodeData, TranslateNodeData } from './llm';
import type { AskNodeData, OpNodeData, StopNodeData, VarNodeData } from './ops';
import type { BeepNodeData, ClockNodeData, ConstNodeData, GateNodeData, JoinNodeData, LogNodeData, ModuleNodeData, PlayAudioNodeData, RetryNodeData, ThrottleNodeData, TimeoutNodeData, WaitNodeData } from './tools';
import type { GithubPushNodeData, GithubUpdateNodeData, UpdateNodeData } from './update';

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
  | LlmChatNodeData
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
  | TaskPaneNodeData
  | ApiPaneNodeData
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
