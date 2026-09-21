import { useState, type DragEvent } from 'react';
import { prompt, confirm, alert } from '../../../../js/dialog.js';
import { getVariableGroup } from '../../nodes/registry';
import {
  varsOfGroup, addVariable, removeVariable, renameVariable, duplicateVar,
  varIdOf, applyVarTo, detachVar, setVariableGlobal, type Variable,
} from '../../engine/variables';

/**
 * 变量选择器 —— 一排「凹槽卡扣」式小卡片，点一下就让节点引用这个变量。
 *
 * 语义（与引擎层的注释一致，这里再说一次因为 UI 上要体现）：
 *   变量 = 值；节点 = 引用。
 *   · 点变量 → 节点记下引用，值不再存在节点上
 *   · 之后改节点上的字段 → 改的是**变量本身**，其它引用它的节点一起变
 *   · 「脱离」→ 把当前值拷一份到节点上，之后自己管自己的
 *
 * 拖动：
 *   · 拖到画布上的节点 → 引用（会做类型验证，不适配的组会被拒绝）
 *   · 按住 Ctrl / ⌘ 拖动 → 复制一个新变量（与节点复制同一套手感）
 */

export const VAR_DRAG_MIME = 'application/x-agent-flow-card';

export type VarDragPayload = { cardId: string; group: string };

export function encodeVarDrag(p: VarDragPayload): string {
  return JSON.stringify(p);
}

/** 解析卡片拖拽数据。只校验形状，真正的合法性在 drop 时按目标节点判断 */
export function decodeVarDrag(raw: string | null | undefined): VarDragPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as VarDragPayload;
    if (!p || typeof p.cardId !== 'string' || typeof p.group !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}

type Props = {
  group: string;
  /** 当前节点 data */
  d: Record<string, unknown>;
  /** 写入节点（可含多个字段） */
  patch: (p: Record<string, unknown>) => void;
  /** 新建变量时的默认名字 */
  defaultName?: string;
  /**
   * 当前画布 id。变量默认画布级，只有本画布 + 全局的可见。
   * 不传则只看得到全局变量 —— 拿不到上下文时宁可少给，
   * 也不要把别张画布的变量混进选择器里。
   */
  canvasId?: string;
};

export function VariablePicker({ group, d, patch, defaultName, canvasId }: Props) {
  /*
   * 卡片存在 localStorage 里，增删改之后要重新读。
   * 用本地计数触发重渲染即可 —— 列表本来就是每次渲染现读的。
   */
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  const groupDef = getVariableGroup(group);
  const keys = groupDef?.keys ?? [];
  const summary = groupDef?.summary ?? (() => '');

  const cards = varsOfGroup(group, canvasId);
  const activeId = varIdOf(d, group);
  // 卡片被删掉了，但节点还记着它的 id —— 当"曾经套用过、现已自定义"处理
  const activeExists = activeId ? cards.some((c) => c.id === activeId) : false;
  const detached = !activeId || !activeExists;

  /** 取当前节点上这组字段的值（用于新建卡片） */
  const currentValues = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = d[k];
    return out;
  };

  const onPick = (c: Variable) => {
    patch(applyVarTo(d, c));
    refresh();
  };

  const onDetach = () => {
    patch(detachVar(d, group));
    refresh();
  };

  const onSaveAs = async () => {
    const values = currentValues();
    // 整组都空就没必要存成卡片
    const hasAny = Object.values(values).some(
      (v) => v !== undefined && v !== null && String(v).trim() !== '',
    );
    if (!hasAny) {
      await alert({
        title: '还没有填内容',
        message: `先在上面填好${defaultName ?? '这些参数'}，再存成卡片。`,
      });
      return;
    }
    const name = await prompt({
      title: '存成变量',
      message: '存好后点一下就能让本画布的节点引用它；改变量，引用的节点一起变。',
      placeholder: '变量名称',
      defaultValue: defaultName ?? summary(values),
      validate: (v: string) => (v && v.trim() ? null : '请填个名字'),
    });
    if (!name) return;
    const card = addVariable({ group, name, values, canvasId });
    // 存完顺便套上，符合"存了就是要用"的预期
    patch(applyVarTo(d, card));
    refresh();
  };

  const askRename = async (c: Variable) => {
    const next = await prompt({
      title: '重命名变量',
      message: '只改名字，引用它的节点跟着显示新名字。',
      placeholder: '变量名称',
      defaultValue: c.name,
      validate: (v: string) => (v && v.trim() ? null : '请填个名字'),
    });
    if (!next) return;
    renameVariable(c.id, next);
    refresh();
  };

  const askRemove = async (c: Variable) => {
    const ok = await confirm({
      title: `删除变量「${c.name}」？`,
      message: '引用了它的节点会变回空白，需要重新选一个变量或自己填。',
    });
    if (!ok) return;
    removeVariable(c.id);
    // 若当前正套用着它，顺手脱钩，免得节点记着一个不存在的 id
    if (activeId === c.id) patch(detachVar(d, group));
    refresh();
  };

  /** 在面板内按住 Ctrl 拖动也能复制（落点就在这一行里） */
  const onDropHere = (e: DragEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const p = decodeVarDrag(e.dataTransfer.getData(VAR_DRAG_MIME))
      ?? decodeVarDrag(e.dataTransfer.getData('text/plain'));
    if (!p || p.group !== group) return;
    e.preventDefault();
    e.stopPropagation();
    const copy = duplicateVar(p.cardId);
    refresh();
    if (copy) void alert({ title: '已复制变量', message: `「${copy.name}」已添加到这一组。` });
  };

  return (
    <div
      className="pc-row"
      onDrop={onDropHere}
      onDragOver={(e) => {
        if (e.ctrlKey || e.metaKey) e.preventDefault();
      }}
    >
      {cards.map((c) => {
        const on = c.id === activeId;
        return (
          <span
            key={c.id}
            className={`pc-card${on ? ' on' : ''}`}
            title={`${summary(c.values)}\n点一下引用；拖到画布节点上也能引用；按住 Ctrl 拖动复制`}
            draggable
            onDragStart={(e) => {
              const payload = encodeVarDrag({ cardId: c.id, group });
              e.dataTransfer.setData(VAR_DRAG_MIME, payload);
              // 同时放一份 text/plain，某些环境下自定义 MIME 会被过滤
              e.dataTransfer.setData('text/plain', payload);
              e.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <button
              className="pc-pick"
              onClick={() => onPick(c)}
              title={on ? '已引用这个变量' : '引用这个变量'}
            >
              <span className="pc-name">{c.name}</span>
              <span className="pc-sum">{summary(c.values)}</span>
            </button>
            <span className="pc-ops">
              {/*
               * 全局开关。默认画布级 —— 跨画布共享请走「画布输入 / 输出」，
               * 那是显式的连线，看得见来龙去脉；全局变量一多名字就撞。
               */}
              <button
                className={'pc-op' + (c.global ? ' on' : '')}
                title={c.global
                  ? '全局：所有画布都能引用 —— 点一下改回画布级'
                  : '画布级：只有本画布能引用 —— 点一下改成全局'}
                onClick={() => { setVariableGlobal(c.id, !c.global, canvasId ?? ''); refresh(); }}
              >
                {c.global ? '全' : '画'}
              </button>
              <button className="pc-op" title="重命名变量" onClick={() => void askRename(c)}>✎</button>
              <button className="pc-op pc-del" title="删除变量" onClick={() => void askRemove(c)}>×</button>
            </span>
          </span>
        );
      })}

      {/* 脱离态：明确告诉用户"这份值不跟着变量变" */}
      {detached && keys.length > 0 && String(d[keys[0]] ?? '').trim() !== '' ? (
        <span className="pc-card is-custom" title="这份值不跟随变量">
          <span className="pc-name">独立</span>
        </span>
      ) : null}

      <button className="pc-add" onClick={() => void onSaveAs()} title="把当前这几个参数存成一个变量">
        ＋
      </button>
      {activeId && activeExists ? (
        <button className="pc-detach" onClick={onDetach} title="脱离变量：把当前值拷到节点上，之后自己管自己的">
          脱离
        </button>
      ) : null}
    </div>
  );
}
