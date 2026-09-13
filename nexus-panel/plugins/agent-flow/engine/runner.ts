import type {
  Graph, GraphNode, NodeStatus, LoopCtx, LoopNodeData, UpdateNodeData, TaskNodeData,
  OcrNodeData, TranslateNodeData,
} from '../types';
import {
  isCondition, isTrigger, isParallel, isLoop, isFs, isUpdate, isOcr, isTranslate,
  isGithubUpdate, isGithubPush,
  DEFAULT_BRANCH, defaultFileOutput, defaultOcrPrompt,
} from '../types';
import { topoLayers } from './topo';
import { renderTemplate } from './template';
import {
  extractFileRefs, parseManualPaths, buildFileFields, type FileRef,
} from './files';
import {
  resolveConfig, buildHeaders, parseResponse, extractContent,
  buildTranslateSystem, TARGET_LANGS, isUsableImageUrl,
  type ChatMessage, type ContentPart,
} from './llm';
import { resolveParams } from './params';
import { evaluateCondition } from './condition';
import { resolveParallel, effectiveConcurrency, MAX_CONCURRENCY } from './parallel';
import { resolveLoopItems, makeLoopCtx, collectLoops, type LoopResolve } from './loop';
import {
  parseFeed, parseBiliApi, detectUpdate, sortByNewest, extractBiliUid, biliApiUrl,
  BILI_REFERER,
  type FeedItem,
} from './updates';

export type RunEvent =
  | { type: 'layer-start'; layer: number; total: number; ids: string[] }
  | { type: 'node-start'; id: string; rendered: string }
  | { type: 'node-chunk'; id: string; chunk: string }
  | { type: 'node-done'; id: string; ok: boolean; output: string; error?: string }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type BranchRecord = { id: string; branchId: string | null; label: string };
type ParallelRecord = { id: string; concurrency: number; reason: string };
type LoopRecord = { id: string; rounds: number; failed: number; reason: string; warnings: string[] };

/**
 * 一轮执行的作用域状态。
 *
 * 主流程用全局那一份；循环每轮迭代会新建一份，
 * 这样上一轮被裁掉的边不会污染下一轮，
 * 而 outputs / failed 等累积记录仍然共享（跨轮可见）。
 */
type Scope = {
  deadEdges: Set<string>;
  skippedSet: Set<string>;
  failedSet: Set<string>;
};

/**
 * 分层执行 DAG，支持条件分支剪枝、并发控制与循环。
 *
 * 四条核心规则：
 *  1. 上游失败 → 下游跳过（skip 会继续向下传播，孙节点不会拿空输入白跑）
 *  2. 条件节点只走命中的那条分支，其余分支的**整条下游链路**被裁掉（pruned）
 *  3. 剪枝 ≠ 失败：被裁掉的分支不计入 failed，也不算工作流出错
 *  4. 循环节点的 body 出口每轮迭代执行一次；done 出口在全部迭代完成后执行一次
 *
 * 关于多入边节点的取舍：只要有一条入边"还活着"就执行（OR 语义）。
 * 这样分支后汇合的场景里，走任一分支都能继续往下跑。
 */
export async function runGraph(graph: Graph, opts: RunOptions): Promise<RunSummary> {
  const { layers, cyclic } = topoLayers(graph);
  const emit = opts.onEvent;

  if (cyclic.length > 0) {
    emit({ type: 'run-error', message: `检测到环，无法执行：${cyclic.join(' → ')}` });
    return { ok: false, outputs: {}, failed: cyclic, skipped: [], branches: [], parallels: [], loops: [] };
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outputs: Record<string, string> = {};
  const failed: string[] = [];
  const skipped: string[] = [];
  const branches: BranchRecord[] = [];
  const parallels: ParallelRecord[] = [];
  const loops: LoopRecord[] = [];

  /**
   * 循环上下文栈 —— 供模板渲染 {{loop.item}} / {{loop.index}} / {{loop.count}}。
   *
   * 原本是单个变量，靠"赋值 → await 执行 → 下一轮覆盖"工作。两个问题：
   *  1. 循环体内若有嵌套循环，内层结束时会置 null，
   *     外层后续节点就读不到自己的 {{loop.item}} 了
   *  2. 若某个节点的渲染被异步延迟到下一轮覆盖之后，会读到错轮的值
   *
   * 改成栈：进入循环体压栈、结束出栈，渲染取栈顶。
   * 这样嵌套时内层 pop 后自动回落到外层的上下文。
   */
  const loopStack: LoopCtx[] = [];
  const currentLoop = (): LoopCtx | null =>
    loopStack.length > 0 ? loopStack[loopStack.length - 1] : null;

  /**
   * 节点的附加字段（{{nodeId.title}} 等）。
   * 用普通对象而非 Map：renderTemplate 每渲染一个变量就查一次，
   * 对象属性访问比 Map.get 直接。
   */
  const nodeFields: Record<string, Record<string, string>> = {};

  const globalScope: Scope = {
    deadEdges: new Set<string>(),
    skippedSet: new Set<string>(),
    failedSet: new Set<string>(),
  };

  const setStatus = (id: string, status: NodeStatus) =>
    emit({ type: 'node-status', id, status });

  /** 只记录一次，避免循环多轮重复 push 导致数组膨胀 */
  const markFailed = (id: string, scope: Scope) => {
    if (!scope.failedSet.has(id)) {
      failed.push(id);
      scope.failedSet.add(id);
    }
    scope.skippedSet.add(id);
  };
  const markSkipped = (id: string, scope: Scope) => {
    if (!scope.skippedSet.has(id)) {
      skipped.push(id);
      scope.skippedSet.add(id);
    }
  };

  const concOf = new Map<string, number>();
  const inheritConcurrency = (id: string): number => {
    if (concOf.has(id)) return concOf.get(id)!;
    const inEdges = graph.edges.filter((e) => e.target === id);
    let value = opts.concurrency;
    if (inEdges.length > 0) {
      const inherited = inEdges.map((e) => concOf.get(e.source) ?? opts.concurrency);
      value = Math.min(...inherited);
    }
    concOf.set(id, value);
    return value;
  };

  /* ---------- 循环体：这些节点由循环自己执行，主流程跳过 ---------- */
  const loopBodies = collectLoops(graph);
  const bodyNodeSet = new Set<string>();
  for (const s of loopBodies.values()) for (const id of s) bodyNodeSet.add(id);

  /** 按全局拓扑层序排列一组节点，保证子图内依赖顺序正确 */
  const orderByLayers = (ids: Iterable<string>): string[] => {
    const want = new Set(ids);
    const out: string[] = [];
    for (const layer of layers) {
      for (const id of layer) if (want.has(id)) out.push(id);
    }
    return out;
  };

  /**
   * 执行一批节点（必须已按拓扑层序排好）。
   * scope 决定用哪份"边失效 / 跳过"状态——主流程用全局，循环每轮用局部。
   */
  async function runScope(ordered: string[], scope: Scope): Promise<void> {
    // 直接用全局分层结果过滤：ordered 已按层序排列，
    // 而 layers 里同层节点互不依赖，是最可靠的并发分组依据
    const want = new Set(ordered);
    const localLayers: string[][] = [];
    for (const layer of layers) {
      const part = layer.filter((id) => want.has(id));
      if (part.length > 0) localLayers.push(part);
    }

    for (const layer of localLayers) {
      if (opts.signal?.aborted) return;

      const runnable: string[] = [];
      for (const id of layer) {
        const inEdges = graph.edges.filter((e) => e.target === id);

        if (inEdges.length === 0) {
          runnable.push(id);
          setStatus(id, 'pending');
          continue;
        }

        if (inEdges.some((e) => scope.failedSet.has(e.source))) {
          markSkipped(id, scope);
          setStatus(id, 'skipped');
          continue;
        }

        const allDead = inEdges.every(
          (e) => scope.deadEdges.has(e.id) || scope.skippedSet.has(e.source) || scope.failedSet.has(e.source),
        );
        if (allDead) {
          markSkipped(id, scope);
          setStatus(id, 'skipped');
          continue;
        }

        runnable.push(id);
        setStatus(id, 'pending');
      }

      const groups = new Map<number, string[]>();
      for (const id of runnable) {
        const c = inheritConcurrency(id);
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c)!.push(id);
      }

      for (const [groupConc, ids] of groups) {
        const queue = [...ids];
        const workerCount = effectiveConcurrency(groupConc, ids.length);
        const workers = Array.from({ length: workerCount }, async () => {
          while (queue.length > 0) {
            if (opts.signal?.aborted) return;
            const id = queue.shift()!;
            await runNode(id, scope);
          }
        });
        await Promise.all(workers);
      }
    }
  }

  /** 执行单个节点，按类型分派 */
  async function runNode(id: string, scope: Scope): Promise<void> {
    const node = byId.get(id)!;

    /* ---------- 触发器节点：只是起点标记，不调 CLI ---------- */
    if (isTrigger(node.data)) {
      setStatus(id, 'running');
      outputs[id] = opts.input ?? '';
      emit({ type: 'node-done', id, ok: true, output: outputs[id] });
      setStatus(id, 'success');
      return;
    }

    /* ---------- 并发节点：解析并发度，影响下游 ---------- */
    if (isParallel(node.data)) {
      setStatus(id, 'running');
      const upstream = graph.edges.filter((e) => e.target === id).map((e) => e.source);
      const text = upstream.length > 0
        ? upstream.map((u) => outputs[u] ?? '').join('\n')
        : (opts.input ?? '');

      const res = resolveParallel(node.data, text);
      concOf.set(id, res.concurrency);
      outputs[id] = `[并发] ${res.reason}`;
      const recorded = Number.isFinite(res.concurrency) ? res.concurrency : MAX_CONCURRENCY;
      parallels.push({ id, concurrency: recorded, reason: res.reason });
      emit({ type: 'parallel-resolved', id, concurrency: recorded, reason: res.reason });
      emit({
        type: 'node-done', id, ok: true, output: outputs[id],
        error: res.errors.length ? res.errors.join('；') : undefined,
      });
      setStatus(id, res.errors.length > 0 ? 'failed' : 'success');
      if (res.errors.length > 0) markFailed(id, scope);
      return;
    }

    /* ---------- 条件节点：只求值，不调 CLI ---------- */
    if (isCondition(node.data)) {
      setStatus(id, 'running');
      const upstream = graph.edges.filter((e) => e.target === id).map((e) => e.source);
      const res = evaluateCondition(node.data, { outputs, input: opts.input, upstream });

      const outEdges = graph.edges.filter((e) => e.source === id);
      const prunedNow: string[] = [];
      for (const e of outEdges) {
        if (!e.branch) continue;
        if (e.branch === res.branchId) continue;
        scope.deadEdges.add(e.id);
        prunedNow.push(e.target);
      }

      const label = res.branchId === DEFAULT_BRANCH
        ? '兜底分支'
        : res.branchId === null ? '无匹配（下游全部跳过）' : (res.rule?.label ?? res.branchId);

      outputs[id] = res.branchId ? `[条件] 走「${label}」` : '[条件] 无分支命中';
      branches.push({ id, branchId: res.branchId, label });
      emit({ type: 'branch-taken', id, branchId: res.branchId, label, pruned: prunedNow });
      emit({ type: 'node-done', id, ok: true, output: outputs[id], error: res.error ?? undefined });
      setStatus(id, res.error ? 'failed' : 'success');
      if (res.error) markFailed(id, scope);
      return;
    }

    /* ---------- 循环节点：解析迭代项，逐轮执行循环体 ---------- */
    if (isLoop(node.data)) {
      await runLoopNode(id, scope);
      return;
    }

    /* ---------- 更新检测节点：抓取 → 解析 → 与基线比对 ---------- */
    if (isUpdate(node.data)) {
      await runUpdateNode(id, scope);
      return;
    }

    /* ---------- 文件操作节点 ---------- */
    if (isFs(node.data)) {
      setStatus(id, 'running');
      const p = renderTemplate(node.data.path, { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields });
      const t = renderTemplate(node.data.target, { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields });
      const c = renderTemplate(node.data.content, { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields });

      if (!opts.fsExecutor) {
        const msg = '未提供文件操作执行器（当前可能运行在浏览器模式）';
        outputs[id] = '';
        emit({ type: 'node-done', id, ok: false, output: '', error: msg });
        markFailed(id, scope);
        setStatus(id, 'failed');
        return;
      }

      emit({ type: 'node-start', id, rendered: `${node.data.op} ${p.text}` });
      try {
        const out = await opts.fsExecutor(node, { path: p.text, target: t.text, content: c.text });
        outputs[id] = out;
        emit({ type: 'node-done', id, ok: true, output: out });
        setStatus(id, 'success');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: 'node-done', id, ok: false, output: '', error: msg });
        markFailed(id, scope);
        setStatus(id, 'failed');
      }
      await sleep(20);
      return;
    }

    /* ---------- OCR 节点 ---------- */
    if (isOcr(node.data)) {
      await runOcr(id, node, scope);
      await sleep(20);
      return;
    }

    /* ---------- 翻译节点 ---------- */
    if (isTranslate(node.data)) {
      await runTranslate(id, node, scope);
      await sleep(20);
      return;
    }

    /* ---------- GitHub 更新 / 推送 ---------- */
    if (isGithubUpdate(node.data)) {
      await runGithubUpdate(id, node, scope);
      return;
    }
    if (isGithubPush(node.data)) {
      await runGithubPush(id, node, scope);
      return;
    }

    /* ---------- 任务节点：渲染提示词并调 CLI ---------- */
    const { text: rendered, missing } = renderTemplate(node.data.prompt, {
      outputs, input: opts.input, loop: currentLoop(), fields: nodeFields,
    });
    if (missing.length > 0) {
      console.warn(`[${id}] 未解析的变量: ${missing.join(', ')}`);
    }

    setStatus(id, 'running');
    emit({ type: 'node-start', id, rendered });

    let acc = '';
    try {
      acc = await opts.executor(node, rendered, (chunk) => {
        acc += chunk;
        emit({ type: 'node-chunk', id, chunk });
      });
      outputs[id] = acc;

      /* ---------- 产出参数字段，供下游 {{id.xxx}} 引用 ---------- */
      const td = node.data as TaskNodeData;
      const refs = resolveFileRefs(td, acc);
      nodeFields[id] = {
        ...buildFileFields(refs),
        ...resolveParams(td.params, { output: acc, refs }),
      };
      emit({
        type: 'node-fields', id,
        files: refs.map((r) => r.abs),
        fields: nodeFields[id],
      });

      emit({ type: 'node-done', id, ok: true, output: acc });
      setStatus(id, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      /*
        失败时也要重置字段：不清的话下游会读到上一次成功运行留下的路径，
        拿着一个根本没改过的文件继续跑，比直接失败更难排查。
      */
      nodeFields[id] = { ...buildFileFields([]) };
      emit({ type: 'node-fields', id, files: [], fields: nodeFields[id] });
      emit({ type: 'node-done', id, ok: false, output: acc, error: msg });
      markFailed(id, scope);
      setStatus(id, 'failed');
    }
    await sleep(50);
  }

  /** 循环节点：解析项 → 逐轮跑循环体 → 汇总 */
  async function runLoopNode(id: string, scope: Scope): Promise<void> {
    const node = byId.get(id)!;
    const data = node.data as LoopNodeData;
    setStatus(id, 'running');

    const res: LoopResolve = resolveLoopItems(data, { outputs, input: opts.input });

    if (res.error) {
      outputs[id] = '';
      emit({ type: 'node-done', id, ok: false, output: '', error: res.error });
      markFailed(id, scope);
      setStatus(id, 'failed');
      loops.push({ id, rounds: 0, failed: 0, reason: res.reason, warnings: res.warnings });
      return;
    }

    emit({ type: 'loop-resolved', id, count: res.items.length, reason: res.reason, warnings: res.warnings });

    const bodyIds = orderByLayers(loopBodies.get(id) ?? []);
    const collected: string[] = [];
    let roundFailed = 0;
    /**
     * 实际执行的轮数。
     * 不能用 res.items.length —— 那是解析出的项数：
     * 用户中途取消、或 onError=stop 提前 break 时，
     * 会虚报成"共 1000 轮"。
     */
    let executed = 0;

    for (let i = 0; i < res.items.length; i++) {
      if (opts.signal?.aborted) break;
      executed += 1;
      const item = res.items[i];
      loopStack.push(makeLoopCtx(item, i, res.items.length));
      emit({ type: 'loop-iteration', id, index: i, item, count: res.items.length });

      // 每轮用独立作用域：上一轮被裁掉的边不影响本轮
      const iterScope: Scope = {
        deadEdges: new Set<string>(),
        skippedSet: new Set<string>(),
        failedSet: new Set<string>(),
      };
      await runScope(bodyIds, iterScope);

      try {
        if (data.collect) {
          const produced = bodyIds
            .map((b) => outputs[b] ?? '')
            .filter((s) => s.length > 0);
          if (produced.length > 0) collected.push(`#${i + 1} ${item}\n${produced.join('\n')}`);
        }

        if (iterScope.failedSet.size > 0) {
          roundFailed += 1;
          if (data.onError === 'stop') break;
        }
      } finally {
        // 出栈放在 finally：循环体抛异常时也不会把栈留脏
        loopStack.pop();
      }
    }

    const total = executed;
    const done = collected.length;
    outputs[id] = data.collect && collected.length > 0
      ? collected.join('\n\n')
      : `[循环] ${res.reason}，共 ${total} 轮`;

    const warn = res.warnings.length ? `；${res.warnings.join('；')}` : '';
    emit({ type: 'loop-done', id, rounds: total, failed: roundFailed });
    emit({
      type: 'node-done', id,
      ok: roundFailed === 0,
      output: outputs[id],
      error: roundFailed > 0 ? `${roundFailed}/${total} 轮失败${warn}` : undefined,
    });
    setStatus(id, roundFailed > 0 ? 'failed' : 'success');
    if (roundFailed > 0) markFailed(id, scope);
    loops.push({
      id, rounds: total, failed: roundFailed,
      reason: `${res.reason}，产出 ${done} 条${warn}`, warnings: res.warnings,
    });
  }

  /**
   * 更新检测节点。
   *
   * 输出是 true / false —— 直接给条件节点判断用。
   * 标题、链接等细节不走主输出（否则 `equals true` 就用不了），
   * 而是放进 nodeFields，通过 {{id.title}} 取。
   */
  async function runUpdateNode(id: string, scope: Scope): Promise<void> {
    const node = byId.get(id)!;
    const d = node.data as UpdateNodeData;
    setStatus(id, 'running');

    const headers: Record<string, string> = {};
    if (d.userAgent) headers['User-Agent'] = d.userAgent;
    if (d.source === 'bilibili' && d.biliCookie) {
      // 允许整条 Cookie 粘进来；只填 SESSDATA 时也能用
      headers.Cookie = /=/ .test(d.biliCookie) && !/^SESSDATA=/i.test(d.biliCookie)
        ? d.biliCookie
        : `SESSDATA=${d.biliCookie.replace(/^SESSDATA=/i, '')}`;
      headers.Referer = BILI_REFERER;
    }

    // 决定抓哪个地址
    let url = '';
    if (d.source === 'bilibili') {
      if (d.biliMode === 'rss') {
        url = d.feedUrl.trim();
        if (!url) {
          fail('RSS 模式需要填订阅源地址');
          return;
        }
      } else {
        const uid = extractBiliUid(d.biliUid);
        if (!uid) {
          fail('填一个 UP 主 UID 或 space.bilibili.com 主页链接');
          return;
        }
        url = biliApiUrl(uid);
      }
    } else {
      url = d.feedUrl.trim();
      if (!url) {
        fail('需要填订阅源地址。公众号没有官方接口，请用 wechat2rss / RSSHub 等生成');
        return;
      }
    }

    // 渲染模板：允许用上游输出拼地址
    const renderedUrl = renderTemplate(url, { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields }).text;

    if (!opts.fetcher) {
      fail('未提供网络抓取执行器（当前可能运行在浏览器模式）');
      return;
    }

    emit({ type: 'node-start', id, rendered: `GET ${renderedUrl}` });

    let text: string;
    try {
      text = await opts.fetcher(node, renderedUrl, {
        headers,
        timeoutSec: d.timeoutSec,
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }

    // 解析：B站接口按 JSON，其余按 RSS/Atom
    const parsed = d.source === 'bilibili' && d.biliMode === 'api'
      ? parseBiliApi(text)
      : parseFeed(text);

    if (parsed.error) {
      fail(parsed.error);
      return;
    }

    const items = sortByNewest(parsed.items);
    const res = detectUpdate({
      items,
      lastSeenId: d.lastSeenId,
      firstRunAsUpdate: d.firstRunAsUpdate,
    });

    const latest: FeedItem | null = res.latest;
    const out = d.outputFormat === 'bool'
      ? String(res.updated)
      : (res.updated
          ? `true\n标题: ${latest?.title ?? ''}\n链接: ${latest?.url ?? ''}\n时间: ${latest?.date ?? ''}`
          : `false\n${latest ? `最新仍是: ${latest.title}` : '无更新'}`);

    outputs[id] = out;
    const item = latest;
    nodeFields[id] = {
      title: item?.title ?? '',
      url: item?.url ?? '',
      date: item?.date ?? '',
      updated: String(res.updated),
    };

    emit({
      type: 'update-checked',
      id,
      updated: res.updated,
      item,
      reason: res.reason,
      baseline: res.baseline,
      // 基线只在"确实看到了最新条目"时才推进，解析失败时保持原值
      patch: {
        lastSeenId: item?.id ?? d.lastSeenId,
        lastSeenTitle: item?.title ?? d.lastSeenTitle,
        lastCheckedAt: Date.now(),
        lastUpdated: res.updated,
      },
    });

    const warn = parsed.warnings.length ? `；${parsed.warnings.join('；')}` : '';
    emit({ type: 'node-done', id, ok: true, output: out, error: warn || undefined });
    setStatus(id, 'success');

    function fail(msg: string) {
      outputs[id] = 'false';
      nodeFields[id] = { title: '', url: '', date: '', updated: 'false' };
      emit({ type: 'node-done', id, ok: false, output: 'false', error: msg });
      markFailed(id, scope);
      setStatus(id, 'failed');
    }
  }


/**
 * 决定这个节点"改了哪些文件"。
 *
 * 手动模式优先：自动识别是尽力而为，一旦用户明确指定了路径，
 * 就应该完全信任用户的输入，不再从输出里猜。
 */
function resolveFileRefs(d: TaskNodeData, output: string): FileRef[] {
  const cfg = d.fileOutput ?? defaultFileOutput();
  if (!cfg.enabled) return [];
  if (cfg.mode === 'manual') return parseManualPaths(cfg.manualPaths, d.workdir);
  return extractFileRefs(output, d.workdir);
}


  /* ================================================================ */
  /* OCR 节点                                                          */
  /* ================================================================ */

  async function runOcr(id: string, node: GraphNode, scope: Scope): Promise<void> {
    const d = node.data as OcrNodeData;
    setStatus(id, 'running');

    const prompt = renderTemplate(
      (d.prompt ?? '').trim() || defaultOcrPrompt(),
      { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields },
    ).text;
    const rawUrl = renderTemplate(d.url ?? '', { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields }).text;
    const rawPath = renderTemplate(d.path ?? '', { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields }).text;

    /*
      图片地址要在使用前决定，因为两种来源的失败提示完全不同：
      URL 只要拼字符串，本地文件还要读盘转 base64。
    */
    let imageUrl = '';
    if (d.imageSource === 'file') {
      const p = rawPath.trim();
      if (!p) {
        failOcr('图片来源选的是「本地文件」，但没有填路径');
        return;
      }
      if (!opts.imageReader) {
        failOcr('当前环境无法读取本地图片（浏览器模式不支持，请用桌面端运行）');
        return;
      }
      emit({ type: 'node-start', id, rendered: `读取本地图片 ${p}` });
      try {
        imageUrl = await opts.imageReader(p);
      } catch (err) {
        failOcr(err instanceof Error ? err.message : String(err));
        return;
      }
    } else {
      imageUrl = rawUrl.trim();
      if (!imageUrl) {
        failOcr('图片来源选的是「网络地址」，但没有填地址');
        return;
      }
      if (!isUsableImageUrl(imageUrl)) {
        failOcr(`图片地址无效：${imageUrl.slice(0, 80)}。需要 http(s) 开头，或 data:image/ 开头`);
        return;
      }
    }

    const cfg = resolveConfig(d.llm);
    const parts: ContentPart[] = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: imageUrl, detail: d.detail } },
    ];
    const messages: ChatMessage[] = [{ role: 'user', content: parts }];

    const body = { model: cfg.model, messages, temperature: 0, stream: false };
    emit({ type: 'node-start', id, rendered: `OCR ${cfg.model} · ${prompt.slice(0, 60)}` });

    if (!opts.llmCaller) {
      failOcr('未提供大模型调用执行器（当前可能运行在浏览器模式）');
      return;
    }

    let res: LlmCallResult;
    try {
      res = await opts.llmCaller({
        url: cfg.url,
        headers: buildHeaders(cfg.apiKey),
        body,
        timeoutSec: cfg.timeoutSec,
      });
    } catch (err) {
      failOcr(err instanceof Error ? err.message : String(err));
      return;
    }

    const parsed = parseResponse(res.status, res.text);
    if (!parsed.ok) {
      failOcr(parsed.error);
      return;
    }

    const text = parsed.text.trim();
    outputs[id] = text;
    nodeFields[id] = { text, chars: String(text.length) };
    emit({ type: 'node-done', id, ok: true, output: text });
    setStatus(id, 'success');

    function failOcr(msg: string) {
      outputs[id] = '';
      nodeFields[id] = { text: '', chars: '0' };
      emit({ type: 'node-done', id, ok: false, output: '', error: msg });
      markFailed(id, scope);
      setStatus(id, 'failed');
    }
  }

  /* ================================================================ */
  /* 翻译节点                                                          */
  /* ================================================================ */

  /* ---------- GitHub 更新节点 ---------- */
  async function runGithubUpdate(id: string, node: GraphNode, scope: Scope): Promise<void> {
    const d = node.data as GithubUpdateNodeData;
    setStatus(id, 'running');

    const owner = renderTemplate(d.owner ?? '', {
      outputs, input: opts.input, loop: currentLoop(), fields: nodeFields,
    }).text.trim();
    const repo = renderTemplate(d.repo ?? '', {
      outputs, input: opts.input, loop: currentLoop(), fields: nodeFields,
    }).text.trim();

    if (!opts.githubFetch) {
      setStatus(id, 'failed');
      outputs[id] = 'false';
      emit({ type: 'node-error', id, error: '未提供 GitHub 拉取执行器' });
      return;
    }
    if (!owner || !repo) {
      setStatus(id, 'failed');
      outputs[id] = 'false';
      emit({ type: 'node-error', id, error: '缺少 owner 或 repo' });
      return;
    }

    try {
      const r = await opts.githubFetch({
        owner, repo,
        branch: d.branch || undefined,
        base: d.base || undefined,
        order: d.order,
        token: d.token || '',
      });
      if (!r.ok || !r.info) {
        setStatus(id, 'failed');
        outputs[id] = 'false';
        emit({ type: 'node-error', id, error: r.error || '拉取失败' });
        return;
      }
      const info = r.info;
      // 主输出是 bool，好让条件节点直接判「等于 true」
      outputs[id] = info.updated ? 'true' : 'false';
      nodeFields[id] = {
        sha: info.sha,
        branch: info.branch,
        message: info.message,
        author: info.author,
        date: info.date,
        via: r.via || '',
      };
      setStatus(id, 'success');
      emit({ type: 'node-done', id, output: outputs[id] });
    } catch (e) {
      setStatus(id, 'failed');
      outputs[id] = 'false';
      emit({ type: 'node-error', id, error: String(e) });
    }
  }

  /* ---------- GitHub 推送节点 ---------- */
  async function runGithubPush(id: string, node: GraphNode, scope: Scope): Promise<void> {
    const d = node.data as GithubPushNodeData;
    setStatus(id, 'running');

    const tpl = (x: string) =>
      renderTemplate(x ?? '', {
        outputs, input: opts.input, loop: currentLoop(), fields: nodeFields,
      }).text;

    const owner = tpl(d.owner).trim();
    const repo = tpl(d.repo).trim();

    if (!opts.githubPush) {
      setStatus(id, 'failed');
      emit({ type: 'node-error', id, error: '未提供 GitHub 推送执行器' });
      return;
    }
    if (!owner || !repo) {
      setStatus(id, 'failed');
      emit({ type: 'node-error', id, error: '缺少 owner 或 repo' });
      return;
    }

    // 每行一条 `路径 = 内容来源`；等号后的内容走模板渲染
    const files: { path: string; content: string }[] = [];
    for (const line of (d.filesText || '').split('\n')) {
      const raw = line.trim();
      if (!raw) continue;
      const eq = raw.indexOf('=');
      if (eq < 0) {
        setStatus(id, 'failed');
        emit({ type: 'node-error', id, error: `文件行缺等号：${raw}` });
        return;
      }
      files.push({ path: raw.slice(0, eq).trim(), content: tpl(raw.slice(eq + 1)) });
    }
    if (files.length === 0) {
      setStatus(id, 'failed');
      emit({ type: 'node-error', id, error: '没有要提交的文件' });
      return;
    }

    try {
      const r = await opts.githubPush({
        owner, repo,
        branch: d.branch || 'main',
        message: tpl(d.message),
        files,
        workdir: d.workdir || undefined,
        order: d.order,
        token: d.token || '',
      });
      if (!r.ok) {
        setStatus(id, 'failed');
        emit({ type: 'node-error', id, error: r.error || '推送失败' });
        return;
      }
      outputs[id] = r.commit ? `已提交 ${r.commit}` : '已推送';
      nodeFields[id] = { commit: r.commit || '', via: r.via || '' };
      setStatus(id, 'success');
      emit({ type: 'node-done', id, output: outputs[id] });
    } catch (e) {
      setStatus(id, 'failed');
      emit({ type: 'node-error', id, error: String(e) });
    }
  }

  async function runTranslate(id: string, node: GraphNode, scope: Scope): Promise<void> {
    const d = node.data as TranslateNodeData;
    setStatus(id, 'running');

    const src = renderTemplate(d.text ?? '', {
      outputs, input: opts.input, loop: currentLoop(), fields: nodeFields,
    }).text;

    if (!src.trim()) {
      failTranslate('待翻译文本为空。检查上游输出，或直接在节点里填写');
      return;
    }

    const target = (d.targetLang ?? '').trim();
    if (!target) {
      failTranslate('未指定目标语言');
      return;
    }

    // 允许填 "日语" 这种中文，也允许填 "ja"
    const preset = TARGET_LANGS.find((l) => l.code === target);
    const targetText = preset ? preset.label : target;

    const sourceLang = (d.sourceLang ?? 'auto').trim() || 'auto';
    const system = buildTranslateSystem(
      targetText,
      sourceLang === 'auto' ? '' : sourceLang,
      d.glossary,
    );

    const cfg = resolveConfig(d.llm);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: src },
    ];
    const body = { model: cfg.model, messages, temperature: 0.2, stream: false };

    emit({ type: 'node-start', id, rendered: `翻译 → ${targetText}（${src.length} 字）` });

    if (!opts.llmCaller) {
      failTranslate('未提供大模型调用执行器（当前可能运行在浏览器模式）');
      return;
    }

    let res: LlmCallResult;
    try {
      res = await opts.llmCaller({
        url: cfg.url,
        headers: buildHeaders(cfg.apiKey),
        body,
        timeoutSec: cfg.timeoutSec,
      });
    } catch (err) {
      failTranslate(err instanceof Error ? err.message : String(err));
      return;
    }

    const parsed = parseResponse(res.status, res.text);
    if (!parsed.ok) {
      failTranslate(parsed.error);
      return;
    }

    const text = parsed.text.trim();
    outputs[id] = text;
    nodeFields[id] = { text, chars: String(text.length) };
    emit({ type: 'node-done', id, ok: true, output: text });
    setStatus(id, 'success');

    function failTranslate(msg: string) {
      outputs[id] = '';
      nodeFields[id] = { text: '', chars: '0' };
      emit({ type: 'node-done', id, ok: false, output: '', error: msg });
      markFailed(id, scope);
      setStatus(id, 'failed');
    }
  }

  /* ---------- 主流程：跳过循环体成员，它们由各自的循环执行 ---------- */
  const mainIds = orderByLayers(
    graph.nodes.map((n) => n.id).filter((id) => !bodyNodeSet.has(id)),
  );
  await runScope(mainIds, globalScope);

  const ok = failed.length === 0;
  emit({ type: 'run-done', ok });
  return { ok, outputs, failed, skipped, branches, parallels, loops };
}
