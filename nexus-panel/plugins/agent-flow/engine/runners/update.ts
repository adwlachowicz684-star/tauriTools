import type {
  GraphNode, NodeStatus, LoopCtx, LoopNodeData, UpdateNodeData, TaskNodeData,
  OcrNodeData, TranslateNodeData, GithubUpdateNodeData, GithubPushNodeData,
  FsNodeData, ConditionNodeData, ParallelNodeData, TriggerNodeData,
} from '../../types';
import { DEFAULT_BRANCH, defaultFileOutput, defaultOcrPrompt } from '../../types';
import {
  UPDATE_SOURCE_META, targetsOf, activeTargets, type UpdateTarget,
} from '../../types';
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
import { probeFeedTarget, BILI_REFERER, type FeedItem } from '../updates';
import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';

export async function runUpdate(ctx: RunContext): Promise<void> {
    const {
    id, node, opts, emit,
    outputs, nodeFields, currentLoop,
  } = ctx;

  const d = node.data as UpdateNodeData;

  await withNodeRun(ctx, async () => {

  /*
   * 多目标。
   *
   * 每个目标各抓各的、各比对自己的基线：
   * 以前一个节点就是一个源，盯三个 UP 主要放三个节点，
   * 而它们共用同一份 lastSeenId —— 后跑的把先跑的基线覆盖掉，
   * 表现为"明明 A 有更新，节点却显示无更新"。
   */
  const all = targetsOf(d);
  const targets = all.filter((t) => t.enabled !== false);

  if (targets.length === 0) {
    fail('至少要有一个启用的监听目标');
  }

  // 逐个检查。下一份 targets 全量回写（patch 是平铺展开的，写不进下标）
  const next: UpdateTarget[] = all.map((t) => ({ ...t }));
  const results: Array<{
    t: UpdateTarget; updated: boolean; item: FeedItem | null; reason: string; error?: string;
  }> = [];

  const headers: Record<string, string> = {};
  if (d.userAgent) headers['User-Agent'] = d.userAgent;

  for (const t of targets) {
    const idx = next.findIndex((x) => x.id === t.id);
    if (idx < 0) continue;
    // 每个目标自己的 Cookie 与 Referer：B站 的目标不该把 Cookie 带给别的源
    const h: Record<string, string> = { ...headers };
    if (t.kind === 'bilibili' && t.biliCookie) {
      h.Cookie = /=/ .test(t.biliCookie) && !/^SESSDATA=/i.test(t.biliCookie)
        ? t.biliCookie
        : `SESSDATA=${t.biliCookie.replace(/^SESSDATA=/i, '')}`;
      h.Referer = BILI_REFERER;
    }

    try {
      const r = await checkOne(ctx, t, h, d.timeoutSec ?? 15, d.firstRunAsUpdate === true);
      next[idx] = {
        ...next[idx],
        lastSeenId: r.latest?.id ?? next[idx].lastSeenId ?? '',
        lastSeenTitle: r.latest?.title ?? next[idx].lastSeenTitle ?? '',
        lastCheckedAt: Date.now(),
        lastUpdated: r.updated,
        error: '',
      };
      results.push({ t, updated: r.updated, item: r.latest, reason: r.reason });
      emit({
        type: 'update-checked', id,
        updated: r.updated, item: r.latest, reason: `[${nameOf(t)}] ${r.reason}`,
        baseline: r.baseline,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      /*
       * 一个目标失败不拖垮整个节点：其余目标照常给出结论。
       * 早先"一个源解析失败 → 整节点失败 → 输出 false"会把
       * 另一个确实有更新的源一起盖掉。
       */
      next[idx] = { ...next[idx], lastCheckedAt: Date.now(), error: msg };
      results.push({ t, updated: false, item: null, reason: msg, error: msg });
      emit({
        type: 'update-checked', id,
        updated: false, item: null, reason: `[${nameOf(t)}] 检查失败：${msg}`, baseline: false,
      });
    }
  }

  const updated = results.some((r) => r.updated);
  const first = results.find((r) => r.updated) ?? results[0];
  const failed = results.filter((r) => r.error);

  const out = d.outputFormat === 'bool'
    ? String(updated)
    : (updated
        ? `true\n标题: ${first?.item?.title ?? ''}\n链接: ${first?.item?.url ?? ''}\n时间: ${first?.item?.date ?? ''}`
        : `false\n${first?.item ? `最新仍是: ${first.item.title}` : '无更新'}`);

  const fields = {
    title: first?.item?.title ?? '',
    url: first?.item?.url ?? '',
    date: first?.item?.date ?? '',
    updated: String(updated),
  };

  emit({
    type: 'update-checked',
    id,
    updated,
    item: first?.item ?? null,
    reason: `${results.filter((r) => r.updated).length}/${targets.length} 个目标有更新`,
    baseline: false,
    /*
     * 回写整份 targets（平铺展开的 patch 写不进数组下标），
     * 同时补节点级的表字段 —— 老存档与只看节点状态的地方仍读得到。
     */
    patch: {
      targets: next,
      lastSeenId: first?.item?.id ?? d.lastSeenId,
      lastSeenTitle: first?.item?.title ?? d.lastSeenTitle,
      lastCheckedAt: Date.now(),
      lastUpdated: updated,
    },
  });

  const warn = failed.length
    ? `${failed.length}/${targets.length} 个目标检查失败：${failed.map((r) => `${nameOf(r.t)}（${r.error}）`).join('；')}`
    : '';
  return { output: out, fields, warn: warn || undefined };
  });

  /*
   * 失败也要输出 'false' 而不是空串：下游条件节点判「等于 true」时，
   * 空串会让条件落进兜底分支，看起来像"没更新"，与真失败混在一起分不清。
   */
  function fail(msg: string): never {
    throw new NodeFailError(msg, 'false', { title: '', url: '', date: '', updated: 'false' });
  }
}

/** 卡片标题：目标自己起了名就用它的，否则用种类名 */
function nameOf(t: UpdateTarget): string {
  return (t.name ?? '').trim() || UPDATE_SOURCE_META[t.kind].label;
}

/**
 * 检查一个目标。
 *
 * 抛错由调用方接住并记到这张卡上 —— 一个源挂了不影响其它源出结论。
 */
async function checkOne(
  ctx: RunContext,
  t: UpdateTarget,
  headers: Record<string, string>,
  timeoutSec: number,
  firstRunAsUpdate: boolean,
): Promise<{ updated: boolean; latest: FeedItem | null; reason: string; baseline: boolean }> {
  const { node, opts, emit, id } = ctx;

  /* ---- GitHub：走 GitHub 拉取，不是网络抓取 ---- */
  if (t.kind === 'github') {
    const owner = ctx.tpl(t.owner ?? '').trim();
    const repo = ctx.tpl(t.repo ?? '').trim();
    if (!owner || !repo) throw new Error('缺少 owner 或 repo');
    if (!opts.githubFetch) throw new Error('当前环境没有 GitHub 拉取能力');

    const r = await opts.githubFetch({
      owner, repo,
      branch: t.branch || undefined,
      base: t.base || undefined,
      order: undefined,
      token: '',
      credentialId: t.credentialId,
    });
    if (!r.ok || !r.info) throw new Error(r.error || '拉取失败');
    const info = r.info;
    return {
      updated: !!info.updated,
      latest: {
        id: info.sha,
        title: info.message || info.sha,
        url: `https://github.com/${owner}/${repo}/commit/${info.sha}`,
        date: info.date || '',
      },
      reason: info.updated ? `有新提交：${info.message || info.sha}` : '没有新提交',
      baseline: false,
    };
  }

  /*
   * ---- 其余：抓一个地址下来解析 ----
   *
   * 走 probeFeedTarget（engine/updates.ts），与「测试」按钮共用同一份逻辑：
   * 以前这里自己拼 URL、自己 parse、自己 detectUpdate，
   * 而试跑面板另有完全相同的一份 —— 两份漂开的表现是
   * "试跑说有更新，正式跑却没更新"，两边都不报错。
   */
  const r = await probeFeedTarget(t, {
    headers,
    timeoutSec,
    firstRunAsUpdate,
    lastSeenId: t.lastSeenId ?? '',
    onUrl: (renderedUrl) => emit({ type: 'node-start', id, rendered: `GET ${renderedUrl}` }),
  }, {
    // 执行器的 fetcher 要求这两个字段必填，而 ProbeDeps 允许省略
    get: (u, o) => opts.fetcher!(node, u, {
      headers: o.headers ?? headers,
      timeoutSec: o.timeoutSec ?? timeoutSec,
    }),
    tpl: (s) => ctx.tpl(s),
  });

  return {
    updated: r.updated,
    latest: r.latest,
    reason: r.reason,
    baseline: r.baseline,
  };
}
