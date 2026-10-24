import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';

/**
 * 模块节点本身**不执行** —— 跑之前 expandModules 已经把它换成内部节点了。
 *
 * 能走到这里只可能是**展开没成功**：
 *   · 模块被删了，而这个实例没有脱钩副本
 *   · 模块循环引用（A 里套着 A，或 A→B→A）
 *   · 将来又多出一条没走展开的路径
 *
 * 以前这里**没有**执行器，而 runner 对没有执行器的节点是「直通」——
 * 绿着 success、output 空串、什么都不做。实测：模块被删掉的图跑完是
 * `ok:true, failed:[]`，下游读 `{{模块.output}}` 拿到空串，全程不报错。
 * 用户看到的是「流程跑通了」，而这个模块里的写文件 / 命令行 / 接口
 * 一次都没执行。
 *
 * 所以刻意注册一个**只会失败**的执行器：把展开阶段写进 data.error 的
 * 原因原样报出来（见 engine/modules.ts 里的两处占位），
 * 让人知道要去模块库里补，而不是对着一个绿节点发呆。
 */
export async function runModule(ctx: RunContext): Promise<void> {
  const d = (ctx.node.data ?? {}) as { error?: unknown };
  const raw = typeof d.error === 'string' ? d.error.trim() : '';
  const reason = raw || '模块没能展开（内部结构缺失）';
  await withNodeRun(ctx, async () => {
    throw new NodeFailError(reason);
  });
}
