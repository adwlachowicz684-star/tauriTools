import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { PASS_CHECK_LABEL } from '../engine/passCheck';
import type {
  JoinNodeData, GateNodeData, ThrottleNodeData,
  TimeoutNodeData, RetryNodeData,
} from '../types';
import type {
  JoinFlowNode, GateFlowNode, ThrottleFlowNode,
  TimeoutFlowNode, RetryFlowNode,
} from '../flowTypes';

/**
 * 控制器卡片。
 *
 * 五个控制器共享一个外壳 —— 它们都不产生数据，
 * 卡片上要展示的都是"它在管什么"，结构一致。
 *
 * 类型色统一由 NodeShell 从注册表取（meta.color），
 * 这里只负责 tag 与 tagExtra 这两行语义文字。
 */
function Card({
  id, type, data, selected, tag, tagExtra,
}: {
  id: string;
  type: string;
  data: { label?: string; status?: string };
  selected?: boolean;
  tag: string;
  tagExtra?: string;
}) {
  return (
    <NodeShell id={id} type={type} data={data} selected={selected} tag={tag}>
      {tagExtra ? <div className="fs-summary"><code className="fs-path" title={tagExtra}>{tagExtra}</code></div> : null}
    </NodeShell>
  );
}

/** 毫秒数太长读着累，超过 1 秒换成秒 */
export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} 秒` : `${ms} 毫秒`;
}

export function JoinNode({ id, data, selected }: NodeProps<JoinFlowNode>) {
  const d = data as JoinNodeData;
  return (
    <Card
      id={id}
      type="join"
      data={d}
      selected={selected}
      tag={d.mode === 'strict' ? '严格 · 缺一即停' : '宽松 · 到齐即放行'}
    />
  );
}

export function GateNode({ id, data, selected }: NodeProps<GateFlowNode>) {
  const d = data as GateNodeData;
  const how = PASS_CHECK_LABEL[d.check ?? 'nonempty'] ?? d.check;
  const extra = d.check === 'nonempty' ? undefined : String(d.value ?? '');
  return (
    <Card
      id={id}
      type="gate"
      data={d}
      selected={selected}
      tag={d.mode === 'wait' ? `等待 · ${how}` : `立即判定 · ${how}`}
      tagExtra={extra}
    />
  );
}

export function ThrottleNode({ id, data, selected }: NodeProps<ThrottleFlowNode>) {
  const d = data as ThrottleNodeData;
  const max = Number(d.maxPerRun ?? 0);
  return (
    <Card
      id={id}
      type="throttle"
      data={d}
      selected={selected}
      tag={`间隔 ${humanMs(Number(d.minIntervalMs ?? 0))}`}
      tagExtra={max > 0 ? `本次最多放行 ${max} 次` : undefined}
    />
  );
}

export function TimeoutNode({ id, data, selected }: NodeProps<TimeoutFlowNode>) {
  const d = data as TimeoutNodeData;
  return (
    <Card
      id={id}
      type="timeout"
      data={d}
      selected={selected}
      tag={`预算 ${humanMs(Number(d.budgetMs ?? 0))}`}
      tagExtra={d.onExceed === 'pass' ? '超预算也放行' : '超预算即中断'}
    />
  );
}

export function RetryNode({ id, data, selected }: NodeProps<RetryFlowNode>) {
  const d = data as RetryNodeData;
  const how = PASS_CHECK_LABEL[d.check ?? 'nonempty'] ?? d.check;
  return (
    <Card
      id={id}
      type="retry"
      data={d}
      selected={selected}
      tag={`重试 ${Number(d.times ?? 0)} 次 · ${how}`}
      tagExtra={d.target ? `目标 ${d.target}` : '未指定目标'}
    />
  );
}
