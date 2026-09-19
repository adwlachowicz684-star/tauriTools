/**
 * 「调用画布」节点的显示名。
 *
 * ================= 为什么要单独一层 =================
 *
 * 卡片上以前直接写 `canvasId.slice(0, 10)` 当兜底 ——
 * 于是画布没名字时，用户看到的是 `cvmamu7obyv93` 这种**内部 id 片段**。
 * 那串字符对用户没有任何意义，看着像乱码。
 *
 * ================= 三条来源，按优先级 =================
 *
 *   1. 覆盖名（用户手填）   —— 填了就不再自动变
 *   2. 目标画布的名字       —— 跟着改名同步
 *   3. 「未命名画布」        —— 兜底，绝不显示 id
 *
 * 第 2 条需要画布列表才能查到，所以做成函数而不是直接读 data 字段。
 */

/** 节点 data 里用到的三个字段 */
export type CanvasRefNameData = {
  /** 用户手填的显示名；空串 = 用自动值 */
  displayName?: string | null;
  /** 创建时快照的目标画布名 */
  canvasName?: string | null;
  canvasId?: string | null;
};

export type CanvasLite = { id: string; name?: string | null };

/**
 * 显示名。
 *
 * @param d    节点 data
 * @param list 全部画布（用来查目标画布当前的名字）；不传则只能用快照
 */
export function canvasRefDisplayName(
  d: CanvasRefNameData,
  list?: CanvasLite[] | null,
): string {
  const manual = String(d.displayName ?? '').trim();
  if (manual) return manual;

  /*
   * 优先查**当前**名字而不是快照：
   * 快照是在创建时复制的，目标画布后来改了名，
   * 还显示旧名会让人以为调错了画布。
   */
  const cid = String(d.canvasId ?? '').trim();
  if (cid && list) {
    const hit = list.find((c) => c.id === cid);
    const now = String(hit?.name ?? '').trim();
    if (now) return now;
  }

  const snap = String(d.canvasName ?? '').trim();
  if (snap) return snap;

  return cid ? '未命名画布' : '还没选要调用哪张画布';
}

/**
 * 下拉框的候选。
 *
 * 排除**自己所在**的画布：调自己会成环，
 * 引擎的环检测会拒绝执行整张图，而用户看不出是哪一块造成的。
 */
export function canvasRefOptions(
  list: CanvasLite[] | null | undefined,
  activeCanvasId?: string | null,
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const c of list ?? []) {
    if (!c?.id) continue;
    if (activeCanvasId && c.id === activeCanvasId) continue;
    const name = String(c.name ?? '').trim();
    out.push({ value: c.id, label: name || '未命名画布' });
  }
  return out;
}

/**
 * 把画布改名同步回引用它的节点。
 *
 * 卡片显示用的是**快照** canvasName（卡片只收 data，拿不到画布列表），
 * 所以目标画布改名后必须有地方回写，否则一直显示旧名 ——
 * 表现为"我明明改了名，这个节点还叫旧的"，且没有任何提示。
 *
 * 只改真的变了的行：无脑重设会让 nodes 每次都是新引用，
 * 触发整张图重渲染（画布会明显发涩）。
 *
 * @returns 同步后的节点数组；没变化就**原样返回同一个引用**
 */
/*
 * 入参写成 `NodeLike[]` 而**不用泛型** `<T extends ...>`。
 *
 * strip-ts.py 剥不掉函数上的泛型参数列表，会把 `<T ...>` 原样留在
 * 生成的 .mjs 里 —— 直接语法错误。这是这个脚本的第十一个坑。
 * 用类型别名收住约束，效果一样且能被测到。
 */
type NodeLike = { data: Record<string, unknown> };

export function syncCanvasRefNames(
  nodes: NodeLike[],
  list: CanvasLite[] | null | undefined,
): NodeLike[] {
  if (!list || list.length === 0) return nodes;

  const nameOf = new Map<string, string>();
  for (const c of list) {
    const n = String(c.name ?? '').trim();
    if (c.id && n) nameOf.set(c.id, n);
  }
  if (nameOf.size === 0) return nodes;

  let changed = false;
  const out = nodes.map((n) => {
    const d = n.data as CanvasRefNameData;
    if (!d || d.canvasId == null) return n;
    const want = nameOf.get(String(d.canvasId));
    // 目标画布没名字（或查不到）时不动 —— 卡片会自己兜底成"未命名画布"
    if (!want) return n;
    if (String(d.canvasName ?? '') === want) return n;
    changed = true;
    return { ...n, data: { ...n.data, canvasName: want } };
  });

  return changed ? out : nodes;
}

/** 画布级包装：把改名同步到**所有**画布里的引用节点 */
export function syncCanvasesRefNames(
  canvases: { id: string; name: string; nodes: NodeLike[] }[],
): { id: string; name: string; nodes: NodeLike[] }[] {
  let any = false;
  const out = canvases.map((c) => {
    const nodes = syncCanvasRefNames(c.nodes as NodeLike[], canvases);
    if (nodes === c.nodes) return c;
    any = true;
    return { ...c, nodes };
  });
  return any ? out : canvases;
}

/**
 * 选中画布时顺带写一份名字快照。
 *
 * 卡片显示只能读 data（拿不到画布列表），所以必须落一份快照。
 * 不写的话新选完画布，卡片上显示"未命名画布"——
 * 明明刚选了一张有名字的画布，看着像没生效。
 */
export function snapshotCanvasName(
  canvasId: unknown,
  list: CanvasLite[] | null | undefined,
): string {
  const cid = String(canvasId ?? '').trim();
  if (!cid) return '';
  const hit = (list ?? []).find((c) => c.id === cid);
  return String(hit?.name ?? '').trim();
}
