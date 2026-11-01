import type {
  GraphNode, NodeStatus, LoopCtx, LoopNodeData, UpdateNodeData, TaskNodeData,
  OcrNodeData, TranslateNodeData, GithubUpdateNodeData, GithubPushNodeData,
  FsNodeData, ConditionNodeData, ParallelNodeData, TriggerNodeData,
} from '../../types';
import { DEFAULT_BRANCH, defaultFileOutput, defaultOcrPrompt } from '../../types';
import { findCredential } from '../credentials';
import { resolveLlmFromCredential, missingLlmReason, missingLlmMessage } from '../llmCredential';

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

  /*
   * 地址与密钥**优先取自连接**。
   *
   * 节点上那份旧 llm 配置只作兜底（老画布迁移前）——
   * 反过来的话，改了连接的地址不生效，表现为"改了没反应"。
   */
  const cfg = resolveLlmFromCredential(
    findCredential(opts.credentials ?? [], d.credentialId), d.llm?.model, { fallback: d.llm },
  );
  /*
   * ⛔ 空地址**必须**在这里说出来。
   *
   * llmChat 一直有这道检查，而 OCR / 翻译没有 ——
   * 于是同样的"连接没了"，一个节点报错、另两个拿着空地址就发请求。
   * fetch('') 打的是当前页面（相对地址），返回一段 HTML，
   * 报错指向"解析响应失败"，跟"你选的连接被删了"差了十万八千里。
   */
  const miss = missingLlmReason(d.credentialId, findCredential(opts.credentials ?? [], d.credentialId), cfg);
  if (miss) failOcr(missingLlmMessage(miss));
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
      /* 同 llmChat：只用 cfg.apiKey，不再 resolveSecret 取第二遍（那份未 trim） */
      headers: buildHeaders(cfg.apiKey),
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
