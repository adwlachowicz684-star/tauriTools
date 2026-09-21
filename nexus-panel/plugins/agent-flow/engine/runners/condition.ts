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
import { evaluateCondition, type RuleOutcome } from '../condition';
import { resolveParallel, effectiveConcurrency, MAX_CONCURRENCY } from '../parallel';
import { resolveLoopItems, makeLoopCtx, type LoopResolve } from '../loop';
import {
  parseFeed, parseBiliApi, detectUpdate, sortByNewest, extractBiliUid, biliApiUrl,
  BILI_REFERER, type FeedItem,
} from '../updates';
import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';

/** 把判定依据压成一行：走了哪条 + 当时看的内容 */
function condDetail(res: RuleOutcome): string {
  const seen = (res.inspected ?? '').trim();
  const what = seen ? `依据「${seen.length > 40 ? `${seen.slice(0, 39)}…` : seen}」` : '依据（上游无内容）';
  const which = res.rule
    ? `命中「${res.rule.label || res.branchId || '未命名规则'}」`
    : '没有规则命中';
  return `${which} · ${what}`;
}

export async function runCondition(ctx: RunContext): Promise<void> {
    const {
    id, node, graph, opts,
    scope, emit, outputs, branches,
  } = ctx;

  await withNodeRun(ctx, async () => {
    const upstream = graph.edges.filter((e) => e.target === id).map((e) => e.source);
    const res = evaluateCondition(node.data as ConditionNodeData, { outputs, input: opts.input, upstream });

    const outEdges = graph.edges.filter((e) => e.source === id);
    const prunedNow: string[] = [];
    for (const e of outEdges) {
      if (!e.branch) continue;
      if (e.branch === res.branchId) continue;
      scope.deadEdges.add(e.id);
      prunedNow.push(e.target);
    }

    const label = res.branchId === DEFAULT_BRANCH
      ? '兜底分支'
      : res.branchId === null ? '无匹配（下游全部跳过）' : (res.rule?.label ?? res.branchId);

    const out = res.branchId ? `[条件] 走「${label}」` : '[条件] 无分支命中';
    branches.push({ id, branchId: res.branchId, label });
    emit({ type: 'branch-taken', id, branchId: res.branchId, label, pruned: prunedNow });
    /*
     * 原实现在这里发的是 ok:true 却同时 markFailed —— 事件说成功、
     * 状态却是失败，两边不一致。既然判定出错就要让下游跳过，
     * 那 node-done 就该是 ok:false，否则日志与徽章各说各话。
     */
    if (res.error) throw new NodeFailError(res.error, out);
    /*
     * 判据：命中了哪条规则 + 当时看的是什么内容。
     *
     * 只看输出(`[条件] 走「xxx」`)无法判断判定对不对 ——
     * 尤其规则里引用 {{上游.output}} 时，实际取到的文本根本看不出来。
     */
    return { output: out, detail: condDetail(res) };
  });
}
