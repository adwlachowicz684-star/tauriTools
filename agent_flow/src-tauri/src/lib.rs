use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap as StdHashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub run_id: String,
    pub cli: String,
    /// CLI 可执行文件；留空则回退到 cli 字段（走 PATH）
    pub cmd: String,
    pub prompt: String,
    pub workdir: String,
    pub model: String,
    pub yolo: bool,
}

#[derive(Debug, Clone, Serialize)]
struct DonePayload {
    code: Option<i32>,
    success: bool,
}

/// 正在运行的子进程，按 runId 索引，用于「停止」按钮
pub struct ProcRegistry(Mutex<HashMap<String, CommandChild>>);

/// 按 CLI 种类拼参数。
/// traecli 2.0 用 `exec` 子命令跑非交互；codebuddy 用 `-p`。
/// 若你的 traecli 版本要求选项放在 exec 之前，改这里即可。
fn build_args(req: &RunRequest) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let is_trae = req.cli == "traecli";

    if is_trae {
        args.push("exec".into());
        args.push(req.prompt.clone());
    } else {
        args.push("-p".into());
        args.push(req.prompt.clone());
        args.push("--output-format".into());
        args.push("text".into());
    }

    if !req.model.is_empty() {
        args.push(if is_trae { "-m".into() } else { "--model".into() });
        args.push(req.model.clone());
    }
    if req.yolo {
        args.push("-y".into());
    }
    args
}

#[tauri::command]
async fn run_node(
    app: AppHandle,
    state: State<'_, ProcRegistry>,
    req: RunRequest,
) -> Result<(), String> {
    let program = if req.cmd.is_empty() { req.cli.clone() } else { req.cmd.clone() };
    let args = build_args(&req);

    let mut command = app.shell().command(&program).args(&args);
    if !req.workdir.is_empty() {
        command = command.current_dir(&req.workdir);
    }

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("无法启动 {}（检查是否已安装并在 PATH 中）: {}", program, e))?;

    state.0.lock().unwrap().insert(req.run_id.clone(), child);

    let run_id = req.run_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let _ = app.emit(
                        &format!("cli-out/{}", run_id),
                        String::from_utf8_lossy(&bytes).to_string(),
                    );
                }
                CommandEvent::Stderr(bytes) => {
                    let _ = app.emit(
                        &format!("cli-err/{}", run_id),
                        String::from_utf8_lossy(&bytes).to_string(),
                    );
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app.emit(
                        &format!("cli-done/{}", run_id),
                        DonePayload { code: payload.code, success: payload.code == Some(0) },
                    );
                    // 进程已结束，从注册表移除，避免内存持续增长
                    if let Ok(mut map) = app.state::<ProcRegistry>().0.lock() {
                        map.remove(&run_id);
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    let _ = app.emit(&format!("cli-err/{}", run_id), format!("{}\n", err));
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn kill_node(state: State<'_, ProcRegistry>, run_id: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    if let Some(child) = map.remove(&run_id) {
        child.kill().map_err(|e| format!("终止进程失败: {}", e))?;
    }
    Ok(())
}

/// 检查 CLI 是否已安装。用标准库执行，不占用 shell 插件权限额度。
#[tauri::command]
fn check_cli(cmd: String) -> bool {
    let probe = if cfg!(windows) {
        std::process::Command::new("where").arg(&cmd).output()
    } else {
        std::process::Command::new("which").arg(&cmd).output()
    };
    match probe {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}


/// 目录监听器注册表：watcher 必须保持存活，否则监听会立刻失效
pub struct WatchRegistry(Mutex<HashMap<String, RecommendedWatcher>>);

/// 启动目录监听。文件变化以 `watch-event/{id}` 事件推给前端。
#[tauri::command]
fn watch_start(
    app: AppHandle,
    state: State<'_, WatchRegistry>,
    id: String,
    dir: String,
    recursive: bool,
) -> Result<(), String> {
    {
        let map = state.0.lock().unwrap();
        if map.contains_key(&id) {
            return Ok(()); // 已注册，避免重复监听导致事件翻倍
        }
    }

    if !Path::new(&dir).exists() {
        return Err(format!("目录不存在: {}", dir));
    }

    let emit_app = app.clone();
    let emit_id = id.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<Event>| {
            if let Ok(ev) = res {
                // 只关心增删改，访问类事件（如读取文件）忽略
                match ev.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        for p in ev.paths {
                            let _ = emit_app.emit(
                                &format!("watch-event/{}", emit_id),
                                p.to_string_lossy().to_string(),
                            );
                        }
                    }
                    _ => {}
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("创建监听器失败: {}", e))?;

    let mode = if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
    watcher
        .watch(Path::new(&dir), mode)
        .map_err(|e| format!("监听目录失败 {}: {}", dir, e))?;

    state.0.lock().unwrap().insert(id, watcher);
    Ok(())
}

/// 停止监听并从注册表移除（drop 即停止）
#[tauri::command]
fn watch_stop(state: State<'_, WatchRegistry>, id: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    map.remove(&id);
    Ok(())
}


/* ------------------------------------------------------------------ */
/* 调用触发（webhook）：本地起一个极简 HTTP 服务                        */
/*                                                                     */
/* 用标准库手写 HTTP/1.1 解析，不引第三方 crate —— 少一个依赖就少一类   */
/* 编译失败风险。够用即可：只解析请求行、Header、带 Content-Length 的   */
/* body，不处理 chunked / keep-alive / 分块上传。                       */
/* ------------------------------------------------------------------ */

/// 一个端口对应一个监听线程；同端口上的多个触发器靠 path 区分
pub struct WebhookRegistry(Mutex<StdHashMap<u16, WebhookServer>>);

struct WebhookServer {
    /// 停服标志：置 true 后 accept 循环退出
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// path -> (trigger_id, token)
    routes: std::sync::Arc<Mutex<Vec<(String, String, String)>>>,
}

/// 极简 HTTP 请求
struct MiniRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<MiniRequest>> {
    let mut reader = BufReader::new(stream.try_clone()?);

    // 请求行
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let parts: Vec<&str> = line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(None);
    }
    let method = parts[0].to_string();
    let path = parts[1].to_string();

    // Header（读到空行为止）
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_len: usize = 0;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 {
            break;
        }
        let t = h.trim().to_string();
        if t.is_empty() {
            break;
        }
        if let Some(idx) = t.find(':') {
            let k = t[..idx].trim().to_lowercase();
            let v = t[idx + 1..].trim().to_string();
            if k == "content-length" {
                content_len = v.parse::<usize>().unwrap_or(0);
            }
            headers.push((k, v));
        }
    }

    // Body
    let mut body = String::new();
    if content_len > 0 {
        let mut buf = vec![0u8; content_len];
        // 可能一次读不满，循环补齐（简单处理，body 通常很小）
        let mut got = 0usize;
        while got < content_len {
            let n = reader.read(&mut buf[got..])?;
            if n == 0 {
                break;
            }
            got += n;
        }
        body = String::from_utf8_lossy(&buf[..got]).to_string();
    }

    Ok(Some(MiniRequest { method, path, headers, body }))
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = if status == 200 { "OK" } else { "Unauthorized" };
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

/// 校验 token：X-Token 头 或 Authorization: Bearer <token>
fn token_ok(req: &MiniRequest, expected: &str) -> bool {
    if expected.is_empty() {
        return true;
    }
    for (k, v) in &req.headers {
        if k == "x-token" && v == expected {
            return true;
        }
        if k == "authorization" {
            if let Some(bearer) = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")) {
                if bearer.trim() == expected {
                    return true;
                }
            }
        }
    }
    false
}

#[tauri::command]
fn webhook_start(
    app: AppHandle,
    state: State<'_, WebhookRegistry>,
    id: String,
    port: u16,
    path: String,
    token: String,
) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();

    // 端口已被占：直接把这条路由加进去（多触发器共端口靠 path 区分）
    if let Some(srv) = map.get(&port) {
        let mut routes = srv.routes.lock().unwrap();
        if !routes.iter().any(|(tid, _, _)| tid == &id) {
            routes.push((id.clone(), path.clone(), token.clone()));
        }
        return Ok(());
    }

    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("绑定端口 {} 失败（可能已被占用）: {}", port, e))?;
    // 非阻塞 + 轮询，保证 stop 后能及时退出而不卡在 accept
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置非阻塞失败: {}", e))?;

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let routes = std::sync::Arc::new(Mutex::new(vec![(id.clone(), path.clone(), token.clone())]));

    let stop_c = stop.clone();
    let routes_c = routes.clone();
    let app_c = app.clone();

    std::thread::spawn(move || {
        loop {
            if stop_c.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let routes2 = routes_c.lock().unwrap().clone();
                    let app2 = app_c.clone();
                    // 每个连接一个线程，够用且实现简单
                    std::thread::spawn(move || {
                        match read_request(&mut stream) {
                            Ok(Some(req)) => {
                                // 去掉查询串后匹配 path
                                let req_path = req.path.split('?').next().unwrap_or(&req.path).to_string();
                                let hit = routes2.iter().find(|(_, p, _)| *p == req_path);

                                match hit {
                                    Some((tid, _, tok)) if token_ok(&req, tok) => {
                                        // 只接受写操作与 GET，其他返回 401 让调用方知道姿势不对
                                        if !matches!(req.method.as_str(), "GET" | "POST" | "PUT") {
                                            write_response(&mut stream, 401, r#"{"ok":false,"error":"method not allowed"}"#);
                                            return;
                                        }
                                        let _ = app2.emit(&format!("webhook-event/{}", tid), req.body.clone());
                                        write_response(&mut stream, 200, r#"{"ok":true}"#);
                                    }
                                    Some(_) => {
                                        write_response(&mut stream, 401, r#"{"ok":false,"error":"invalid token"}"#);
                                    }
                                    None => {
                                        write_response(&mut stream, 404, r#"{"ok":false,"error":"no such route"}"#);
                                    }
                                }
                            }
                            _ => {
                                write_response(&mut stream, 400, r#"{"ok":false,"error":"bad request"}"#);
                            }
                        }
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(_) => {
                    // 监听被关闭（stop 时 drop）
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
    });

    map.insert(port, WebhookServer { stop, routes });
    Ok(())
}

#[tauri::command]
fn webhook_stop(state: State<'_, WebhookRegistry>, id: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    let mut empty_ports: Vec<u16> = Vec::new();

    for (port, srv) in map.iter_mut() {
        let mut routes = srv.routes.lock().unwrap();
        routes.retain(|(tid, _, _)| tid != &id);
        if routes.is_empty() {
            srv.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            empty_ports.push(*port);
        }
    }
    for p in empty_ports {
        map.remove(&p);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ProcRegistry(Mutex::new(HashMap::new())))
        .manage(WatchRegistry(Mutex::new(HashMap::new())))
        .manage(WebhookRegistry(Mutex::new(StdHashMap::new())))
        .invoke_handler(tauri::generate_handler![
            run_node,
            kill_node,
            check_cli,
            watch_start,
            watch_stop,
            webhook_start,
            webhook_stop
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
