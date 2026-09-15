import type {
  GraphNode, NodeStatus, LoopCtx, FsNodeData,
} from '../types';
import type { Credential } from './credentials';
import type { FeedItem } from './updates';

export type RunEvent =
  | { type: 'layer-start'; layer: number; total: number; ids: string[] }
  | { type: 'node-start'; id: string; rendered: string }
  | { type: 'node-chunk'; id: string; chunk: string }
  | { type: 'node-done'; id: string; ok: boolean; output: string; error?: string }
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
   * 凭据库。节点只存 credentialId，真正取密钥在这里做 ——
   * 密钥不进图数据，导出画布时也不会跟着走。
   */
  credentials?: Credential[];
  /** GitHub 拉取执行器；不提供时 GitHub 更新节点会失败并提示 */
  githubFetch?: GithubUpdateRunner;
  /** GitHub 推送执行器；不提供时 GitHub 推送节点会失败并提示 */
  githubPush?: GithubPushRunner;
  input?: string;
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
