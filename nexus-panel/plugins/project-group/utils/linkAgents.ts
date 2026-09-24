/**
 * 链接名的批量操作（#64 恢复预设 / #65 全选-全不选）。
 *
 * 抽成纯函数的原因同 utils/tabs.ts：这几处的**键迁移**规则很绕 ——
 * 改名之后，开关 / 备注 / 厂商的键是"当前显示名"，而置顶列表存的也是显示名，
 * 一旦名字变回去而键没跟着迁，置顶会静默失效、备注会挂在已经不存在的名字上。
 * 这类"数据还在但看不见了"的问题，界面上很难一眼看出来。
 */

/** 一个预设链接名：original 是固有键，shown 是当前显示名（可能已改名） */
export interface PresetRow {
  original: string;
  shown: string;
}

/**
 * 与链接名相关的一整套状态。
 * 抽成命名类型而不写成内联对象字面量，是因为测试要直接吃这份源码
 * （见 testkit.mjs），内联的多行对象类型标注剥离不了。命名类型本身也更清楚。
 */
export interface LinkAgentState {
  renames: Record<string, string>;
  vendors: Record<string, string>;
  remarks: Record<string, string>;
  pinned: string[];
  map: Record<string, boolean>;
}

/**
 * 全选 / 全不选（#65）。
 *
 * 写 `true` 而不是删掉键：后端对缺失键按"启用"处理，
 * 于是"全选"若靠删键实现，效果对，但一旦将来默认值改成关闭就全反了。
 * 显式写值不依赖默认值是什么。
 */
export function setAllEnabled(
  names: string[], map: Record<string, boolean>, enabled: boolean,
): Record<string, boolean> {
  const next = { ...map };
  for (const n of names) next[n] = enabled;
  return next;
}

/** 是否全部启用（用于决定"全选"还是"全不选"按钮的可用态） */
export function allEnabled(names: string[], map: Record<string, boolean>): boolean {
  return names.length > 0 && names.every((n) => map[n] ?? true);
}

/**
 * 反选（#96）：把当前启用的关掉、关掉的启用。
 *
 * 同样**显式写值**（`!cur`）而不是删键，理由与 setAllEnabled 一致：
 * 靠删键实现的话，一旦后端默认值改了就全反。
 *
 * 注意读当前值要用 `?? true`（缺失=启用），
 * 直接 `!map[n]` 会把缺失键当成"关闭"而反成启用 ——
 * 于是"看起来没启用的一项被反选后还是启用"，用户以为功能坏了。
 */
export function invertEnabled(
  names: string[], map: Record<string, boolean>,
): Record<string, boolean> {
  const next = { ...map };
  for (const n of names) next[n] = !(map[n] ?? true);
  return next;
}

/**
 * 恢复预设（#64）：清空改名与厂商标注，名字回到预设原名。
 *
 * **置顶与备注保持不变** —— 但它们的键是"显示名"，名字变回原名后
 * 必须跟着迁键，否则：
 *   · 置顶项指向一个已不存在的名字 → 置顶静默失效（最迷惑的一种）
 *   · 备注挂在幽灵名字上 → submit() 的 pick() 会把它整个丢掉
 * 所以这里做的是"键迁移"而不是"清空重来"。
 *
 * 自定义链接名不受影响（它们没有预设可恢复）。
 */
export function resetToPreset(rows: PresetRow[], cur: LinkAgentState): LinkAgentState {
  const renames = { ...cur.renames };
  const vendors = { ...cur.vendors };
  const remarks = { ...cur.remarks };
  const map = { ...cur.map };
  const pinned = [...cur.pinned];

  for (const { original, shown } of rows) {
    if (shown === original) {
      // 没改名，只需清掉可能存在的厂商标注（留空即回退预设值）
      delete vendors[shown];
      continue;
    }
    delete renames[original];
    // 厂商：清掉显示名上的覆盖，回落到预设自带的厂商
    delete vendors[shown];
    // 开关 / 备注 / 置顶：键从"旧显示名"迁到"原名"
    if (shown in map) {
      map[original] = map[shown];
      delete map[shown];
    }
    if (shown in remarks) {
      remarks[original] = remarks[shown];
      delete remarks[shown];
    }
    const i = pinned.indexOf(shown);
    if (i !== -1) pinned[i] = original;
  }

  return { renames, vendors, remarks, pinned, map };
}

/**
 * 大小写不敏感查重（#91）。
 *
 * 为什么必须不敏感：**Windows 文件系统本身大小写不敏感**，
 * `.OpenCode` 与 `.opencode` 是同一个目录。用 `includes()`（精确比较）
 * 拦不住前者，于是两个链接名会指向同一个 junction ——
 * 创建时后一个覆盖前一个，其中一个必然失效，
 * 而且界面上两个名字都在、都显示"已启用"，没有任何报错。
 * 用户只会发现"某个 AI 读不到配置了"，但根本想不到是这里重名。
 *
 * 用 `toLowerCase()` 而不是 `localeCompare`：后者受语言环境影响
 * （比如土耳其语的 I/ı），同一份数据在不同机器上判定结果可能不同。
 */
export function hasNameCI(names: string[], name: string): boolean {
  const n = name.trim().toLowerCase();
  return names.some((x) => x.trim().toLowerCase() === n);
}

/**
 * #354 置顶名的比较：一律大小写不敏感、两端去空白。
 *
 * 原版 `LinkAgentViewModel` 里置顶相关的四处（加 / 删 / 查 / 改名的迁移）
 * 全用 `OrdinalIgnoreCase`，与链接名查重（#91 / #204 / #310）同一约定。
 *
 * 本版此前用 `indexOf` / `includes` 精确比较，于是配置里存的是旧大小写时
 * （手改过 config、或从更老版本迁移上来）置顶**静默失效** ——
 * 不报错、列表也不乱，只是那一项不在最前面，
 * 用户只会以为"置顶没记住"。
 */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 置顶列表里某名字的下标（-1 无）；大小写不敏感（#354）。 */
export function pinIndexOf(pinned: string[], name: string): number {
  return pinned.findIndex((x) => sameName(x, name));
}
