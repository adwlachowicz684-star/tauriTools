/**
 * Scratch 式嵌合 —— 节点上下吸附成"积木串"。
 *
 * ================= 数据模型 =================
 *
 * 嵌合关系存在**子节点**上：`data.stackParent = 上方节点 id`。
 *
 * 为什么存子指向父，而不是父存 children 数组：
 * 一份关系只有一处真相。父存数组的话，改一次关系要同时改两个节点，
 * 漏改就会出现"子说自己属于 A，A 的列表里却没有它" ——
 * 这类不同步不报错，只表现为连线时有时无。
 * 现在解嵌只改子节点一个字段。
 *
 * ================= 执行语义 =================
 *
 * 嵌合等价于一条隐式的边（父 → 子）。所以拓扑、失败传播、跳过
 * 全部自动成立 —— 不需要在引擎里为"嵌合"单独写一套逻辑，
 * 只要在组图时把虚拟边拼进去即可（stackEdges）。
 *
 * 输出传递（用户选定：直接上方为主，其余用单独变量）：
 *   {{input}}        直接上方的输出（未嵌合时仍是工作流全局输入）
 *   {{chain.output}} 整条串上、本节点之前所有输出的拼接
 *   {{id.output}}    照旧，任意一个具体节点的输出
 *
 * ================= 视觉成组 =================
 *
 * 串可整体拖动（拖上级带动下方全部）、可折叠。
 * 折叠只是隐藏，不影响执行 —— 折叠的节点照常参与运行。
 */

/** 嵌合后两块之间的缝隙。0 = 真正贴合（像积木咬合） */
export const STACK_GAP = 0;

/** 吸附判定的垂直容差：拖到离目标下缘这么近就吸上 */
export const SNAP_TOLERANCE = 26;

/** 水平方向至少要重叠这么多比例才算"对得上" */
export const SNAP_OVERLAP_RATIO = 0.5;

type AnyNode = {
  id: string;
  position?: { x: number; y: number };
  measured?: { width?: number; height?: number } | null;
  data?: Record<string, unknown>;
};

/** 只取嵌合关系时用这个 —— 不需要坐标，省得调用方硬凑一个 position */
export function stackParentOf(d: { data?: Record<string, unknown> }): string | null {
  const p = d.data?.stackParent;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

/** 节点高度。未测量时给个经验值 —— 只影响吸附判定，不影响布局 */
function posOf(n: AnyNode): { x: number; y: number } {
  return n.position ?? { x: 0, y: 0 };
}

export function heightOf(n: AnyNode): number {
  const h = n.measured?.height;
  return typeof h === 'number' && h > 0 ? h : 76;
}

export function widthOf(n: AnyNode): number {
  const w = n.measured?.width;
  return typeof w === 'number' && w > 0 ? w : 240;
}

export function parentIdOf(n: AnyNode): string | null {
  const p = n.data?.stackParent;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

export function isInStack(n: AnyNode): boolean {
  return parentIdOf(n) !== null;
}

/* ------------------------------------------------------------------ */
/* 链                                                                  */
/* ------------------------------------------------------------------ */

/** 直接下级（可能多个：一个节点下面并排挂两块时，取链上第一个为准） */
export function childrenOf(nodes: AnyNode[], id: string): string[] {
  return nodes.filter((n) => parentIdOf(n) === id).map((n) => n.id);
}

/** 全部后代（下方挂着的整串），自上而下 */
export function descendantsOf(nodes: AnyNode[], id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  const seen = new Set<string>([id]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const c of childrenOf(nodes, cur)) {
      if (seen.has(c)) continue; // 防御：万一存成了环
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/** 串顶（一直往上找，直到没有上级） */
export function chainTopOf(nodes: AnyNode[], id: string): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur = id;
  const seen = new Set<string>([cur]);
  for (let i = 0; i < nodes.length + 1; i += 1) {
    const p = parentIdOf(byId.get(cur) ?? ({ id: cur } as AnyNode));
    if (!p || !byId.has(p) || seen.has(p)) return cur;
    seen.add(p);
    cur = p;
  }
  return cur;
}

/** 完整的一条串（从顶到底） */
export function chainOf(nodes: AnyNode[], id: string): string[] {
  const top = chainTopOf(nodes, id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [top];
  const seen = new Set<string>([top]);
  let cur = top;
  for (let i = 0; i < nodes.length + 1; i += 1) {
    const kids = childrenOf(nodes, cur);
    if (kids.length === 0) break;
    const next = kids.find((k) => !seen.has(k));
    if (!next) break;
    seen.add(next);
    out.push(next);
    cur = next;
    void byId;
  }
  return out;
}

/** 嵌合产生的虚拟边（父 → 子），组图时拼进 edges */
export function stackEdges(nodes: AnyNode[]): { id: string; source: string; target: string }[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out: { id: string; source: string; target: string }[] = [];
  for (const n of nodes) {
    const p = parentIdOf(n);
    // 父节点已被删掉时丢弃这条关系，否则引擎会引用一个不存在的 id
    if (p && ids.has(p) && p !== n.id) {
      out.push({ id: `stack:${p}->${n.id}`, source: p, target: n.id });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 吸附判定                                                            */
/* ------------------------------------------------------------------ */

export type SnapHit = { parentId: string; y: number; x: number };

/**
 * 找一个可吸附的目标：拖动的节点顶边贴近某个节点的底边。
 *
 * @param exclude 不能作为目标的 id 集合：被拖动节点自己 + 它的全部后代。
 *                少了这个排除，把 A 拖到自己的下级下面会成环 ——
 *                引擎的环检测会直接拒绝执行整张图，用户完全不知道为什么。
 */
export function findSnapTarget(
  nodes: AnyNode[],
  dragged: AnyNode,
  exclude: Set<string>,
): SnapHit | null {
  const dw = widthOf(dragged);
  const dx1 = posOf(dragged).x;
  const dx2 = dx1 + dw;

  let best: SnapHit | null = null;
  let bestGap = Infinity;

  for (const n of nodes) {
    if (n.id === dragged.id || exclude.has(n.id)) continue;

    const nx1 = posOf(n).x;
    const nx2 = nx1 + widthOf(n);

    // 水平重叠比例
    const overlap = Math.min(dx2, nx2) - Math.max(dx1, nx1);
    if (overlap <= 0) continue;
    if (overlap / Math.min(dw, nx2 - nx1) < SNAP_OVERLAP_RATIO) continue;

    // 目标底边与拖动节点顶边的距离
    const bottom = posOf(n).y + heightOf(n);
    const gap = posOf(dragged).y - (bottom + STACK_GAP);
    if (gap > SNAP_TOLERANCE || gap < -SNAP_TOLERANCE) continue;

    const d = Math.abs(gap);
    if (d < bestGap) {
      bestGap = d;
      // 吸附时对齐 x —— 串里各块左对齐才像积木
      best = { parentId: n.id, y: bottom + STACK_GAP, x: nx1 };
    }
  }

  return best;
}

/** 判断拖动是否把节点拖离了原位足够远（用于"拖开即解除嵌合"） */
export function movedEnough(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) > SNAP_TOLERANCE || Math.abs(a.y - b.y) > SNAP_TOLERANCE;
}

/* ------------------------------------------------------------------ */
/* 输出传递                                                            */
/* ------------------------------------------------------------------ */

/**
 * 串上位于 id 之前的输出，按顺序拼接。
 *
 * 用换行连接而不是空格：多数情况下拼的是多段文本，
 * 空格连会让它们糊成一坨，换行至少能看出层次。
 */
export function chainOutputAbove(
  nodes: AnyNode[],
  id: string,
  outputs: Record<string, string>,
): string {
  const chain = chainOf(nodes, id);
  const at = chain.indexOf(id);
  if (at <= 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < at; i += 1) {
    const v = outputs[chain[i]];
    if (v !== undefined && v !== '') parts.push(v);
  }
  return parts.join('\n');
}

/**
 * {{input}} 的取值：嵌合时取直接上方的输出，否则回落到工作流全局输入。
 *
 * 这是"直接上方为主"的具体含义。回落很重要 ——
 * 未嵌合的节点沿用旧语义，老画布不会因为这次改动而行为突变。
 */
export function inputValueFor(
  nodes: AnyNode[],
  id: string,
  outputs: Record<string, string>,
  globalInput: string | undefined,
): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const self = byId.get(id);
  const p = self ? parentIdOf(self) : null;
  if (p && byId.has(p)) {
    const v = outputs[p];
    if (v !== undefined) return v;
  }
  return globalInput ?? '';
}
