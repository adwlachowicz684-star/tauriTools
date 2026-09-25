/**
 * 组合框（frame）—— 把若干节点框成一个"模块"。
 *
 * ================= 它解决什么问题 =================
 *
 * 一张画布画到二三十个节点后，看不出哪几个是一组：
 * 想整体挪一下要框选（还得选全）、想看清边界只能靠连线的走向猜。
 *
 * 组合框是**纯显示层**的归类 ——
 * 不参与执行、不产生连线、不改变任何节点的语义。
 * 这一点必须说清，否则用户会以为"框起来就等于打包成模块，
 * 外面接不到框里的节点"。
 *
 * ================= 为什么成员存在框上，而不是用 xyflow 的 parentId ====
 *
 * parentId 是"父子节点"：子坐标相对父、父移动子跟着动、
 * 子拖出父范围会被 extent 限制。而这里要的是**松散的标注**：
 *   · 成员可以单独拖走（框跟着长大，不拦着）
 *   · 一个节点只属于一个框，但从数据上说得清是谁
 * 用 parentId 的话前者要额外绕过 extent，后者要靠 parentId 反查。
 * 把成员 id 直接写在框上，两个需求都自然成立。
 */

/** 节点形状 —— 只取用得着的字段，好让纯 node 测试能直接喂对象 */
export type FrameAnyNode = {
  id: string;
  type?: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
  data?: unknown;
  selected?: boolean;
  zIndex?: number;
};

export const FRAME_TYPE = 'frame';

/** 框内边距 —— 成员与框边之间留多少 */
export const FRAME_PAD = 18;
/** 标题条高度 —— 框顶那一条，框要连它一起罩住 */
export const FRAME_HEAD = 24;
export const FRAME_MIN_W = 180;
export const FRAME_MIN_H = 110;

/**
 * 尺寸兜底。
 *
 * measured 是 xyflow 量出来的真实尺寸，**首帧还没有**。
 * 不兜底的话首帧的框会算成 0 宽，第二帧才跳到正确大小 ——
 * 表现为"框闪一下"。
 */
const FALLBACK_W = 200;
const FALLBACK_H = 96;

export function widthOf(n: FrameAnyNode): number {
  return n.measured?.width ?? n.width ?? FALLBACK_W;
}

export function heightOf(n: FrameAnyNode): number {
  return n.measured?.height ?? n.height ?? FALLBACK_H;
}

/**
 * 是不是组合框。
 *
 * 两个口径都认：node.type 是画布层的写法，
 * data.kind 是执行层的写法（转图后 node.type 会被剥掉）。
 * 只认一个的话，另一条路上就"认不出这是框" ——
 * 框会被当成普通节点去跑，而它没有任何执行器。
 */
export function isFrameNode(n: unknown): boolean {
  if (!n) return false;
  const x = n as { type?: string; data?: unknown };
  if (x.type === FRAME_TYPE) return true;
  const d = x.data as Record<string, unknown> | undefined;
  return !!d && d.kind === FRAME_TYPE;
}

/** 框里的成员 id */
export function frameMemberIds(n: unknown): string[] {
  const d = (n as { data?: unknown } | undefined)?.data as Record<string, unknown> | undefined;
  const raw = d?.members;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x === 'string' && out.indexOf(x) < 0) out.push(x);
  }
  return out;
}

type Bounds = { x1: number; y1: number; x2: number; y2: number };

/** 一批节点的包围盒；一个都不存在返回 null */
export function boundsOf(nodes: FrameAnyNode[], ids: string[]): Bounds | null {
  const byId = new Map((nodes ?? []).map((n) => [n.id, n]));
  let hit: Bounds | null = null;
  for (const id of ids ?? []) {
    const n = byId.get(id);
    if (!n || isFrameNode(n)) continue;
    const x1 = n.position?.x ?? 0;
    const y1 = n.position?.y ?? 0;
    const x2 = x1 + widthOf(n);
    const y2 = y1 + heightOf(n);
    if (!hit) hit = { x1, y1, x2, y2 };
    else {
      hit = {
        x1: Math.min(hit.x1, x1),
        y1: Math.min(hit.y1, y1),
        x2: Math.max(hit.x2, x2),
        y2: Math.max(hit.y2, y2),
      };
    }
  }
  return hit;
}

/**
 * 框应该长成什么样 —— 纯函数，成员一变就跟着变。
 *
 * 自适应是**算出来的**而不是存下来的：
 * 存一份的话，成员挪了要记得同步、改高度要记得同步、
 * 加成员要记得同步 —— 漏一处就是"框和里面的东西对不上"，
 * 而它不报错，只是看着别扭。
 */
export function frameGeometryOf(
  frame: FrameAnyNode,
  nodes: FrameAnyNode[],
): { x: number; y: number; width: number; height: number } | null {
  const ids = frameMemberIds(frame).filter((id) => id !== frame.id);
  const b = boundsOf(nodes, ids);
  if (!b) return null;
  return {
    x: b.x1 - FRAME_PAD,
    y: b.y1 - FRAME_PAD - FRAME_HEAD,
    width: Math.max(FRAME_MIN_W, b.x2 - b.x1 + FRAME_PAD * 2),
    height: Math.max(FRAME_MIN_H, b.y2 - b.y1 + FRAME_PAD * 2 + FRAME_HEAD),
  };
}

function sameGeom(a: FrameAnyNode, g: { x: number; y: number; width: number; height: number }): boolean {
  const ax = a.position?.x ?? 0;
  const ay = a.position?.y ?? 0;
  return (
    Math.abs(ax - g.x) < 0.5 &&
    Math.abs(ay - g.y) < 0.5 &&
    Math.abs((a.width ?? 0) - g.width) < 0.5 &&
    Math.abs((a.height ?? 0) - g.height) < 0.5
  );
}

/**
 * 把所有框重算一遍。
 *
 * 成员被删掉后要从 members 里清掉 id ——
 * 不清的话包围盒里查不到它，框会**凭空长大一小圈**（因为少了收缩的依据？不，
 * 是框还在却框不住任何东西），更麻烦的是解散时又冒出来一个空成员。
 *
 * 成员全没了就删掉这个框：
 * "没有成员的框"在数据上和"刚建的框"分不开，留着它用户只看到
 * 一个框不住任何东西的空框，而删掉它不会丢任何节点。
 *
 * 全程**不改 state**，只在渲染时派生 ——
 * 写回 state 的话，每次派生都触发一次 setNodes，拖动时就是每帧两次渲染。
 */
export function fitFrames<T extends FrameAnyNode>(nodes: T[]): T[] {
  const list = nodes ?? [];
  const alive = new Set(list.map((n) => n.id));
  let changed = false;

  const kept: T[] = [];
  for (const n of list) {
    if (!isFrameNode(n)) {
      kept.push(n);
      continue;
    }
    const d = (n.data ?? {}) as Record<string, unknown>;
    const rawIds = frameMemberIds(n);
    const live = rawIds.filter((id) => alive.has(id) && id !== n.id);

    if (live.length === 0) {
      // 空框：直接丢掉（见上面说明）
      changed = true;
      continue;
    }

    let next: T = n;
    if (live.length !== rawIds.length) {
      next = { ...n, data: { ...d, members: live } } as T;
      changed = true;
    }

    const g = frameGeometryOf(next, list);
    if (!g) {
      kept.push(next);
      continue;
    }
    if (!sameGeom(next, g)) {
      next = {
        ...next,
        position: { x: g.x, y: g.y },
        width: g.width,
        height: g.height,
      } as T;
      changed = true;
    }
    kept.push(next);
  }

  return changed ? kept : list;
}

/**
 * 点中一个框 = 选中它里面所有节点。
 *
 * 这是"框"区别于"一块带色的背景"的关键：
 * 框选一片节点要选全、还要避开旁边的节点，而点框一下就全选了。
 *
 * 反向不成立 —— 点框里的某个节点只选中它自己（xyflow 的默认行为），
 * 否则"改一个节点的参数"就变成"每次都选中一整组"。
 */
export function selectionWithFrames<T extends FrameAnyNode>(nodes: T[], ids: string[]): string[] {
  const out = new Set<string>(ids ?? []);
  const byId = new Map((nodes ?? []).map((n) => [n.id, n]));
  for (const id of ids ?? []) {
    const n = byId.get(id);
    if (!n || !isFrameNode(n)) continue;
    for (const m of frameMemberIds(n)) out.add(m);
  }
  return [...out];
}

/**
 * 拖框 = 挪里面所有节点。
 *
 * 框的位置是算出来的，直接改它没用（下一帧就被重算覆盖，表现为"拖不动"）。
 * 所以把位移转给成员 —— 框再自己跟着长过去。
 *
 * expand 用来把成员展开成"成员 + 它的嵌合下级"：
 * 只挪成员本身会把串拆散（下级留在原地，串断成两截）。
 */
export function frameDelta<T extends FrameAnyNode>(
  nodes: T[],
  frameId: string,
  dx: number,
  dy: number,
  expand?: (id: string) => string[],
): Record<string, { x: number; y: number }> {
  const byId = new Map((nodes ?? []).map((n) => [n.id, n]));
  const frame = byId.get(frameId);
  if (!frame || !isFrameNode(frame)) return {};

  const ids = new Set<string>();
  for (const m of frameMemberIds(frame)) {
    ids.add(m);
    for (const extra of expand ? expand(m) : []) ids.add(extra);
  }

  const out: Record<string, { x: number; y: number }> = {};
  for (const id of ids) {
    const n = byId.get(id);
    if (!n || isFrameNode(n)) continue;
    out[id] = { x: (n.position?.x ?? 0) + dx, y: (n.position?.y ?? 0) + dy };
  }
  return out;
}

/** 造一个组合框节点 */
export function makeFrame<T extends FrameAnyNode>(
  id: string,
  members: string[],
  label: string,
): T {
  return {
    id,
    type: FRAME_TYPE,
    position: { x: 0, y: 0 },
    width: FRAME_MIN_W,
    height: FRAME_MIN_H,
    /*
     * 负 zIndex：框要压在成员下面。
     *
     * 不设的话它按数组顺序叠，后建的框会盖住先建的节点 ——
     * 表现为"框住了就点不中了"，而这种失败没有任何提示。
     */
    zIndex: -1,
    data: { kind: FRAME_TYPE, label, members: [...members] },
  } as unknown as T;
}
