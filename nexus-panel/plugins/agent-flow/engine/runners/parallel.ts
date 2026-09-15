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

export async function runParallel(ctx: RunContext): Promise<void> {
  const {
    id, node, graph, opts, scope, emit, setStatus, markFailed, markSkipped, sleep,
    outputs, nodeFields, currentLoop, branches, parallels, loops, byId,
    loopBodies, orderByLayers, loopStack, setConcurrency,
  } = ctx;

    setStatus(id, 'running');
    const upstream = graph.edges.filter((e) => e.target === id).map((e) => e.source);
    const text = upstream.length > 0
      ? upstream.map((u) => outputs[u] ?? '').join('\n')
      : (opts.input ?? '');

    const res = resolveParallel(node.data as ParallelNodeData, text);
    setConcurrency(id, res.concurrency);
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
