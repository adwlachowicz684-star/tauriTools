/**
 * 导入导出的共用口径。
 *
 * 自定义预设 / 模块 / 变量这三处是**同一份结构**：
 * 都是 `{ version, <字段>: [...] }` 的包装、都认裸数组、都支持 merge / replace。
 * 因此它们也会踩**同一个洞**，各写一遍就是各漏一遍 —— 所以共用口径收在这里。
 */

/**
 * 【破坏性】replace 模式下的一条共同防线：文件全是坏条目时，不能顺带清空原有的。
 *
 * 洞是在预设那边实测出来的：
 *
 *   导入一个**全是坏条目**的文件，选了替换 → 原有预设**全部消失**。
 *   提示框只报「跳过 N 条」，只字未提"你原有的一起没了"。
 *
 * 因为 replace 的语义是"先把 current 清空，再往里塞"，而"塞不进去"
 * 并不会把清空的动作撤销 —— 于是"导入失败"和"清空"同时发生了。
 *
 * 怎么区分"用户真想清空"和"文件坏了"：
 *   · 列表本身是空的（0 条）→ 那是明确意图，照办；
 *   · 列表里有东西、但一条都没通过校验 → 文件坏了，不是用户想要空。
 *
 * 后者直接抛错中止（不落库），并把"原有 N 条已保留"写进错误信息 ——
 * 破坏性操作被拦下来这件事，必须用最醒目的方式让人看见。
 *
 * @param count 现在库里还有几条。抛错时要说出来，让人知道东西还在
 * @param noun  进错误信息的名字（'预设' / '模块' / '变量'）
 */
export function assertNoReplaceWipe(args: {
  mode?: 'merge' | 'replace';
  list: unknown[];
  added: number;
  updated: number;
  count: () => number;
  noun: string;
}): void {
  if (args.mode !== 'replace') return;
  if (args.list.length === 0) return;
  if (args.added + args.updated > 0) return;

  const kept = args.count();
  throw new Error(
    `文件里 ${args.list.length} 条一条都没通过校验，没有导入。`
      + (kept > 0 ? `你原有的 ${kept} 条${args.noun}已保留，未清空。` : ''),
  );
}
