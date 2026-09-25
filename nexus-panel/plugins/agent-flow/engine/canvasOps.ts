/**
 * 画布删除操作（纯逻辑，可单测）。
 *
 * 抽出来的原因：删除不只是"从数组里去掉一个元素"——
 * 它要连带清理边、修正选中态，还要提醒"下游还在引用被删节点的输出"。
 * 这些判断值得被测试覆盖，而不是散落在 UI 事件回调里。
 */

import { isPaneNode } from './pane';

export type MinimalNode = {
  id: string;
  /**
   * 各节点 data 形状完全不同（task 有 prompt、condition 有 rules、fs 有 path…），
   * 这里只做结构性占位，具体字段由 templateTextOf() 运行时自行探测。
   * 写死成 `{ prompt?: string }` 会让 condition / fs 等节点类型不满足约束。
   */
  data?: unknown;
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
/**
 * 取出一个节点里所有可能写模板变量的字段，拼成一段文本供引用检测用。
 * 各类型节点字段不同，这里穷举已知字段；后续新增节点类型记得补上。
 */
export function templateTextOf(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const parts: unknown[] = [d.prompt, d.path, d.target, d.content, d.pattern, d.feedUrl, d.biliUid];
  const texts: string[] = [];
  for (const v of parts) {
    if (typeof v === 'string') texts.push(v);
  }
  return texts.join(' ');
}

/**
 * 取出节点配置里"直接引用其他节点 id"的字段（非模板变量形式）。
 *
 * 条件节点的 source、循环节点的 source 都是直接存 id，不走 {{id.output}}，
 * 所以 extractRefs 扫不到 —— 上游被删后判定会静默拿到空字符串，
 * 表现为"一直没命中"而不是"配置坏了"，极难排查。
 */
export function sourceRefsOf(data: unknown): string[] {
  const d = data as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') return [];
  const refs: string[] = [];

  // 条件节点：rules[].source 与 rules[].conditions[].source
  if (Array.isArray(d.rules)) {
    for (const r of d.rules as Record<string, unknown>[]) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.source === 'string' && r.source) refs.push(r.source);
      if (Array.isArray(r.conditions)) {
        for (const c of r.conditions as Record<string, unknown>[]) {
          if (!c || typeof c !== 'object') continue;
          if (typeof c.source === 'string' && c.source) refs.push(c.source);
        }
      }
    }
  }

  // 循环 / 并行等节点的来源
  if (typeof d.source === 'string' && d.source) refs.push(d.source);

  return refs;
}

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

  /*
   * 删掉窗格时，把挂在它下面的节点的 paneId 一起清掉。
   *
   * 不清的话那些节点的 paneId 指向一个已经不存在的窗格：
   * 运行时按"没挂窗格"处理（用节点自己的配置），
   * 而面板上下拉框显示的也正好是"不挂窗格" ——
   * 界面与实际恰好一致，于是**看不出继承已经失效**：
   * 用户改窗格、节点不再跟着变，却没有任何提示。
   *
   * 悬空 id 比空值更糟：它让"数据对不上"这件事无法被察觉。
   */
  const removedPaneIds = new Set(
    nodes.filter((n) => nodeSet.has(n.id) && isPaneNode(n)).map((n) => n.id),
  );
  const nextNodes = nodes.filter((n) => !nodeSet.has(n.id)).map((n) => {
    if (removedPaneIds.size === 0) return n;
    const d = (n.data ?? null) as { paneId?: unknown } | null;
    if (!d || !removedPaneIds.has(String(d.paneId ?? ''))) return n;
    const next = { ...(d as Record<string, unknown>) };
    delete next.paneId;
    return { ...n, data: next as unknown as N['data'] };
  });
  const nextEdges = edges.filter((e) => !removedEdgeIds.includes(e.id));

  // 悬空引用检查：只看留下来的节点
  const danglingRefs: DeleteResult<N, E>['danglingRefs'] = [];
  for (const removed of removedNodeIds) {
    const usedBy = nextNodes
      // 不只查 prompt：循环的通配符、文件节点的路径/内容同样支持模板变量，
      // 上游被删后这些字段会拿到空值——Rust 侧只会报"路径为空"，
      // 用户看不出是引用断了，所以一并纳入检测
      .filter((n) =>
        extractRefs(templateTextOf(n.data)).includes(removed) ||
        sourceRefsOf(n.data).includes(removed))
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
