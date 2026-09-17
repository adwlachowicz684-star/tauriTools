import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { checkPass } from '../passCheck';
import { upstreamText } from '../upstream';
import type { RetryNodeData } from '../../types';

/**
 * 重试 —— 上游成功了但内容不合格时，重跑它直到合格。
 *
 * ================= 它能做什么、不能做什么 =================
 *
 * 能做的：上游**执行成功**但产出不合格时（接口返回了错误文本、
 * 抓到了空内容），重跑那个节点，直到合格或用完次数。
 *
 * 做不到的：上游**执行失败**时（抛了 NodeFailError）。
 * 那种情况下引擎在调度层就把本节点跳过了 —— 失败会沿边传播，
 * 本节点根本没机会运行。这是既有规则，重试节点不去推翻它。
 * 想"失败也重试"得改引擎的跳过判定，那是另一件事。
 */
export async function runRetry(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as RetryNodeData;

  await withNodeRun(ctx, async () => {
    const target = String(d.target ?? '').trim();
    if (!target) {
      throw new NodeFailError('没填要重试哪个节点');
    }
    if (!ctx.byId.has(target)) {
      throw new NodeFailError(`找不到要重试的节点 ${target}（可能已被删除）`);
    }

    const check = String(d.check ?? 'nonempty');
    const value = String(d.value ?? '');
    const times = Math.max(0, Math.floor(Number(d.times ?? 0)));
    const interval = Math.max(0, Number(d.intervalMs ?? 0));

    const read = () => ctx.outputs[target] ?? '';

    let r = checkPass(read(), check, value);
    if (r.ok) return { output: upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input) };

    for (let i = 1; i <= times; i++) {
      if (interval > 0) await ctx.sleep(interval);

      ctx.emit({ type: 'log', message: `重试 ${target}（第 ${i}/${times} 次）` });
      /*
       * 重跑目标节点本身。
       * runNode 会重新走一遍它的执行器并覆盖 outputs[target]，
       * 所以下面重新读到的就是新一次的结果。
       */
      await ctx.runNode(target, ctx.scope);

      r = checkPass(read(), check, value);
      if (r.ok) {
        ctx.emit({ type: 'log', message: `重试第 ${i} 次后合格` });
        return { output: upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input) };
      }
    }

    /*
     * 用完次数仍不合格：报失败，让下游跳过 ——
     * 静默放行会让"重试没起作用"这件事看不出来。
     */
    throw new NodeFailError(`重试 ${times} 次后仍不合格：${r.reason}`);
  });
}
