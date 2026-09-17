# extract — JSON 路径 / 正则 / 按行

> 自动生成，不要手改。源文件：`nodes/defs/extract.tsx`

- **分类**：文件与数据
- **node.type**：`extract`
- **产出**：text（文本）
- **接受**：text / json
- **需要的外部能力**：无（纯本地，浏览器模式也能跑）

## 它做什么

从上游文本里提取出的值

## 注意

- 它只接受 text / json 类型的数据，其余类型接上去会被告警。

## 参数概览

共 5 项。完整表格与用法见 → [extract.params.md](extract.params.md)

- `mode`（提取方式）
- `spec`
- `group`（第几个捕获组）
- `trim`
- `failOnMiss`

---

[← 回到索引](../README.md)
