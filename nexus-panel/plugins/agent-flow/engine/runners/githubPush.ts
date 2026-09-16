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

export async function runGithubPush(ctx: RunContext): Promise<void> {
    const {
    node, opts, outputs, nodeFields,
    currentLoop,
  } = ctx;
  const d = node.data as GithubPushNodeData;

  await withNodeRun(ctx, async () => {
    const tpl = (x: string) => ctx.tpl(x ?? '');

    const owner = tpl(d.owner).trim();
    const repo = tpl(d.repo).trim();

    if (!owner || !repo) throw new NodeFailError('缺少 owner 或 repo');

    // 每行一条 `路径 = 内容来源`；等号后的内容走模板渲染
    const files: { path: string; content: string }[] = [];
    for (const line of (d.filesText || '').split('\n')) {
      const raw = line.trim();
      if (!raw) continue;
      const eq = raw.indexOf('=');
      if (eq < 0) throw new NodeFailError(`文件行缺等号：${raw}`);
      files.push({ path: raw.slice(0, eq).trim(), content: tpl(raw.slice(eq + 1)) });
    }
    if (files.length === 0) throw new NodeFailError('没有要提交的文件');

    const r = await opts.githubPush!({
      owner, repo,
      branch: d.branch || 'main',
      message: tpl(d.message),
      files,
      workdir: d.workdir || undefined,
      order: d.order,
      token: d.token || '',
      credentialId: d.credentialId,
    });
    if (!r.ok) throw new NodeFailError(r.error || '推送失败');

    return {
      output: r.commit ? `已提交 ${r.commit}` : '已推送',
      fields: { commit: r.commit || '', via: r.via || '' },
    };
  });
}
