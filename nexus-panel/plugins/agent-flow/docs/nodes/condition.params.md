# condition — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](condition.md) ｜ [← 回到索引](../README.md)

共 3 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `rules` **必填** | — | 规则列表，从上到下判定，命中第一条即走对应分支。每条 = { id, label, op, value, source }；source 填上游节点 id，或 "input" 表示全局输入，空字符串表示拼接全部上游输出 | — | — |
| `defaultBranch` | — | 是否启用兜底分支。true 时所有规则都未命中则走 __default__ 边（分支 id 固定） | — | — |
| `op` | — | 算子。常用：nonEmpty / isEmpty / contains / notContains / equals / always | `nonEmpty` / `isEmpty` / `contains` / `notContains` / `equals` / `always` | — |

## 怎么用它

1. 从侧栏「流程控制」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/condition.ts` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'condition' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
