# translate — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](translate.md) ｜ [← 回到索引](../README.md)

共 6 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `sourceLang` | text | 源语言；留空让模型自动判断；填了能减少误判（如「日语」）；占位：留空自动识别 | — | — |
| `targetLang` | chips | 目标语言；占位：如「简练的文言文」 | — | `d → !TARGET_LANGS.some((l) => l.code === d.targetLang)` |
| `credentialId` | credential | — | — | — |
| `text` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `glossary` | textarea | 术语表（可选）；每行一条「原文=译文」，保证专有名词译法一致；占位：GPU=图形处理器\nTransformer=变换器 | — | — |
| `llm` | 隐藏（不在面板字段里） | 大模型配置 { url, model, apiKey, timeoutSec }。由 llm-config 卡片组提供，建节点时 def.create() 会填默认值 | — | — |

## 怎么用它

1. 从侧栏「AI 能力」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/translate.tsx` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

产出是文本，可以：
- 直接给下游用（`{{translate节点id.output}}`）
- 接「condition」节点做判断

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'translate' }` 会缺默认字段 ——
本控件尤其要注意 `llm`，它不在面板字段里。
