# compare — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/compare.ts` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：运算
- **node.type**：`compare`
- **源文件**：`nodes/defs/compare.ts`
- **产出**：text（文本）　**接受**：any
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

比较结果 'true' / 'false'

## 面板上的提示

> 两边都能转成数字时按数字比（否则 "10" 会小于 "9"），否则按文本比。输出 true / false。

共 3 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `op` | select | 比较 | `eq` / `neq` / `gt` / `gte` / `lt` / `lte` / `contains` / `startsWith` / `endsWith` | — |
| `a` | text | 左边；占位：支持 {{上游.output}} | — | — |
| `b` | text | 右边；占位：要比较的值 | — | — |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'compare' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
