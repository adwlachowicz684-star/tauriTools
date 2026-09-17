# generic-http — 填地址与参数即可调任意接口

> 自动生成，不要手改。源文件：`nodes/defs/genericHttp.tsx`

- **分类**：外部服务
- **node.type**：`generic-http`
- **产出**：json（JSON）
- **接受**：any
- **需要的外部能力**：`httpRequester`

## 它做什么

HTTP 响应正文

## 能力签名

- `httpRequester`: `(url, { method, headers, body, timeoutSec, maxBytes }) => Promise<{ status, ok, text, headers }>`

## 参数概览

共 7 项。完整表格与用法见 → [generic-http.params.md](generic-http.params.md)

- `headersText`（请求头）
- `body`（请求体）
- `bodyIsJson`
- `credentialId`
- `timeoutSec`（超时（秒））
- `maxBytesKb`（响应上限（KB））
- `failOnHttpError`

---

[← 回到索引](../README.md)
