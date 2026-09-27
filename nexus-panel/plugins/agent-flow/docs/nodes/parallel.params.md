# parallel — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/parallel.ts` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：流程控制
- **node.type**：`parallel`
- **源文件**：`nodes/defs/parallel.ts`
- **产出**：any（透传上游）　**接受**：any
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

透传

共 4 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `mode` **必填** | — | 并发模式：fixed = 固定并发数；byRule = 按条件规则从上到下第一条命中的决定；all = 不限制，全部并行 | `fixed` / `byRule` / `all` | — |
| `concurrency` | — | fixed 模式下的并发度（同时跑几个） | — | — |
| `rules` | — | byRule 模式的规则列表，从上到下判定、第一条命中即用其并发数。每条 = { id, op, value, concurrency, label? }；op 与条件节点同一套算子。mode 为 byRule 时必填，否则并发数无从决定 | — | — |
| `fallbackConcurrency` | — | byRule 模式下所有规则都没命中时用的并发数 | — | — |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'parallel' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
