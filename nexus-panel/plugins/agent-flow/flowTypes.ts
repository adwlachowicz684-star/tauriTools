import type { Node } from '@xyflow/react';
import type {
  TaskNodeData, ConditionNodeData, TriggerNodeData, ParallelNodeData,
  LoopNodeData, FsNodeData, UpdateNodeData, OcrNodeData, TranslateNodeData,
  GenericHttpNodeData, ExtractNodeData,
  GithubUpdateNodeData, GithubPushNodeData,
  WaitNodeData, LogNodeData, BeepNodeData, PlayAudioNodeData,
  ClockNodeData, ConstNodeData, ModuleNodeData, FrameNodeData, JoinNodeData,
  GateNodeData, ThrottleNodeData, TimeoutNodeData, RetryNodeData,
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
/** 合并后的「更新检测」：一个节点盯多个目标 */
export type UpdateFlowNode = Node<UpdateNodeData, 'update'>;
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
export type ModuleFlowNode = Node<ModuleNodeData, 'module'>;
/** 组合框：画在节点后面的框，不参与执行 */
export type FrameFlowNode = Node<FrameNodeData, 'frame'>;
/* ---- 控制器 ---- */
export type JoinFlowNode = Node<JoinNodeData, 'join'>;
export type GateFlowNode = Node<GateNodeData, 'gate'>;
export type ThrottleFlowNode = Node<ThrottleNodeData, 'throttle'>;
export type TimeoutFlowNode = Node<TimeoutNodeData, 'timeout'>;
export type RetryFlowNode = Node<RetryNodeData, 'retry'>;

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
  | ConstFlowNode
  | ModuleFlowNode
  | FrameFlowNode
  | JoinFlowNode
  | GateFlowNode
  | ThrottleFlowNode
  | TimeoutFlowNode
  | RetryFlowNode;

/** React Flow v12 的边类型；data.branch 标注所属分支 */
export type FlowEdgeData = {
  branch?: string;
  label?: string;
  /** 循环节点的出边角色：body 每轮执行 / done 结束后执行一次 */
  loopRole?: 'body' | 'done';
  /**
   * 参数连线标记：'param' 表示这条边只给某个参数供值，不参与执行顺序。
   * 与 types.ts 的 GraphEdge.data 是同一份语义（那边给 engine/ 下的
   * 纯 node 测试用，这边给 React Flow 的边用）。
   */
  kind?: string;
  /** 参数连线的目标参数名 */
  targetArg?: string;
};
export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  /** React Flow 用它选渲染组件：'param' 走参数连线那套样式 */
  type?: string;
  label?: string;
  data?: FlowEdgeData;
  /** 条件分支边在 UI 上高亮 */
  style?: Record<string, string>;
};
