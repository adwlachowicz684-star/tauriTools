import type { ComponentType } from 'react';
import type { NodeProps, NodeTypes } from '@xyflow/react';
import type { NodeData, GraphNode, SecretPolicy } from '../types';
import type { FlowNode, FlowEdge } from '../flowTypes';
import type { Credential } from '../engine/credentials';
import type { RunContext } from '../engine/runContext';

/**
 * 节点注册表 —— 让"新增一种节点"只需要写一个文件。
 *
 * 重构前，加一种节点要同时改 7 处，任何一处漏改都是运行时才炸的坑：
 *   1. types.ts        加 XxxNodeData + 并进 NodeData 联合 + isXxx() + makeXxxNode()
 *   2. flowTypes.ts    加 XxxFlowNode + 并进 FlowNode 联合
 *   3. App.tsx         nodeTypes 映射（画布用哪个组件渲染）
 *   4. App.tsx         新增节点时的 if-else 链（id 前缀 / type / 调哪个 make）
 *   5. Sidebar.tsx     DragPayload 联合 + decodeDrag 白名单 + 侧栏 UI
 *   6. Inspector.tsx   isXxx() 分发链
 *   7. runner.ts       isXxx() 分发链 + 执行函数
 *
 * 现在这些全部由一份 NodeDef 推导：
 * 侧栏条目、画布组件、属性面板、执行器都从注册表里取，
 * 上面 3/4/5/6/7 五处变成"读表"，新增节点不再需要碰它们。
 */

/** 侧栏分组。顺序即展示顺序 */
export type NodeCategory = 'trigger' | 'task' | 'flow' | 'data' | 'ai' | 'external';

export const NODE_CATEGORY_META: Record<NodeCategory, { label: string }> = {
  trigger:  { label: '触发器（起点）' },
  task:     { label: '任务' },
  flow:     { label: '流程控制' },
  data:     { label: '文件与数据' },
  ai:       { label: 'AI 能力' },
  external: { label: '外部服务' },
};

/**
 * 属性面板的入参。
 *
 * 各节点面板需要的字段不同（比如只有触发器要 webhookTokens），
 * 统一成一个 props 类型、各取所需，比给每种节点定义不同签名更好扩展：
 * 注册表要用同一个 ComponentType 装下所有面板，签名必须一致。
 */
export type NodeInspectorProps = {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
  /** 凭据列表；不传则凭据选择区不显示 */
  credentials?: Credential[];
  /** 打开凭据中心，并聚焦到指定类型 */
  onOpenCredentials?: (kind: string) => void;
  /** 内联密钥的落盘策略 */
  secretPolicy?: SecretPolicy;
  onChangeSecretPolicy?: (p: SecretPolicy) => void;
  /** 后端为「未填 Token」的 webhook 触发器自动生成的校验 Token，按触发器 id 索引 */
  webhookTokens?: Record<string, string>;
};

/**
 * 侧栏里的一个可拖拽条目。
 *
 * 预设 ≠ 节点类型：一个类型可以有多个预设。
 * 典型是「任务」节点 —— TraceCode / CodeBuddy 是同一个类型、两种 cli 取值；
 * 「B站 / 公众号」同理，共用 update 类型、靠 source 区分。
 * 拆成预设而不是类型，是为了不让类型数爆炸（仓库里已经有 12 个类型了）。
 */
export type NodePreset = {
  /** 唯一键，拖拽载荷里传它 */
  key: string;
  /** 对应的节点类型 */
  type: string;
  label: string;
  /** 侧栏圆点色，一般与画布卡片左边框同色 */
  color: string;
  /** 悬浮提示 */
  hint?: string;
  /** 创建时的初始数据 */
  init: () => NodeData;
};

export type NodeMeta = {
  label: string;
  /** 卡片左边框 + 侧栏圆点色 */
  color: string;
  category: NodeCategory;
  /** 新建节点时的 id 前缀，如 'task' → t1、'loop' → lp1 */
  idPrefix: string;
  /** 侧栏该组下方的补充说明 */
  sub?: string;
  /**
   * 该类型在侧栏里的预设。
   * 不给则用 meta 生成单个预设（label/color 取 meta）。
   */
  presets?: () => Omit<NodePreset, 'type'>[];
};

export type NodeDef = {
  /** xyflow 的 node.type，也是注册表主键 */
  type: string;
  /**
   * data 的判别式（data.kind），执行引擎用它来分发。
   *
   * 为什么不统一用 type：runGraph 收到的 Graph 是 {id, data} 结构，
   * **不带 node.type**（画布节点在转图时被剥掉了），执行器只拿得到 data。
   * 而 data.kind 是每个节点数据自带的，所以执行分发走它。
   *
   * 多数情况 dataKind 与 type 相同；以下两种不一致：
   *  - bili / wechat：两个 type，同一个 data（kind='update'），共用执行器
   *  - task：TaskNodeData 历史原因没有 kind 字段，这里记作 'task' 兜底
   */
  dataKind: string;
  meta: NodeMeta;
  /** 造默认数据 */
  create: (id: string, partial?: Record<string, unknown>) => NodeData;
  /**
   * 画布上的卡片组件。
   *
   * 类型直接取 xyflow NodeTypes 的值类型 —— 各卡片实际声明的是
   * NodeProps<具体FlowNode>，比裸 NodeProps 更窄，写 `ComponentType<NodeProps>`
   * 会因参数逆变而赋值失败。xyflow 自己也是用 data:any 放宽的，这里照抄它的口径。
   */
  Canvas: NodeTypes[string];
  /** 右侧属性面板 */
  Inspector: ComponentType<NodeInspectorProps>;
  /**
   * 执行器。不提供时该节点只做"直通"：不产出输出、直接成功。
   * 纯编排类节点（并发控制的某些模式）可以不给。
   */
  run?: (ctx: RunContext) => Promise<void>;
};
