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
import type { LlmCallResult } from '../runTypes';

export async function runTranslate(ctx: RunContext): Promise<void> {
    const {
    id, node, opts, emit,
    outputs, nodeFields, currentLoop,
  } = ctx;

  const d = node.data as TranslateNodeData;

  /*
   * 失败一律抛异常，由 withNodeRun 统一收口（置空 / node-done / markFailed /
   * setStatus 四连），避免漏掉 markFailed 造成"假失败"。
   */
  function failTranslate(msg: string): never {
    throw new NodeFailError(msg, '', { text: '', chars: '0' });
  }

  await withNodeRun(ctx, async () => {

  const src = ctx.tpl(d.text ?? '');

  if (!src.trim()) {
    failTranslate('待翻译文本为空。检查上游输出，或直接在节点里填写');
  }

  const target = (d.targetLang ?? '').trim();
  if (!target) {
    failTranslate('未指定目标语言');
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


  let res: LlmCallResult;
  try {
    res = await opts.llmCaller!({
      url: cfg.url,
      headers: buildHeaders(resolveSecret(opts.credentials ?? [], d.credentialId, cfg.apiKey)),
      body,
      timeoutSec: cfg.timeoutSec,
    });
  } catch (err) {
    failTranslate(err instanceof Error ? err.message : String(err));
  }

  const parsed = parseResponse(res.status, res.text);
  if (!parsed.ok) {
    failTranslate(parsed.error);
  }

  const text = parsed.text.trim();
  return { output: text, fields: { text, chars: String(text.length) } };
  });

}
