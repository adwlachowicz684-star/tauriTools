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
 *   2. 主题 themeDark / themeLight —— 插件自选的主题，null 表示跟随全局
 *      （详见 DEFAULTS 上方的说明）
 *
 * ⚠️ 这里原先还有第三个字段 adaptTheme（主题适配开关）。
 * 它控制的是那套"外壳判定插件基调、与面板不一致就罩滤镜反转"的机制 ——
 * 该机制已整套删除：现在外壳只把主题变量推给插件，
 * 插件渲染成什么样就是什么样，插件自己写死配色是插件自己的事。
 * 字段连同 shouldAdaptTheme() 一并删除（它已无任何调用者），
 * 设置页（App.tsx / index.js）与外壳抽屉（shell.js）里的对应开关也已删掉。
 *
 * 旧配置里残留的 adaptTheme 值无害 —— 没人读它了。
 */

const KEY = (id) => `nexus:plugin-cfg:${id}`;
const EVENT = 'nexus:plugin-cfg-changed';

/**
 * themeDark / themeLight —— 插件自选的主题，null 表示跟随全局。
 *
 * 语义（这是最容易搞混的一点）：**不是**"锁定成深色/浅色"，
 * 而是"当整体主题是深色时用哪套、是浅色时用哪套"。
 * 两个都填了，插件就会跟着整体主题的深浅在自己这两套之间切换，
 * 但**不会**跟着用户在深色系列里换主题（比如从石墨换到极光）。
 * 只填一个的话，另一个基调下仍跟随全局。
 */
export const DEFAULTS = {
  isolated: false,
  themeDark: null,
  themeLight: null,
};

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
