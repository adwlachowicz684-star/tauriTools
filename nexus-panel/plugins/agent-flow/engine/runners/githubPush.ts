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

export async function runGithubPush(ctx: RunContext): Promise<void> {
  const {
    id, node, graph, opts, scope, emit, setStatus, markFailed, markSkipped, sleep,
    outputs, nodeFields, currentLoop, branches, parallels, loops, byId,
    loopBodies, orderByLayers, loopStack, setConcurrency,
  } = ctx;

  const d = node.data as GithubPushNodeData;
  setStatus(id, 'running');

  const tpl = (x: string) =>
    renderTemplate(x ?? '', {
      outputs, input: opts.input, loop: currentLoop(), fields: nodeFields,
    }).text;

  const owner = tpl(d.owner).trim();
  const repo = tpl(d.repo).trim();

  if (!opts.githubPush) {
    setStatus(id, 'failed');
    emit({ type: 'node-error', id, error: '未提供 GitHub 推送执行器' });
    return;
  }
  if (!owner || !repo) {
    setStatus(id, 'failed');
    emit({ type: 'node-error', id, error: '缺少 owner 或 repo' });
    return;
  }

  // 每行一条 `路径 = 内容来源`；等号后的内容走模板渲染
  const files: { path: string; content: string }[] = [];
  for (const line of (d.filesText || '').split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    const eq = raw.indexOf('=');
    if (eq < 0) {
      setStatus(id, 'failed');
      emit({ type: 'node-error', id, error: `文件行缺等号：${raw}` });
      return;
    }
    files.push({ path: raw.slice(0, eq).trim(), content: tpl(raw.slice(eq + 1)) });
  }
  if (files.length === 0) {
    setStatus(id, 'failed');
    emit({ type: 'node-error', id, error: '没有要提交的文件' });
    return;
  }

  try {
    const r = await opts.githubPush({
      owner, repo,
      branch: d.branch || 'main',
      message: tpl(d.message),
      files,
      workdir: d.workdir || undefined,
      order: d.order,
      token: d.token || '',
      credentialId: d.credentialId,
    });
    if (!r.ok) {
      setStatus(id, 'failed');
      emit({ type: 'node-error', id, error: r.error || '推送失败' });
      return;
    }
    outputs[id] = r.commit ? `已提交 ${r.commit}` : '已推送';
    nodeFields[id] = { commit: r.commit || '', via: r.via || '' };
    setStatus(id, 'success');
    emit({ type: 'node-done', id, ok: true, output: outputs[id] });
  } catch (e) {
    setStatus(id, 'failed');
    emit({ type: 'node-error', id, error: String(e) });
  }
}
