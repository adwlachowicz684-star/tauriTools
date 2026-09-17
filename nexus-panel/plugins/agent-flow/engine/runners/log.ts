import type { RunContext } from '../runContext';
import { withNodeRun } from '../runnerKit';
import type { LogNodeData } from '../../types';
import { upstreamText } from '../upstream';

/**
 * 日志标记：把一段文本写进运行日志，输出原样传给下游。
 *
 * 存在的意义：长流程跑到一半想知道"到这了没""这个变量是什么值"，
 * 靠猜只能把中间结果接到一个终点节点上看输出，很别扭。
 * 这个节点不改变数据流，纯粹是给人看的。
 */
export async function runLog(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as LogNodeData;

  await withNodeRun(ctx, async () => {
    const { id, graph, outputs, opts } = ctx;
    const upstream = upstreamText(graph.edges, id, outputs, opts.input);

    // 留空则记上游内容，这样"想知道这里流过来的是什么"不用填任何东西
    const text = ctx.tpl(String(d.text ?? '')).trim() || upstream;
    const level = d.level ?? 'info';
    const mark = level === 'error' ? '✗' : level === 'warn' ? '⚠' : 'ℹ';

    ctx.emit({ type: 'log', message: `${mark} ${text}` });

    /*
     * 输出原样透传：它不该改变数据流。
     * warn / error 只是日志标记，**不会让流程失败** ——
     * 否则"记一条警告"会连带把下游全跳过，那不是这个节点该干的事。
     */
    return { output: upstream };
  });
}
