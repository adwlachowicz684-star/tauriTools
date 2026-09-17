import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { playBeep } from '../beep';
import { upstreamText } from '../upstream';
import type { BeepNodeData } from '../../types';

/**
 * 提示音：用 Web Audio 合成，不加载任何音频文件。
 *
 * 典型用途是长时间无人值守的流程 —— 跑完了响一声，
 * 不用一直盯着日志看。
 */
export async function runBeep(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as BeepNodeData;

  await withNodeRun(ctx, async () => {
    /*
     * 没填 / 不是有效数字时用默认音量，而不是报错。
     * 老存档的节点可能没有 volume 字段，报错只会显示
     * 「音量要在 0~1 之间，当前是 undefined」，用户看不懂该怎么修。
     * 但显式填了个越界值（如 5）仍然要报错 —— 那是真的配错了。
     */
    const raw: unknown = d.volume;
    const empty = raw === undefined || raw === null || raw === '';
    const volume = empty ? 0.6 : Number(raw);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new NodeFailError(`音量要在 0~1 之间，当前是 ${raw}`);
    }

    /*
     * 音频播不出来不该让流程失败 —— 它只是个提示。
     * 静音环境、没有音频设备、浏览器未交互过（自动播放策略）
     * 都会导致播不出来，这些都不该中断正事。
     * 所以失败只告警，输出仍算成功。
     */
    const err = await playBeep(d.preset ?? 'success', volume);
    // 失败时也透传，不让下游拿到空串
    if (err) {
      return {
        output: upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input),
        warn: err,
      };
    }

    // 透传，理由同 wait —— 控制流不该改写数据流
    ctx.emit({ type: 'log', message: '🔔 已播放提示音' });
    return { output: upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input) };
  });
}
