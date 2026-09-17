# github-update — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](github-update.md) ｜ [← 回到索引](../README.md)

## 面板上的提示

> 输出 true / false，条件节点判断「等于 true」即可分流。

共 4 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `branch` | text | 分支；占位：留空用默认分支 | — | — |
| `base` | text | 基准；填了会与本地 HEAD 比对，只关心"本地是否落后"时很有用；占位：本地 HEAD，留空则只取远端状态 | — | — |
| `credentialId` | credential | — | — | — |
| `order` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |

## 怎么用它

1. 从侧栏「外部服务」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/github_update.tsx` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

产出是JSON，可以：
- 直接给下游用（`{{github-update节点id.output}}`）
- 接「extract」节点按 JSON 路径取值
- 接「condition」节点做判断

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'github-update' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
