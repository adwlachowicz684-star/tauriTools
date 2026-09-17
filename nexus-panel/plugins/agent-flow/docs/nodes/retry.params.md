# retry — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](retry.md) ｜ [← 回到索引](../README.md)

## 面板上的提示

> 上游**执行失败**时本节点不会运行（失败会沿边传播）。这里处理的是"跑成功了但内容不对"。

共 5 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `target` | text | 重试哪个节点；填要重跑的节点 id（卡片底部那行就是）；占位：节点 id，如 h1 | — | — |
| `times` | number | 最多重试几次 | — | — |
| `intervalMs` | number | 每次间隔；毫秒 | — | — |
| `check` | select | 合格条件；有内容就行 | `nonempty` / `contains` / `notContains` / `regex` | — |
| `value` | text | 比对值；占位：要包含的文本 / 正则表达式 | — | `d → d.check !== 'nonempty'` |

## 怎么用它

1. 从侧栏「控制器」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/retry.tsx` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'retry' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
