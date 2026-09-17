# translate — 需填自己的大模型 API Key

> 自动生成，不要手改。源文件：`nodes/defs/translate.tsx`

- **分类**：AI 能力
- **node.type**：`translate`
- **产出**：text（文本）
- **接受**：text
- **需要的外部能力**：`llmCaller`

## 它做什么

翻译后的文本

## 能力签名

- `llmCaller`: `({ url, headers, body, timeoutSec }) => Promise<{ status, text }>`

## 注意

- 它只接受 text 类型的数据，其余类型接上去会被告警。

## 参数概览

共 6 项。完整表格与用法见 → [translate.params.md](translate.params.md)

- `sourceLang`（源语言）
- `targetLang`（目标语言）
- `credentialId`
- `text`
- `glossary`（术语表（可选））
- `llm`

---

[← 回到索引](../README.md)
