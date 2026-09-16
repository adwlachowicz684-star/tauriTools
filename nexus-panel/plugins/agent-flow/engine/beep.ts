/**
 * 提示音合成。
 *
 * 用 Web Audio 的振荡器现场合成，不加载任何音频文件：
 *   · 不需要打包资源，也不要求用户机器上有对应文件
 *   · 不读磁盘，因此不受 fs 授权目录限制
 *   · 浏览器与 Tauri 都可用（两边都有 AudioContext）
 *
 * 失败时返回错误说明而不是抛异常 —— 提示音播不出来不该中断流程，
 * 静音环境、没有音频设备、浏览器自动播放策略都会挡住它。
 */

import type { BeepPreset } from '../types';

/** 每个 preset 是一串 [频率Hz, 时长ms] */
const PATTERNS: Record<BeepPreset, Array<[number, number]>> = {
  // 两声上行短音
  success: [[660, 90], [880, 130]],
  // 两声下行低音
  fail: [[330, 130], [220, 200]],
  // 一声中音
  notice: [[520, 160]],
  // 三声急促高音
  alarm: [[980, 80], [980, 80], [980, 80]],
};

/** 音之间的间隔，让连音听得出来是几声 */
const GAP_MS = 60;

type Ctor = typeof AudioContext;

function getCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * 播放内置提示音。
 *
 * @returns null 表示成功；字符串是失败原因（不抛异常）
 */
export async function playBeep(preset: BeepPreset, volume: number): Promise<string | null> {
  const Ctor = getCtor();
  if (!Ctor) return '当前环境不支持 Web Audio，已跳过提示音';

  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    /*
     * 浏览器自动播放策略：未经用户交互创建的 AudioContext 是 suspended，
     * 不 resume 就完全没声音，而且不报错 —— 这种"静默失败"最难排查，
     * 所以这里显式 resume 并等待。
     */
    if (ctx.state === 'suspended') await ctx.resume();

    const pattern = PATTERNS[preset] ?? PATTERNS.notice;
    let at = ctx.currentTime;

    for (const [freq, dur] of pattern) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;

      /*
       * 首尾各留一点淡入淡出。
       * 直接开关增益会有"啪"的爆音（波形突变），听起来很难受。
       */
      const fade = Math.min(0.02, dur / 1000 / 4);
      const t0 = at;
      const t1 = at + dur / 1000;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(volume, t0 + fade);
      gain.gain.setValueAtTime(volume, t1 - fade);
      gain.gain.linearRampToValueAtTime(0, t1);

      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1);

      at = t1 + GAP_MS / 1000;
    }

    // 等最后一个音放完再返回，避免上下文被提前关掉
    const totalMs = (at - ctx.currentTime) * 1000 + 50;
    await new Promise((r) => setTimeout(r, totalMs));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    // 关掉上下文，否则每个节点都留一个，跑多了会耗尽
    try { await ctx?.close(); } catch { /* 关不掉就算了 */ }
  }
}

type ReadFile = (path: string) => Promise<string>;

export type PlayAudioOpts = {
  path: string;
  volume: number;
  waitForEnd: boolean;
  readFile?: ReadFile | null;
};

/**
 * 播放本地音频文件。
 *
 * @param readFile 读文件为 DataURL。由执行器注入（Tauri 走 fs 通道，
 *                 浏览器模式下没有这个能力，注入空即可触发明确报错）。
 */
export type PlayAudioResult = { ok: boolean; error?: string };

export async function playAudioFile(opts: PlayAudioOpts): Promise<PlayAudioResult> {
  if (!opts.readFile) {
    return { ok: false, error: '当前环境无法读取本地文件（可能运行在浏览器模式）' };
  }
  const Ctor = getCtor();
  if (!Ctor) return { ok: false, error: '当前环境不支持 Web Audio' };

  let dataUrl = '';
  try {
    dataUrl = await opts.readFile(opts.path);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!dataUrl) return { ok: false, error: '读到的音频是空的' };

  /*
   * 用 Audio 元素而不是 decodeAudioData：
   * 后者要一次性把整个文件解码进内存，几十 MB 的音频会明显卡顿；
   * 而且我们只是播放，不需要拿到采样数据做处理。
   */
  return new Promise((resolve) => {
    let audio: HTMLAudioElement | null = null;
    try {
      audio = new Audio(dataUrl);
      audio.volume = Math.max(0, Math.min(1, opts.volume));

      const done = () => resolve({ ok: true });
      const fail = () => resolve({ ok: false, error: '音频播放失败，可能是格式不支持或文件损坏' });

      audio.addEventListener('ended', done, { once: true });
      audio.addEventListener('error', fail, { once: true });

      void audio.play().catch(() => {
        // 自动播放策略会挡住，但这不算"播放失败"，给用户一条明确说明
        resolve({ ok: false, error: '浏览器拦截了自动播放，请先点一下页面再试' });
      });

      if (!opts.waitForEnd) {
        // 不等播完：立刻返回，声音继续放
        resolve({ ok: true });
      }
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
