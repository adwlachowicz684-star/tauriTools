/**
 * 页签增删与重排后的「活动页签索引」计算。
 *
 * 为什么要抽成纯函数：这段是纯索引算术，写起来顺手、错了却很隐蔽 ——
 * 症状是"拖完之后停在别的页签上"或"删完之后落到越界位置白屏"，
 * 而在界面上复现要连点好几次、还得页签够多。
 * 抽出来就能直接用一张表把所有方向覆盖一遍（见 tab-index-test.mjs）。
 */

/**
 * 页签重排后，当前活动页签应该落在哪。
 *
 * 规则（对应原版"其他页签实时让位"）：
 *   · 拖的正是当前页签 → 跟着走到落点
 *   · 从左往右拖：夹在 [from, to] 之间的页签整体左移一位（含 to）
 *   · 从右往左拖：夹在 [to, from) 之间的页签整体右移一位
 *   · 其余不动
 *
 * @param active 当前活动索引
 * @param from   被拖动页签的原下标
 * @param to     落点下标
 */
export function activeAfterMove(active: number, from: number, to: number): number {
  if (from === to) return active;
  if (active === from) return to;
  if (from < to && active > from && active <= to) return active - 1;
  if (from > to && active >= to && active < from) return active + 1;
  return active;
}

/**
 * 删除页签后，活动索引应该收敛到哪。
 *
 * @param active 当前活动索引
 * @param removed 被删页签的下标
 * @param before 删除**前**的页签总数
 */
export function activeAfterRemove(active: number, removed: number, before: number): number {
  // 删完之后剩 before-1 个，最大合法下标是 before-2
  const maxIndex = before - 2;
  const next = active > removed ? active - 1 : active;
  return Math.max(0, Math.min(next, maxIndex));
}

/**
 * 判断某组页签操作是否合法（供 UI 禁用按钮 / 测试共用）。
 *
 * 单独拎出来是因为"边界能不能点"这件事，界面与规则容易长出两套判断：
 * 按钮的 disabled 写一遍、函数里再判一遍，改一处忘一处就会出现
 * "按钮能点、点了没反应"。这里给唯一答案。
 */
export function canMove(index: number, total: number, delta: number): boolean {
  if (total <= 1) return false;
  if (index < 0 || index >= total) return false;
  const target = index + delta;
  return target >= 0 && target < total;
}

/** 是否允许删除（至少保留一个） */
export function canRemove(total: number): boolean {
  return total > 1;
}

/**
 * 卡片拖到某个页签时，是否该**整个跳过**（#103 / #709）。
 *
 * 卡片已在目标页签里 → 什么都不做。
 *
 * 为什么不能"照常移到末尾"：moveCard 的实现是"先从所有页签里摘掉、再插入目标"，
 * 拖回自己所在的页签就会被移到**末尾**。用户只是想取消这次拖拽
 * （拖起来发现放错地方，又拖回去放下），界面却把卡片挪到了最后一位 ——
 * 他以为取消了，实际改了顺序，而且没有任何提示。
 *
 * 这类"操作没有按预期取消"最伤：用户下次就不敢拖了。
 *
 * @param tabs 该栏的全部页签
 * @param tabIndex 落点页签下标
 * @param path 被拖的卡片路径
 */
/**
 * 页签里的条目两种形态都存在：
 *   · 运行时快照 `TabInfo.items` 是 `CardInfo[]`
 *   · 配置里的 `TabItem.items` 是 `string[]`
 * 所以这里两种都收，而不是只写 `string[]`。
 *
 * **只写 `string[]` 是个真 bug，不是类型洁癖**：调用方传的是
 * `CardInfo[]`，`items.includes(path)` 拿对象去比字符串**恒为 false** ——
 * 于是这条守卫一次也没生效过，#103「拖回源页签 = 无操作」形同虚设
 * （用户拖回去仍会被挪到末尾）。类型不匹配正是它唯一的破绽。
 */
/** 页签里的条目：运行时快照是 `CardInfo`，配置里是路径字符串。 */
export type DropItem = string | { path: string };

export function skipDropToTab(
  tabs: { items: DropItem[] }[],
  tabIndex: number,
  path: string,
): boolean {
  const t = tabs[tabIndex];
  if (!t) return false;
  /* 显式比较 path，而不是 includes —— 后者在形态不匹配时静默失效 */
  return t.items.some((it) => (typeof it === 'string' ? it : it.path) === path);
}
