import type { NodeProps } from '@xyflow/react';
import { TRIGGER_META, type TriggerConfig, type TriggerKind, type TriggerNodeData } from '../types';
import { triggerEntriesOf, entryEnabled, mergeConfig } from '../engine/triggerEntries';
import type { TriggerFlowNode } from '../flowTypes';
import { NodeShell } from './NodeShell';

/** 某种触发方式的简短摘要 */
function summaryOf(c: TriggerConfig, k: TriggerKind): string {
  switch (k) {
    /*
     * 手动这一档的摘要不再写「点『运行』时触发」——
     * 那句话是在指别处的一个按钮，而卡片上现在自己就能点。
     * 写着"去别处点"、却又在本处给了按钮，是两种互相矛盾的指引。
     */
    case 'manual':
      return '点右边按钮立即跑一次';
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
  /*
   * 卡片上的「手动触发」回调 —— App 在渲染时塞进 data（不落盘，
   * 见 engine/sanitize 的 VIEW_KEYS）。
   *
   * 卡片组件只拿得到自己这一个节点，而它是按 node.type 从注册表取的，
   * 没有别的入口能传 props，所以走 data。
   */
  const fire = (d as unknown as { onFireManual?: (id: string) => void }).onFireManual;

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
            {/*
              手动这一档自己带触发按钮 —— 多触发器时，工具栏那个「运行」
              看不出跑的是哪一个，而卡片上写着"点『运行』时触发"
              却没有任何可点的东西。

              stopPropagation 是必须的：xyflow 的节点区会响应
              mousedown 做拖动/选中，不拦住的话点按钮会顺带把节点拖走。
            */}
            {e.kind === 'manual' && fire && entryEnabled(e) ? (
              <button
                type="button"
                className="trig-fire"
                title="立即跑一次这张画布"
                onMouseDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => { ev.stopPropagation(); fire(id); }}
              >▶ 触发</button>
            ) : null}
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
