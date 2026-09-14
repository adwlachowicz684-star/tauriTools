/**
 * Tauri API 兼容层
 * ------------------------------------------------------------
 * 同时兼容两种运行方式：
 *   1) 无构建工具：依赖 tauri.conf.json 里的 app.withGlobalTauri = true
 *      → 使用 window.__TAURI_INTERNALS__
 *   2) Vite / npm：动态 import('@tauri-apps/api/*')
 * 取不到时优雅降级为 null，面板仍可作为纯前端外壳运行（便于浏览器里调 UI）。
 */

/**
 * 能力探测结果缓存。
 *
 * **只缓存成功，失败不缓存。**
 * 此前是 `if (_cache !== undefined) return _cache`，失败也会把 null 写进缓存
 * —— 于是首次调用时若环境尚未就绪（Tauri 注入时机晚于页面脚本，
 * 浏览器调试模式下则是压根没有），就永久缓存了失败结果：
 * 后面即便环境好了，面板也永远停在降级态，表现是"功能莫名不可用"。
 *
 * 失败重试的代价只是一次属性读取加一次动态 import，可以忽略。
 */
let _cache = undefined;   // undefined = 还没探测过；null = 探测过但没拿到

export async function getTauri() {
  if (_cache) return _cache;      // 命中成功缓存（null 会落到这里之外，继续重探）

  const w = typeof window !== 'undefined' ? window : globalThis;

  // ① 全局注入（withGlobalTauri）
  const g = w.__TAURI_INTERNALS__;
  if (g && typeof g.invoke === 'function') {
    _cache = {
      mode: 'global',
      invoke: (cmd, args) => g.invoke(cmd, args),
      transformCallback: g.transformCallback,
      convertFileSrc: g.convertFileSrc,
    };
    return _cache;
  }

  // ② npm 包（Vite 等打包器会静态分析并打包这里的 import）
  try {
    const core = await import('@tauri-apps/api/core');
    _cache = {
      mode: 'npm',
      invoke: (cmd, args) => core.invoke(cmd, args),
      transformCallback: core.convertFileSrc ? undefined : undefined,
      convertFileSrc: core.convertFileSrc,
    };
    return _cache;
  } catch {
    /* 未安装依赖，继续降级 */
  }

  // 探测失败：不写入缓存，留待下次重试
  return null;
}

/**
 * 事件系统：优先用 Tauri 原生事件（Rust 可推送），
 * 拿不到时返回 null —— 此时插件间通信走 shell 内置的纯前端事件总线。
 */
export async function getTauriEvent() {
  const w = globalThis;

  if (w.__TAURI_EVENT_PLUGIN_INTERNALS__ && typeof w.__TAURI_EVENT_PLUGIN_INTERNALS__.listen === 'function') {
    const ev = w.__TAURI_EVENT_PLUGIN_INTERNALS__;
    return { mode: 'global', listen: ev.listen, emit: ev.emit, unlisten: ev.unlisten };
  }
  try {
    const ev = await import('@tauri-apps/api/event');
    return { mode: 'npm', listen: ev.listen, emit: ev.emit, unlisten: ev.unlisten };
  } catch {
    return null;
  }
}

/** 判断当前是否运行在 Tauri 壳内 */
export function isInsideTauri() {
  const w = globalThis;
  return !!(w.__TAURI_INTERNALS__ || w.isTauri || navigator.userAgent.includes('Tauri'));
}
