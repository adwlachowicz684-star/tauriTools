import { Handle, Position, type NodeProps } from '@xyflow/react';
import { EXTRACT_MODE_META, HTTP_METHODS, type ExtractNodeData, type GenericHttpNodeData } from '../types';
import type { ExtractFlowNode, GenericHttpFlowNode } from '../flowTypes';

const STATUS_TEXT: Record<string, string> = {
  idle: '待运行',
  pending: '排队中',
  running: '执行中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

/**
 * 通用节点的画布卡片。
 *
 * 一个组件服务两种节点（HTTP 请求 / 数据提取）：它们的卡片结构完全一样
 * （标题行 + 一行摘要），差别只在摘要怎么算。为此各写一个组件会多出两份
 * 几乎相同的 60 行，不值得。
 */
function Card({
  id, data, selected, color, tag, summary, title,
}: {
  id: string;
  data: { label?: string; status?: string };
  selected?: boolean;
  color: string;
  tag: string;
  summary: { text: string; full?: string };
  title?: string;
}) {
  return (
    <div
      className={`node-card status-${data.status ?? 'idle'} ${selected ? 'is-selected' : ''}`}
      id={id}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      <div className="node-head">
        <span className="node-dot" style={{ background: color }} />
        <span className="node-title">{data.label}</span>
        <span className={`node-badge badge-${data.status ?? 'idle'}`}>
          {STATUS_TEXT[data.status ?? 'idle']}
        </span>
      </div>

      <div className="node-cli">{tag}</div>

      <div className="fs-summary">
        <code className="fs-path" title={summary.full ?? summary.text}>
          {summary.text}
        </code>
      </div>
      {title ? <div className="node-sub">{title}</div> : null}
    </div>
  );
}

/** 去掉协议头与查询串，只留主机 + 路径 —— 卡片上放不下完整 URL */
function briefUrl(url: string): { text: string; full: string } {
  const raw = (url ?? '').trim();
  if (!raw) return { text: '（未填地址）', full: '' };
  try {
    const u = new URL(raw);
    const p = u.pathname === '/' ? '' : u.pathname;
    return { text: `${u.host}${p}`, full: raw };
  } catch {
    // 还没填完 / 含 {{变量}} 时不是合法 URL，原样截断显示
    return { text: raw.length > 40 ? `${raw.slice(0, 40)}…` : raw, full: raw };
  }
}

export function HttpCard({ id, data, selected }: NodeProps<GenericHttpFlowNode>) {
  const d = data as GenericHttpNodeData;
  const method = HTTP_METHODS.includes(d.method) ? d.method : 'GET';
  return (
    <Card
      id={id}
      data={d}
      selected={selected}
      color="#0ea5e9"
      tag="HTTP 请求 · 经桌面端发出"
      summary={{ text: `${method} ${briefUrl(d.url).text}` }}
      title={briefUrl(d.url).full !== briefUrl(d.url).text ? briefUrl(d.url).full : undefined}
    />
  );
}

export function ExtractCard({ id, data, selected }: NodeProps<ExtractFlowNode>) {
  const d = data as ExtractNodeData;
  const meta = EXTRACT_MODE_META[d.mode];
  return (
    <Card
      id={id}
      data={d}
      selected={selected}
      color="#38bdf8"
      tag={`按${meta?.label ?? d.mode}提取`}
      summary={{
        text: d.mode === 'text' ? '原样传给下游' : (d.spec || '（未填参数）'),
      }}
    />
  );
}
