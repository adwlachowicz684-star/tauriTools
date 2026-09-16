import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { ModuleFlowNode } from '../flowTypes';
import type { ModuleNodeData } from '../types';

/**
 * 模块实例的画布卡片。
 *
 * 只显示名字与"跟随 / 已脱钩"状态 —— 内部结构不在这里展开，
 * 要改请进属性面板点「编辑内部」。画布上铺开内部结构会
 * 让每个模块块都占半屏，反而看不清流程主干。
 */
export function ModuleNode({ id, data, selected }: NodeProps<ModuleFlowNode>) {
  const d = data as ModuleNodeData;
  const detached = !!d.inner;
  return (
    <NodeShell
      id={id}
      type="module"
      data={d}
      selected={selected}
      tag="模块"
      dotColor={detached ? '#94a3b8' : '#f59e0b'}
      statusText={{
        idle: detached ? '已脱钩' : '跟随模块库',
      }}
      footExtra={detached ? null : '改库则跟着变'}
    >
      <div className="fs-summary">
        <code className="fs-path" title={d.label}>{d.label}</code>
      </div>
      <div className="node-sub">
        {detached ? '独立副本 · 不跟随模块库' : '来自模块库'}
      </div>
    </NodeShell>
  );
}
