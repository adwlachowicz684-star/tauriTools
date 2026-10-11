/**
 * 页签增删与重排后的「活动页签索引」计算。
 *
 * 为什么要抽成纯函数：这段是纯索引算术，写起来顺手、错了却很隐蔽 ——
 * 症状是"拖完之后停在别的页签上"或"删完之后落到越界位置白屏"，
 * 而在界面上复现要连点好几次、还得页签够多。
 * 抽出来就能直接用一张表把所有方向覆盖一遍（见 tab-index-test.mjs）。
 */

/**
 * 判据走 `normalizeKey`，**不在本文件另写一份归一化**。
 *
 * 本插件里凡比对路径的地方（useFpx / DialogsHub / LinkPickDialog / App）
 * 都用它，为的就是与后端 `store::normalize_key` 保持同一套规则。
 * 这里再抄一份，迟早与后端分叉 —— 而分叉的表现是"守卫时灵时不灵"：
 * 同一个卡片，路径写法对得上时不挪、对不上时被挪到末尾。
 *
 * 从 `./pathKey` 引而不是 `../api`：api.ts 有泛型箭头，测试工具剥类型
 * 后加载不了它，挂在那边的纯函数就没法真跑单测（详见 pathKey.ts 顶部）。
 */
import { normalizeKey } from './pathKey';

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

/**
 * @param ci 是否忽略大小写 —— **由调用方按平台传**，与后端
 * `store::normalize_key` 同规则（只在 Windows 下转小写）。
 *
 * 判据必须归一，不能原文精确比：后端登记/摘除卡片一律走
 * `normalize_key`（去尾部分隔符 + `\`→`/` + Windows 下转小写），
 * 这里若比原文，config 里存的是旧写法（`D:\Proj\A\` 带尾杠、
 * 或大小写不同）时守卫**失配** —— 卡片明明已在这个页签里，
 * 却被判成"不在"，于是照常走 moveCard 挪到末尾。
 * 正是上面那段注释写明要防的后果，换条路照样发生。
 *
 * 默认 false（大小写敏感）是刻意的：Linux/macOS 上 `A` 与 `a`
 * 是两个不同的目录，判成同一个才会改错东西。**忘了传 ci 的代价是
 * 守卫漏匹配（Windows 上多挪一次），不会误合并两个目录。**
 */
export function skipDropToTab(
  tabs: { items: DropItem[] }[],
  tabIndex: number,
  path: string,
  ci = false,
): boolean {
  const t = tabs[tabIndex];
  if (!t) return false;
  /* 显式比较 path，而不是 includes —— 后者在形态不匹配时静默失效 */
  const key = normalizeKey(path, ci);
  return t.items.some(
    (it) => normalizeKey(typeof it === 'string' ? it : it.path, ci) === key,
  );
}

/**
 * 页签名是否被占用（新建的默认名 / 改名都要查）。
 *
 * **页签名不是纯显示文本**：后端 `sys::resolve_new_target` 把它 join 进
 * 目标路径（`父目录/页签名/项目名`），也就是它会变成**真实的目录名**。
 * 两个同名页签于是共用同一个物理目录 —— 在第二个里面新建项目必然撞上
 * 「目标已存在」，而界面上两个分类**长得一模一样**，用户只会以为新建坏了。
 *
 * 即使不开层级，同名也让界面无从分辨：页签条、移动到分类的列表、
 * 分组标题全是两条一样的名字，点哪个全凭位置。
 *
 * 判据一律 trim + 小写（与 #354 链接名同一约定）：Windows 上 `Design`
 * 与 `design` 本就是同一个目录，按原文比会放过真正的撞车。
 *
 * @param names 已有的页签名
 * @param name 待查的名字
 * @param exceptIndex 改名时跳过自己（-1 表示不跳过，用于新建）
 */
export function isTabNameTaken(names: string[], name: string, exceptIndex = -1): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  return names.some((n, i) => i !== exceptIndex && n.trim().toLowerCase() === key);
}

/**
 * 生成一个**不与现有页签重名**的名字（新建页签的默认名用）。
 *
 * 为什么必须查：默认名是 `页签${长度+1}`，删掉中间一个之后再新建，
 * 算出来的名字必然与现存的重合 —— 例：[页签1, 页签2] 删掉页签1，
 * 剩 [页签2]，再新建得 `页签${1+1}` = **页签2**，与现存的撞车。
 * 这是"随手一点就撞上"的路径，不需要任何刻意的输入。
 *
 * **递增数字后缀而不是无脑加 `(2)`**：末尾是数字时优先 +1，
 * 得到「页签3」而不是「页签2(2)」——后者看着像复制品，不像下一个。
 */
export function uniqueTabName(names: string[], base: string): string {
  const b = base.trim() || '页签';
  if (!isTabNameTaken(names, b)) return b;
  const m = /^(.*?)(\d+)$/.exec(b);
  if (m) {
    const prefix = m[1];
    let n = Number(m[2]);
    for (let k = 0; k < 999; k++) {
      n += 1;
      const c = `${prefix}${n}`;
      if (!isTabNameTaken(names, c)) return c;
    }
  }
  for (let k = 2; k < 999; k++) {
    const c = `${b}(${k})`;
    if (!isTabNameTaken(names, c)) return c;
  }
  return `${b}(${Date.now()})`;
}
