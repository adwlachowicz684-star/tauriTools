/**
 * 每插件的沙箱 / 主题配置
 * ============================================================
 * 把"隔离"从一个大开关拆成**两个独立维度**，在插件自己的设置面板里勾选：
 *
 *   1. 功能隔离 isolated
 *      关（默认）：iframe 带 allow-same-origin，插件可直连外壳
 *                （parent.document / localStorage / Tauri IPC 都够得着），
 *                外部能力直接可用，不需要桥接。
 *      开        ：去掉 allow-same-origin，插件碰不到外壳任何东西，
 *                一切都得走 postMessage 桥接（ctx.store / ctx.invoke 等照常）。
 *
 *   2. 主题适配 adaptTheme
 *      开（默认）：外壳判定插件基调，与面板不一致时自动反转统一。
 *                隔离开启时外壳读不到插件内部，改由插件自报基调。
 *      关        ：完全不碰插件外观，保持它自己的样子。
 *
 * 两个维度自由组合，互不牵连：
 *   隔离关 + 适配开 → 外壳穿透采样，最精准
 *   隔离关 + 适配关 → 原样呈现
 *   隔离开 + 适配开 → 插件自报基调，自动适配
 *   隔离开 + 适配关 → 原样呈现
 */

const KEY = (id) => `nexus:plugin-cfg:${id}`;
const EVENT = 'nexus:plugin-cfg-changed';

export const DEFAULTS = { isolated: false, adaptTheme: true };

export function getPluginConfig(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(id)) || '{}');
    return { ...DEFAULTS, ...raw };
  } catch { return { ...DEFAULTS }; }
}

export function setPluginConfig(id, patch) {
  const next = { ...getPluginConfig(id), ...patch };
  try {
    localStorage.setItem(KEY(id), JSON.stringify(next));
    globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { id, config: next } }));
  } catch { /* 存储不可用时忽略 */ }
  return next;
}

export function onPluginConfigChange(fn) {
  globalThis.addEventListener?.(EVENT, (e) => fn(e.detail?.id, e.detail?.config));
  return () => globalThis.removeEventListener?.(EVENT, fn);
}

/** 供引擎快速读取 */
export const isIsolated = (id) => getPluginConfig(id).isolated;
export const shouldAdaptTheme = (id) => getPluginConfig(id).adaptTheme;
