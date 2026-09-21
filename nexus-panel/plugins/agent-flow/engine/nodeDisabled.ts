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
 */

/** 关着吗。只看这一个字段，不做任何推断 */
export function isNodeDisabled(data: { data?: Record<string, unknown> } | undefined): boolean {
  return (data?.data as Record<string, unknown> | undefined)?.disabled === true;
}

export function nodeDisabledOf(d: NodeData | Record<string, unknown> | undefined): boolean {
  return (d as Record<string, unknown> | undefined)?.disabled === true;
}
