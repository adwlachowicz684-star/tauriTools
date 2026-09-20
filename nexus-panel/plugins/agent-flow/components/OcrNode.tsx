import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { OcrNodeData } from '../types';
import { PROVIDER_META } from '../engine/llm';
import type { OcrFlowNode } from '../flowTypes';

const SOURCE_LABEL: Record<string, string> = { url: '网络地址', file: '本地文件' };

export default function OcrNode({ id, data, selected }: NodeProps<OcrFlowNode>) {
  const d: OcrNodeData = data;
  const meta = PROVIDER_META[d.llm?.provider ?? 'custom'];
  const src = d.imageSource === 'file' ? (d.path || '未填路径') : (d.url || '未填地址');

  return (
    <NodeShell
      id={id}
      type="ocr"
      data={d}
      selected={selected}
      className="ocr"
      tag={`${meta?.label ?? '自定义'} · ${d.llm?.model || '未选模型'}`}
      footExtra={
        d.lastChars != null && d.lastChars > 0 ? (
          <span className="node-line--foot">{d.lastChars} 字</span>
        ) : null
      }
    >
      <div className="node-line node-line--preview">
        <span className="node-pill">{SOURCE_LABEL[d.imageSource] ?? d.imageSource}</span>
        {src}
      </div>
    </NodeShell>
  );
}
