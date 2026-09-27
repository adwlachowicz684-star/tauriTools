# update — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/bili.ts` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：外部服务
- **node.type**：`bili` / `update` / `wechat`（多个 type 共用一份 data）
- **源文件**：`nodes/defs/bili.ts`
- **产出**：bool（是/否）　**接受**：none
- **需要的外部能力**：`fetcher`, `githubFetch`

## 它做什么

是否有更新（true / false）—— 给条件节点判断

## 能力签名

- `fetcher`: `(node, url, { headers, timeoutSec }) => Promise<string>`
- `githubFetch`: `抓取仓库信息 => Promise<信息对象>`

> `fetcher` 是**按需**的：只有满足特定条件时才需要（见参数页）。

> `githubFetch` 是**按需**的：只有满足特定条件时才需要（见参数页）。

## 注意

- 它**不需要输入**（`接受 = none`），通常作为链的起点。

共 5 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `targets` **必填** | — | 要盯的目标列表（唯一数据源）。每张 = { id, kind, name, feedUrl, enabled, lastSeenId }；kind 决定盯哪个平台（取值是完整拼写如 bilibili，不是节点 type bili），feedUrl 是订阅源地址 —— 除 youtube / podcast 外都没有官方源，地址要照 UPDATE_SOURCE_META[kind].route 的示例拼。新建节点用 def.create()，它会直接落一份 targets；不要建顶层的 source / feedUrl —— 老存档缺 targets 时由 targetsOf() 读时合成一张卡，那是兼容路径，不是写入路径。 | `bilibili` / `wechat` / `xiaohongshu` / `weibo` / `zhihu` / `douyin` / `kuaishou` / `toutiao` / `douban` / `juejin` / `csdn` / `jianshu` / `v2ex` / `youtube` / `twitter` / `podcast` / `github` / `custom` | — |
| `outputFormat` | — | 输出格式：bool 只给 true / false（给条件节点判断），detail 额外带上标题 / 链接 / 时间 | `bool` / `detail` | — |
| `timeoutSec` | — | 每个目标的抓取超时（秒）；留空用默认 15 | — | — |
| `userAgent` | — | 自定义 User-Agent；部分订阅源会拒绝默认的非浏览器 UA，留空用默认值 | — | — |
| `firstRunAsUpdate` | — | 首次运行（还没有基线）时也算作更新。默认关闭 —— 刚配好就触发一次下游通常是误报 | — | — |

## 具名输出（除「结论」外还能取到什么）

用 `{{节点id.字段名}}` 取，或直接从卡片上对应的那个出口拖线。

| 字段名 | 显示名 | 值种类 |
|---|---|---|
| `updated` | 是否有更新 | bool |
| `title` | 标题 | text |
| `url` | 链接 | text |
| `date` | 时间 | text |


## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'update' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
