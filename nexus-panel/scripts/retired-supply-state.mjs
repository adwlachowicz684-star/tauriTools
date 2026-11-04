#!/usr/bin/env node
/**
 * 退场态供给判据（纯函数，零依赖）
 * ============================================================
 * 为什么单独一个文件：守卫要在「vite / react 没装」的环境里也能跑。
 * build-plugins.mjs 顶部 import { build } from 'vite'，直接 import 它会让
 * 守卫在依赖被清掉的沙盒里 MODULE_NOT_FOUND —— 那表现为「守卫没跑」，
 * 而不是「守卫报红」，正是本项目反复栽的静默失效。
 *
 * 判据本身不定义 12 个插件名单：名单属于 plugin-repo-map.mjs / registry.js，
 * 这里再存一份就是无守卫的第二映射表。
 *
 * 三态必须分开：
 *   · source  ：有源码，正常构建（本地开发态），允许 exit 0
 *   · retired ：无源码但有产物（合法退场态，主仓改由 runtime-plugins 供给）
 *   · broken  ：两者皆无，供给链断裂
 *
 * 旧 main() 在 scanIframePlugins() 返回 0 时打印一句就 return ——
 * **构建 0 个插件却 exit 0**，在 CI 里与「全部构建成功」无法区分。
 *
 * @param {string[]} pluginIds  scanIframePlugins() 的结果
 * @param {string[]} productIds listProductPluginIds() 的结果
 * @returns {{mode:'source'|'retired'|'broken', productIds:string[]}}
 */
export function retiredSupplyState(pluginIds, productIds) {
  const src = Array.isArray(pluginIds) ? pluginIds : [];
  const prod = Array.isArray(productIds) ? productIds : [];
  if (src.length > 0) return { mode: 'source', productIds: prod };
  if (prod.length > 0) return { mode: 'retired', productIds: prod };
  return { mode: 'broken', productIds: prod };
}

/** source 态才允许 exit 0；retired / broken 一律非零（fail-closed）。 */
export function retiredExitCode(state) {
  return state && state.mode === 'source' ? 0 : 1;
}
