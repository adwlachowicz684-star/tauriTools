//! agent_flow 插件的 Rust 后端。
//!
//! 提供四类能力：
//!   - run_node / kill_node / check_cli   启动 CLI 子进程并流式回传 stdout
//!   - watch_start / watch_stop           目录监听（监听触发器）
//!   - webhook_start / webhook_stop       本地 HTTP 服务（调用触发器）
//!   - fs_op                              文件 / 文件夹操作
//!
//! 这段实现曾在一次全量覆盖推送中丢失（main.rs 被打回最初的模板版本），
//! 现从历史提交 d06f060c 取回，并独立成模块 ——
//! 不再与外壳代码混在同一个文件里，以免再被同类操作整体覆盖。

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::HashMap as StdHashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::Mutex;

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
pub struct ProcRegistry(pub Mutex<HashMap<String, CommandChild>>);

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
pub async fn run_node(
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
pub fn kill_node(state: State<'_, ProcRegistry>, run_id: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    if let Some(child) = map.remove(&run_id) {
        child.kill().map_err(|e| format!("终止进程失败: {}", e))?;
    }
    Ok(())
}

/// 检查 CLI 是否已安装。用标准库执行，不占用 shell 插件权限额度。
#[tauri::command]
pub fn check_cli(cmd: String) -> bool {
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
pub struct WatchRegistry(pub Mutex<HashMap<String, RecommendedWatcher>>);

/// 启动目录监听。文件变化以 `watch-event/{id}` 事件推给前端。
#[tauri::command]
pub fn watch_start(
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
pub fn watch_stop(state: State<'_, WatchRegistry>, id: String) -> Result<(), String> {
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
pub struct WebhookRegistry(pub Mutex<StdHashMap<u16, WebhookServer>>);

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
pub fn webhook_start(
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
pub fn webhook_stop(state: State<'_, WebhookRegistry>, id: String) -> Result<(), String> {
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

/* ================================================================== */
/* 文件 / 文件夹操作 —— Agent Flow 的「文件操作」节点用                  */
/*                                                                     */
/* 前端（iframe）无法直接读写本地磁盘，必须经 Rust。                    */
/* 刻意用 std::fs 而不是 tauri-plugin-fs：                             */
/*   · 少一个插件依赖，也就不必在 capabilities 里逐条声明路径权限      */
/*   · 这里做的是"工作流里的显式操作"，路径由用户在节点里写明，        */
/*     语义上更接近"执行一条命令"而非"应用申请文件系统权限"            */
/*                                                                     */
/* 安全兜底只做一件事：绝不允许删掉系统关键路径。                      */
/* 路径穿越等不做限制——这是本地开发工具，用户对自己填的路径负责。      */
/* ================================================================== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsRequest {
    pub op: String,
    pub path: String,
    pub target: String,
    pub content: String,
    pub recursive: bool,
    pub force: bool,
    pub dry_run: bool,
    #[serde(default)]
    pub max_bytes: usize,
    #[serde(default)]
    pub exts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsResult {
    pub ok: bool,
    /// 展示用的结果文本（文件内容 / 目录清单 / 操作回执）
    pub text: String,
}

/// 这些路径绝不允许删除——误删代价太大，宁可拒绝
const FORBIDDEN_DELETE: &[&str] = &[
    "/", "/etc", "/usr", "/bin", "/sbin", "/var", "/lib", "/boot", "/root",
    "/system", "/windows", "/program files",
    "c:\\", "c:\\windows", "c:\\windows\\system32", "c:\\program files",
];

fn is_forbidden_delete(p: &Path) -> bool {
    let raw = p.to_string_lossy().replace('\\', "/").to_lowercase();
    let trimmed = raw.trim_end_matches('/');
    if trimmed.is_empty() {
        return true;
    }
    FORBIDDEN_DELETE.iter().any(|f| {
        let f = f.replace('\\', "/").to_lowercase();
        trimmed == f.as_str() || trimmed == f.trim_end_matches('/')
    })
}

/// 只列出一层目录
fn list_dir(dir: &Path, recursive: bool, exts: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![dir.to_path_buf()];

    while let Some(cur) = stack.pop() {
        let rd = std::fs::read_dir(&cur)
            .map_err(|e| format!("读取目录失败 {}: {}", cur.display(), e))?;
        let mut entries: Vec<std::path::PathBuf> = Vec::new();
        for entry in rd.flatten() {
            entries.push(entry.path());
        }
        entries.sort();

        for p in entries {
            let is_dir = p.is_dir();
            let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();

            if is_dir {
                out.push(format!("{}/", p.display()));
                if recursive {
                    stack.push(p);
                }
            } else if exts.is_empty()
                || exts.iter().any(|e| name.to_lowercase().ends_with(&format!(".{}", e.trim_start_matches('.').to_lowercase())))
            {
                out.push(p.display().to_string());
            }
        }
    }
    Ok(out)
}

/// 极简 glob：支持 `*` （单段通配）与 `**` （跨目录通配），不支持 `?` 与字符类。
/// 够工作流用即可，避免为此引入 walkdir / glob crate。
fn glob_match(pattern: &str, path: &str) -> bool {
    let pnorm = pattern.replace('\\', "/");
    let anorm = path.replace('\\', "/");
    let pseg: Vec<&str> = pnorm.split('/').filter(|s| !s.is_empty()).collect();
    let aseg: Vec<&str> = anorm.split('/').filter(|s| !s.is_empty()).collect();

    fn seg_match(pat: &str, s: &str) -> bool {
        if pat == "*" {
            return true;
        }
        // 只处理 '*' 这一种通配符
        let parts: Vec<&str> = pat.split('*').collect();
        if parts.len() == 1 {
            return pat == s;
        }
        let mut pos = 0usize;
        for (i, part) in parts.iter().enumerate() {
            if part.is_empty() {
                continue;
            }
            if i == 0 {
                if !s.starts_with(part) {
                    return false;
                }
                pos = part.len();
            } else if i + 1 == parts.len() {
                if !s[pos..].ends_with(part) {
                    return false;
                }
            } else {
                match s[pos..].find(part) {
                    Some(idx) => pos += idx + part.len(),
                    None => return false,
                }
            }
        }
        true
    }

    // 注意：Rust 的嵌套 fn 不能捕获外层变量，
    // 所以把 pseg / aseg 显式作为参数传进去（写成闭包则返回 Box，递归更麻烦）
    fn walk(pseg: &[&str], aseg: &[&str], pi: usize, ai: usize) -> bool {
        if pi == pseg.len() {
            return ai == aseg.len();
        }
        let seg = pseg[pi];
        if seg == "**" {
            // '**' 吃掉 0..n 段
            for k in ai..=aseg.len() {
                if walk(pseg, aseg, pi + 1, k) {
                    return true;
                }
            }
            return false;
        }
        if ai >= aseg.len() {
            return false;
        }
        if seg_match(seg, aseg[ai]) && walk(pseg, aseg, pi + 1, ai + 1) {
            return true;
        }
        false
    }

    walk(&pseg, &aseg, 0, 0)
}

/// 展开通配符：从 pattern 里截出最长的"不含通配符的前缀目录"作为起点递归
fn expand_glob(pattern: &str) -> Result<Vec<String>, String> {
    let pnorm = pattern.replace('\\', "/");
    let is_abs = pnorm.starts_with('/') || pnorm.contains(':');
    let segs: Vec<&str> = pnorm.split('/').collect();

    let mut base_parts: Vec<&str> = Vec::new();
    for s in &segs {
        if s.is_empty() || s.contains('*') {
            break;
        }
        base_parts.push(*s);
    }

    // 两个分支必须同为 String。
    // else 分支里 join/format 产出的是 String，而 if 分支原本写的是 &str
    // 字面量（"/" / "."）—— if/else 是同一个表达式，两分支类型必须一致，否则 E0308。
    // 末尾的 .to_string() 救不回来：求值时 if/else 本身已必须先确定唯一类型。
    let base = if base_parts.is_empty() {
        if is_abs { String::from("/") } else { String::from(".") }
    } else {
        // 绝对路径时首段为空，需要还原前导斜杠
        let joined = base_parts.join("/");
        if is_abs && !joined.starts_with('/') { format!("/{}", joined) } else { joined }
    };

    let base_path = Path::new(&base);
    if !base_path.exists() {
        return Ok(Vec::new());
    }

    let mut hits: Vec<String> = Vec::new();
    if base_path.is_file() {
        if glob_match(&pnorm, &base) {
            hits.push(base.clone());
        }
        return Ok(hits);
    }

    let mut stack = vec![base_path.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let rd = match std::fs::read_dir(&cur) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let ps = p.to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                stack.push(p.clone());
            }
            if glob_match(&pnorm, &ps) {
                hits.push(ps);
            }
        }
    }
    hits.sort();
    Ok(hits)
}

fn copy_all(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)
            .map_err(|e| format!("创建目标目录失败 {}: {}", dst.display(), e))?;
        for entry in std::fs::read_dir(src)
            .map_err(|e| format!("读取源目录失败 {}: {}", src.display(), e))?
            .flatten()
        {
            let name = entry.file_name();
            copy_all(&entry.path(), &dst.join(name))?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
        }
        std::fs::copy(src, dst)
            .map_err(|e| format!("复制失败 {} → {}: {}", src.display(), dst.display(), e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn fs_op(req: FsRequest) -> Result<FsResult, String> {
    let dry = req.dry_run;
    let path = req.path.trim().to_string();
    if path.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let p = Path::new(&path);

    macro_rules! done {
        ($t:expr) => { Ok(FsResult { ok: true, text: $t }) };
    }
    macro_rules! skip {
        ($t:expr) => { Ok(FsResult { ok: true, text: format!("[演练] {}", $t) }) };
    }

    match req.op.as_str() {
        /* ---------- 读 ---------- */
        "read" => {
            if !p.exists() {
                return Err(format!("文件不存在: {}", path));
            }
            if p.is_dir() {
                return Err(format!("是目录不是文件，请用「列目录」: {}", path));
            }
            let meta = std::fs::metadata(p).map_err(|e| format!("读取元信息失败: {}", e))?;
            let cap = if req.max_bytes == 0 { usize::MAX } else { req.max_bytes };
            let bytes = std::fs::read(p).map_err(|e| format!("读取失败: {}", e))?;
            let truncated = bytes.len() > cap;
            let text = String::from_utf8_lossy(&bytes[..bytes.len().min(cap)]).to_string();
            let mut out = text;
            if truncated {
                out.push_str(&format!(
                    "\n\n… 已截断（共 {} 字节，上限 {}）",
                    meta.len(),
                    cap
                ));
            }
            done!(out)
        }

        /* ---------- 写 / 追加 ---------- */
        "write" | "append" => {
            let is_append = req.op == "append";
            if dry {
                return skip!(format!("{} {} 字节 → {}", if is_append { "追加" } else { "写入" }, req.content.len(), path));
            }
            if let Some(parent) = p.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("创建父目录失败 {}: {}", parent.display(), e))?;
                }
            }
            if is_append {
                use std::io::Write as _;
                let mut f = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(p)
                    .map_err(|e| format!("打开文件失败: {}", e))?;
                f.write_all(req.content.as_bytes())
                    .map_err(|e| format!("写入失败: {}", e))?;
            } else {
                std::fs::write(p, &req.content).map_err(|e| format!("写入失败: {}", e))?;
            }
            done!(format!("已{} {} 字节 → {}", if is_append { "追加" } else { "写入" }, req.content.len(), path))
        }

        /* ---------- 复制 ---------- */
        "copy" => {
            let dst = req.target.trim();
            if dst.is_empty() {
                return Err("复制需要提供目标路径".to_string());
            }
            if dry {
                return skip!(format!("复制 {} → {}", path, dst));
            }
            if !p.exists() {
                return Err(format!("源不存在: {}", path));
            }
            copy_all(p, Path::new(dst))?;
            done!(format!("已复制 {} → {}", path, dst))
        }

        /* ---------- 移动 / 重命名 ---------- */
        "move" => {
            let dst = req.target.trim();
            if dst.is_empty() {
                return Err("移动需要提供目标路径".to_string());
            }
            if dry {
                return skip!(format!("移动 {} → {}", path, dst));
            }
            if !p.exists() {
                return Err(format!("源不存在: {}", path));
            }
            if let Some(parent) = Path::new(dst).parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
                }
            }
            std::fs::rename(p, dst).map_err(|e| format!("移动失败: {}", e))?;
            done!(format!("已移动 {} → {}", path, dst))
        }

        /* ---------- 删除 ---------- */
        "delete" => {
            if is_forbidden_delete(p) {
                return Err(format!("拒绝删除系统关键路径: {}", path));
            }
            if !p.exists() {
                return Ok(FsResult { ok: true, text: format!("不存在，无需删除: {}", path) });
            }
            let kind = if p.is_dir() { "目录" } else { "文件" };
            if p.is_dir() && !req.force {
                return Err(format!("「{}」是目录。确认要连同内容一起删除请勾选「允许删目录」", path));
            }
            if dry {
                return skip!(format!("删除{} {}", kind, path));
            }
            if p.is_dir() {
                std::fs::remove_dir_all(p).map_err(|e| format!("删除目录失败: {}", e))?;
            } else {
                std::fs::remove_file(p).map_err(|e| format!("删除文件失败: {}", e))?;
            }
            done!(format!("已删除{} {}", kind, path))
        }

        /* ---------- 列目录 ---------- */
        "list" => {
            if !p.exists() {
                return Err(format!("目录不存在: {}", path));
            }
            if !p.is_dir() {
                return Err(format!("不是目录: {}", path));
            }
            let items = list_dir(p, req.recursive, &req.exts)?;
            if items.is_empty() {
                done!("（空目录）".to_string())
            } else {
                done!(items.join("\n"))
            }
        }

        /* ---------- 建目录 ---------- */
        "mkdir" => {
            if dry {
                return skip!(format!("创建目录 {}", path));
            }
            std::fs::create_dir_all(p).map_err(|e| format!("创建目录失败: {}", e))?;
            done!(format!("已确保目录存在: {}", path))
        }

        /* ---------- 是否存在 ---------- */
        "exists" => {
            done!(if p.exists() { "true" } else { "false" }.to_string())
        }

        /* ---------- 元信息 ---------- */
        "stat" => {
            if !p.exists() {
                return Err(format!("路径不存在: {}", path));
            }
            let meta = std::fs::metadata(p).map_err(|e| format!("读取元信息失败: {}", e))?;
            let kind = if meta.is_dir() { "目录" } else { "文件" };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| {
                    let secs = d.as_secs() as i64;
                    // 简单格式化，避免引入 chrono
                    format!("{}", secs)
                })
                .unwrap_or_else(|| "未知".to_string());
            done!(format!(
                "类型: {}\n大小: {} 字节\n修改时间(Unix 秒): {}\n只读: {}",
                kind,
                meta.len(),
                modified,
                meta.permissions().readonly()
            ))
        }

        /* ---------- 通配符展开（供循环节点 glob 模式用） ---------- */
        "glob" => {
            let hits = expand_glob(&path)?;
            if hits.is_empty() {
                done!("".to_string())
            } else {
                done!(hits.join("\n"))
            }
        }

        other => Err(format!("未知操作: {}", other)),
    }
}

/* ================================================================== */
/* 本地图片读取（OCR 节点）                                          */
/* ================================================================== */
// Path 已在文件头导入，这里不再重复


/// 单张图片的大小上限。
///
/// base64 会再膨胀约 1/3，20MB 的图片编码后接近 27MB，
/// 已经足以让多数 API 网关直接拒绝请求，再大没有意义。
const MAX_BYTES: usize = 20 * 1024 * 1024;

/// 读取本地图片，返回可直接放进 `image_url.url` 的 data URL。
///
/// 前端（iframe）没有磁盘权限，必须经 Rust 读。
#[tauri::command]
pub fn af_read_image_data_url(path: String) -> Result<String, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("图片路径为空".into());
    }
    let f = Path::new(p);
    if !f.is_file() {
        return Err(format!("文件不存在或不是普通文件: {p}"));
    }

    let bytes = std::fs::read(f).map_err(|e| format!("读取失败: {e}"))?;
    if bytes.is_empty() {
        return Err("文件为空".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "图片过大（约 {} MB），上限 20 MB。可先压缩再识别",
            bytes.len() / 1024 / 1024
        ));
    }

    // 按文件头判断类型，而不是看扩展名：
    // 截图工具常存成没有扩展名的临时文件，只看扩展名会误判。
    let mime = detect_mime(&bytes)
        .ok_or("不是支持的图片格式（支持 png / jpeg / gif / webp / bmp）")?;

    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// 用魔数判断图片类型
fn detect_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if b.starts_with(b"BM") {
        return Some("image/bmp");
    }
    // RIFF....WEBP
    if b.len() >= 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 标准 base64 编码（含末尾 = 填充）
fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);

    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);

        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
