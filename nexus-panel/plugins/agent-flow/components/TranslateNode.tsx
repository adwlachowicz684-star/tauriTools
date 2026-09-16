import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { TranslateNodeData } from '../types';
import { PROVIDER_META, TARGET_LANGS } from '../engine/llm';
import type { TranslateFlowNode } from '../flowTypes';

export default function TranslateNode({ id, data, selected }: NodeProps<TranslateFlowNode>) {
  const d: TranslateNodeData = data;
  const meta = PROVIDER_META[d.llm?.provider ?? 'custom'];
  const preset = TARGET_LANGS.find((l) => l.code === d.targetLang);
  const targetText = preset ? preset.label : d.targetLang;

  return (
    <NodeShell
      id={id}
      type="translate"
      data={d}
      selected={selected}
      className="translate"
      tag={`${meta?.label ?? '自定义'} · ${d.llm?.model || '未选模型'}`}
      footExtra={
        d.lastChars != null && d.lastChars > 0 ? (
          <span className="node-model">{d.lastChars} 字</span>
        ) : null
      }
    >
      <div className="node-prompt">
        <span className="node-tag">→ {targetText || '未指定语言'}</span>
        {d.text ? d.text.slice(0, 70) + (d.text.length > 70 ? '…' : '') : '（未填写待翻译内容）'}
      </div>
    </NodeShell>
  );
}
