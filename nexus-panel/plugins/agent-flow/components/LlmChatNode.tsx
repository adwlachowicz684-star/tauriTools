import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { LLM_USE_META, type LlmChatNodeData, type LlmUse } from '../types';

/**
 * 大模型节点卡片。
 *
 * 一个节点覆盖三种用途（自由对话 / 图片识别 / 翻译），
 * 所以卡片上显示的内容随用途变：
 *   - 自由对话：有没有角色 + 要问的内容
 *   - 图片识别：图片来源 + 识别要求
 *   - 翻译：目标语言 + 待翻译内容
 *
 * 模型名**必须显示** —— 它决定花多少钱、跑多快，
 * 而节点卡片是运行时之外唯一能一眼看到它的地方。
 */
export default function LlmChatNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as LlmChatNodeData;
  const use: LlmUse = d.use ?? 'chat';
  const prompt = String(d.prompt ?? '').trim();
  const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;

  /*
   * 用途徽章要显示 —— 三种用途的字段完全不同，
   * 同名卡片上不写用途的话，看到"翻译"节点却显示图片来源会以为配错了。
   */
  const useBadge = use === 'chat' ? null : (
    <span className="node-pill">{LLM_USE_META[use].label}</span>
  );

  /* 图片识别：来源比提示词更该先看到（它决定能不能跑） */
  const srcBadge = use === 'ocr'
    ? <span className="node-pill">{d.imageSource === 'file' ? '本地文件' : '网络地址'}</span>
    : null;

  /* 翻译：翻成什么语言 */
  const langBadge = use === 'translate' && d.targetLang
    ? <span className="node-pill">→ {String(d.targetLang)}</span>
    : null;

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
        {useBadge}
        {srcBadge}
        {langBadge}
        {use === 'chat' && d.system ? <span className="node-pill">有角色</span> : null}
        {/*
         * 空态复用 node-line--meta（灰字），与 FsNode「（未填路径）」等处同一套写法。
         * 必须带 node-line 块类名：--meta 只管外观，间距与字号基准在块上（见 classNames 测试）。
         */}
        {preview || <span className="node-line node-line--meta">（未填内容）</span>}
      </div>
    </NodeShell>
  );
}
