import type { Graph, GraphNode, NodeStatus, LoopCtx, LoopNodeData } from '../types';
import {
  isCondition, isTrigger, isParallel, isLoop, isFs, DEFAULT_BRANCH,
} from '../types';
import { topoLayers } from './topo';
import { renderTemplate } from './template';
import { evaluateCondition } from './condition';
import { resolveParallel, effectiveConcurrency, MAX_CONCURRENCY } from './parallel';
import { resolveLoopItems, makeLoopCtx, collectLoops, type LoopResolve } from './loop';

export type RunEvent =
  | { type: 'layer-start'; layer: number; total: number; ids: string[] }
  | { type: 'node-start'; id: string; rendered: string }
  | { type: 'node-chunk'; id: string; chunk: string }
  | { type: 'node-done'; id: string; ok: boolean; output: string; error?: string }
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
  | { type: 'run-done'; ok: boolean }
  | { type: 'run-error'; message: string };

/** 执行一个任务节点，返回完整输出；抛错即视为失败 */
export type Executor = (
  node: GraphNode,
  renderedPrompt: string,
  onChunk: (chunk: string) => void,
) => Promise<string>;

/** 执行文件操作，返回展示用的结果文本；抛错即视为失败 */
export type FsExecutor = (
  node: GraphNode,
  args: { path: string; target: string; content: string },
) => Promise<string>;

export type RunOptions = {
  /** 同层并发上限。设为 1 即严格串行 */
  concurrency: number;
  executor: Executor;
  /** 文件操作执行器；不提供时文件节点会直接失败并提示 */
  fsExecutor?: FsExecutor;
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

  /** 循环迭代上下文，供模板渲染 {{loop.item}} 等 */
  let loopCtx: LoopCtx | null = null;

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

    /* ---------- 文件操作节点 ---------- */
    if (isFs(node.data)) {
      setStatus(id, 'running');
      const p = renderTemplate(node.data.path, { outputs, input: opts.input, loop: loopCtx });
      const t = renderTemplate(node.data.target, { outputs, input: opts.input, loop: loopCtx });
      const c = renderTemplate(node.data.content, { outputs, input: opts.input, loop: loopCtx });

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

    /* ---------- 任务节点：渲染提示词并调 CLI ---------- */
    const { text: rendered, missing } = renderTemplate(node.data.prompt, {
      outputs, input: opts.input, loop: loopCtx,
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
      emit({ type: 'node-done', id, ok: true, output: acc });
      setStatus(id, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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

    for (let i = 0; i < res.items.length; i++) {
      if (opts.signal?.aborted) break;
      const item = res.items[i];
      loopCtx = makeLoopCtx(item, i, res.items.length);
      emit({ type: 'loop-iteration', id, index: i, item, count: res.items.length });

      // 每轮用独立作用域：上一轮被裁掉的边不影响本轮
      const iterScope: Scope = {
        deadEdges: new Set<string>(),
        skippedSet: new Set<string>(),
        failedSet: new Set<string>(),
      };
      await runScope(bodyIds, iterScope);

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
    }
    loopCtx = null;

    const total = res.items.length;
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

  /* ---------- 主流程：跳过循环体成员，它们由各自的循环执行 ---------- */
  const mainIds = orderByLayers(
    graph.nodes.map((n) => n.id).filter((id) => !bodyNodeSet.has(id)),
  );
  await runScope(mainIds, globalScope);

  const ok = failed.length === 0;
  emit({ type: 'run-done', ok });
  return { ok, outputs, failed, skipped, branches, parallels, loops };
}
