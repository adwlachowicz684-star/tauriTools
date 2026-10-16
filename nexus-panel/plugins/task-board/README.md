# task-board · 任务管理器插件

多 AI 窗口 + 人工 + agent-flow 流程共用的任务看板。**数据只有一份**：数据目录下的 `tasks.json`。

## 四条通道，一份数据

| 谁 | 怎么用 |
|---|---|
| 人 | 打开插件：看板 / 列表 / 分组 / 统计四视图，流转、新建、认领、审查、备注、删除 |
| AI 窗口 | `curl` 打本地 HTTP API（默认 `127.0.0.1:9911`，设置里起服务） |
| MCP 客户端 | 直连 `http://127.0.0.1:9911/mcp`（Streamable HTTP + JSON-RPC 2.0），6 个任务工具原生可调 |
| agent-flow | 画布上 `generic-http` 节点打同一个 API；提交审查可 POST 回调触发流程 |

## MCP 工具（POST /mcp，JSON-RPC 2.0）

| 工具 | 作用 |
|---|---|
| `tb_list_tasks` | 列任务（status/priority/tag/assignee/q 过滤） |
| `tb_create_task` | 新建 {title, detail?, priority?, tags?, reporter?} |
| `tb_get_task` | 单条详情含历史 |
| `tb_update_task` | 流转/改字段（走同一套流转图与认领守卫） |
| `tb_add_event` | 追加备注 |
| `tb_register_agent` | 注册窗口身份 |

鉴权与 HTTP API 相同（X-TB-Token / Authorization: Bearer）。客户端配置示例见插件「⚙ 设置」底部。

## 任务生命周期

```
todo ─认领→ claimed ─开始→ doing ─提交审查→ review ─通过→ done
                                      ↑          │
                                      └────打回──┘
```

`done` 只能由审查窗口打；开发窗口最多送到 `review`。认领必须署名（`assignee` = 窗口 ID）。

## 四种视图

顶栏下方切换，偏好（视图 / 分组依据 / 排序）经 `ctx.store` 持久化，重开不丢：

| 视图 | 形态 |
|---|---|
| 看板 | 按状态分五列，列内优先级升序 + 更新时间倒序 |
| 列表 | 平铺表格，表头六列可点（优先级 / ID / 标题 / 状态 / 认领人 / 更新），未认领恒排最后 |
| 分组 | 按状态 / 优先级 / 认领人 / 标签聚合；未认领置顶、标签用并集语义（一个任务可同时进多个标签组） |
| 统计 | 数字卡（总数 / 未完成 / 进行中 / 已完成 / 超 7 天未动）+ 状态与优先级分布条 + 认领人负载 + 热门标签 + 最近动态（点击可跳详情） |

四视图共用顶栏同一份筛选；统计视图看全量，不受筛选影响。

## 文件清单

```
plugins/task-board/
  index.html      首帧底色脚本 + 入口
  main.tsx        bootIframeReactPlugin
  App.tsx         四视图（看板/列表/分组/统计 + 过滤器/身份切换/详情/历史）
  Settings.tsx    数据目录/端口/令牌/自动启动/通知 URL
  styles.css      样式（style-audit / tokens / standard 三守卫零告警）
  types.ts        数据模型
  core.mjs        纯逻辑（状态机/归一化/排序/过滤/分组/统计）+ core.d.ts
  lib/store.ts    配置 + tasks.json 读写 + HTTP 客户端
  task-board-test.mjs   core 单测（89 项）
  docs/AI-CONVENTIONS.md   AI 窗口操作手册（curl 示例 + 认领礼仪）
  docs/AGENT-FLOW.md       agent-flow 联动指南（画布搭法 + 报文格式）
```

Rust 侧：`src-tauri/src/task_board.rs`（HTTP 服务 + 文件读写 + 目录授权），
命令 `tb_default_dir / tb_set_data_dir / tb_read_store / tb_write_store / tb_http_start / tb_http_stop`。

## HTTP API 速查

```
GET    /api/health             探活
GET    /api/tasks              全量任务 + 窗口身份
GET    /api/tasks/{id}         单条
POST   /api/tasks              新建 {title, detail?, priority?, tags?, reporter?}
PATCH  /api/tasks/{id}         流转/改字段 {status?, assignee?, priority?, title?, detail?, tags?, by?, note?}
POST   /api/tasks/{id}/events  追加事件 {by, action, note?}
POST   /api/agents             注册窗口身份 {id, name?, role?}
```

token 非空时请求头带 `X-TB-Token`。响应统一 `{"ok":true,...}` / `{"ok":false,"error"}`。

## 测试

```bash
npm run test:tb-core        # core 纯逻辑 89 项
node style-audit-test.mjs   # 样式审计（含本插件）
node style-standard-test.mjs --dir plugins/task-board
npm run scan:admit          # 插件准入扫描
npm run build && npm run check:dist
```

详细使用见 `docs/AI-CONVENTIONS.md` 与 `docs/AGENT-FLOW.md`。
