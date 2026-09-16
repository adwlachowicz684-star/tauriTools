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

export async function runOcr(ctx: RunContext): Promise<void> {
    const {
    id, node, opts, emit,
    outputs, nodeFields, currentLoop,
  } = ctx;

  const d = node.data as OcrNodeData;

  /*
   * 失败一律转成抛异常，由 withNodeRun 统一收口。
   * 以前这里要写「置空 + emit + markFailed + setStatus」四连，
   * 少写一行就会出现"节点红了但下游照跑"的假失败。
   */
  function failOcr(msg: string): never {
    throw new NodeFailError(msg, '', { text: '', chars: '0' });
  }

  await withNodeRun(ctx, async () => {

  const prompt = ctx.tpl((d.prompt ?? '').trim() || defaultOcrPrompt());
  const rawUrl = ctx.tpl(d.url ?? '');
  const rawPath = ctx.tpl(d.path ?? '');

  /*
    图片地址要在使用前决定，因为两种来源的失败提示完全不同：
    URL 只要拼字符串，本地文件还要读盘转 base64。
  */
  let imageUrl = '';
  if (d.imageSource === 'file') {
    const p = rawPath.trim();
    if (!p) {
      failOcr('图片来源选的是「本地文件」，但没有填路径');
    }
    emit({ type: 'node-start', id, rendered: `读取本地图片 ${p}` });
    try {
      imageUrl = await opts.imageReader!(p);
    } catch (err) {
      failOcr(err instanceof Error ? err.message : String(err));
    }
  } else {
    imageUrl = rawUrl.trim();
    if (!imageUrl) {
      failOcr('图片来源选的是「网络地址」，但没有填地址');
    }
    if (!isUsableImageUrl(imageUrl)) {
      failOcr(`图片地址无效：${imageUrl.slice(0, 80)}。需要 http(s) 开头，或 data:image/ 开头`);
    }
  }

  const cfg = resolveConfig(d.llm);
  const parts: ContentPart[] = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: imageUrl, detail: d.detail } },
  ];
  const messages: ChatMessage[] = [{ role: 'user', content: parts }];

  const body = { model: cfg.model, messages, temperature: 0, stream: false };
  emit({ type: 'node-start', id, rendered: `OCR ${cfg.model} · ${prompt.slice(0, 60)}` });


  let res: LlmCallResult;
  try {
    res = await opts.llmCaller!({
      url: cfg.url,
      headers: buildHeaders(resolveSecret(opts.credentials ?? [], d.credentialId, cfg.apiKey)),
      body,
      timeoutSec: cfg.timeoutSec,
    });
  } catch (err) {
    failOcr(err instanceof Error ? err.message : String(err));
  }

  const parsed = parseResponse(res.status, res.text);
  if (!parsed.ok) {
    failOcr(parsed.error);
  }

  const text = parsed.text.trim();
  return { output: text, fields: { text, chars: String(text.length) } };
  });
}
