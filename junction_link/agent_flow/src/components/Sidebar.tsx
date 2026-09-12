import type { DragEvent } from 'react';
import {
  CLI_META,
  TRIGGER_META,
  type CliKind,
  type TriggerKind,
} from '../types';

/**
 * 从边栏拖到画布上时携带的数据。
 * 用 dataTransfer 传字符串，drop 时再解析——这是 HTML5 拖放的标准做法。
 */
export type DragPayload =
  | { kind: 'task'; cli: CliKind }
  | { kind: 'condition' }
  | { kind: 'parallel' }
  | { kind: 'trigger'; trigger: TriggerKind };

export const DRAG_MIME = 'application/x-agent-flow-node';

export function encodeDrag(p: DragPayload): string {
  return JSON.stringify(p);
}

/** 解析拖拽数据；格式不对时返回 null，调用方应静默忽略 */
export function decodeDrag(raw: string | null | undefined): DragPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as DragPayload;
    if (!p || typeof p.kind !== 'string') return null;
    if (p.kind === 'task' && (p as { cli?: string }).cli) return p;
    if (p.kind === 'condition' || p.kind === 'parallel') return p;
    if (p.kind === 'trigger' && (p as { trigger?: string }).trigger) return p;
    return null;
  } catch {
    return null;
  }
}

type Props = {
  onAdd: (p: DragPayload) => void;
  disabled?: boolean;
};

const TRIGGER_KINDS: TriggerKind[] = ['manual', 'interval', 'cron', 'watch', 'webhook'];

export default function Sidebar({ onAdd, disabled }: Props) {
  const onDragStart = (e: DragEvent, p: DragPayload) => {
    e.dataTransfer.setData(DRAG_MIME, encodeDrag(p));
    // 同时放一份 text/plain，某些环境下自定义 MIME 会被过滤
    e.dataTransfer.setData('text/plain', encodeDrag(p));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <aside className="sidebar">
      <div className="side-head">节点库</div>
      <div className="side-hint">拖到画布，或点击直接添加</div>

      <div className="side-group">
        <div className="side-title">任务</div>
        {(Object.keys(CLI_META) as CliKind[]).map((k) => (
          <div
            key={k}
            className="side-item"
            draggable={!disabled}
            onDragStart={(e) => onDragStart(e, { kind: 'task', cli: k })}
            onClick={() => !disabled && onAdd({ kind: 'task', cli: k })}
            title={`拖到画布添加 ${CLI_META[k].label} 任务节点`}
          >
            <span className="side-dot" style={{ background: CLI_META[k].color }} />
            <span className="side-label">{CLI_META[k].label}</span>
          </div>
        ))}
      </div>

      <div className="side-group">
        <div className="side-title">触发器（起点）</div>
        {TRIGGER_KINDS.map((k) => (
          <div
            key={k}
            className="side-item"
            draggable={!disabled}
            onDragStart={(e) => onDragStart(e, { kind: 'trigger', trigger: k })}
            onClick={() => !disabled && onAdd({ kind: 'trigger', trigger: k })}
            title={TRIGGER_META[k].hint}
          >
            <span className="side-dot" style={{ background: '#eab308' }} />
            <span className="side-label">{TRIGGER_META[k].label}</span>
          </div>
        ))}
      </div>

      <div className="side-group">
        <div className="side-title">流程控制</div>
        <div
          className="side-item"
          draggable={!disabled}
          onDragStart={(e) => onDragStart(e, { kind: 'condition' })}
          onClick={() => !disabled && onAdd({ kind: 'condition' })}
          title="按条件走不同分支，不消耗积分"
        >
          <span className="side-dot" style={{ background: '#a855f7' }} />
          <span className="side-label">条件分支</span>
        </div>
        <div
          className="side-item"
          draggable={!disabled}
          onDragStart={(e) => onDragStart(e, { kind: 'parallel' })}
          onClick={() => !disabled && onAdd({ kind: 'parallel' })}
          title="控制下游节点的并发度，可按条件决定"
        >
          <span className="side-dot" style={{ background: '#06b6d4' }} />
          <span className="side-label">并发控制</span>
        </div>
      </div>

      {disabled && <div className="side-hint warn">运行中不可添加节点</div>}
    </aside>
  );
}
