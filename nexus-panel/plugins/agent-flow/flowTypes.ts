import type { Node } from '@xyflow/react';
import type {
  TaskNodeData, ConditionNodeData, TriggerNodeData, ParallelNodeData,
  LoopNodeData, FsNodeData, UpdateNodeData, OcrNodeData, TranslateNodeData,
  GenericHttpNodeData, ExtractNodeData,
  GithubUpdateNodeData, GithubPushNodeData,
  WaitNodeData, LogNodeData, BeepNodeData, PlayAudioNodeData,
  ClockNodeData, ConstNodeData,
} from './types';

/** React Flow v12 的节点类型；data 承载我们自己的定义 */
export type TaskFlowNode = Node<TaskNodeData, 'task'>;
export type CondFlowNode = Node<ConditionNodeData, 'condition'>;
export type TriggerFlowNode = Node<TriggerNodeData, 'trigger'>;
export type ParallelFlowNode = Node<ParallelNodeData, 'parallel'>;
export type GenericHttpFlowNode = Node<GenericHttpNodeData, 'generic-http'>;
export type ExtractFlowNode = Node<ExtractNodeData, 'extract'>;
export type LoopFlowNode = Node<LoopNodeData, 'loop'>;
export type FsFlowNode = Node<FsNodeData, 'fs'>;
/** B站与公众号共用同一种 data，靠 data.source 区分 */
export type BiliFlowNode = Node<UpdateNodeData, 'bili'>;
export type WechatFlowNode = Node<UpdateNodeData, 'wechat'>;
export type OcrFlowNode = Node<OcrNodeData, 'ocr'>;
export type TranslateFlowNode = Node<TranslateNodeData, 'translate'>;
export type GithubUpdateFlowNode = Node<GithubUpdateNodeData, 'github-update'>;
export type GithubPushFlowNode = Node<GithubPushNodeData, 'github-push'>;
/* ---- 工具节点 ---- */
export type WaitFlowNode = Node<WaitNodeData, 'wait'>;
export type LogFlowNode = Node<LogNodeData, 'log'>;
export type BeepFlowNode = Node<BeepNodeData, 'beep'>;
export type PlayAudioFlowNode = Node<PlayAudioNodeData, 'play-audio'>;
export type ClockFlowNode = Node<ClockNodeData, 'clock'>;
export type ConstFlowNode = Node<ConstNodeData, 'const'>;

/* 新增节点类型时必须同时加到这里。
   漏加的话，App.tsx 里 `as FlowNode` 会报 TS2352 ——
   断言目标与源类型"重叠不足"，编译器认为这个转换没有意义。 */
export type FlowNode =
  | TaskFlowNode
  | CondFlowNode
  | TriggerFlowNode
  | ParallelFlowNode
  | LoopFlowNode
  | GenericHttpFlowNode
  | ExtractFlowNode
  | FsFlowNode
  | BiliFlowNode
  | WechatFlowNode
  | OcrFlowNode
  | TranslateFlowNode
  | GithubUpdateFlowNode
  | GithubPushFlowNode
  | WaitFlowNode
  | LogFlowNode
  | BeepFlowNode
  | PlayAudioFlowNode
  | ClockFlowNode
  | ConstFlowNode;

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
