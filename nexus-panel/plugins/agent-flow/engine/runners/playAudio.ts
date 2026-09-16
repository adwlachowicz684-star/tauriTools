import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { playAudioFile } from '../beep';
import type { PlayAudioNodeData } from '../../types';

/** 播放本地音频文件。需要 fs 与 audio 执行器，浏览器模式下不可用 */
export async function runPlayAudio(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as PlayAudioNodeData;

  await withNodeRun(ctx, async () => {
    const path = ctx.tpl(String(d.path ?? '')).trim();
    if (!path) throw new NodeFailError('没填音频文件路径');

    const volume = Number(d.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new NodeFailError(`音量要在 0~1 之间，当前是 ${d.volume}`);
    }

    const res = await playAudioFile({
      path,
      volume,
      waitForEnd: d.waitForEnd !== false,
      readFile: ctx.opts.playAudioReader,
    });

    if (!res.ok) throw new NodeFailError(res.error ?? '播放失败');
    return { output: `已播放 ${path}` };
  });
}
