import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { LoopNodeData, LoopMode } from '../types';
import { LOOP_MODE_META } from '../types';
import type { LoopFlowNode } from '../flowTypes';
import { NodeShell } from './NodeShell';
import { ArgLine } from './ArgCell';
import type { BriefPart } from '../engine/ops';

/** 把分隔符显示成人能看懂的样子 */
function sepLabel(sep: string): string {
  if (sep === '\\n') return '换行';
  if (sep === ',') return '逗号';
  if (sep === ';') return '分号';
  if (sep === '\\t') return '制表符';
  if (sep === '') return '换行';
  return sep;
}

/**
 * 循环方式在卡片上直接换。
 *
 * 循环节点没有走 registry 的 fields（面板是 LoopInspector 手写的），
 * 所以选项只能在这里显式给 —— 但**取自 LOOP_MODE_META**，
 * 与面板、与卡片 tag 用的是同一份，不在卡片上另抄一份标签。
 */
const MODE_OPTS = (Object.keys(LOOP_MODE_META) as LoopMode[]).map((k) => ({
  value: k,
  label: LOOP_MODE_META[k].label,
}));

export default function LoopNode({ id, data, selected }: NodeProps<LoopFlowNode>) {
  const d: LoopNodeData = data;
  const d2 = d as unknown as Record<string, unknown>;

  /*
   * 参数随方式变，所以摘要也要按方式拼 —— 与面板口径一致。
   *
   * 分隔符**不给编辑**：它的值可能是真正的换行符（默认就是 '\n'），
   * 单行输入框装不下换行，编辑框里只剩一个空串，
   * 一失焦就把分隔符改没了 —— 不报错，只是列表从此切不开。
   * 这种情况宁可让它留在面板里改。
   */
  const param: BriefPart[] =
    d.mode === 'times'
      ? [
          {
            role: 'val',
            text: `${d.times} 次`,
            key: 'times',
            raw: String(d.times ?? ''),
            edit: { key: 'times', kind: 'text' },
          },
        ]
      : d.mode === 'list'
        ? [
            { role: 'text', text: '按「' },
            // 分隔符：可见但不可改，理由见上
            { role: 'text', text: sepLabel(d.separator) },
            { role: 'text', text: '」切分' },
            ...(d.source
              ? [{ role: 'text' as const, text: `· 来源 ${d.source}` }]
              : [{ role: 'text' as const, text: '· 全部上游' }]),
          ]
        : [
            {
              role: 'val',
              text: d.pattern || '（未填通配符）',
              key: 'pattern',
              raw: String(d.pattern ?? ''),
              edit: { key: 'pattern', kind: 'text' },
            },
          ];

  return (
    <NodeShell
      id={id}
      type="loop"
      data={d}
      selected={selected}
      className="loop"
      tag={`循环 · ${LOOP_MODE_META[d.mode]?.label ?? d.mode} · 不调用 CLI`}
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
        <ArgLine
          nodeId={id}
          type="loop"
          data={d2}
          className="loop-text"
          parts={[
            {
              role: 'op',
              text: LOOP_MODE_META[d.mode]?.label ?? String(d.mode ?? ''),
              key: 'mode',
              raw: String(d.mode ?? ''),
              edit: { key: 'mode', kind: 'select', options: MODE_OPTS },
            },
            ...param,
          ]}
        />
      </div>

      <div className="loop-ports">
        <span className="loop-port body">循环体</span>
        <span className="loop-port done">结束</span>
      </div>
    </NodeShell>
  );
}
