import type {
  GraphNode, NodeStatus, LoopCtx, LoopNodeData, UpdateNodeData, TaskNodeData,
  OcrNodeData, TranslateNodeData, GithubUpdateNodeData, GithubPushNodeData,
  FsNodeData, ConditionNodeData, ParallelNodeData, TriggerNodeData,
} from '../../types';
import { DEFAULT_BRANCH, defaultFileOutput, defaultOcrPrompt } from '../../types';
import { resolveSecret } from '../credentials';

import {
  extractFileRefs, parseManualPaths, buildFileFields, fsRenderIssue, type FileRef,
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

export async function runFs(ctx: RunContext): Promise<void> {
    const {
    id, node, opts, emit,
    sleep, outputs, nodeFields, currentLoop,
  } = ctx;

  const d = node.data as FsNodeData;

  await withNodeRun(ctx, async () => {
    const rp = ctx.render(d.path);
    const rt = ctx.render(d.target);
    const rc = ctx.render(d.content);
    const p = rp.text;
    const t = rt.text;
    const c = rc.text;


    emit({ type: 'node-start', id, rendered: `${d.op} ${p}` });
    let out = '';
    try {
      /*
       * 渲染**之后**再校验一遍路径。
       *
       * 编辑期的校验（nodeValidate 的 vFs）只看填了没填，而路径支持模板：
       * `{{n1.output}}` 在编辑期是合法的非空值、圆点是绿的；
       * n1 没产出时模板原样保留，于是 fs_op 收到字面量 `{{n1.output}}` ——
       * 磁盘上真的会多出一个叫这名字的东西，且不报错、日志干净。
       *
       * 校验放在调用执行器**之前**：抛出去走的是同一条失败路径，
       * 节点变红并带上原因，而不是让 Rust 去碰一个不该碰的路径。
       */
      const issue = fsRenderIssue(
        d.op, p, t,
        /* 渲染时算出来的结论，不在这里另扫一遍 */
        rp.missing, rt.missing,
      );
      if (issue) throw new NodeFailError(issue);

      out = await opts.fsExecutor!(node, { path: p, target: t, content: c });
    } catch (err) {
      throw new NodeFailError(err instanceof Error ? err.message : String(err));
    }
    return { output: out };
  });

  await sleep(20);
}
