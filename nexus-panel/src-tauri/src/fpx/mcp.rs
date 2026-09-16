//! 内置 MCP server：让 AI 客户端直接调用本插件的能力。
//! ------------------------------------------------------------------
//! 原版是独立 McpServer.cs（30 个工具）；这里只暴露本插件**真实具备**的能力，
//! 用 std::net::TcpListener 手写 HTTP/1.1 + JSON-RPC 2.0，不引 axum/tokio。
//!
//! 端点：
//!   POST /mcp   JSON-RPC 2.0（initialize / tools/list / tools/call / ping）
//!   GET  /      健康检查，返回当前监听地址与工具数量
//! 仅绑定 127.0.0.1，不对外网开放。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use serde_json::{json, Value};
use tauri::AppHandle;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// 停服唤醒：accept 是非阻塞轮询，没有条件变量就得睡满一整拍才检查到 RUNNING。
static WAKE: (Mutex<u64>, Condvar) = (Mutex::new(0), Condvar::new());

/// 单个请求的 body 上限（8 MiB）。
///
/// 与 af_flow 的 webhook 同理：Content-Length 是客户端声明的，
/// 照它直接 `vec![0u8; n]` 等于把内存分配权交给对端。
const MAX_BODY: usize = 8 * 1024 * 1024;

/// 同时处理的连接上限。每连接一个线程，不设限会被慢速连接堆满线程。
const MAX_CONNS: usize = 32;

/// 当前操作对象（AI 用 select_folder 指定，后续带 target 的工具可省略参数）。
/// 存 (路径, 类别)，类别为 project / group / other。
static SELECTION: Mutex<Option<(String, String)>> = Mutex::new(None);

fn set_selection(path: &str, kind: &str) {
    if let Ok(mut g) = SELECTION.lock() {
        *g = Some((path.to_string(), kind.to_string()));
    }
}

fn get_selection_inner() -> Option<(String, String)> {
    SELECTION.lock().ok().and_then(|g| g.clone())
}

/// 取目标目录：优先用显式 target，其次用已选对象；都没有时按 require 决定报错还是返回 None。
fn resolve_target(args: &Value, require: bool) -> Result<Option<String>, String> {
    let t = args.get("target").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if !t.is_empty() { return Ok(Some(t)); }
    if let Some((p, _)) = get_selection_inner() { return Ok(Some(p)); }
    if require {
        return Err("未选择文件夹，请先 select_folder 或传 target".into());
    }
    Ok(None)
}

/// 启动 MCP server。port=0 时由系统分配空闲端口。返回实际监听地址。
pub fn serve(app: AppHandle, port: u16) -> Result<String, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("MCP server 已在运行".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("绑定端口失败: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?.to_string();

    // 非阻塞 accept：阻塞式的 incoming() 不关掉 socket 就永远不会返回，
    // 那样 stop() 只是置了个标志，线程卡在 accept 里、旧端口一直被占着。
    // 改成非阻塞 + 短睡眠轮询，stop 后 100ms 内线程即可退出。
    listener.set_nonblocking(true)
        .map_err(|e| format!("设置非阻塞失败: {e}"))?;

    /* 数据目录在这里解析一次，之后整个 server 只认路径、不认句柄。
       serve 仍收 AppHandle 是为了兼容现有调用方（setup 里传 app.handle()）。 */
    let dir = super::store::resolve_data_dir(&app)
        .map_err(|e| format!("无法定位数据目录: {e}"))?;

    std::thread::spawn(move || {
        let live = Arc::new(AtomicUsize::new(0));
        loop {
            if !RUNNING.load(Ordering::SeqCst) { break; }
            match listener.accept() {
                Ok((stream, _)) => {
                    // 监听句柄是非阻塞的，accept 出来的连接要显式转回阻塞：
                    // handle() 里的 set_read_timeout 只对阻塞 socket 有意义，
                    // 若继承了非阻塞，读会直接返回 WouldBlock，请求全部失败。
                    let _ = stream.set_nonblocking(false);

                    if live.load(Ordering::SeqCst) >= MAX_CONNS {
                        // 过载：直接关闭连接，而不是继续起线程
                        continue;
                    }
                    let live_c = live.clone();
                    live_c.fetch_add(1, Ordering::SeqCst);
                    let dir2 = dir.clone();
                    std::thread::spawn(move || {
                        handle(stream, dir2);
                        live_c.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // 条件变量代替 sleep：stop() 能立刻唤醒，无需等满 100ms
                    let (lock, cvar) = &WAKE;
                    match lock.lock() {
                        Ok(g) => { let _ = cvar.wait_timeout(g, std::time::Duration::from_millis(100)); }
                        Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
                    }
                }
                Err(_) => break,
            }
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(addr)
}

/* ---------------------------- stdio ---------------------------- */

/// 以 stdio 方式跑 MCP server（供 Claude Desktop 这类客户端拉起子进程）。
///
/// 协议是 MCP 规定的 **换行分隔 JSON**（不是 LSP 的 Content-Length 分帧）：
/// 一行一条 JSON-RPC 消息，stdin 读、stdout 写。
///
/// 为什么必须有这个模式：客户端拉起的是**子进程**，它只认 stdout。
/// HTTP 模式要额外知道端口，而端口是动态分配的，客户端无从得知。
///
/// 三条硬约束：
///
/// 1. **stdout 只能有 JSON-RPC。**
///    任何日志、panic 信息、Tauri 启动输出混进去都会让客户端解析失败。
///    所以本函数一行 println! 都没有，日志一律 eprintln!（走 stderr）。
///    也正因如此，它必须在 Tauri `Builder` **之前**调用 ——
///    一旦 run() 起来，Tauri 往 stdout 打了什么就不可控了。
///
/// 2. **每条消息后必须 flush。**
///    不 flush 的话内容留在缓冲区，客户端会一直等，表现为"卡住无响应"。
///
/// 3. **解析失败不能让循环崩。**
///    回一个 JSON-RPC -32700（Parse error）继续读下一行；
///    否则一行坏数据就把整个 server 打死，客户端只会看到"进程退出"。
pub fn serve_stdio(dir: PathBuf) -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取 stdin 失败: {e}"))?;
        if n == 0 {
            break; // EOF：客户端关闭了管道，正常退出
        }
        let text = line.trim();
        if text.is_empty() {
            continue;
        }

        let req: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                // -32700 Parse error。id 未知，按规范填 null。
                eprintln!("[mcp:stdio] 解析失败: {e}");
                write_out(
                    &mut out,
                    &json!({
                        "jsonrpc": "2.0", "id": Value::Null,
                        "error": { "code": -32700, "message": format!("解析失败: {e}") }
                    }),
                )?;
                continue;
            }
        };

        if let Some(resp) = dispatch_opt(&req, &dir) {
            write_out(&mut out, &resp)?;
        }
    }
    Ok(())
}

/// 写一行 JSON 并**立即 flush**（不 flush 客户端会一直等）。
fn write_out<W: Write>(out: &mut W, v: &Value) -> Result<(), String> {
    let text = serde_json::to_string(v).map_err(|e| format!("序列化响应失败: {e}"))?;
    writeln!(out, "{text}").map_err(|e| format!("写 stdout 失败: {e}"))?;
    out.flush().map_err(|e| format!("flush stdout 失败: {e}"))
}

pub fn stop() {
    // 标志置 false 后，线程最多再睡 100ms 就会退出并释放端口
    RUNNING.store(false, Ordering::SeqCst);
    // 唤醒正在 wait_timeout 的 accept 线程，让它马上看到标志并释放端口
    let (lock, cvar) = &WAKE;
    if let Ok(_g) = lock.lock() {
        cvar.notify_all();
    }
}
pub fn is_running() -> bool { RUNNING.load(Ordering::SeqCst) }

/* ---------------------------- HTTP ---------------------------- */

fn handle(mut stream: TcpStream, dir: PathBuf) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));

    // 借用式 BufReader：作用域结束后即可再用 stream 写回
    let (request_line, body, too_large) = {
        let mut reader = BufReader::new(&stream);

        let mut request_line = String::new();
        if BufRead::read_line(&mut reader, &mut request_line).is_err() { return; }

        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            match BufRead::read_line(&mut reader, &mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            if line == "\r\n" || line == "\n" { break; }
            if let Some(v) = line.to_lowercase().strip_prefix("content-length:") {
                // 解析失败按 0 处理；超大值由下面的 MAX_BODY 拦下
                content_length = v.trim().parse().unwrap_or(0);
            }
        }

        // 先校验再分配：绝不按声明长度直接 vec![0u8; content_length]。
        // 借用块内拿不到 &mut stream（reader 还借着它），先用标志带出去，出块再回包。
        let mut too_large = false;
        let mut body: Vec<u8> = Vec::with_capacity(content_length.min(64 * 1024));
        if content_length > MAX_BODY {
            too_large = true;
        } else if content_length > 0
            && reader
                .by_ref()
                .take(content_length as u64)
                .read_to_end(&mut body)
                .is_err()
        {
            return;
        }
        (request_line, body, too_large)
    };

    if too_large {
        write_raw(&mut stream, 413, br#"{"error":"payload too large"}"#);
        return;
    }

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    let method = parts.first().copied().unwrap_or("");
    let path = parts.get(1).copied().unwrap_or("/");

    let (status, payload) = match method {
        "GET" => (200, json!({
            "service": "nexus-panel/项目组分配",
            "running": true,
            "tools": tools().len(),
            "endpoint": "POST /mcp",
        })),
        "POST" if path.starts_with("/mcp") || path == "/" => {
            let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            // 通知（JSON-RPC 里没有 id 的请求）按规范不回包，回 204
            if req.get("id").is_none() {
                (204, Value::Null)
            } else {
                (200, dispatch(&req, &dir))
            }
        }
        "OPTIONS" => (204, json!(null)),
        _ => (404, json!({ "error": "not found" })),
    };

    let body_bytes = if status == 204 { Vec::new() } else { serde_json::to_vec(&payload).unwrap_or_default() };
    write_raw(&mut stream, status, &body_bytes);
}

/// 写 HTTP 响应（含 CORS 头，方便浏览器侧的 MCP 调试页直连）。
fn write_raw(stream: &mut TcpStream, status: u16, body: &[u8]) {
    let status_text = match status {
        200 => "OK",
        204 => "No Content",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut out = Vec::with_capacity(head.len() + body.len());
    out.extend_from_slice(head.as_bytes());
    out.extend_from_slice(body);
    let _ = stream.write_all(&out);
    let _ = stream.flush();
}

/* ---------------------------- JSON-RPC ---------------------------- */

/// 处理一个带 id 的 JSON-RPC 请求（通知在 handle 里已用 204 打发，不进这里）。
/// 分发一个 JSON-RPC 请求。
///
/// 返回 `None` 表示这是一条**通知**（没有 id），按 JSON-RPC 规范不应回复。
/// HTTP 模式下无所谓（总会回一个），但 stdio 模式下必须区分：
/// 客户端发的 `notifications/initialized` 若收到一个 id:null 的响应，
/// 部分客户端会当成协议错误直接断开。
fn dispatch_opt(req: &Value, dir: &Path) -> Option<Value> {
    // 没有 "id" 字段 = 通知。注意区分「没有 id」和「id 为 null」：
    // 后者是合法请求，客户端要的是 id:null 的响应。
    if !req.get("id").map(|v| !v.is_null()).unwrap_or(false)
        && !req.as_object().map(|o| o.contains_key("id")).unwrap_or(false)
    {
        return None;
    }
    Some(dispatch(req, dir))
}

fn dispatch(req: &Value, dir: &Path) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "nexus-panel-project-group", "version": "0.1.0" },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => match load_cfg(dir) {
            Ok(cfg) => Ok(json!({ "tools": enabled_tools(&cfg) })),
            Err(e) => Err(e),
        },
        "tools/call" => call_tool(req, dir),
        other => Err(json!({ "code": -32601, "message": format!("未知方法: {other}") })),
    };

    match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    }
}

fn tools() -> Vec<Value> {
    let tool = |name: &str, desc: &str, props: Value, required: Vec<&str>| json!({
        "name": name,
        "description": desc,
        "inputSchema": {
            "type": "object",
            "properties": props,
            "required": required,
        }
    });

    vec![
        tool("list_projects", "列出所有项目页签与卡片", json!({}), vec![]),
        tool("list_groups", "列出所有项目组页签与卡片", json!({}), vec![]),
        tool("list_links", "列出全部链接记录及其状态", json!({}), vec![]),
        tool("create_link", "为项目建立指向项目组的链接（分配）", json!({
            "project": { "type": "string", "description": "项目文件夹完整路径" },
            "group": { "type": "string", "description": "项目组文件夹完整路径" },
        }), vec!["project", "group"]),
        tool("remove_link", "撤销某项目下的链接", json!({
            "project": { "type": "string" },
        }), vec!["project"]),
        tool("scan_content", "扫描项目组下的 agent / skill / rule", json!({
            "root": { "type": "string", "description": "项目组目录" },
            "kind": { "type": "string", "enum": ["all", "agent", "skill", "rule"] },
        }), vec!["root"]),
        tool("read_file", "读取文件内容（目录型 skill 自动读 SKILL.md）", json!({
            "path": { "type": "string" },
        }), vec!["path"]),
        tool("create_folder", "新建项目 / 项目组文件夹（hierarchy 仅在设置里开启「路径携带层级」时生效）", json!({
            "parent": { "type": "string" },
            "name": { "type": "string" },
            "hierarchy": { "type": "string", "description": "可选，页签名；受设置项 createPathCarriesHierarchy 控制" },
        }), vec!["parent", "name"]),
        tool("add_card", "把文件夹加入页签（tab_index 省略时加到第一个页签）", json!({
            "kind": { "type": "string", "enum": ["project", "group"] },
            "path": { "type": "string" },
            "tab_index": { "type": "integer", "description": "可选，页签序号（0 起）；省略则加到第一个页签" },
        }), vec!["kind", "path"]),
        tool("set_lock", "设置 ACL 保护（防删除 / 防写入）", json!({
            "path": { "type": "string" },
            "denyDelete": { "type": "boolean" },
            "denyWrite": { "type": "boolean" },
        }), vec!["path"]),
        tool("set_tag_color", "设置卡片标签颜色（#RRGGBB，空串=恢复默认）", json!({
            "path": { "type": "string" },
            "color": { "type": "string" },
        }), vec!["path"]),
        tool("backup", "一键备份项目 / 项目组", json!({
            "kind": { "type": "string", "enum": ["project", "group"] },
            "appendOnly": { "type": "boolean", "description": "true=只新增更新，false=镜像同步" },
        }), vec!["kind"]),
        // ---- 与原版对齐、此前缺失的能力 ----
        tool("get_manual", "返回本服务全部工具的能力总览（Markdown 表格）", json!({}), vec![]),
        tool("get_status", "返回当前状态：数据目录、项目/项目组清单、链接数、当前选择", json!({}), vec![]),
        tool("select_folder", "指定当前操作对象（后续工具可省略 target）", json!({
            "path": { "type": "string", "description": "项目或项目组文件夹完整路径" },
        }), vec!["path"]),
        tool("get_selection", "获取当前操作对象及其 agent/skill/rule 内容", json!({}), vec![]),
        tool("lock_status", "查询某目录的 ACL 保护状态（防删除 / 防写入）", json!({
            "path": { "type": "string" },
        }), vec!["path"]),
        tool("folder_icon_set", "设置文件夹图标（受设置 iconAffectExplorer 影响是否写入 desktop.ini）", json!({
            "path": { "type": "string" },
            "icon": { "type": "string", "description": "图标文件绝对路径；支持 路径|索引 形式" },
        }), vec!["path", "icon"]),
        tool("folder_icon_get", "查询文件夹当前图标", json!({
            "path": { "type": "string" },
        }), vec!["path"]),
        tool("folder_icon_restore", "恢复文件夹为默认图标", json!({
            "path": { "type": "string" },
        }), vec!["path"]),
        tool("capture_screen", "截取整个屏幕，返回落盘路径", json!({
            "dir": { "type": "string", "description": "可选，保存目录；默认数据目录 shots/" },
        }), vec![]),
        tool("list_windows", "列举标题含关键字的可见窗口（仅 Windows）", json!({
            "keyword": { "type": "string", "description": "可选，为空则列全部" },
        }), vec![]),
        tool("capture_window", "按标题关键字截取单个窗口（仅 Windows）", json!({
            "title": { "type": "string" },
            "dir": { "type": "string", "description": "可选，保存目录" },
        }), vec!["title"]),
        tool("pick_screen_color", "取屏幕上某点的颜色，返回 #RRGGBB；x/y 省略时取当前鼠标所在点（仅 Windows）", json!({
            "x": { "type": "integer", "description": "可选，屏幕横坐标；与 y 一起省略则跟随鼠标" },
            "y": { "type": "integer", "description": "可选，屏幕纵坐标" },
        }), vec![]),
        tool("deploy_skill", "部署 skill：无 AI 命令时本地生成 SKILL.md 骨架，有则写入请求并拉起 AI", json!({
            "prompt": { "type": "string", "description": "skill 描述" },
            "target": { "type": "string", "description": "可选，目标目录；省略则用当前选择" },
            "agentCmd": { "type": "string", "description": "可选，临时指定 AI 客户端命令" },
        }), vec!["prompt"]),
    ]
}

/// MCP 总开关：false 时整个服务拒绝服务（与"停掉进程"区分开，配置可随时改回）。
fn service_enabled(cfg: &super::model::FpxConfig) -> bool {
    cfg.mcp_enabled
}

/// 单个工具是否暴露：config.mcpTools 里缺失视为开启（兼容旧配置）。
fn tool_enabled(cfg: &super::model::FpxConfig, name: &str) -> bool {
    cfg.mcp_tools.get(name).copied().unwrap_or(true)
}

/// 按 config.mcpTools 过滤后的工具清单（tools/list 用）。
pub fn enabled_tools(cfg: &super::model::FpxConfig) -> Vec<Value> {
    tools()
        .into_iter()
        .filter(|t| t.get("name").and_then(|n| n.as_str())
            .map(|n| tool_enabled(cfg, n))
            .unwrap_or(false))
        .collect()
}

/// 全部工具及其开关状态（设置面板用）。
/// 注意与 enabled_tools 的区别：这里**不**过滤，关掉的工具也要列出来，
/// 否则用户一旦关掉某个工具就再也找不回来、无法重新打开。
pub fn tool_rows(cfg: &super::model::FpxConfig) -> Vec<super::model::McpToolRow> {
    tools()
        .into_iter()
        .map(|t| {
            let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let desc = t.get("description").and_then(|n| n.as_str()).unwrap_or("").to_string();
            // 缺失视为开启，这里把默认值算好再发给前端
            let enabled = tool_enabled(cfg, &name);
            super::model::McpToolRow { name, desc, enabled }
        })
        .collect()
}

/**
 * 原版（WPF McpServer.cs）工具名 → 当前工具名 的兼容映射。
 * ====================================================================
 * 为什么需要：工具名改过，而用户侧的 AI 客户端配置 / 提示词里很可能
 * 已经写死了旧名字。没有这层，旧名字会直接落到「未知工具」分支，
 * 且错误不明显 —— 表现为"连上了但一直报错"，很难往工具名上想。
 *
 * 第三个元素是"改名后需要补的默认参数"：
 * 原版按类型拆成多个工具，现在合成一个靠参数区分（scan_content 的 kind）。
 * **只改名不补参数的话，list_agents 会返回 all（含 rule）** ——
 * 语义错误但不报错，比直接失败更难排查。
 *
 * 只在 tools/call 时接受，**不**进 tools/list：
 *   · 清单里冒出两套名字，AI 可能同时调两个，行为重复且难解释
 *   · 用户关掉实名后，别名不该还挂在清单里显得能用
 *
 * 这张表同时是 manual_text 里「兼容别名」一节的唯一真源 ——
 * 本文件一贯的做法是说明从清单推导，手写会与实际脱节。
 */
const ALIASES: &[(&str, &str, Option<(&str, &str)>)] = &[
    ("backup_now", "backup", None),
    ("lock_set", "set_lock", None),
    /* 三个 kind **必须成套**。
       原版把 scan_content 按类型拆成三个独立工具（agent / skill / rule），
       这里合成一个靠 kind 区分，所以三个旧名都要有别名。

       此前只补了 agent 与 skill，漏了 rule：
       旧配置里写 `list_rules` 的客户端会落到「未知工具」，
       而更糟的是 —— 就算它被当成 scan_content 处理，缺了 kind 也会返回
       all（含 agent/skill），**语义错误但不报错**，比直接失败更难排查。 */
    ("list_agents", "scan_content", Some(("kind", "agent"))),
    ("list_skills", "scan_content", Some(("kind", "skill"))),
    ("list_rules", "scan_content", Some(("kind", "rule"))),
    // 原版建项目 / 建项目组是两个工具，当前合并成 create_folder。
    // 注意：底层的 core_create_folder 本就不区分类型（第 5 参是 template
    // 而非 kind），所以这两个别名落到同一行为是**既有语义**，不是别名
    // 丢失了信息。要区分请用 add_card 指定 kind。
    ("create_project", "create_folder", None),
    ("create_group", "create_folder", None),
    /* 原版把「设图标」按来源拆成 ico 与 dll 两个工具。
       当前只有一个 folder_icon_set —— 它的 icon 参数本就支持
       `<ico 路径>` 与 `<dll 路径>|<索引>` 两种写法
       （见 sys.rs 里 apply_icon 的注释），所以 dll 那个旧名不是"缺失的能力"，
       只是旧名字。加一条别名即可，不必新建工具。 */
    ("folder_icon_set_dll", "folder_icon_set", None),
];

/// 把可能是原版名字的调用归一化成当前实名，返回 (实名, 需要补的默认参数)。
/// 不是别名则原样返回。
fn canonical_tool(name: &str) -> (&str, Option<(&str, &str)>) {
    for (old, new, patch) in ALIASES {
        if *old == name {
            return (new, *patch);
        }
    }
    (name, None)
}

fn call_tool(req: &Value, dir: &Path) -> Result<Value, Value> {
    let params = req.get("params").cloned().unwrap_or(json!({}));
    let raw = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let mut args = params.get("arguments").cloned().unwrap_or(json!({}));

    /* 别名归一化（原版工具名 → 当前实名）。
       ------------------------------------------------------------------
       **必须在查开关之前**：用实名查开关，才能保证"关掉 backup 之后
       backup_now 也跟着用不了"。反过来就会出现绕过去的口子 ——
       用户明明关了备份，换个旧名字照样能调。 */
    let (name, patch) = canonical_tool(raw);
    if let Some((k, v)) = patch {
        // 只在调用方没给这个参数时才补，不覆盖显式传参
        let missing = args.get(k).and_then(|x| x.as_str()).map(str::is_empty).unwrap_or(true);
        if missing {
            // 用 as_object_mut 而不是 args[k] = ...：
            // 后者依赖 Value 的 IndexMut<&str>，写法更短但这里没法编译验证，
            // 稳妥起见走明确分支。args 必是对象（来自 arguments 或 {}）。
            if let Some(obj) = args.as_object_mut() {
                obj.insert((*k).to_string(), json!(v));
            }
        }
    }

    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();

    // 先过开关，再谈执行：总开关关着就整个拒绝，单工具关着就只拒绝那一个
    let cfg = load_cfg(dir)?;
    if !service_enabled(&cfg) {
        return Err(err("MCP 服务已在设置中关闭"));
    }
    if !tool_enabled(&cfg, name) {
        // 走别名进来时提示一下等价关系：用户看到的是旧名字，
        // 配置里关的却是新名字，不给这句意会以为关错了工具。
        let hint = if name != raw { format!("（{raw} 即 {name}）") } else { String::new() };
        return Err(err(&format!("工具 {name} 已在设置中关闭{hint}")));
    }

    let out = match name {
        "list_projects" | "list_groups" => {
            let snap = snapshot(dir)?;
            let tabs = if name == "list_groups" { snap.group_tabs } else { snap.project_tabs };
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&tabs).unwrap_or_default() }] })
        }
        "list_links" => {
            let snap = snapshot(dir)?;
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&snap.links).unwrap_or_default() }] })
        }
        "create_link" => {
            let project = s("project");
            let group = s("group");
            if project.is_empty() || group.is_empty() { return Err(err("project 与 group 必填")); }
            let snap = super::core_create_link(&dir, &project, &group, None)
                .map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": format!("已分配，当前链接 {} 条", snap.links.len()) }] })
        }
        "remove_link" => {
            let snap = super::core_remove_link(&dir, &s("project"))
                .map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": format!("已撤销，剩余链接 {} 条", snap.links.len()) }] })
        }
        "scan_content" => {
            let kind = if s("kind").is_empty() { "all".to_string() } else { s("kind") };
            let items = super::fpx_scan_content(s("root"), Some(kind));
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&items).unwrap_or_default() }] })
        }
        "read_file" => {
            let text = super::fpx_read_file(s("path"), Some(20000)).map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": text }] })
        }
        "create_folder" => {
            // 注意：kind 是 project/group，不是页签名，绝不能当 hierarchy 传
            // （那会建出 父目录\project\名称 这种错误层级）。
            // 层级走独立的 hierarchy 参数，未给则不拼。
            let hierarchy = args.get("hierarchy").and_then(|v| v.as_str()).map(str::to_string);
            let p = super::core_create_folder(&dir, &s("parent"), &s("name"),
                hierarchy.as_deref(), None)
                .map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": p }] })
        }
        "add_card" => {
            let kind = s("kind");
            let path = s("path");
            if path.is_empty() { return Err(err("path 必填")); }
            // 用 as_u64 而不是 as_i64：JSON 里没有负数这种页签序号，
            // as_u64 顺带挡掉 -1 这种（as_i64 会收下，然后转 usize 时溢出）。
            let tab_index = args.get("tab_index").and_then(|v| v.as_u64()).map(|v| v as usize);
            // 必须在事务内「读→改→写」。
            // 若先 load_cfg 改完再 core_save_config，传进去的是旧快照，
            // core_save_config 会拿它整份覆盖磁盘 —— 期间别人的改动就丢了。
            let (tab_name, already) = super::store::with_config(&dir, |cfg| {
                let tabs = if kind == "group" { &mut cfg.group_tabs } else { &mut cfg.project_tabs };
                if tabs.is_empty() { tabs.push(super::model::TabItem { name: "默认".into(), items: vec![] }); }
                /* tab_index 缺省时沿用旧行为（第一个页签），多页签场景下
                   AI 才能指定目标 —— 此前写死 tabs[0]，只能往第一个页签加。

                   越界判断必须放在闭包里：tabs 的长度只有这里拿得到，
                   挪到外面就得先读一次配置，既多一次 IO 又可能读到已被
                   别的进程改过的快照。 */
                let idx = match tab_index {
                    Some(i) => {
                        if i >= tabs.len() {
                            return Err(format!(
                                "tab_index {i} 越界：{kind} 类当前只有 {} 个页签（有效范围 0..{}）",
                                tabs.len(),
                                tabs.len().saturating_sub(1)));
                        }
                        i
                    }
                    None => 0,
                };
                let tab_name = tabs[idx].name.clone();
                let already = tabs[idx].items.iter().any(|x| x == &path);
                if !already { tabs[idx].items.push(path.clone()); }
                Ok((tab_name, already))
            }).map_err(|e| err(&e))?;
            let text = if already {
                format!("{path} 已在页签「{tab_name}」中，未重复添加")
            } else {
                format!("已把 {path} 加入页签「{tab_name}」")
            };
            json!({ "content": [{ "type": "text", "text": text }] })
        }
        "set_lock" => {
            let dd = args.get("denyDelete").and_then(|v| v.as_bool()).unwrap_or(false);
            let dw = args.get("denyWrite").and_then(|v| v.as_bool()).unwrap_or(false);
            super::core_set_lock(&dir, &s("path"), dd, dw).map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": format!("保护已更新：防删除={dd} 防写入={dw}") }] })
        }
        "set_tag_color" => {
            let path = s("path");
            let color = s("color");
            // 用只改颜色的版本：不先读 folder_icons 再传回去，
            // 那样会把读到的旧图标写回，覆盖期间别人设的新图标。
            super::core_set_tag_color(&dir, &path,
                if color.is_empty() { None } else { Some(color) })
                .map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": "标签颜色已保存" }] })
        }
        "backup" => {
            let kind = if s("kind") == "group" { "group" } else { "project" };
            let append_only = args.get("appendOnly").and_then(|v| v.as_bool()).unwrap_or(true);
            let cfg = super::store::load_config(&dir);
            // summary 是方法不是字段，别写成 r.summary
            let r = super::backup::run(&cfg, &dir, kind, append_only);
            json!({ "content": [{ "type": "text", "text": r.summary() }] })
        }
        // ---- 与原版对齐、此前缺失的能力 ----
        "get_manual" => {
            json!({ "content": [{ "type": "text", "text": manual_text(&dir) }] })
        }
        "get_status" => {
            let snap = snapshot(dir)?;
            let cfg = load_cfg(dir)?;
            let projects: Vec<String> = snap.project_tabs.iter().flat_map(|t| t.items.iter().map(|c| c.path.clone())).collect();
            let groups: Vec<String> = snap.group_tabs.iter().flat_map(|t| t.items.iter().map(|c| c.path.clone())).collect();
            let sel = get_selection_inner().map(|(p, k)| json!({ "path": p, "kind": k }));
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&json!({
                "configPath": dir.join("config.json").to_string_lossy(),
                "recordPath": dir.join("link-record.json").to_string_lossy(),
                "projects": projects,
                "groups": groups,
                "linkCount": snap.links.len(),
                "chainClient": cfg.chain_client,
                "selection": sel,
            })).unwrap_or_default() }] })
        }
        "select_folder" => {
            let path = s("path");
            if path.is_empty() { return Err(err("缺少参数 path")); }
            // 用 symlink_metadata 判定，不跟随链接：项目目录里大量使用 junction，
            // 跟随判定会把链接背后的目录当成"另一个真实目录"登记进来，
            // 后续备份 / 递归遍历就可能顺着它绕回自身
            let p = std::path::Path::new(&path);
            if super::fsutil::is_link(p) {
                return Err(err(&format!("不支持符号链接路径，请传入真实目录: {path}")));
            }
            if !super::fsutil::is_real_dir(p) { return Err(err(&format!("文件夹不存在: {path}"))); }
            // 判定类别：先看项目组再看项目，都不在则是 other（仍可选，只是类别不明）
            let snap = snapshot(dir)?;
            let key = super::store::normalize_key(&path);
            let in_group = snap.group_tabs.iter().flat_map(|t| t.items.iter())
                .any(|c| super::store::normalize_key(&c.path) == key);
            let in_project = snap.project_tabs.iter().flat_map(|t| t.items.iter())
                .any(|c| super::store::normalize_key(&c.path) == key);
            let kind = if in_group { "group" } else if in_project { "project" } else { "other" };
            set_selection(&path, kind);
            let items = super::fpx_scan_content(path.clone(), Some("all".to_string()));
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&json!({
                "selection": { "path": path, "kind": kind },
                "content": items,
            })).unwrap_or_default() }] })
        }
        "get_selection" => {
            match get_selection_inner() {
                None => json!({ "content": [{ "type": "text", "text": "当前未选择任何文件夹，请先 select_folder" }] }),
                Some((p, k)) => {
                    let items = super::fpx_scan_content(p.clone(), Some("all".to_string()));
                    json!({ "content": [{ "type": "text", "text": serde_json::to_string(&json!({
                        "selection": { "path": p, "kind": k },
                        "content": items,
                    })).unwrap_or_default() }] })
                }
            }
        }
        "lock_status" => {
            let path = s("path");
            if path.is_empty() { return Err(err("缺少参数 path")); }
            let cfg = super::store::load_config(&dir);
            let (dd, dw) = match super::store::lock_of(&cfg, &path) {
                Some(l) => (l.deny_delete, l.deny_write),
                None => (false, false),
            };
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&json!({
                "path": path, "locked": dd || dw, "denyDelete": dd, "denyWrite": dw,
            })).unwrap_or_default() }] })
        }
        "folder_icon_set" => {
            let path = s("path");
            let icon = s("icon");
            if path.is_empty() || icon.is_empty() { return Err(err("path 与 icon 必填")); }
            // 同上：不跟随符号链接
            if !super::fsutil::is_real_dir(std::path::Path::new(&path)) {
                return Err(err(&format!("目录不存在: {path}")));
            }
            // 事务内改配置 + 落 desktop.ini：apply_icon 失败则不落盘
            let note = super::store::with_config(&dir, |cfg| {
                cfg.folder_icons.insert(path.clone(), icon.clone());
                if cfg.icon_affect_explorer {
                    super::sys::apply_icon(&path, &icon)?;
                    Ok("已写入 desktop.ini，资源管理器同步生效".to_string())
                } else {
                    Ok("已记录到配置（界面内生效，未写入资源管理器）".to_string())
                }
            }).map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": note }] })
        }
        "folder_icon_get" => {
            let path = s("path");
            if path.is_empty() { return Err(err("缺少参数 path")); }
            let cfg = super::store::load_config(&dir);
            let cur = cfg.folder_icons.get(&path).cloned()
                .or_else(|| {
                    let key = super::store::normalize_key(&path);
                    cfg.folder_icons.iter()
                        .find(|(k, _)| super::store::normalize_key(k) == key)
                        .map(|(_, v)| v.clone())
                });
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&json!({
                "path": path,
                "iconAffectExplorer": cfg.icon_affect_explorer,
                "icon": cur,
            })).unwrap_or_default() }] })
        }
        "folder_icon_restore" => {
            let path = s("path");
            if path.is_empty() { return Err(err("缺少参数 path")); }
            super::store::with_config(&dir, |cfg| {
                let key = super::store::normalize_key(&path);
                cfg.folder_icons.retain(|k, _| super::store::normalize_key(k) != key);
                if cfg.icon_affect_explorer {
                    // 空 icon_ref = 恢复默认（删除 desktop.ini 并去掉 +s）
                    let _ = super::sys::apply_icon(&path, "");
                }
                Ok(())
            }).map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": "已恢复默认图标" }] })
        }
        "capture_screen" => {
            let target = match args.get("dir").and_then(|v| v.as_str()) {
                Some(d) if !d.trim().is_empty() => std::path::PathBuf::from(d.trim()),
                _ => dir.join("shots"),
            };
            let r = super::screen::capture(&target).map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&r).unwrap_or_default() }] })
        }
        "list_windows" => {
            let list = super::screen::list_windows(&s("keyword")).map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&list).unwrap_or_default() }] })
        }
        "capture_window" => {
            let title = s("title");
            if title.is_empty() { return Err(err("缺少参数 title")); }
            let target = match args.get("dir").and_then(|v| v.as_str()) {
                Some(d) if !d.trim().is_empty() => std::path::PathBuf::from(d.trim()),
                _ => dir.join("shots"),
            };
            let r = super::screen::capture_window(&target, &title).map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&r).unwrap_or_default() }] })
        }
        /* 吸管取色。
           ------------------------------------------------------------------
           后端 `sys::pick_screen_color` 早已实现（色盘吸管在用），
           命令 `fpx_pick_color` 也已注册 —— 这里只是把它接进 MCP。

           两个要注意的点：

           ① **非 Windows 必须明确报错**，不能静默给个默认值。
              这一点 `sys.rs` 里已经做了（`#[cfg(not(windows))]` 版本返回 Err，
              并提示改用 RGB/HEX 输入），这里直接透传即可，不要改成"返回空串"。

           ② 坐标**可以省略**：省略时取当前鼠标所在的点。
              这不是"参数缺失"的错误，而是一条真实且常用的路径 ——
              AI 没法预知用户想取哪，跟随鼠标才是对的用法。
              所以必填列表是空的，不写 vec!["x","y"]。 */
        "pick_screen_color" => {
            let coord = |k: &str| -> Result<Option<i32>, Value> {
                match args.get(k).and_then(|v| v.as_i64()) {
                    None => Ok(None),
                    // 超范围就报错，不要静默回退成"跟随鼠标"——
                    // 那样 AI 以为取了指定坐标，实际取的是鼠标处，错了还不知道
                    Some(n) => i32::try_from(n).map(Some)
                        .map_err(|_| err(&format!("{k} 超出有效范围: {n}"))),
                }
            };
            let x = coord("x")?;
            let y = coord("y")?;
            let hex = super::sys::pick_screen_color(x, y).map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": hex }] })
        }
        "deploy_skill" => {
            let prompt = s("prompt");
            if prompt.trim().is_empty() { return Err(err("缺少参数 prompt（skill 描述）")); }
            let target = resolve_target(&args, false).map_err(|e| err(&e))?
                .ok_or_else(|| err("未指定目标文件夹，请先 select_folder 或传 target"))?;

            let cfg = super::store::load_config(&dir);
            // 目标为项目组时自动落到其 skill 目录（与界面行为一致）
            let deploy_base = if let Some(sd) = super::content::skill_dir_of(&target) {
                sd
            } else {
                std::path::Path::new(&target).join("skill")
            };

            // 摘锁创建：skill 目录可能是受保护项目组的子孙，直接 CreateDir 会被拒绝
            let _guard = super::LockGuard::new(&target, super::store::lock_of(&cfg, &target));
            if !deploy_base.is_dir() {
                std::fs::create_dir_all(&deploy_base)
                    .map_err(|e| err(&format!("创建 skill 目录失败: {e}")))?;
            }
            drop(_guard);

            // 有 AI 命令 → 写请求文件并拉起；否则本地生成 SKILL.md 骨架
            let agent_cmd = s("agentCmd");
            let cmd = if agent_cmd.trim().is_empty() { cfg.chain_client.clone().unwrap_or_default() } else { agent_cmd };

            if !cmd.trim().is_empty() {
                let req = deploy_base.join("_deploy-request.json");
                let body = json!({ "prompt": prompt, "target": deploy_base.to_string_lossy() });
                std::fs::write(&req, serde_json::to_string_pretty(&body).unwrap_or_default())
                    .map_err(|e| err(&format!("写入请求文件失败: {e}")))?;
                // 注意用 send_command 而非 send：这里拿到的是一条命令行，不是客户端 id
                let r = super::chain::send_command(&cmd, &deploy_base.to_string_lossy(), &prompt);
                json!({ "content": [{ "type": "text", "text": serde_json::to_string(&json!({
                    "mode": "agent",
                    "deployBase": deploy_base.to_string_lossy(),
                    "requestFile": req.to_string_lossy(),
                    "ok": r.ok,
                    "message": r.message,
                })).unwrap_or_default() }] })
            } else {
                let r = local_skill_scaffold(&deploy_base, &prompt).map_err(|e| err(&e))?;
                json!({ "content": [{ "type": "text", "text": serde_json::to_string(&json!({
                    "mode": "local",
                    "deployBase": deploy_base.to_string_lossy(),
                    "name": r.0,
                    "skillDir": r.1,
                    "skillFile": r.2,
                    "note": "已在 skill 目录生成本地骨架（SKILL.md），在 AI 客户端中重新打开该分组即可加载",
                })).unwrap_or_default() }] })
            }
        }
        other => {
            /* 走到这里说明既不是实名、也没有落到任何已实现的分支。
               若它是从某个别名归一化来的，把原名字一并报出来 ——
               典型场景是"删了工具却忘了删 ALIASES 里的旧名"，
               只报新名字的话很难看出是这条映射失效了。 */
            let from = if other != raw {
                format!("（由 {raw} 映射而来，该映射可能已失效）")
            } else {
                String::new()
            };
            return Err(err(&format!("未知工具: {other}{from}")));
        }
    };
    Ok(out)
}

/**
 * 生成工具能力总览（Markdown 表格），内容由 tools() 推导，
 * 与 tools/list 永远一致 —— 手写说明会和实际清单脱节。
 */
fn manual_text(data_dir: &std::path::Path) -> String {
    let mut rows = String::new();
    for t in tools() {
        let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("").replace('|', "\\|");
        let schema = t.get("inputSchema");
        let props = schema.and_then(|s| s.get("properties"))
            .and_then(|p| p.as_object())
            .map(|m| m.keys().cloned().collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        let req = schema.and_then(|s| s.get("required"))
            .and_then(|r| r.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        rows.push_str(&format!("| {name} | {desc} | {} | {} |\n",
            if props.is_empty() { "无".to_string() } else { props },
            if req.is_empty() { "-".to_string() } else { req }));
    }
    /* 兼容别名一节同样从 ALIASES 推导，而不是手写 ——
       手写的话，将来加一条别名忘了改这里，AI 拿到的总览就是错的，
       而它恰恰是 AI 判断"该调哪个工具"的依据。 */
    let mut compat = String::new();
    for (old, new, patch) in ALIASES {
        let note = match patch {
            Some((k, v)) => format!("等价于 `{new}`，并自动补 `{k}={v}`"),
            None => format!("等价于 `{new}`"),
        };
        compat.push_str(&format!("- `{old}` — {note}\n"));
    }

    format!(
        "本 MCP 服务「项目组分配」工具能力总览：\n\n| 工具 | 说明 | 参数 | 必填 |\n|---|---|---|---|\n{rows}\n\
         兼容的旧版工具名（调用时会自动转换，不在上方清单中重复列出）：\n{compat}\n\
         数据目录：{}\n用法：先 select_folder 指定操作对象，其后多数工具可省略 target。",
        data_dir.to_string_lossy()
    )
}

/// 本地生成 skill 骨架：目录名由描述清洗得来，同名自动加序号避让（永不覆盖已有内容）。
/// 返回 (最终名称, 目录, SKILL.md 路径)。
fn local_skill_scaffold(base: &std::path::Path, prompt: &str) -> Result<(String, String, String), String> {
    let base_name = sanitize_name(prompt);
    if base_name.is_empty() { return Err("skill 描述清洗后为空，请换个说法".into()); }

    let (final_name, dir) = {
        let mut n = base_name.clone();
        let mut p = base.join(&n);
        let mut i = 2;
        while p.exists() {
            n = format!("{base_name}{i}");
            p = base.join(&n);
            i += 1;
        }
        (n, p)
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 skill 目录失败: {e}"))?;

    let file = dir.join("SKILL.md");
    let md = format!(
        "---\nname: {final_name}\ndescription: {prompt}\n---\n\n# {final_name}\n\n> 由「项目组分配」MCP server 本地脚手架生成。\n\n## 用途\n{prompt}\n\n## 用法\n（在此补充该 skill 的具体步骤、命令或工具调用。）\n\n## 注意事项\n- 此文件由脚手架生成，内容需你完善。\n"
    );
    std::fs::write(&file, md).map_err(|e| format!("写入 SKILL.md 失败: {e}"))?;

    Ok((final_name,
        dir.to_string_lossy().to_string(),
        file.to_string_lossy().to_string()))
}

/// 把描述清洗成合法目录名：保留中英文数字与 - _ ，其余转空格再压成一个 -
fn sanitize_name(raw: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in raw.trim().chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
            last_dash = false;
        } else if c.is_whitespace() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            if !out.is_empty() && !last_dash {
                out.push('-');
                last_dash = true;
            }
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    // 不能直接 &trimmed[..60]：中文每字 3 字节，硬切片落在字符中间会 panic。
    // 先退到最近的合法边界再截。
    if trimmed.len() > 60 {
        let end = super::store::safe_truncate_at(&trimmed, 60);
        trimmed[..end].trim_end_matches('-').to_string()
    } else {
        trimmed
    }
}

fn err(msg: &str) -> Value {
    json!({ "code": -32000, "message": msg })
}

/* ---------------------------- 后端访问 ---------------------------- */

/* 数据目录由调用方解析好后传进来，mcp.rs 自身不再依赖 AppHandle。

   为什么要这样改：
   stdio 模式必须在 Tauri `Builder` **之前**跑起来（见 serve_stdio），
   那时还没有 AppHandle 可用。而 mcp.rs 里所有 app 的用途只有一件事 ——
   解析数据目录。把依赖从「句柄」降为「路径」，stdio 就能复用整条工具链，
   不必为它另写一套。

   HTTP 模式仍由 serve() 从 AppHandle 现算一次，行为与改动前一致。 */
fn load_cfg(dir: &Path) -> Result<super::model::FpxConfig, Value> {
    Ok(super::store::load_config(dir))
}

fn snapshot(dir: &Path) -> Result<super::model::Snapshot, Value> {
    Ok(super::core_snapshot(dir))
}

/// 供命令层查询运行状态（前端展示用）。
pub fn status() -> Value {
    json!({ "running": is_running() })
}
