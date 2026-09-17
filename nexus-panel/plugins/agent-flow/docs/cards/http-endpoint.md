# 接口卡片（http-endpoint）

> 自动生成，不要手改。源文件：`nodes/cardGroups.ts`

[← 回到索引](../README.md)

## 它管哪些字段

- `url`
- `method`

改其中任一字段 → 节点脱钩成「自定义」。

## 说明

HTTP 请求地址：url / method

## 能用在哪些节点

- [`generic-http`](../nodes/generic-http.params.md) — HTTP 请求

拖到节点上时会校验：节点必须**声明支持**这个组，否则拒绝并说明原因。

## 什么情况下这张卡片不能用

校验规则：`validate: (v) => { const url = asText(v.url); if (!url) return '没填地址'; if (!/^https?:\/\//i.test(url)) return '地址要以 http:// 或 https:// 开头'; return null; },`

返回非空即拒绝 —— 这是为了挡住"看着能拖、套上去是空的"这类错配。

## 语义

卡片是**模板库**，节点上的是**实例**：

- 点卡片 → 深拷贝一份值进节点
- 之后改节点上的字段 → 该组自动脱钩成「自定义」，卡片本身不变
- 删掉正在用的卡片 → 节点降级为「自定义」，值保留
