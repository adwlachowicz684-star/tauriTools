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
import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { unresolvedIssue } from '../template';

export async function runGithubPush(ctx: RunContext): Promise<void> {
    const {
    node, opts, outputs, nodeFields,
    currentLoop,
  } = ctx;
  const d = node.data as GithubPushNodeData;

  await withNodeRun(ctx, async () => {
    const render = (x: string) => ctx.render(x ?? '');
    /** 收集所有没渲染出来的变量 —— 推送是不可逆的，不能带着字面量出去 */
    const missing: string[] = [];
    const seen = (m: string[]) => { for (const k of m) if (!missing.includes(k)) missing.push(k); };

    const ro = render(d.owner);
    const rr = render(d.repo);
    const owner = ro.text.trim();
    const repo = rr.text.trim();
    seen(ro.missing);
    seen(rr.missing);

    if (!owner || !repo) throw new NodeFailError('缺少 owner 或 repo');

    /*
     * 每行一条 `路径 = 内容来源`，**两边都走模板渲染**。
     *
     * 以前只有等号右边渲染 —— 而字段的 placeholder 明写着
     * `notes/{{date}}.txt={{上游.output}}`，也就是路径侧确实承诺了模板。
     * 不渲染的后果不是"路径不对"，是**仓库里多出一个叫
     * `notes/{{date}}.txt` 的文件**：不报错，提交记录还留着。
     */
    const files: { path: string; content: string }[] = [];
    for (const line of (d.filesText || '').split('\n')) {
      const raw = line.trim();
      if (!raw) continue;
      const eq = raw.indexOf('=');
      if (eq < 0) throw new NodeFailError(`文件行缺等号：${raw}`);
      const rp = render(raw.slice(0, eq));
      const rc = render(raw.slice(eq + 1));
      seen(rp.missing);
      seen(rc.missing);
      files.push({ path: rp.text.trim(), content: rc.text });
    }
    if (files.length === 0) throw new NodeFailError('没有要提交的文件');

    const rm = render(d.message);
    seen(rm.missing);

    /*
     * 判失败而不是照推：推上去就是一次公开提交，
     * 字面量 `{{x}}` 会留在仓库的提交历史里，撤掉还得再推一次。
     */
    if (missing.length > 0) {
      throw new NodeFailError(unresolvedIssue(
        '要推送的内容', missing, '会拿字面量提交到远端仓库，去检查上游有没有产出',
      ));
    }

    const r = await opts.githubPush!({
      owner, repo,
      branch: d.branch || 'main',
      message: rm.text,
      files,
      workdir: d.workdir || undefined,
      order: d.order,
      token: d.token || '',
      credentialId: d.credentialId,
    });
    if (!r.ok) throw new NodeFailError(r.error || '推送失败');

    return {
      output: r.commit ? `已提交 ${r.commit}` : '已推送',
      fields: { commit: r.commit || '', via: r.via || '' },
    };
  });
}
