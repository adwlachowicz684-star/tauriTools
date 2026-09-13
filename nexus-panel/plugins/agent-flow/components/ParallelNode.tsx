import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ParallelNodeData } from '../types';
import type { ParallelFlowNode } from '../flowTypes';
import { describeRule } from '../engine/parallel';

const STATUS_TEXT: Record<string, string> = {
  idle: '待运行',
  pending: '排队中',
  running: '解析中',
  success: '已解析',
  failed: '解析异常',
  skipped: '已跳过',
};

export default function ParallelNode({ id, data, selected }: NodeProps<ParallelFlowNode>) {
  const d: ParallelNodeData = data;
  const rules = d.rules ?? [];

  const summary =
    d.mode === 'all'
      ? '不限制并发'
      : d.mode === 'fixed'
        ? `固定并发 ${d.concurrency}`
        : rules.length > 0
          ? `${rules.length} 条规则 · 兜底 ${d.fallbackConcurrency}`
          : `兜底并发 ${d.fallbackConcurrency}`;

  return (
    <div className={`node-card parallel status-${d.status} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      <div className="node-head">
        <span className="node-dot" style={{ background: '#06b6d4' }} />
        <span className="node-title">{d.label}</span>
        <span className={`node-badge badge-${d.status}`}>{STATUS_TEXT[d.status]}</span>
      </div>

      <div className="node-cli">并发控制 · 不调用 CLI</div>

      <div className="par-summary">
        <span className="par-bars" aria-hidden>
          {Array.from({ length: 3 }, (_, i) => (
            <i key={i} />
          ))}
        </span>
        {summary}
      </div>

      {d.mode === 'byRule' && rules.length > 0 && (
        <div className="par-rules">
          {rules.slice(0, 3).map((r) => (
            <div key={r.id} className="par-rule">
              {describeRule(r)}
            </div>
          ))}
          {rules.length > 3 && <div className="par-rule dim">…还有 {rules.length - 3} 条</div>}
        </div>
      )}

      <div className="node-foot">
        <span className="node-id">{id}</span>
        <span className="node-model">作用于下游</span>
      </div>
    </div>
  );
}
