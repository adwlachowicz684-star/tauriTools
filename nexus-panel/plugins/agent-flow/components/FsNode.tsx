import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FsNodeData } from '../types';
import { FS_OP_META } from '../types';
import type { FsFlowNode } from '../flowTypes';

const STATUS_TEXT: Record<string, string> = {
  idle: '待运行',
  pending: '排队中',
  running: '执行中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

/** 把长路径压缩成 "…/末尾两级"，节点卡片宽度有限 */
function shortPath(p: string): string {
  if (!p) return '（未填路径）';
  const norm = p.replace(/\\/g, '/');
  const segs = norm.split('/').filter(Boolean);
  if (segs.length <= 2) return norm;
  return `…/${segs.slice(-2).join('/')}`;
}

export default function FsNode({ id, data, selected }: NodeProps<FsFlowNode>) {
  const d: FsNodeData = data;
  const meta = FS_OP_META[d.op];

  return (
    <div className={`node-card fs status-${d.status} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      <div className="node-head">
        <span className="node-dot" style={{ background: '#38bdf8' }} />
        <span className="node-title">{d.label}</span>
        <span className={`node-badge badge-${d.status}`}>{STATUS_TEXT[d.status]}</span>
      </div>

      <div className="node-cli">文件操作 · 经 Rust 执行</div>

      <div className={`fs-summary ${meta?.destructive ? 'is-danger' : ''}`}>
        <span className="fs-op">{meta?.label ?? d.op}</span>
        <code className="fs-path" title={d.path}>
          {shortPath(d.path)}
        </code>
      </div>

      {(d.op === 'copy' || d.op === 'move') && (
        <div className="fs-summary sub">
          <span className="fs-arrow">→</span>
          <code className="fs-path" title={d.target}>
            {shortPath(d.target) || '（未填目标）'}
          </code>
        </div>
      )}

      {d.dryRun && <div className="fs-flag">演练模式 · 不会真正改动磁盘</div>}

      <div className="node-foot">
        <span className="node-id">{id}</span>
        <span className="node-model">{meta?.destructive ? '会改动磁盘' : '只读'}</span>
      </div>
    </div>
  );
}
