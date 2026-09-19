import type { NodeProps } from '@xyflow/react';
import { NodeShell, NODE_STATUS_TEXT } from './NodeShell';

/**
 * 表格节点共用的卡片。
 *
 * 四个节点结构一样（一行摘要），合成一个。
 * 摘要显示"几行 × 几列"和公式 —— 扫一眼知道这张表多大、在算什么。
 */
export function TableNode({ id, type, data, selected }: NodeProps) {
  const d = (data ?? {}) as Record<string, unknown>;
  return (
    <NodeShell
      id={id}
      type={type}
      data={d}
      selected={selected}
      statusText={{ ...NODE_STATUS_TEXT, running: '计算中' }}
    >
      <div className="node-line node-line--brief">{briefOf(type, d)}</div>
    </NodeShell>
  );
}

function briefOf(type: string, d: Record<string, unknown>): string {
  if (type === 'tableRead') {
    const p = String(d.path ?? '').trim();
    return p ? p.split(/[\\/]/).pop() ?? p : '还没选文件';
  }
  if (type === 'derive') {
    const c = String(d.newCol ?? '').trim();
    const e = String(d.expr ?? '').trim();
    if (!c && !e) return '还没填公式';
    return e ? `${c} = ${e}` : `新增列 ${c}`;
  }
  if (type === 'filter') {
    const c = String(d.cond ?? '').trim();
    return c ? `保留：${c}` : '还没填条件';
  }
  if (type === 'agg') {
    const c = String(d.col ?? '').trim();
    const op = String(d.op ?? 'sum');
    const label: Record<string, string> = {
      sum: '求和', avg: '平均', min: '最小', max: '最大', count: '计数',
    };
    return c ? `${label[op] ?? op}：${c}` : '还没填列名';
  }
  return '';
}
