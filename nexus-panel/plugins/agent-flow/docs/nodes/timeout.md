# timeout — 整条流程超预算就断在这里

> 自动生成，不要手改。源文件：`nodes/defs/timeout.tsx`

- **分类**：控制器
- **node.type**：`timeout`
- **产出**：any（透传上游）
- **接受**：any
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

透传上游；整条流程超预算时中断

## 参数概览

共 2 项。完整表格与用法见 → [timeout.params.md](timeout.params.md)

- `budgetMs`（预算）
- `onExceed`（超预算时）

---

[← 回到索引](../README.md)
