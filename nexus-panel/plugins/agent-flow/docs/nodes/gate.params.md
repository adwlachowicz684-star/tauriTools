# gate — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/gate.tsx` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：控制器
- **node.type**：`gate`
- **源文件**：`nodes/defs/gate.tsx`
- **产出**：any（透传上游）　**接受**：any
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

透传上游；条件不满足时阻断或等待

## 面板上的提示

> 等待模式在循环体里最有用 —— 每轮进来都会重新判定一次上游输出。

共 6 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `mode` | select | 判定方式；轮询到满足为止，超时按下面配置处理 | `wait` / `now` | — |
| `check` | select | 条件；有内容就行 | `nonempty` / `contains` / `notContains` / `regex` | — |
| `value` | text | 比对值；占位：要包含的文本 / 正则表达式 | — | `d → d.check !== 'nonempty'` |
| `timeoutMs` | number | 最长等待；毫秒 | — | `d → d.mode === 'wait'` |
| `pollMs` | number | 轮询间隔；毫秒 | — | `d → d.mode === 'wait'` |
| `onTimeout` | select | 超时后；阻断下游 | `fail` / `pass` | `d → d.mode === 'wait'` |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'gate' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
