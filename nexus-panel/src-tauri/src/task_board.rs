//! task_board — 任务管理器本地 HTTP API 服务。
//!
//! 定位：给「多 AI 窗口 + agent-flow 流程」提供统一的任务存取通道。
//! 数据落在单一 tasks.json（数据目录由插件设置决定，默认 app_data_dir/task-board/），
//! 看板 UI、AI 窗口（curl）、agent-flow（generic-http 节点）三方共用这一份数据。
//!
//! 路由（全部 JSON，端口默认 9911，绑 127.0.0.1）：
//!   GET    /api/health              服务探活
//!   GET    /api/tasks               全量任务 + 窗口身份列表
//!   GET    /api/tasks/{id}          单条任务
//!   POST   /api/tasks               新建 {title, detail?, priority?, tags?, reporter?}
//!   PATCH  /api/tasks/{id}          改字段/流转 {status?, assignee?, priority?, title?,
//!                                   detail?, tags?, by?, note?}
//!   POST   /api/tasks/{id}/events   追加事件 {by, action, note?}
//!   POST   /api/agents              注册窗口身份 {id, name?, role?}
//!
//! 校验：token 非空时要求请求头 X-TB-Token 匹配（防本机其他程序静默调用）；
//! 留空则不校验（单机自用场景，用户在设置里自选）。
//!
//! 实现沿用 af_flow webhook 的既有形状：非阻塞 accept + 停止标志 + 连接上限 +
//! 读超时。写盘走「临时文件 + rename」原子替换，读到的坏 JSON 直接报错——
//! 任务数据不允许被静默重置。

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::{Manager, State};

/// 每个任务保留的历史事件上限（防无限增长）。
const HISTORY_CAP: usize = 100;
/// 合法任务状态（前端状态机与此一致，双端各自校验）。
const STATUSES: [&str; 5] = ["todo", "claimed", "doing", "review", "done"];

/// 文件级全局锁：看板 UI 与 HTTP 服务两条写通道都要过它，
/// 否则「读-改-写」序列会被对方插在半途。
fn file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 任务服务共享状态：端口 -> 运行中的服务 + 当前授权的数据目录。
/// 数据目录是显式授权的（tb_set_data_dir / tb_http_start 登记），
/// 读写命令只认授权目录 —— 不给自己开任意文件读写的后门。
pub struct TbState {
    pub servers: Mutex<HashMap<u16, TbServerEntry>>,
    pub data_dir: Mutex<Option<PathBuf>>,
}

pub struct TbServerEntry {
    stop: Arc<AtomicBool>,
    wake: Arc<(Mutex<bool>, Condvar)>,
}

// ---------------------------------------------------------------- 数据目录授权

/// 登记数据目录（插件设置里选/改目录时调用）。创建目录并写入授权表。
#[tauri::command]
pub fn tb_set_data_dir(state: State<'_, TbState>, dir: String) -> Result<String, String> {
    Ok(tb_set_data_dir_inner(&state, &dir)?.to_string_lossy().to_string())
}

fn tb_set_data_dir_inner(state: &TbState, dir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(dir);
    if path.as_os_str().is_empty() {
        return Err("数据目录不能为空".to_string());
    }
    fs::create_dir_all(&path).map_err(|e| format!("创建数据目录失败 {}: {}", path.display(), e))?;
    let canon = path.canonicalize().unwrap_or(path);
    let mut guard = state.data_dir.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(canon.clone());
    Ok(canon)
}

fn authorized_dir(state: &TbState, dir: &str) -> Result<PathBuf, String> {
    let want = PathBuf::from(dir);
    let canon = if want.exists() {
        want.canonicalize().unwrap_or(want.clone())
    } else {
        want.clone()
    };
    let guard = state.data_dir.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(allowed) if *allowed == canon => Ok(canon),
        _ => Err("该数据目录尚未授权（请先在设置里确认目录）".to_string()),
    }
}

// ---------------------------------------------------------------- 文件读写（看板 UI 通道）

/// 读 tasks.json 原文；文件不存在返回 None（调用方按空库处理）。
#[tauri::command]
pub fn tb_read_store(state: State<'_, TbState>, dir: String) -> Result<Option<String>, String> {
    let base = authorized_dir(&state, &dir)?;
    let _lock = file_lock().lock().unwrap_or_else(|e| e.into_inner());
    let file = base.join("tasks.json");
    if !file.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&file).map_err(|e| format!("读取 tasks.json 失败: {}", e))?;
    Ok(Some(text))
}

/// 原子写 tasks.json（先 .tmp 再 rename），调用方负责 JSON 合法性。
///
/// `expect_text` 是乐观锁：调用方把「本次修改所基于的那份原文」原样传回，
/// 锁内与当前盘上内容比对——不一致说明别的通道（HTTP / 另一个 UI）已插队写入，
/// 拒绝本次覆盖（错误以 TB_CONFLICT 开头，前端据此重读重试）。
/// 不传则退回「最后写入者获胜」。
#[tauri::command]
pub fn tb_write_store(
    state: State<'_, TbState>,
    dir: String,
    json: String,
    expect_text: Option<String>,
) -> Result<(), String> {
    let base = authorized_dir(&state, &dir)?;
    // 落盘前先验一遍：坏 JSON 写进去，下次所有通道都读不出来
    serde_json::from_str::<Value>(&json).map_err(|e| format!("拒绝写入非法 JSON: {}", e))?;
    let _lock = file_lock().lock().unwrap_or_else(|e| e.into_inner());
    let file = base.join("tasks.json");
    if let Some(expect) = &expect_text {
        let cur = if file.exists() {
            fs::read_to_string(&file).unwrap_or_default()
        } else {
            String::new()
        };
        if cur != *expect {
            return Err("TB_CONFLICT: tasks.json 已被其他通道修改，请重读后重试".to_string());
        }
    }
    let tmp = base.join("tasks.json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写临时文件失败: {}", e))?;
    fs::rename(&tmp, &file).map_err(|e| format!("替换 tasks.json 失败: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------- 命令

/// 默认数据目录：app_data_dir/task-board（与 project-group 平级，互不干扰）。
/// 插件设置里可改到任意目录；没配过就用这个。
#[tauri::command]
pub fn tb_default_dir(app: tauri::AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    let dir = base.join("task-board");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录 {}: {}", dir.display(), e))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 启动 HTTP 服务。返回实际使用的 token（留空时为 ""）。
/// 端口已被本服务占用时直接报错，避免把旧服务的数据目录悄悄换掉。
/// `notify_url` 非空时：任务经 HTTP 进入 review 会向它 POST 一份通知
/// （agent-flow webhook 触发器地址，见 docs/AGENT-FLOW.md）。
#[tauri::command]
pub fn tb_http_start(
    state: State<'_, TbState>,
    port: u16,
    token: String,
    data_dir: String,
    notify_url: String,
) -> Result<String, String> {
    // 起服务的目录必须先进授权表（UI 改设置时已授权；这里兜底再授一次）
    let dir = tb_set_data_dir_inner(&state, &data_dir)?;

    let mut map = state.servers.lock().unwrap_or_else(|e| e.into_inner());
    if map.contains_key(&port) {
        return Err(format!("端口 {} 上的任务服务已在运行，请先停止再改配置", port));
    }

    let tasks_file = dir.join("tasks.json");
    if !tasks_file.exists() {
        let _lock = file_lock().lock().unwrap_or_else(|e| e.into_inner());
        if !tasks_file.exists() {
            save_tasks(&dir, &empty_store())?;
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("绑定端口 {} 失败（可能已被占用）: {}", port, e))?;
    // 非阻塞 + 停止标志，保证 stop 后能及时退出而不卡在 accept
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置非阻塞失败: {}", e))?;

    let stop = Arc::new(AtomicBool::new(false));
    let wake = Arc::new((Mutex::new(false), Condvar::new()));
    let stop_c = stop.clone();
    let wake_c = wake.clone();
    let token_c = token.clone();
    let dir_c = dir.clone();
    let notify_c = notify_url.clone();

    thread::spawn(move || {
        // 并发连接上限：连上不发数据的慢速连接不能把线程堆爆
        const MAX_CONNS: usize = 32;
        let live = Arc::new(AtomicUsize::new(0));

        loop {
            if stop_c.load(Ordering::Relaxed) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    if live.load(Ordering::Relaxed) >= MAX_CONNS {
                        let mut s = stream;
                        write_response(&mut s, 503, r#"{"ok":false,"error":"too many connections"}"#);
                        continue;
                    }
                    let live_c = live.clone();
                    live_c.fetch_add(1, Ordering::Relaxed);
                    let dir_t = dir_c.clone();
                    let token_t = token_c.clone();
                    let notify_t = notify_c.clone();
                    thread::spawn(move || {
                        let mut s = stream;
                        let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
                        // 写超时：持全局文件锁期间写响应，慢客户端不能拖死其他通道
                        let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
                        handle_conn(&mut s, &dir_t, &token_t, &notify_t);
                        live_c.fetch_sub(1, Ordering::Relaxed);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // 没连接就睡，停止时被唤醒立即退
                    let (lock, cv) = &*wake_c;
                    let mut flag = lock.lock().unwrap_or_else(|e| e.into_inner());
                    if !*flag {
                        let (guard, _) = cv
                            .wait_timeout(flag, Duration::from_millis(500))
                            .unwrap_or_else(|e| e.into_inner());
                        flag = guard;
                    }
                    if *flag {
                        break;
                    }
                }
                Err(_) => continue,
            }
        }
    });

    map.insert(
        port,
        TbServerEntry {
            stop,
            wake: wake.clone(),
        },
    );
    Ok(token)
}

/// 停止指定端口的服务。
#[tauri::command]
pub fn tb_http_stop(state: State<'_, TbState>, port: u16) -> Result<(), String> {
    let mut map = state.servers.lock().unwrap_or_else(|e| e.into_inner());
    match map.remove(&port) {
        Some(entry) => {
            entry.stop.store(true, Ordering::Relaxed);
            let (lock, cv) = &*entry.wake;
            if let Ok(mut flag) = lock.lock() {
                *flag = true;
                cv.notify_all();
            }
            Ok(())
        }
        None => Err(format!("端口 {} 上没有运行中的任务服务", port)),
    }
}

// ---------------------------------------------------------------- HTTP

struct Request {
    method: String,
    path: String,
    body: String,
    token_header: String,
}

fn handle_conn(stream: &mut TcpStream, dir: &PathBuf, expect_token: &str, notify_url: &str) {
    let req = match read_request(stream) {
        Some(r) => r,
        None => {
            write_response(stream, 400, r#"{"ok":false,"error":"bad request"}"#);
            return;
        }
    };

    // 预检直接放行（本机 API，CORS 只图方便）
    if req.method == "OPTIONS" {
        write_response(stream, 204, "");
        return;
    }

    if !expect_token.is_empty() && req.token_header != *expect_token {
        write_response(stream, 401, r#"{"ok":false,"error":"bad token"}"#);
        return;
    }

    // 一次请求一把文件锁：读-改-写序列不允许被另一个请求插在半途
    let _lock = file_lock().lock().unwrap_or_else(|e| e.into_inner());
    let resp = route(&req, dir);
    // 通知在锁外发：spawn_notify 不碰 file_lock，但也不该拖住响应写回
    if let Some(body) = &resp.2 {
        spawn_notify(notify_url, body);
    }
    write_response(stream, resp.0, &resp.1);
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_uppercase();
    let path = parts.next()?.to_string();

    let mut content_length = 0usize;
    let mut token_header = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim();
            if key == "content-length" {
                content_length = val.parse().unwrap_or(0);
            } else if key == "x-tb-token" {
                token_header = val.to_string();
            }
        }
    }

    let mut body = String::new();
    if content_length > 0 {
        // 限长：请求体过大直接拒，防内存被撑爆
        const MAX_BODY: usize = 4 * 1024 * 1024;
        if content_length > MAX_BODY {
            return None;
        }
        let mut buf = vec![0u8; content_length];
        reader.read_exact(&mut buf).ok()?;
        body = String::from_utf8_lossy(&buf).to_string();
    }

    Some(Request {
        method,
        path,
        body,
        token_header,
    })
}

/// 路由返回 (HTTP 状态码, 响应体, 待发通知 body)。
/// 第三项非空时由 handle_conn 在锁外 fire-and-forget POST 给 notify_url。
fn route(req: &Request, dir: &PathBuf) -> (u16, String, Option<String>) {
    let path = req.path.split('?').next().unwrap_or(&req.path);
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    let ok_json = |v: Value| (200, v.to_string(), None);

    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["api", "health"]) => ok_json(json!({"ok": true, "service": "task-board"})),
        ("GET", ["api", "tasks"]) => match load_tasks(dir) {
            Ok(store) => ok_json(json!({"ok": true, "tasks": store.get("tasks").cloned().unwrap_or(json!([])),
                       "agents": store.get("agents").cloned().unwrap_or(json!([]))})),
            Err(e) => (500, err_json(&e), None),
        },
        ("GET", ["api", "tasks", id]) => match load_tasks(dir) {
            Ok(store) => match find_task(&store, id) {
                Some(t) => ok_json(json!({"ok": true, "task": t})),
                None => (404, r#"{"ok":false,"error":"task not found"}"#.to_string(), None),
            },
            Err(e) => (500, err_json(&e), None),
        },
        ("POST", ["api", "tasks"]) => match parse_body(&req.body) {
            Ok(body) => match create_task(dir, &body) {
                Ok(t) => ok_json(json!({"ok": true, "task": t})),
                Err(e) => (500, err_json(&e), None),
            },
            Err(e) => (400, err_json(&e), None),
        },
        ("PATCH", ["api", "tasks", id]) => match parse_body(&req.body) {
            Ok(body) => match patch_task(dir, id, &body) {
                Ok((t, became_review)) => {
                    // 送审即通知（agent-flow 审查流程的触发源，AI 通道与 UI 通道行为对齐）
                    let notice = became_review.then(|| {
                        json!({
                            "source": "task-board",
                            "event": "submit-review",
                            "task": t,
                        })
                        .to_string()
                    });
                    (200, json!({"ok": true, "task": t}).to_string(), notice)
                }
                Err(e) => (500, err_json(&e), None),
            },
            Err(e) => (400, err_json(&e), None),
        },
        ("POST", ["api", "tasks", id, "events"]) => match parse_body(&req.body) {
            Ok(body) => match add_event(dir, id, &body) {
                Ok(t) => (200, json!({"ok": true, "task": t}).to_string(), None),
                Err(e) => (500, err_json(&e), None),
            },
            Err(e) => (400, err_json(&e), None),
        },
        ("POST", ["api", "agents"]) => match parse_body(&req.body) {
            Ok(body) => match register_agent(dir, &body) {
                Ok(agents) => (200, json!({"ok": true, "agents": agents}).to_string(), None),
                Err(e) => (500, err_json(&e), None),
            },
            Err(e) => (400, err_json(&e), None),
        },
        ("POST", ["mcp"]) => {
            // MCP JSON-RPC 2.0 端点：鉴权已在上游 handle_conn 统一做过
            let (code, body) = mcp_handle(&req.body, dir);
            (code, body, None)
        }
        _ => (404, r#"{"ok":false,"error":"not found"}"#.to_string(), None),
    }
}

/// 把通知 body POST 给 notify_url（fire-and-forget：失败静默，不重试不阻塞）。
/// 目标是本机 agent-flow webhook（纯 http），手写 TcpStream 就够，不引 HTTP 客户端。
fn spawn_notify(notify_url: &str, body: &str) {
    if notify_url.trim().is_empty() {
        return;
    }
    let url = notify_url.to_string();
    let body = body.to_string();
    thread::spawn(move || {
        // 只认 http://host[:port]/path，https 目标不在本机 webhook 场景内
        let rest = match url.strip_prefix("http://") {
            Some(r) => r,
            None => {
                eprintln!("[task-board] 通知地址不是 http://，已忽略: {}", url);
                return;
            }
        };
        let (host_port, path) = match rest.split_once('/') {
            Some((hp, p)) => (hp.to_string(), format!("/{}", p)),
            None => (rest.to_string(), "/".to_string()),
        };
        let mut stream = match TcpStream::connect(&host_port) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[task-board] 通知连不上 {}: {}", host_port, e);
                return;
            }
        };
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let head = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            path,
            host_port,
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body.as_bytes());
        let _ = stream.flush();
        // 不读响应：webhook 只需要收到，HTTP/1.1 close 语义下直接断开
    });
}

fn err_json(e: &str) -> String {
    json!({"ok": false, "error": e}).to_string()
}

fn parse_body(body: &str) -> Result<Value, String> {
    if body.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(body).map_err(|e| format!("请求体不是合法 JSON: {}", e))
}

// ---------------------------------------------------------------- MCP（JSON-RPC 2.0）

// 端点 POST /mcp：把任务能力暴露为 MCP 工具，外部 AI 客户端
// （WorkBuddy / Claude 等）直连 http://127.0.0.1:<port>/mcp 即可，
// 不必 curl。鉴权复用 X-TB-Token（handle_conn 统一校验）。
// 协议形状与 fpx/mcp.rs 保持一致（initialize/ping/tools/list/tools/call，
// 无 id = 通知不回包），但工具表独立——这里是任务能力，那里是 fpx 能力。

/// MCP 工具表。6 个工具覆盖任务全生命周期，参数与 HTTP API 一致。
///
/// pub：MCP 网关（mcp_gate.rs）启动时按它逐个注册（与自身 /mcp 端点
/// 同一份表，不另抄一遍——抄两份必然漂移）。
pub fn mcp_tools() -> Vec<Value> {
    let tool = |name: &str, desc: &str, props: Value, required: Vec<&str>| json!({
        "name": name,
        "description": desc,
        "inputSchema": { "type": "object", "properties": props, "required": required },
    });

    vec![
        tool(
            "tb_list_tasks",
            "列出任务看板全部任务（可按状态/优先级/标签/认领人/关键词过滤）",
            json!({
                "status":   { "type": "string", "enum": ["todo", "claimed", "doing", "review", "done"], "description": "按状态过滤，缺省=全部" },
                "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"], "description": "按优先级过滤" },
                "tag":      { "type": "string", "description": "按标签过滤" },
                "assignee": { "type": "string", "description": "按认领人过滤；传 \"__none__\" 查未认领" },
                "q":        { "type": "string", "description": "关键词，匹配标题/详情/id" },
            }),
            vec![],
        ),
        tool(
            "tb_create_task",
            "新建任务（发现问题→建任务交给其他窗口认领）",
            json!({
                "title":    { "type": "string", "description": "一句话说清问题" },
                "detail":   { "type": "string", "description": "复现步骤/期望行为，可选" },
                "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"], "description": "默认 P2" },
                "tags":     { "type": "array", "items": { "type": "string" }, "description": "自由标签" },
                "reporter": { "type": "string", "description": "报告人窗口 ID，缺省 manual" },
            }),
            vec!["title"],
        ),
        tool(
            "tb_get_task",
            "查单条任务详情（含全部历史事件）",
            json!({ "id": { "type": "string", "description": "任务 id，如 tb-0001" } }),
            vec!["id"],
        ),
        tool(
            "tb_update_task",
            "流转/修改任务：认领、开工、提交审查、通过、打回、退回、改字段",
            json!({
                "id":       { "type": "string", "description": "任务 id" },
                "status":   { "type": "string", "enum": ["todo", "claimed", "doing", "review", "done"], "description": "目标状态（流转图校验：todo/claimed 不可直跳 done）" },
                "assignee": { "type": "string", "description": "认领人；已被他人认领会被拒绝；空串=释放认领" },
                "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"], "description": "改优先级" },
                "title":    { "type": "string", "description": "改标题" },
                "detail":   { "type": "string", "description": "改详情" },
                "tags":     { "type": "array", "items": { "type": "string" }, "description": "整体替换标签" },
                "by":       { "type": "string", "description": "操作者窗口 ID，进历史" },
                "note":     { "type": "string", "description": "备注；打回时必填原因" },
            }),
            vec!["id"],
        ),
        tool(
            "tb_add_event",
            "给任务追加备注/进展（不改状态）",
            json!({
                "id":     { "type": "string", "description": "任务 id" },
                "by":     { "type": "string", "description": "操作者窗口 ID" },
                "action": { "type": "string", "description": "事件类型，缺省 note" },
                "note":   { "type": "string", "description": "内容" },
            }),
            vec!["id"],
        ),
        tool(
            "tb_register_agent",
            "注册本窗口身份（首次使用先登记，认领/流转时署名用它）",
            json!({
                "id":   { "type": "string", "description": "窗口 ID，如 dev-a" },
                "name": { "type": "string", "description": "显示名，可选" },
                "role": { "type": "string", "enum": ["dev", "review", "manual"], "description": "缺省 dev" },
            }),
            vec!["id"],
        ),
    ]
}

/// tools/call 分发：业务函数与 HTTP 路由共用同一份（同一把锁下执行），
/// 业务失败走 MCP 约定的 isError 内容，而不是 JSON-RPC error——
/// 让 AI 读得到失败原因并自行调整参数重试。
///
/// pub：MCP 网关（mcp_gate.rs）代理转发用 —— 转发时**不拆包重包**，
/// 对端（这里是网关回传）看到的 isError 原样可达 AI 客户端。
pub fn mcp_call_tool(name: &str, args: &Value, dir: &PathBuf) -> Value {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|x| x.to_string());
    let result: Result<Value, String> = match name {
        "tb_list_tasks" => (|| -> Result<Value, String> {
            let store = load_tasks(dir)?;
            let tasks = store
                .get("tasks")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let status = s("status");
            let priority = s("priority");
            let tag = s("tag");
            let assignee = s("assignee");
            let q = s("q").map(|x| x.to_lowercase());
            let hit: Vec<&Value> = tasks
                .iter()
                .filter(|t| {
                    if let Some(st) = &status {
                        if t.get("status").and_then(|v| v.as_str()) != Some(st.as_str()) {
                            return false;
                        }
                    }
                    if let Some(p) = &priority {
                        if t.get("priority").and_then(|v| v.as_str()) != Some(p.as_str()) {
                            return false;
                        }
                    }
                    if let Some(tag) = &tag {
                        let has = t
                            .get("tags")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().any(|x| x.as_str() == Some(tag.as_str())))
                            .unwrap_or(false);
                        if !has {
                            return false;
                        }
                    }
                    if let Some(asg) = &assignee {
                        let cur = t.get("assignee").and_then(|v| v.as_str()).unwrap_or("");
                        if asg == "__none__" {
                            if !cur.is_empty() {
                                return false;
                            }
                        } else if cur != asg.as_str() {
                            return false;
                        }
                    }
                    if let Some(q) = &q {
                        let hay = format!(
                            "{} {} {}",
                            t.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                            t.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                            t.get("detail").and_then(|v| v.as_str()).unwrap_or("")
                        )
                        .to_lowercase();
                        if !hay.contains(q.as_str()) {
                            return false;
                        }
                    }
                    true
                })
                .collect();
            Ok(json!({ "count": hit.len(), "tasks": hit }))
        })(),
        "tb_create_task" => create_task(dir, args).map(|t| json!({ "created": t })),
        "tb_get_task" => (|| -> Result<Value, String> {
            let id = s("id").unwrap_or_default();
            let store = load_tasks(dir)?;
            match find_task(&store, &id) {
                Some(t) => Ok(json!({ "task": t })),
                None => Err(format!("任务 {id} 不存在")),
            }
        })(),
        "tb_update_task" => {
            patch_task(dir, &s("id").unwrap_or_default(), args).map(|(t, review)| {
                json!({ "updated": t, "review_notice_sent": review })
            })
        }
        "tb_add_event" => {
            add_event(dir, &s("id").unwrap_or_default(), args).map(|t| json!({ "task": t }))
        }
        "tb_register_agent" => {
            register_agent(dir, args).map(|a| json!({ "agents": a }))
        }
        other => Err(format!("未知工具: {other}")),
    };

    match result {
        Ok(v) => json!({
            "content": [{ "type": "text", "text": v.to_string() }],
        }),
        Err(e) => json!({
            "content": [{ "type": "text", "text": e }],
            "isError": true,
        }),
    }
}

/// JSON-RPC 2.0 分发。返回 None = 通知（无 id），调用方回 202 空体。
fn mcp_dispatch(req: &Value, dir: &PathBuf) -> Option<Value> {
    // 「没有 id」= 通知；「id: null」= 合法请求，要回 id:null 的响应
    let is_notification = !req
        .as_object()
        .map(|o| o.contains_key("id"))
        .unwrap_or(false);
    if is_notification {
        return None;
    }

    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "nexus-panel-task-board", "version": "1.0.0" },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": mcp_tools() })),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            Ok(mcp_call_tool(name, &args, dir))
        }
        other => Err(json!({ "code": -32601, "message": format!("未知方法: {other}") })),
    };

    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    })
}

/// POST /mcp 的请求体可能是一批 JSON-RPC（数组=batch），逐条分发。
fn mcp_handle(body: &str, dir: &PathBuf) -> (u16, String) {
    let parsed: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            return (
                400,
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":format!("解析失败: {e}")}})
                    .to_string(),
            );
        }
    };

    let responses: Vec<Value> = match parsed {
        Value::Array(batch) => batch
            .iter()
            .filter_map(|req| mcp_dispatch(req, dir))
            .collect(),
        single => match mcp_dispatch(&single, dir) {
            Some(resp) => vec![resp],
            None => vec![], // 纯通知：202 空体
        },
    };

    if responses.is_empty() {
        (202, String::new())
    } else if responses.len() == 1 {
        (200, responses[0].to_string())
    } else {
        (200, Value::Array(responses).to_string())
    }
}

// ---------------------------------------------------------------- 数据

fn empty_store() -> Value {
    json!({"v": 1, "nextId": 1, "tasks": [], "agents": []})
}

fn load_tasks(dir: &PathBuf) -> Result<Value, String> {
    let file = dir.join("tasks.json");
    if !file.exists() {
        return Ok(empty_store());
    }
    let text = fs::read_to_string(&file).map_err(|e| format!("读取 tasks.json 失败: {}", e))?;
    let mut store: Value =
        serde_json::from_str(&text).map_err(|e| format!("tasks.json 已损坏（拒绝覆盖写）: {}", e))?;
    if !store.is_object() {
        return Err("tasks.json 顶层不是对象（拒绝覆盖写）".to_string());
    }
    let obj = store.as_object_mut().unwrap();
    for key in ["tasks", "agents"] {
        if !obj.get(key).map(|v| v.is_array()).unwrap_or(false) {
            obj.insert(key.to_string(), json!([]));
        }
    }
    if !obj.get("nextId").map(|v| v.is_number()).unwrap_or(false) {
        obj.insert("nextId".to_string(), json!(1));
    }
    Ok(store)
}

/// 原子写：先写 .tmp 再 rename，半途掉电也不会留下半个 JSON。
fn save_tasks(dir: &PathBuf, store: &Value) -> Result<(), String> {
    let file = dir.join("tasks.json");
    let tmp = dir.join("tasks.json.tmp");
    let text = serde_json::to_string_pretty(store).map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&tmp, text).map_err(|e| format!("写临时文件失败: {}", e))?;
    fs::rename(&tmp, &file).map_err(|e| format!("替换 tasks.json 失败: {}", e))?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn find_task<'a>(store: &'a Value, id: &str) -> Option<&'a Value> {
    store
        .get("tasks")?
        .as_array()?
        .iter()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id))
}

fn push_history(task: &mut Map<String, Value>, by: &str, action: &str, note: &str) {
    let entry = json!({"at": now_ms(), "by": by, "action": action, "note": note});
    let hist = task
        .entry("history")
        .or_insert_with(|| json!([]));
    if let Some(arr) = hist.as_array_mut() {
        arr.push(entry);
        if arr.len() > HISTORY_CAP {
            let excess = arr.len() - HISTORY_CAP;
            arr.drain(0..excess);
        }
    }
}

fn str_field(body: &Value, key: &str) -> Option<String> {
    body.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// 状态流转图：与前端 plugins/task-board/core.mjs 的 canTransition 逐字对齐
/// （双端各自校验，防 HTTP 通道绕过看板规则——如 todo 直跳 done 淌过审查）。
///
/// 有守卫盯着：regression-guard-test.mjs 第 22 节会逐档比对这张表，
/// 连 MCP schema 里的 enum 一起盯（改了它们 AI 就调不通）。
/// 反向路径都在：claimed→todo / doing→todo 退回，review→doing 打回，done→review 重开。
fn can_transition(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    let allowed: &[(&str, &[&str])] = &[
        ("todo", &["claimed", "doing"]),
        ("claimed", &["doing", "todo"]),
        ("doing", &["review", "todo"]),
        ("review", &["done", "doing"]),
        ("done", &["review"]),
    ];
    allowed
        .iter()
        .find(|(f, _)| *f == from)
        .map(|(_, ts)| ts.contains(&to))
        .unwrap_or(false)
}

fn create_task(dir: &PathBuf, body: &Value) -> Result<Value, String> {
    let title = str_field(body, "title").unwrap_or_default();
    if title.trim().is_empty() {
        return Err("title 不能为空".to_string());
    }
    // 新建只允许 todo：想认领/开工/送审走 PATCH，别在建任务时一步跳过整个流程
    if let Some(s) = str_field(body, "status") {
        if s != "todo" {
            return Err(format!(
                "新建任务只允许 status=todo（收到 {}）；后续流转走 PATCH",
                s
            ));
        }
    }
    let priority = str_field(body, "priority").unwrap_or_else(|| "P2".to_string());
    if !["P0", "P1", "P2", "P3"].contains(&priority.as_str()) {
        return Err(format!("非法优先级 {}（合法值: P0/P1/P2/P3）", priority));
    }
    let mut store = load_tasks(dir)?;
    let next_id = store.get("nextId").and_then(|v| v.as_u64()).unwrap_or(1);
    let id = format!("tb-{:04}", next_id);
    store["nextId"] = json!(next_id + 1);

    let reporter = str_field(body, "reporter").unwrap_or_else(|| "manual".to_string());
    let mut task = Map::new();
    task.insert("id".to_string(), json!(id));
    task.insert("title".to_string(), json!(title.trim()));
    task.insert(
        "detail".to_string(),
        json!(str_field(body, "detail").unwrap_or_default()),
    );
    task.insert("status".to_string(), json!("todo"));
    task.insert("priority".to_string(), json!(priority));
    task.insert(
        "tags".to_string(),
        body.get("tags")
            .filter(|v| v.is_array())
            .cloned()
            .unwrap_or(json!([])),
    );
    task.insert("reporter".to_string(), json!(reporter));
    task.insert("assignee".to_string(), json!(str_field(body, "assignee")));
    task.insert("createdAt".to_string(), json!(now_ms()));
    task.insert("updatedAt".to_string(), json!(now_ms()));
    push_history(&mut task, &reporter, "create", "新建任务");

    store["tasks"]
        .as_array_mut()
        .ok_or("tasks 不是数组")?
        .push(Value::Object(task.clone()));
    save_tasks(dir, &store)?;
    Ok(Value::Object(task))
}

/// 返回 (任务快照, 是否本次进入 review)——后者驱动 webhook 通知。
fn patch_task(dir: &PathBuf, id: &str, body: &Value) -> Result<(Value, bool), String> {
    let mut store = load_tasks(dir)?;
    let by = str_field(body, "by").unwrap_or_else(|| "manual".to_string());
    let note = str_field(body, "note").unwrap_or_default();

    let (snapshot, became_review) = {
        let tasks = store["tasks"].as_array_mut().ok_or("tasks 不是数组")?;
        let task = tasks
            .iter_mut()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id))
            .ok_or_else(|| format!("任务 {} 不存在", id))?;
        let obj = task.as_object_mut().ok_or("任务不是对象")?;

        let mut changed = false;
        for key in ["title", "detail", "priority", "reporter"] {
            if let Some(v) = str_field(body, key) {
                obj.insert(key.to_string(), json!(v));
                changed = true;
            }
        }
        // 认领守卫：已被别人认领的任务不能被悄悄抢走（PATCH 是覆盖语义，
        // 不挡这里的话 A、B 先后认领都返回 200，先认领者毫不知情）。
        // 传空串 = 主动释放认领。
        if let Some(v) = str_field(body, "assignee") {
            let cur = obj.get("assignee").and_then(|x| x.as_str()).unwrap_or("");
            if !v.is_empty() && !cur.is_empty() && cur != v {
                return Err(format!(
                    "任务已被 {} 认领；如需接手先与其确认或先退回 todo",
                    cur
                ));
            }
            if obj.get("assignee").and_then(|x| x.as_str()).unwrap_or("") != v.as_str() {
                obj.insert("assignee".to_string(), if v.is_empty() { json!(null) } else { json!(v) });
                changed = true;
            }
        }
        if let Some(status) = str_field(body, "status") {
            if !STATUSES.contains(&status.as_str()) {
                return Err(format!(
                    "非法状态 {}（合法值: {}）",
                    status,
                    STATUSES.join("/")
                ));
            }
            let old = obj.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if old != status {
                if !can_transition(&old, &status) {
                    return Err(format!(
                        "不允许的流转 {} -> {}（合法路径见 docs/AI-CONVENTIONS.md 状态图）",
                        old, status
                    ));
                }
                obj.insert("status".to_string(), json!(status));
                changed = true;
                let suffix = if note.is_empty() { String::new() } else { format!("（{}）", note) };
                push_history(obj, &by, "status", &format!("{} -> {}{}", old, status, suffix));
            }
        }
        if let Some(tags) = body.get("tags").filter(|v| v.is_array()) {
            obj.insert("tags".to_string(), tags.clone());
            changed = true;
        }
        if !changed {
            return Err("没有可应用的变更".to_string());
        }
        if !note.is_empty() {
            push_history(obj, &by, "note", &note);
        }
        obj.insert("updatedAt".to_string(), json!(now_ms()));
        let became = obj.get("status").and_then(|v| v.as_str()) == Some("review");
        (Value::Object(obj.clone()), became)
    };

    save_tasks(dir, &store)?;
    Ok((snapshot, became_review))
}

fn add_event(dir: &PathBuf, id: &str, body: &Value) -> Result<Value, String> {
    let by = str_field(body, "by").unwrap_or_else(|| "manual".to_string());
    let action = str_field(body, "action").unwrap_or_else(|| "note".to_string());
    let note = str_field(body, "note").unwrap_or_default();
    let mut store = load_tasks(dir)?;

    let snapshot = {
        let tasks = store["tasks"].as_array_mut().ok_or("tasks 不是数组")?;
        let task = tasks
            .iter_mut()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id))
            .ok_or_else(|| format!("任务 {} 不存在", id))?;
        let obj = task.as_object_mut().ok_or("任务不是对象")?;
        push_history(obj, &by, &action, &note);
        obj.insert("updatedAt".to_string(), json!(now_ms()));
        Value::Object(obj.clone())
    };

    save_tasks(dir, &store)?;
    Ok(snapshot)
}

fn register_agent(dir: &PathBuf, body: &Value) -> Result<Value, String> {
    let id = str_field(body, "id").unwrap_or_default();
    if id.trim().is_empty() {
        return Err("id 不能为空".to_string());
    }
    let mut store = load_tasks(dir)?;
    {
        let agents = store["agents"].as_array_mut().ok_or("agents 不是数组")?;
        if let Some(a) = agents
            .iter_mut()
            .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        {
            if let Some(obj) = a.as_object_mut() {
                if let Some(name) = str_field(body, "name") {
                    obj.insert("name".to_string(), json!(name));
                }
                if let Some(role) = str_field(body, "role") {
                    obj.insert("role".to_string(), json!(role));
                }
                obj.insert("lastSeen".to_string(), json!(now_ms()));
            }
        } else {
            agents.push(json!({
                "id": id,
                "name": str_field(body, "name").unwrap_or_else(|| id.clone()),
                "role": str_field(body, "role").unwrap_or_else(|| "dev".to_string()),
                "lastSeen": now_ms(),
            }));
        }
    }
    save_tasks(dir, &store)?;
    Ok(store["agents"].clone())
}

// ---------------------------------------------------------------- 响应

fn write_response(stream: &mut TcpStream, code: u16, body: &str) {
    let reason = match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PATCH, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-TB-Token\r\nConnection: close\r\n\r\n",
        code, reason, body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    if code != 204 {
        let _ = stream.write_all(body.as_bytes());
    }
    let _ = stream.flush();
}

/* ================================================================== */
/* 单测：流转图与前端 core.mjs 的 can_transition 用例一一对应（防双端漂移） */

#[cfg(test)]
mod tests {
    use super::can_transition;

    #[test]
    fn forward_paths_match_frontend() {
        assert!(can_transition("todo", "claimed"));
        assert!(can_transition("todo", "doing"));
        assert!(can_transition("claimed", "doing"));
        assert!(can_transition("doing", "review"));
        assert!(can_transition("review", "done"));
    }

    #[test]
    fn backward_paths_allowed() {
        // 退回 / 打回 / 重开
        assert!(can_transition("claimed", "todo"));
        assert!(can_transition("doing", "todo"));
        assert!(can_transition("review", "doing"));
        assert!(can_transition("done", "review"));
    }

    #[test]
    fn skip_review_forbidden() {
        // 审查不能被绕过：todo/claimed 不能直跳 done
        assert!(!can_transition("todo", "done"));
        assert!(!can_transition("claimed", "done"));
        assert!(!can_transition("claimed", "review"));
        assert!(!can_transition("todo", "review"));
    }

    #[test]
    fn illegal_states_rejected() {
        assert!(!can_transition("todo", "nope"));
        assert!(!can_transition("bogus", "todo"));
        assert!(!can_transition("done", "doing")); // done 只能重开进 review
    }

    #[test]
    fn self_transition_allowed() {
        assert!(can_transition("doing", "doing"));
        assert!(can_transition("todo", "todo"));
    }

    /* ---------------- MCP 协议层 ---------------- */

    use super::{mcp_dispatch, mcp_handle, mcp_tools, empty_store, save_tasks};
    use std::path::PathBuf;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "tb-mcp-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        save_tasks(&d, &empty_store()).unwrap();
        d
    }

    #[test]
    fn tools_list_has_six_entries() {
        let tools = mcp_tools();
        assert_eq!(tools.len(), 6);
        for t in &tools {
            assert!(t.get("inputSchema").is_some(), "工具缺 inputSchema");
        }
    }

    #[test]
    fn notification_gets_no_response() {
        // 无 id = 通知，不回包
        let req = serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        assert!(mcp_dispatch(&req, &PathBuf::new()).is_none());
    }

    #[test]
    fn initialize_shape() {
        let req = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}});
        let resp = mcp_dispatch(&req, &PathBuf::new()).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(resp["result"]["serverInfo"]["name"], "nexus-panel-task-board");
    }

    #[test]
    fn call_create_then_list_roundtrip() {
        let dir = tmp_dir("roundtrip");
        let call = |name: &str, args: serde_json::Value| {
            let req = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
                "params":{"name":name,"arguments":args}});
            mcp_dispatch(&req, &dir).unwrap()["result"].clone()
        };

        let r = call("tb_create_task", serde_json::json!({
            "title": "MCP 冒烟", "priority": "P1", "tags": ["test"], "reporter": "dev-a"
        }));
        assert!(r.get("isError").is_none(), "建任务不应报错: {r}");
        assert_eq!(r["content"][0]["type"], "text");

        let r = call("tb_list_tasks", serde_json::json!({"status": "todo"}));
        let text = r["content"][0]["text"].as_str().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["count"], 1);

        // 业务错误走 isError 内容而不是 JSON-RPC error
        let r = call("tb_update_task", serde_json::json!({
            "id": "tb-0001", "status": "done", "by": "dev-a"
        }));
        assert_eq!(r["isError"], true, "todo 直跳 done 必须被流转图拦下");
    }

    #[test]
    fn batch_and_parse_error() {
        let dir = tmp_dir("batch");
        // 批量：通知 + 请求混发，只回请求那条
        let body = serde_json::json!([
            {"jsonrpc":"2.0","method":"notifications/initialized"},
            {"jsonrpc":"2.0","id":7,"method":"ping"}
        ])
        .to_string();
        let (code, text) = mcp_handle(&body, &dir);
        assert_eq!(code, 200);
        assert!(text.contains("\"id\":7"));

        // 坏 JSON → -32700
        let (code, text) = mcp_handle("{oops", &dir);
        assert_eq!(code, 400);
        assert!(text.contains("-32700"));
    }
}
