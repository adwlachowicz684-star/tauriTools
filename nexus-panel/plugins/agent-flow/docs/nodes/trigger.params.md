# trigger — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](trigger.md) ｜ [← 回到索引](../README.md)

共 2 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `mode` **必填** | — | 触发方式 | `manual` / `interval` / `cron` / `watch` / `webhook` / `conversation` | — |
| `enabled` | — | 是否启用 | — | — |

## 怎么用它

1. 从侧栏「触发器（起点）」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/trigger.ts` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

产出是文本，可以：
- 直接给下游用（`{{trigger节点id.output}}`）
- 接「condition」节点做判断

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'trigger' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
