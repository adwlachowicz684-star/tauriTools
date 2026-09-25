import type {
  GraphNode, NodeStatus, LoopCtx, LoopNodeData, UpdateNodeData, TaskNodeData,
  OcrNodeData, TranslateNodeData, GithubUpdateNodeData, GithubPushNodeData,
  FsNodeData, ConditionNodeData, ParallelNodeData, TriggerNodeData,
} from '../../types';
import { DEFAULT_BRANCH, defaultFileOutput, defaultOcrPrompt } from '../../types';
import { resolveSecret } from '../credentials';

import {
  extractFileRefs, parseManualPaths, buildFileFields, resolveFileRefs, type FileRef,
} from '../files';
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
import { isAbortError } from '../sleep';

export async function runTask(ctx: RunContext): Promise<void> {
    const {
    id, node, opts, emit,
    sleep, outputs, nodeFields, currentLoop,
  } = ctx;

  const td = node.data as TaskNodeData;
  const rendered = ctx.tpl(td.prompt);

  await withNodeRun(ctx, async () => {
    emit({ type: 'node-start', id, rendered });

    let acc = '';
    try {
      acc = await opts.executor(node, rendered, (chunk) => {
        acc += chunk;
        emit({ type: 'node-chunk', id, chunk });
      });

      /* ---------- 产出参数字段，供下游 {{id.xxx}} 引用 ---------- */
      const refs = resolveFileRefs(td, acc);
      return {
        output: acc,
        fields: {
          ...buildFileFields(refs),
          ...resolveParams(td.params, { output: acc, refs }),
        },
        files: refs.map((r) => r.abs),
      };
    } catch (err) {
      /*
       * 取消要原样抛回去，不能裹成 NodeFailError。
       *
       * 裹了之后上层分不清"这一步被掐断"和"这一步真的出错" ——
       * 而两者处置相反：被掐断的不该再记一次失败（停止时尤其不该标红）。
       */
      if (isAbortError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      /*
        失败时也要重置字段：不清的话下游会读到上一次成功运行留下的路径，
        拿着一个根本没改过的文件继续跑，比直接失败更难排查。
        output 用 acc 而不是空串 —— 已经产出的部分内容对排查有用。
      */
      throw new NodeFailError(msg, acc, { ...buildFileFields([]) });
    }
  });

  await sleep(50);
}
