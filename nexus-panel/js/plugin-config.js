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

/* 与宿主侧（js/host.js 的 purgePluginStorage）同一套键格式 ——
   那边卸载时按这个键清配置，两边拼法岔开就是"卸载了配置还在"。 */
import { pluginCfgKey } from './plugin-store.js';

const KEY = pluginCfgKey;
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

/**
 * 写入并**如实回答落没落盘**。
 *
 * 这是给界面用的那一个：开关拨过去之后要说"已保存"，就必须先知道
 * 到底存没存成。存储不可用（配额满、隐身模式、隔离态 SecurityError）时
 * `localStorage.setItem` 会抛 —— 那时**一个字节都没写进去**，而调用方
 * 拿到的 `next` 看起来跟成功时一模一样。
 *
 * 照旧写法的后果：界面把开关画成"已开启"、弹一句「已保存，重载插件后生效」，
 * 用户照着提示重载插件 —— 值还是旧的。**说了保存却没保存**，且全程不报错，
 * 与本项目一贯的"谎报成功比不报更糟"同一类。
 *
 * @returns {{config: object, saved: boolean}}
 */
export function savePluginConfig(id, patch) {
  const next = { ...getPluginConfig(id), ...patch };
  let saved = false;
  try {
    localStorage.setItem(KEY(id), JSON.stringify(next));
    saved = true;
  } catch { /* 存储不可用：如实回 saved=false，不假装成功 */ }
  // 只在真的写成了才广播：没落盘却让宿主按新值重推，同样是谎报
  if (saved) {
    globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { id, config: next } }));
  }
  return { config: next, saved };
}

/**
 * 只回配置（**不告诉调用方落没落盘**）。
 *
 * 保留它是因为 `ctx.shell.pluginConfig.set` 的对外契约就是"回配置对象"
 * （插件那边按 `get` 的返回值形状在用）。需要向用户报"已保存"的
 * **界面**一律用 `savePluginConfig` —— 说成功之前必须先知道成功没有。
 */
export function setPluginConfig(id, patch) {
  return savePluginConfig(id, patch).config;
}

export function onPluginConfigChange(fn) {
  globalThis.addEventListener?.(EVENT, (e) => fn(e.detail?.id, e.detail?.config));
  return () => globalThis.removeEventListener?.(EVENT, fn);
}

/** 供引擎快速读取 */
export const isIsolated = (id) => getPluginConfig(id).isolated;
