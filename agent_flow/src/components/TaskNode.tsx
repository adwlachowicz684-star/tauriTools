import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CLI_META, type TaskNodeData } from '../types';
import type { TaskFlowNode } from '../flowTypes';

const STATUS_TEXT: Record<string, string> = {
  idle: '待运行',
  pending: '排队中',
  running: '执行中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

export default function TaskNode({ id, data, selected }: NodeProps<TaskFlowNode>) {
  const meta = CLI_META[data.cli];
  const d: TaskNodeData = data;

  return (
    <div className={`node-card status-${d.status} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />

      <div className="node-head">
        <span className="node-dot" style={{ background: meta.color }} />
        <span className="node-title">{d.label}</span>
        <span className={`node-badge badge-${d.status}`}>{STATUS_TEXT[d.status]}</span>
      </div>

      <div className="node-cli">{meta.label}</div>

      <div className="node-prompt">
        {d.prompt ? d.prompt.slice(0, 90) + (d.prompt.length > 90 ? '…' : '') : '（未填写提示词）'}
      </div>

      <div className="node-foot">
        <span className="node-id">{id}</span>
        {d.model && <span className="node-model">{d.model}</span>}
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
