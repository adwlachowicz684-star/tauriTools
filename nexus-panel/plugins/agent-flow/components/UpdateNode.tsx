import type { NodeProps } from '@xyflow/react';
import { UPDATE_SOURCE_META, type UpdateNodeData } from '../types';
import type { BiliFlowNode, WechatFlowNode } from '../flowTypes';
import { NodeShell, NODE_STATUS_TEXT } from './NodeShell';

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
    <NodeShell
      id={id}
      // 本组件服务 bili / wechat 两种类型，圆点色按数据源取（两处的
      // meta.color 本就引用同一个 UPDATE_SOURCE_META，仍是单一来源）
      type="bili"
      dotColor={meta.color}
      data={d}
      selected={selected}
      className="update"
      statusText={{
        ...NODE_STATUS_TEXT,
        idle: '待检查',
        running: '检查中',
        success: '已检查',
        failed: '检查失败',
      }}
      footExtra={<span className="node-model">更新检测</span>}
      tag={
        <>
          <span className="upd-icon">{meta.icon}</span>
          {meta.label} · 输出 true / false
        </>
      }
    >

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

    </NodeShell>
  );
}
