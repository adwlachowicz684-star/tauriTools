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

export async function runOcr(ctx: RunContext): Promise<void> {
  const {
    id, node, graph, opts, scope, emit, setStatus, markFailed, markSkipped, sleep,
    outputs, nodeFields, currentLoop, branches, parallels, loops, byId,
    loopBodies, orderByLayers, loopStack, setConcurrency,
  } = ctx;

  const d = node.data as OcrNodeData;
  setStatus(id, 'running');

  const prompt = renderTemplate(
    (d.prompt ?? '').trim() || defaultOcrPrompt(),
    { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields },
  ).text;
  const rawUrl = renderTemplate(d.url ?? '', { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields }).text;
  const rawPath = renderTemplate(d.path ?? '', { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields }).text;

  /*
    图片地址要在使用前决定，因为两种来源的失败提示完全不同：
    URL 只要拼字符串，本地文件还要读盘转 base64。
  */
  let imageUrl = '';
  if (d.imageSource === 'file') {
    const p = rawPath.trim();
    if (!p) {
      failOcr('图片来源选的是「本地文件」，但没有填路径');
      return;
    }
    if (!opts.imageReader) {
      failOcr('当前环境无法读取本地图片（浏览器模式不支持，请用桌面端运行）');
      return;
    }
    emit({ type: 'node-start', id, rendered: `读取本地图片 ${p}` });
    try {
      imageUrl = await opts.imageReader(p);
    } catch (err) {
      failOcr(err instanceof Error ? err.message : String(err));
      return;
    }
  } else {
    imageUrl = rawUrl.trim();
    if (!imageUrl) {
      failOcr('图片来源选的是「网络地址」，但没有填地址');
      return;
    }
    if (!isUsableImageUrl(imageUrl)) {
      failOcr(`图片地址无效：${imageUrl.slice(0, 80)}。需要 http(s) 开头，或 data:image/ 开头`);
      return;
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

  if (!opts.llmCaller) {
    failOcr('未提供大模型调用执行器（当前可能运行在浏览器模式）');
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
    failOcr(err instanceof Error ? err.message : String(err));
    return;
  }

  const parsed = parseResponse(res.status, res.text);
  if (!parsed.ok) {
    failOcr(parsed.error);
    return;
  }

  const text = parsed.text.trim();
  outputs[id] = text;
  nodeFields[id] = { text, chars: String(text.length) };
  emit({ type: 'node-done', id, ok: true, output: text });
  setStatus(id, 'success');

  function failOcr(msg: string) {
    outputs[id] = '';
    nodeFields[id] = { text: '', chars: '0' };
    emit({ type: 'node-done', id, ok: false, output: '', error: msg });
    markFailed(id, scope);
    setStatus(id, 'failed');
  }
}
