# gate — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](gate.md) ｜ [← 回到索引](../README.md)

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

## 怎么用它

1. 从侧栏「控制器」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/gate.tsx` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'gate' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
