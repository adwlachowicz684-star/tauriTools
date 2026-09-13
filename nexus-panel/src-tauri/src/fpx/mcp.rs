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

use serde_json::{json, Value};
use tauri::AppHandle;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// 启动 MCP server。port=0 时由系统分配空闲端口。返回实际监听地址。
pub fn serve(app: AppHandle, port: u16) -> Result<String, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("MCP server 已在运行".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("绑定端口失败: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?.to_string();

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if !RUNNING.load(Ordering::SeqCst) { break; }
            match stream {
                Ok(s) => {
                    let app2 = app.clone();
                    std::thread::spawn(move || handle(s, app2));
                }
                Err(_) => continue,
            }
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(addr)
}

pub fn stop() { RUNNING.store(false, Ordering::SeqCst); }
pub fn is_running() -> bool { RUNNING.load(Ordering::SeqCst); }

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
        other => return Err(err(&format!("未知工具: {other}"))),
    };
    Ok(out)
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

fn snapshot(app: &AppHandle) -> Result<super::Snapshot, Value> {
    let dir = data_dir_of(app)?;
    Ok(super::core_snapshot(&dir))
}

/// 供命令层查询运行状态（前端展示用）。
pub fn status() -> Value {
    json!({ "running": is_running() })
}
