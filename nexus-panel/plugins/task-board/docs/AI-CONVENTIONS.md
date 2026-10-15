# 任务管理器 · AI 窗口协作约定

多个 AI 窗口（WorkBuddy 会话）+ 人工 + agent-flow 流程，共用同一份 `tasks.json`。
本文是给 AI 窗口的操作手册：**发现问题 → 建任务 → 认领 → 开工 → 送审 → 审查通过**。

## 0. 前提

任务管理器插件已打开，且 HTTP 服务已启动（看板顶栏圆点变亮，或设置面板点「启动服务」）。
默认端口 `9911`，数据目录默认 `%APPDATA%/com.nexus.panel/task-board/`（设置里可改可看）。
配了访问令牌的话，所有请求都要带头 `X-TB-Token: <令牌>`。

> ⚠️ 令牌留空 = 不校验。服务只绑 127.0.0.1 外部进不来，但**同机的浏览器网页**可以跨源
> 访问它（CORS 放开是给插件自己用的）。单机自用无妨；介意就把令牌配上。

## 1. 任务的一生

```
todo ──认领──> claimed ──开始──> doing ──提交审查──> review ──通过──> done
 ▲              │                  │                    │             │
 └──退回────────┘                  └──退回──────────────┘──打回───────┘
                                                          ▲
                                              done ──重开──┘
```

流转规则**三端同源**（UI / HTTP / 本图），Rust 与前端各自校验：
`claimed→todo`、`doing→todo` 退回；`review→doing` 打回；`done→review` 重开。
不存在跳跃：todo/claimed 不能直跳 done（审查不能被绕过），新建只允许 todo。

| 状态 | 含义 | 谁来做 |
|---|---|---|
| todo | 待办，没人认领 | 报告人（任何窗口） |
| claimed | 已认领，还没开工 | 认领人 |
| doing | 进行中 | 认领人 |
| review | 待审查 | 审查窗口 |
| done | 审查通过，关闭 | 审查窗口 |

## 2. 常用操作（curl）

设两个变量少打字：

```bash
TB=http://127.0.0.1:9911
TBH='-H "Content-Type: application/json" -H "X-TB-Token: <令牌>"'   # 没配令牌就留空
```

**发现问题 → 新建任务**（报告人写自己的窗口 ID）：

```bash
curl -X POST $TBH -d '{
  "title": "登录页在 125% 缩放下样式错乱",
  "detail": "复现：设置→显示→125%；期望：按钮不错位",
  "priority": "P1",
  "tags": ["bug", "ui"],
  "reporter": "dev-a"
}' $TB/api/tasks
```

**看全部任务**（开工前先看一眼有没有自己的活、有没有新问题）：

```bash
curl $TBH $TB/api/tasks
```

**认领任务**（署名 + 置为 claimed，一条 PATCH 搞定）：

```bash
curl -X PATCH $TBH -d '{"assignee": "dev-a", "status": "claimed", "by": "dev-a"}' $TB/api/tasks/tb-0001
```

> 已被别人认领的任务会收到 409 语义的错误（「任务已被 xxx 认领」）——先与对方确认或退回 todo，别硬抢。

**开始干活**：

```bash
curl -X PATCH $TBH -d '{"status": "doing", "by": "dev-a"}' $TB/api/tasks/tb-0001
```

**写完自测过 → 提交审查**（note 写清改了什么、怎么验的）：

```bash
curl -X PATCH $TBH -d '{"status": "review", "by": "dev-a", "note": "改了 login.css 的 flex 基准；125%/150% 下肉眼+截图比对通过"}' $TB/api/tasks/tb-0001
```

**审查窗口打回**（必须写原因）：

```bash
curl -X PATCH $TBH -d '{"status": "doing", "by": "review-1", "note": "边缘情况没处理：空密码直接放行了"}' $TB/api/tasks/tb-0001
```

**审查通过**：

```bash
curl -X PATCH $TBH -d '{"status": "done", "by": "review-1"}' $TB/api/tasks/tb-0001
```

**追加备注/进展**（不改状态，只留痕）：

```bash
curl -X POST $TBH -d '{"by": "dev-a", "action": "note", "note": "定位到是缩放断点缺失，正在补"}' $TB/api/tasks/tb-0001/events
```

**注册窗口身份**（首次使用先登记，看板身份下拉里能看到你）：

```bash
curl -X POST $TBH -d '{"id": "dev-a", "name": "开发窗口A", "role": "dev"}' $TB/api/agents
```

`role` 约定：`dev`（开发）/ `review`（审查）/ `manual`（人工）。

## 3. 字段速查

| 字段 | 值 | 说明 |
|---|---|---|
| `priority` | P0 / P1 / P2 / P3 | 紧急 / 高 / 中 / 低，默认 P2 |
| `tags` | 字符串数组 | 自由标签，看板可按标签过滤 |
| `status` | todo/claimed/doing/review/done | 非法值会被拒 |
| `by` | 窗口 ID | 谁做的这个操作，进历史 |
| `note` | 字符串 | 备注；打回时必填 |
| `reporter` | 窗口 ID | 谁报的问题，默认 manual |

响应一律 `{"ok": true, ...}` 或 `{"ok": false, "error": "原因"}`。

## 4. 认领礼仪（多窗口并行不打架）

1. **认领前先 GET 一遍**：确认任务还在 todo、没人认领。
2. **认领必须署名**：`assignee` 写自己的窗口 ID，别替别人认领。
3. **一个任务一个人**：看到 `assignee` 是别人的 ID，想接话先追加 note 问，别直接改状态。
4. **长时间没进展**：追加 note 说明卡点，必要时退回 todo（`{"status":"todo"}`）放别人接手。
5. **完成 ≠ 关闭**：`done` 只能由审查窗口打；开发窗口最多送到 `review`。

## 5. 直接改文件（不经过 HTTP）

`tasks.json` 就在数据目录里，AI 也可以直接用文件工具读写。
约定：改完保持 JSON 合法；`nextId` 只增不减；新建任务 id 用 `tb-%04d`（nextId 当前值）。
**同时只走一条通道**：要么全程 curl，要么全程改文件，别混着来（看板每 2s 重读文件，混用会互相覆盖）。
