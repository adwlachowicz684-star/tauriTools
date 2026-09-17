import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { upstreamText } from '../upstream';
import type { TimeoutNodeData } from '../../types';

/**
 * 超时熔断 —— 整条流程的预算超了就断在这里。
 *
 * ================= 预算是"从运行开始算"，不是本节点耗时 =================
 *
 * 这一点很关键：衡量的是**整条流程已经跑了多久**，
 * 而不是这一个节点跑了多久。后者的场景基本不存在
 * （本节点自己卡住的话，卡在哪一步是看得见的）。
 *
 * 所以它是个"截止时间"节点：流程跑了 5 分钟还没到我这里，
 * 后面的活儿就不必再做了。
 */
export async function runTimeout(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as TimeoutNodeData;

  await withNodeRun(ctx, async () => {
    const text = upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input);
    const budget = Number(d.budgetMs ?? 0);

    if (!Number.isFinite(budget) || budget <= 0) {
      throw new NodeFailError('没填有效的预算时长');
    }

    const elapsed = Date.now() - ctx.runStartedAt;

    if (elapsed > budget) {
      const msg = `超时熔断：已用 ${elapsed}ms，超过预算 ${budget}ms`;
      if (d.onExceed === 'pass') {
        ctx.emit({ type: 'log', message: `⚠ ${msg}（按配置照样放行）` });
        return { output: text, warn: msg };
      }
      throw new NodeFailError(msg);
    }

    const left = budget - elapsed;
    ctx.emit({ type: 'log', message: `⏳ 预算剩余 ${left}ms` });
    return { output: text };
  });
}
