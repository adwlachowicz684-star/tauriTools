# MCP 整体架构方案

> 基于当前代码实证（`src-tauri/src/fpx/mcp.rs` 801 行、`mod.rs`、`main.rs`）。
> 所有数字与结论均经过代码核对，不是估算。

---

## 一、当前实现（事实）

| 项 | 现状 |
|---|---|
| 传输 | **HTTP over TCP**，手写 HTTP/1.1 + JSON-RPC 2.0，**不引 axum / tokio** |
| 监听 | `TcpListener::bind(("127.0.0.1", port))`，仅本机 |
| 方法 | `initialize` / `tools/list` / `tools/call` / `ping` |
| 工具数 | **24 个**（由 `tools()` 定义推导，README 已同步） |
| 入口 | `fpx_mcp_start` / `fpx_mcp_stop` / `fpx_mcp_status` / `fpx_mcp_tools` |
| 进程模型 | GUI 进程内线程；`--mcp` 是**另一个 exe 实例** |
| 工具开关 | `config.mcp_tools`（逐工具，`tools/list` 按此过滤） |

**24 个工具**：

```
list_projects · list_groups · list_links · create_link · remove_link
scan_content · read_file · create_folder · add_card · set_lock
set_tag_color · backup · get_manual · get_status · select_folder
get_selection · lock_status · folder_icon_set · folder_icon_get
folder_icon_restore · capture_screen · list_windows · capture_window
deploy_skill
```

### 当前比原版多出的（勿删）

`add_card`、`set_tag_color`、`read_file` —— 原版没有，因本版前端需要而加。

---

## 二、与原版（WPF）的架构差异 ⚠️ 最关键的一节

| | 原版 | 当前 |
|---|---|---|
| 传输 | **stdio JSON-RPC**（`--mcp`，不开窗口） | **HTTP over TCP** |
| 进程 | AI 客户端拉起独立进程，stdin/stdout 通信 | GUI 内线程；或 `--mcp` 独立进程 |
| 并发 | 两个进程可能并存，靠**跨进程 Mutex** 保护 | 已补文件锁（见下） |

### 差异 1：工具名变了，照原版 README 配置会全失败

| 原版 | 当前 | 说明 |
|---|---|---|
| `backup_now` | `backup` | **改名，无别名** |
| `lock_set` | `set_lock` | 改名 |
| `list_agents` + `list_skills` | `scan_content` | 合并 |
| `create_project` + `create_group` | `create_folder` | 合并 |
| `pick_screen_color` | — | 未实现 |
| `folder_icon_set_dll` | — | 未实现 |
| `refresh_content` | — | 未实现 |

**风险**：任何按原版文档写的 AI 客户端配置，调用 `backup_now` / `lock_set` 会**全部失败**，且错误不明显。

**建议**：要么加别名映射，要么在 README 显著位置列新旧对照表（当前 README 只列了当前名）。

### 差异 2：`--mcp` 的位置 ⚠️ 影响 S4 可行性

**`--mcp` 不在 `cli.rs`**，而在 `main.rs` 的 Tauri `Builder` 的 `setup` 里——关掉主窗口后再 `serve()`。

```
cli.rs  → 只处理 --self-check / --migrate-*
main.rs → Builder.setup() 里处理 --mcp（关窗口 → serve）
```

**后果**：`--mcp` 实例仍然加载了**完整 Tauri 栈**（webview、插件注册表全初始化），只是不显示窗口。

**对 stdio 模式（S4）的硬约束**：
> Tauri 自己会往 stdout 打东西，而 stdio 模式要求 stdout **只能**输出 JSON-RPC。
> 所以 stdio 分支**必须挪到 `main()` 最前面、在 `Builder` 之前**处理。
> 否则一条 Tauri 的启动日志就会污染协议流，导致 AI 客户端解析失败——
> 且这类失败表现为"连上了但一直报错"，极难定位。

### 差异 3：跨进程数据竞争（已修）

原版有 `Global\` 命名 Mutex 保护 config 与账本。

当前两个进程（GUI + `--mcp`）会同时读写同一份 config。已补：
- 文件锁（`create_new` 原子创建，10s 超时报错不强抢）
- 进程内可重入（`thread_local!` 记层数）
- 覆盖 `with_config` / `with_records` / `save_config` / `save_records`
- 竞态落点 `core_create_link` / `core_remove_link` 已并入事务

**待验证**：Rust 端尚未编译过（沙箱无 cargo），需本地 `cargo build` 确认。

---

## 三、待办与优先级

| 编号 | 项 | 说明 |
|---|---|---|
| S1 | **工具名兼容层** | 加 `backup_now → backup` 等别名，或在 README 列对照表 |
| S2 | **补 3 个缺失工具** | `pick_screen_color`、`folder_icon_set_dll`、`refresh_content` |
| S3 | `create_folder` 补 `tab_index` | 让 AI 能指定加入哪个页签，多页签场景必需 |
| S4 | **stdio 模式** | 必须挪到 `Builder` 之前；见差异 2 |
| S5 | 跨进程锁编译验证 | 依赖本地 `cargo build` |

**S1 建议优先**——它是唯一会造成"用户按文档配置完完全不能用"的问题，且改动小（别名映射或文档）。

---

## 四、验证方式

```bash
# 跨端契约（命令/DTO，不含 MCP 工具名）
cd nexus-panel && node cross-end-check.mjs --strict

# 工具清单是否与 README 一致（由 tools() 自动推导，不会脱节）
# mcp.rs 里 get_manual 会生成 Markdown 表格，与 tools/list 永远一致
```

> `mcp.rs` 的 `get_manual` 由 `tools()` 推导生成，
> **手写说明会和实际清单脱节**，所以不要手写工具表格。
