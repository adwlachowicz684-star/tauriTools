import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { upstreamText } from '../upstream';
import type { ThrottleNodeData } from '../../types';

/**
 * 限流 —— 控制放行的节奏。
 *
 * ================= 模块级状态是刻意的 =================
 *
 * "上次什么时候放行的"必须跨节点、跨运行地记着，否则限流没有意义 ——
 * 每次运行都从零开始的话，第二次运行就不会被限制了。
 *
 * 代价是这是一份进程级状态（刷新页面会重置）。对本插件的用法
 * （本机跑流程）够用，也比对每次运行做一份快照更容易理解。
 */

const lastPassAt = new Map<string, number>();
/** key = 节点 id；记的是"哪次运行"与"放行过几次" */
const runPass = new Map<string, { startedAt: number; count: number }>();

export async function runThrottle(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as ThrottleNodeData;

  await withNodeRun(ctx, async () => {
    const text = upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input);
    const min = Math.max(0, Number(d.minIntervalMs ?? 0));

    /* ---- 次数上限 ---- */
    const max = Number(d.maxPerRun ?? 0);
    if (Number.isFinite(max) && max > 0) {
      const cur = runPass.get(ctx.id);
      const count = cur && cur.startedAt === ctx.runStartedAt ? cur.count : 0;
      if (count >= max) {
        throw new NodeFailError(`限流：本次运行已放行 ${count} 次，达到上限 ${max}`);
      }
      runPass.set(ctx.id, { startedAt: ctx.runStartedAt, count: count + 1 });
    }

    /* ---- 最小间隔 ---- */
    const last = lastPassAt.get(ctx.id) ?? 0;
    const waitFor = min > 0 ? last + min - Date.now() : 0;
    if (waitFor > 0) {
      ctx.emit({ type: 'log', message: `限流：等待 ${waitFor}ms 后放行` });
      await ctx.sleep(waitFor);
    }
    lastPassAt.set(ctx.id, Date.now());

    return { output: text };
  });
}
