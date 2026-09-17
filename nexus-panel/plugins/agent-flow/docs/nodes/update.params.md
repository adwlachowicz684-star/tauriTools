# update — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](update.md) ｜ [← 回到索引](../README.md)

共 1 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `source` | 隐藏（不在面板字段里） | 数据源。由节点类型决定（bili 与 wechat 两个 type 共用一份 update data），建节点时用对应的 def.create() | `bilibili` / `wechat` | — |

## 怎么用它

1. 从侧栏「外部服务」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/bili.ts` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'update' }` 会缺默认字段 ——
本控件尤其要注意 `source`，它不在面板字段里。
