/* ⚠️ 本文件当前**没有任何地方 import 它** —— 是重构遗留的旧实现。
 * ------------------------------------------------------------
 * 生效的那一份在 components/ControlNode.tsx（同名的 JoinNode），
 * nodes/defs/join.tsx 从那边取，与 gate / throttle / timeout / retry
 * 一起共用共享外壳 Card。
 *
 * 两份的差异（2026-10 核对）：
 *   · 本文件 —— 额外画两个 target handle（id 'a' / 'b'，38% 与 62%），
 *     纯**视觉**用途：让"它在等好几路"一眼看得见。下面那段注释已写明
 *     真正的多路是靠多条边连到同一 target，handle id 不参与引擎判定。
 *   · ControlNode 版 —— 不画 handle，靠 NodeShell 的默认 target handle。
 *
 * 也就是说**重构到共享 Card 时丢掉了"两个入口"的视觉提示**。要不要把那两个
 * 装饰 handle 挪回 ControlNode 版，属于观感取舍，由 agent-flow 那边定。
 *
 * 别直接把 defs/join.tsx 改回引本文件 —— 那会让汇合节点绕过共享外壳，
 * 且长出两个不参与判定的入口，看着能连、实际连了也没用。
 *
 * 守卫：regression-guard-test.mjs 第 1.7b 节钉着"生效的是 ControlNode 版"。
 */
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
