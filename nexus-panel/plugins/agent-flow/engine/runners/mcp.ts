import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';

/**
 * MCP 节点（连上 server 后由 tools/list 自动生成的那一批）的执行器。
 *
 * ================= 为什么是「明确失败」而不是「直通成功」=================
 *
 * 这一族节点是**动态生成**的 —— 不在 `nodes/defs/` 里，而是连上 server、
 * 拿到工具清单后在侧栏里凭空长出一批。它们共用一个 dataKind（`mcp`），
 * 而静态执行器表（`engine/runnerRegistry.ts` 的 RUNNERS）是手写的，
 * 很容易漏掉这种"运行时才出现"的种类。
 *
 * 漏掉的后果在 runner.ts 的兜底分支：
 *
 *     outputs[id] = '';
 *     setStatus(id, 'success');       ← 绿
 *     emit({ ok: true, output: '' }); ← 成功
 *
 * 于是节点绿着成功、输出为空、什么都没做。用户以为调了 Notion，
 * 其实一次请求都没发出 —— 不报错、日志干净、界面上一切正常，
 * 正是最难查的那一类失效。
 *
 * 所以这里显式注册一个执行器，把"还没接上协议通道"说出来。
 * 与静默成功相比，报错是更好的结果：**它至少是真的**。
 *
 * ================= 关于 nodes 层那个 runPlaceholder =================
 *
 * `nodes/mcpGenerated.tsx` 里也写过一个 runPlaceholder，意图与这里一致。
 * 但 `NodeDef.run` 这个字段**全仓没有任何一处消费** —— 执行分发只认
 * RUNNERS（且 GraphNode 只有 {id, data}，拿不到 type，也没法按 def 查）。
 * 于是那个占位执行器永远不会跑，最糟的结果照样发生。
 *
 * 真正能保证生效的只有 RUNNERS 这一处，所以放这里。
 */
export async function runMcp(ctx: RunContext): Promise<void> {
  const d = (ctx.node.data ?? {}) as Record<string, unknown>;

  await withNodeRun(ctx, async () => {
    const server = String(d.mcpServer ?? '').trim();
    const tool = String(d.mcpTool ?? '').trim();
    const who = tool && server
      ? `「${tool}」由 ${server} 提供`
      : (server ? `${server} 的这个工具` : '这个 MCP 工具');
    /*
     * 必填参数检查**刻意不做**：节点反正会失败，先报"缺参数"会让人
     * 以为补齐参数就能跑通。真正的原因只有一条 —— 协议通道没接上。
     */
    throw new NodeFailError(
      `${who} —— MCP 协议的调用通道还没接上，这个节点当前不会真的调用工具`,
    );
  });
}
