# condition — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/condition.ts` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：流程控制
- **node.type**：`condition`
- **源文件**：`nodes/defs/condition.ts`
- **产出**：mark（状态标记）　**接受**：any
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

分支标记文本（如「[条件] 走「是」」）—— 作用是分流，不转换数据

## 注意

- 产出是**状态标记**，插在链中间会截断上游数据。下游若要处理上游内容，改用 `{{上游id.output}}` 直接取。

共 3 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `rules` **必填** | — | 规则列表，从上到下判定，命中第一条即走对应分支。每条 = { id, label, op, value, source }；source 填上游节点 id，或 "input" 表示全局输入，空字符串表示拼接全部上游输出 | — | — |
| `defaultBranch` | — | 是否启用兜底分支。true 时所有规则都未命中则走 __default__ 边（分支 id 固定） | — | — |
| `op` | — | 算子。常用：nonEmpty / isEmpty / contains / notContains / equals / always | `nonEmpty` / `isEmpty` / `contains` / `notContains` / `equals` / `always` | — |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'condition' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
