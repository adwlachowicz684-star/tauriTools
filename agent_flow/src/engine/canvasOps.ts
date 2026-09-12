/**
 * 画布删除操作（纯逻辑，可单测）。
 *
 * 抽出来的原因：删除不只是"从数组里去掉一个元素"——
 * 它要连带清理边、修正选中态，还要提醒"下游还在引用被删节点的输出"。
 * 这些判断值得被测试覆盖，而不是散落在 UI 事件回调里。
 */

export type MinimalNode = {
  id: string;
  data?: { prompt?: string };
};

export type MinimalEdge = {
  id: string;
  source: string;
  target: string;
};

export type DeleteRequest = {
  /** 要删除的节点 id */
  nodeIds?: string[];
  /** 要删除的边 id */
  edgeIds?: string[];
};

export type DeleteResult<N extends MinimalNode, E extends MinimalEdge> = {
  nodes: N[];
  edges: E[];
  /** 实际删掉的节点 id（过滤掉不存在的） */
  removedNodeIds: string[];
  /** 实际删掉的边 id */
  removedEdgeIds: string[];
  /**
   * 悬空引用：被删节点的 id 仍出现在其他节点 prompt 的 {{xxx.output}} 里。
   * 不阻断删除，但调用方应该提示——否则运行时会静默把变量原样传给 CLI。
   */
  danglingRefs: { nodeId: string; ref: string; usedBy: string[] }[];
};

const TOKEN = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;

/** 提取提示词里引用的节点 id（只取 .output / 简写形式，忽略 {{input}}） */
export function extractRefs(prompt: string): string[] {
  const refs: string[] = [];
  if (!prompt) return refs;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(prompt)) !== null) {
    const key = m[1].trim();
    const nodeId = key.includes('.') ? key.split('.')[0] : key;
    if (nodeId === 'input') continue;
    refs.push(nodeId);
  }
  return [...new Set(refs)];
}

/**
 * 执行删除。
 *
 * 关键行为：删节点时**连带删除与之相连的所有边**，
 * 否则会留下指向不存在节点的悬空边，运行时拓扑计算会踩空。
 */
export function deleteElements<N extends MinimalNode, E extends MinimalEdge>(
  nodes: N[],
  edges: E[],
  req: DeleteRequest,
): DeleteResult<N, E> {
  const nodeSet = new Set(req.nodeIds ?? []);
  const edgeSet = new Set(req.edgeIds ?? []);

  const removedNodeIds = nodes.filter((n) => nodeSet.has(n.id)).map((n) => n.id);

  // 边分两类：显式指定删除的 + 因节点被删而失效的
  const removedEdges = edges.filter(
    (e) => edgeSet.has(e.id) || nodeSet.has(e.source) || nodeSet.has(e.target),
  );
  const removedEdgeIds = removedEdges.map((e) => e.id);

  const nextNodes = nodes.filter((n) => !nodeSet.has(n.id));
  const nextEdges = edges.filter((e) => !removedEdgeIds.includes(e.id));

  // 悬空引用检查：只看留下来的节点
  const danglingRefs: DeleteResult<N, E>['danglingRefs'] = [];
  for (const removed of removedNodeIds) {
    const usedBy = nextNodes
      .filter((n) => extractRefs(n.data?.prompt ?? '').includes(removed))
      .map((n) => n.id);
    if (usedBy.length > 0) {
      danglingRefs.push({ nodeId: removed, ref: `${removed}.output`, usedBy });
    }
  }

  return { nodes: nextNodes, edges: nextEdges, removedNodeIds, removedEdgeIds, danglingRefs };
}

/**
 * 删除后该选中谁。
 *
 * 删掉当前选中项时返回 null（清空右侧属性面板），
 * 否则保持原选中——避免删一条边就把正在编辑的节点取消选中。
 */
export function nextSelection(
  current: string | null,
  removedNodeIds: string[],
): string | null {
  if (current === null) return null;
  return removedNodeIds.includes(current) ? null : current;
}

/** 是否真的有东西可删（用于禁用按钮 / 阻止无意义的撤销记录） */
export function hasAnythingToDelete<N extends MinimalNode, E extends MinimalEdge>(
  nodes: N[],
  edges: E[],
  req: DeleteRequest,
): boolean {
  const nodeSet = new Set(req.nodeIds ?? []);
  const edgeSet = new Set(req.edgeIds ?? []);
  if (nodes.some((n) => nodeSet.has(n.id))) return true;
  return edges.some((e) => edgeSet.has(e.id));
}

/**
 * 撤销快照。
 *
 * 删除是画布上唯一的破坏性操作，没有撤销代价太大。
 * 只记录最近一次（而非完整历史栈）——这是刻意的取舍：
 * 单次误删是绝大多数场景，完整 undo 栈会引入一堆状态管理复杂度。
 */
export type UndoSnapshot<N extends MinimalNode, E extends MinimalEdge> = {
  nodes: N[];
  edges: E[];
  selectedId: string | null;
  label: string;
};

export function makeSnapshot<N extends MinimalNode, E extends MinimalEdge>(
  nodes: N[],
  edges: E[],
  selectedId: string | null,
  label: string,
): UndoSnapshot<N, E> {
  // 深拷贝：撤销要恢复到删除前的状态，不能被后续 mutation 影响
  return {
    nodes: nodes.map((n) => ({ ...n, data: { ...(n.data as object) } })) as N[],
    edges: edges.map((e) => ({ ...e })),
    selectedId,
    label,
  };
}

/** 生成删除操作的说明文案，用于撤销按钮的提示 */
export function describeDelete(removedNodeIds: string[], removedEdgeIds: string[]): string {
  const parts: string[] = [];
  if (removedNodeIds.length > 0) parts.push(`${removedNodeIds.length} 个节点`);
  if (removedEdgeIds.length > 0) parts.push(`${removedEdgeIds.length} 条连线`);
  return parts.join(' + ') || '0 个元素';
}
