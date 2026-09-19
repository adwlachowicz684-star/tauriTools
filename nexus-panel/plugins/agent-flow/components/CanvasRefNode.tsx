import type { NodeProps } from '@xyflow/react';
import { NodeShell, NODE_STATUS_TEXT } from './NodeShell';
import { canvasRefDisplayName } from '../engine/canvasRefName';

/**
 * 跨画布相关的三个节点共用的卡片。
 *
 * 结构一样（标题 + 一行说明），合成一个。
 */
export function CanvasRefNode({ id, type, data, selected }: NodeProps) {
  const d = (data ?? {}) as Record<string, unknown>;
  /*
   * 卡片拿不到画布列表（只收 data），所以显示名只能用**快照** canvasName。
   *
   * 快照是在创建 / 选画布时写的，目标画布后来改名会不同步 ——
   * 这事由 App 在改名时回写（见 syncCanvasNames），卡片这边不猜。
   */
  return (
    <NodeShell
      id={id}
      type={type}
      data={d}
      selected={selected}
      statusText={NODE_STATUS_TEXT}
    >
      <div className="node-line node-line--brief">{briefOf(type, d)}</div>
    </NodeShell>
  );
}

function briefOf(type: string, d: Record<string, unknown>): string {
  if (type === 'canvasRef') {
    /*
     * 绝不再显示 canvasId 的片段。
     *
     * 以前这里写 `调用画布 ${cid.slice(0, 8)}…` ——
     * 画布没名字时用户看到的是 `cvmamu7obyv93` 这种内部 id，
     * 看着像乱码，且完全无法对应到哪张画布。
     * 内部 id 对用户没有任何意义，显示它只会让人以为是故障。
     */
    const name = canvasRefDisplayName(d);
    const cid = String(d.canvasId ?? '').trim();
    if (!cid) return name; // '还没选要调用哪张画布'
    return `调用「${name}」`;
  }
  if (type === 'canvasIn') {
    const p = String(d.portName ?? '').trim();
    return p ? `入口 · ${p}` : '画布入口';
  }
  if (type === 'canvasOut') {
    const p = String(d.portName ?? '').trim();
    return p ? `出口 · ${p}` : '画布出口';
  }
  return '';
}
