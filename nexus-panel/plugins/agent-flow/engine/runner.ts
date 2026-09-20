import type {
  Graph, GraphNode, NodeStatus, LoopCtx, LoopNodeData, UpdateNodeData, TaskNodeData,
  OcrNodeData, TranslateNodeData, GithubUpdateNodeData, GithubPushNodeData,
} from '../types';
import {
  isCondition, isTrigger, isParallel, isLoop, isFs, isUpdate, isOcr, isTranslate,
  isGithubUpdate, isGithubPush,
  DEFAULT_BRANCH, defaultFileOutput, defaultOcrPrompt,
} from '../types';
import { resolveSecret, type Credential } from './credentials';
import { topoLayers } from './topo';
import { getRunner } from './runnerRegistry';
import type { RunContext } from './runContext';
import { renderTemplate } from './template';
import { inputValueFor, chainOutputAbove } from './stack';
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

import type {
  RunEvent, RunOptions, RunSummary, Scope, BranchRecord, ParallelRecord, LoopRecord,
  Executor, Fetcher, LlmCaller, LlmCallResult, ImageReader, FsExecutor,
  GithubUpdateRunner, GithubPushRunner, GithubUpdateInfo, HttpRequester,
} from './runTypes';
export type {
  RunEvent, RunOptions, RunSummary, Scope, BranchRecord, ParallelRecord, LoopRecord,
  Executor, Fetcher, LlmCaller, LlmCallResult, ImageReader, FsExecutor,
  GithubUpdateRunner, GithubPushRunner, GithubUpdateInfo, HttpRequester,
} from './runTypes';

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runGraph(graph: Graph, opts: RunOptions): Promise<RunSummary> {
  const { layers, cyclic } = topoLayers(graph);
  const emit = opts.onEvent;

  if (cyclic.length > 0) {
    emit({ type: 'run-error', message: `检测到环，无法执行：${cyclic.join(' → ')}` });
    return {
      ok: false, outputs: {}, failed: cyclic, skipped: [],
      branches: [], parallels: [], loops: [], vars: {},
    };
  }

  const runStartedAt = Date.now();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outputs: Record<string, string> = {};
  /*
   * 工作流变量表。跨节点共享，{{var.名字}} 可读。
   *
   * 与 outputs 的区别：outputs 是"某个节点产出了什么"（id → 结果），
   * vars 是"流程自己记了什么"（名字 → 值）。
   * 后者能解决 outputs 解决不了的问题 ——
   * 下游要拿上游**很远**的值时，{{id.output}} 得知道那个 id，
   * 而流程一改 id 就变了；用变量存一个名字则稳定得多。
   */
  const vars: Record<string, string> = {};
  /*
   * 停止信号。由「停止」节点写入。
   *
   * 'all' = 整个流程到此为止（Scratch 的"停止全部脚本"）
   * 'branch' = 只掐掉当前这条分支，别的分支照跑
   */
  let stopAll = false;
  /*
   * 「停止这条分支」的起点。
   *
   * 第一版写成了"停掉当前 scope"，那是错的 ——
   * 单纯的分叉（A 同时连向 B 和 C）共用同一个全局 scope，
   * 停一条会把另一条也停了，而这正是用户不期望的。
   *
   * 正确的粒度是**停止节点自己的下游链路**：
   * 从它出发沿边能走到的都停，走不到的照跑。
   */
  const stoppedRoots = new Set<string>();
  let stoppedDownstream: Set<string> | null = null;

  /** 从停止节点出发，沿正向边能走到的全部节点（含自身） */
  const computeStoppedDownstream = (): Set<string> => {
    const out = new Set<string>();
    const adj = new Map<string, string[]>();
    for (const e of graph.edges) {
      const cur = adj.get(e.source);
      if (cur) cur.push(e.target);
      else adj.set(e.source, [e.target]);
    }
    const stack = [...stoppedRoots];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (out.has(id)) continue;
      out.add(id);
      for (const nxt of adj.get(id) ?? []) stack.push(nxt);
    }
    return out;
  };
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
      // 停止全部：整个流程到此为止
      if (stopAll) return;
      // 停止这条分支：掐掉停止节点的下游链路，别的分支不受影响
      if (stoppedRoots.size > 0) {
        if (!stoppedDownstream) stoppedDownstream = computeStoppedDownstream();
      }

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
            if (stopAll) return;
            const id = queue.shift()!;
            /*
             * 在停止节点的下游链路上 → 跳过。
             * 不计入 skipped 也不算失败 —— "主动停下的"与"没跑成的"是两回事，
             * 混在一起会让日志里出现一堆红色，排查时会往错误方向找。
             */
            if (stoppedDownstream && stoppedDownstream.has(id)) continue;
            await runNode(id, scope);
          }
        });
        await Promise.all(workers);
      }
    }
  }
  /**
   * 组装交给节点执行器的上下文。
   *
   * 闭包里的这些变量执行器拿不到（它们在 engine/runners/ 下，是独立模块），
   * 只能在这里打包一份递过去。markFailed/markSkipped 包一层是为了让
   * 执行器可以省略 scope 参数 —— 绝大多数调用就是当前作用域。
   */
  /*
   * 嵌合链的输出传递。
   * 只在真的有嵌合关系时才算 —— 绝大多数流程不用它，
   * 没必要每次渲染都遍历一遍节点。
   */
  const hasStack = (opts.stackNodes ?? []).some((n) => String((n.data as Record<string, unknown>)?.stackParent ?? '') !== '');
  const stackNodes = (opts.stackNodes ?? []) as Array<{
    id: string; position: { x: number; y: number }; data?: Record<string, unknown>;
  }>;
  const stackOf = (id: string): { directOutput?: string; chainOutput?: string } | undefined => {
    if (!hasStack) return undefined;
    const self = stackNodes.find((n) => n.id === id);
    if (!self || !String(self.data?.stackParent ?? '')) return undefined;
    return {
      directOutput: inputValueFor(stackNodes, id, outputs, opts.input),
      chainOutput: chainOutputAbove(stackNodes, id, outputs),
    };
  };

  const makeCtx = (id: string, node: GraphNode, scope: Scope): RunContext => ({
    id, node, graph, opts, scope, runStartedAt,
    emit, setStatus, sleep,
    markFailed: (i, s) => markFailed(i, s ?? scope),
    markSkipped: (i, s) => markSkipped(i, s ?? scope),
    outputs, nodeFields, currentLoop,
    /*
     * 模板渲染统一在这里带上上下文，执行器直接 ctx.tpl(x) 即可。
     *
     * 未解析变量的告警也在这一层处理：原先只有任务节点自己 warn，
     * 其他节点引用了不存在的变量则完全没提示。下沉后所有节点自动
     * 获得这个能力 —— 以后要改成发事件、或改成可配置的严格模式
     * （缺失即失败），也只需要动这一处。
     */
    vars,
    /*
     * 发起停止。
     *
     * 不直接抛异常 —— 抛出的话当前节点会被记成 failed，
     * 而"用户/流程主动停下"不是失败，日志里显示成红色会误导排查。
     */
    requestStop: (mode) => {
      if (mode === 'all') {
        stopAll = true;
        return;
      }
      stoppedRoots.add(id);
      // 新加了一个停止点，缓存失效
      stoppedDownstream = null;
    },
    /** 停下来了吗（供节点决定要不要继续做无用功） */
    isStopped: () => {
      if (stopAll) return true;
      if (stoppedRoots.size === 0) return false;
      if (!stoppedDownstream) stoppedDownstream = computeStoppedDownstream();
      return stoppedDownstream.has(id);
    },
    /*
     * 等人填东西。
     *
     * 没有提供实现时返回 null，由执行器转成明确的失败 ——
     * 静默返回空串会让下游拿着空值继续跑，那比报错难查。
     */
    askHuman: async (promptText, defaultValue) => {
      if (!opts.askHuman) return null;
      return opts.askHuman(promptText, defaultValue);
    },
    tpl: (text) => {
      const r = renderTemplate(text, {
        outputs, input: opts.input, loop: currentLoop(), fields: nodeFields, vars,
        params: opts.params,
        /*
         * 嵌合带来的 {{input}} / {{chain.output}}。
         * 没有嵌合关系时两者都不传 —— {{input}} 回落到全局输入，
         * {{chain.output}} 视为未解析（保留原样提示）。
         */
        stackInput: stackOf(id)?.directOutput,
        chainOutput: stackOf(id)?.chainOutput,
      });
      if (r.missing.length > 0) {
        console.warn(`[${id}] 未解析的变量: ${r.missing.join(', ')}`);
      }
      return r.text;
    },
    branches, parallels, loops,
    byId, bodyNodeSet, loopBodies, orderByLayers, inheritConcurrency,
    setConcurrency: (i, v) => concOf.set(i, v),
    runNode, runScope, loopStack,
  });


  /** 执行单个节点，按类型分派 */
  async function runNode(id: string, scope: Scope): Promise<void> {
    const node = byId.get(id)!;

    /* ================================================================
     * 按注册表分发。
     *
     * 以前这里是一条 isXxx() 的 if 链，加一种节点就要在这里再插一段，
     * 并且执行逻辑也得写进本文件的闭包里（本文件一度 1100 行）。
     * 现在每种节点的执行器由它自己的节点定义提供，本文件只负责组装上下文。
     * ================================================================ */
    const run = getRunner(node.data);
    if (run) {
      await run(makeCtx(id, node, scope));
      return;
    }
    /*
     * 没有执行器的节点（纯编排占位、或本机未注册的自定义节点）：
     * 直通而不是报错 —— 一个不该执行的节点不该让整条工作流失败，
     * 但也不假装成功产出内容，输出留空便于下游判断。
     */
    outputs[id] = '';
    setStatus(id, 'success');
    emit({ type: 'node-done', id, ok: true, output: '' });
  }

  /* ---------- 主流程：跳过循环体成员，它们由各自的循环执行 ---------- */
  const mainIds = orderByLayers(
    graph.nodes.map((n) => n.id).filter((id) => !bodyNodeSet.has(id)),
  );
  await runScope(mainIds, globalScope);

  const ok = failed.length === 0;
  emit({ type: 'run-done', ok });
  return { ok, outputs, failed, skipped, branches, parallels, loops, vars };
}
