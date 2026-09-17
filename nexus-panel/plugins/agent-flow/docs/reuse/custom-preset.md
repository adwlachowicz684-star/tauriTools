# 自定义节点预设 — 一个配好的节点

> 自动生成，不要手改。源文件：`engine/customPresets.ts`

[← 回到索引](../README.md)

## 它是什么

把「某个已存在的节点配好一份参数」存成侧栏可复用的条目。
它与基础类型**共用 node.type**，所以执行器、卡片、属性面板全部自动继承。

## 结构

定义见 `engine/customPresets.ts` 的 `CustomPreset`（**以源文件为准**，下面是自动派生的字段清单）：

- `id`: `string`
- `name`: `string`
- `baseType`: `string`
- `color`: `string`
- `data`: `Record<string, unknown>`
- `createdAt`: `number`

## 与模块的区别（最容易混淆）

| | 自定义预设 | 模块 |
|---|---|---|
| 装的是什么 | **一个**节点 + 一套参数 | **多个**节点 + 它们之间的连线 |
| node.type | 复用基础类型的 type | 有自己的 `module` 类型 |
| 能存连线 | 不能 | 能 |

简单说：预设是"配好的一个积木"，模块是"编好的一组积木"。

## 存的时候会剥掉什么

- 运行时字段：`status` / `output` / `error` / 所有 `last*` 前缀
- 显示与布局：`size` / `stackParent` / `stackCollapsed`
- 内联密钥：`token` / `llm.apiKey` / `config.token`

**剥运行时的理由**：不剥的话，把跑过的 HTTP 节点存成预设，
之后每次拖出来的新节点都带着上一次的 `status='success'` 和旧 output ——
看起来"已经跑完了"，实际一次都没跑。

**剥密钥的理由**：预设明文存 localStorage，不能当密钥仓库用。
凭据引用（`credentialId`）会保留，它只是个 id。

## 导入时会校验

基础节点在本机不存在就跳过，并带回原因（"本机没有「xxx」这种节点"）——
硬塞进去侧栏会出现一个点了没反应的条目，那比不显示更糟。
同 id 视为同一条走更新，重复导入不会堆副本。
