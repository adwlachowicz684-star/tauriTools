# github-update — 在「凭据」里填一次令牌，两个节点共用

> 自动生成，不要手改。源文件：`nodes/defs/github_update.tsx`

- **分类**：外部服务
- **node.type**：`github-update`
- **产出**：json（JSON）
- **接受**：none
- **需要的外部能力**：`githubFetch`

## 它做什么

仓库最新信息（JSON）

## 能力签名

- `githubFetch`: `抓取仓库信息 => Promise<信息对象>`

## 注意

- 它**不需要输入**（`接受 = none`），通常作为链的起点。

## 参数概览

共 4 项。完整表格与用法见 → [github-update.params.md](github-update.params.md)

- `branch`（分支）
- `base`（基准）
- `credentialId`
- `order`

---

[← 回到索引](../README.md)
