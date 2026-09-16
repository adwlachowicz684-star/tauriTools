import type { RunContext } from '../runContext';
import { withNodeRun } from '../runnerKit';
import type { ConstNodeData } from '../../types';

/**
 * 常量节点：输出一个固定值给下游。
 *
 * 名字叫"常量"，但值支持模板，所以实际是"拼一段固定文本"。
 * 典型用途：给文件写入节点提供一段固定的头部、给 HTTP 请求提供
 * 一个固定 body、给条件节点提供一个比较基准。
 */
export async function runConst(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as ConstNodeData;

  await withNodeRun(ctx, async () => {
    return { output: ctx.tpl(String(d.value ?? '')) };
  });
}
