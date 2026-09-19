import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { FsNodeData } from '../types';
import { FS_OP_META } from '../types';
import type { FsFlowNode } from '../flowTypes';

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
    <NodeShell
      id={id}
      type="fs"
      data={d}
      selected={selected}
      className="fs"
      tag="文件操作 · 经 Rust 执行"
      footExtra={
        <span className="node-line--foot">{meta?.destructive ? '会改动磁盘' : '只读'}</span>
      }
    >

      <div className={`node-line node-line--path ${meta?.destructive ? 'is-danger' : ''}`}>
        <span className="node-line__op">{meta?.label ?? d.op}</span>
        <code className="node-line__code" title={d.path}>
          {shortPath(d.path)}
        </code>
      </div>

      {(d.op === 'copy' || d.op === 'move') && (
        <div className="node-line node-line--path is-sub">
          <span className="node-line__arrow">→</span>
          <code className="node-line__code" title={d.target}>
            {shortPath(d.target) || '（未填目标）'}
          </code>
        </div>
      )}

      {d.dryRun && <div className="node-line--flag">演练模式 · 不会真正改动磁盘</div>}
    </NodeShell>
  );
}
