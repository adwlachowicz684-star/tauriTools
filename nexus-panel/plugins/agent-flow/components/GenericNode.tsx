import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { EXTRACT_MODE_META, HTTP_METHODS, type ExtractNodeData, type GenericHttpNodeData } from '../types';
import type { ExtractFlowNode, GenericHttpFlowNode } from '../flowTypes';

/**
 * 通用卡片：HTTP 请求与数据提取的画布结构完全一样（标题行 + 一行摘要），
 * 差别只在摘要怎么算。各写一个组件会多出两份几乎相同的 60 行，不值得。
 */
function Card({
  id, type, data, selected, tag, summary, title,
}: {
  id: string;
  type: string;
  data: { label?: string; status?: string };
  selected?: boolean;
  tag: string;
  summary: { text: string; full?: string };
  title?: string;
}) {
  return (
    <NodeShell id={id} type={type} data={data} selected={selected} tag={tag}>
      <div className="fs-summary">
        <code className="fs-path" title={summary.full ?? summary.text}>
          {summary.text}
        </code>
      </div>
      {title ? <div className="node-sub">{title}</div> : null}
    </NodeShell>
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
      type="generic-http"
      data={d}
      selected={selected}
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
      type="extract"
      data={d}
      selected={selected}
      tag={`按${meta?.label ?? d.mode}提取`}
      summary={{
        text: d.mode === 'text' ? '原样传给下游' : (d.spec || '（未填参数）'),
      }}
    />
  );
}
