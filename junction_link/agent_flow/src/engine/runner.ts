import type { Graph, GraphNode, NodeStatus } from '../types';
import { isCondition, isTrigger, isParallel, DEFAULT_BRANCH } from '../types';
import { topoLayers } from './topo';
import { renderTemplate } from './template';
import { evaluateCondition } from './condition';
import { resolveParallel, effectiveConcurrency, MAX_CONCURRENCY } from './parallel';

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
  | { type: 'run-done'; ok: boolean }
  | { type: 'run-error'; message: string };

/** 执行一个任务节点，返回完整输出；抛错即视为失败 */
export type Executor = (
  node: GraphNode,
  renderedPrompt: string,
  onChunk: (chunk: string) => void,
) => Promise<string>;

export type RunOptions = {
  /** 同层并发上限。设为 1 即严格串行 */
  concurrency: number;
  executor: Executor;
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
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一条分支判定记录 */
type BranchRecord = { id: string; branchId: string | null; label: string };

/** 并发节点的解析记录 */
type ParallelRecord = { id: string; concurrency: number; reason: string };

/**
 * 分层执行 DAG，支持条件分支剪枝。
 *
 * 三条核心规则：
 *  1. 上游失败 → 下游跳过（skip 会继续向下传播，孙节点不会拿空输入白跑）
 *  2. 条件节点只走命中的那条分支，其余分支的**整条下游链路**被裁掉（pruned）
 *  3. 剪枝 ≠ 失败：被裁掉的分支不计入 failed，也不算工作流出错
 *
 * 关于多入边节点的取舍：只要有一条入边"还活着"就执行（OR 语义）。
 * 这样分支后汇合的场景里，走任一分支都能继续往下跑。
 */
export async function runGraph(graph: Graph, opts: RunOptions): Promise<RunSummary> {
  const { layers, cyclic } = topoLayers(graph);
  const emit = opts.onEvent;

  if (cyclic.length > 0) {
    emit({ type: 'run-error', message: `检测到环，无法执行：${cyclic.join(' → ')}` });
    return { ok: false, outputs: {}, failed: cyclic, skipped: [], branches: [], parallels: [] };
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outputs: Record<string, string> = {};
  const failed: string[] = [];
  const skipped: string[] = [];
  const branches: BranchRecord[] = [];
  const parallels: ParallelRecord[] = [];

  const failedSet = new Set<string>();
  /** 因分支未命中/上游跳过而未执行的节点。剪枝 ≠ 失败，不计入 failed */
  const skippedSet = new Set<string>();
  /**
   * 被条件分支裁掉的边（按边 id）。
   * 用「边」而不是「节点」的原因是：一个节点可能有多条入边，
   * 只有全部入边都失效时它才该被跳过（分支汇合场景走任一分支都要继续）。
   */
  const deadEdges = new Set<string>();

  const setStatus = (id: string, status: NodeStatus) =>
    emit({ type: 'node-status', id, status });

  /**
   * 每个节点继承到的并发度。
   *
   * 传播规则：默认用全局 opts.concurrency；
   * 上游是并发节点时，取该并发节点解析出的值；
   * 多入边时取**最小**的那个（保守，避免超发请求）。
   */
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

  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    if (opts.signal?.aborted) break;

    emit({ type: 'layer-start', layer: li, total: layers.length, ids: layer });

    // 先挑出本层可执行的节点
    const runnable: string[] = [];
    for (const id of layer) {
      const inEdges = graph.edges.filter((e) => e.target === id);

      // 无入边 → 起点，直接执行
      if (inEdges.length === 0) {
        runnable.push(id);
        setStatus(id, 'pending');
        continue;
      }

      // 任一上游失败 → 算失败并向下传播
      if (inEdges.some((e) => failedSet.has(e.source))) {
        skipped.push(id);
        failedSet.add(id);
        setStatus(id, 'skipped');
        continue;
      }

      // 所有入边都失效（被裁 / 上游被跳过 / 上游失败）→ 这条路没走，跳过但不算失败
      const allDead = inEdges.every(
        (e) => deadEdges.has(e.id) || skippedSet.has(e.source) || failedSet.has(e.source),
      );
      if (allDead) {
        skipped.push(id);
        skippedSet.add(id);
        setStatus(id, 'skipped');
        continue;
      }

      runnable.push(id);
      setStatus(id, 'pending');
    }

    // 按各自继承到的并发度分组：同组并发跑，组间串行。
    // 这样语义可预测——不会出现"说好串行却因为隔壁组并发而超发"的情况。
    const groups = new Map<number, string[]>();
    for (const id of runnable) {
      const c = inheritConcurrency(id);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c)!.push(id);
    }

    for (const [groupConc, ids] of groups) {
    const queue = [...ids];
      // 'all' 模式解析出的并发数是 Infinity，直接 Array.from 会 RangeError。
      // 用 effectiveConcurrency 收敛到「本组任务数」和全局上限之间。
      const workerCount = effectiveConcurrency(groupConc, ids.length);
      const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        if (opts.signal?.aborted) return;
        const id = queue.shift()!;
        const node = byId.get(id)!;

        /* ---------- 触发器节点：只是起点标记，不调 CLI ---------- */
        if (isTrigger(node.data)) {
          setStatus(id, 'running');
          outputs[id] = opts.input ?? '';
          emit({ type: 'node-done', id, ok: true, output: outputs[id] });
          setStatus(id, 'success');
          continue;
        }

        /* ---------- 并发节点：解析并发度，影响下游 ---------- */
        if (isParallel(node.data)) {
          setStatus(id, 'running');
          const upstream = graph.edges.filter((e) => e.target === id).map((e) => e.source);
          const text = upstream.length > 0
            ? upstream.map((u) => outputs[u] ?? '').join('\n')
            : (opts.input ?? '');

          const res = resolveParallel(node.data, text);
          // 写入本节点并发度；下游通过 inheritConcurrency 继承
          concOf.set(id, res.concurrency);
          outputs[id] = `[并发] ${res.reason}`;
          // Infinity 过 JSON 会变 null，落到记录里用上限表示"不限"
          const recorded = Number.isFinite(res.concurrency) ? res.concurrency : MAX_CONCURRENCY;
          parallels.push({ id, concurrency: recorded, reason: res.reason });
          emit({ type: 'parallel-resolved', id, concurrency: recorded, reason: res.reason });
          emit({ type: 'node-done', id, ok: true, output: outputs[id], error: res.errors.length ? res.errors.join('；') : undefined });
          setStatus(id, res.errors.length > 0 ? 'failed' : 'success');
          if (res.errors.length > 0) {
            failed.push(id);
            failedSet.add(id);
            skippedSet.add(id);
          }
          continue;
        }

        /* ---------- 条件节点：只求值，不调 CLI ---------- */
        if (isCondition(node.data)) {
          setStatus(id, 'running');
          const upstream = graph.edges.filter((e) => e.target === id).map((e) => e.source);
          const res = evaluateCondition(node.data, { outputs, input: opts.input, upstream });

          const outEdges = graph.edges.filter((e) => e.source === id);

          // 把没走到的分支边标记为失效；未标注 branch 的普通出边视为无条件，始终保留
          const prunedNow: string[] = [];
          for (const e of outEdges) {
            if (!e.branch) continue;
            if (e.branch === res.branchId) continue;
            deadEdges.add(e.id);
            prunedNow.push(e.target);
          }

          const label = res.branchId === DEFAULT_BRANCH
            ? '兜底分支'
            : res.branchId === null ? '无匹配（下游全部跳过）' : (res.rule?.label ?? res.branchId);

          outputs[id] = res.branchId
            ? `[条件] 走「${label}」`
            : '[条件] 无分支命中';

          branches.push({ id, branchId: res.branchId, label });
          emit({ type: 'branch-taken', id, branchId: res.branchId, label, pruned: prunedNow });
          emit({ type: 'node-done', id, ok: true, output: outputs[id], error: res.error ?? undefined });
          setStatus(id, res.error ? 'failed' : 'success');
          if (res.error) {
            failed.push(id);
            failedSet.add(id);
          }
          continue;
        }

        /* ---------- 任务节点：渲染提示词并调 CLI ---------- */
        const { text: rendered, missing } = renderTemplate(node.data.prompt, {
          outputs,
          input: opts.input,
        });
        if (missing.length > 0) {
          // 引用了非上游节点：不阻断，但把未解析的原样留给 CLI
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
          failed.push(id);
          failedSet.add(id);
          skippedSet.add(id);
          emit({ type: 'node-done', id, ok: false, output: acc, error: msg });
          setStatus(id, 'failed');
        }
        // 轻量节流，避免瞬间打满 CLI 的限频窗口
        await sleep(50);
      }
    });
    await Promise.all(workers);
    }
  }

  // 剪枝导致的跳过不算失败
  const ok = failed.length === 0;
  emit({ type: 'run-done', ok });
  return { ok, outputs, failed, skipped, branches, parallels };
}
