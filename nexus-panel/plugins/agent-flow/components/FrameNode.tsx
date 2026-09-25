import type { NodeProps } from '@xyflow/react';
import type { FrameNodeData } from '../types';

/**
 * 组合框卡片 —— 一块带标题的底板，框住一组节点。
 *
 * ================= 为什么不用 NodeShell =================
 *
 * NodeShell 是给"会执行的节点"用的：状态圆点、缺参徽章、
 * 参数格、输出端口……框一个都不该有。
 * 套上去的话框上会出现一个"缺参"红点 ——
 * 它根本不参与执行，红点却说它有问题，而且点不出任何提示。
 *
 * ================= 为什么不给连接端口 =================
 *
 * 框不是流程的一环。给了端口就能把线连到框上，
 * 而框不执行，那条线连的是"什么都没有" ——
 * 引擎会报"找不到上游"，用户却看不出为什么不能连。
 */
export function FrameNode({ data, selected }: NodeProps) {
  const d = (data ?? {}) as FrameNodeData;
  const count = (d.members ?? []).length;
  return (
    <div className={`af-frame${selected ? ' is-selected' : ''}`}>
      <div className="af-frame-head">
        <span className="af-frame-tag">组合</span>
        <span className="af-frame-title">{d.label || '组合'}</span>
        <span className="af-frame-count">{count} 个节点</span>
      </div>
    </div>
  );
}
