import type {
  GraphNode, NodeStatus, LoopCtx, FsNodeData,
} from '../types';
import type { Credential } from './credentials';
import type { FeedItem } from './updates';

export type RunEvent =
  | { type: 'layer-start'; layer: number; total: number; ids: string[] }
  | { type: 'node-start'; id: string; rendered: string }
  | { type: 'node-chunk'; id: string; chunk: string }
  /*
   * detail：这个结论是怎么来的（判据）。
   * 运算类节点只输出 true/false，没有它事后完全无法复盘。
   */
  | { type: 'node-done'; id: string; ok: boolean; output: string; error?: string; detail?: string }
  /**
   * 节点出错但还没到"完成"那一步 —— 缺执行器、参数不合法等前置失败。
   *
   * 与 `node-done{ok:false}` 的区别：done 表示节点真的跑过了，
   * error 表示**根本没跑起来**。分开是必要的 ——
   * 前者输出可能有效，后者输出一定是空的，界面上不该同等对待。
   */
  | { type: 'node-error'; id: string; error: string }
  /** 任务节点的参数字段已产出：{{id.file}} {{id.参数名}} 等可引用了 */
  | { type: 'node-fields'; id: string; files: string[]; fields: Record<string, string> }
  | { type: 'node-status'; id: string; status: NodeStatus }
  /**
   * 一条运行日志。
   *
   * 与 node-chunk 的区别：chunk 是某节点的流式输出片段，
   * 而这是**节点主动要记的一句话**（日志标记节点用），
   * 语义上属于"给人看的提示"而非"节点的产出"。
   * 混用 chunk 会让界面把它当成输出内容显示，含义就错了。
   */
  | { type: 'log'; id?: string; message: string; level?: 'info' | 'warn' | 'error' }
  /** 条件节点判定完成：branchId 为走的分支，pruned 是被裁掉的节点 */
  | { type: 'branch-taken'; id: string; branchId: string | null; label: string; pruned: string[] }
  /** 并发节点解析完成：下游将以 concurrency 并发执行 */
  | { type: 'parallel-resolved'; id: string; concurrency: number; reason: string }
  /** 循环节点解析完成：共 items.length 轮 */
  | { type: 'loop-resolved'; id: string; count: number; reason: string; warnings: string[] }
  /** 每一轮迭代开始 */
  | { type: 'loop-iteration'; id: string; index: number; item: string; count: number }
  /** 循环全部结束 */
  | { type: 'loop-done'; id: string; rounds: number; failed: number }
  /**
   * 更新检测节点检查完毕。
   * patch 是需要写回节点的数据（新基线、上次检查时间等）——
   * 执行器本身是纯的，改状态这件事交给调用方落盘。
   */
  | {
      type: 'update-checked';
      id: string;
      updated: boolean;
      item: FeedItem | null;
      reason: string;
      baseline: boolean;
      patch: Record<string, unknown>;
    }
  | { type: 'run-done'; ok: boolean }
  | { type: 'run-error'; message: string };

/** 执行一个任务节点，返回完整输出；抛错即视为失败 */
export type Executor = (
  node: GraphNode,
  renderedPrompt: string,
  onChunk: (chunk: string) => void,
) => Promise<string>;

/** 抓取一个 URL 的文本内容；抛错即视为失败 */
export type Fetcher = (
  node: GraphNode,
  url: string,
  opts: { headers: Record<string, string>; timeoutSec: number },
) => Promise<string>;

export type LlmCallResult = { status: number; text: string };

/**
 * 调用大模型 API。
 *
 * 与 Fetcher 分开定义：大模型要的是"发 JSON + 拿回文本 + 带状态码"，
 * 而 Fetcher 只管抓文本，混用一个签名会让两边的错误处理都变复杂。
 */
export type LlmCaller = (req: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutSec: number;
}) => Promise<LlmCallResult>;

/** 读取本地图片为 data URL（base64），供 OCR 节点使用 */
export type ImageReader = (path: string) => Promise<string>;

/** 执行文件操作，返回展示用的结果文本；抛错即视为失败 */
export type FsExecutor = (
  node: GraphNode,
  args: { path: string; target: string; content: string },
) => Promise<string>;

/**
 * GitHub 拉取执行器。
 *
 * 与 Fetcher 分开：Fetcher 只有 (url) => text，而 GitHub 多方案需要
 * 传目标、策略顺序、以及 cli 兜底的执行通道 —— 塞进 Fetcher 会让签名膨胀。
 */
export type GithubUpdateRunner = (req: {
  owner: string;
  repo: string;
  branch?: string;
  base?: string;
  order?: string[];
  token: string;
  credentialId?: string;
}) => Promise<{ ok: boolean; info?: GithubUpdateInfo; error?: string; via?: string }>;

export type GithubPushRunner = (req: {
  owner: string;
  repo: string;
  branch?: string;
  message: string;
  files: { path: string; content: string }[];
  workdir?: string;
  order?: string[];
  token: string;
  credentialId?: string;
}) => Promise<{ ok: boolean; commit?: string; via?: string; error?: string }>;

/** 拉取结果的展示字段，runner 只关心这几个 */
export type GithubUpdateInfo = {
  branch: string;
  sha: string;
  message: string;
  author: string;
  date: string;
  updated: boolean;
};

/**
 * 通用 HTTP 执行器。
 *
 * 与 Fetcher 分开：Fetcher 只会 GET 且只回文本，而通用 HTTP 节点要能
 * 指定方法 / 请求体 / 超时，还要拿到状态码与响应头（判断 4xx 是否算失败、
 * 以及取 `Location` 这类头都要用）。塞进 Fetcher 会让它背上不属于它的参数。
 */
export type HttpRequester = (
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutSec?: number;
    maxBytes?: number;
  },
) => Promise<{ status: number; ok: boolean; text: string; headers: Record<string, string> }>;

export type RunOptions = {
  /** 同层并发上限。设为 1 即严格串行 */
  concurrency: number;
  executor: Executor;
  /** 文件操作执行器；不提供时文件节点会直接失败并提示 */
  fsExecutor?: FsExecutor;
  /** 网络抓取执行器；不提供时更新检测节点会直接失败并提示 */
  fetcher?: Fetcher;
  /** 大模型调用执行器；不提供时 OCR / 翻译节点会直接失败并提示 */
  llmCaller?: LlmCaller;
  /** 本地图片读取器；不提供时 OCR 的本地文件模式会失败并提示 */
  imageReader?: ImageReader;
  /**
   * 连接库。节点只存 credentialId，真正取密钥在这里做 ——
   * 密钥不进图数据，导出画布时也不会跟着走。
   */
  credentials?: Credential[];
  /**
   * 读表格文件（读表格节点用）。
   *
   * 走 Rust 的 fs_op —— 浏览器里没有磁盘权限。
   * 不提供时读表格节点会明确失败，不做模拟：
   * "假装读到一张空表"会让下游算出一堆 0，比报错难查得多。
   */
  tableReader?: (path: string) => Promise<string>;
  /**
   * 等人填内容（「人工输入」节点用）。
   *
   * 返回 null = 用户取消。不提供时该节点会明确失败并说明原因 ——
   * 静默返回空串会让下游拿着空值继续跑，那比报错难查得多。
   */
  askHuman?: (promptText: string, defaultValue?: string) => Promise<string | null>;
  /** GitHub 拉取执行器；不提供时 GitHub 更新节点会失败并提示 */
  githubFetch?: GithubUpdateRunner;
  /** GitHub 推送执行器；不提供时 GitHub 推送节点会失败并提示 */
  githubPush?: GithubPushRunner;
  /** 通用 HTTP 执行器；不提供时 HTTP 请求节点会失败并提示 */
  httpRequester?: HttpRequester;
  /**
   * 读取本地音频文件为 DataURL。
   * 播放音频节点用；不提供时该节点会失败并提示（浏览器模式）。
   */
  playAudioReader?: (path: string) => Promise<string>;
  input?: string;
  /**
   * 全局默认的单节点超时（秒）。0 / 不填 = 不限时。
   *
   * 节点自己的 `timeoutSec` 优先，且**能覆盖成"不限时"**——
   * 否则"全局设了 60 秒、某个节点就是要等 10 分钟"表达不出来，
   * 用户只能把全局调大，等于全局保护失效。
   *
   * 默认不限时是刻意的：加这个功能不能改变任何既有流程的行为。
   */
  nodeTimeoutSec?: number;
  /**
   * 画布参数（{{params.名字}}）。
   *
   * 由调用方（App）从当前画布的 config.params 传入 ——
   * 引擎不知道"画布"这个概念，它只跑一张图。
   * 模块展开后内部节点也是这张图的节点，于是自动取到
   * 当前画布的值 —— 同一模块在不同画布取到不同值，靠的就是这一层。
   */
  params?: Record<string, string>;
  /**
   * 带位置的节点列表，用于嵌合（Scratch 式上下吸附）的输出传递。
   *
   * 为什么单独传而不是让引擎从 graph 里推：graph 是执行用的最小结构
   * （只有 id + data），执行顺序与坐标都靠它；而嵌合要用到测量的高度，
   * 那是画布层才有的信息。由调用方（App）补给即可。
   *
   * 不传时嵌合节点拿不到 {{input}} / {{chain.output}} —— 但嵌合产生的
   * 虚拟边是调用方拼进 edges 的，所以**执行顺序与失败传播照常工作**。
   */
  stackNodes?: Array<{ id: string; position: { x: number; y: number }; data?: Record<string, unknown> }>;
  /**
   * 入口触发器节点 id —— 本次运行从它出发。
   *
   * 不给 = 图上全部触发器都算起点（手动运行的语义）。
   * 给了 = 只跑从它出发的那一条链路（自动触发必须给，
   *        否则一个周期任务到期会带起整张画布）。
   *
   * 判定与可达计算见 engine/triggerScope：
   * 引擎这一侧只负责"限定范围"，"该不该有入口"由调用方判定 ——
   * 触发器是否启用牵扯节点禁用、触发条件卡片、后台开关，
   * 那些语义在 triggerRegistry 里，不归 runner 管。
   */
  entry?: string;
  onEvent: (e: RunEvent) => void;
  signal?: AbortSignal;
};

export type RunSummary = {
  ok: boolean;
  outputs: Record<string, string>;
  failed: string[];
  skipped: string[];
  /** 条件判定的轨迹，便于事后回溯走了哪条路 */
  branches: BranchRecord[];
  /** 并发节点的解析结果 */
  parallels: ParallelRecord[];
  /** 循环节点的执行结果 */
  loops: LoopRecord[];
  /** 运行结束时的工作流变量表 */
  vars: Record<string, string>;
};


export type BranchRecord = { id: string; branchId: string | null; label: string };
export type ParallelRecord = { id: string; concurrency: number; reason: string };
export type LoopRecord = { id: string; rounds: number; failed: number; reason: string; warnings: string[] };

/**
 * 一轮执行的作用域状态。
 *
 * 主流程用全局那一份；循环每轮迭代会新建一份，
 * 这样上一轮被裁掉的边不会污染下一轮，
 * 而 outputs / failed 等累积记录仍然共享（跨轮可见）。
 */
export type Scope = {
  deadEdges: Set<string>;
  skippedSet: Set<string>;
  failedSet: Set<string>;
};
