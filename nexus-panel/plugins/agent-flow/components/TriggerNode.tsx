import type { NodeProps } from '@xyflow/react';
import { TRIGGER_META, triggerKindsOf, type TriggerKind, type TriggerNodeData } from '../types';
import type { TriggerFlowNode } from '../flowTypes';
import { NodeShell } from './NodeShell';

/** 某种触发方式的简短摘要 */
function summaryOf(d: TriggerNodeData, k: TriggerKind): string {
  const c = d.config;
  switch (k) {
    case 'manual':
      return '点「运行」时触发';
    case 'interval':
      return `每 ${c.intervalSec} 秒`;
    case 'cron':
      return c.cronExpr;
    case 'watch':
      return c.watchDir || '（未配置目录）';
    case 'webhook':
      return `:${c.port}${c.path}`;
    default:
      return '';
  }
}

export default function TriggerNode({ id, data, selected }: NodeProps<TriggerFlowNode>) {
  const d: TriggerNodeData = data;
  // 一个节点可以挂多种触发方式，兼容旧的单值字段
  const kinds: TriggerKind[] = triggerKindsOf(d);

  return (
    <NodeShell
      id={id}
      type="trigger"
      data={d}
      selected={selected}
      // is-disabled 是触发器独有的（停用态），外壳不认识，这里自己加
      className={`trigger ${d.enabled ? '' : 'is-disabled'}`}
      /* 触发器是起点，没有输入端口 */
      hasTarget={false}
      tag={
        <>
          <span className="trig-icon">⚡</span>
          {kinds.length === 1
            ? (TRIGGER_META[kinds[0]]?.label ?? kinds[0])
            : `${kinds.length} 种触发方式`}
          {!d.enabled && <span className="trig-off">已停用</span>}
        </>
      }
      footExtra={<span className="node-line--foot">触发器起点</span>}
    >

      <div className="trig-list">
        {kinds.length === 0 && <div className="trig-row dim">未选择触发方式</div>}
        {kinds.map((k) => (
          <div key={k} className="trig-row">
            <span className="trig-kind-icon">{TRIGGER_META[k]?.icon ?? '⚡'}</span>
            <span className="trig-kind">{TRIGGER_META[k]?.label ?? k}</span>
            <span className="trig-detail">{summaryOf(d, k)}</span>
          </div>
        ))}
      </div>

      {d.lastFiredAt && (
        <div className="trig-last">
          上次触发：{d.lastFiredKind ? `${TRIGGER_META[d.lastFiredKind]?.label ?? d.lastFiredKind} · ` : ''}
          {new Date(d.lastFiredAt).toLocaleString('zh-CN')}
        </div>
      )}

    </NodeShell>
  );
}
