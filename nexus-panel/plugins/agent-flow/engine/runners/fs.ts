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

export async function runFs(ctx: RunContext): Promise<void> {
    const {
    id, node, opts, emit,
    sleep, outputs, nodeFields, currentLoop,
  } = ctx;

  const d = node.data as FsNodeData;

  await withNodeRun(ctx, async () => {
    const p = ctx.tpl(d.path);
    const t = ctx.tpl(d.target);
    const c = ctx.tpl(d.content);


    emit({ type: 'node-start', id, rendered: `${d.op} ${p}` });
    let out = '';
    try {
      out = await opts.fsExecutor(node, { path: p, target: t, content: c });
    } catch (err) {
      throw new NodeFailError(err instanceof Error ? err.message : String(err));
    }
    return { output: out };
  });

  await sleep(20);
}
