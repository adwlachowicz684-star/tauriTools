import type {
  GraphNode, NodeStatus, LoopCtx, LoopNodeData, UpdateNodeData, TaskNodeData,
  OcrNodeData, TranslateNodeData, GithubUpdateNodeData, GithubPushNodeData,
  FsNodeData, ConditionNodeData, ParallelNodeData, TriggerNodeData,
} from '../../types';
import { DEFAULT_BRANCH, defaultFileOutput, defaultOcrPrompt } from '../../types';
import { resolveSecret } from '../credentials';

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
import { withNodeRun, NodeFailError } from '../runnerKit';

export async function runParallel(ctx: RunContext): Promise<void> {
    const {
    id, node, graph, opts,
    emit, outputs, parallels, setConcurrency,
  } = ctx;

  await withNodeRun(ctx, async () => {
    const upstream = graph.edges.filter((e) => e.target === id).map((e) => e.source);
    const text = upstream.length > 0
      ? upstream.map((u) => outputs[u] ?? '').join('\n')
      : (opts.input ?? '');

    const res = resolveParallel(node.data as ParallelNodeData, text);
    // 并发度必须先登记：即使下面判定为配置错误，下游也该按这个值跑
    setConcurrency(id, res.concurrency);
    const out = `[并发] ${res.reason}`;
    const recorded = Number.isFinite(res.concurrency) ? res.concurrency : MAX_CONCURRENCY;
    parallels.push({ id, concurrency: recorded, reason: res.reason });
    emit({ type: 'parallel-resolved', id, concurrency: recorded, reason: res.reason });
    // 同条件节点：原实现发 ok:true 却 markFailed，这里统一成 ok:false
    if (res.errors.length > 0) throw new NodeFailError(res.errors.join('；'), out);
    return { output: out };
  });
}
