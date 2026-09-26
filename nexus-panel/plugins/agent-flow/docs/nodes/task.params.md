# task — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/task.tsx` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：任务
- **node.type**：`task`
- **源文件**：`nodes/defs/task.tsx`
- **产出**：text（文本）　**接受**：any
- **需要的外部能力**：`executor`

## 它做什么

CLI 的执行输出

## 能力签名

- `executor`: `(node, rendered, onChunk) => Promise<string>（CLI 的完整输出）`

共 6 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `cli` | select | 使用 CLI | — | — |
| `prompt` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `model` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | — |
| `workdir` | text | 工作目录；占位：留空用当前目录 | — | — |
| `yolo` | switch | 省去每次确认，但 CLI 会直接改文件；占位：自动批准工具调用（-y） | — | — |
| `zzz` | 隐藏（不在面板字段里） | 所属任务窗格（taskPane）的 id。留空 = 不挂窗格。挂了之后：节点上填了的项优先，没填的从窗格继承（工作目录 / 默认连接 / 模型 / 自动批准） —— 窗格改一次，整组跟着变。由 paneField 卡片组提供。 | — | — |

## 具名输出（除「结论」外还能取到什么）

用 `{{节点id.字段名}}` 取，或直接从卡片上对应的那个出口拖线。

| 字段名 | 显示名 | 值种类 |
|---|---|---|
| `file` | 文件路径 | text |
| `files` | 全部路径 | text |
| `fileRel` | 原始路径 | text |
| `fileName` | 文件名 | text |
| `fileNames` | 全部文件名 | text |
| `fileDir` | 所在目录 | text |
| `fileExt` | 扩展名 | text |
| `fileCount` | 文件数 | num |


## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'task' }` 会缺默认字段 ——
本控件尤其要注意 `zzz`，它不在面板字段里。
