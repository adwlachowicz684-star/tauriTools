import type {
  GraphNode, NodeStatus, LoopCtx, LoopNodeData, UpdateNodeData, TaskNodeData,
  OcrNodeData, TranslateNodeData, GithubUpdateNodeData, GithubPushNodeData,
  FsNodeData, ConditionNodeData, ParallelNodeData, TriggerNodeData,
} from '../../types';
import { DEFAULT_BRANCH, defaultFileOutput, defaultOcrPrompt } from '../../types';
import { resolveSecret } from '../credentials';
import { renderTemplate } from '../template';
import { extractFileRefs, parseManualPaths, buildFileFields, type FileRef } from '../files';
import {
  resolveConfig, buildHeaders, parseResponse, extractContent,
  buildTranslateSystem, TARGET_LANGS, isUsableImageUrl,
  type ChatMessage, type ContentPart,
} from '../llm';
import { resolveParams } from '../params';
import { evaluateCondition } from '../condition';
import { resolveParallel, effectiveConcurrency, MAX_CONCURRENCY } from '../parallel';
import { resolveLoopItems, makeLoopCtx, type LoopResolve } from '../loop';
import {
  parseFeed, parseBiliApi, detectUpdate, sortByNewest, extractBiliUid, biliApiUrl,
  BILI_REFERER, type FeedItem,
} from '../updates';
import type { RunContext } from '../runContext';

export async function runCondition(ctx: RunContext): Promise<void> {
  const {
    id, node, graph, opts, scope, emit, setStatus, markFailed, markSkipped, sleep,
    outputs, nodeFields, currentLoop, branches, parallels, loops, byId,
    loopBodies, orderByLayers, loopStack, setConcurrency,
  } = ctx;

    setStatus(id, 'running');
    const upstream = graph.edges.filter((e) => e.target === id).map((e) => e.source);
    const res = evaluateCondition(node.data as ConditionNodeData, { outputs, input: opts.input, upstream });

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
