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

export async function runUpdate(ctx: RunContext): Promise<void> {
  const {
    id, node, graph, opts, scope, emit, setStatus, markFailed, markSkipped, sleep,
    outputs, nodeFields, currentLoop, branches, parallels, loops, byId,
    loopBodies, orderByLayers, loopStack, setConcurrency,
  } = ctx;

  const d = node.data as UpdateNodeData;
  setStatus(id, 'running');

  const headers: Record<string, string> = {};
  if (d.userAgent) headers['User-Agent'] = d.userAgent;
  if (d.source === 'bilibili' && d.biliCookie) {
    // 允许整条 Cookie 粘进来；只填 SESSDATA 时也能用
    headers.Cookie = /=/ .test(d.biliCookie) && !/^SESSDATA=/i.test(d.biliCookie)
      ? d.biliCookie
      : `SESSDATA=${d.biliCookie.replace(/^SESSDATA=/i, '')}`;
    headers.Referer = BILI_REFERER;
  }

  // 决定抓哪个地址
  let url = '';
  if (d.source === 'bilibili') {
    if (d.biliMode === 'rss') {
      url = d.feedUrl.trim();
      if (!url) {
        fail('RSS 模式需要填订阅源地址');
        return;
      }
    } else {
      const uid = extractBiliUid(d.biliUid);
      if (!uid) {
        fail('填一个 UP 主 UID 或 space.bilibili.com 主页链接');
        return;
      }
      url = biliApiUrl(uid);
    }
  } else {
    url = d.feedUrl.trim();
    if (!url) {
      fail('需要填订阅源地址。公众号没有官方接口，请用 wechat2rss / RSSHub 等生成');
      return;
    }
  }

  // 渲染模板：允许用上游输出拼地址
  const renderedUrl = renderTemplate(url, { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields }).text;

  if (!opts.fetcher) {
    fail('未提供网络抓取执行器（当前可能运行在浏览器模式）');
    return;
  }

  emit({ type: 'node-start', id, rendered: `GET ${renderedUrl}` });

  let text: string;
  try {
    text = await opts.fetcher(node, renderedUrl, {
      headers,
      timeoutSec: d.timeoutSec,
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  // 解析：B站接口按 JSON，其余按 RSS/Atom
  const parsed = d.source === 'bilibili' && d.biliMode === 'api'
    ? parseBiliApi(text)
    : parseFeed(text);

  if (parsed.error) {
    fail(parsed.error);
    return;
  }

  const items = sortByNewest(parsed.items);
  const res = detectUpdate({
    items,
    lastSeenId: d.lastSeenId,
    firstRunAsUpdate: d.firstRunAsUpdate,
  });

  const latest: FeedItem | null = res.latest;
  const out = d.outputFormat === 'bool'
    ? String(res.updated)
    : (res.updated
        ? `true\n标题: ${latest?.title ?? ''}\n链接: ${latest?.url ?? ''}\n时间: ${latest?.date ?? ''}`
        : `false\n${latest ? `最新仍是: ${latest.title}` : '无更新'}`);

  outputs[id] = out;
  const item = latest;
  nodeFields[id] = {
    title: item?.title ?? '',
    url: item?.url ?? '',
    date: item?.date ?? '',
    updated: String(res.updated),
  };

  emit({
    type: 'update-checked',
    id,
    updated: res.updated,
    item,
    reason: res.reason,
    baseline: res.baseline,
    // 基线只在"确实看到了最新条目"时才推进，解析失败时保持原值
    patch: {
      lastSeenId: item?.id ?? d.lastSeenId,
      lastSeenTitle: item?.title ?? d.lastSeenTitle,
      lastCheckedAt: Date.now(),
      lastUpdated: res.updated,
    },
  });

  const warn = parsed.warnings.length ? `；${parsed.warnings.join('；')}` : '';
  emit({ type: 'node-done', id, ok: true, output: out, error: warn || undefined });
  setStatus(id, 'success');

  function fail(msg: string) {
    outputs[id] = 'false';
    nodeFields[id] = { title: '', url: '', date: '', updated: 'false' };
    emit({ type: 'node-done', id, ok: false, output: 'false', error: msg });
    markFailed(id, scope);
    setStatus(id, 'failed');
  }
}
