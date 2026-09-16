import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { formatTime } from '../clock';
import type { ClockNodeData } from '../../types';

/**
 * 当前时间。常用于生成带时间戳的文件名（交给下游做路径）
 * 或记录流程跑到某一步的时刻。
 */
export async function runClock(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as ClockNodeData;

  await withNodeRun(ctx, async () => {
    const format = String(d.format ?? '').trim();
    if (!format) throw new NodeFailError('没填时间格式，例如 YYYY-MM-DD HH:mm:ss');

    const out = formatTime(format);
    /*
     * 用户可能把占位符写错（如 yyyy、MMM），此时输出会与格式串一样。
     * 不报错（那太粗暴），但给一条提示 —— 否则用户只会觉得"时间没生效"。
     */
    if (out === format && !/\d/.test(format)) {
      return { output: out, warn: '格式串里没有可识别的占位符（支持 YYYY MM DD HH mm ss SSS）' };
    }
    return { output: out };
  });
}
