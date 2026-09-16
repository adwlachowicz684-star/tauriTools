import { cardIdOf, findCard } from '../engine/paramCards';

/**
 * 画布节点上的参数卡扣 —— 显示这个节点套用了哪些参数卡片。
 *
 * 视觉上是「嵌进节点里的凹槽卡扣」：不是可点的按钮（点在画布上会误触发拖拽），
 * 只作状态指示，让扫一眼就知道这个节点用的是哪张卡片、还是改过的自定义值。
 * 要切换卡片去右侧属性面板。
 */

type Chip = {
  group: string;
  /** 卡片被删掉 / 从未套用时的兜底文案 */
  fallback?: string;
};

export function NodeCardChips({ data, groups }: { data: unknown; groups: Chip[] }) {
  const chips = groups
    .map(({ group, fallback }) => {
      const id = cardIdOf(data, group);
      const card = findCard(id);
      if (card) return { key: group, text: card.name, on: true };
      // 没套卡片，但这一组的值是填了的 → 自定义
      const fb = fallback ?? '';
      return fb ? { key: group, text: `${fb} · 自定义`, on: false } : null;
    })
    .filter((x): x is { key: string; text: string; on: boolean } => x !== null);

  if (chips.length === 0) return null;

  return (
    <div className="node-chips">
      {chips.map((c) => (
        <span
          key={c.key}
          className={`node-chip${c.on ? ' on' : ' is-custom'}`}
          title={c.on ? '套用了参数卡片' : '已改过，不跟随卡片'}
        >
          {c.text}
        </span>
      ))}
    </div>
  );
}
