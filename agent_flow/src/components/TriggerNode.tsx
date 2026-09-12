import { Handle, Position, type NodeProps } from '@xyflow/react';
import { TRIGGER_META, type TriggerNodeData } from '../types';
import type { TriggerFlowNode } from '../flowTypes';

const STATUS_TEXT: Record<string, string> = {
  idle: '待触发',
  pending: '排队中',
  running: '触发中',
  success: '已触发',
  failed: '异常',
  skipped: '已跳过',
};

/** 触发器配置的简短摘要，直接显示在节点卡片上 */
function summary(d: TriggerNodeData): string {
  const c = d.config;
  switch (d.trigger) {
    case 'manual':
      return '点「运行」时触发';
    case 'interval':
      return `每 ${c.intervalSec} 秒`;
    case 'cron':
      return `cron: ${c.cronExpr}`;
    case 'watch': {
      const exts = c.watchExts?.length ? ` · ${c.watchExts.join('/')}` : '';
      return `监听 ${c.watchDir || '（未配置目录）'}${exts}`;
    }
    case 'webhook':
      return `POST :${c.port}${c.path}`;
    default:
      return '';
  }
}

export default function TriggerNode({ id, data, selected }: NodeProps<TriggerFlowNode>) {
  const d: TriggerNodeData = data;
  const meta = TRIGGER_META[d.trigger];

  return (
    <div
      className={`node-card trigger status-${d.status} ${selected ? 'is-selected' : ''} ${
        d.enabled ? '' : 'is-disabled'
      }`}
    >
      {/* 触发器是起点，没有输入端口 */}
      <Handle type="source" position={Position.Right} />

      <div className="node-head">
        <span className="node-dot" style={{ background: '#eab308' }} />
        <span className="node-title">{d.label}</span>
        <span className={`node-badge badge-${d.status}`}>{STATUS_TEXT[d.status]}</span>
      </div>

      <div className="node-cli">
        <span className="trig-icon">{meta?.icon ?? '⚡'}</span>
        {meta?.label ?? d.trigger}
        {!d.enabled && <span className="trig-off">已停用</span>}
      </div>

      <div className="trig-summary">{summary(d)}</div>

      {d.lastFiredAt && (
        <div className="trig-last">
          上次触发：{new Date(d.lastFiredAt).toLocaleString('zh-CN')}
        </div>
      )}

      <div className="node-foot">
        <span className="node-id">{id}</span>
        <span className="node-model">触发器起点</span>
      </div>
    </div>
  );
}
