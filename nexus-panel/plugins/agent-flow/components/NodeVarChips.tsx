import { varIdOf, findVar, getVariableGroup, type Variable } from '../engine/variables';

/**
 * 画布节点上的变量卡扣 —— 显示这个节点引用了哪些变量。
 *
 * ================= 三档显示 =================
 *
 *   简（sm）：不显示。次要节点、模块内部用这个，卡片上只留标题。
 *   标（md）：显示变量名。扫一眼就知道用的是哪个变量。
 *   详（lg）：显示变量的**内容**（各字段的值）。关键节点用这个。
 *
 * ================= 视觉 =================
 *
 * 「嵌进节点里的凹槽卡扣」：不是可点的按钮（点在画布上会误触发拖拽），
 * 只作状态指示。要切换变量去右侧属性面板。
 *
 * 详档的文本一律限制三行（CSS line-clamp）：
 * 变量值可能是整段脚本或一长串路径，不限制的话一个节点能把整张画布顶开。
 */

type Chip = {
  group: string;
  /** 引用被删掉 / 从未引用时的兜底文案 */
  fallback?: string;
};

/** 详档下把变量的各字段摊开成「键 = 值」几行 */
function detailRows(v: Variable): { k: string; text: string }[] {
  const gd = getVariableGroup(v.group);
  const keys = gd?.keys ?? Object.keys(v.values);
  const out: { k: string; text: string }[] = [];
  for (const k of keys) {
    const raw = v.values?.[k];
    if (raw === undefined || raw === null) continue;
    // 对象（如 llm 配置）摊成字符串，免得显示成 [object Object]
    const text = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (!text.trim()) continue;
    out.push({ k, text });
  }
  return out;
}

export function NodeVarChips({ data, groups, size = 'md' }: {
  data: unknown;
  groups: Chip[];
  /** 节点显示高度：简不显示 / 标显示名字 / 详显示内容 */
  size?: 'sm' | 'md' | 'lg';
}) {
  /* 简档一律不显示 —— 这一档就是要卡片上只剩标题 */
  if (size === 'sm') return null;

  const chips = groups
    .map(({ group, fallback }) => {
      const id = varIdOf(data, group);
      const v = findVar(id);
      if (v) return { key: group, v, on: true as const };
      // 没引用变量，但这一组的值是填了的 → 独立值
      const fb = fallback ?? '';
      return fb ? { key: group, v: null, on: false as const, fb } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (chips.length === 0) return null;

  return (
    <div className="node-chips">
      {chips.map((c) => {
        if (!c.on) {
          return (
            <span key={c.key} className="node-chip is-custom" title="独立值 —— 不跟随变量">
              {c.fb} · 独立
            </span>
          );
        }
        const rows = size === 'lg' ? detailRows(c.v) : [];
        return (
          <span
            key={c.key}
            className="node-chip on"
            title={rows.length ? rows.map((r) => `${r.k} = ${r.text}`).join('\n') : '引用了这个变量'}
          >
            <span className="node-chip-name">{c.v.name}</span>
            {rows.length > 0 ? (
              <span className="node-chip-detail">
                {rows.map((r) => (
                  <span key={r.k} className="node-chip-row">
                    <span className="node-chip-k">{r.k}</span>
                    <span className="node-chip-v">{r.text}</span>
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
