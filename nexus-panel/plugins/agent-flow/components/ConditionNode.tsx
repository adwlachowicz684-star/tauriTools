import { Handle, Position, type NodeProps } from '@xyflow/react';
import { DEFAULT_BRANCH, OP_META, type ConditionNodeData } from '../types';
import type { CondFlowNode } from '../flowTypes';
import { describeRule } from '../engine/condition';
import { NodeShell, NODE_STATUS_TEXT } from './NodeShell';

export default function ConditionNode({ id, data, selected }: NodeProps<CondFlowNode>) {
  const d: ConditionNodeData = data;
  const rules = d.rules ?? [];

  return (
    <NodeShell
      id={id}
      type="condition"
      data={d}
      selected={selected}
      className="cond"
      tag="条件分支 · 不调用 CLI"
      statusText={{
        ...NODE_STATUS_TEXT,
        running: '判定中',
        success: '已判定',
        failed: '判定异常',
      }}
      footExtra={<span className="node-line--foot">菱形决策</span>}
      /*
       * 出口是每条规则各一个（分支手柄在 children 里逐个渲染），
       * 不是统一的一个右侧出口，所以关掉外壳默认那个。
       */
      hasSource={false}
    >
      <div className="cond-rules">
        {rules.length === 0 && <div className="nx-empty cond-empty">未配置规则</div>}
        {rules.map((r) => (
          <div key={r.id} className="cond-rule">
            <Handle
              type="source"
              position={Position.Right}
              id={r.id}
              style={{ top: 'auto' }}
              className="branch-handle"
            />
            {/* 算子带上图标与配色，扫一眼就能分辨是哪种判定 */}
            <span
              className="cond-op"
              style={{ borderColor: OP_META[r.op]?.color, color: OP_META[r.op]?.color }}
              title={OP_META[r.op]?.hint}
            >
              <span className="cond-op-icon">{OP_META[r.op]?.icon ?? '?'}</span>
              {OP_META[r.op]?.label ?? r.op}
            </span>
            <span className="cond-text">{describeRule(r)}</span>
          </div>
        ))}
        {d.defaultBranch && (
          <div className="cond-rule is-default">
            <Handle
              type="source"
              position={Position.Right}
              id={DEFAULT_BRANCH}
              className="branch-handle"
            />
            <span className="cond-op">兜底</span>
            <span className="cond-text">以上都不满足</span>
          </div>
        )}
      </div>
    </NodeShell>
  );
}
