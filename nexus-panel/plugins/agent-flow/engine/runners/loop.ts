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
import type { RunContext, Scope } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';

export async function runLoop(ctx: RunContext): Promise<void> {
    const {
    id, node, opts, emit,
    outputs, loops, loopBodies, orderByLayers,
    loopStack,
  } = ctx;

  const data = node.data as LoopNodeData;
  const res: LoopResolve = resolveLoopItems(data, { outputs, input: opts.input });

  if (res.error) {
    // 解析不出迭代项：记一条 0 轮的循环记录再失败，
    // 这样面板上能看出"是解析阶段就失败了"，而不是"循环跑了 0 次"
    loops.push({ id, rounds: 0, failed: 0, reason: res.reason, warnings: res.warnings });
    await withNodeRun(ctx, async (): Promise<never> => { throw new NodeFailError(res.error!); });
    return;
  }

  await withNodeRun(ctx, async () => {

  emit({ type: 'loop-resolved', id, count: res.items.length, reason: res.reason, warnings: res.warnings });

  const bodyIds = orderByLayers(loopBodies.get(id) ?? new Set<string>());
  const collected: string[] = [];
  let roundFailed = 0;
  /**
   * 实际执行的轮数。
   * 不能用 res.items.length —— 那是解析出的项数：
   * 用户中途取消、或 onError=stop 提前 break 时，
   * 会虚报成"共 1000 轮"。
   */
  let executed = 0;

  for (let i = 0; i < res.items.length; i++) {
    if (opts.signal?.aborted) break;
    executed += 1;
    const item = res.items[i];
    loopStack.push(makeLoopCtx(item, i, res.items.length));
    emit({ type: 'loop-iteration', id, index: i, item, count: res.items.length });

    // 每轮用独立作用域：上一轮被裁掉的边不影响本轮
    const iterScope: Scope = {
      deadEdges: new Set<string>(),
      skippedSet: new Set<string>(),
      failedSet: new Set<string>(),
    };
    await ctx.runScope(bodyIds, iterScope);

    try {
      if (data.collect) {
        const produced = bodyIds
          .map((b) => outputs[b] ?? '')
          .filter((s) => s.length > 0);
        if (produced.length > 0) collected.push(`#${i + 1} ${item}\n${produced.join('\n')}`);
      }

      if (iterScope.failedSet.size > 0) {
        roundFailed += 1;
        if (data.onError === 'stop') break;
      }
    } finally {
      // 出栈放在 finally：循环体抛异常时也不会把栈留脏
      loopStack.pop();
    }
  }

  const total = executed;
  const done = collected.length;
  const out = data.collect && collected.length > 0
    ? collected.join('\n\n')
    : `[循环] ${res.reason}，共 ${total} 轮`;

  const warn = res.warnings.length ? `；${res.warnings.join('；')}` : '';
  emit({ type: 'loop-done', id, rounds: total, failed: roundFailed });
  loops.push({
    id, rounds: total, failed: roundFailed,
    reason: `${res.reason}，产出 ${done} 条${warn}`, warnings: res.warnings,
  });
  if (roundFailed > 0) throw new NodeFailError(`${roundFailed}/${total} 轮失败${warn}`, out);
  return { output: out };
  });
}
