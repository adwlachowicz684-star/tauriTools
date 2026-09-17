import type { ComponentType } from 'react';
import type { NodeProps, NodeTypes } from '@xyflow/react';
import type { NodeData, GraphNode, SecretPolicy } from '../types';
import type { FlowNode, FlowEdge } from '../flowTypes';
import type { Credential } from '../engine/credentials';
import type { RunContext } from '../engine/runContext';
/* 必须保持 `import type`：fields 属于组件层，而注册表（nodes/registry）依赖本文件。
   一旦变成值导入，组件层就会被拉进注册表的运行时依赖，
   重新形成 registry → components → nodes → registry 的环（详见
   components/inspectors/inspectorOf.tsx 的注释：环会让插件卡死在握手上）。 */
import type { FieldFactory, FieldRenderProps } from '../components/inspectors/fields';

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
export type NodeCategory =
  | 'trigger' | 'task' | 'flow' | 'data' | 'ai' | 'external' | 'tools' | 'custom'
  /**
   * 控制器：不产生数据，只管**何时放行、放不放行**。
   * 与 flow（条件/循环，靠数据决定走向）分开，
   * 因为控制器的判据是"到齐了没"，与数据内容无关。
   */
  | 'control'
  /**
   * 运算：数学 / 文本 / 比较 / 随机 / 变量。
   *
   * Scratch 里这是一整类积木（Operators），本插件此前完全没有 ——
   * 要算个数只能靠模板拼字符串，而模板不会真的计算。
   * 单独成类而不是塞进 tools：tools 是"做事的小工具"（等待、提示音），
   * 运算是"算出一个值"，找起来是两种意图。
   */
  | 'ops'
  /**
   * MCP 生成的节点。
   *
   * 单独一类而不是塞进 'external'：这类节点是**运行时生成**的，
   * 数量与种类随连上的 server 变化，混进固定分组会让那组的含义变模糊。
   * 侧栏里再按 server 折叠成小组。
   */
  | 'mcp';

/*
 * 键序即侧栏分组的展示顺序。
 * 控制器紧挨流程控制 —— 它俩都是"管走向"的，放一起才好找。
 */
export const NODE_CATEGORY_META: Record<NodeCategory, { label: string }> = {
  trigger:  { label: '触发器（起点）' },
  task:     { label: '任务' },
  flow:     { label: '流程控制' },
  control:  { label: '控制器' },
  ops:      { label: '运算' },
  data:     { label: '文件与数据' },
  ai:       { label: 'AI 能力' },
  external: { label: '外部服务' },
  /*
   * 工具类小节点单独成组：等待、日志、提示音、取当前时间、常量……
   * 它们数量会持续增加，散进「流程控制」「数据」里会稀释那两组的主题
   * （用户找"流程控制"时想的是条件/循环，不是"等两秒"）。
   */
  tools:    { label: '工具' },
  /*
   * MCP 节点按 server 折叠成小组，所以这一层只给个总标题。
   * 放在 custom 之前：它是"别人提供的能力"，比用户自己存的更靠前。
   */
  mcp:      { label: 'MCP' },
  custom:   { label: '自定义' },
};

/**
 * 属性面板的入参。
 *
 * 各节点面板需要的字段不同（比如只有触发器要 webhookTokens），
 * 统一成一个 props 类型、各取所需，比给每种节点定义不同签名更好扩展：
 * 注册表要用同一个 ComponentType 装下所有面板，签名必须一致。
 */
export type NodeInspectorProps = {
  /** 进入模块实例的内部编辑（由属性面板注入） */
  onEditModule?: (nodeId: string) => void;
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
  /**
   * 这个节点支持哪些参数卡片组（如 'github-repo'）。
   *
   * 声明了就会在属性面板自动出现对应的卡片选择器，并且**只有这些组**
   * 的卡片能拖到这类节点上 —— 面板渲染与拖放校验共用这一份声明，
   * 不会出现"面板上有选择器却不接受拖放"或反之的不一致。
   */
  cardGroups?: string[];
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
  /**
   * 属性面板字段清单。
   *
   * 给了 fields 就不必再写 Inspector —— 基础面板按描述自动渲染（含标题行）。
   * 这是新增节点的**首选写法**：多数节点只需声明字段，不写 JSX。
   *
   * 需要特殊交互时（条件规则编辑器、循环配置、触发器的五种子类型），
   * 用 type:'custom' 的 render 逃生口嵌一段自己的 JSX；
   * 复杂到描述不住的，给 Inspector 整体接管。
   */
  fields?: FieldFactory;
  /** 追加在字段之后的自定义内容（例：OCR 的「测试一下」按钮） */
  panelFooter?: (p: FieldRenderProps) => React.ReactNode;
  /** 属性面板。不给则按 fields 自动渲染；两者都没给则为空面板 */
  Inspector?: ComponentType<NodeInspectorProps>;
  /**
   * 执行器。不提供时该节点只做"直通"：不产出输出、直接成功。
   * 纯编排类节点（并发控制的某些模式）可以不给。
   */
  run?: (ctx: RunContext) => Promise<void>;
};
