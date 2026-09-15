/**
 * 后端通道体检。
 *
 * 背景（审查项 A-01）：本插件是 iframe 沙箱插件，却直接 import 了
 * `@tauri-apps/api/core` 的 invoke。开启「严格沙箱」后 iframe 变成
 * opaque origin，`__TAURI_INTERNALS__` 不可达，invoke 全部失败 ——
 * 而失败发生时界面上只是一片安静：按钮点了没反应，没有任何报错。
 *
 * 全量改走 ctx.invoke 才是根治（要连带重做事件转发），那是另一个量级的改动。
 * 这里先做能立刻生效的一半：**启动时主动探一次，把"通道不通"变成看得见的提示**，
 * 而不是等用户点了某个功能才发现它一直是坏的。
 *
 * 探测用 `app_version`：Rust 侧已有、无副作用、开销可忽略。
 */

import { invoke, isTauri } from '@tauri-apps/api/core';

/** 探测结果。ok=false 时 reason 直接展示给用户 */
export type ChannelStatus = {
  ok: boolean;
  /** 界面上直接显示的说明 */
  reason: string;
  /**
   * 是否疑似被沙箱隔离。
   * true 时提示语要指向"关闭严格沙箱"这个具体动作，否则用户无从下手。
   */
  isolated: boolean;
};

const OK: ChannelStatus = { ok: true, reason: '', isolated: false };

let cached: ChannelStatus | null = null;
let inflight: Promise<ChannelStatus> | null = null;

/**
 * 体检一次，结果缓存（同一会话里不必反复探）。
 *
 * 判据分两层：
 *  1. isTauri() 为假 —— 根本不在 Tauri 壳里，或 IPC 句柄不可达
 *  2. invoke 真的抛错 —— 句柄在但命令调不通（scope 未放行等）
 *
 * 第 1 层里的大多数情况其实是"被隔离"：面板明明跑在 Tauri 里，
 * 只是这个 iframe 拿不到句柄。所以提示语要能区分，别一律说"请用桌面端"。
 */
export async function checkChannel(): Promise<ChannelStatus> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async (): Promise<ChannelStatus> => {
    if (!isTauri()) {
      return {
        ok: false,
        isolated: true,
        reason: '当前拿不到桌面端通道，运行 / 文件 / 监听 / Webhook 等功能都不可用。'
          + '若插件设置里开了「严格沙箱」，请关掉它后重载插件。',
      };
    }
    try {
      await invoke<string>('app_version');
      return OK;
    } catch (e) {
      return {
        ok: false,
        isolated: false,
        reason: `后端命令调用失败（${String(e)}）。请重载插件；若持续出现，检查 Rust 侧命令是否已注册。`,
      };
    }
  })();

  cached = await inflight;
  inflight = null;
  return cached;
}

/** 同步取已缓存的结果；还没探过返回 null。用于渲染时避免闪一下"不可用" */
export function peekChannel(): ChannelStatus | null {
  return cached;
}

/** 仅供测试：清掉缓存 */
export function resetChannelCache(): void {
  cached = null;
  inflight = null;
}
