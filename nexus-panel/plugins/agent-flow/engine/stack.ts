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
import { isFrameNode, heightOf as frameHeightOf, widthOf as frameWidthOf } from './frames';

export function stackParentOf(d: { data?: Record<string, unknown> }): string | null {
  const p = d.data?.stackParent;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

/** 节点高度。未测量时给个经验值 —— 只影响吸附判定，不影响布局 */
function posOf(n: AnyNode): { x: number; y: number } {
  return n.position ?? { x: 0, y: 0 };
}

/*
 * 节点尺寸 —— 与 engine/frames 共用同一份。
 *
 * 以前这里只认 measured、兜底 76/240，而 frames 那份认 measured/width/height、
 * 兜底 96/200。两份对同一个节点的高度看法不同：
 * 首帧没量出来时，串按 76 贴合、框按 96 画，
 * 于是"串贴合好了、框却还差一截" —— 而用户只看到框没跟上。
 *
 * 更隐蔽的是 style.height：改档位若走 style，这里完全看不见，
 * 串不重贴合、框也不变，改档位就像没生效。
 * 共用一份后两种情况一起消失。
 */
export function heightOf(n: AnyNode): number {
  return frameHeightOf(n);
}

export function widthOf(n: AnyNode): number {
  return frameWidthOf(n);
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

/**
 * 哪些节点下面挂着块（即"是串中某一环的上半截"）。
 *
 * 直筒观感需要它：CSS 只能给下方块压掉上圆角（.is-stacked，
 * 从 stackParent 就能看出来），而"压掉下圆角"必须知道**下面有没有块** ——
 * 光看自己看不出来，得扫全图。
 *
 * 返回 Set 而不是给每个节点打标记：调用方（App 渲染时）拿着它
 * 决定要不要给某个节点加类名，不需要改动 nodes 数组本身。
 */
/**
 * 一串的最下面那块。
 *
 * 反向吸附要用它：被拖节点下面本来就挂着块时（A→B），
 * 真正要贴到对方上边缘的是 **B** 的底边，不是 A 的。
 * 按 A 算会把 B 压在对方身上。
 */
export function stackTailOf(nodes: AnyNode[], id: string): string {
  let cur = id;
  const seen = new Set<string>([id]);
  for (;;) {
    const kids = childrenOf(nodes, cur);
    if (kids.length === 0) return cur;
    // 下面并排挂两块时取第一个；万一成环就地停下
    if (seen.has(kids[0])) return cur;
    seen.add(kids[0]);
    cur = kids[0];
  }
}

export function stackParentIds(nodes: AnyNode[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const p = parentIdOf(n);
    // 父不存在就丢弃（父被删了，这条关系是脏的）
    if (!p || p === n.id || !ids.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** 这个节点下面有没有挂着块 */
export function hasStackChild(nodes: AnyNode[], id: string): boolean {
  for (const n of nodes) {
    if (parentIdOf(n) === id && n.id !== id) return true;
  }
  return false;
}

/** 全部祖先（上方挂着的整串），自下而上 */
export function ancestorsOf(nodes: AnyNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = id;
  for (let i = 0; i < nodes.length + 1; i += 1) {
    const p = parentIdOf(byId.get(cur) ?? ({ id: cur } as AnyNode));
    if (!p || !byId.has(p) || seen.has(p)) return out;
    seen.add(p);
    out.push(p);
    cur = p;
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
    /* 组合框不能当嵌合目标：它是一个框，不是一块积木。
       挂上去的话节点会"嵌合在框下面"，而框自己还要跟着成员走，
       两边互相追位置，表现为串里的节点慢慢飘走。 */
    if (isFrameNode(n)) continue;

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
      const at = snapPosOf(n);
      best = { parentId: n.id, y: at.y, x: at.x };
    }
  }

  return best;
}

/**
 * **反向**吸附：被拖节点的**底边**贴近另一个节点的**顶边**。
 *
 * ================= 为什么需要它 =================
 *
 * findSnapTarget 只认"被拖节点的顶边贴近目标底边"，
 * 于是只有**把 A 拖到 B 下方**才会嵌合；
 * 而用户把 A 拖到 B **上方**（想把 B 接到 A 下面）时不生效。
 *
 * 从用户视角看，两块上下贴着就该成串 ——
 * 谁是被拖的那一个不该影响结果。只支持一个方向会让人以为功能坏了。
 *
 * ================= 谁能被挂上来 =================
 *
 * ① 不能是被拖节点自己 / 后代 / **祖先**
 *    祖先挂到自己下面会成环 —— 引擎的环检测会拒绝执行**整张图**，
 *    而用户看不出是哪一块造成的。
 * ② 自身不能有上级
 *    从一条现成串的中间把节点抽走，会把原串断成两截：
 *    它的上级没了下级、它的下级没了上级，而两截都还在画布上。
 *    串顶（或独立节点）整串平移过来才不会拆散任何东西。
 */
export function findStackChild(
  nodes: AnyNode[],
  dragged: AnyNode,
  exclude: Set<string>,
): SnapHit | null {
  const dw = widthOf(dragged);
  const dx1 = posOf(dragged).x;
  const dx2 = dx1 + dw;
  /*
   * 用**串尾**的底边，不是被拖节点自己的底边。
   *
   * 拖一整串（A→C）时，视觉上靠近对方的那个边是 C 的下边缘 ——
   * 按 A 的底边判定的话，串越长越吸不上（A 的底边离对方还差一整块的高度），
   * 表现为"明明贴得很近却没反应"。
   */
  const tail = nodes.find((n) => n.id === stackTailOf(nodes, dragged.id)) ?? dragged;
  const bottom = posOf(tail).y + heightOf(tail);

  /*
   * 祖先必须排除：把祖先挂到自己下面会成环。
   * exclude 里只有"自己 + 后代"，不含祖先 —— 这里补上。
   */
  const blocked = new Set(exclude);
  for (const a of ancestorsOf(nodes, dragged.id)) blocked.add(a);

  let best: SnapHit | null = null;
  let bestGap = Infinity;

  for (const n of nodes) {
    if (n.id === dragged.id || blocked.has(n.id)) continue;
    // 组合框不是积木，不能挂上来（理由同 findSnapTarget）
    if (isFrameNode(n)) continue;
    // 已是串中间的一环：挂过来会把原串拆断
    if (parentIdOf(n)) continue;

    const nx1 = posOf(n).x;
    const nx2 = nx1 + widthOf(n);
    const overlap = Math.min(dx2, nx2) - Math.max(dx1, nx1);
    if (overlap <= 0) continue;
    if (overlap / Math.min(dw, nx2 - nx1) < SNAP_OVERLAP_RATIO) continue;

    const gap = posOf(n).y - (bottom + STACK_GAP);
    if (gap > SNAP_TOLERANCE || gap < -SNAP_TOLERANCE) continue;

    const d = Math.abs(gap);
    if (d < bestGap) {
      bestGap = d;
      best = { parentId: n.id, y: 0, x: 0 };
    }
  }

  return best;
}

/**
 * 吸附后的位置：对齐 x、贴在父节点下方。
 *
 * findSnapTarget 与"归位"都要用 —— 两处各算一次的话，
 * 吸附和归位可能给出不同的 y，表现为"吸上去和拖回来位置不一样"。
 */
export function snapPosOf(parent: AnyNode): { x: number; y: number } {
  return {
    x: posOf(parent).x,
    y: posOf(parent).y + heightOf(parent) + STACK_GAP,
  };
}

/**
 * 高度变化后，把下方的串重新贴回去。
 *
 * ================= 为什么要它 ====================
 *
 * 嵌合位置是**落位那一刻**按当时的高度算出来的绝对值。
 * 之后改「显示高度」（矮 / 中 / 高），被改的节点长高了，
 * 而它下面挂着的块还停在原来的 y ——
 * 于是串在显示上裂开（或叠在一起），`stackParent` 关系却还在。
 *
 * 这正是"嵌合看着坏了"的另一种成因，而且比拖动更难自查：
 * 用户改的是高度滑块，不会想到要去挪下面的节点。
 *
 * ================= 为什么用位移量 =================
 *
 * 不逐个重算贴合位置（y = 父底边 + GAP）：
 * 那样会把用户**故意**留的小缝隙一并抹平，等于偷偷改了他摆好的相对位置。
 *
 * 用位移量则只补偿"高度差"，其余相对关系原样保留。
 *
 * ================= 高度为什么事后才量 =================
 *
 * 新高度取决于内容（标题、参数行、字体），改完 size 的**当下**还不知道，
 * 要等浏览器渲染完才拿得到 measured。
 * 所以这里只接收"谁变了多少"，由调用方在渲染后比对得出。
 */
export function planStackReflow(
  all: AnyNode[],
  deltas: Map<string, number>,
): { id: string; position: { x: number; y: number } }[] {
  if (deltas.size === 0) return [];

  const byId = new Map(all.map((n) => [n.id, n]));

  /*
   * 每个节点要挪多少 = 它**所有上级**的高度变化之和。
   *
   * 串中间那块长高了：它自己不动（顶边对齐父节点），
   * 它下面的每一块都要往下挪，且再下面的要叠加上去。
   */
  const shiftOf = (id: string): number => {
    let total = 0;
    let cur = id;
    const seen = new Set<string>([id]);
    for (;;) {
      const n = byId.get(cur);
      if (!n) break;
      const p = parentIdOf(n);
      if (!p || seen.has(p)) break; // 没有上级，或成环
      seen.add(p);
      total += deltas.get(p) ?? 0;
      cur = p;
    }
    return total;
  };

  const out: { id: string; position: { x: number; y: number } }[] = [];
  for (const n of all) {
    /*
     * 注意：自己高度变了**不代表不用挪**。
     * 一块可以同时"自己长高了"和"被上级的变化推着走" ——
     * 少算后者会出现"改了中间那块，它自己不跟着串走"的怪状态。
     * shiftOf 只累加**上级**的变化，所以这里不必排除自己。
     */
    const dy = shiftOf(n.id);
    if (dy === 0) continue;
    out.push({ id: n.id, position: { x: posOf(n).x, y: posOf(n).y + dy } });
  }
  return out;
}

/**
 * 当前各节点的高度快照。
 *
 * 没有测量值的（还没渲染过 / 折叠隐藏了）不写进去 ——
 * 写进去等于认为它高度是 0，下一次量到真实高度时会算出一个巨大的位移。
 */
export function measureHeights(all: AnyNode[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of all) {
    const h = n.measured?.height;
    if (typeof h === 'number' && h > 0) out.set(n.id, h);
  }
  return out;
}

/** 松手后的落位决定。undefined = 这一项不动 */
export type StackDropPlan = {
  position?: { x: number; y: number };
  /**
   * 被拖节点**下方整串**的新位置。
   *
   * 少了它：挪动串中间的一环时，只有它自己归位/吸附，
   * 下级停在原地或停在拖动跟随后的偏移处 ——
   * 于是两块在显示上裂开，而 `stackParent` 关系还在，
   * 看着像"嵌合坏了"，其实是位置没同步。
   */
  followers?: { id: string; position: { x: number; y: number } }[];
  /** 显式给 null 表示解除嵌合 */
  stackParent?: string | null;
  /**
   * **反向**吸附（拖到别人上方）：把对方挂到自己**下面**。
   *
   * ================= 谁动 =================
   *
   * 移动的是**被拖节点自己** —— 它往上靠，贴到对方上边缘。
   *
   * 以前是反过来：把对方（和它的整串）拖到被拖节点下面。
   * 用户拖 A 到 B 上方，看到的却是**B 跳到 A 下面** ——
   * 动的是他没碰的那个，很反直觉。
   * 嵌合的语义是"被拖的节点去靠别人"，不该让别人来靠它。
   *
   * 所以 moves 恒为空：对方原地不动，只改 stackParent。
   */
  attach?: {
    /** 要挂上去的那个节点 —— 改的是它自己的 stackParent */
    childId: string;
    /**
     * 挂在谁下面。
     *
     * 通常是被拖节点自己，但它下面本来就挂着块时（A→B）是**串尾 B** ——
     * 写成 A 的话 A、B、对方三块会在同一个位置叠起来。
     */
    parentId: string;
    moves?: { id: string; position: { x: number; y: number } }[];
  };
};

/**
 * 松手时该怎么落位。
 *
 * ================= 为什么要单独一个函数 =================
 *
 * 以前这段写在 App 里，条件是 `if (hit && hit.parentId !== oldParent)`。
 * 于是**已经是嵌合态、只挪动了一点点**（不到脱开阈值 26px）时：
 *   · moved = false → 不解除
 *   · 命中的还是原来那个父，条件不成立 → 不吸附
 * 结果节点停在偏移后的位置，关系还在却看着歪的 ——
 * 正是"没取消嵌合，也没回到嵌合位置"。
 *
 * 用户挪一点点显然不是想解开，而是想让它归位。
 *
 * ================= 优先级 =================
 *
 *   1. 下方命中 → 自己嵌到它下面（拖到别人下方）
 *   2. 上方命中 → **自己**靠上去，对方挂到自己下面（反向吸附）
 *   3. 拖开了且都没命中 → 解除
 *   4. 没拖开但没命中（横向挪了点，重叠不够）→ 归位，关系不变
 */
export function planStackDrop(
  all: AnyNode[],
  dragged: AnyNode,
  opts: { oldParent: string | null; moved: boolean; exclude: Set<string> },
): StackDropPlan {
  const hit = findSnapTarget(all, dragged, opts.exclude);
  if (hit) {
    const to = { x: hit.x, y: hit.y };
    return {
      position: to,
      followers: followersFor(all, dragged.id, posOf(dragged), to),
      stackParent: hit.parentId,
    };
  }

  const { oldParent, moved } = opts;

  /*
   * 反向吸附只在**真的拖动过**时才考虑。
   *
   * 没拖动（只挪了一点点）时节点还在原位，而它下方本来就紧邻着
   * 自己的下级 —— 此时若触发反向吸附，会把已经挂在下面的节点
   * 又"重新挂一次"，表现为位置和关系莫名被改。
   */
  if (moved) {
    const child = findStackChild(all, dragged, opts.exclude);
    const target = child ? all.find((n) => n.id === child.parentId) : null;
    /*
     * 挂到**串尾**下面，而不是被拖节点自己下面：
     * 被拖节点下方本来就挂着块（A→B）时，接上去的应该是 B 的下级。
     */
    const tail = all.find((n) => n.id === stackTailOf(all, dragged.id)) ?? dragged;
    // 本来就已经挂在串尾下面的不必重挂
    if (target && parentIdOf(target) !== tail.id) {
      /*
       * 被拖节点（连同它下方整串）**往上靠**，让串尾贴住对方上边缘。
       *
       * 用**串尾**而不是被拖节点自己的底边：
       * 被拖节点下面本来就挂着块（A→B）时，真正要贴上去的是 B 的底边；
       * 按 A 的底边算会把 B 压在对方身上，两块叠在一起。
       */
      const bottom = posOf(tail).y + heightOf(tail);
      const dy = posOf(target).y - (bottom + STACK_GAP);
      const to = { x: posOf(target).x, y: posOf(dragged).y + dy };

      return {
        position: to,
        // 整串跟随平移 —— 少了这段，自己挪走了下级还在原地，串会散
        followers: followersFor(all, dragged.id, posOf(dragged), to),
        attach: { childId: target.id, parentId: tail.id, moves: [] },
      };
    }
  }

  if (!oldParent) return {};

  if (moved) {
    /*
     * 拖开了、且没吸上任何东西 —— 解除。
     * 位置不动：用户是主动拖走的，不该被拽回去。
     */
    return { stackParent: null };
  }

  /*
   * 没拖开，但也没命中（水平重叠不够 / 父节点已经被删了）。
   * 仍是嵌合态，就把它放回该在的位置。
   * 父节点找不到了（被删）则什么都不做 —— 关系是别处清理的。
   */
  const parent = all.find((n) => n.id === oldParent);
  if (!parent) return {};
  const to = snapPosOf(parent);
  return { position: to, followers: followersFor(all, dragged.id, posOf(dragged), to) };
}

/**
 * 位移类落位（吸附 / 归位）时，下级的跟随位置。
 *
 * 用"位移量"而不是重新算贴合位置：
 * 下级之间可能各自有偏移（比如整串被拖歪了一点），
 * 逐个重算会把串压成严丝合缝，等于偷偷改了用户摆好的相对位置。
 */
function followersFor(
  all: AnyNode[],
  draggedId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): { id: string; position: { x: number; y: number } }[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return [];
  const out: { id: string; position: { x: number; y: number } }[] = [];
  for (const id of descendantsOf(all, draggedId)) {
    const n = all.find((m) => m.id === id);
    if (!n) continue;
    out.push({ id, position: { x: posOf(n).x + dx, y: posOf(n).y + dy } });
  }
  return out;
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
