/**
 * 预设图标分组的清理与维护（#12）。
 *
 * 「失效项」指的是：**分组里记着这个名字，但图标已经不存在了**。
 * 常见于插件更新时删掉了某些内置图标 —— config 里的旧名字还在，
 * 界面上就是一格破图，且没有任何报错。
 */

import type { IconGroup } from '../types';

/**
 * 按已知清单找出失效项（同步判据）。
 *
 * 只认**确定不在清单里**的。清单本身是构建时生成的真相源，
 * 所以这一路判断没有误伤风险。
 *
 * @param groups 待检查的分组
 * @param known 已知有效的图标名（PRESET_ICON_NAMES）
 * @returns 被判定失效的名字（去重、保序）
 */
export function staleByList(groups: IconGroup[], known: string[]): string[] {
  const set = new Set(known);
  const out: string[] = [];
  for (const g of groups) {
    for (const n of g.icons) {
      if (!set.has(n) && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/**
 * 探测函数：加载一个图标名 → true 表示能加载。
 *
 * 抽成具名类型不只是为了好看 —— 直接写 `(name: string) => Promise<boolean>`
 * 这种内联函数类型注解，测试用的类型剥离器处理不了（会把 `=> Promise<boolean>`
 * 当成函数体留下），于是测试根本 import 不进来。给类型一个名字就绕开了。
 */
export type IconProbe = (name: string) => Promise<boolean>;

/**
 * 逐个探测图标文件是否真的能加载。
 *
 * **为什么要分出这一路**：`staleByList` 只能发现"清单里没这个名字"，
 * 发现不了"清单里有、但物理文件漏发了"（发布时漏拷一个 .ico）。
 * 那种情况界面上同样是破图。
 *
 * @param names 待探测的名字
 * @param load 加载一个名字 → true 表示能加载。抽出来自测时可注入假的。
 * @returns 探测为失效的名字
 */
export async function staleByProbe(names: string[], load: IconProbe): Promise<string[]> {
  const out: string[] = [];
  for (const n of names) {
    let ok = false;
    try {
      ok = await load(n);
    } catch {
      /*
       * **加载抛异常 ≠ 文件不存在**。
       *
       * 把网络抖动、超时、沙箱限制都当成"失效"删掉的话，
       * 一次抖动就能把整个图标库清空 —— 这比留着几张破图严重得多。
       * 所以只看明确的"加载失败"（load 返回 false），异常一律放过。
       */
      ok = true;
    }
    if (!ok) out.push(n);
  }
  return out;
}

/**
 * 按失效名单清理分组。
 *
 * **清理全部分组，不只是当前看的那一组** ——
 * 只清当前组的话，用户以为清完了，切到别的组还有破图。
 *
 * @param groups 原分组
 * @param stale 要移除的名字
 * @returns 清理后的分组，以及每个分组各清掉了多少
 */
export function pruneGroups(
  groups: IconGroup[], stale: string[],
): { groups: IconGroup[]; removed: number[] } {
  const dead = new Set(stale);
  const removed: number[] = [];
  const next = groups.map((g) => {
    const before = g.icons.length;
    const icons = g.icons.filter((n) => !dead.has(n));
    removed.push(before - icons.length);
    return { name: g.name, icons };
  });
  return { groups: next, removed };
}

/** 清理结果的总数（用于提示"共清掉 N 项"） */
export function totalRemoved(removed: number[]): number {
  return removed.reduce((a, b) => a + b, 0);
}
