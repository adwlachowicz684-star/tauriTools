import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { TranslateNodeData } from '../types';
import { PROVIDER_META, TARGET_LANGS } from '../engine/llm';
import type { TranslateFlowNode } from '../flowTypes';

const STATUS_TEXT: Record<string, string> = {
  idle: '待运行',
  pending: '排队中',
  running: '翻译中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

export default function TranslateNode({ id, data, selected }: NodeProps<TranslateFlowNode>) {
  const d: TranslateNodeData = data;
  const meta = PROVIDER_META[d.llm?.provider ?? 'custom'];
  const preset = TARGET_LANGS.find((l) => l.code === d.targetLang);
  const targetText = preset ? preset.label : d.targetLang;

  return (
    <div className={`node-card translate status-${d.status} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />

      <div className="node-head">
        <span className="node-dot" style={{ background: '#38bdf8' }} />
        <span className="node-title">{d.label}</span>
        <span className={`node-badge badge-${d.status}`}>{STATUS_TEXT[d.status]}</span>
      </div>

      <div className="node-cli">
        {meta?.label ?? '自定义'} · {d.llm?.model || '未选模型'}
      </div>

      <div className="node-prompt">
        <span className="node-tag">→ {targetText || '未指定语言'}</span>
        {d.text ? d.text.slice(0, 70) + (d.text.length > 70 ? '…' : '') : '（未填写待翻译内容）'}
      </div>

      <div className="node-foot">
        <span className="node-id">{id}</span>
        {d.lastChars != null && d.lastChars > 0 && <span className="node-model">{d.lastChars} 字</span>}
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
