# github-push — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](github-push.md) ｜ [← 回到索引](../README.md)

共 8 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `owner` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `repo` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `branch` | text | 分支；占位：main | — | — |
| `message` | text | 提交信息；占位：支持 {{上游.output}} | — | — |
| `filesText` | textarea | 文件（每行一条 路径=内容）；占位：README.md=# 标题\nnotes/{{date}}.txt={{上游.output}} | — | — |
| `credentialId` | credential | — | — | — |
| `order` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `workdir` | text | 本地路径；占位：仅 git 方案需要 | — | — |

## 怎么用它

1. 从侧栏「外部服务」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/github_push.tsx` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

产出是文本，可以：
- 直接给下游用（`{{github-push节点id.output}}`）
- 接「condition」节点做判断

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'github-push' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
