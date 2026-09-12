import type { DragEvent } from 'react';
import {
  CLI_META,
  TRIGGER_META,
  type CliKind,
} from '../types';

/**
 * 从边栏拖到画布上时携带的数据。
 * 用 dataTransfer 传字符串，drop 时再解析——这是 HTML5 拖放的标准做法。
 */
export type DragPayload =
  | { kind: 'task'; cli: CliKind }
  | { kind: 'condition' }
  | { kind: 'parallel' }
  | { kind: 'loop' }
  | { kind: 'fs' }
  | { kind: 'bili' }
  | { kind: 'wechat' }
  | { kind: 'trigger' };

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
    if (p.kind === 'loop' || p.kind === 'fs') return p;
    if (p.kind === 'bili' || p.kind === 'wechat') return p;
    if (p.kind === 'trigger') return p;
    return null;
  } catch {
    return null;
  }
}

type Props = {
  onAdd: (p: DragPayload) => void;
  disabled?: boolean;
};

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
        {/*
          五种触发方式合并成一个节点 —— 它们只是同一个节点的配置项，
          拆成五个拖拽项会让节点库变长，而添加后还要在右侧面板再选一次类型。
          默认「手动触发」：最安全，不会一放上画布就自动跑起来。
        */}
        <div
          className="side-item"
          draggable={!disabled}
          onDragStart={(e) => onDragStart(e, { kind: 'trigger' })}
          onClick={() => !disabled && onAdd({ kind: 'trigger' })}
          title="工作流的起点。添加后在右侧面板里选择具体触发方式"
        >
          <span className="side-dot" style={{ background: '#eab308' }} />
          <span className="side-label">触发器</span>
        </div>
        <div className="side-sub">
          {Object.values(TRIGGER_META).map((m) => m.label).join(' / ')}
        </div>
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
        <div
          className="side-item"
          draggable={!disabled}
          onDragStart={(e) => onDragStart(e, { kind: 'loop' })}
          onClick={() => !disabled && onAdd({ kind: 'loop' })}
          title="重复执行下游子图：固定次数 / 遍历列表 / 匹配文件"
        >
          <span className="side-dot" style={{ background: '#f472b6' }} />
          <span className="side-label">循环</span>
        </div>
      </div>

      <div className="side-group">
        <div className="side-title">文件</div>
        <div
          className="side-item"
          draggable={!disabled}
          onDragStart={(e) => onDragStart(e, { kind: 'fs' })}
          onClick={() => !disabled && onAdd({ kind: 'fs' })}
          title="读写删改文件或目录，经 Rust 执行"
        >
          <span className="side-dot" style={{ background: '#38bdf8' }} />
          <span className="side-label">文件操作</span>
        </div>
      </div>

      <div className="side-group">
        <div className="side-title">更新检测</div>
        <div
          className="side-item"
          draggable={!disabled}
          onDragStart={(e) => onDragStart(e, { kind: 'bili' })}
          onClick={() => !disabled && onAdd({ kind: 'bili' })}
          title="检测 B站 UP 主是否有新投稿，输出 true / false 供条件节点判断"
        >
          <span className="side-dot" style={{ background: '#fb7299' }} />
          <span className="side-label">B站 UP 主</span>
        </div>
        <div
          className="side-item"
          draggable={!disabled}
          onDragStart={(e) => onDragStart(e, { kind: 'wechat' })}
          onClick={() => !disabled && onAdd({ kind: 'wechat' })}
          title="检测微信公众号是否有新推文（需填第三方订阅源地址）"
        >
          <span className="side-dot" style={{ background: '#07c160' }} />
          <span className="side-label">微信公众号</span>
        </div>
        <div className="side-sub">输出 true / false，接条件节点即可分流</div>
      </div>

      {disabled && <div className="side-hint warn">运行中不可添加节点</div>}
    </aside>
  );
}
