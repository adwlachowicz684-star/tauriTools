import type {
  GraphNode, NodeStatus, LoopCtx, LoopNodeData, UpdateNodeData, TaskNodeData,
  OcrNodeData, TranslateNodeData, GithubUpdateNodeData, GithubPushNodeData,
  FsNodeData, ConditionNodeData, ParallelNodeData, TriggerNodeData,
} from '../../types';
import { DEFAULT_BRANCH, defaultFileOutput, defaultOcrPrompt } from '../../types';
import { resolveSecret } from '../credentials';
import { renderTemplate } from '../template';
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

export async function runTask(ctx: RunContext): Promise<void> {
  const {
    id, node, graph, opts, scope, emit, setStatus, markFailed, markSkipped, sleep,
    outputs, nodeFields, currentLoop, branches, parallels, loops, byId,
    loopBodies, orderByLayers, loopStack, setConcurrency,
  } = ctx;

    const td = node.data as TaskNodeData;
    const { text: rendered, missing } = renderTemplate(td.prompt, {
      outputs, input: opts.input, loop: currentLoop(), fields: nodeFields,
    });
    if (missing.length > 0) {
      console.warn(`[${id}] 未解析的变量: ${missing.join(', ')}`);
    }

    setStatus(id, 'running');
    emit({ type: 'node-start', id, rendered });

    let acc = '';
    try {
      acc = await opts.executor(node, rendered, (chunk) => {
        acc += chunk;
        emit({ type: 'node-chunk', id, chunk });
      });
      outputs[id] = acc;

      /* ---------- 产出参数字段，供下游 {{id.xxx}} 引用 ---------- */
            const refs = resolveFileRefs(td, acc);
      nodeFields[id] = {
        ...buildFileFields(refs),
        ...resolveParams(td.params, { output: acc, refs }),
      };
      emit({
        type: 'node-fields', id,
        files: refs.map((r) => r.abs),
        fields: nodeFields[id],
      });

      emit({ type: 'node-done', id, ok: true, output: acc });
      setStatus(id, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      /*
        失败时也要重置字段：不清的话下游会读到上一次成功运行留下的路径，
        拿着一个根本没改过的文件继续跑，比直接失败更难排查。
      */
      nodeFields[id] = { ...buildFileFields([]) };
      emit({ type: 'node-fields', id, files: [], fields: nodeFields[id] });
      emit({ type: 'node-done', id, ok: false, output: acc, error: msg });
      markFailed(id, scope);
      setStatus(id, 'failed');
    }
    await sleep(50);
}
