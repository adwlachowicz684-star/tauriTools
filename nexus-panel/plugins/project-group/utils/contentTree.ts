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
      const leaf = firstLeaf(n);
      if (leaf?.path) {
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
