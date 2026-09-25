import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { LlmChatNodeData } from '../types';

/**
 * 大模型节点卡片。
 *
 * 与 OCR 卡片的区别只是"显示哪几项"：
 * OCR 一定显示图片来源，这个节点显示的是本次要问的内容。
 *
 * 模型名**必须显示** —— 它决定花多少钱、跑多快，
 * 而节点卡片是运行时之外唯一能一眼看到它的地方。
 */
export default function LlmChatNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as LlmChatNodeData;
  const prompt = String(d.prompt ?? '').trim();
  const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;

  return (
    <NodeShell
      id={id}
      type="llmChat"
      data={d}
      selected={selected}
      className="llm-chat"
      tag={d.model || '未选模型'}
      footExtra={
        String(d.output ?? '').length > 0 ? (
          <span className="node-line--foot">{String(d.output).length} 字</span>
        ) : null
      }
    >
      <div className="node-line node-line--preview">
        {d.system ? <span className="node-pill">有角色</span> : null}
        {/*
         * 空态复用 node-line--meta（灰字），与 FsNode「（未填路径）」等处同一套写法。
         * 必须带 node-line 块类名：--meta 只管外观，间距与字号基准在块上（见 classNames 测试）。
         */}
        {preview || <span className="node-line node-line--meta">（未填内容）</span>}
      </div>
    </NodeShell>
  );
}
