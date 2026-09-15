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

export async function runFs(ctx: RunContext): Promise<void> {
  const {
    id, node, graph, opts, scope, emit, setStatus, markFailed, markSkipped, sleep,
    outputs, nodeFields, currentLoop, branches, parallels, loops, byId,
    loopBodies, orderByLayers, loopStack, setConcurrency,
  } = ctx;

    setStatus(id, 'running');
    const d = node.data as FsNodeData;
    const p = renderTemplate(d.path, { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields });
    const t = renderTemplate(d.target, { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields });
    const c = renderTemplate(d.content, { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields });

    if (!opts.fsExecutor) {
      const msg = '未提供文件操作执行器（当前可能运行在浏览器模式）';
      outputs[id] = '';
      emit({ type: 'node-done', id, ok: false, output: '', error: msg });
      markFailed(id, scope);
      setStatus(id, 'failed');
      return;
    }

    emit({ type: 'node-start', id, rendered: `${d.op} ${p.text}` });
    try {
      const out = await opts.fsExecutor(node, { path: p.text, target: t.text, content: c.text });
      outputs[id] = out;
      emit({ type: 'node-done', id, ok: true, output: out });
      setStatus(id, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: 'node-done', id, ok: false, output: '', error: msg });
      markFailed(id, scope);
      setStatus(id, 'failed');
    }
    await sleep(20);
    return;
}
