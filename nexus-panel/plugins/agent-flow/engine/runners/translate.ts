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
import type { LlmCallResult } from '../runTypes';

export async function runTranslate(ctx: RunContext): Promise<void> {
  const {
    id, node, graph, opts, scope, emit, setStatus, markFailed, markSkipped, sleep,
    outputs, nodeFields, currentLoop, branches, parallels, loops, byId,
    loopBodies, orderByLayers, loopStack, setConcurrency,
  } = ctx;

  const d = node.data as TranslateNodeData;
  setStatus(id, 'running');

  const src = renderTemplate(d.text ?? '', {
    outputs, input: opts.input, loop: currentLoop(), fields: nodeFields,
  }).text;

  if (!src.trim()) {
    failTranslate('待翻译文本为空。检查上游输出，或直接在节点里填写');
    return;
  }

  const target = (d.targetLang ?? '').trim();
  if (!target) {
    failTranslate('未指定目标语言');
    return;
  }

  // 允许填 "日语" 这种中文，也允许填 "ja"
  const preset = TARGET_LANGS.find((l) => l.code === target);
  const targetText = preset ? preset.label : target;

  const sourceLang = (d.sourceLang ?? 'auto').trim() || 'auto';
  const system = buildTranslateSystem(
    targetText,
    sourceLang === 'auto' ? '' : sourceLang,
    d.glossary,
  );

  const cfg = resolveConfig(d.llm);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: src },
  ];
  const body = { model: cfg.model, messages, temperature: 0.2, stream: false };

  emit({ type: 'node-start', id, rendered: `翻译 → ${targetText}（${src.length} 字）` });

  if (!opts.llmCaller) {
    failTranslate('未提供大模型调用执行器（当前可能运行在浏览器模式）');
    return;
  }

  let res: LlmCallResult;
  try {
    res = await opts.llmCaller({
      url: cfg.url,
      headers: buildHeaders(resolveSecret(opts.credentials ?? [], d.credentialId, cfg.apiKey)),
      body,
      timeoutSec: cfg.timeoutSec,
    });
  } catch (err) {
    failTranslate(err instanceof Error ? err.message : String(err));
    return;
  }

  const parsed = parseResponse(res.status, res.text);
  if (!parsed.ok) {
    failTranslate(parsed.error);
    return;
  }

  const text = parsed.text.trim();
  outputs[id] = text;
  nodeFields[id] = { text, chars: String(text.length) };
  emit({ type: 'node-done', id, ok: true, output: text });
  setStatus(id, 'success');

  function failTranslate(msg: string) {
    outputs[id] = '';
    nodeFields[id] = { text: '', chars: '0' };
    emit({ type: 'node-done', id, ok: false, output: '', error: msg });
    markFailed(id, scope);
    setStatus(id, 'failed');
  }
}
