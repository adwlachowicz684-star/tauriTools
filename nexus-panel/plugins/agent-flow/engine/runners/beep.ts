import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { playBeep, playAudioFile } from '../beep';
import { upstreamText } from '../upstream';
import type { BeepNodeData } from '../../types';

/**
 * 播放声音：系统音效（Web Audio 合成）或本地音频文件。
 *
 * 提示音与播放音频原本是两个节点两个 runner，
 * 但它们做的是同一件事（响一声），且**都带 volume** ——
 * 音量校验那段逻辑随之写了两遍。合并后只有一份。
 *
 * 典型用途是长时间无人值守的流程 —— 跑完了响一声，
 * 不用一直盯着日志看。
 */
export async function runBeep(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as BeepNodeData;
  /*
   * 缺省 'preset'：老存档里没有 source 字段，
   * 而它们当初的行为正是系统音效。
   */
  const source = d.source ?? 'preset';

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
    /*
     * 播不出来不该让流程失败 —— 它只是个提示。
     * 静音环境、没有音频设备、浏览器未交互过（自动播放策略）
     * 都会导致播不出来，这些都不该中断正事。
     *
     * 唯一例外是**本地文件这条路**：文件不存在是配置错误，
     * 静默放行会让人以为"我配的文件播过了"。
     */
    if (source === 'file') {
      const path = ctx.tpl(String(d.path ?? '')).trim();
      /*
       * 没填路径必须指名是"音频文件"没填 ——
       * 只说"没填路径"的话，用户会去检查系统音效那一栏，
       * 而那一栏在文件模式下根本不显示。
       */
      if (!path) throw new NodeFailError('没填音频文件路径');

      const res = await playAudioFile({
        path,
        volume,
        waitForEnd: d.waitForEnd !== false,
        readFile: ctx.opts.playAudioReader,
      });
      if (!res.ok) throw new NodeFailError(res.error ?? '播放失败');
      ctx.emit({ type: 'log', message: `🎵 已播放 ${path}` });
      return { output: upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input) };
    }

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
