import { useCallback, useEffect, useState } from 'react';
import {
  deleteElements, nextSelection, hasAnythingToDelete,
  makeSnapshot, describeDelete, type UndoSnapshot,
} from '../engine/canvasOps';
import type { FlowEdge, FlowNode } from '../flowTypes';

/**
 * 删除 + 撤销删除。
 *
 * ================= 为什么抽出来 ====================
 *
 * App.tsx 往下拆的第五块。它只依赖"节点 / 边 / 选中态"和三个 setter，
 * 与连接、MCP、嵌合、执行流程都不相干 —— 是边界很清晰的一块。
 *
 * ================= 边界 ====================
 *
 * 删除的纯逻辑（谁被连带删掉、哪些引用会悬空）在 engine/canvasOps。
 * 这里只管快照、撤销栈与 Ctrl/Cmd+Z 的键盘接线。
 *
 * ================= 为什么只撤销"删除" ====================
 *
 * 目前只记删除一种操作。移动、改参数都还没进撤销栈 ——
 * 那就该老老实实只显示"撤销删除"，不要假装是通用撤销：
 * 用户按 Ctrl+Z 期待撤回上一步改参数，结果什么都没发生，
 * 会以为键盘坏了。
 */
export function useDeleteUndo({
  nodes, edges, selectedId,
  setNodes, setEdges, setSelectedId,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedId: string | null;
  setNodes: React.Dispatch<React.SetStateAction<FlowNode[]>>;
  setEdges: React.Dispatch<React.SetStateAction<FlowEdge[]>>;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  /** 最近一次删除的快照，用于撤销；null 表示无可撤销 */
  const [undoSnap, setUndoSnap] = useState<UndoSnapshot<FlowNode, FlowEdge> | null>(null);
  /** 删除后可能出现的"下游还在引用被删节点"提示 */
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  /** 记录删除前快照，并算出删除后是否留下悬空引用 */
  const beforeDelete = useCallback(
    (req: { nodeIds?: string[]; edgeIds?: string[] }) => {
      if (!hasAnythingToDelete(nodes, edges, req)) return true;

      setUndoSnap(makeSnapshot(nodes, edges, selectedId, describeDelete(req.nodeIds ?? [], req.edgeIds ?? [])));

      // 提前算出悬空引用：删除后节点已消失，就查不到了
      const res = deleteElements(nodes, edges, req);
      if (res.danglingRefs.length > 0) {
        const detail = res.danglingRefs
          .map((d) => `${d.ref} 仍被 ${d.usedBy.join('、')} 引用`)
          .join('；');
        setDeleteNotice(`已删除，但 ${detail}。这些变量运行时会原样传给 CLI，记得改掉。`);
      } else {
        setDeleteNotice(null);
      }
      return true; // 允许删除
    },
    [nodes, edges, selectedId],
  );

  const handleNodesDelete = useCallback((deleted: { id: string }[]) => {
    setSelectedId((cur) => nextSelection(cur, deleted.map((n) => n.id)));
  }, []);

  /** 工具栏「删除」：删掉当前选中项（React Flow 选中标记 + 属性面板选中态兜底） */
  const deleteSelected = useCallback(() => {
    const nodeIds = nodes.filter((n) => n.selected).map((n) => n.id);
    const edgeIds = edges.filter((e) => (e as { selected?: boolean }).selected).map((e) => e.id);
    // 属性面板选中的节点可能没走 React Flow 的选中态，补上
    if (nodeIds.length === 0 && edgeIds.length === 0 && selectedId) nodeIds.push(selectedId);

    if (!hasAnythingToDelete(nodes, edges, { nodeIds, edgeIds })) return;

    beforeDelete({ nodeIds, edgeIds });
    const res = deleteElements(nodes, edges, { nodeIds, edgeIds });
    setNodes(res.nodes);
    setEdges(res.edges);
    setSelectedId((cur) => nextSelection(cur, res.removedNodeIds));
  }, [nodes, edges, selectedId, beforeDelete, setNodes, setEdges]);

  /** 撤销：恢复最近一次删除 */
  const undoDelete = useCallback(() => {
    if (!undoSnap) return;
    setNodes(undoSnap.nodes);
    setEdges(undoSnap.edges);
    setSelectedId(undoSnap.selectedId);
    setUndoSnap(null);
    setDeleteNotice(null);
  }, [undoSnap, setNodes, setEdges]);

  // Ctrl/Cmd+Z 撤销删除（在输入框里打字时不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (t?.isContentEditable) return;
      if (!undoSnap) return;
      e.preventDefault();
      undoDelete();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoSnap, undoDelete]);


  /*
   * 换画布时要清掉撤销栈。
   *
   * 撤销快照里是**上一张画布**的节点与边 —— 不清的话，
   * 在 B 画布上按 Ctrl+Z 会把 A 画布的内容整片恢复过来，
   * 而用户看到的只是"我什么都没删，画布却变了"。
   */
  const clearUndo = useCallback(() => {
    setUndoSnap(null);
    setDeleteNotice(null);
  }, []);

  return {
    undoSnap, deleteNotice, setDeleteNotice,
    beforeDelete, deleteSelected, undoDelete, handleNodesDelete, clearUndo,
  };
}
