# retry — 上游内容不合格就重跑它

> 自动生成，不要手改。源文件：`nodes/defs/retry.tsx`

- **分类**：控制器
- **node.type**：`retry`
- **产出**：any（透传上游）
- **接受**：any
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

透传上游；上游内容不合格时重跑它

## 参数概览

共 5 项。完整表格与用法见 → [retry.params.md](retry.params.md)

- `target`（重试哪个节点）
- `times`（最多重试几次）
- `intervalMs`（每次间隔）
- `check`（合格条件）
- `value`（比对值）

---

[← 回到索引](../README.md)
