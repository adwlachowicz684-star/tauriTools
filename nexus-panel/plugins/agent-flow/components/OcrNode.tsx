import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { OcrNodeData } from '../types';
import { PROVIDER_META } from '../engine/llm';
import type { OcrFlowNode } from '../flowTypes';

const STATUS_TEXT: Record<string, string> = {
  idle: '待运行',
  pending: '排队中',
  running: '识别中',
  success: '已识别',
  failed: '失败',
  skipped: '已跳过',
};

const SOURCE_LABEL: Record<string, string> = { url: '网络地址', file: '本地文件' };

export default function OcrNode({ id, data, selected }: NodeProps<OcrFlowNode>) {
  const d: OcrNodeData = data;
  const meta = PROVIDER_META[d.llm?.provider ?? 'custom'];
  const src = d.imageSource === 'file' ? (d.path || '未填路径') : (d.url || '未填地址');

  return (
    <div className={`node-card ocr status-${d.status} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />

      <div className="node-head">
        <span className="node-dot" style={{ background: '#f472b6' }} />
        <span className="node-title">{d.label}</span>
        <span className={`node-badge badge-${d.status}`}>{STATUS_TEXT[d.status]}</span>
      </div>

      <div className="node-cli">
        {meta?.label ?? '自定义'} · {d.llm?.model || '未选模型'}
      </div>

      <div className="node-prompt">
        <span className="node-tag">{SOURCE_LABEL[d.imageSource] ?? d.imageSource}</span>
        {src}
      </div>

      <div className="node-foot">
        <span className="node-id">{id}</span>
        {d.lastChars != null && d.lastChars > 0 && <span className="node-model">{d.lastChars} 字</span>}
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
