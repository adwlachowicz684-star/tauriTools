import { useState } from 'react';
import { prompt, confirm } from '../../../../js/dialog.js';
import {
  cardsOfGroup, addParamCard, removeParamCard, renameParamCard,
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
 */

type Props = {
  group: string;
  /** 这张卡片管辖的字段名 */
  keys: string[];
  /** 卡片上显示的摘要，如 "acme/web" */
  summary: (values: Record<string, unknown>) => string;
  /** 当前节点 data */
  d: Record<string, unknown>;
  /** 写入节点（可含多个字段） */
  patch: (p: Record<string, unknown>) => void;
  /** 新建卡片时的默认名字 */
  defaultName?: string;
};

export function ParamCardPicker({ group, keys, summary, d, patch, defaultName }: Props) {
  /*
   * 卡片存在 localStorage 里，增删改之后要重新读。
   * 用本地计数触发重渲染即可 —— 列表本来就是每次渲染现读的。
   */
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

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
      await confirm({
        title: '还没有填内容',
        message: `先在上面填好${defaultName ?? '这些参数'}，再存成卡片。`,
        cancel: false,
      } as never);
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

  return (
    <div className="pc-row">
      {cards.map((c) => {
        const on = c.id === activeId;
        return (
          <span key={c.id} className={`pc-card${on ? ' on' : ''}`} title={summary(c.values)}>
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
      {detached && (d[keys[0]] !== undefined && String(d[keys[0]] ?? '').trim() !== '') ? (
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
