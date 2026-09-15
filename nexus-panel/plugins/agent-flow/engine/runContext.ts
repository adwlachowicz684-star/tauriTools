import type {
  Graph, GraphNode, NodeStatus, LoopCtx,
} from '../types';
import type {
  RunEvent, RunOptions, Scope, BranchRecord, ParallelRecord, LoopRecord,
} from './runTypes';

/**
 * 节点执行器拿到的上下文。
 *
 * 为什么要有这么一个"大礼包"对象：
 * 执行逻辑原本写在 runGraph 的闭包里，能直接摸到 outputs / emit / setStatus
 * 等一堆内部状态。要做"一个节点一个文件"，这些逻辑必须搬出去 ——
 * 搬出去就拿不到闭包变量了，只能显式传进来。
 *
 * 于是这里把闭包里**确实被用到**的东西全部列出来，由 runGraph 在调用时
 * 组装一份交给节点执行器。执行器只依赖这个类型，不依赖 runner.ts，
 * 依赖方向是单向的（runner → 注册表 → 节点定义 → 执行器），不会成环。
 *
 * 刻意**不**把整个 runGraph 的内部状态暴露成 any ——
 * 那样等于没抽离，节点照样能改到任何东西。
 */
export type RunContext = {
  /** 当前节点 id */
  id: string;
  /** 当前节点（含 data） */
  node: GraphNode;
  graph: Graph;
  opts: RunOptions;
  scope: Scope;

  /* ---------- 事件与状态 ---------- */
  emit: (e: RunEvent) => void;
  setStatus: (id: string, status: NodeStatus) => void;
  /** 只记录一次，避免循环多轮重复 push 导致数组膨胀 */
  markFailed: (id: string, scope?: Scope) => void;
  markSkipped: (id: string, scope?: Scope) => void;
  sleep: (ms: number) => Promise<void>;

  /* ---------- 共享累积状态（跨节点、跨轮次可见） ---------- */
  outputs: Record<string, string>;
  /** {{nodeId.title}} 这类附加字段 */
  nodeFields: Record<string, Record<string, string>>;
  /** 循环上下文栈顶；不在循环体内时为 null */
  currentLoop: () => LoopCtx | null;

  /* ---------- 结果收集器 ---------- */
  branches: BranchRecord[];
  parallels: ParallelRecord[];
  loops: LoopRecord[];

  /* ---------- 图信息 ---------- */
  byId: Map<string, GraphNode>;
  /** 属于某个循环体的节点，主流程要跳过 */
  bodyNodeSet: Set<string>;
  /** 循环 id → 该循环体包含的节点 id */
  loopBodies: Map<string, Set<string>>;
  /** 按拓扑序排列一组节点（循环体用） */
  orderByLayers: (ids: Iterable<string>) => string[];
  inheritConcurrency: (id: string) => number;
  /**
   * 记录本节点的实际并发度，供下游继承。
   * 并发节点算完后要把它登记进去，否则下游拿到的仍是全局默认值。
   */
  setConcurrency: (id: string, value: number) => void;

  /* ---------- 递归入口 ---------- */
  /** 执行单个节点 */
  runNode: (id: string, scope: Scope) => Promise<void>;
  /** 按拓扑序执行一批节点（循环每轮用，带独立作用域） */
  runScope: (ids: string[], scope: Scope) => Promise<void>;
  /** 循环上下文栈（循环节点自己压栈/出栈） */
  loopStack: LoopCtx[];
};

export type { Scope } from './runTypes';
