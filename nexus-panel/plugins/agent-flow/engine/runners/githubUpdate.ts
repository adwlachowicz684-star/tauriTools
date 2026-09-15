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

export async function runGithubUpdate(ctx: RunContext): Promise<void> {
  const {
    id, node, graph, opts, scope, emit, setStatus, markFailed, markSkipped, sleep,
    outputs, nodeFields, currentLoop, branches, parallels, loops, byId,
    loopBodies, orderByLayers, loopStack, setConcurrency,
  } = ctx;

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
      credentialId: d.credentialId,
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
    emit({ type: 'node-done', id, ok: true, output: outputs[id] });
  } catch (e) {
    setStatus(id, 'failed');
    outputs[id] = 'false';
    emit({ type: 'node-error', id, error: String(e) });
  }
}
