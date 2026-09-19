import type { NodeProps } from '@xyflow/react';
import { NodeShell, NODE_STATUS_TEXT } from './NodeShell';

/**
 * 跨画布相关的三个节点共用的卡片。
 *
 * 结构一样（标题 + 一行说明），合成一个。
 */
export function CanvasRefNode({ id, type, data, selected }: NodeProps) {
  const d = (data ?? {}) as Record<string, unknown>;
  return (
    <NodeShell
      id={id}
      type={type}
      data={d}
      selected={selected}
      statusText={NODE_STATUS_TEXT}
    >
      <div className="node-line node-line--brief">{briefOf(type, d)}</div>
    </NodeShell>
  );
}

function briefOf(type: string, d: Record<string, unknown>): string {
  if (type === 'canvasRef') {
    const cid = String(d.canvasId ?? '').trim();
    const name = String(d.canvasName ?? '').trim();
    if (!cid) return '还没选要调用哪张画布';
    return name ? `调用「${name}」` : `调用画布 ${cid.slice(0, 8)}…`;
  }
  if (type === 'canvasIn') {
    const p = String(d.portName ?? '').trim();
    return p ? `入口 · ${p}` : '画布入口';
  }
  if (type === 'canvasOut') {
    const p = String(d.portName ?? '').trim();
    return p ? `出口 · ${p}` : '画布出口';
  }
  return '';
}
