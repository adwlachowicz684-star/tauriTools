import type { Node } from '@xyflow/react';
import type {
  TaskNodeData, ConditionNodeData, TriggerNodeData, ParallelNodeData,
  LoopNodeData, FsNodeData,
} from './types';

/** React Flow v12 的节点类型；data 承载我们自己的定义 */
export type TaskFlowNode = Node<TaskNodeData, 'task'>;
export type CondFlowNode = Node<ConditionNodeData, 'condition'>;
export type TriggerFlowNode = Node<TriggerNodeData, 'trigger'>;
export type ParallelFlowNode = Node<ParallelNodeData, 'parallel'>;
export type LoopFlowNode = Node<LoopNodeData, 'loop'>;
export type FsFlowNode = Node<FsNodeData, 'fs'>;

export type FlowNode =
  | TaskFlowNode
  | CondFlowNode
  | TriggerFlowNode
  | ParallelFlowNode
  | LoopFlowNode
  | FsFlowNode;

/** React Flow v12 的边类型；data.branch 标注所属分支 */
export type FlowEdgeData = {
  branch?: string;
  label?: string;
  /** 循环节点的出边角色：body 每轮执行 / done 结束后执行一次 */
  loopRole?: 'body' | 'done';
};
export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  data?: FlowEdgeData;
  /** 条件分支边在 UI 上高亮 */
  style?: Record<string, string>;
};
