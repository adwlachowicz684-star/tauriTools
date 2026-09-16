import { useState, type DragEvent } from 'react';
import { prompt, confirm, alert } from '../../../../js/dialog.js';
import { getCardGroup } from '../../nodes/registry';
import {
  cardsOfGroup, addParamCard, removeParamCard, renameParamCard, duplicateCard,
  cardIdOf, applyCardTo, detachGroup, type ParamCard,
} from '../../engine/paramCards';

/**
 * 参数卡片选择器 —— 一排「凹槽卡扣」式小卡片，点一下就把整组参数套到节点上。
 *
 * 语义（与引擎层的注释一致，这里再说一次因为 UI 上要体现）：
 *   卡片是模板库，节点上是实例。
 *   · 点卡片 → 拷贝一份值进节点
 *   · 之后改节点上的字段 → 自动脱钩成「自定义」，卡片与其它节点不受影响
 *   · 改卡片 → 不影响已套用过的节点
 *
 * 拖动：
 *   · 拖到画布上的节点 → 套用（会做类型验证，不适配的组会被拒绝）
 *   · 按住 Ctrl / ⌘ 拖动 → 复制一张新卡片（与节点复制同一套手感）
 */

export const CARD_DRAG_MIME = 'application/x-agent-flow-card';

export type CardDragPayload = { cardId: string; group: string };

export function encodeCardDrag(p: CardDragPayload): string {
  return JSON.stringify(p);
}

/** 解析卡片拖拽数据。只校验形状，真正的合法性在 drop 时按目标节点判断 */
export function decodeCardDrag(raw: string | null | undefined): CardDragPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as CardDragPayload;
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
  /** 新建卡片时的默认名字 */
  defaultName?: string;
};

export function ParamCardPicker({ group, d, patch, defaultName }: Props) {
  /*
   * 卡片存在 localStorage 里，增删改之后要重新读。
   * 用本地计数触发重渲染即可 —— 列表本来就是每次渲染现读的。
   */
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  const groupDef = getCardGroup(group);
  const keys = groupDef?.keys ?? [];
  const summary = groupDef?.summary ?? (() => '');

  const cards = cardsOfGroup(group);
  const activeId = cardIdOf(d, group);
  // 卡片被删掉了，但节点还记着它的 id —— 当"曾经套用过、现已自定义"处理
  const activeExists = activeId ? cards.some((c) => c.id === activeId) : false;
  const detached = !activeId || !activeExists;

  /** 取当前节点上这组字段的值（用于新建卡片） */
  const currentValues = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = d[k];
    return out;
  };

  const onPick = (c: ParamCard) => {
    patch(applyCardTo(d, c, keys));
    refresh();
  };

  const onDetach = () => {
    patch(detachGroup(d, group));
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
      title: '存成参数卡片',
      message: '存好后点一下就能套到其它节点上；改节点不会改到卡片本身。',
      placeholder: '卡片名称',
      defaultValue: defaultName ?? summary(values),
      validate: (v: string) => (v && v.trim() ? null : '请填个名字'),
    });
    if (!name) return;
    const card = addParamCard({ group, name, values });
    // 存完顺便套上，符合"存了就是要用"的预期
    patch(applyCardTo(d, card, keys));
    refresh();
  };

  const askRename = async (c: ParamCard) => {
    const next = await prompt({
      title: '重命名卡片',
      message: '只改卡片名字，已套用过的节点不受影响。',
      placeholder: '卡片名称',
      defaultValue: c.name,
      validate: (v: string) => (v && v.trim() ? null : '请填个名字'),
    });
    if (!next) return;
    renameParamCard(c.id, next);
    refresh();
  };

  const askRemove = async (c: ParamCard) => {
    const ok = await confirm({
      title: `删除卡片「${c.name}」？`,
      message: '只删这张卡片。已经套用过它的节点会变成「自定义」，值仍然保留。',
    });
    if (!ok) return;
    removeParamCard(c.id);
    // 若当前正套用着它，顺手脱钩，免得节点记着一个不存在的 id
    if (activeId === c.id) patch(detachGroup(d, group));
    refresh();
  };

  /** 在面板内按住 Ctrl 拖动也能复制（落点就在这一行里） */
  const onDropHere = (e: DragEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const p = decodeCardDrag(e.dataTransfer.getData(CARD_DRAG_MIME))
      ?? decodeCardDrag(e.dataTransfer.getData('text/plain'));
    if (!p || p.group !== group) return;
    e.preventDefault();
    e.stopPropagation();
    const copy = duplicateCard(p.cardId);
    refresh();
    if (copy) void alert({ title: '已复制卡片', message: `「${copy.name}」已添加到这一组。` });
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
            title={`${summary(c.values)}\n点一下套用；拖到画布节点上也能套用；按住 Ctrl 拖动复制`}
            draggable
            onDragStart={(e) => {
              const payload = encodeCardDrag({ cardId: c.id, group });
              e.dataTransfer.setData(CARD_DRAG_MIME, payload);
              // 同时放一份 text/plain，某些环境下自定义 MIME 会被过滤
              e.dataTransfer.setData('text/plain', payload);
              e.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <button
              className="pc-pick"
              onClick={() => onPick(c)}
              title={on ? '已套用这张卡片' : '套用这张卡片'}
            >
              <span className="pc-name">{c.name}</span>
              <span className="pc-sum">{summary(c.values)}</span>
            </button>
            <span className="pc-ops">
              <button className="pc-op" title="重命名" onClick={() => void askRename(c)}>✎</button>
              <button className="pc-op pc-del" title="删除卡片" onClick={() => void askRemove(c)}>×</button>
            </span>
          </span>
        );
      })}

      {/* 脱钩态：明确告诉用户"这份值不再跟随卡片" */}
      {detached && keys.length > 0 && String(d[keys[0]] ?? '').trim() !== '' ? (
        <span className="pc-card is-custom" title="这份值已改过，不再跟随卡片">
          <span className="pc-name">自定义</span>
        </span>
      ) : null}

      <button className="pc-add" onClick={() => void onSaveAs()} title="把当前这几个参数存成一张卡片">
        ＋
      </button>
      {activeId && activeExists ? (
        <button className="pc-detach" onClick={onDetach} title="不再跟随这张卡片（值保留在节点上）">
          脱钩
        </button>
      ) : null}
    </div>
  );
}
