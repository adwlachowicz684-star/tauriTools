# translate — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/translate.tsx` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：AI 能力
- **node.type**：`translate`
- **源文件**：`nodes/defs/translate.tsx`
- **产出**：text（文本）　**接受**：text
- **需要的外部能力**：`llmCaller`

## 它做什么

翻译后的文本

## 能力签名

- `llmCaller`: `({ url, headers, body, timeoutSec }) => Promise<{ status, text }>`

## 注意

- 它只接受 text，其余类型接上去会被告警。

共 6 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `sourceLang` | text | 源语言；留空让模型自动判断；填了能减少误判（如「日语」）；占位：留空自动识别 | — | — |
| `targetLang` | chips | 目标语言；占位：如「简练的文言文」 | `动态（TARGET_LANGS.map）` | `d → !TARGET_LANGS.some((l) => l.code === d.targetLang)` |
| `credentialId` | credential | — | — | — |
| `text` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `glossary` | textarea | 术语表（可选）；每行一条「原文=译文」，保证专有名词译法一致；占位：GPU=图形处理器\nTransformer=变换器 | — | — |
| `llm` | 隐藏（不在面板字段里） | 大模型配置 { url, model, apiKey, timeoutSec }。由 llm-config 卡片组提供，建节点时 def.create() 会填默认值 | — | — |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'translate' }` 会缺默认字段 ——
本控件尤其要注意 `llm`，它不在面板字段里。
