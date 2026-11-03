/**
 * types.ts 第 1 卷：core。
 *
 * 实现按域分卷，types.ts 只留 re-export 入口；外部 175 处 import 路径不变。
 * 卷内代码按原文件行序原样保留（含私有辅助与初始化顺序），不要重排。
 */
import type { NodeParam } from '../engine/params';
import type { NodeData } from './condition';


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

  /**
   * 属于哪个 CLI 任务窗格（节点 id）。
   *
   * 留空 = 独立节点，自己那份配置自己管。
   * 填了则**节点上没填的项**从窗格继承（工作目录 / 模型 / 连接 / 自动批准），
   * 节点上填了的项仍然优先 —— 否则窗格一改，精心配好的节点就被盖掉了。
   */
  paneId?: string;
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
