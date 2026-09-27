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

共 4 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `triggers` **必填** | — | 触发方式列表（可以同时挂多种，任一满足即触发）。写单个字符串与写单元素数组等价 | `manual` / `interval` / `cron` / `watch` / `webhook` / `chat` | — |
| `config` | — | 各类触发方式的配置，按 kind 取对应字段，未用到的留默认即可：intervalSec（interval，最小 10）/ cronExpr（cron，五段表达式）/ watchDir + watchExts + 防抖（watch）/ 端口与路径（webhook） | — | — |
| `input` | — | 手动触发时的初始文本（其余方式由事件内容填入） | — | — |
| `enabled` | — | 是否启用；false 时该触发器不参与任何触发判定 | — | — |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'trigger' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
