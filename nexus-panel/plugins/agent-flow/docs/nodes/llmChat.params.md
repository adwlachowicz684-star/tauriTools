# llmChat — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/llmChat.tsx` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：AI 能力
- **node.type**：`llmChat`
- **源文件**：`nodes/defs/llmChat.tsx`
- **产出**：text（文本）　**接受**：text / files / any
- **需要的外部能力**：`imageReader`, `llmCaller`

## 它做什么

模型的回复文本

## 能力签名

- `imageReader`: `(path) => Promise<string>（data URL）`
- `llmCaller`: `({ url, headers, body, timeoutSec }) => Promise<{ status, text }>`

> `imageReader` 是**按需**的：只有满足特定条件时才需要（见参数页）。

共 16 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `use` | select | 用途 | — | — |
| `model` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `credentialId` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `llm` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `imageSource` | select | 图片来源 | — | ` → isOcr` |
| `url` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | `d → isOcr && (d.imageSource ?? 'url') === 'url'` |
| `path` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | `d → isOcr && d.imageSource === 'file'` |
| `detail` | select | 图片细节 | `auto` / `low` / `high` | ` → isOcr` |
| `targetLang` | chips | 目标语言；占位：如「简练的文言文」 | `动态（TARGET_LANGS.map）` | ` → isTrans` |
| `sourceLang` | text | 源语言；留空让模型自动判断；填了能减少误判（如「日语」）；占位：留空自动识别 | — | ` → isTrans` |
| `glossary` | textarea | 术语表（可选）；每行一条「原文=译文」，保证专有名词译法一致；占位：GPU=图形处理器\nTransformer=变换器 | — | ` → isTrans` |
| `system` | textarea | 角色提示词（system）；填了就以这里为准；没填且挂了窗格，则用窗格的角色设定；占位：留空用所属任务窗格那一份 | — | ` → isChat` |
| `prompt` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `temperature` | number | 温度；越低越稳定，越高越发散；占位：留空用窗格的，再没有则 0.3 | — | ` → isChat` |
| `maxTokens` | number | 最大输出 token；占位：留空不限制 | — | — |
| `jsonMode` | switch | 占位：要求结构化 JSON 输出 | — | — |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'llmChat' }` 会缺默认字段 ——
本控件尤其要注意 `llm` / `use` / `imageSource` / `url` / `path` / `detail` / `targetLang` / `sourceLang` / `glossary`，它不在面板字段里。
