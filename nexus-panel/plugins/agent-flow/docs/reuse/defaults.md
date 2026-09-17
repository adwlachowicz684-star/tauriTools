# 节点默认值 — 新建节点长什么样

> 自动生成，不要手改。源文件：`engine/nodeDefaults.ts`

[← 回到索引](../README.md)

## 它是什么

属性面板的「设为默认」把当前节点的参数存成这类节点的默认值，
之后**新建**的同类节点都用这套值。已有节点不受影响。

严格说它不是"能拖出来的积木"，但它决定新建节点长什么样，
所以一并收录。

## 按 preset.key 存，不按 node.type

这一点很关键：任务节点有两个变体（WorkBuddy / TraeCode），
侧栏是两条独立预设，靠 `preset.init()` 写入不同的 `cli`。

若按 type 存一份默认，给 WorkBuddy 变体设的默认会**连带把
TraeCode 变体的 cli 也改掉** —— 而用户根本没碰过那个变体。

存的时候反查节点属于哪条预设（type 相同 + `init()` 写进去的字段
都与当前 data 一致）。改过那些字段的节点不属于任何预设，回落到 `node.type`。

## 叠加顺序

`create() → init() → defaults()`

默认放**最后**盖。反过来会被出厂值盖掉。

## 存之前剥三类字段

1. **运行时**（status / output / error / last*）—— 不剥的话新建节点
   带着 `status='success'` 和旧输出，看起来"已经跑完了"
2. **显示与布局**（size / stackParent / stackCollapsed）
   —— 尤其 `stackParent`：不剥的话每个新建节点都"嵌合"到一个
   不存在的父节点上，引擎把它转成边，**新节点莫名跑不起来**
3. **内联密钥**（token / llm.apiKey / config.token）——
   默认值明文存 localStorage，不能当密钥仓库用

## 存储键

`agent-flow.node-defaults.v1`
