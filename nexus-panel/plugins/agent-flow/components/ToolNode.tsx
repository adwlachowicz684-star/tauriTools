import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { BEEP_PRESET_META, type BeepNodeData, type WaitNodeData, type LogNodeData, type PlayAudioNodeData, type ClockNodeData, type ConstNodeData } from '../types';
import type {
  WaitFlowNode, LogFlowNode, BeepFlowNode, PlayAudioFlowNode,
  ClockFlowNode, ConstFlowNode,
} from '../flowTypes';

/**
 * 工具节点的画布卡片。
 *
 * 这六种节点的画布结构完全一样（一行摘要），各写一个组件会多出六份
 * 几乎相同的 60 行 —— 与 GenericNode 同样的理由，合成一个。
 *
 * 摘要在卡片上直接显示关键参数，扫一眼就知道这个节点在干什么，
 * 不必逐个点开看。
 */

function Card({
  id, type, data, selected, tag, summary,
}: {
  id: string;
  type: string;
  /** data 只需这两个字段，六种节点都有 */
  data: { label?: string; status?: string };
  selected?: boolean;
  tag: string;
  summary: string;
}) {
  return (
    <NodeShell id={id} type={type} data={data} selected={selected} tag={tag}>
      <div className="fs-summary">
        <code className="fs-path" title={summary}>{summary}</code>
      </div>
    </NodeShell>
  );
}

/** 毫秒数太长读着累，超过 1 秒就换成秒 */
function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} 秒` : `${ms} 毫秒`;
}

export function WaitNode({ id, data, selected }: NodeProps<WaitFlowNode>) {
  const d = data as WaitNodeData;
  return (
    <Card
      id={id}
      type="wait"
      data={d}
      selected={selected}
      tag="等待"
      summary={humanMs(Number(d.ms ?? 0))}
    />
  );
}

export function LogNode({ id, data, selected }: NodeProps<LogFlowNode>) {
  const d = data as LogNodeData;
  const level = d.level ?? 'info';
  const mark = level === 'error' ? '✗' : level === 'warn' ? '⚠' : 'ℹ';
  const text = String(d.text ?? '').trim();
  return (
    <Card
      id={id}
      type="log"
      data={d}
      selected={selected}
      tag={`日志 ${mark}`}
      summary={text || '（留空则记上游内容）'}
    />
  );
}

export function BeepNode({ id, data, selected }: NodeProps<BeepFlowNode>) {
  const d = data as BeepNodeData;
  const meta = BEEP_PRESET_META[d.preset ?? 'success'];
  const vol = Math.round(Number(d.volume ?? 0.6) * 100);
  return (
    <Card
      id={id}
      type="beep"
      data={d}
      selected={selected}
      tag="提示音"
      summary={`${meta?.label ?? d.preset} · 音量 ${vol}%`}
    />
  );
}

export function PlayAudioNode({ id, data, selected }: NodeProps<PlayAudioFlowNode>) {
  const d = data as PlayAudioNodeData;
  const p = String(d.path ?? '').trim();
  const name = p ? p.split(/[\\/]/).pop() ?? p : '（未填文件）';
  return (
    <Card
      id={id}
      type="play-audio"
      data={d}
      selected={selected}
      tag="播放音频"
      summary={`${name}${d.waitForEnd === false ? ' · 不等待' : ''}`}
    />
  );
}

export function ClockNode({ id, data, selected }: NodeProps<ClockFlowNode>) {
  const d = data as ClockNodeData;
  return (
    <Card
      id={id}
      type="clock"
      data={d}
      selected={selected}
      tag="当前时间"
      summary={String(d.format ?? '')}
    />
  );
}

export function ConstNode({ id, data, selected }: NodeProps<ConstFlowNode>) {
  const d = data as ConstNodeData;
  const v = String(d.value ?? '');
  return (
    <Card
      id={id}
      type="const"
      data={d}
      selected={selected}
      tag="常量"
      summary={v || '（空）'}
    />
  );
}
