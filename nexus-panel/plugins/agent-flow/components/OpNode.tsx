import type { NodeProps } from '@xyflow/react';
import { NodeShell, NODE_STATUS_TEXT } from './NodeShell';
import { opSummary } from '../engine/ops';

/**
 * 运算 / 变量 / 停止 / 人工输入 共用的卡片。
 *
 * 这七个节点的结构完全一样（一行摘要），各写一个会多出七份
 * 几乎相同的卡片 —— 与 ToolNode 同样的理由，合成一个。
 *
 * 摘要直接显示"在算什么"（如 "＋"、"拼接"、"变量：总数"），
 * 扫一眼就知道这个节点在干什么，不必逐个点开。
 */
export function OpNode({ id, type, data, selected }: NodeProps) {
  const d = (data ?? {}) as Record<string, unknown>;
  const brief = briefOf(type, d);
  return (
    <NodeShell
      id={id}
      type={type}
      data={d}
      selected={selected}
      statusText={{ ...NODE_STATUS_TEXT, running: '运算中' }}
    >
      <div className="node-brief">{brief}</div>
    </NodeShell>
  );
}

function briefOf(type: string, d: Record<string, unknown>): string {
  const op = String(d.op ?? '');
  if (type === 'math' || type === 'text' || type === 'compare' || type === 'random') {
    return opSummary(type, op);
  }
  if (type === 'var') {
    const name = String(d.name ?? '').trim();
    const isGet = String(d.mode ?? 'set') === 'get';
    return name ? `${isGet ? '读取' : '写入'}：${name}` : (isGet ? '读取变量' : '写入变量');
  }
  if (type === 'stop') {
    return String(d.mode ?? 'all') === 'all' ? '停止整个流程' : '停止这条分支';
  }
  if (type === 'ask') {
    const p = String(d.prompt ?? '').trim();
    return p ? `等人填：${p.slice(0, 20)}` : '等人输入';
  }
  return '';
}
