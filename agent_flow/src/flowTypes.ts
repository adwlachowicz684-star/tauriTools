import type { Node } from '@xyflow/react';
import type {
  TaskNodeData, ConditionNodeData, TriggerNodeData, ParallelNodeData,
} from './types';

/** React Flow v12 的节点类型；data 承载我们自己的定义 */
export type TaskFlowNode = Node<TaskNodeData, 'task'>;
export type CondFlowNode = Node<ConditionNodeData, 'condition'>;
export type TriggerFlowNode = Node<TriggerNodeData, 'trigger'>;
export type ParallelFlowNode = Node<ParallelNodeData, 'parallel'>;

export type FlowNode =
  | TaskFlowNode
  | CondFlowNode
  | TriggerFlowNode
  | ParallelFlowNode;

/** React Flow v12 的边类型；data.branch 标注所属分支 */
export type FlowEdgeData = {
  branch?: string;
  label?: string;
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
