# github-push

> 自动生成，不要手改。源文件：`nodes/defs/github_push.tsx`

- **分类**：外部服务
- **node.type**：`github-push`
- **产出**：text（文本）
- **接受**：any
- **需要的外部能力**：`githubPush`

## 它做什么

推送结果说明

## 能力签名

- `githubPush`: `推送文件 => Promise<string>`

## 参数概览

共 8 项。完整表格与用法见 → [github-push.params.md](github-push.params.md)

- `owner`
- `repo`
- `branch`（分支）
- `message`（提交信息）
- `filesText`（文件（每行一条 路径=内容））
- `credentialId`
- `order`
- `workdir`（本地路径）

---

[← 回到索引](../README.md)
