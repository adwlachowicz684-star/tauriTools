# extract — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](extract.md) ｜ [← 回到索引](../README.md)

## 面板上的提示

> 把上游的一大段文本（典型是 HTTP 响应）裁成一条值，供条件节点判断或下游引用。

共 5 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `mode` | select | 提取方式 | — | — |
| `spec` | text | — | — | `d → d.mode !== 'text'` |
| `group` | number | 第几个捕获组；0 取整段匹配，1 取第一个括号 | — | `d → d.mode === 'regex'` |
| `trim` | switch | 占位：去掉首尾空白 | — | — |
| `failOnMiss` | switch | 关掉则输出空串、流程继续（原因仍记在日志里）；占位：取不到就失败 | — | — |

## 怎么用它

1. 从侧栏「文件与数据」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/extract.tsx` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

产出是文本，可以：
- 直接给下游用（`{{extract节点id.output}}`）
- 接「condition」节点做判断

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'extract' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
