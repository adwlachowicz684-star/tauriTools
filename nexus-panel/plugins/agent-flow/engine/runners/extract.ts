import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { extractText } from '../extract';
import { upstreamText } from '../upstream';
import type { ExtractNodeData } from '../../types';

/**
 * 拼出上游传给本节点的文本。
 *
 * 与条件/并发节点保持同一套约定：有上游就拼接全部上游输出，
 * 没有上游（挂在触发器后面）则用整条流程的输入。
 * 写成一处是为了三边行为一致 —— 各写一份迟早会分叉。
 */
/* 上游取值统一走 engine/upstream —— 那里有为什么抽出来的说明 */
function upstreamOf(ctx: RunContext): string {
  const { id, graph, outputs, opts } = ctx;
  return upstreamText(graph.edges, id, outputs, opts.input);
}

/**
 * 数据提取节点。
 *
 * 不需要任何执行器能力（纯本地字符串处理），所以 engine/nodeRequires.ts 里
 * 没有它的条目 —— 也正因如此，它在浏览器模式下同样可用，不像 HTTP 节点
 * 那样依赖桌面端通道。
 */
export async function runExtract(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as ExtractNodeData;

  await withNodeRun(ctx, async () => {
    const r = extractText(upstreamOf(ctx), d.mode, d.spec, d.group);

    if (!r.ok) {
      /*
       * 关掉"取不到就失败"时输出空串让流程继续，但把原因挂在 warn 上 ——
       * 这样日志里仍看得出那一步没取到，不会无声吞掉。
       * 开着则走标准失败路径（下游跳过）。
       */
      if (!d.failOnMiss) return { output: '', warn: r.error };
      throw new NodeFailError(r.error ?? '提取失败', '');
    }

    /*
     * 刻意不用 `d.trim ? r.text.trim() : r.text` 这种单行三元：
     * scripts/strip-ts.py 会把其中的 `:` 当成类型注解剥掉，
     * 生成的 .mjs 语法错误。多写两行换一个不会踩坑的写法。
     */
    let text = r.text;
    if (d.trim) text = text.trim();
    return {
      output: text,
      // len 给下游判断用：例如"提取结果为空则走兜底分支"
      fields: { text, len: String(text.length) },
      warn: r.warn,
    };
  });
}
