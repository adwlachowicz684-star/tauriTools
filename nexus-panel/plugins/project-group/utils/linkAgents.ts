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

/**
 * 链接名是否**真的能用**（不只是"不含非法字符"）。
 *
 * 只查非法字符是不够的：`.` / `..` / `...` 都不含非法字符，
 * 但它们**永远建不出链接** ——
 *   link_path(project, "..") = **项目的父目录**，"." = **项目自身**。
 * 建链时两者都命中 Conflict（已存在且不是链接）被拒，
 * 于是这条名字从此每次分配都失败，报错却指向 `<项目>\..`
 * 这种看着像"路径拼错了"的文本 —— 用户想不到是**名字**本身不合法。
 *
 * 而它在保存时是**静默收下的**：界面列表里正常显示、开关正常，
 * 只有到"分配项目组"那一刻才炸，且炸在别的地方。
 *
 * 判据与后端 `junction::normalize_name` 一致：去掉前导点后必须还剩内容。
 */
export function usableLinkName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (/[\\/:*?"<>|]/.test(n)) return false;
  if (isReservedWinName(n)) return false;
  return n.replace(/^\.+/, '').trim().length > 0;
}

/**
 * Windows 保留设备名 —— 在**任何目录、带任何扩展名**都建不出文件/链接：
 * `D:\proj\CON` 会被解析到控制台设备而不是目录。
 *
 * 后果是建链时 mklink 失败，而错误只说"mklink 失败"并指向 `CON`
 * 这个看着完全正常的名字 —— 用户只会以为磁盘或权限出了问题。
 *
 * 这份清单与后端 `sys::is_reserved_name` 的 RESERVED **逐项镜像**，
 * 有断言比对两侧（改一处不改另一处会直接报红）：抄两份必然漂移，
 * 而"前端放行、后端才拒"恰恰只有两套规则不一致时才出现 —— 那时报错
 * 又会回到"指向不明"的原状。
 */
export const WIN_RESERVED_NAMES: readonly string[] = [
  'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
];

/**
 * 判据要点（每条都对应一个误伤或漏判）：
 *   - 取**第一个点之前**的主名：`CON.txt` 同样保留，扩展名不算数
 *   - **完全相等**才判保留，不能用 startsWith：否则 `config` / `console`
 *     这些以保留名开头的常用名会被误拒，那比漏判更糟
 *   - 大小写不敏感：Windows 上 `con` 与 `CON` 是同一个
 *   - `.CON` 的主名为空，与 Windows 实际行为一致（不判保留）
 */
export function isReservedWinName(name: string): boolean {
  const stem = (name.split('.')[0] ?? '').trim();
  if (!stem) return false;
  const up = stem.toUpperCase();
  return WIN_RESERVED_NAMES.includes(up);
}

/** 置顶列表里某名字的下标（-1 无）；大小写不敏感（#354）。 */
export function pinIndexOf(pinned: string[], name: string): number {
  return pinned.findIndex((x) => sameName(x, name));
}
