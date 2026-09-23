import type { Graph, GraphEdge } from '../types';

export type TopoResult = {
  /** 分层结果，同层节点互不依赖可并行 */
  layers: string[][];
  /** 成环时无法排入的节点（非环图为空数组） */
  cyclic: string[];
};

/**
 * 排序时要额外计入的依赖（参数连线）。
 *
 * 只带两端，不带 id —— 它不参与 deadEdges / 分支 / 循环那套判定，
 * 纯粹是"这个节点得在那个节点之后跑"。
 */
export type ExtraDep = { source: string; target: string };

/**
 * Kahn 算法分层拓扑排序。
 * 同层内的节点之间没有依赖路径，因此可以安全并发执行。
 *
 * ================= extra 为什么单独一个参数 =================
 *
 * 参数连线（A 的输出填进 B 的某个参数）**必须**让 A 排在 B 之前，
 * 否则 B 拿到的 outputs[A] 还不存在，填进去的是 undefined，
 * 表现为"连了线却拿到空值"，而界面上连线明明画着。
 *
 * 但它**不能并进 graph.edges**：那份边会被分支、循环、停止传播、
 * 并发继承等一堆逻辑遍历。参数连线混进去，一个"给参数取值"的动作
 * 会凭空多出一条执行路径 —— 表现为某个节点跑了两次。
 *
 * 所以排序用它，执行逻辑不碰它。
 */
export function topoLayers(graph: Graph, extra?: ExtraDep[]): TopoResult {
  const ids = graph.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  // 只保留两端都存在的边，避免悬空引用导致入度错乱
  const edges = graph.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
  const extras = (extra ?? []).filter((e) => idSet.has(e.source) && idSet.has(e.target));

  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));

  /*
   * 同一对节点可能既有流程边又有参数连线（A 既在 B 上游，又给 B 供参数）。
   * 用 Set 去重：不去重会让 B 的入度变成 2，
   * 而 A 只会被消费一次，B 就永远排不进去 —— 表现为"流程跑到某处停了"。
   */
  const seenPair = new Set<string>();
  const addDep = (source: string, target: string) => {
    const k = `${source}->${target}`;
    if (seenPair.has(k)) return;
    seenPair.add(k);
    indeg.set(target, (indeg.get(target) ?? 0) + 1);
    adj.get(source)!.push(target);
  };

  for (const e of edges) addDep(e.source, e.target);
  for (const e of extras) addDep(e.source, e.target);

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
