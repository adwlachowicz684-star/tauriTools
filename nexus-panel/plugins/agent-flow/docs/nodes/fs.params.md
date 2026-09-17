# fs — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](fs.md) ｜ [← 回到索引](../README.md)

## 面板上的提示

> 这个操作会改动磁盘上的文件，请确认路径无误。

共 8 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `op` | select | 操作 | — | — |
| `path` | text | 路径；支持模板变量，如 {{upstream.output}} / {{loop.item}}；占位：/abs/or/relative/path | — | — |
| `target` | text | 目标路径；占位：/path/to/dest | — | `d → Boolean(FS_OP_META[d.op as FsOp]?.needsTarget)` |
| `content` | textarea | 内容；占位：写入的内容，支持 {{模板变量}} | — | `d → Boolean(FS_OP_META[d.op as FsOp]?.needsContent)` |
| `maxBytes` | number | 最大读取字节；超出会截断，0 表示不限制 | — | `d → d.op === 'read'` |
| `recursive` | switch | 占位：递归子目录 | — | `d → d.op === 'list'` |
| `exts` | text | 只保留这些后缀（逗号分隔，留空=全部）；占位：ts,tsx,md | — | `d → d.op === 'list'` |
| `dryRun` | switch | 占位：演练模式（不会真正改动磁盘） | — | — |

## 怎么用它

1. 从侧栏「文件与数据」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/fs.ts` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'fs' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
