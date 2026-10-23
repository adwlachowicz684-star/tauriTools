# MCP 整体架构方案

> **核实时间**：2026-10-24（上一次为 2026-09-17，期间架构发生大变化，旧版结论全部作废）
> **核实方式**：逐条对照当前代码（`fpx/mcp.rs` 2067 行、`mcp_gate.rs` 1570 行、`main.rs`、`task_board.rs`），
> 所有数字与结论均经过代码核对，不是估算。
> **最新功能状态**以 `docs/核对状态表.md` 与 `docs/功能完成状态总览.md` 为准；本文聚焦架构与接线。

---

## 一、当前实现（事实）

| 项 | 现状 |
|---|---|
| 传输 | **HTTP over TCP**，手写 HTTP/1.1 + JSON-RPC 2.0，**不引 axum / tokio** |
| 监听 | `TcpListener::bind(("127.0.0.1", port))`，仅本机 |
| 方法 | `initialize` / `tools/list` / `tools/call` / `ping` |
| 工具数 | **25 个**（`fpx/mcp.rs` 的 `tools()` 定义推导；task-board 另有 6 个，见第四节网关） |
| 入口 | `fpx_mcp_start` / `fpx_mcp_stop` / `fpx_mcp_status` / `fpx_mcp_tools` |
| 进程模型 | GUI 进程内线程；`--mcp` = 另一个 exe 实例（**隐藏窗口跑界面**）；`--stdio` = 真正的 stdio 模式 |
| 工具开关 | `config.mcp_tools`（逐工具，`tools/list` 按此过滤，缺失视为开启） |
| 服务总开关 | `config.mcp_enabled`（false 时整个服务拒绝服务，配置可随时改回） |
| 退出行为 | `close_mcp_on_exit` 已接 `RunEvent::Exit`（true 才关，默认 false = 常驻） |

**25 个工具**（`tools()` 实有，`get_manual` 由它推导，不会脱节）：

```
list_projects · list_groups · list_links · create_link · remove_link
scan_content · read_file · create_folder · add_card · set_lock
set_tag_color · backup · get_manual · get_status · select_folder
get_selection · lock_status · folder_icon_set · folder_icon_get
folder_icon_restore · capture_screen · list_windows · capture_window
pick_screen_color · deploy_skill
```

### 当前比原版多出的（勿删）

`add_card`、`set_tag_color`、`read_file` —— 原版没有，因本版前端需要而加。

---

## 二、与原版（WPF）的架构差异 ⚠️ 最关键的一节

| | 原版 | 当前 |
|---|---|---|
| 传输 | **stdio JSON-RPC**（`--mcp`，不开窗口） | **HTTP over TCP**；stdio 走 `--stdio`（S4 已完成） |
| 进程 | AI 客户端拉起独立进程，stdin/stdout 通信 | GUI 内线程；或 `--mcp` 独立进程（隐藏窗口） |
| 并发 | 两个进程可能并存，靠**跨进程 Mutex** 保护 | 已补文件锁（见下） |

### 差异 1：工具名变了，照原版 README 配置会全失败 —— ✅ 已解决（S1）

`mcp.rs` 的 `ALIASES` 表（9 条）在 `tools/call` 时归一化：

| 原版 | 当前 | 说明 |
|---|---|---|
| `backup_now` | `backup` | 改名 |
| `lock_set` | `set_lock` | 改名 |
| `list_agents` / `list_skills` / `list_rules` | `scan_content` | 合并，**补 `kind` 默认参数**（三件必须成套，漏 rule 会让旧调用返回 all，语义错但不报错） |
| `refresh_content` | `scan_content` | 同一函数换个名；且做了 `target` → `root` 参数回退 |
| `create_project` / `create_group` | `create_folder` | 合并 |
| `folder_icon_set_dll` | `folder_icon_set` | 改名；`icon` 参数本就支持 `路径\|索引` |
| `pick_screen_color` | 同名 | **S2 已实现**（x/y 可选，省略跟随鼠标） |

设计要点（源码注释已固化）：
- **只在 `tools/call` 接受，不进 `tools/list`** —— 清单里冒两套名字，AI 可能同时调两个；
  且用户关掉实名后别名不该还挂在清单里显得能用。
- **必须在查开关之前归一化** —— 否则关掉 `backup` 后用 `backup_now` 还能调，是个绕过口子。
- 补默认参数（`kind`）是别名正确性的关键：只改名不补参 = 语义错误但不报错，比直接失败更难排查。

### 差异 2：`--mcp` 的位置与 stdio 入口 ⚠️（S4 已完成）

**`--mcp` 不在 `cli.rs`**，而在 `main.rs` 的 Tauri `Builder` 的 `setup` 里——关掉主窗口后再 `serve()`。
`--mcp` 实例仍然加载了**完整 Tauri 栈**，只是不显示窗口。

**stdio 模式的入口是 `--stdio`（`MCP_STDIO_ARG`），不是 `--mcp`**：

```
cli.rs   → 只处理 --self-check / --migrate-*
main.rs  → ① Builder 之前：--stdio 分支（serve_stdio，stdout 只出 JSON-RPC）
            ② Builder.setup() 里：--mcp（关窗口 → serve，隐藏窗口跑界面）
```

> Tauri 自己会往 stdout 打东西，而 stdio 模式要求 stdout **只能**输出 JSON-RPC。
> 所以 stdio 分支**必须挪到 `main()` 最前面、在 `Builder` 之前**处理。
> 否则一条 Tauri 的启动日志就会污染协议流，导致 AI 客户端解析失败——
> 且这类失败表现为"连上了但一直报错"，极难定位。
>
> 照原版写 `--mcp` 当 stdio 入口的后果：客户端拉起进程后**收不到任何响应**，
> 进程起来了、也不报错，只是不在说协议，日志里什么都没有，最难查。

### 差异 3：跨进程数据竞争（已修，S5 已验证）

原版有 `Global\` 命名 Mutex 保护 config 与账本。

当前两个进程（GUI + `--mcp`）会同时读写同一份 config。已补：
- 文件锁（`create_new` 原子创建，10s 超时报错不强抢）
- 进程内可重入（`thread_local!` 记层数）
- 覆盖 `with_config` / `with_records` / `save_config` / `save_records`
- 竞态落点 `core_create_link` / `core_remove_link` 已并入事务

**已验证**：2026-09-16 本地 `cargo build` 通过；`target/release/` 下 `nexus-panel.exe` 存在。

---

## 三、MCP 网关（AI 客户端统一接入点）

`mcp_gate.rs`（1570 行）。各插件原本各自起一个 MCP server，端口、令牌、客户端配置
各一份 —— AI 客户端要配 N 条 `mcpServers`。网关把能力聚合到**一个端点**：
客户端只配一次，之后新插件的工具自动出现在同一张工具表里。

| 项 | 值 |
|---|---|
| 端点 | `http://127.0.0.1:9910/mcp`（HTTP + JSON-RPC 2.0） |
| 鉴权 | **所有**请求（含 `GET /`）都要 Bearer 令牌；常量时间比较；无 CORS |
| 令牌 | 「设置 → MCP 网关」页查看，首次启动自动生成并持久化（重启不变，变了客户端全断） |
| 端口 | 默认 9910（避开 fpx 动态分配与 task-board 的 9911），可改，改后需重启 |
| auto_start | **默认开** —— 本功能目的就是「接入后直接可用」 |
| 工具名规则 | `server__工具`，`__` 分隔，拆分取**第一个** `__`（防工具名自带下划线错切）；**不做裸名兼容**（两个插件同名工具时裸名路由挑错不报错，读的是另一个服务的数据） |

**内置 server 两个**（`register_builtins` 启动时注册）：

| server | 工具数 | 说明 |
|---|---|---|
| `project-group` | 25 | fpx 的 `tools()`；handler 薄封装 `invoke_tool`，数据目录**调用时现取** |
| `task-board` | 6 | `tb_list_tasks / tb_create_task / tb_get_task / tb_update_task / tb_add_event / tb_register_agent`；handler 调用时现取数据目录，过文件锁 |

合计 **31 个工具**经网关暴露。

### 新插件的工具怎么进网关（两条路）

**路 A：插件在 Rust 侧已有工具表**（与 `fpx::mcp::tools()` 同形态）。在
`register_builtins()` 里加一段循环，`register_native` 逐个登记 —— handler 直接调
业务函数，不起第二个端口。注意：① 数据目录**调用时现取**（注册时定死 = 用户改目录后
读写旧库且不报错）；② 薄封装转调插件自己的 `call_tool`，别在网关侧重抄参数校验 ——
别名归一化、报错文案只应有一个真相源。

**路 B：插件自己跑着独立的 MCP HTTP server**。代理注册表单填 server 名 / 地址 / 令牌
（`mcp_gw_register`），或代码里调 `register_proxy`。注册时先拉对方 `tools/list` 逐个
登记，**拉不到就不落任何一条** —— 半截注册的结果是「工具表里有、调用必失败」，
比没有这个服务更难排查。调用时整包转发 JSON-RPC，对端 `isError` 原样回传（网关不拆包重包）。

server 名约束（`validate_server_name`）：非空、≤32 字符、只含小写字母/数字/连字符、
不能含 `__`、不能占用内置名。

### 插件 MCP 总开关（`disabled_servers`）

`GwConfig.disabled_servers`（`#[serde(default)]`，旧配置无此字段也能读）：

- 判据是「**不在关闭清单里就是开的**」——`server_enabled()`
- `list_tools` 过滤关闭的 server（关了就不该出现在 AI 的工具清单里）
- `call_tool` 对关闭的 server 报「整体关闭」并指路设置（不是「没有这个工具」）
- `save_config` 保留关闭清单（保存端口不能把总开关重置）
- `register` / `unregister` 时清理失效的关闭记录（重新注册同名服务不带着旧关态回来）

### 治理命令（七条）

`mcp_gw_start / mcp_gw_stop / mcp_gw_status / mcp_gw_save_config /
mcp_gw_register / mcp_gw_unregister / mcp_gw_set_server_enabled`

已按四件套登记：`js/command-caps.js` 定级（start/stop/register 为 **M** ——
改对外连接面的能力不扩散；set_server_enabled 为 **W**）、`js/invoke-policy.js` 的
settings 白名单、`mcp-gate-test.mjs` 跨文件钉住整条接线（`npm run test:mcp-gate`）、
`main.rs` 的 `generate_handler!`。

### 卸载协作

宿主 `removePlugin` 收口：按「服务名 = 插件 id 且 kind=proxy」匹配，命中先 confirm
说清后果，再 `mcp_gw_unregister`（插件没了，工具不能还挂在网关里）。查网关失败
不挡卸载。设置页三个移除入口统一走 chokepoint（`__nexusRemovePlugin`）读 `{ok, mcp}`。

---

## 四、MCP 客户端注册自愈（#42）

`register_clients()`（`mcp.rs` 尾部）。修各客户端全局配置里**已存在**的本服务条目：

- 候选路径：`%APPDATA%\TRAE SOLO CN\User\mcp.json`、`%APPDATA%\Trae CN\User\mcp.json`
  （取自原版 `McpRegistrationService.UpdateTraeGlobalMcpJson`）
- 键名 `nexus-panel-project-group`（`MCP_REGISTER_KEY`），或 command 指向本 exe 旧位置
  （判据是**文件名相同**，升级换路径后仍认得）才修；两者都不是 → 整条不动
  （那里可能登记着别的 MCP 服务，或用户故意配的包装脚本）
- 修正内容：`command` → 当前 exe 绝对路径；`args` → `["--stdio"]`

三条硬约束（沿原版设计）：
1. **绝不主动创建**文件或条目 —— 用户全局配置里有什么是他自己的事
2. **幂等**：只在确实不一致时才写
3. **原子写**：先 `.tmp` 再 rename，进程中断不残留半截文件

失败只返回一段说明，不往上抛 —— 锦上添花，不能因为自愈失败就让界面起不来。

---

## 五、待办状态（S1–S5 全部完成）

| 编号 | 项 | 状态 |
|---|---|---|
| ~~S1~~ | ~~工具名兼容层~~ | ✅ `ALIASES` 表 9 条；只在 `tools/call` 接受、进不了 `tools/list`、先于开关检查归一化 |
| ~~S2~~ | ~~补 3 个缺失工具~~ | ✅ `pick_screen_color` 已实现；`folder_icon_set_dll` / `refresh_content` 由别名等价解决（别名按设计不进清单，`tools/list` 里找不到 ≠ 缺失） |
| ~~S3~~ | ~~`create_folder` 补 `tab_index`~~ | ✅ 已带可选 `kind` + `tab_index`，建完即登记；越界先查再建防孤儿目录；登记逻辑抽成 `register_card` 与 `add_card` 共用 |
| ~~S4~~ | ~~stdio 模式~~ | ✅ `serve_stdio` 已实现且在 Tauri `Builder` **之前**拉起；入口参数是 `--stdio` 不是 `--mcp`；`mcp-stdio-test.mjs`（34 项）守护接线 |
| ~~S5~~ | ~~跨进程锁编译验证~~ | ✅ 2026-09-16 本地 `cargo build` 通过 |

> `close_mcp_on_exit`（退出时关 MCP，此前是死配置项）已接 `RunEvent::Exit`，
> 仅配置为 true 时关 —— 有人把 MCP 当常驻服务用。

---

## 六、验证方式

```bash
# 跨端契约（Rust 命令 ↔ TS 调用、DTO 字段；不含 MCP 工具名）
cd nexus-panel && node cross-end-check.mjs --strict

# MCP 网关接线（七条命令四处接线 + 总开关 + 卸载清理 + 负向自检）
cd nexus-panel && npm run test:mcp-gate

# stdio 模式接线（34 项）
node mcp-stdio-test.mjs
```

**工具清单不会与 README 脱节**：`mcp.rs` 的 `get_manual` 由 `tools()` 推导生成
（含「兼容别名」一节，唯一真源是 `ALIASES`），**不要手写工具表格**。
网关聚合的工具表同理由 `register_builtins` 的注册结果推导。

> 历史教训（第五次同类误判）：按工具名去 `tools/list` 里找别名命中的旧名，
> 会误判为「缺失」。核对缺失要么看 `tools()`，要么看 `ALIASES`，二选一即可结论。
