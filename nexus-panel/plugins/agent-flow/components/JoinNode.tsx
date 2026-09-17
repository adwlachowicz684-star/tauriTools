import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { JoinNodeData } from '../types';
import type { JoinFlowNode } from '../flowTypes';

/**
 * 汇合节点卡片。
 *
 * 视觉上刻意画出两个入口 —— 让"它在等好几路"这件事一眼看得见。
 *
 * 注意：**真正的多路是靠多条边连到同一个 target**，不是靠两个 handle。
 * 引擎按 target 找入边，handle id 不参与判定。
 */
export function JoinNode({ id, data, selected }: NodeProps<JoinFlowNode>) {
  const d = data as JoinNodeData;
  const strict = d.mode === 'strict';

  return (
    <NodeShell
      id={id}
      type="join"
      data={d}
      selected={selected}
      tag={strict ? '严格 · 缺一即停' : '宽松 · 到齐即放行'}
    >
      <Handle type="target" position={Position.Left} id="a" style={{ top: '38%' }} />
      <Handle type="target" position={Position.Left} id="b" style={{ top: '62%' }} />
    </NodeShell>
  );
}

export default JoinNode;
