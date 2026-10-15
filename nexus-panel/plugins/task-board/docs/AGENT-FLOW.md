# 任务管理器 × Agent Flow 联动指南

目标：**条件满足 → 自动触发流程 → 流程自动生成一组任务 → 任务干完再回调流程**。
全程不改 agent-flow 一行代码，靠它现成的 `webhook` 触发器 + `generic-http` 节点。

## 0. 两个方向的通道

```
                 ┌──────────────── agent-flow 画布 ────────────────┐
                 │                                                  │
  任务管理器      │  trigger(webhook) → condition → … → generic-http │
  tasks.json ◄────┼──POST /api/tasks──────── 建任务 ──POST──────────┤
                 │                                                  │
                 │  trigger(webhook) → condition → …（审查流程）      │
                 └──────────────────────────────────────────────────┘
                          ▲
                          └── 任务提交审查时，任务管理器 POST 通知
                              （设置里的「审查通知 URL」填 webhook 地址）
```

- **流程 → 任务**：画布上的 `generic-http` 节点 POST `http://127.0.0.1:9911/api/tasks`。
- **任务 → 流程**：任务管理器设置里填「审查通知 URL」= agent-flow 的 webhook 地址，
  任务进入 `review` 时自动 POST 一份 `{source, event, task}` JSON。

## 1. 让 agent-flow 能触发任务管理器（建任务链）

### 1.1 任务管理器侧

1. 打开任务管理器 → 「⚙ 设置」→ 启动 HTTP 服务（记下端口，默认 9911；有令牌就一并记下）。
2. 想收审查回调：把「审查通知 URL」填成 agent-flow webhook 地址（见 1.2）。

### 1.2 agent-flow 侧（画布搭法）

**画布 A：定时巡检 → 发现问题 → 自动建一组任务**

```
[trigger interval 5min]
      │
      ▼
[generic-http GET 巡检接口]        ← 你的巡检/构建/测试接口
      │
      ▼
[condition]
  规则1: op=nonEmpty source=上节点       命中 → 走「有问题」分支
  规则2: op=isEmpty  source=上节点       命中 → 走「一切正常」分支
      │                                     │
      ▼                                     ▼
[text/derive 拼任务清单 JSON]          [log 记录正常]（结束）
      │
      ▼
[loop list 模式遍历清单]
      │
      ▼
[generic-http POST http://127.0.0.1:9911/api/tasks]
  headers: Content-Type: application/json
           X-TB-Token: <令牌>        ← 配了才加
  body: {"title":"{{item.title}}","priority":"{{item.priority}}",
         "tags":["auto","巡检"],"reporter":"flow-patrol"}
```

每个 loop 轮次建一个任务，一轮巡检出来 N 个问题就是 N 个 `tb-xxxx`。

**画布 B：审查回调 → 通知/再处理**

```
[trigger webhook path=/hooks/tb-review token=<令牌>]
      │
      ▼
[condition]  规则: op=equals source=input value=submit-review
      │
      ▼
[generic-http POST 你的通知渠道]   body 用 {{input}} 里的 task 字段
```

任务管理器的通知 URL 就填：`http://127.0.0.1:8787/hooks/tb-review`（端口/路径按你画的触发器）。

### 1.3 通知报文长什么样

```json
{
  "source": "task-board",
  "event": "submit-review",
  "task": {
    "id": "tb-0007",
    "title": "登录页样式错乱",
    "status": "review",
    "assignee": "dev-a"
  }
}
```

`{{input}}` 拿得到整份；条件节点按 `submit-review` 分流，别的事件走默认分支。

## 2. 让任务管理器反过来触发 agent-flow（任务驱动流程）

两种玩法：

**玩法一：提交审查即触发**（推荐，零画布逻辑）
设置里「审查通知 URL」指向 webhook 触发器。画布按 1.2-B 搭。
语义：*开发送审 → 审查流程自动跑*（比如自动跑测试、自动@审查人）。

**玩法二：任务状态轮询驱动**
画布上 `trigger interval` + `generic-http GET http://127.0.0.1:9911/api/tasks` +
`condition` 判 `status` 字段 + 下游处理。适合「攒够 N 个待办再统一干」的批处理场景。

## 3. 常见问题

| 现象 | 原因 | 解法 |
|---|---|---|
| generic-http 报 connection refused | 任务管理器 HTTP 服务没起 | 设置面板点「启动服务」，或勾「打开插件时自动启动」 |
| 401 bad token | 设了令牌但节点没带 | generic-http 的 headers 加 `X-TB-Token: <令牌>` |
| 建出来的任务 priority 是 P2 | 没传 priority 字段 | body 里显式带 `"priority":"P1"` |
| 审查回调没反应 | 通知 URL 空或 webhook 没起 | 设置里确认 URL；agent-flow 画布触发器要是运行状态 |
| 想删任务 | HTTP API 没有 DELETE | 看板详情里删，或直接改 tasks.json |

## 4. 报文格式速查

```
GET    /api/health              → {"ok":true,"service":"task-board"}
GET    /api/tasks               → {"ok":true,"tasks":[...],"agents":[...]}
GET    /api/tasks/tb-0001       → {"ok":true,"task":{...}}
POST   /api/tasks               body {title, detail?, priority?, tags?, reporter?, assignee?}
PATCH  /api/tasks/tb-0001       body {status?, assignee?, priority?, title?, detail?, tags?, by?, note?}
POST   /api/tasks/tb-0001/events body {by, action, note?}
POST   /api/agents              body {id, name?, role?}
```

`status` 合法值：`todo` / `claimed` / `doing` / `review` / `done`。
`priority` 合法值：`P0` / `P1` / `P2` / `P3`。
