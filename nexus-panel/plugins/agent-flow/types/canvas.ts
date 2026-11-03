/**
 * types.ts 第 8 卷：canvas。
 *
 * 实现按域分卷，types.ts 只留 re-export 入口；外部 175 处 import 路径不变。
 * 卷内代码按原文件行序原样保留（含私有辅助与初始化顺序），不要重排。
 */
import type { CliKind, GraphNode, NodeSize } from './core';

/* ------------------------------------------------------------------ */
/* 组合框                                                              */
/* ------------------------------------------------------------------ */

/**
 * 组合框的数据。
 *
 * 只有三样东西：判别式、名字、成员 id。
 * 它**没有** status / output / error —— 那三个是运行时字段，
 * 而组合框不参与执行（见 App 里 runNodes 的过滤）。
 * 给了它们反而会被当成"一个状态永远是 idle 的节点"，
 * 在各种统计里冒出来。
 *
 * members 存 id 而不是存节点副本：
 * 存副本的话成员改了参数，框里的那份不会跟着变，
 * 而界面上完全看不出有两份。
 */
export type FrameNodeData = {
  kind: 'frame';
  label: string;
  /** 成员节点 id；顺序只影响显示，不影响任何逻辑 */
  members: string[];
};

export function makeFrameNode(id: string, partial: Partial<FrameNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'frame',
      label: partial.label ?? '组合',
      members: partial.members ?? [],
    } as FrameNodeData,
  };
}

/* ------------------------------------------------------------------ */
/* 任务窗格                                                            */
/* ------------------------------------------------------------------ */

/**
 * 任务窗格 —— 一组同类节点的**共享配置容器**。
 *
 * ================= 它和组合框的区别 ====================
 *
 * 组合框（frame）只管画图：框住、整体挪动，不带任何配置。
 * 窗格（taskPane / apiPane）带配置：挂在窗格里的节点，
 * **自己没填的项**从窗格继承。
 *
 * 于是"这几个节点都在同一个项目目录里跑"只要配一次。
 *
 * ================= 为什么不参与执行 ====================
 *
 * 它只是配置的载体，真正跑的还是里面的节点。
 * 让它也跑一遍会出现一个什么都不做的空节点，
 * 任务记录里多一条、流程图上多一格，徒增噪音。
 */
export type TaskPaneNodeData = {
  kind: 'taskPane';
  label: string;
  /** 成员节点 id。与组合框一样，顺序只影响显示 */
  members: string[];
  /** 窗格默认 CLI。成员节点自己选了就用它自己的 */
  cli?: CliKind;
  /** 共享工作目录。成员节点留空时用这个 */
  workdir?: string;
  /** 默认模型。成员节点留空时用这个 */
  model?: string;
  /** 默认连接（模型清单来源）。成员节点留空时用这个 */
  credentialId?: string;
  /** 默认是否自动批准工具调用 */
  yolo?: boolean;
  /**
   * 是否把同一窗格内上游节点的输出自动接进下一个节点的提示词。
   *
   * 关掉时每个节点只看到自己那份提示词 —— 上下文互不相通，
   * 适合"几个独立任务凑一批跑"的场景。
   */
  shareContext?: boolean;
  /**
   * 是否让窗格里的成员**接着同一个会话**跑（codebuddy 的 `-c`）。
   *
   * ================= 与 shareContext 的区别 ====================
   *
   * shareContext 是把上游的输出**抄进提示词**——下游看得到上游说了什么，
   * 但 CLI 那边每次都是全新会话，项目上下文要重新加载一遍。
   *
   * relaySession 是 CLI 自己接着上次继续——会话历史在它那边，
   * 不用重加载上下文，也省 token。代价是成员之间变成**强串行**：
   * "上一次会话"是 CLI 全局记的，两个并行节点会互相串到对方那一次上。
   *
   * ================= 为什么默认关 ====================
   *
   * 它依赖 CLI 自己维护"上一次"这个全局状态。若用户在别处
   * （比如自己开着的终端里）刚跑过同一个 CLI，接力的可能是那一次会话 ——
   * 表现为"节点读到了一段没见过的历史"。默认关，要的人自己开。
   */
  relaySession?: boolean;
};

export function makeTaskPaneNode(id: string, partial: Partial<TaskPaneNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'taskPane',
      label: partial.label ?? 'CLI 任务窗格',
      members: partial.members ?? [],
      cli: partial.cli,
      workdir: partial.workdir ?? '',
      model: partial.model ?? '',
      credentialId: partial.credentialId ?? '',
      yolo: partial.yolo,
      shareContext: partial.shareContext ?? true,
      relaySession: partial.relaySession ?? false,
    } as TaskPaneNodeData,
  };
}

/**
 * API 任务窗格 —— 大模型节点的共享配置容器。
 *
 * 与 CLI 窗格同理，多承载一样东西：**system 提示词**。
 * 于是窗格变成一个"角色 / 场景模板"：
 * 里面每个节点只填 user 提示词，共用一个角色设定与同一条连接。
 */
export type ApiPaneNodeData = {
  kind: 'apiPane';
  label: string;
  members: string[];
  /** 默认连接（大模型凭据） */
  credentialId?: string;
  /** 默认模型 */
  model?: string;
  /** 共享的 system 提示词（角色设定） */
  system?: string;
  /** 默认温度 */
  temperature?: number;
  /** 是否要求结构化 JSON 输出 */
  jsonMode?: boolean;
};

export function makeApiPaneNode(id: string, partial: Partial<ApiPaneNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'apiPane',
      label: partial.label ?? 'API 任务窗格',
      members: partial.members ?? [],
      credentialId: partial.credentialId ?? '',
      model: partial.model ?? '',
      system: partial.system ?? '',
      temperature: partial.temperature,
      jsonMode: partial.jsonMode ?? false,
    } as ApiPaneNodeData,
  };
}

/* ------------------------------------------------------------------ */
/* 跨画布                                                              */
/* ------------------------------------------------------------------ */

/**
 * 画布引用节点 —— 调用另一张画布。
 *
 * 执行时会被目标画布的内部节点替换（见 engine/canvasRef.ts），
 * 所以它在画布上是"一个节点"，在引擎里是"一整张图"。
 */
export type CanvasRefNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'canvasRef';
  label: string;
  /** 要调用哪张画布 */
  canvasId: string;
  /**
   * 卡片上的显示名（用户可手填）。
   *
   * 空串 = 用目标画布的名字（并跟着改名）。
   * 有这个字段是因为同一张画布可能被多处引用，
   * 各引用节点想显示不同的名字来区分用途。
   */
  displayName?: string;
  status?: string;
  output?: string;
  error?: string;
};

/**
 * 画布输入节点 —— 显式标注"这里是这张画布的入口"。
 *
 * 不放也能用（自动推导无上游的节点），放它是为了自己定接口：
 * 比如画布内部其实有多个独立起点，只想暴露其中一部分。
 */
export type CanvasInNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'canvasIn';
  label: string;
  /** 端口名，多入口时用来区分 */
  portName?: string;
  status?: string;
  output?: string;
  error?: string;
};

export type CanvasOutNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'canvasOut';
  label: string;
  portName?: string;
  /** 没接上游时输出这个兜底值 */
  fallback?: string;
  status?: string;
  output?: string;
  error?: string;
};

export function makeCanvasRefNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'canvasRef', label: '调用画布', canvasId: '',
      status: 'idle', output: '', error: '', ...partial,
    } as CanvasRefNodeData,
  };
}

export function makeCanvasInNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'canvasIn', label: '画布输入', portName: '',
      status: 'idle', output: '', error: '', ...partial,
    } as CanvasInNodeData,
  };
}

export function makeCanvasOutNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'canvasOut', label: '画布输出', portName: '', fallback: '',
      status: 'idle', output: '', error: '', ...partial,
    } as CanvasOutNodeData,
  };
}

/* ------------------------------------------------------------------ */
/* 表格（数值推导）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 表格以 **CSV 文本** 在节点间流动，没有隐藏状态 ——
 * 理由见 engine/table.ts 文件头。
 */

export type TableReadNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'tableRead';
  label: string;
  /** CSV / TSV 文件路径 */
  path: string;
  /** 分隔符；留空自动判断 */
  delim?: string;
  status?: string;
  output?: string;
  error?: string;
};

export type DeriveNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'derive';
  label: string;
  /** 新列名 */
  newCol: string;
  /** 公式，用列名直接引用该行的值 */
  expr: string;
  /** 列名已存在时是否覆盖 */
  replace?: boolean;
  status?: string;
  output?: string;
  error?: string;
};

export type FilterNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'filter';
  label: string;
  /** 条件表达式；结果非 0 的行保留 */
  cond: string;
  status?: string;
  output?: string;
  error?: string;
};

export type AggNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'agg';
  label: string;
  col: string;
  op: 'sum' | 'avg' | 'min' | 'max' | 'count';
  status?: string;
  output?: string;
  error?: string;
};

export function makeTableReadNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'tableRead', label: '读表格', path: '', delim: '',
      status: 'idle', output: '', error: '', ...partial,
    } as TableReadNodeData,
  };
}

export function makeDeriveNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'derive', label: '推导列', newCol: '', expr: '', replace: false,
      status: 'idle', output: '', error: '', ...partial,
    } as DeriveNodeData,
  };
}

export function makeFilterNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'filter', label: '筛选行', cond: '',
      status: 'idle', output: '', error: '', ...partial,
    } as FilterNodeData,
  };
}

export function makeAggNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'agg', label: '汇总', col: '', op: 'sum',
      status: 'idle', output: '', error: '', ...partial,
    } as AggNodeData,
  };
}
