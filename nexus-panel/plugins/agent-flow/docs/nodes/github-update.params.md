# github-update — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/github_update.tsx` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：外部服务
- **node.type**：`github-update`
- **源文件**：`nodes/defs/github_update.tsx`
- **产出**：json（JSON）　**接受**：none
- **需要的外部能力**：`githubFetch`

## 它做什么

仓库最新信息（JSON）

## 能力签名

- `githubFetch`: `抓取仓库信息 => Promise<信息对象>`

## 注意

- 它**不需要输入**（`接受 = none`），通常作为链的起点。

## 面板上的提示

> 输出 true / false，条件节点判断「等于 true」即可分流。

共 4 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `branch` | text | 分支；占位：留空用默认分支 | — | — |
| `base` | text | 基准；填了会与本地 HEAD 比对，只关心"本地是否落后"时很有用；占位：本地 HEAD，留空则只取远端状态 | — | — |
| `credentialId` | credential | — | — | — |
| `order` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'github-update' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
