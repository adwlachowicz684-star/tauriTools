# throttle — 控制放行的节奏

> 自动生成，不要手改。源文件：`nodes/defs/throttle.tsx`

- **分类**：控制器
- **node.type**：`throttle`
- **产出**：any（透传上游）
- **接受**：any
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

透传上游；按间隔与次数限制放行节奏

## 参数概览

共 2 项。完整表格与用法见 → [throttle.params.md](throttle.params.md)

- `minIntervalMs`（最小间隔）
- `maxPerRun`（本次最多放行）

---

[← 回到索引](../README.md)
