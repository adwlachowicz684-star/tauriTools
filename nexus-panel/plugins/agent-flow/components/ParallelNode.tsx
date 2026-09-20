import type { NodeProps } from '@xyflow/react';
import type { ParallelNodeData } from '../types';
import type { ParallelFlowNode } from '../flowTypes';
import { describeRule } from '../engine/parallel';
import { NodeShell } from './NodeShell';

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
    <NodeShell
      id={id}
      type="parallel"
      data={d}
      selected={selected}
      className="parallel"
      tag="并发控制 · 不调用 CLI"
      footExtra={<span className="node-line--foot">作用于下游</span>}
    >
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
    </NodeShell>
  );
}
