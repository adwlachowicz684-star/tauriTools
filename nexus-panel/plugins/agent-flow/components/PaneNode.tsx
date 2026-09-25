import { useNodes, type NodeProps } from '@xyflow/react';
import { CLI_META, type CliKind } from '../types';

/**
 * 任务窗格卡片 —— 一块带标题的底板，标注这一组的共享配置。
 *
 * ================= 与组合框的差别 ====================
 *
 * 组合框只画图；窗格带配置，所以卡片上多一行摘要
 * （CLI 窗格显示工作目录 / 模型，API 窗格显示模型 / 角色设定）。
 *
 * 这一行不是装饰：窗格的价值就在于"改一处、整组生效"，
 * 卡片上看不到它现在配了什么，就无从判断这一组会不会按预期跑。
 *
 * ================= 成员数为什么现场数 ====================
 *
 * 归属关系是**节点上的 paneId 指向窗格**，单向。
 * 窗格上再存一份 members 就会有两处真相：
 * 节点改了 paneId 而窗格的 members 没跟着改，
 * 卡片上显示的数字就是错的 —— 而且是静默的，看不出哪边是真的。
 *
 * 所以窗格不维护名单，显示时按 paneId 现场数一遍，永远对得上。
 *
 * ================= 同样不给端口、不参与执行 ====================
 *
 * 理由与 FrameNode 完全一致：它不是流程的一环，
 * 给了端口就能连上一条指向"什么都没有"的线。
 */
export function PaneNode({ id, data, selected }: NodeProps) {
  const all = useNodes();
  const count = all.filter((n) => {
    const d = (n.data ?? null) as { paneId?: string } | null;
    return String(d?.paneId ?? '') === id;
  }).length;

  const d = (data ?? {}) as {
    kind?: string;
    label?: string;
    workdir?: string;
    model?: string;
    system?: string;
    cli?: CliKind;
  };
  const isApi = d.kind === 'apiPane';

  const sub = isApi
    ? (d.model || (d.system ? '已设角色提示词' : '未选模型'))
    : (d.workdir || (d.cli ? (CLI_META[d.cli]?.label ?? '') : '') || '未设工作目录');

  return (
    <div className={`af-frame af-pane${selected ? ' is-selected' : ''}`}>
      <div className="af-frame-head">
        <span className="af-frame-tag">{isApi ? 'API 窗格' : 'CLI 窗格'}</span>
        <span className="af-frame-title">{d.label || '任务窗格'}</span>
        <span className="af-frame-count">{count} 个节点</span>
      </div>
      <div className="af-frame-sub">{sub}</div>
    </div>
  );
}
