import type { DragEvent } from 'react';
import { presetsByCategory, getDef } from '../nodes';

/**
 * 从边栏拖到画布上时携带的数据。
 * 用 dataTransfer 传字符串，drop 时再解析——这是 HTML5 拖放的标准做法。
 *
 * kind 存的是**预设 key**（'task' / 'task:codebuddy' / 'condition' …），
 * 不再是枚举出来的联合类型 —— 预设由注册表生成，写死联合会立刻过期
 * （以后用户自定义节点注册进来，这里不可能预先知道）。
 */
export type DragPayload = { kind: string };

export const DRAG_MIME = 'application/x-agent-flow-node';

export function encodeDrag(p: DragPayload): string {
  return JSON.stringify(p);
}

/**
 * 解析拖拽数据。
 *
 * 只校验「是个带 kind 字符串的对象」——不再维护一份类型白名单。
 * 白名单的问题是新注册的类型忘了加进来就会被静默丢弃，
 * 而真正的合法性判断在 App 那边：查不到预设就忽略，行为一致。
 */
export function decodeDrag(raw: string | null | undefined): DragPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as DragPayload;
    if (!p || typeof p.kind !== 'string') return null;
    return p;
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

  /*
   * 侧栏条目、分组、配色、提示语全部来自注册表里各节点自己声明的 meta。
   *
   * 以前这里的每个条目都是手写的一段 JSX：加一种节点要在 DragPayload 联合、
   * decodeDrag 白名单、以及下面这片 UI 里各加一处，三处不同步就会出现
   * "侧栏点得出来、但拖放被 decodeDrag 判为非法而静默丢弃"。
   * 现在只有一处真相，这类不同步不可能再发生。
   */
  const groups = presetsByCategory();

  return (
    <aside className="sidebar">
      <div className="side-head">节点库</div>
      <div className="side-hint">拖到画布，或点击直接添加</div>

      {groups.map((g) => {
        const def = getDef(g.presets[0].type);
        return (
          <div className="side-group" key={g.category}>
            <div className="side-title">{g.label}</div>
            {g.presets.map((p) => (
              <div
                key={p.key}
                className="side-item"
                draggable={!disabled}
                onDragStart={(e) => onDragStart(e, { kind: p.key })}
                onClick={() => !disabled && onAdd({ kind: p.key })}
                title={p.hint ?? `拖到画布添加 ${p.label}`}
              >
                <span className="side-dot" style={{ background: p.color }} />
                <span className="side-label">{p.label}</span>
              </div>
            ))}
            {def.meta.sub ? <div className="side-sub">{def.meta.sub}</div> : null}
          </div>
        );
      })}
    </aside>
  );
}
