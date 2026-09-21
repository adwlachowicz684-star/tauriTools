import type { NodeProps } from '@xyflow/react';
import { TRIGGER_META, type TriggerConfig, type TriggerKind, type TriggerNodeData } from '../types';
import { triggerEntriesOf, entryEnabled, mergeConfig } from '../engine/triggerEntries';
import type { TriggerFlowNode } from '../flowTypes';
import { NodeShell } from './NodeShell';

/** 某种触发方式的简短摘要 */
function summaryOf(c: TriggerConfig, k: TriggerKind): string {
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
  /*
   * 每个触发条件是一张卡 —— 逐张显示，停用的也显示（标出来），
   * 不显示的话用户会以为那个条件不存在。
   */
  const entries = triggerEntriesOf(d as unknown as Record<string, unknown>);

  return (
    <NodeShell
      id={id}
      type="trigger"
      data={d}
      selected={selected}
      // is-disabled 是触发器独有的（停用态），外壳不认识，这里自己加
      // 口径 `=== false`：老存档没有 enabled 字段，取到 undefined，
      // 写成 `!d.enabled` 会让好端端的触发器显示"已停用"
      className={`trigger ${d.enabled === false ? 'is-disabled' : ''}`}
      /* 触发器是起点，没有输入端口 */
      hasTarget={false}
      tag={
        <>
          <span className="trig-icon">⚡</span>
          {entries.length === 1
            ? (TRIGGER_META[entries[0].kind]?.label ?? entries[0].kind)
            : `${entries.length} 个触发条件`}
          {d.enabled === false && <span className="trig-off">已停用</span>}
        </>
      }
      footExtra={<span className="node-line--foot">触发器起点</span>}
    >

      <div className="trig-list">
        {entries.length === 0 && <div className="trig-row dim">还没有触发条件</div>}
        {entries.map((e) => (
          <div key={e.id} className={'trig-row' + (entryEnabled(e) ? '' : ' is-off')}>
            <span className="trig-kind-icon">{TRIGGER_META[e.kind]?.icon ?? '⚡'}</span>
            <span className="trig-kind">{TRIGGER_META[e.kind]?.label ?? e.kind}</span>
            {/* 用这张卡自己的配置做摘要 —— 读共享 config 会显示成别的条件的值 */}
            <span className="trig-detail">{summaryOf(mergeConfig(d.config, e.config), e.kind)}</span>
            {!entryEnabled(e) && <span className="trig-off">停用</span>}
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
