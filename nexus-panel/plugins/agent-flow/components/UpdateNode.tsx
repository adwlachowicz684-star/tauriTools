import { Handle, Position, type NodeProps } from '@xyflow/react';
import { UPDATE_SOURCE_META, type UpdateNodeData } from '../types';
import type { BiliFlowNode, WechatFlowNode } from '../flowTypes';

const STATUS_TEXT: Record<string, string> = {
  idle: '待检查',
  pending: '排队中',
  running: '检查中',
  success: '已检查',
  failed: '检查失败',
  skipped: '已跳过',
};

/** 卡片上显示"要检测谁" */
function targetOf(d: UpdateNodeData): string {
  if (d.source === 'bilibili') {
    if (d.biliMode === 'rss') return d.feedUrl || '（未填订阅源）';
    return d.biliUid ? `UID ${d.biliUid}` : '（未填 UID）';
  }
  return d.feedUrl || '（未填订阅源）';
}

/** 把长 URL 压成好看的短形式 */
function shortUrl(u: string): string {
  if (!u) return '';
  const s = u.replace(/^https?:\/\//i, '');
  return s.length > 30 ? `${s.slice(0, 29)}…` : s;
}

export default function UpdateNode({ id, data, selected }: NodeProps<BiliFlowNode | WechatFlowNode>) {
  const d: UpdateNodeData = data;
  const meta = UPDATE_SOURCE_META[d.source];

  // 上次检查结果：用一个醒目的小徽章直接给出结论
  const verdict =
    d.lastUpdated === null
      ? null
      : d.lastUpdated
        ? { text: '有更新', cls: 'yes' }
        : { text: '无更新', cls: 'no' };

  return (
    <div className={`node-card update status-${d.status} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      <div className="node-head">
        <span className="node-dot" style={{ background: meta.color }} />
        <span className="node-title">{d.label}</span>
        <span className={`node-badge badge-${d.status}`}>{STATUS_TEXT[d.status]}</span>
      </div>

      <div className="node-cli">
        <span className="upd-icon">{meta.icon}</span>
        {meta.label} · 输出 true / false
      </div>

      <div className="upd-summary">
        <code title={d.source === 'bilibili' && d.biliMode === 'api' ? d.biliUid : d.feedUrl}>
          {shortUrl(targetOf(d))}
        </code>
      </div>

      <div className="upd-foot">
        {verdict && <span className={`upd-verdict ${verdict.cls}`}>{verdict.text}</span>}
        {d.lastCheckedAt && (
          <span className="upd-time">
            {new Date(d.lastCheckedAt).toLocaleString('zh-CN', {
              month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
            })}
          </span>
        )}
      </div>

      {d.lastSeenTitle && (
        <div className="upd-latest" title={d.lastSeenTitle}>
          最新：{d.lastSeenTitle}
        </div>
      )}

      <div className="node-foot">
        <span className="node-id">{id}</span>
        <span className="node-model">更新检测</span>
      </div>
    </div>
  );
}
