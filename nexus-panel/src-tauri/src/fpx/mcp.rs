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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::AppHandle;

static RUNNING: AtomicBool = AtomicBool::new(false);

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

    std::thread::spawn(move || {
        loop {
            if !RUNNING.load(Ordering::SeqCst) { break; }
            match listener.accept() {
                Ok((stream, _)) => {
                    // 监听句柄是非阻塞的，accept 出来的连接要显式转回阻塞：
                    // handle() 里的 set_read_timeout 只对阻塞 socket 有意义，
                    // 若继承了非阻塞，读会直接返回 WouldBlock，请求全部失败。
                    let _ = stream.set_nonblocking(false);
                    let app2 = app.clone();
                    std::thread::spawn(move || handle(stream, app2));
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(addr)
}

pub fn stop() {
    // 标志置 false 后，线程最多再睡 100ms 就会退出并释放端口
    RUNNING.store(false, Ordering::SeqCst);
}
pub fn is_running() -> bool { RUNNING.load(Ordering::SeqCst) }

/* ---------------------------- HTTP ---------------------------- */

fn handle(mut stream: TcpStream, app: AppHandle) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));

    // 借用式 BufReader：作用域结束后即可再用 stream 写回
    let (request_line, body) = {
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
                content_length = v.trim().parse().unwrap_or(0);
            }
        }

        let mut body = vec![0u8; content_length];
        if content_length > 0 && Read::read_exact(&mut reader, &mut body).is_err() { return; }
        (request_line, body)
    };

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
                (200, dispatch(&req, &app))
            }
        }
        "OPTIONS" => (204, json!(null)),
        _ => (404, json!({ "error": "not found" })),
    };

    let body_bytes = if status == 204 { Vec::new() } else { serde_json::to_vec(&payload).unwrap_or_default() };
    let status_text = match status { 200 => "OK", 204 => "No Content", 404 => "Not Found", _ => "Error" };
    let head = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nConnection: close\r\n\r\n",
        body_bytes.len()
    );
    let mut out = Vec::with_capacity(head.len() + body_bytes.len());
    out.extend_from_slice(head.as_bytes());
    out.extend_from_slice(&body_bytes);
    let _ = stream.write_all(&out);
    let _ = stream.flush();
}

/* ---------------------------- JSON-RPC ---------------------------- */

/// 处理一个带 id 的 JSON-RPC 请求（通知在 handle 里已用 204 打发，不进这里）。
fn dispatch(req: &Value, app: &AppHandle) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "nexus-panel-project-group", "version": "0.1.0" },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => {
            let cfg = load_cfg(app)?;
            Ok(json!({ "tools": enabled_tools(&cfg) }))
        }
        "tools/call" => call_tool(req, app),
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
        tool("add_card", "把文件夹加入页签", json!({
            "kind": { "type": "string", "enum": ["project", "group"] },
            "path": { "type": "string" },
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

fn call_tool(req: &Value, app: &AppHandle) -> Result<Value, Value> {
    let params = req.get("params").cloned().unwrap_or(json!({}));
    let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();

    // 先过开关，再谈执行：总开关关着就整个拒绝，单工具关着就只拒绝那一个
    let cfg = load_cfg(app)?;
    if !service_enabled(&cfg) {
        return Err(err("MCP 服务已在设置中关闭"));
    }
    if !tool_enabled(&cfg, name) {
        return Err(err(&format!("工具 {name} 已在设置中关闭")));
    }

    let out = match name {
        "list_projects" | "list_groups" => {
            let snap = snapshot(app)?;
            let tabs = if name == "list_groups" { snap.group_tabs } else { snap.project_tabs };
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&tabs).unwrap_or_default() }] })
        }
        "list_links" => {
            let snap = snapshot(app)?;
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&snap.links).unwrap_or_default() }] })
        }
        "create_link" => {
            let project = s("project");
            let group = s("group");
            if project.is_empty() || group.is_empty() { return Err(err("project 与 group 必填")); }
            let dir = data_dir_of(app)?;
            let snap = super::core_create_link(&dir, &project, &group, None)
                .map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": format!("已分配，当前链接 {} 条", snap.links.len()) }] })
        }
        "remove_link" => {
            let dir = data_dir_of(app)?;
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
            let dir = data_dir_of(app)?;
            let p = super::core_create_folder(&dir, &s("parent"), &s("name"),
                hierarchy.as_deref(), None)
                .map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": p }] })
        }
        "add_card" => {
            let kind = s("kind");
            let path = s("path");
            if path.is_empty() { return Err(err("path 必填")); }
            let dir = data_dir_of(app)?;
            // 必须在事务内「读→改→写」。
            // 若先 load_cfg 改完再 core_save_config，传进去的是旧快照，
            // core_save_config 会拿它整份覆盖磁盘 —— 期间别人的改动就丢了。
            let (tab_name, already) = super::store::with_config(&dir, |cfg| {
                let tabs = if kind == "group" { &mut cfg.group_tabs } else { &mut cfg.project_tabs };
                if tabs.is_empty() { tabs.push(super::model::TabItem { name: "默认".into(), items: vec![] }); }
                let tab_name = tabs[0].name.clone();
                let already = tabs[0].items.iter().any(|x| x == &path);
                if !already { tabs[0].items.push(path.clone()); }
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
            let dir = data_dir_of(app)?;
            super::core_set_lock(&dir, &s("path"), dd, dw).map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": format!("保护已更新：防删除={dd} 防写入={dw}") }] })
        }
        "set_tag_color" => {
            let path = s("path");
            let color = s("color");
            let dir = data_dir_of(app)?;
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
            let dir = data_dir_of(app)?;
            let cfg = super::store::load_config(&dir);
            // summary 是方法不是字段，别写成 r.summary
            let r = super::backup::run(&cfg, &dir, kind, append_only);
            json!({ "content": [{ "type": "text", "text": r.summary() }] })
        }
        // ---- 与原版对齐、此前缺失的能力 ----
        "get_manual" => {
            let dir = data_dir_of(app)?;
            json!({ "content": [{ "type": "text", "text": manual_text(&dir) }] })
        }
        "get_status" => {
            let dir = data_dir_of(app)?;
            let snap = snapshot(app)?;
            let cfg = load_cfg(app)?;
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
            if !std::path::Path::new(&path).is_dir() { return Err(err(&format!("文件夹不存在: {path}"))); }
            // 判定类别：先看项目组再看项目，都不在则是 other（仍可选，只是类别不明）
            let snap = snapshot(app)?;
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
            let dir = data_dir_of(app)?;
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
            if !std::path::Path::new(&path).is_dir() { return Err(err(&format!("目录不存在: {path}"))); }
            let dir = data_dir_of(app)?;
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
            let dir = data_dir_of(app)?;
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
            let dir = data_dir_of(app)?;
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
            let dir = data_dir_of(app)?;
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
            let dir = data_dir_of(app)?;
            let target = match args.get("dir").and_then(|v| v.as_str()) {
                Some(d) if !d.trim().is_empty() => std::path::PathBuf::from(d.trim()),
                _ => dir.join("shots"),
            };
            let r = super::screen::capture_window(&target, &title).map_err(|e| err(&e))?;
            json!({ "content": [{ "type": "text", "text": serde_json::to_string(&r).unwrap_or_default() }] })
        }
        "deploy_skill" => {
            let prompt = s("prompt");
            if prompt.trim().is_empty() { return Err(err("缺少参数 prompt（skill 描述）")); }
            let target = resolve_target(&args, false).map_err(|e| err(&e))?
                .ok_or_else(|| err("未指定目标文件夹，请先 select_folder 或传 target"))?;

            let dir = data_dir_of(app)?;
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
        other => return Err(err(&format!("未知工具: {other}"))),
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
    format!(
        "本 MCP 服务「项目组分配」工具能力总览：\n\n| 工具 | 说明 | 参数 | 必填 |\n|---|---|---|---|\n{rows}\n\n数据目录：{}\n用法：先 select_folder 指定操作对象，其后多数工具可省略 target。",
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

/// 直接解析数据目录，不依赖 State（MCP 线程不是 Tauri 命令，拿不到 State）。
fn data_dir_of(app: &AppHandle) -> Result<PathBuf, Value> {
    super::store::resolve_data_dir(app).map_err(|e| err(&e))
}

fn load_cfg(app: &AppHandle) -> Result<super::model::FpxConfig, Value> {
    let dir = data_dir_of(app)?;
    Ok(super::store::load_config(&dir))
}

fn snapshot(app: &AppHandle) -> Result<super::model::Snapshot, Value> {
    let dir = data_dir_of(app)?;
    Ok(super::core_snapshot(&dir))
}

/// 供命令层查询运行状态（前端展示用）。
pub fn status() -> Value {
    json!({ "running": is_running() })
}
