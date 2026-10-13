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
import { findPane, resolveTaskPane, withPaneContext, panePrevOutputs } from '../pane';
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
import { unresolvedIssue } from '../template';

export async function runTask(ctx: RunContext): Promise<void> {
    const {
    id, node, opts, emit, graph,
    sleep, outputs, nodeFields, currentLoop,
  } = ctx;

  const td = node.data as TaskNodeData;

  /*
   * 窗格只影响"节点上没填的项"，这里先算出生效配置再往下用。
   *
   * 共享上下文在这里拼、不写回 prompt：写回的话它会留在存档里，
   * 第二次跑看到的上下文是第一次的结果，越跑越长（见 withPaneContext）。
   */
  const pane = findPane(graph?.nodes ?? [], td.paneId);
  const eff = resolveTaskPane(td, pane);
  const rp = ctx.render(td.prompt);
  const rendered = eff.shareContext
    ? withPaneContext(rp.text, panePrevOutputs(graph, id, td.paneId, outputs), true)
    : rp.text;

  await withNodeRun(ctx, async () => {
    emit({ type: 'node-start', id, rendered });

    /*
     * 未渲染就判失败，**不交给命令行**。
     *
     * 命令里引用了上游、上游没产出时模板原样保留，于是执行的会是
     * `移动 data 到 {{dest}}` —— 命令真的跑完、副作用真的发生，
     * 而日志干净、节点是绿的。这是最难排查的一类："没报错，但东西没了"。
     *
     * 判据用 render 算出来的 missing（全仓只有 renderTemplate 一处判），
     * 不在这里对着文本重扫 —— 重扫会把正文里本来就带 {{}} 的命令误判。
     */
    if (rp.missing.length > 0) {
      throw new NodeFailError(unresolvedIssue(
        '命令', rp.missing, '会真的执行一条带字面量的命令，去检查上游有没有产出',
      ));
    }

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
