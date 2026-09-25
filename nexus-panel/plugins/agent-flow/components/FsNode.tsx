import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { ArgLine } from './ArgCell';
import type { BriefPart } from '../engine/ops';
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

/**
 * 一个可就地编辑的文本参数格。
 *
 * 显示用 shortPath（卡片窄），**编辑初值必须是完整路径** ——
 * 拿截断后的那截当初值，点一下输入框里就只剩 `…/a/b`，
 * 一失焦等于把完整路径改成了这一截，且不报错，只是运行时找不到文件。
 */
function pathCell(key: string, full: string): BriefPart {
  return {
    role: 'val',
    text: shortPath(full),
    key,
    raw: full,
    edit: { key, kind: 'text' },
  };
}

export default function FsNode({ id, data, selected }: NodeProps<FsFlowNode>) {
  const d: FsNodeData = data;
  const meta = FS_OP_META[d.op];
  const dangerous = Boolean(meta?.destructive);
  const needsTarget = Boolean(meta?.needsTarget);

  return (
    <NodeShell
      id={id}
      type="fs"
      data={d}
      selected={selected}
      className="fs"
      tag="文件操作 · 经 Rust 执行"
      footExtra={
        <span className="node-line--foot">{dangerous ? '会改动磁盘' : '只读'}</span>
      }
    >
      {/*
       * 操作种类点一下就能换（下拉来自节点定义的 fields，不另写一份），
       * 路径点一下直接改 —— 以前这两样都是纯文字，改必须开右侧面板，
       * 而"读哪个文件"恰恰是这个节点唯一真正要调的东西。
       */}
      <ArgLine
        nodeId={id}
        type="fs"
        data={d as unknown as Record<string, unknown>}
        className={`node-line node-line--path${dangerous ? ' is-danger' : ''}`}
        parts={[
          {
            role: 'op',
            text: meta?.label ?? d.op,
            raw: String(d.op ?? ''),
            edit: { key: 'op', kind: 'select' },
          },
          pathCell('path', String(d.path ?? '')),
        ]}
      />

      {needsTarget && (
        <ArgLine
          nodeId={id}
          type="fs"
          data={d as unknown as Record<string, unknown>}
          className="node-line node-line--path is-sub"
          parts={[
            /*
             * 箭头是纯文字，不是参数 —— 画成正文而不是下凹格，
             * 免得看起来像"还有一个能点的东西"。
             */
            { role: 'text', text: '→' },
            pathCell('target', String(d.target ?? '')),
          ]}
        />
      )}

      {d.dryRun && <div className="node-line--flag">演练模式 · 不会真正改动磁盘</div>}
    </NodeShell>
  );
}
