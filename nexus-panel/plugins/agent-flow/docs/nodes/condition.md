# condition

> 自动生成，不要手改。源文件：`nodes/defs/condition.ts`

- **分类**：流程控制
- **node.type**：`condition`
- **产出**：mark（状态标记）
- **接受**：any
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

分支标记文本（如「[条件] 走「是」」）—— 作用是分流，不转换数据

## 注意

- 产出是**状态标记**，插在链中间会截断上游数据。下游若要处理上游内容，改用 `{{上游id.output}}` 直接取。

## 参数概览

共 3 项。完整表格与用法见 → [condition.params.md](condition.params.md)

- `rules`
- `defaultBranch`
- `op`

---

[← 回到索引](../README.md)
