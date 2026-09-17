import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import type { JoinNodeData } from '../../types';

/**
 * 汇合节点（控制器）。
 *
 * ================= 为什么需要它 =================
 *
 * 多入边节点默认是 **OR 语义**：只要有一条入边活着就执行。
 * 这对"分支后汇合"是对的 —— 走任一分支都该能继续往下跑。
 *
 * 但有一类场景要的是 **AND**：几条并行分支**全部完成**才继续。
 * 比如并发抓三个源，全拿到了再汇总分析。OR 语义下只要有一个先完成
 * 下游就跑了，另外两个的结果根本没被等。
 *
 * ================= 两种模式 =================
 *
 *   all（宽松，默认）—— 活着的入边都到齐就放行。
 *     被条件剪掉的分支不算"缺失"，否则条件分支 + 汇合会永远收集不齐。
 *
 *   strict（严格）—— 任何一条入边没产出都算没收集全，直接失败。
 *     用于"这几条路必须都走到"的场合，缺失要暴露而不是静默继续。
 *
 * ================= 关于"等待" =================
 *
 * 引擎按拓扑分层逐层推进，同一层内并发、层间串行 ——
 * 所以汇合节点被调度到时，它的**所有上游都已经处理完了**。
 * "等齐"这件事是分层调度天然保证的，这里不需要真的 await 什么，
 * 只需要在到齐之后**判定**是否放行。
 */
export async function runJoin(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as JoinNodeData;

  await withNodeRun(ctx, async () => {
    const { id, graph, outputs, scope } = ctx;
    const inEdges = graph.edges.filter((e) => e.target === id);

    if (inEdges.length === 0) {
      throw new NodeFailError('汇合节点没有任何输入，等于永远收集不齐');
    }

    /*
     * 三种"没到"的状态：
     *   deadEdges  —— 被条件分支剪掉（那条路根本不该走）
     *   skippedSet —— 上游自己被跳过了（它上面失败/跳过）
     *   failedSet  —— 上游失败了（这种情况引擎在调度时就已经 skip 本节点了，
     *                 这里再列一次只为让报错信息完整）
     */
    const missing = inEdges.filter((e) => (
      scope.deadEdges.has(e.id)
      || scope.skippedSet.has(e.source)
      || scope.failedSet.has(e.source)
    ));

    const strict = d.mode === 'strict';
    if (strict && missing.length > 0) {
      const names = missing.map((e) => e.source).join('、');
      throw new NodeFailError(
        `严格汇合：有 ${missing.length} 条输入没收集到（${names}）`,
      );
    }

    /*
     * 只合并"真的产出了"的那些。
     *
     * 宽松模式下被剪枝的分支不算缺失，但它的输出也不该混进来 ——
     * outputs 里没有它，取到的是空串，拼进去会多出一个空行。
     */
    const arrived = inEdges.filter((e) => !missing.some((m) => m.id === e.id));
    const sep = unescape(String(d.joinBy ?? '\\n'));
    const merged = arrived
      .map((e) => outputs[e.source] ?? '')
      .filter((v) => v !== '')
      .join(sep);

    return { output: merged };
  });
}

/**
 * 把 '\n' 这类字面上写的转义还原成真字符。
 *
 * 用户在输入框里填的是两个字符 \ 和 n，直接用的话会拼出字面 "\n"
 * 而不是换行 —— 这种错不报错，只是输出长得不对，很难发现。
 */
function unescape(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}
