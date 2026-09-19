import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { LoopNodeData } from '../types';
import { LOOP_MODE_META } from '../types';
import type { LoopFlowNode } from '../flowTypes';
import { NodeShell, NODE_STATUS_TEXT } from './NodeShell';

/** 把分隔符显示成人能看懂的样子 */
function sepLabel(sep: string): string {
  if (sep === '\\n') return '换行';
  if (sep === ',') return '逗号';
  if (sep === ';') return '分号';
  if (sep === '\\t') return '制表符';
  if (sep === '') return '换行';
  return sep;
}

export default function LoopNode({ id, data, selected }: NodeProps<LoopFlowNode>) {
  const d: LoopNodeData = data;

  const detail =
    d.mode === 'times'
      ? `固定 ${d.times} 次`
      : d.mode === 'list'
        ? `列表 · 按「${sepLabel(d.separator)}」切分${d.source ? ` · 来源 ${d.source}` : ' · 全部上游'}`
        : `匹配 ${d.pattern || '（未填通配符）'}`;

  return (
    <NodeShell
      id={id}
      type="loop"
      data={d}
      selected={selected}
      className="loop"
      tag={`循环 · ${LOOP_MODE_META[d.mode]?.label ?? d.mode} · 不调用 CLI`}
      statusText={{
        ...NODE_STATUS_TEXT,
        running: '循环进行中',
        success: '循环完成',
        failed: '有轮次失败',
      }}
      footExtra={
        <span className="node-line--foot">
          上限 {d.maxIterations} · {d.onError === 'stop' ? '遇错停止' : '遇错继续'}
        </span>
      }
      // 两个出口（循环体 / 结束）在下面自行渲染，不用外壳默认那个
      hasSource={false}
    >
      {/*
        两个出口：
          上 = 循环体（每轮迭代都跑）
          下 = 循环结束（全部迭代完成后跑一次）
        用竖向位置区分，比左右更易读。
      */}
      <Handle
        type="source"
        position={Position.Right}
        id="body"
        className="loop-handle loop-handle-body"
        style={{ top: '38%' }}
        title="循环体：每轮迭代执行一次"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="done"
        className="loop-handle loop-handle-done"
        style={{ top: '72%' }}
        title="循环结束：全部迭代完成后执行一次"
      />

      <div className="loop-summary">
        <span className="loop-icon" aria-hidden>
          ⟲
        </span>
        {detail}
      </div>

      <div className="loop-ports">
        <span className="loop-port body">循环体</span>
        <span className="loop-port done">结束</span>
      </div>
    </NodeShell>
  );
}
