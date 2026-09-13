import { Handle, Position, type NodeProps } from '@xyflow/react';
import { DEFAULT_BRANCH, OP_META, type ConditionNodeData } from '../types';
import type { CondFlowNode } from '../flowTypes';
import { describeRule } from '../engine/condition';

const STATUS_TEXT: Record<string, string> = {
  idle: '待运行',
  pending: '排队中',
  running: '判定中',
  success: '已判定',
  failed: '判定异常',
  skipped: '已跳过',
};

export default function ConditionNode({ id, data, selected }: NodeProps<CondFlowNode>) {
  const d: ConditionNodeData = data;
  const rules = d.rules ?? [];

  return (
    <div className={`node-card cond status-${d.status} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />

      <div className="node-head">
        <span className="node-dot" style={{ background: '#a855f7' }} />
        <span className="node-title">{d.label}</span>
        <span className={`node-badge badge-${d.status}`}>{STATUS_TEXT[d.status]}</span>
      </div>

      <div className="node-cli">条件分支 · 不调用 CLI</div>

      <div className="cond-rules">
        {rules.length === 0 && <div className="cond-empty">未配置规则</div>}
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

      <div className="node-foot">
        <span className="node-id">{id}</span>
        <span className="node-model">菱形决策</span>
      </div>
    </div>
  );
}
