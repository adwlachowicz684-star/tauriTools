import type { NodeProps } from '@xyflow/react';
import { TRIGGER_META, TRIGGER_KINDS, type TriggerConfig, type TriggerKind, type TriggerNodeData } from '../types';
import { triggerEntriesOf, entryEnabled, mergeConfig } from '../engine/triggerEntries';
import type { TriggerFlowNode } from '../flowTypes';
import { NodeShell } from './NodeShell';
import { ArgLine } from './ArgCell';
import type { BriefPart } from '../engine/ops';

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
      // 换了方式之后这一档可能是空的（新方式还没配），不能显示成 undefined
      return c.cronExpr || '（未填表达式）';
    case 'watch':
      return c.watchDir || '（未配置目录）';
    case 'webhook':
      return `:${c.port}${c.path}`;
    default:
      return '';
  }
}

/** 方式下拉的选项 */
const KIND_OPTS = TRIGGER_KINDS.map((k) => ({
  value: k,
  label: TRIGGER_META[k]?.label ?? k,
}));

/**
 * 这一档的摘要里，哪一段是可编辑的、改的是哪个字段。
 *
 * 手动档没有可编辑的东西（点按钮就完了），返回空。
 */
function editableFieldOf(kind: TriggerKind): { key: string; label: string } | null {
  switch (kind) {
    case 'interval': return { key: 'intervalSec', label: '周期秒数' };
    case 'cron':     return { key: 'cronExpr',    label: 'cron 表达式' };
    case 'watch':    return { key: 'watchDir',    label: '监听目录' };
    case 'webhook':  return { key: 'port',        label: '端口' };
    default:         return null;
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

  /*
   * 写入路径要按**原始数组**的下标，不能按过滤后列表的下标。
   *
   * triggerEntriesOf 会跳过 id 为空或 kind 非法的条目，
   * 于是第 2 张卡在过滤后的列表里下标是 1，在原始数组里可能是 3。
   * 用错下标就是把值写进另一张卡 —— 不报错，改的是你看不见的地方。
   */
  const rawEntries = Array.isArray((d as unknown as Record<string, unknown>).entries)
    ? ((d as unknown as Record<string, unknown>).entries as Record<string, unknown>[])
    : null;

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
        {entries.map((e) => {
          /*
           * 找不到原始下标 = 这条是老存档现算出来的，还没落盘。
           *
           * 这时**不给编辑**：写 `entries.0.config.x` 会凭空建出
           * `{config:{...}}` 而没有 id/kind，triggerEntriesOf 会跳过它 ——
           * 结果是"改了一下，这张卡消失了"，而老字段 triggers 还在，
           * 于是下次打开又是原来的样子，看着像随机出错。
           */
          const rawIdx = rawEntries
            ? rawEntries.findIndex((x) => String(x?.id ?? '') === e.id)
            : -1;
          const cfg = mergeConfig(d.config, e.config);
          const field = editableFieldOf(e.kind);

          const parts: BriefPart[] = [
            {
              role: 'op',
              text: TRIGGER_META[e.kind]?.label ?? e.kind,
              key: 'kind',
              /*
               * 老存档现算出来的卡（rawIdx = -1）不能给编辑 ——
               * 写 `entries.-1.kind` 会凭空建出一条没有 id/kind 的条目，
               * triggerEntriesOf 随即跳过它，"改了一下，这张卡消失了"。
               */
              edit: rawIdx >= 0
                ? { key: 'kind', kind: 'select', path: `entries.${rawIdx}.kind`, options: KIND_OPTS }
                : undefined,
            },
          ];
          if (field) {
            const rawVal = String((cfg as unknown as Record<string, unknown>)[field.key] ?? '');
            parts.push({
              role: 'val',
              text: field.key === 'intervalSec' ? `${rawVal} 秒` : rawVal || '（未填）',
              key: field.key,
              raw: rawVal,
              edit: rawIdx >= 0
                ? {
                    key: field.key,
                    kind: 'text',
                    path: `entries.${rawIdx}.config.${field.key}`,
                  }
                : undefined,
            });
          }

          return (
            <div key={e.id} className={'trig-row' + (entryEnabled(e) ? '' : ' is-off')}>
              <span className="trig-kind-icon">{TRIGGER_META[e.kind]?.icon ?? '⚡'}</span>
              {/*
                方式 + 关键参数都在卡片上直接改。
                以前改一个周期秒数要打开右侧面板、在好几张条件卡里找到那一张，
                而卡片上明明就写着"每 30 秒"。
              */}
              <ArgLine
                nodeId={id}
                type="trigger"
                data={d as unknown as Record<string, unknown>}
                parts={parts}
              />
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
          );
        })}
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
