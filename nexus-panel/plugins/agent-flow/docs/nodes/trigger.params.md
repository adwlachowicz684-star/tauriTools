# trigger — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/trigger.ts` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：触发器（起点）
- **node.type**：`trigger`
- **源文件**：`nodes/defs/trigger.ts`
- **产出**：text（文本）　**接受**：none
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

流程的初始输入（手动文本 / 触发带来的内容）

## 注意

- 它**不需要输入**（`接受 = none`），通常作为链的起点。

共 2 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `mode` **必填** | — | 触发方式 | `manual` / `interval` / `cron` / `watch` / `webhook` / `conversation` | — |
| `enabled` | — | 是否启用 | — | — |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'trigger' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
