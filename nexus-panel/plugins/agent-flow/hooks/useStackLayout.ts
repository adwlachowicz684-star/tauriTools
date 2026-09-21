import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  stackEdges, descendantsOf, chainTopOf,
  parentIdOf, movedEnough, heightOf, STACK_GAP, stackParentIds,
  planStackDrop, planStackReflow, measureHeights,
} from '../engine/stack';
import { canConnect, specOf } from '../engine/nodeSpecs';

/**
 * 嵌合要用的节点形状。
 *
 * `measured` 是 xyflow 量出来的真实尺寸 —— 没有它就算不出贴合位置，
 * 而"两块明明贴着却吸不上"恰恰是最难自查的那类问题。
 */
export type StackNode = {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  data?: unknown;
};

/**
 * 嵌合（Scratch 式竖串联结）+ 折叠 + 高度自适配。
 *
 * ================= 为什么抽出来 ====================
 *
 * App.tsx 是从三千七百多行往下拆的第二块。
 * 嵌合这块只依赖"节点数组"和"节点类型判定"，
 * 与凭据、任务、MCP 都不相干，可以整块搬走。
 *
 * ================= 边界 ====================
 *
 * 位置计算全在 engine/stack（纯函数、可单测）。
 * 这里只做三件事：拖动的三个事件回调、折叠后的渲染派生、渲染后的高度补偿。
 */
export function useStackLayout<T extends StackNode>({
  nodes, setNodes, kindOfNode, onLog, isDuplicating,
}: {
  nodes: T[];
  setNodes: React.Dispatch<React.SetStateAction<T[]>>;
  kindOfNode: (nodes: T[], id: string | null) => string | null;
  onLog: (msg: string) => void;
  /**
   * 当前是不是"按住 Ctrl 拖动 = 复制"。
   *
   * 复制时移动的是副本，原件关系没变 ——
   * 此时改 stackParent 会把**原件**改坏。
   */
  isDuplicating: () => boolean;
}) {

  /*
   * 节点高度变了就把下方的串重新贴回去。
   *
   * ================= 为什么必须事后做 ====================
   *
   * 嵌合位置是**落位那一刻**按当时的高度算的绝对值。
   * 之后改「显示高度」（矮 / 中 / 高），被改的那块长高了，
   * 下面挂着的还停在原来的 y —— 串在显示上裂开，关系却还在。
   *
   * 而新高度取决于内容（标题、参数行、字号），改完的**当下**还不知道，
   * 要等浏览器渲染完才拿得到 measured —— 所以只能在渲染后比对。
   *
   * ================= 为什么不逐个重算贴合位置 =================
   *
   * 那样会把用户故意留的小缝隙一并抹平。
   * 这里只补偿"高度差"（见 planStackReflow），其余相对关系原样保留。
   *
   * ================= 不会死循环 =================
   *
   * 挪动位置不改变高度，所以下一轮 deltas 必为空，effect 直接返回。
   */
  /** 拖动开始时"被拖节点 + 整串"的起始位置 */
  const dragStartRef = useRef<Record<string, { x: number; y: number }> | null>(null);

  const heightsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const next = measureHeights(nodes as never);
    const deltas = new Map<string, number>();
    for (const [id, h] of next) {
      const old = heightsRef.current.get(id);
      // 1px 以内的抖动不算 —— 频繁整串位移会让画布看着在抖
      if (old !== undefined && Math.abs(h - old) >= 1) deltas.set(id, h - old);
    }
    heightsRef.current = next;
    if (deltas.size === 0) return;

    const moves = planStackReflow(nodes as never, deltas);
    if (moves.length === 0) return;
    const at = new Map(moves.map((m) => [m.id, m.position]));
    setNodes((ns) => ns.map((n) => {
      const p = at.get(n.id);
      return p ? ({ ...n, position: p } as T) : n;
    }));
  }, [nodes, setNodes]);

  /*
   * 切到任务 / 历史时左边栏要隐藏 ——
   * 那些视图下画布都藏起来了，节点拖不出去，留着就是死栏。
   */

  /*
   * 拖动开始时记下"被拖节点 + 它下方整串"的起始位置。
   *
   * Scratch 的手感：拖动一块，它下面挂着的整串一起走。
   * 所以快照要包含后代，不然下方节点会被落下、串就散了。
   */
  const onStackDragStart = useCallback(
    (_e: unknown, node: { id: string }) => {
      const kids = descendantsOf(nodes as never, node.id);
      const snap: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) {
        if (n.id === node.id || kids.includes(n.id)) {
          snap[n.id] = { x: n.position.x, y: n.position.y };
        }
      }
      dragStartRef.current = snap;
    },
    [nodes],
  );

  /** 拖动中：整串跟着走（用起始位置 + 被拖节点的位移量） */
  const onStackDrag = useCallback(
    (_e: unknown, node: { id: string; position: { x: number; y: number } }) => {
      const start = dragStartRef.current;
      if (!start || !start[node.id]) return;
      const dx = node.position.x - start[node.id].x;
      const dy = node.position.y - start[node.id].y;
      if (dx === 0 && dy === 0) return;
      setNodes((ns) => ns.map((n) => (
        start[n.id] && n.id !== node.id
          ? { ...n, position: { x: start[n.id].x + dx, y: start[n.id].y + dy } }
          : n
      )));
    },
    [setNodes],
  );

  /** 拖动结束：判定吸附 / 脱开 */
  const onStackDragStop = useCallback(
    (_e: unknown, node: { id: string; position: { x: number; y: number } }) => {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      if (!start) return;
      /*
       * 复制拖动时不处理嵌合：
       * 移动的是副本，原件关系没变，此时改 stackParent 会把原件改坏。
       */
      if (isDuplicating()) return;

      const self = nodes.find((n) => n.id === node.id);
      if (!self) return;

      /*
       * 落位决定交给 engine/stack 的 planStackDrop ——
       *
       * 以前这里写的是 `if (hit && hit.parentId !== oldParent)`，
       * 于是**已经是嵌合态、只挪动了一点点**（不到脱开阈值）时：
       *   · 没到脱开距离 → 不解除
       *   · 命中的还是原来那个父，条件不成立 → 不吸附
       * 节点就停在偏移后的位置：关系还在，看着却是歪的。
       * 用户挪一点点显然不是想解开，而是想让它归位。
       */
      const oldParent = parentIdOf(self as never);
      const moved = start[node.id] ? movedEnough(start[node.id], node.position) : false;
      const exclude = new Set<string>([node.id, ...descendantsOf(nodes as never, node.id)]);

      const plan = planStackDrop(
        nodes.map((n) => ({
          id: n.id,
          position: { x: n.position.x, y: n.position.y },
          measured: n.measured as { width?: number; height?: number } | undefined,
          data: n.data as Record<string, unknown>,
        })) as never,
        {
          id: node.id,
          position: { x: node.position.x, y: node.position.y },
          measured: self.measured as { width?: number; height?: number } | undefined,
          data: self.data as Record<string, unknown>,
        } as never,
        { oldParent, moved, exclude },
      );

      if (!plan.position && plan.stackParent === undefined && !plan.attach) return;

      setNodes((ns) => {
        /*
         * 反向吸附：动的是**被拖节点自己**（往上靠到对方上边缘），
         * 对方原地不动，只改 stackParent —— 所以 moves 恒为空。
         */
        const moves = plan.attach?.moves?.length
          ? new Map(plan.attach.moves.map((m) => [m.id, m.position]))
          : null;
        /** 反向吸附时要改 stackParent 的那个节点（对方） */
        const attachChild = plan.attach?.childId ?? null;
        /** 它挂在谁下面 —— 被拖节点有串时是串尾 */
        const attachParent = plan.attach?.parentId ?? null;
        /*
         * 位移类落位（吸附 / 归位）时下级跟随的新位置。
         * 少了它：挪动串中间的一环，只有它自己归位，
         * 下级停在偏移处 —— 两块裂开而关系还在。
         */
        const follow = plan.followers?.length
          ? new Map(plan.followers.map((m) => [m.id, m.position]))
          : null;

        return ns.map((n) => {
          const isDragged = n.id === node.id;
          const at = moves?.get(n.id) ?? follow?.get(n.id);
          const isAttachChild = attachChild === n.id;
          if (!isDragged && !at && !isAttachChild) return n;

          const data = { ...(n.data as object) } as Record<string, unknown>;
          /*
           * 覆盖式写入，不会出现"一个节点有两个上级"。
           * 反向吸附时被拖节点（或它的串尾）是**父**，自己不动 stackParent，
           * 只把对方改成指向自己。
           */
          if (isDragged && plan.stackParent !== undefined) data.stackParent = plan.stackParent;
          // 对方不动位置，所以不能挂靠在 `at` 上 —— 它恒为空
          if (isAttachChild && attachParent) data.stackParent = attachParent;

          return {
            ...n,
            ...(at ? { position: at } : null),
            ...(isDragged && plan.position ? { position: plan.position } : null),
            data,
          } as T;
        });
      });

      /*
       * 嵌合 = 一条隐式边，连接判据与拉线一致。
       * 只在**换了上级**时才打日志 —— 归位与解除都是"维持现状"，
       * 每次都报一句会淹没真正的警告。
       */
      const nextParent = plan.stackParent !== undefined ? plan.stackParent : oldParent;
      if (plan.stackParent && plan.stackParent !== oldParent) {
        const verdict = canConnect(
          specOf(kindOfNode(nodes, plan.stackParent) ?? ''),
          specOf(kindOfNode(nodes, node.id)),
        );
        if (verdict.reason) onLog(`⚠ ${verdict.reason}`);
        else onLog(`⇲ 已嵌合到 ${plan.stackParent} 下方（可整体拖动，输出自动向下传递）`);
      } else if (nextParent === null && oldParent) {
        onLog(`⇱ 已解除与 ${oldParent} 的嵌合`);
      } else if (plan.attach) {
        /*
         * 反向吸附也要报一句 ——
         * 它是"我把别人接到了自己下面"，画面变化在**对方**身上，
         * 没有提示的话用户会以为只是自己挪了个位置。
         */
        const verdict = canConnect(
          specOf(kindOfNode(nodes, plan.attach.parentId) ?? ''),
          specOf(kindOfNode(nodes, plan.attach.childId) ?? ''),
        );
        if (verdict.reason) onLog(`⚠ ${verdict.reason}`);
        else onLog(`⇲ 已嵌合到 ${plan.attach.childId} 上方（拖动它会带着整串走）`);
      }
    },
    [nodes, setNodes, onLog, kindOfNode],
  );

  /*
   * 折叠后的隐藏：派生一份渲染用的节点数组，而不是改 nodes。
   * 直接写 hidden 进 nodes 会被保存 effect 落盘，
   * 于是"折叠状态"变成了画布数据的一部分 —— 那是显示状态，不该进存档。
   */
  const displayNodes = useMemo(() => {
    const tops = nodes.filter((n) => Boolean((n.data as Record<string, unknown>)?.stackCollapsed));
    /*
     * 下面挂着块的节点：直筒观感要给它们压掉下圆角与下边框。
     * 这个标记塞进 data 而不是另开一条通道 —— NodeShell 只拿得到自己
     * 这一个节点，扫不到全图。不落盘（见 engine/sanitize 的 VIEW_KEYS）。
     */
    const withChild = new Set(stackParentIds(nodes as never));

    // 既没嵌合也没折叠：原样返回，不重建数组（xyflow 会因此全量重渲染）
    if (tops.length === 0 && withChild.size === 0) return nodes;

    const hidden = new Set<string>();
    for (const t of tops) {
      for (const d of descendantsOf(nodes as never, t.id)) hidden.add(d);
    }
    return nodes.map((n) => {
      let out = n;
      if (withChild.has(n.id)) {
        const merged = { ...(out.data as Record<string, unknown>), hasStackChild: true };
        // 双重断言：FlowNode 是联合类型，各成员的 data 形状不同，
        // 展开后加字段没法直接对上任何一个成员
        out = { ...out, data: merged } as unknown as typeof n;
      }
      if (tops.length > 0) {
        out = { ...out, hidden: hidden.has(n.id) } as typeof n;
      }
      return out;
    });
  }, [nodes]);

  /** 折叠 / 展开整条串（只影响显示，不影响执行） */
  const toggleStackCollapse = useCallback(
    (nodeId: string) => {
      const top = chainTopOf(nodes as never, nodeId);
      const collapsed = Boolean((nodes.find((n) => n.id === top)?.data as Record<string, unknown>)?.stackCollapsed);
      setNodes((ns) => ns.map((n) => (
        n.id === top
          ? { ...n, data: { ...(n.data as object), stackCollapsed: !collapsed } } as T
          : n
      )));
    },
    [nodes, setNodes],
  );

  return {
    displayNodes, toggleStackCollapse,
    onStackDragStart, onStackDrag, onStackDragStop,
  };
}
