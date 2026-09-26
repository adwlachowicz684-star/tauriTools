import type { FlowNode } from '../../flowTypes';
import {
  CONST_TYPE_LABEL, constsOf, newConstId, normBoolText,
  type ConstNodeData, type ConstItem, type ConstValueType,
} from '../../types';

/**
 * 常量节点的面板：一**张卡**一个常量。
 *
 * ================= 为什么整份 items 一起写 =================
 *
 * 用点号路径（items.0.value）写的话，setInPath 会**凭空建出一个对象** ——
 * 里面没有 id。卡片渲染时拿不到稳定的 key，连线（按 id 记的）也就跟着漂。
 *
 * 所以任何改动都写整份数组。items 是唯一的数据源，
 * 不需要再往顶层 value / valueType 镜像一份（那份已经删了）。
 */

const KINDS: ConstValueType[] = ['text', 'num', 'bool'];

export function ConstInspector({ node, onChange }: {
  node: FlowNode;
  onChange: (id: string, patch: Record<string, unknown>) => void;
}) {
  const d = node.data as ConstNodeData;
  const list = constsOf(d);

  const writeAll = (next: ConstItem[]) => onChange(node.id, { items: next });

  const patchAt = (i: number, part: Partial<ConstItem>) =>
    writeAll(list.map((t, j) => (j === i ? { ...t, ...part } : t)));

  const add = () => writeAll([...list, {
    id: newConstId(),
    name: '',
    valueType: 'text',
    value: '',
  }]);

  const removeAt = (i: number) => writeAll(list.filter((_, j) => j !== i));

  return (
    <>
      <div className="trig-cards">
        {list.map((t, i) => {
          const vt: ConstValueType = t.valueType ?? 'text';
          return (
            <div className="trig-card upd-card" key={t.id || `c${i}`}>
              <div className="upd-card-head">
                <span className="upd-icon">📌</span>
                <input
                  className="p-input upd-name-input"
                  value={t.name ?? ''}
                  placeholder={`常量${i + 1}`}
                  title="卡名即输出端口名，也是 {{节点id.卡名}} 引用的名字"
                  onChange={(e) => patchAt(i, { name: e.target.value })}
                />
                <span className="task-grow" />
                {list.length > 1 ? (
                  <button
                    type="button"
                    className="insp-size-btn"
                    title="删掉这一张（其余不受影响）"
                    onClick={() => removeAt(i)}
                  >
                    删除
                  </button>
                ) : null}
              </div>

              <label className="p-row">
                <span className="p-muted" style={{ width: 64, flex: 'none' }}>种类</span>
                <select
                  className="p-input"
                  value={vt}
                  onChange={(e) => patchAt(i, { valueType: e.target.value as ConstValueType })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{CONST_TYPE_LABEL[k]}</option>
                  ))}
                </select>
              </label>

              {vt === 'bool' ? (
                <label className="p-row">
                  <span className="p-muted" style={{ width: 64, flex: 'none' }}>值</span>
                  <select
                    className="p-input"
                    /* 与卡片显示共用同一份规范化 —— 各判一次的话，
                       卡片上写着「假」、面板里却选着「真」 */
                    value={normBoolText(t.value)}
                    onChange={(e) => patchAt(i, { value: e.target.value })}
                  >
                    <option value="true">真（true）</option>
                    <option value="false">假（false）</option>
                  </select>
                </label>
              ) : vt === 'num' ? (
                <label className="p-row">
                  <span className="p-muted" style={{ width: 64, flex: 'none' }}>值</span>
                  <input
                    className="p-input"
                    value={t.value ?? ''}
                    placeholder="如 42；也支持 {{模板变量}}"
                    onChange={(e) => patchAt(i, { value: e.target.value })}
                  />
                </label>
              ) : (
                <label className="p-col">
                  <span className="p-muted">值（支持模板）</span>
                  <textarea
                    className="p-input"
                    rows={4}
                    value={t.value ?? ''}
                    placeholder="原样输出给下游；支持 {{模板变量}}"
                    onChange={(e) => patchAt(i, { value: e.target.value })}
                  />
                </label>
              )}
            </div>
          );
        })}
      </div>

      <button type="button" className="insp-size-btn" onClick={add}>
        ＋ 加一个常量
      </button>
      <div className="p-muted upd-hint">
        每张卡各带一个输出端口 —— 把「阈值」接到「大于」上、「价格」接到写入节点上，不用摆多个常量节点。
      </div>
    </>
  );
}
