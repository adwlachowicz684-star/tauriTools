# gate — 满足条件才放行下游

> 自动生成，不要手改。源文件：`nodes/defs/gate.tsx`

- **分类**：控制器
- **node.type**：`gate`
- **产出**：any（透传上游）
- **接受**：any
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

透传上游；条件不满足时阻断或等待

## 参数概览

共 6 项。完整表格与用法见 → [gate.params.md](gate.params.md)

- `mode`（判定方式）
- `check`（条件）
- `value`（比对值）
- `timeoutMs`（最长等待）
- `pollMs`（轮询间隔）
- `onTimeout`（超时后）

---

[← 回到索引](../README.md)
