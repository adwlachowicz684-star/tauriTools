import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { checkPass } from '../passCheck';
import { upstreamText } from '../upstream';
import type { GateNodeData } from '../../types';

/**
 * 闸门 —— 满足条件才放行下游。
 *
 * ================= 两种模式 =================
 *
 *   now  —— 立刻判定：不满足就失败，下游跳过。
 *           用于"这个条件不满足就别往下跑了"。
 *
 *   wait —— 轮询等待：每隔 pollMs 重新取一次上游输出再判，
 *           直到满足或超过 timeoutMs。用于"等某个东西就绪"。
 *
 * ================= 关于 wait 模式的一个说明 =================
 *
 * 引擎是按拓扑分层推进的，**上游在本节点执行前就已经跑完了**。
 * 所以"等"等到的通常不是上游重新执行 —— 轮询重新判定的是
 * 上游已经产出的那份输出（它在跑完那一刻就固定了）。
 *
 * 那为什么还要轮询？因为循环体内会重跑：闸门在循环体里时，
 * 每轮进来都是新一轮的上游输出。另外 ctx.tpl 渲染的结果
 * 也可能随 nodeFields 变化。真正"等外部条件"的场景
 * （等文件出现、等接口就绪）靠的是这种每轮重判。
 */
export async function runGate(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as GateNodeData;

  await withNodeRun(ctx, async () => {
    const text = upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input);
    const check = String(d.check ?? 'nonempty');
    const value = String(d.value ?? '');

    const first = checkPass(text, check, value);
    if (first.ok) return { output: text };

    if (d.mode !== 'wait') {
      throw new NodeFailError(`闸门未放行：${first.reason}`);
    }

    const timeoutMs = Math.max(0, Number(d.timeoutMs ?? 10000));
    const pollMs = Math.max(50, Number(d.pollMs ?? 500));
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await ctx.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      // 重新取一次 —— 循环体内每轮的上游输出是不同的
      const nowText = upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input);
      const r = checkPass(nowText, check, value);
      if (r.ok) {
        ctx.emit({ type: 'log', message: `闸门放行（等待后满足条件）` });
        return { output: nowText };
      }
    }

    if (d.onTimeout === 'pass') {
      const nowText = upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input);
      ctx.emit({ type: 'log', message: `⚠ 闸门等待超时，按配置照样放行` });
      return { output: nowText, warn: `等待超时（${timeoutMs}ms）仍未满足：${first.reason}` };
    }

    throw new NodeFailError(`闸门等待 ${timeoutMs}ms 仍未满足：${first.reason}`);
  });
}
