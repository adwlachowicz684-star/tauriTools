# fs

> 自动生成，不要手改。源文件：`nodes/defs/fs.ts`

- **分类**：文件与数据
- **node.type**：`fs`
- **产出**：files（文件列表）
- **接受**：any
- **需要的外部能力**：`fsExecutor`

## 它做什么

文件引用列表（下游按文件处理）

## 能力签名

- `fsExecutor`: `(node, { path, target, content }) => Promise<string>`

## 参数概览

共 8 项。完整表格与用法见 → [fs.params.md](fs.params.md)

- `op`（操作）
- `path`（路径）
- `target`（目标路径）
- `content`（内容）
- `maxBytes`（最大读取字节）
- `recursive`
- `exts`（只保留这些后缀（逗号分隔，留空=全部））
- `dryRun`

---

[← 回到索引](../README.md)
