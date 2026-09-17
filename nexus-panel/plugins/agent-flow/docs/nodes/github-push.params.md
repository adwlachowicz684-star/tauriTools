# github-push — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/github_push.tsx` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：外部服务
- **node.type**：`github-push`
- **源文件**：`nodes/defs/github_push.tsx`
- **产出**：text（文本）　**接受**：any
- **需要的外部能力**：`githubPush`

## 它做什么

推送结果说明

## 能力签名

- `githubPush`: `推送文件 => Promise<string>`

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

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'github-push' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
