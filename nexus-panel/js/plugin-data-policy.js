/**
 * 卸载时的用户数据去留策略（纯函数，零运行时依赖）。
 *
 * ------------------------------------------------------------------
 * 为什么需要单独一条策略，而不是"卸载就清"或"卸载就不清"
 * ------------------------------------------------------------------
 * 宿主里有**两条**卸载路径，它们的语义本该一致，实际却相反：
 *
 *   1. js/plugin-installer.js 的 uninstallPlugin
 *      —— 默认保留用户数据，只有显式 removeUserData 才删（D3）。
 *   2. js/host.js 的 removePlugin（ctx.removePlugin / 界面卸载按钮）
 *      —— purgePluginStorage(id) **无条件清**。
 *
 * 第 2 条这么写的理由写在它自己的注释里：
 *   「重装会是新的 custom-时间戳 id，不存在留着以后用的场景」
 * 这个假设对 **custom-*** 插件成立（id 含时间戳，重装必然是新 id，
 * 旧数据永远没人再来取）。但它对**市场插件不成立**：市场插件的 id
 * 由仓库决定、固定不变，重装就是同一个 id —— 数据留着才谈得上
 * "重装可恢复"（决策 D3）。
 *
 * 于是出现一个静默失效：市场插件走 host.removePlugin 卸载时，
 * 用户数据被清掉，而"卸载保留数据"这条承诺在界面上完全看不出被绕过。
 * 本文件把去留判断抽出来，让两条路径共用同一个结论。
 *
 * ------------------------------------------------------------------
 * 默认方向的取舍：判不准时宁可"多留"，不能"多删"
 * ------------------------------------------------------------------
 * 两个方向都有代价，但**不对等**：
 *   · 多留 → 残留数据占空间、理论上可被手工清理（可逆）
 *   · 多删 → 用户的配置/状态**不可恢复**（不可逆）
 * 所以判定不准时默认**保留**；只有能确认是 custom 来源时才清。
 * 这也意味着将来新增来源类型时，默认落点是安全的那一侧。
 *
 * ------------------------------------------------------------------
 * 刻意不做的事
 * ------------------------------------------------------------------
 *   · **不在这里撤销授权**（revokeAllGrants / revokePluginHosts）。
 *     授权跟的是"用户放行过什么"，插件卸载就该撤销 —— 与数据去留无关，
 *     市场插件重装后重新授权才是对的（内容可能已变）。
 *   · **不碰 nexus:fsclaim:<id> 文件账本**。它用的是 plugin-fs 自有前缀，
 *     按设计不参与清理（账本是"将来手工清理"的依据，N42）。
 */

/** 来源类型：由 install 通道写入，与 nexus.plugin.json 的 source 对齐。 */
export const SOURCE_CUSTOM = 'custom';
export const SOURCE_MARKET = 'market';

/**
 * 判断这次卸载要不要连带清掉用户数据。
 *
 * @param {object} p
 * @param {string} p.id                 插件 id
 * @param {string} [p.source]           来源：'custom' | 'market'，未知留空
 * @param {boolean} [p.removeUserData]  用户显式要求"连数据一起删"
 * @param {boolean} [p.purgeData]       removeUserData 的同义别名（两条路径用词不同）
 * @returns {boolean} true = 清；false = 保留
 */
export function shouldPurgeDataOnUninstall(p) {
  const o = p || {};

  /* 显式要求删：两条路径的用词都认，且**优先级最高** ——
     用户点"同时删除我的数据"就该删，不管来源是什么。
     （用 === true 而不是真值判断：传 undefined 不能当成 false 之外的第三种。） */
  if (o.removeUserData === true || o.purgeData === true) return true;

  /* 确认是 custom 来源 → 沿用既有行为（清）。
     判据只看显式声明的 source，不靠 id 前缀猜 ——
     id 长什么样是插件作者定的，拿 "custom-" 前缀当判据会被
     一个恰好叫 custom-xxx 的市场插件骗过去。 */
  if (o.source === SOURCE_CUSTOM) return true;

  /* 确认是市场来源 → 保留（D3 的核心） */
  if (o.source === SOURCE_MARKET) return false;

  /* 来源未知 → 保留。理由见文件头"默认方向的取舍"。
     这里刻意**不**去看 id 前缀：没有 source 就说明通道没写，
     此时猜错方向（多删）的代价是不可逆的。 */
  return false;
}

/**
 * 把"来源"归一化成规范值，供台账/界面统一使用。
 *
 * 只认两个已知值，其它一律返回 null（表示"未知"），
 * **不**把未知值原样透传 —— 否则一个拼写错的 'markt'
 * 会一路流到 shouldPurgeDataOnUninstall 并落到"保留"分支，
 * 而它本该被当成未知来源单独处理。
 *
 * @param {unknown} v
 * @returns {'custom'|'market'|null}
 */
export function normalizeSource(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === SOURCE_CUSTOM) return SOURCE_CUSTOM;
  if (s === SOURCE_MARKET) return SOURCE_MARKET;
  return null;
}
