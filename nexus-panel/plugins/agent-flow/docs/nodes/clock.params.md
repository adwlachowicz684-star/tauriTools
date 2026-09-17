# clock — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](clock.md) ｜ [← 回到索引](../README.md)

## 面板上的提示

> 占位符：YYYY 年 · MM 月 · DD 日 · HH 时 · mm 分 · ss 秒 · SSS 毫秒。其它字符原样保留。

共 1 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `format` | text | 格式；占位：YYYY-MM-DD HH:mm:ss | — | — |

## 怎么用它

1. 从侧栏「工具」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/clock.ts` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

产出是文本，可以：
- 直接给下游用（`{{clock节点id.output}}`）
- 接「condition」节点做判断

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'clock' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
