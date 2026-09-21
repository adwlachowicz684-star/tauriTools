import type { NodeData } from '../types';

/**
 * 节点的「关闭」开关。
 *
 * ================= 为什么不是删掉 ====================
 *
 * 调试时常要临时停掉某一步：删了就得重连上下游，
 * 而"先关掉、待会儿再开"才是真实用法。
 *
 * ================= 关掉之后 ====================
 *
 * 卡片**照常显示缺参 / 缺项**，只是圆点变灰。
 *
 * 把整个徽章去掉的话，你重新打开时才发现它其实一直没配好 ——
 * 关掉不等于修好，缺什么还得看得见。
 *
 * 圆点变灰是唯一能一眼区分"关着的"和"配好的"的地方。
 *
 * ================= 字段 ====================
 *
 * 用 `disabled` 而不是 `enabled`：
 * 缺省即"开着"，老存档没有这个字段也不会变成一堆关掉的节点。
 *
 * 触发器历史上另有一个 `enabled` 字段（节点级"启用这个触发器"），
 * 与这里的 `disabled` 是**同一件事的两个副本**。
 * 两个副本的后果：关掉其中一个，另一个还开着，
 * 界面上又有两个开关，用户不知道该拨哪个、也不知道当前到底算不算关。
 * 所以这里把 `enabled === false` 也算作关闭 —— 一份真相，兼容老存档。
 */

/**
 * 关着吗。
 *
 * 只看 `disabled`；触发器额外看老字段 `enabled === false`。
 *
 * 口径一律 `=== false` / `=== true`，不写 `!x`：
 * 老存档没有这些字段，取到 undefined，
 * `!undefined` 为真会把好端端的节点全判成关着的。
 */
export function isNodeDisabled(data: { data?: Record<string, unknown> } | undefined): boolean {
  const d = data?.data as Record<string, unknown> | undefined;
  if (!d) return false;
  return d.disabled === true || d.enabled === false;
}

export function nodeDisabledOf(d: NodeData | Record<string, unknown> | undefined): boolean {
  const x = d as Record<string, unknown> | undefined;
  if (!x) return false;
  return x.disabled === true || x.enabled === false;
}
