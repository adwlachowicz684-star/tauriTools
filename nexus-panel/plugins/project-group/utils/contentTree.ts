import type { ContentItem } from '../types';

/**
 * 内容树构建与物理路径回填（纯逻辑，可单测）
 * ------------------------------------------------------------------
 * 从 ContentPanel.tsx 抽出来的直接原因是**可测性**：这四段都是纯函数，
 * 但 .tsx 里的 JSX 让类型剥离器没法加载，于是只能写"源码里有这行"的
 * 文本断言 —— 那种断言改一个变量名就失效，且测不到算法对不对
 * （`fillDirPaths` 掐错段数照样通过）。
 *
 * 抽成 .ts 之后 `content-tree-test.mjs` 能 `loadTs` 加载真身，
 * 用穷举不变量钉住：目录节点的 path 必须是后代叶子 path 的目录前缀。
 */

export interface TreeNode {
  name: string;
  /** 物理路径。**目录节点**由 `fillDirPaths` 回填，构建时是空串 */
  path: string;
  relPath: string;
  /** 所属类别（agent/skill/rule）。同名条目在不同类别下是不同节点，必须一起参与匹配。 */
  kind: string;
  /** 叶子才有。目录型 skill 也是叶子（它整体就是一个 skill），靠 `item.isDir` 区分 */
  item?: ContentItem;
  children: TreeNode[];
}

export function buildTree(items: ContentItem[]): TreeNode[] {
  const roots: TreeNode[] = [];

  for (const it of items) {
    const parts = it.relPath.split('\\').filter(Boolean);
    let level = roots;
    let prefix = '';

    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      prefix = prefix ? `${prefix}\\${part}` : part;
      // 关键：按 kind + name 匹配。否则 agent\foo.md 与 rule\foo.md 会撞成同一个节点，
      // 后遍历到的 item 覆盖先遍历到的，界面上直接少一个条目。
      let node = level.find((n) => n.name === part && n.kind === it.kind);
      if (!node) {
        node = { name: part, path: '', relPath: prefix, kind: it.kind, children: [] };
        level.push(node);
      }
      if (isLeaf) {
        node.item = it;
        node.path = it.path;
      }
      level = node.children;
    });
  }
  sortTree(roots);
  return roots;
}

/** 目录在前、同级按名称（#348 对应原版 SortTree）。 */
export function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    const ad = a.children.length > 0 && !a.item;
    const bd = b.children.length > 0 && !b.item;
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  for (const n of nodes) sortTree(n.children);
}

/** 按 Windows / Unix 两种分隔符切路径（后端 to_string_lossy 在 Windows 上给 `\`）。 */
export const splitPath = (p: string): string[] => p.split(/[\\/]/).filter(Boolean);

/** 该子树里**第一个**叶子（已按名称排序，对应原版 FindFirstLeaf）。 */
export function firstLeaf(n: TreeNode): TreeNode | null {
  if (n.item) return n;
  for (const c of n.children) {
    const f = firstLeaf(c);
    if (f) return f;
  }
  return null;
}

/** 收集该子树全部叶子（对应原版 CollectLeaves）。 */
export function collectLeaves(n: TreeNode): TreeNode[] {
  if (n.item) return [n];
  return n.children.flatMap(collectLeaves);
}

/**
 * #345 树后处理：给**目录节点**回填真实物理路径。
 *
 * `buildTree` 只给叶子填 `path`（它才有 ContentItem），中间目录节点的 `path` 是空串。
 * 于是"打开所在文件夹 / 复制路径"这类操作对目录一律不可用 ——
 * 而用户在树上看到的正是这些目录，点了却没反应且没有任何提示。
 *
 * 推导方式：目录的 `relPath` 是后代叶子 `relPath` 的前缀，
 * 所以取第一个后代叶子的 `path`、掐掉末尾多出来的那几段即可。
 * 不直接拼 `root/xxx`：后端对 agent/agents 单复数两种写法都兼容，
 * 拼出来的路径不一定存在，而反推一定对得上磁盘实际结构。
 */
export function fillDirPaths(nodes: TreeNode[]): void {
  for (const n of nodes) {
    if (!n.item) {
      /*
       * #345（更正）**只对 agent / rule 回填**。
       *
       * 原版 PrepareTree 注释写明：只有 agent/rule 的文件夹节点回填物理路径；
       * skill 的层级是**虚拟层**（由名字里的 `_` 拆出来，见 `skillTreeRelPath`），
       * 磁盘上并不存在对应的目录。
       *
       * 对它回填会推出一个**错误的**路径：名字 `a_b_c` 的目录型 skill，
       * 节点 `a` 会被填成 skill 根目录 —— 用户点「打开所在文件夹」
       * 打开的是整个 skill 目录，而不是他点的那一层。没有报错，只是开错了地方。
       */
      const leaf = firstLeaf(n);
      if (leaf?.path && n.kind !== 'skill') {
        const extra = splitPath(leaf.relPath).length - splitPath(n.relPath).length;
        const parts = splitPath(leaf.path);
        if (extra > 0 && parts.length > extra) {
          n.path = parts.slice(0, parts.length - extra).join('\\');
        }
      }
      fillDirPaths(n.children);
    }
  }
}

/**
 * #342 skill 名按 `_` 拆分层级（原版 RefreshCore：
 * `s.RelPath.Replace('_', '\\')`，在**呈现层**做，不在扫描层）。
 *
 * 放在呈现层而不是后端有两个原因：
 *   · 原版就是这样分的（Service 给物理相对路径，ViewModel 决定怎么显示）
 *   · 改后端 `rel_path` 会破坏 `baseDirOf`（用 `path.endsWith(relPath)` 反推基目录），
 *     改完"打开 skill 目录"按钮会一直置灰 —— 而它报错也指不到这里
 */
export const skillTreeRelPath = (relPath: string): string => relPath.split('_').join('\\');

/** 拆出最后一段：返回 `[所在目录, 末段名]`。两种分隔符都认。 */
export function splitLast(p: string): [string, string] {
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  return i < 0 ? ['', t] : [t.slice(0, i), t.slice(i + 1)];
}

/** 主名（去扩展名）与扩展名（含点）。目录没有扩展名。 */
export function stemExt(name: string, isDir: boolean): [string, string] {
  if (isDir) return [name, ''];
  const i = name.lastIndexOf('.');
  return i <= 0 ? [name, ''] : [name.slice(0, i), name.slice(i)];
}

export interface SegmentMove {
  from: string;
  to: string;
  isDir: boolean;
}

/**
 * #213 / #344 skill 虚拟层重命名：批量替换子树条目**物理名**中对应的 `_` 段。
 *
 * 原版 `RenameSkillSegment`：`segIndex = folder.Depth - 1`，
 * 物理名 `Split('_')` 后取该下标替换。所以点击树里的第 2 层文件夹，
 * 改的是磁盘名里第 2 个 `_` 段。
 *
 * **只算计划，不执行** —— 真正的改名（含冲突检查与原子性）在 Rust 侧。
 * 这样这段最容易算错的逻辑（下标、扩展名保留、跳过条件）可以在沙箱里穷举单测；
 * 留在 .tsx 里就只能写文本断言，下标算错照样通过。
 *
 * 返回 `skipped` 而不是静默丢弃：一个都没匹配上时调用方要能报出来
 * （否则用户改了个名字、界面毫无变化，只会以为坏了）。
 */
export function planSkillSegmentRename(
  leaves: { path: string; isDir: boolean }[],
  segIndex: number,
  oldSeg: string,
  newName: string,
): { moves: SegmentMove[]; skipped: number } {
  const moves: SegmentMove[] = [];
  let skipped = 0;
  for (const leaf of leaves) {
    const [dir, name] = splitLast(leaf.path);
    const [stem, ext] = stemExt(name, leaf.isDir);
    const segs = stem.split('_');
    // 物理名段数不够、或该下标不是旧段名 —— 跳过（原版同判据）
    if (segIndex >= segs.length || segs[segIndex] !== oldSeg) { skipped++; continue; }
    segs[segIndex] = newName;
    const sep = dir.includes('\\') ? '\\' : (dir.includes('/') ? '/' : '\\');
    moves.push({ from: leaf.path, to: `${dir}${sep}${segs.join('_')}${ext}`, isDir: leaf.isDir });
  }
  return { moves, skipped };
}
