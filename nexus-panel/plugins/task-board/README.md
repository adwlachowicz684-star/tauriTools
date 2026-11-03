# task-board · 任务管理器插件

多 AI 窗口 + 人工 + agent-flow 流程共用的任务看板。**数据只有一份**：数据目录下的 `tasks.json`。

## AI 通道（HTTP / MCP）与界面同口径

`create_task` / `patch_task` / `tb_list_tasks` 两条通道共用。这几处与界面一致：

- **多选列**：`tags / type / group / assignee` 可以是字符串或数组。列任务的 `assignee` 过滤、`__none__`（未认领）、PATCH 写入都认数组；PATCH 遇到已存数组按**追加去重**处理，不会把多值覆盖成单值。
- **搜索 `q`**：与顶栏全局搜索同口径 —— id / 标题 / 详情 / 说明 + 状态 / 优先级 / 分组 / 认领人 / 类型 / 标签的**原始值与定义表显示名**（自定义流程的状态按流程里配的名字）。
- **定义表**：`defs_of` 优先读平级字段、回退 `defs.<key>`，导入「只有 defs」的文件时 AI 也能看到候选值。
- **优先级**：P0~P5 六档，与前端 `PRIORITY_ORDER` 逐项同序（守卫盯着）。
- **通知状态**：`tb_update_task` 用的 `notify_status` 由 HTTP 服务一路透传到 MCP 通道，不再写死 `review`（自定义流程里那一步可能叫别的）。返回值是 `entered_notify_status`，**只表示本次进入了通知状态**；webhook 由 HTTP PATCH 通道发出，MCP 通道不发通知 —— 别把它当成"已送达"。
- **status 参数不写 enum**：两处 schema 只声明 `type: string`，实际生效的状态看 `tb_list_tasks` 响应的 `defs.statuses`（服务端按 `flow` 校验），自定义流程的状态不会被客户端 schema 挡掉。
- **register_agent**：id / name / role 写入侧先 trim。
- **PATCH 判等**：`title / detail / summary / priority / reporter` 传一个没变化的值不再写盘、不再刷新 `updatedAt` —— 否则任务会从「超 7 天未动」里凭空消失、按更新排序顶到最前，而什么都没改。这五个字段写入侧也和 create 一样先 trim。
- **通知契约**：HTTP PATCH 进通知状态时，webhook 体与界面 `notifyWebhook` 用同一份形状（`{ id, title, status, assignee: 显示串 }`），不再把整条任务（含多值数组 / history / deps）外发。通知写失败或收到非 2xx 会写进 stderr，不再完全静默。
- **两条读通道字段一致**：`tb_list_tasks` 与 `GET /api/tasks` 都返回 `tasks + agents + defs`。
- **文本字段统一 trim**：`str_field` 一处归一，create / patch / add_event / register_agent 的所有文本字段自动生效，不再逐处打补丁。带空格的 `status` / `priority` 不会被误判为非法值。
- **deps 通道补齐**：建任务与改任务都认 `deps`（字符串或数组），写入侧按前端 `normalizeTask` 同一判据清洗（trim / 去空 / 去重 / 去自依赖），指向不存在任务的 id 保留给界面标「前置不存在」。两处 schema 都列了这个字段。
- **空事件不写盘**：`tb_add_event` 无 `note` 且 `action` 缺省或为 `note` 时返回错误，不再 push 一条空历史、不再刷新 `updatedAt`。
- **四条读通道都带 defs**：`GET /api/tasks`、`GET /api/tasks/{id}`、`tb_list_tasks`、`tb_get_task` 口径一致。
- **defs 给 AI 完整流程视图**：除 `statuses`（id 列表，保留兼容）外新增 `statusDefs`（每个状态的名字/颜色/进入动词/是否完成态）、`transitions`（界面实际生效的流转图）、`initial`（新建任务必须落在的状态）。三者都从 `flow` 派生，不新增落盘字段，导入导出原样带回。
- **默认流转表抽成一份常量**：`can_transition` 与 `flow_for_ai` 共用 `DEFAULT_TRANSITIONS`；`patch_task` 与 `defs.transitions` 共用同一份归一表（自定义优先、裁到当前状态清单、空表回退裁剪默认图），AI 看到的图就是服务端校验的图。
- **AI 列任务可按 type / group 过滤**：支持多值列任一命中与 `__none__` 查空值，两处 schema 都列了参数。
- **HTTP 业务错误按语义分类**：参数错误 400、目标不存在 404、文件/序列化错误仍 500。原来一律 500，AI 会当成服务端故障去重试、去查端口和 token。
- **两条读通道共用一份过滤判据**：抽出 `TaskFilter`（`from_args` 给 MCP、`from_query` 给 HTTP、共用 `matches`）。`GET /api/tasks` 原来把 query string 整个丢掉、一个过滤参数都没有，现在支持 `status/priority/type/group/tag/assignee/q`，重复键累加、百分号解码，并带 `count` 与 MCP 对齐。
- **过滤参数可传数组**：除 `q` 外每个参数都认 `["string","array"]`（OR 命中），写入侧早就能传数组，读侧过滤原来只 `as_str()`，传数组会被静默忽略。
- **MCP batch 响应始终是数组**：JSON-RPC 2.0 §6 要求；原来 batch 只剩 1 条响应时会返回单个对象，严格客户端解析失败。
- **错误码判据按形状**：`api_status` 先判 IO 前缀（500），再用 `任务 {id} 不存在` 的形状判 404，其余 400。原来用 `contains("不存在")`，自定义状态名或 IO 错误 detail 含这三个字都会误判。
- **PATCH 三个多值列认数组**：`type` / `group` / `assignee` 的 `tb_update_task` 原来只 `str_field`（只认字符串），而 `tb_create_task` 走 `enum_value` 认数组、读侧过滤参数上一轮也改成认数组。同一份 `{"type":["dev","bug"]}` 建任务成功、改任务被静默当作「没传」并报「没有可应用的变更」。现在数组形状走 `patch_vals_set`（整体替换），单值仍走 `patch_vals`（追加/替换/清空），两路共用判等与历史格式；三处 schema 声明同步改成 `["string","array"]`。HTTP 与 MCP 共用 `patch_task`，一起生效。
- **create schema 补 `assignee`**：实现里写了 `enum_value(body, "assignee")`、tasks.json 里显式存了这一列、`tb_update_task` 也能改，但 `tb_create_task` 的工具表里没列这个参数 —— AI 建任务时看不见，永远填不了，只能建完再 PATCH 认领。与「create 不写 summary / deps」是同一族「看得见却填不了」。新增通杀守卫：`create_task` 写进文件的每个字段都必须在 schema 里列出。
- **所有 id 入口统一归一**：新增 `norm_id`（百分号解码 + 首尾空白），MCP 分发的 `s("id")`、HTTP path 的 id 段、新增的删除入口共用。上一轮把 `str_field` 改成统一 trim，但 MCP 的 id 走另一个取值函数没跟上 —— AI 传 `"  tb-0001  "` 会拿到「任务  tb-0001  不存在」，而任务明明在；`GET /api/tasks/%20tb-0001` 也找不到。
- **AI 通道补齐删除**：新增 `HTTP DELETE /api/tasks/{id}` 与 MCP `tb_delete_task`，共用 `delete_task`。界面早有单条/批量删除，6 个工具里却没有删除 —— AI 误建任务或清理废弃任务只能让用户去界面点。与界面同一判据：**不清其它任务的 deps**（保留给界面标「前置不存在」），但因为 AI 没有确认框，把受影响任务放进响应 `dependents` / `dependentsCount`；不刷新其它任务的 `updatedAt`。删除不存在的 id 返回 404「任务 {id} 不存在」。
- **单条读 404 文案统一**：`GET /api/tasks/{id}` 原来是硬编码英文 `task not found`（不带 id、不走 `api_status`），而 MCP 是「任务 {id} 不存在」。两条通道的字段/能力/错误码都对齐了，错误体没对齐。现在统一走同一句文案 + `api_status`。
- **MCP schema 的 6 处 type 声明放行宽进参数**：`tags` / `deps` 原来写 `"type": "array"`、`estimate` 写 `"type": "number"`，而三者的描述都写着「单个写成字符串也认 / 写成数字字符串也认」、服务端也确实认 —— **严格按 `inputSchema` 做本地校验的 MCP 客户端会在请求发出前就拒掉**，curl 手调却一切正常。与之前修过的「status enum 写死 7 个」「PATCH 多值列 type 单值」同族：指了路却把门关着。已改成 `["string","array"]` / `["number","string"]`，并加通杀守卫：凡描述说宽进的字段，type 必须真的放行。
- **写响应形状两条通道统一**：新建/修改/删除/事件/注册，HTTP 一直用 `{"ok":true,"task":...}`，MCP 却是 `created` / `updated` / `task` 三个名字且没有 `ok`；`entered_notify_status` 反过来只有 MCP 有。现在 MCP 补上 `ok` 与 `task` 别名、HTTP PATCH 补上 `entered_notify_status`，**旧名 `created`/`updated` 全部保留**（不破坏已有客户端）—— 两条通道都能用 `resp.ok` / `resp.task.id` 解析。
- **id 专属取值闭包改名 `id_of`**：上一轮给 `norm_id` 加了 `pct_decode`，而承载它的闭包仍叫通用的 `s` —— 将来谁复用它读正文，会把 `%20` 静默解成空格。四个调用点全是 id，改名把语义钉死；`search_hay` 里那个只读文本字段的 `s` 保持不变。
- **过滤值归一只有一份 `norm_text`**：上一轮抽了 `TaskFilter.matches`，却留下 `from_args` / `from_query` **各自归一** —— MCP 只 `trim()`、HTTP 只 `pct_decode()`。于是同一个 AI 请求里 `?status=%20todo%20` 静默 0 条而 `{"status":" todo "}` 命中；`{"group":"%E7%99%BB%E5%BD%95"}` 筛不到而 HTTP 同名 query 能筛到（上一轮刚给 MCP 的 **id** 加了 `norm_id` 解码+trim，过滤值没跟上）。现在两条通道共用「百分号解码 + trim」，差别仅在协议要求的 `+` 语义：query 里 `+` 是空格，JSON 参数里是字面量（分组名「C++」不会被悄悄改成「C  」）。
- **MCP 失败的 `text` 与成功 / HTTP 同形状**：上一轮把两条通道的成功响应统一成 `resp.ok` / `resp.task.id`，失败侧没跟上 —— MCP 成功的 `content[0].text` 是 JSON 串，失败却是裸文案，客户端统一 `JSON.parse(text)` 时直接抛 SyntaxError，把「任务不存在」误判成「服务端返回坏数据」；HTTP 失败是 `{"ok":false,"error":...}`，MCP 既没有 `ok:false` 也没有 `error`。现在失败 `text` 也走 `err_json`，`isError:true` 保留（协议要求）。两条通道、成功失败，解析后字段一致。
- **CORS 允许 DELETE**：新增 `DELETE /api/tasks/{id}` 时 `Access-Control-Allow-Methods` 仍是 `GET, POST, PATCH, OPTIONS` —— 浏览器跨域 DELETE 的预检会被拒，而服务端用 curl 测一切正常，属于「新增能力但配套没跟上」。已补，并加通杀守卫：从 route 动态抽出所有方法名，逐个核对响应头。文件头的路由清单也同步补上 DELETE 和各通道新增的字段。
- **工具表 7 个**：Rust 内置测试里 `assert_eq!(tools.len(), 6)` 同步改成 7，避免 `cargo test` 红。
- **认领守卫与追加语义统一**：守卫注释原写着「PATCH 是覆盖语义」，而 `patch_vals` 早已改成追加 —— 任务已有 `["张三"]` 时，AI 传单值「李四」想共同认领被拒绝，界面却支持共同认领。现在抽成 `guard_assignee`，只看**最终集合是否保留所有现有认领人**：单值追加/数组加人放行，踢人拒绝，空串或空数组显式释放。哨兵值不参与判断。

### 写入侧归一化（与界面同一判据）

AI 通道的 `create_task` / `patch_task` 写入前也做归一，避免把静默坏数据写进 tasks.json：

- **id**：`nextId` 与库里实际最大编号取大 —— `nextId` 落后时不会和已有任务撞号，提升后的值一并写回。
- **estimate**：数字或数字字符串都认（`"2.5"` 不会被当成没估）；负数/非法值归 0。
- **tags / type / group / assignee**：单个值写成字符串也认；数组逐元素 trim、去空、去重。
- **历史上限**：`HISTORY_CAP` 跨端同值（守卫盯着）。

## 优先级与颜色（可改、落盘、随项目带走）

优先级固定 **P0~P5 六档**（P0 最紧急，默认色也最红）。优先级与状态的**颜色都是数据**，不是写死在样式里：

- 在列头的筛选面板里点色点改色（固定调色板 + 主面板取色器）
- 优先级颜色存 `tasks.json` 的 `defs.priority`，同时展开成平级 `priorityDefs`
- 状态颜色存 `flow.statuses[].color`（本来就在 `tasks.json` 里）
- 两处都随项目**导入 / 导出原样带回来**，不依赖插件偏好或全局配置
- 老文件（四档）读进来自动补齐 P4/P5，用户改过的颜色不会被默认冲掉

优先级是固定枚举，所以只给改色、不给新建/改名/删除；状态的增删改在「流程设置」里。处于「未配置状态」（配置里已删、任务上还留着）的项没有存储位置，不给色板。

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

上图是**默认流程**。状态流转图用户可自定义（⚙ 流程设置里增删改状态与流转边），
自定义之后：状态名、完成态、通知触发态全部跟着配置走，
界面上不会出现写死默认状态的判据（有守卫盯着）。

默认流程下：`done` 只能由审查窗口打；开发窗口最多送到 `review`。认领必须署名（`assignee` = 窗口 ID）。

## 四种视图

顶栏下方切换，偏好（视图 / 分组依据 / 排序）经 `ctx.store` 持久化，重开不丢：

| 视图 | 形态 |
|---|---|
| 看板 | 按状态分列（列数 = 流程里配置的状态数；处于配置里没有的状态的任务会多出一列标「未配置」），列内优先级升序 + 更新时间倒序 |
| 列表 | 平铺表格，12 列（优先级 / ID / 标题 / 分组 / 状态 / 认领人 / 任务类型 / 标签 / 说明 / 预估 / 创建 / 更新）**每列都能筛选和排序**；列可隐藏、可拖宽，偏好持久化 |
| 分组 | 按状态 / 优先级 / 认领人 / 任务类型 / 标签 / 分组聚合，可多级；未认领置顶、标签用并集语义。多选列（标签/类型/分组/认领人，可在列设置里勾）的任务会**同时出现在每个所属的组** |
| 统计 | 数字卡（总数 / 未完成 / 进行中 / 已完成 / 超 7 天未动）+ 状态与优先级分布条 + 认领人负载 + 热门标签 + 最近动态（点击可跳详情） |

四视图共用同一份筛选结果；统计视图看全量，不受筛选影响。

**筛选在列上**：点列头的漏斗开面板（enum 列多选、text 列关键词、time 列起止日期），
点列头文字排序（升序 ⇄ 降序）。已生效的筛选在筛选条上列成 chip，可逐个摘掉或一键重置。
顶栏只留一个全局搜索（跨 id / 标题 / 详情 / 说明 / 状态名 / 优先级档位与名称 / 分组 / 认领人 / 类型名 / 标签名；定义表改名后按新名搜）—— 那是"找某一条"的入口，不属于按列筛。
筛选入口在列表视图；其它视图消费同一份结果，筛选条上有跳转按钮。

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
  task-board-test.mjs   core 单测（641 项，含源码扫描类守卫）
  docs/AI-CONVENTIONS.md   AI 窗口操作手册（curl 示例 + 认领礼仪）
  docs/AGENT-FLOW.md       agent-flow 联动指南（画布搭法 + 报文格式）
```

Rust 侧：`src-tauri/src/task_board.rs`（HTTP 服务 + 文件读写 + 目录授权），
命令 `tb_default_dir / tb_set_data_dir / tb_read_store / tb_write_store / tb_http_start / tb_http_stop`。

## HTTP API 速查

```
GET    /api/health             探活
GET    /api/tasks              全量任务 + 窗口身份 + defs（定义表与生效状态清单）
GET    /api/tasks/{id}         单条
POST   /api/tasks              新建 {title, detail?, summary?, priority?, tags?, type?, group?, assignee?, estimate?, reporter?}
PATCH  /api/tasks/{id}         流转/改字段 {status?, assignee?, priority?, title?, detail?, summary?, type?, group?, tags?, estimate?, deps?, by?, note?}
POST   /api/tasks/{id}/events  追加事件 {by, action, note?}
POST   /api/agents             注册窗口身份 {id, name?, role?}
```

token 非空时请求头带 `X-TB-Token`。响应统一 `{"ok":true,...}` / `{"ok":false,"error"}`。

## 测试

```bash
npm run test:tb-core        # core 纯逻辑 641 项
node style-audit-test.mjs   # 样式审计（含本插件）
node style-standard-test.mjs --dir plugins/task-board
npm run scan:admit          # 插件准入扫描
npm run build && npm run check:dist
```

详细使用见 `docs/AI-CONVENTIONS.md` 与 `docs/AGENT-FLOW.md`。
