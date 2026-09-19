import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { TaskNodeData } from '../types';
import { CLI_META } from '../types';
import type { TaskFlowNode } from '../flowTypes';

export default function TaskNode({ id, data, selected }: NodeProps<TaskFlowNode>) {
  const d: TaskNodeData = data;
  const meta = CLI_META[d.cli];

  return (
    <NodeShell
      id={id}
      type="task"
      data={d}
      selected={selected}
      /*
       * 圆点按所选 CLI 变色（两种 CLI 各有自己的品牌色），
       * 这是"同类型不同变体"的正当特例 —— 其余节点都该用注册表的 meta.color。
       */
      typeColor={meta?.color}
      tag={meta?.label}
      footExtra={d.model ? <span className="node-line--foot">{d.model}</span> : null}
    >
      <div className="node-line node-line--preview">
        {d.prompt ? d.prompt.slice(0, 90) + (d.prompt.length > 90 ? '…' : '') : '（未填写提示词）'}
      </div>

      {/* 改了哪些文件：扫一眼就知道参数有没有传出去 */}
      {d.lastFiles && d.lastFiles.length > 0 && (
        <div className="node-line--files" title={d.lastFiles.join('\n')}>
          <span className="node-line__badge">{d.lastFiles.length}</span>
          <span>{d.lastFiles[0].split(/[\\/]/).pop()}</span>
        </div>
      )}
    </NodeShell>
  );
}
