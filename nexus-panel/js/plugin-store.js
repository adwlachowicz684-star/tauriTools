/**
 * 插件存储的键名（**宿主侧与 SDK 侧共用**）
 * ============================================================
 * 为什么要有这个文件：
 *
 * `ctx.store.*` 这条通路有**两个实现**，各自拼同一批键：
 *   · js/host.js      —— iframe 插件：宿主在自己的文档里代读代写
 *   · js/plugin-sdk.js —— 同页插件：直接碰 localStorage
 *
 * 两边用的是**同一份 localStorage**（同页插件与主页面同文档；iframe 插件
 * 由宿主代劳，落到宿主的文档）。所以键名必须逐字节一致 ——
 * 一旦岔开，"在 A 模式存的值，B 模式读不到"，而且**不报错**
 * （读不到只是返回默认值 def）。
 *
 * 这与「两个壳各自写裸字面量」是同一类坑，只是那一处在 nexus:* 外壳键上，
 * 这一处在 nexus:<插件id>:* 上。
 *
 * ------------------------------------------------------------
 * 刻意**不**纳入的：
 *
 *   · `nexus:fsclaim:<id>` 文件账本 —— 在 js/plugin-fs.js 里自有 PREFIX。
 *     那个文件刻意保持零运行时依赖（N59：沙盒依赖会被 npm install 裁剪），
 *     不为"统一前缀"去破坏它。两套前缀**必须不同**，否则卸载清理
 *     （purgePluginStorage 按 `nexus:<id>:` 前缀扫）会把账本一起删掉，
 *     而账本是"将来手工清理"的依据。
 *   · 外壳级键（nexus:last-plugin / nexus:sidebar-open 等）—— 不属于
 *     任何插件，在 js/host.js 顶部各自导出。
 */

/** 全站统一前缀。带上它是为了不与页面里其它库的键撞车。 */
export const STORE_NS = 'nexus';

/**
 * 单键：`nexus:<插件id>:<k>`
 *
 * k 由插件自己给，可以是 'a' 也可以是 'a/b'（不再分段），
 * 所以这里不做任何转义 —— 插件给的键原样拼进去，
 * 保证"存进去的 k 和取出来的 k 是同一个字符串"。
 */
export function storeKey(pluginId, k) {
  return `${STORE_NS}:${pluginId}:${k}`;
}

/**
 * 前缀：`nexus:<插件id>:`
 *
 * 用于 store.all 的遍历与卸载清理的筛选。
 * 注意 `nexus:<id>:` 与 `nexus:<id2>:` 不会互相误伤 ——
 * 结尾的冒号是分隔符，缺了它 `nexus:ab:` 会被 `nexus:a` 前缀命中。
 */
export function storePrefix(pluginId) {
  return `${STORE_NS}:${pluginId}:`;
}

/**
 * 每插件配置：`nexus:plugin-cfg:<插件id>`
 *
 * 与 ctx.store 分开存：store 是插件自己随便写的 KV，
 * 这份是外壳读的配置（是否启用、挂载模式等），
 * 格式由外壳定，插件不能瞎写。
 */
export function pluginCfgKey(pluginId) {
  return `${STORE_NS}:plugin-cfg:${pluginId}`;
}
