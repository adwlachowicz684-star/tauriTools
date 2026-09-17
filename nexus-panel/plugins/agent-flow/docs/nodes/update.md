# update

> 自动生成，不要手改。源文件：`nodes/defs/bili.ts`

- **分类**：外部服务
- **node.type**：`bili` / `wechat`（多个 type 共用一份 data）
- **产出**：bool（是/否）
- **接受**：none
- **需要的外部能力**：`fetcher`

## 它做什么

是否有更新（true / false）—— 给条件节点判断

## 能力签名

- `fetcher`: `(node, url, { headers, timeoutSec }) => Promise<string>`

## 注意

- 它**不需要输入**（`接受 = none`），通常作为链的起点。

## 参数概览

共 1 项。完整表格与用法见 → [update.params.md](update.params.md)

- `source`

---

[← 回到索引](../README.md)
