import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { ArgLine } from './ArgCell';
import type { BriefPart } from '../engine/ops';
import type { TaskNodeData } from '../types';
import { CLI_META } from '../types';
import type { TaskFlowNode } from '../flowTypes';

export default function TaskNode({ id, data, selected }: NodeProps<TaskFlowNode>) {
  const d: TaskNodeData = data;
  const meta = CLI_META[d.cli];

  /*
   * 提示词在卡片上直接改。
   *
   * 以前这里是一行截断到 90 字的纯文字：改提示词必须打开右侧面板，
   * 而提示词恰恰是这类节点**唯一真正要调的东西** ——
   * 调一次要：选中 → 找到那一栏 → 改 → 回画布看，来回好几趟。
   *
   * 显示的仍然是截断后的那截（长提示词不能把整张画布顶开），
   * 但编辑初值是**完整原文** —— 见 BriefPart.raw 的说明：
   * 拿截断后的当初值，一失焦就等于把原文改成了那截。
   */
  const prompt = String(d.prompt ?? '');
  const shown = prompt
    ? prompt.slice(0, 90) + (prompt.length > 90 ? '…' : '')
    : '（未填写提示词）';
  const promptPart: BriefPart = prompt
    ? { role: 'val', text: shown, key: 'prompt', raw: prompt, edit: { key: 'prompt', kind: 'area' } }
    : { role: 'val', text: shown, key: 'prompt', raw: '', edit: { key: 'prompt', kind: 'area' } };

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
      <ArgLine
        nodeId={id}
        type="task"
        data={d as unknown as Record<string, unknown>}
        parts={[promptPart]}
      />

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
