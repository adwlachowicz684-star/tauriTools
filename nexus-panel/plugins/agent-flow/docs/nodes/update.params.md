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

共 9 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `biliUid` | text | UP 主；占位：UID 或 space.bilibili.com 主页链接 | — | `d → d.source === 'bilibili'` |
| `biliMode` | select | 抓取方式 | `rss` / `api` | `d → d.source === 'bilibili'` |
| `biliCookie` | textarea | Cookie（可选）；绕过风控用。只填 SESSDATA 往往不够，B站还会看 buvid3 / _uuid，直接粘整条最省事；占位：浏览器里复制的整条 Cookie | — | `d → d.source === 'bilibili' && d.biliMode === 'api'` |
| `feedUrl` | text | 订阅源地址；占位：https://.../feed.xml | — | `d → d.source === 'wechat'` |
| `userAgent` | text | User-Agent（可选）；部分源会拒绝默认的非浏览器 UA；占位：留空用默认值 | — | — |
| `firstRunAsUpdate` | switch | 默认关闭：刚配好就触发一次下游通常是误报；占位：首次运行（还没有基线）时算作更新 | — | — |
| `outputFormat` | select | 输出格式 | `bool` / `detail` | — |
| `timeoutSec` | number | 超时（秒） | — | — |
| `source` | 隐藏（不在面板字段里） | 数据源。由节点类型决定（bili 与 wechat 两个 type 共用一份 update data），建节点时用对应的 def.create() | `bilibili` / `wechat` | — |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'update' }` 会缺默认字段 ——
本控件尤其要注意 `source`，它不在面板字段里。
