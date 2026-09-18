import type { RunContext } from '../runContext';
import { withNodeRun } from '../runnerKit';
import { upstreamText } from '../upstream';
import type { CanvasInNodeData, CanvasOutNodeData } from '../../types';

/**
 * 画布输入 / 输出节点。
 *
 * 这两个节点**不做任何计算**，只是接口标记 ——
 * 真正决定"谁是入口谁是出口"的是 engine/canvasRef.ts 的推导。
 *
 * 运行时它们就是**透传**：
 * 控制流不该改写数据流（这个项目的一条既定原则），
 * 输入节点把上游内容原样交给下游，输出节点把上游内容原样送出画布。
 */

export async function runCanvasIn(ctx: RunContext): Promise<void> {
  await withNodeRun(ctx, async () => {
    const d = ctx.node.data as CanvasInNodeData;
    const up = upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input);
    return {
      output: up,
      fields: {
        端口: String(d.portName ?? '').trim() || '（默认）',
        说明: '画布入口：把外部传进来的数据交给内部下游',
      },
    };
  });
}

export async function runCanvasOut(ctx: RunContext): Promise<void> {
  await withNodeRun(ctx, async () => {
    const d = ctx.node.data as CanvasOutNodeData;
    const up = upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input);
    /*
     * 没接上游时用兜底值，不报错 ——
     * 输出节点常常是"内部结果汇总到这里"，
     * 内部没东西时不该让整张画布失败。
     */
    const out = up || ctx.tpl(String(d.fallback ?? ''));
    return {
      output: out,
      fields: {
        端口: String(d.portName ?? '').trim() || '（默认）',
        说明: '画布出口：把内部结果交给外部下游',
      },
    };
  });
}
