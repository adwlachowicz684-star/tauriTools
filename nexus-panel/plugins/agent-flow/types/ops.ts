/**
 * types.ts 第 9 卷：ops。
 *
 * 实现按域分卷，types.ts 只留 re-export 入口；外部 175 处 import 路径不变。
 * 卷内代码按原文件行序原样保留（含私有辅助与初始化顺序），不要重排。
 */
import type { ConditionNodeData, NodeData } from './condition';
import type { GraphNode, NodeSize, TaskNodeData } from './core';
import type { ExtractNodeData, FsNodeData } from './io';
import type { BeepNodeData, ClockNodeData, ConstItem, ConstNodeData, LogNodeData, PlayAudioNodeData, WaitNodeData } from './tools';
import { newConstId } from './tools';

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

/**
 * 新建常量节点 —— 至少带**一张**卡。
 *
 * 空 items 的节点在画布上是一张卡都没有：没有输出端口、主输出空串，
 * 而节点看着挺正常。所以创建时保证有一张，删到零张的事由面板拦（见 ConstInspector）。
 */
export function makeConstNode(id: string, partial: Partial<ConstNodeData> = {}): GraphNode {
  const items: ConstItem[] = partial.items?.length
    ? partial.items
    : [{
      id: newConstId(),
      name: '',
      valueType: 'text',
      /*
       * 值留空即可 —— 空串在卡片上是「（空）」，用户一眼看见要填什么。
       * （布尔卡曾经默认 'true'，是为了避免空值在下游判定时两边不靠；
       *   现在种类是用户自己切的，切完就在面板上选真/假，不需要猜默认值。）
       */
      value: '',
    }];
  return {
    id,
    data: {
      kind: 'const',
      label: partial.label ?? '常量',
      items,
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
