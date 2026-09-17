# ocr

> 自动生成，不要手改。源文件：`nodes/defs/ocr.tsx`

- **分类**：AI 能力
- **node.type**：`ocr`
- **产出**：text（文本）
- **接受**：text / files / any
- **需要的外部能力**：`imageReader`, `llmCaller`

## 它做什么

图片识别出的文字

## 能力签名

- `imageReader`: `(path) => Promise<string>（data URL）`
- `llmCaller`: `({ url, headers, body, timeoutSec }) => Promise<{ status, text }>`

> `imageReader` 是**按需**的：只有在满足特定条件时才需要（见参数页）。

## 参数概览

共 7 项。完整表格与用法见 → [ocr.params.md](ocr.params.md)

- `imageSource`（图片来源）
- `url`
- `credentialId`
- `path`
- `prompt`（识别要求）
- `detail`（图片细节）
- `llm`

---

[← 回到索引](../README.md)
