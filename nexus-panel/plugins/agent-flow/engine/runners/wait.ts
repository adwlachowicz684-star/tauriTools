import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { sleep } from '../sleep';
import type { WaitNodeData } from '../../types';

/** 等待节点。就是 sleep，但把"支持模板"与"时间上限"收在自己这里 */
export async function runWait(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as WaitNodeData;

  await withNodeRun(ctx, async () => {
    /*
     * ms 支持模板：{{上游.output}} 里可能算出一个时长。
     * 渲染后是字符串（"2000"），要转数字 —— 不转的话延时恒为 0。
     */
    const raw = ctx.tpl(String(d.ms ?? ''));
    const ms = Number(raw);

    if (!Number.isFinite(ms) || ms < 0) {
      throw new NodeFailError(`等待时长不是有效数字：${raw}`);
    }

    /*
     * 上限 10 分钟。
     * 不设上限的话，模板里一个笔误（比如把秒当毫秒写成 3600000）
     * 会让流程卡死一小时，而用户看不到任何提示，只会以为它挂了。
     */
    const MAX = 10 * 60 * 1000;
    const safe = Math.min(ms, MAX);
    if (safe !== ms) {
      ctx.emit({ type: 'log', message: `等待时长 ${ms}ms 超过上限，已按 ${MAX}ms 执行` });
    }

    await sleep(safe);
    return { output: `已等待 ${safe}ms` };
  });
}
