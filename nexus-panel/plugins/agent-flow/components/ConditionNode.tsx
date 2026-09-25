import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  DEFAULT_BRANCH, OP_META, ruleConditions,
  type ConditionNodeData, type ConditionOp,
} from '../types';
import type { CondFlowNode } from '../flowTypes';
import { describeRule } from '../engine/condition';
import { NodeShell } from './NodeShell';
import { ArgLine } from './ArgCell';
import type { BriefPart } from '../engine/ops';

/**
 * 算子的可选项 —— 取自 OP_META，不在卡片上另抄一份。
 *
 * 条件节点没有走 registry 的 fields（面板是 ConditionInspector 手写的），
 * 所以选项在这里显式给出；但**标签仍来自 OP_META**，
 * 与面板、与下面算子徽章用的是同一份。
 */
const OP_OPTS = (Object.keys(OP_META) as ConditionOp[]).map((k) => ({
  value: k,
  label: OP_META[k].label,
}));

export default function ConditionNode({ id, data, selected }: NodeProps<CondFlowNode>) {
  const d: ConditionNodeData = data;
  const rules = d.rules ?? [];

  return (
    <NodeShell
      id={id}
      type="condition"
      data={d}
      selected={selected}
      className="cond"
      tag="条件分支 · 不调用 CLI"
      footExtra={<span className="node-line--foot">菱形决策</span>}
      /*
       * 出口是每条规则各一个（分支手柄在 children 里逐个渲染），
       * 不是统一的一个右侧出口，所以关掉外壳默认那个。
       */
      hasSource={false}
    >
      <div className="cond-rules">
        {rules.length === 0 && <div className="nx-empty cond-empty">未配置规则</div>}
        {rules.map((r, i) => {
          /*
           * 多条件规则**不给就地编辑**。
           *
           * 多条件时值在 `rules[i].conditions[j].value`，而卡片上改的是
           * `rules[i].value` —— 写进去对显示毫无影响（ruleConditions 优先取
           * conditions），表现为"改了一下，卡片纹丝不动"，而值确实存进去了。
           * 这种"改了没反应还看不出为什么"正是就地编辑最忌讳的，
           * 所以多条件留给面板里那条专用的表达式编辑器。
           */
          const multi = (r.conditions ?? []).length > 0;
          const conds = ruleConditions(r);
          const c = conds[0] ?? r;
          const meta = OP_META[c.op as ConditionOp];
          const needsValue = meta?.needsValue !== false;

          const parts: BriefPart[] = multi
            ? [{ role: 'text', text: describeRule(r) }]
            : [
                ...(c.source ? [{ role: 'text' as const, text: `${c.source} ` }] : []),
                {
                  role: 'op',
                  text: meta?.label ?? String(c.op),
                  key: 'op',
                  raw: String(c.op ?? ''),
                  edit: { key: 'op', kind: 'select', path: `rules.${i}.op`, options: OP_OPTS },
                },
                ...(needsValue
                  ? [
                      { role: 'text' as const, text: '「' },
                      {
                        role: 'val' as const,
                        text: String(c.value ?? '') || '（空）',
                        key: 'value',
                        raw: String(c.value ?? ''),
                        edit: { key: 'value', kind: 'text' as const, path: `rules.${i}.value` },
                      },
                      { role: 'text' as const, text: '」' },
                    ]
                  : []),
              ];

          return (
            <div key={r.id} className="cond-rule">
              <Handle
                type="source"
                position={Position.Right}
                id={r.id}
                style={{ top: 'auto' }}
                className="branch-handle"
              />
              {/*
                算子徽章只留图标 + 配色：算子的**名字与改法**交给右边的
                参数格，两边都写一遍的话卡片上会出现两个「包含」。
                图标仍按分类配色，扫一眼就能分辨是哪种判定。
              */}
              <span
                className="cond-op"
                style={{ borderColor: OP_META[r.op]?.color, color: OP_META[r.op]?.color }}
                title={`${OP_META[r.op]?.label ?? r.op} —— ${OP_META[r.op]?.hint ?? ''}`}
              >
                <span className="cond-op-icon">{OP_META[r.op]?.icon ?? '?'}</span>
              </span>
              <ArgLine
                nodeId={id}
                type="condition"
                data={d as unknown as Record<string, unknown>}
                className="cond-text"
                parts={parts}
              />
            </div>
          );
        })}
        {d.defaultBranch && (
          <div className="cond-rule is-default">
            <Handle
              type="source"
              position={Position.Right}
              id={DEFAULT_BRANCH}
              className="branch-handle"
            />
            <span className="cond-op">兜底</span>
            <span className="cond-text">以上都不满足</span>
          </div>
        )}
      </div>
    </NodeShell>
  );
}
