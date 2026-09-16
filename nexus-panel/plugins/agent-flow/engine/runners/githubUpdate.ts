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

export async function runGithubUpdate(ctx: RunContext): Promise<void> {
    const {
    node, opts, outputs, nodeFields,
    currentLoop,
  } = ctx;
  const d = node.data as GithubUpdateNodeData;

  await withNodeRun(ctx, async () => {
    const owner = ctx.tpl(d.owner ?? '').trim();
    const repo = ctx.tpl(d.repo ?? '').trim();

    if (!owner || !repo) throw new NodeFailError('缺少 owner 或 repo', 'false');

    const r = await opts.githubFetch({
      owner, repo,
      branch: d.branch || undefined,
      base: d.base || undefined,
      order: d.order,
      token: d.token || '',
      credentialId: d.credentialId,
    });
    if (!r.ok || !r.info) throw new NodeFailError(r.error || '拉取失败', 'false');

    const info = r.info;
    // 主输出是 bool，好让条件节点直接判「等于 true」
    return {
      output: info.updated ? 'true' : 'false',
      fields: {
        sha: info.sha,
        branch: info.branch,
        message: info.message,
        author: info.author,
        date: info.date,
        via: r.via || '',
      },
    };
  });
}
