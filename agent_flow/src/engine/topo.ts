import type { Graph, GraphEdge } from '../types';

export type TopoResult = {
  /** 分层结果，同层节点互不依赖可并行 */
  layers: string[][];
  /** 成环时无法排入的节点（非环图为空数组） */
  cyclic: string[];
};

/**
 * Kahn 算法分层拓扑排序。
 * 同层内的节点之间没有依赖路径，因此可以安全并发执行。
 */
export function topoLayers(graph: Graph): TopoResult {
  const ids = graph.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  // 只保留两端都存在的边，避免悬空引用导致入度错乱
  const edges = graph.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));

  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));

  for (const e of edges) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  }

  const layers: string[][] = [];
  let frontier = ids.filter((id) => indeg.get(id) === 0);

  while (frontier.length > 0) {
    layers.push(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const to of adj.get(id) ?? []) {
        const d = (indeg.get(to) ?? 0) - 1;
        indeg.set(to, d);
        if (d === 0) next.push(to);
      }
    }
    frontier = next;
  }

  const placed = new Set(layers.flat());
  const cyclic = ids.filter((id) => !placed.has(id));
  return { layers, cyclic };
}

/** 收集某节点的全部祖先（上游依赖），用于检测数据引用是否合法 */
export function ancestorsOf(id: string, edges: GraphEdge[]): Set<string> {
  const rev = new Map<string, string[]>();
  for (const e of edges) {
    if (!rev.has(e.target)) rev.set(e.target, []);
    rev.get(e.target)!.push(e.source);
  }
  const seen = new Set<string>();
  const stack = [...(rev.get(id) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(rev.get(cur) ?? []));
  }
  return seen;
}

/**
 * 收集某节点的全部后代（下游依赖者）。
 * 条件分支剪枝时用：一条分支被裁掉，它的整条下游链路都要裁掉。
 */
export function descendantsOf(id: string, edges: GraphEdge[]): Set<string> {
  const fwd = new Map<string, string[]>();
  for (const e of edges) {
    if (!fwd.has(e.source)) fwd.set(e.source, []);
    fwd.get(e.source)!.push(e.target);
  }
  const seen = new Set<string>();
  const stack = [...(fwd.get(id) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(fwd.get(cur) ?? []));
  }
  return seen;
}
