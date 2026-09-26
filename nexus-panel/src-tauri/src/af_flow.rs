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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

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
    /// 是否接着上一次会话继续（codebuddy 的 `-c`）。
    ///
    /// ================= 为什么只在 codebuddy 上带 =================
    ///
    /// traecli 官方只给了交互式 TUI 与 `-p` 非交互两种，没有"按 id 恢复"
    /// 这类参数（见 docs）。把 `-c` 也给它带上的话，它多半会当成未知选项
    /// 直接报错退出 —— 表现为"开了会话衔接之后，窗格里的节点全部失败"，
    /// 而不是"这个 CLI 不支持"，排查方向会整个偏掉。
    ///
    /// 所以能不能接力由前端按 CLI 种类判断，这里只管拼。
    #[serde(default)]
    pub cont: bool,
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
    /*
     * `-c` 放在最后：它是"接着上次会话"，读的是 CLI 自己记的会话状态，
     * 与前面那些选项没有顺序依赖；放最后改动最小，也最好注释。
     */
    if req.cont && !is_trae {
        args.push("-c".into());
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

    /*
     * 先查 workdir 再启动。
     *
     * 原来目录不存在时，错误会落到下面那句"无法启动 X（检查是否已安装并在 PATH 中）"——
     * 把人引去查 CLI 装没装，而真正的原因是工作目录写错了。
     * 这两类失败要分开说，否则用户会在错误的地方耗很久。
     */
    if !req.workdir.is_empty() {
        let wd = Path::new(&req.workdir);
        if !wd.exists() {
            return Err(format!("工作目录不存在: {}", req.workdir));
        }
        if !wd.is_dir() {
            return Err(format!("工作目录不是文件夹: {}", req.workdir));
        }
    }

    let mut command = app.shell().command(&program).args(&args);
    if !req.workdir.is_empty() {
        command = command.current_dir(&req.workdir);
    }

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("无法启动 {}（检查是否已安装并在 PATH 中）: {}", program, e))?;

    // 锁中毒时取回内部数据继续用：release profile 里 panic = "abort"，
    // 一次 panic 会让整个进程退出，而不是只丢掉这一个子进程
    state.0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(req.run_id.clone(), child);

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

/* ---------------------------- 进程树终止 ---------------------------- */
/*
 * 为什么不能只 `child.kill()`（清单 P1-2）：
 * 这些 CLI（traecli / codebuddy / opencode …）本身就是启动器，
 * 真正干活的是它们拉起的子进程。`kill()` 只杀直接子进程，
 * 子孙会被系统收养后继续跑 —— 界面上显示"已停止"，
 * 但后台的编译 / 下载 / 端口占用全都还在，用户以为停掉了。
 *
 * 所以先清整棵树，再杀本体。顺序不能反：
 * 本体一死，子孙就被 1 号进程（Linux）收养或干脆失去父子关系（Windows），
 * 再按父进程号去找就找不到了。
 *
 * 一个绕不开的风险：**PID 复用**。从拿到 pid 到执行 kill 之间，
 * 目标若已退出，同一个号可能已被新进程占用，那一刀就砍错人了。
 * 这里能做的只有把窗口压到最小（先枚举、再按"自底向上"逐个杀），
 * 完全消除需要 job object / cgroup 之类的容器机制，Tauri 侧拿不到。
 */

/// 终止以 `root` 为根的整棵进程树。返回 Err 时**不代表一个都没杀掉**，
/// 只代表至少有一刀没成功；调用方按"尽力而为"处理。
#[cfg(windows)]
fn kill_process_tree(root: u32) -> Result<(), String> {
    // /T = 连子孙一起，/F = 强制。一条命令搞定，比逐个枚举可靠也快得多
    let out = std::process::Command::new("taskkill")
        .args(["/PID", &root.to_string(), "/T", "/F"])
        .output()
        .map_err(|e| format!("调用 taskkill 失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(not(windows))]
fn kill_process_tree(root: u32) -> Result<(), String> {
    /// 自底向上：先递归清干净子孙，最后才是本体
    fn rec(pid: u32, depth: usize, errs: &mut Vec<String>) {
        // 深度兜底：ppid 理论上不该成环，但 /proc 读到的是内核快照，
        // 不设上限的话一个异常值就能把栈打爆
        if depth > 16 {
            return;
        }
        for c in child_pids_of(pid) {
            rec(c, depth + 1, errs);
            if let Err(e) = kill_one(c) {
                errs.push(e);
            }
        }
    }
    let mut errs: Vec<String> = Vec::new();
    rec(root, 0, &mut errs);
    if let Err(e) = kill_one(root) {
        errs.push(e);
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs.join("; "))
    }
}

/// 列出 pid 的**直接**子进程。
///
/// Linux 走 /proc：不依赖任何外部命令，也就不存在"pgrep 没装"这回事。
/// 注意 /proc 下只列线程组组长（tgid），不会把同一个进程重复列出来。
#[cfg(target_os = "linux")]
fn child_pids_of(pid: u32) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(s) = name.to_str() else { continue };
        if !s.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(e.path().join("stat")) else {
            continue;
        };
        // 进程名 comm 里可能带空格和括号，所以从**最后一个** ')' 之后开始切
        let Some(idx) = stat.rfind(')') else { continue };
        // ')' 之后依次是：运行状态、父进程号
        let mut rest = stat[idx + 1..].split_whitespace();
        let _state = rest.next();
        let ppid = rest.next().and_then(|v| v.parse::<u32>().ok());
        if ppid == Some(pid) {
            if let Ok(me) = s.parse::<u32>() {
                out.push(me);
            }
        }
    }
    out
}

/// macOS / 其它 Unix：pgrep 不在 PATH 上时退化为"找不到子进程"，
/// 此时只杀得掉本体 —— 比杀错强。
#[cfg(not(any(windows, target_os = "linux")))]
fn child_pids_of(pid: u32) -> Vec<u32> {
    let out = std::process::Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output();
    match out {
        // pgrep 在没有匹配时返回非 0，那不是错误
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(not(windows))]
fn kill_one(pid: u32) -> Result<(), String> {
    let out = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .map_err(|e| format!("kill {pid} 失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("kill {pid}: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

#[tauri::command]
pub fn kill_node(state: State<'_, ProcRegistry>, run_id: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = map.remove(&run_id) {
        // pid 必须在 kill 之前取：kill 会消费掉 child
        let pid = child.pid();
        let tree_err = kill_process_tree(pid);
        // 本体仍交给 Tauri 杀：它走的是平台原生路径，比我们可靠。
        // 上面已整树清过一遍，这里失败多半只是"进程已不存在"，不值得报错。
        let own_err = child.kill().err();
        match (tree_err, own_err) {
            // 树清干净了，本体这一刀失手多半是"已经死了"，不算失败
            (Ok(()), None) => {}
            (Ok(()), Some(e)) => {
                eprintln!("[af] 进程树已清理，本体的 kill 报错（pid {pid}）: {e}");
            }
            // 树没清干净：无论本体杀没杀掉，都要告诉用户有残留
            (Err(te), _) => return Err(format!("终止进程树失败（可能有残留子进程）: {te}")),
        }
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
        let map = state.0.lock().unwrap_or_else(|e| e.into_inner());
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

    state.0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, watcher);
    Ok(())
}

/// 停止监听并从注册表移除（drop 即停止）
#[tauri::command]
pub fn watch_stop(state: State<'_, WatchRegistry>, id: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
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

/// 必须 pub：WebhookRegistry 的字段是 pub，本类型若私有会让「有效可见性」
/// （crate，因 main.rs 里 `mod af_flow;` 私有但 root 可访问其中 pub 项）
/// 大于本类型的可见性，触发 private_interfaces 警告。加了 -D warnings 就会变硬错误。
/// 字段可保持私有 —— 唯一构造点在本文件内。
pub struct WebhookServer {
    /// 停服标志：置 true 后 accept 循环退出
    stop: Arc<AtomicBool>,
    /// 停服用唤醒：accept 是无阻塞轮询，没有它就要睡满一整拍才检查到 stop
    wake: Arc<(Mutex<bool>, Condvar)>,
    /// path -> (trigger_id, token)
    routes: Arc<Mutex<Vec<(String, String, String)>>>,
}

/// 单个请求的 body 上限（8 MiB）。
///
/// body 长度直接来自 Content-Length 头，不设上限就是"声明多大就分配多大"：
/// 一个 `Content-Length: 999999999999` 的伪造请求足以让进程 OOM。
/// webhook 只用来传触发参数，8 MiB 已远远够用。
const MAX_BODY: usize = 8 * 1024 * 1024;

/// body 超限的标记错误。调用方据 `ErrorKind::InvalidData` 回 413。
fn body_too_large() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, "payload too large")
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
        // 先校验再分配：绝不按声明长度直接 vec![0u8; content_len]
        if content_len > MAX_BODY {
            return Err(body_too_large());
        }
        // 预留按实际长度起步但封顶 64 KiB，剩下的靠 read_to_end 增长，
        // 避免"合法但偏大"的请求一次性吃掉大量内存
        let mut buf: Vec<u8> = Vec::with_capacity(content_len.min(64 * 1024));
        // take 保证最多读 content_len 字节，读满即停
        reader
            .by_ref()
            .take(content_len as u64)
            .read_to_end(&mut buf)?;
        body = String::from_utf8_lossy(&buf).to_string();
    }

    Ok(Some(MiniRequest { method, path, headers, body }))
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Unauthorized",
    };
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

/// 浏览器防护头。
///
/// 背景：webhook 绑在 127.0.0.1，外部机器进不来，但**本机浏览器里的任意
/// 网页**都能访问它 —— 同源策略管的是"读响应"，管不住"把请求发出去"。
/// 于是恶意网页可以用 `<img src="http://127.0.0.1:8787/hook">` 或 fetch
/// 静默触发本地 CLI 执行与文件操作，而用户毫无察觉。
///
/// 要求一个自定义头就能挡住所有来自网页的触发：
///   · `<img>` / `<script>` / `<form>` 根本没法加自定义头
///   · `fetch` / `XHR` 加了自定义头 → 浏览器先发 OPTIONS 预检，
///     本服务不处理 OPTIONS → 预检失败 → 真实请求根本发不出去
/// 而 curl / 脚本加一个 `-H` 毫无成本。
///
/// 只在"未配 token"时启用：配了 token 的请求自带 `X-Token` 自定义头，
/// 同样会触发预检，天然已被挡住。
const BROWSER_GUARD_HEADER: &str = "x-nexus-webhook";

/// 校验 token：X-Token 头 或 Authorization: Bearer <token>
fn token_ok(req: &MiniRequest, expected: &str) -> bool {
    if expected.is_empty() {
        // 未配 token：不校验身份，但仍要挡住浏览器发起的静默触发。
        // 此前这里是 `return true`，等于本机任意网页可随意触发。
        //
        // 这一路现在只是兜底 —— webhook_start 会在 token 留空时自动生成
        // 一个随机 token，正常流程走不到这里。保留它是为了防御未来
        // 有人绕过 webhook_start 直接塞空 token 注册路由。
        return req.headers.iter().any(|(k, _)| k == BROWSER_GUARD_HEADER);
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

/// 生成一个随机 token，供"触发器没配 token"时兜底。
///
/// 不引 rand / getrandom：只为挡住"未配置就裸奔"，不是抗网络攻击的密钥
/// （webhook 只绑 127.0.0.1）。熵来自 时间纳秒 + 进程号 + 调用序号，
/// 用 FNV-1a 混成 128 位后输出 32 位十六进制。
fn random_token() -> String {
    // 唯一实现在 safety 里（MCP 的令牌也用它），这里只保留调用点
    crate::fpx::safety::random_token()
}

/// 处理单个 webhook 连接：解析请求 → 校验 → 回包。
fn handle_webhook_conn(stream: &mut TcpStream, routes: &[(String, String, String)], app: &AppHandle) {
    match read_request(stream) {
        Ok(Some(req)) => {
            // 去掉查询串后匹配 path
            let req_path = req.path.split('?').next().unwrap_or(&req.path).to_string();
            let hit = routes.iter().find(|(_, p, _)| *p == req_path);

            match hit {
                Some((tid, _, tok)) if token_ok(&req, tok) => {
                    // 只接受写操作与 GET，其他返回 401 让调用方知道姿势不对
                    if !matches!(req.method.as_str(), "GET" | "POST" | "PUT") {
                        write_response(
                            stream,
                            401,
                            r#"{"ok":false,"error":"method not allowed"}"#,
                        );
                        return;
                    }
                    let _ = app.emit(&format!("webhook-event/{}", tid), req.body.clone());
                    write_response(stream, 200, r#"{"ok":true}"#);
                }
                Some(_) => {
                    write_response(stream, 401, r#"{"ok":false,"error":"invalid token"}"#);
                }
                None => {
                    write_response(stream, 404, r#"{"ok":false,"error":"no such route"}"#);
                }
            }
        }
        Ok(None) => {}
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            // 唯一用 InvalidData 的地方就是 body 超限
            write_response(stream, 413, r#"{"ok":false,"error":"payload too large"}"#);
        }
        Err(_) => {
            write_response(stream, 400, r#"{"ok":false,"error":"bad request"}"#);
        }
    }
}

#[tauri::command]
pub fn webhook_start(
    app: AppHandle,
    state: State<'_, WebhookRegistry>,
    id: String,
    port: u16,
    path: String,
    token: String,
) -> Result<String, String> {
    // 没配 token 就生成一个。浏览器的静默触发已被 BROWSER_GUARD_HEADER 挡住，
    // 但本机进程只要发个带自定义头的请求就能触发工作流（起 CLI、读写授权目录），
    // 空口令等于把这些能力敞开给本机所有程序。
    // 生成后回传给前端，用户才能在界面上看到该用什么 token 调用。
    let effective = if token.trim().is_empty() {
        let generated = random_token();
        eprintln!(
            "[webhook] 触发器 {} 未配置校验 Token，已自动生成: {}",
            id, generated
        );
        generated
    } else {
        token.clone()
    };

    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());

    // 端口已被占：直接把这条路由加进去（多触发器共端口靠 path 区分）
    if let Some(srv) = map.get(&port) {
        let mut routes = srv.routes.lock().unwrap_or_else(|e| e.into_inner());
        if !routes.iter().any(|(tid, _, _)| tid == &id) {
            routes.push((id.clone(), path.clone(), effective.clone()));
        }
        return Ok(effective);
    }

    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("绑定端口 {} 失败（可能已被占用）: {}", port, e))?;
    // 非阻塞 + 轮询，保证 stop 后能及时退出而不卡在 accept
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置非阻塞失败: {}", e))?;

    let stop = Arc::new(AtomicBool::new(false));
    let wake = Arc::new((Mutex::new(false), Condvar::new()));
    let routes = Arc::new(Mutex::new(vec![(
        id.clone(),
        path.clone(),
        effective.clone(),
    )]));

    let stop_c = stop.clone();
    let wake_c = wake.clone();
    let routes_c = routes.clone();
    let app_c = app.clone();

    std::thread::spawn(move || {
        // 并发连接上限。"每连接一个线程"不设限的话，
        // 一堆连上却不发数据的慢速连接就能把线程数堆爆（fd + 栈内存双重压力）。
        const MAX_CONNS: usize = 32;
        let live = Arc::new(AtomicUsize::new(0));

        loop {
            if stop_c.load(Ordering::Relaxed) {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    // 读超时：连上了不发请求体的客户端不能永久占着一个线程
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));

                    if live.load(Ordering::Relaxed) >= MAX_CONNS {
                        // 过载时直接回绝并关闭，而不是继续起线程
                        write_response(
                            &mut stream,
                            503,
                            r#"{"ok":false,"error":"too many connections"}"#,
                        );
                        continue;
                    }
                    let live_c = live.clone();
                    live_c.fetch_add(1, Ordering::Relaxed);

                    let routes2 = routes_c.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    let app2 = app_c.clone();
                    std::thread::spawn(move || {
                        handle_webhook_conn(&mut stream, &routes2, &app2);
                        live_c.fetch_sub(1, Ordering::Relaxed);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // 用条件变量代替 sleep：stop 时能立刻被唤醒，
                    // 不必傻等满这一拍（100ms）才检查到标志
                    let (lock, cvar) = &*wake_c;
                    match lock.lock() {
                        Ok(g) => {
                            let _ = cvar.wait_timeout(g, std::time::Duration::from_millis(100));
                        }
                        Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
                    }
                }
                Err(_) => {
                    // 监听被关闭（stop 时 drop）：退出，不再空转
                    break;
                }
            }
        }
    });

    map.insert(port, WebhookServer { stop, wake, routes });
    Ok(effective)
}

#[tauri::command]
pub fn webhook_stop(state: State<'_, WebhookRegistry>, id: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut empty_ports: Vec<u16> = Vec::new();

    for (port, srv) in map.iter_mut() {
        let mut routes = srv.routes.lock().unwrap_or_else(|e| e.into_inner());
        routes.retain(|(tid, _, _)| tid != &id);
        if routes.is_empty() {
            srv.stop.store(true, Ordering::Relaxed);
            // 唤醒正在 wait_timeout 的 accept 线程，让它马上看到 stop
            let (lock, cvar) = &*srv.wake;
            if let Ok(_g) = lock.lock() {
                cvar.notify_all();
            }
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

/// fs_op read 未指定 max_bytes 时使用的默认上限（8 MiB）。
const FS_READ_DEFAULT_CAP: usize = 8 * 1024 * 1024;

/// fs_op read 的硬上限（64 MiB）：即便调用方显式要更多，也最多读这么多。
const FS_READ_HARD_CAP: usize = 64 * 1024 * 1024;

/// 把请求里的 max_bytes 归一化成一个安全上限。
///
/// 此前 `max_bytes == 0` 被解释成 `usize::MAX`（不限制），
/// 于是"忘了填上限"等于"把整个文件读进内存"。现在 0 表示"用默认值"。
fn read_cap(max_bytes: usize) -> usize {
    if max_bytes == 0 {
        FS_READ_DEFAULT_CAP
    } else {
        max_bytes.min(FS_READ_HARD_CAP)
    }
}

/// 流式读取文件的前 cap 字节，返回 (内容, 是否被截断)。
///
/// 关键在 **先限流再读**：`BufReader::take(cap + 1)` 读满即停，
/// 所以内存占用只与 cap 有关，与文件多大无关。
/// 多读 1 个字节只是为了判断"后面还有没有"，判断完立刻 truncate。
fn read_head(p: &Path, cap: usize) -> Result<(String, bool), String> {
    let f = std::fs::File::open(p).map_err(|e| format!("打开失败: {e}"))?;
    let mut reader = BufReader::new(f);
    let mut buf: Vec<u8> = Vec::with_capacity(cap.min(64 * 1024));
    reader
        .by_ref()
        .take(cap as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取失败: {e}"))?;
    let truncated = buf.len() > cap;
    if truncated {
        buf.truncate(cap);
    }
    Ok((String::from_utf8_lossy(&buf).to_string(), truncated))
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
    use crate::fpx::fsutil::{is_real_dir, WalkGuard};

    let mut out: Vec<String> = Vec::new();
    let mut guard = WalkGuard::new();
    let mut stack: Vec<std::path::PathBuf> = vec![dir.to_path_buf()];

    while let Some(cur) = stack.pop() {
        // 自指软链 / 硬链接环：这个节点本次已经走过，跳过
        if !guard.visit(&cur) {
            continue;
        }
        let rd = std::fs::read_dir(&cur)
            .map_err(|e| format!("读取目录失败 {}: {}", cur.display(), e))?;
        let mut entries: Vec<std::path::PathBuf> = Vec::new();
        for entry in rd.flatten() {
            entries.push(entry.path());
        }
        entries.sort();

        for p in entries {
            // 用 symlink_metadata 判定：不跟随符号链接。
            // 否则一个指向上级目录的软链就能让递归永不结束
            let is_dir = is_real_dir(&p);
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
    if crate::fpx::fsutil::is_real_file(base_path) {
        if glob_match(&pnorm, &base) {
            hits.push(base.clone());
        }
        return Ok(hits);
    }

    // 与 list_dir 同样的两道保险：链接点不深入 + 已访问节点集合
    let mut guard = crate::fpx::fsutil::WalkGuard::new();
    let mut stack = vec![base_path.to_path_buf()];
    while let Some(cur) = stack.pop() {
        if !guard.visit(&cur) {
            continue;
        }
        let rd = match std::fs::read_dir(&cur) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let ps = p.to_string_lossy().replace('\\', "/");
            if crate::fpx::fsutil::is_real_dir(&p) {
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

/// 递归复制（文件 / 目录都支持）。
///
/// 走 fsutil::copy_tree：跳过链接点、带已访问节点集合。
/// 原实现用 `src.is_dir()`（跟随链接）判断递归，目录软链会被当成普通目录一路深入，
/// 遇到自指链接就是无限递归 + 无限复制。
fn copy_all(src: &Path, dst: &Path) -> Result<(), String> {
    crate::fpx::fsutil::copy_tree(src, dst)
}

/* ================================================================== */
/* fs_op 路径约束 —— 授权根目录白名单                                 */
/* ================================================================== */
/*
 * fs_op 此前只校验「路径非空」，read / write / copy / move / delete / list
 * 可作用于任意绝对路径；read 还不填 max_bytes 时不截断（cap = usize::MAX）。
 * 配合 capabilities 里全开的 http（https 与 http 的通配 `**` 域），一个只需一次
 * confirm 就能装上的外域插件，可以「读本地任意文件 → 经 fetch 外传」，
 * 全程无二次确认 —— 这是「fs 无约束 + http 全开」的组合风险。
 *
 * 收敛点放在 fs_op 本身：任何路径（含 copy / move 的目标路径）都必须
 * canonicalize 后落在授权根目录内。canonicalize 会解析符号链接，
 * 因此 ../ 穿越与 symlink 逃逸一并挡住（不是靠字符串前缀比较）。
 *
 * 注意演练（dry_run）同样要校验：演练能列出任意目录 = 目录结构泄露，
 * 越权判定必须在 dry 分支之前。
 */

/* 已授权的根目录（存的是 canonicalize 后的绝对路径，便于 starts_with 比较）。

   `loaded` 与 `roots` 放在**同一个 struct 里**：加载标记和列表必须被同一把锁
   保护，否则两个线程可以同时判定「还没加载过」、各自去读一遍文件再各写一次。 */
struct FsRootsState {
    loaded: bool,
    roots: Vec<PathBuf>,
}

static FS_ROOTS: OnceLock<Mutex<FsRootsState>> = OnceLock::new();

fn fs_roots_lock() -> &'static Mutex<FsRootsState> {
    FS_ROOTS.get_or_init(|| Mutex::new(FsRootsState { loaded: false, roots: Vec::new() }))
}

/* ---------------- fs_op 授权的持久化 ---------------- */
/*
 * 授权列表此前只活在内存里，重启就回到「只有应用数据目录」的默认状态 ——
 * 用户每次启动都要重新加一遍，等于这个入口形同虚设。
 *
 * 存到独立的 fs-roots.json，而不是塞进 project-group 的 config.json：
 * 授权是**安全边界**，不该和插件的业务配置共用一个文件 ——
 * 混在一起意味着任何写 config.json 的代码路径都可能碰到它。
 *
 * 三个必须守住的点：
 *
 * 1. **加载时重新校验 forbidden。**
 *    文件是用户可编辑的，内容不可信。若加载时不过 is_forbidden_root，
 *    手工往 JSON 里写 "/" 就能绕过 UI 的限制。
 *
 * 2. **加载时重新 canonicalize。**
 *    同理：文件里可以是任意字符串。只对「能解析成真实目录」的条目放行。
 *
 * 3. **不持久化应用数据目录。**
 *    它是动态算出来的兜底范围（换机器 / 重命名都会变），存进去会留下
 *    指向旧位置的僵尸条目。所以只存用户显式授权的那些。
 */

const FS_ROOTS_FILE: &str = "fs-roots.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct FsRootsFile {
    #[serde(default)]
    roots: Vec<String>,
}

/// 从磁盘读回授权列表。**失败一律当作空列表** —— 首次启动本来就没文件，
/// 而列表为空只会让 fs_op 退回「仅数据目录」的默认状态，不会失控。
fn load_fs_roots(dir: &Path) -> Vec<PathBuf> {
    let path = dir.join(FS_ROOTS_FILE);
    let file: FsRootsFile = match crate::fpx::store::read_json_any(&path) {
        Ok(v) => v,
        Err(_) => return Vec::new(),   // 不存在 / 解析失败 → 视作未授权过
    };
    let mut out = Vec::new();
    for raw in file.roots {
        let p = Path::new(raw.trim());
        // 不存在、或已被 forbidden 规则排除的，一律丢弃（内容不可信）
        let Ok(canon) = p.canonicalize() else { continue };
        if is_forbidden_root(&canon) { continue; }
        if !out.contains(&canon) { out.push(canon); }
    }
    out
}

/// 写回磁盘。**不存**应用数据目录（理由见上）。
/// 写失败只记日志、不向上抛：授权已经在内存里生效了，
/// 因为落盘失败就让用户本次操作报错，代价明显大于收益。
fn persist_fs_roots(app: &AppHandle) {
    let Ok(dir) = crate::fpx::store::resolve_data_dir(app) else { return };
    let default = dir.canonicalize().ok();
    let g = fs_roots_lock().lock().unwrap_or_else(|e| e.into_inner());
    let roots: Vec<String> = g
        .roots
        .iter()
        .filter(|r| Some(*r) != default.as_ref())
        .map(|r| r.display().to_string())
        .collect();
    drop(g);   // 别把锁带进 IO
    if let Err(e) = crate::fpx::store::write_json_any(
        &dir.join(FS_ROOTS_FILE),
        &FsRootsFile { roots },
    ) {
        eprintln!("[fs_op] 授权列表写入失败（本次仍生效，重启后丢失）: {e}");
    }
}

/// 即便显式授权也拒绝的根：把整块盘或系统目录放进来等于没约束。
///
/// 实现已收敛到 `fpx::guard::forbidden_root`（全仓唯一一份，含回归测试），
/// 这里保留同名包装只为不动调用点 —— 两份实现迟早漂移。
fn is_forbidden_root(p: &Path) -> bool {
    crate::fpx::guard::forbidden_root(p)
}

/// 取授权根目录快照。首次调用时把应用数据目录设为默认根，
/// 保证「刚装好、还没配过任何目录」时 fs_op 仍可用于自己的数据区，
/// 不至于一上来所有操作都被拒。
fn fs_roots_snapshot(app: &AppHandle) -> Vec<PathBuf> {
    let mut g = fs_roots_lock().lock().unwrap_or_else(|e| e.into_inner());
    if !g.loaded {
        // 先置位：即使下面加载失败也不再重试，避免每次调用都打一次磁盘
        g.loaded = true;
        let dir = crate::fpx::store::resolve_data_dir(app).ok();
        if let Some(d) = &dir {
            for c in load_fs_roots(d) {
                if !g.roots.contains(&c) {
                    g.roots.push(c);
                }
            }
        }
        // 兜底：保证「刚装好、还没配过任何目录」时 fs_op 仍可用于自己的数据区
        if let Some(d) = &dir {
            if let Ok(c) = d.canonicalize() {
                if !is_forbidden_root(&c) && !g.roots.contains(&c) {
                    g.roots.push(c);
                }
            }
        }
    }
    g.roots.clone()
}

/// 解析路径并校验它落在授权范围内。
///
/// 目标不存在时（write 新建、copy 到新文件）canonicalize 会失败，
/// 退化为「父目录 canonicalize + 文件名」——否则新建文件就能绕过校验。
///
/// 判定逻辑已经收敛到 `fpx::guard::must_be_under`（本插件唯一的路径收口实现），
/// 这里保留同名包装只为不动调用点 —— 两份实现迟早漂移，现在只有一份。
fn resolve_within(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    crate::fpx::guard::must_be_under(raw, roots)
}

/// 授权一个目录供 fs_op 使用。
#[tauri::command]
pub fn af_fs_allow_root(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("目录路径为空".to_string());
    }
    let p = Path::new(trimmed);
    if !p.is_dir() {
        return Err(format!("不是目录或目录不存在: {trimmed}"));
    }
    let canon = p
        .canonicalize()
        .map_err(|e| format!("目录无法解析: {trimmed}（{e}）"))?;
    if is_forbidden_root(&canon) {
        return Err(format!(
            "不允许把 {} 整个加入授权范围（范围过大或属于系统目录）。请指定更具体的子目录。",
            canon.display()
        ));
    }
    let mut g = fs_roots_lock().lock().unwrap_or_else(|e| e.into_inner());
    /* 这里也要确保兜底目录在内：用户可能一启动就来授权，
       中间没经过任何一次 fs_op，snapshot 的懒加载还没跑过。
       不补的话 persist 会把「只有用户目录」的列表写下去，
       之后 snapshot 再补兜底目录，两者不一致。 */
    if let Ok(dir) = crate::fpx::store::resolve_data_dir(&app) {
        if let Ok(c) = dir.canonicalize() {
            if !is_forbidden_root(&c) && !g.roots.contains(&c) {
                g.roots.push(c);
            }
        }
    }
    if !g.roots.contains(&canon) {
        g.roots.push(canon);
    }
    let out: Vec<String> = g.roots.iter().map(|r| r.display().to_string()).collect();
    drop(g);   // 先放锁再写盘
    // 标记已加载：这次是显式授权，不该被随后某次 snapshot 的懒加载覆盖掉
    fs_roots_lock().lock().unwrap_or_else(|e| e.into_inner()).loaded = true;
    persist_fs_roots(&app);
    Ok(out)
}

/// 列出当前已授权的目录。
#[tauri::command]
pub fn af_fs_list_roots(app: AppHandle) -> Vec<String> {
    fs_roots_snapshot(&app)
        .iter()
        .map(|r| r.display().to_string())
        .collect()
}

/// 撤销某个目录的授权。应用数据目录是兜底范围，不允许撤销。
#[tauri::command]
pub fn af_fs_disallow_root(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let canon = Path::new(path.trim())
        .canonicalize()
        .map_err(|e| format!("目录无法解析: {}（{e}）", path.trim()))?;
    let default = crate::fpx::store::resolve_data_dir(&app)
        .ok()
        .and_then(|d| d.canonicalize().ok());
    if Some(&canon) == default.as_ref() {
        return Err("应用数据目录是 fs_op 的兜底范围，不能撤销。".to_string());
    }
    let mut g = fs_roots_lock().lock().unwrap_or_else(|e| e.into_inner());
    g.roots.retain(|r| r != &canon);
    let out: Vec<String> = g.roots.iter().map(|r| r.display().to_string()).collect();
    drop(g);
    persist_fs_roots(&app);
    Ok(out)
}

/* ------------------------------------------------------------------ */
/* 设备盐（凭据加密用）                                                */
/* ------------------------------------------------------------------ */

/**
 * 取本机设备盐；第一次调用时生成并落盘。
 *
 * 为什么要有这个命令：
 *   凭据在 auto 模式下用「本机特征 + 设备盐」派生密钥。
 *   盐原先存在 localStorage —— 而 localStorage 里的东西，
 *   同一个页面上的任何脚本（包括别的插件）都能读。
 *   拿到盐 + 公开的本机特征，就能算出密钥解开别人的凭据。
 *
 * 挪到这里之后， salt 只有能调 `af_device_salt` 的一方才拿得到，
 * 这条路径可以被 capability 收口 —— 于是"别的插件顺手读走"被挡住了。
 *
 * 但要如实说明挡不住什么：
 *   盐文件就在应用数据目录里，明文明放。
 *   谁把整个用户数据目录拷走，谁就能拿到盐，接着离线复现密钥。
 *   所以这一改动**不是**"防离线拷贝"，它防的是"同页面其它代码顺手读"。
 *   要防离线拷贝，只有口令模式（钥匙在用户脑子里）。
 *
 * 生成失败必须报错而不是"退回一个默认值"：
 *   盐变了，之前加密的凭据就全解不开了，静默换盐等于数据丢失。
 */
#[tauri::command]
pub fn af_device_salt(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建应用数据目录失败 {}: {e}", dir.display()))?;

    let file = dir.join("af-device-salt");

    if let Ok(existing) = std::fs::read_to_string(&file) {
        let s = existing.trim().to_string();
        if !s.is_empty() {
            return Ok(s);
        }
    }

    let salt = make_device_salt();
    // 写入失败必须向上报：写不进去的话下次又生成一个新的，
    // 已存的凭据就再也解不开了 —— 宁可现在失败，也不能悄悄换盐。
    std::fs::write(&file, &salt)
        .map_err(|e| format!("写入设备盐失败 {}: {e}", file.display()))?;
    Ok(salt)
}

/**
 * 生成一段盐。
 *
 * 强度不来自这个字符串"有多随机" —— 盐是明文存盘的，谈不上保密。
 * 它只需要做到两点：每台机器不同、不能从公开信息推出来。
 * 时间戳 + 进程号已经满足（进程号不可预测、纳秒时间戳无法穷举），
 * 再用 RandomState 混一道打散时间戳的可预测性。
 * 不引新的随机 crate：为这点用途拉一个依赖不划算。
 */
fn make_device_salt() -> String {
    use std::hash::{BuildHasher, Hash, Hasher};

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();

    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    nanos.hash(&mut hasher);
    pid.hash(&mut hasher);
    let mixed = hasher.finish();

    format!("{nanos:x}-{pid:x}-{mixed:x}")
}

/// 检查 CLI 是否已安装。用标准库执行，不占用 shell 插件权限额度。

/* ------------------------------------------------------------------ */
/* 增量读取（对话监听用）                                              */
/* ------------------------------------------------------------------ */

/// 单次 tail 最多读多少字节。
///
/// 对话文件是追加写的，监听只需要看末尾。64KB 对"最近几十条消息"足够；
/// 设上限是为了避免某个文件异常巨大时一次读爆内存。
const TAIL_MAX: u64 = 64 * 1024;

/// 读文件末尾的内容。
///
/// 为什么需要它：对话监听要**每隔几秒**看一眼文件末尾有没有新消息。
/// 用 fs_op 的 read 得把整个文件读进来再切片 —— 一个几十 MB 的 jsonl
/// 每 3 秒整读一次，磁盘和内存都吃不消。这里直接从末尾 seek。
///
/// 返回的内容**可能以半截行开头**（seek 落在行中间），
/// 调用方负责丢掉第一行 —— 那行多半是半个 JSON，解析必然失败，
/// 丢掉最多只漏一条消息，而它下一轮还会被完整读到。
///
/// 路径必须落在 fs_op 的授权根内：同模块的 `fs_op` 走 `resolve_within` 白名单，
/// 而这里原先是裸 `std::fs` 读，等于给白名单开了个旁路（清单 P1-1）。
#[tauri::command]
pub fn af_fs_tail(app: AppHandle, path: String, max_bytes: Option<u64>) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let roots = fs_roots_snapshot(&app);
    let p = crate::fpx::guard::must_be_under(path.trim(), &roots)?;
    if !p.is_file() {
        return Err(format!("不是文件或不存在: {}", path));
    }

    let meta = std::fs::metadata(&p).map_err(|e| format!("读取元信息失败: {e}"))?;
    let want = max_bytes.unwrap_or(TAIL_MAX).clamp(1, TAIL_MAX);
    // 从末尾往前 want 字节；文件比 want 短就从头读
    let start = meta.len().saturating_sub(want);

    let mut f = std::fs::File::open(p).map_err(|e| format!("打开失败: {e}"))?;
    f.seek(SeekFrom::Start(start))
        .map_err(|e| format!("定位失败: {e}"))?;

    let mut buf = Vec::with_capacity((meta.len() - start) as usize);
    f.take(meta.len() - start)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取失败: {e}"))?;

    Ok(String::from_utf8_lossy(&buf).to_string())
}

#[tauri::command]
pub fn fs_op(app: AppHandle, req: FsRequest) -> Result<FsResult, String> {
    let dry = req.dry_run;
    let path = req.path.trim().to_string();
    if path.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let roots = fs_roots_snapshot(&app);
    let p = resolve_within(&path, &roots)?;

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
            let meta = std::fs::metadata(&p).map_err(|e| format!("读取元信息失败: {}", e))?;
            let cap = read_cap(req.max_bytes);
            // 流式读，读满 cap 就停：内存占用被 cap 约束，与文件实际大小无关
            let (mut out, truncated) = read_head(&p, cap)?;
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
                    .open(&p)
                    .map_err(|e| format!("打开文件失败: {}", e))?;
                f.write_all(req.content.as_bytes())
                    .map_err(|e| format!("写入失败: {}", e))?;
            } else {
                std::fs::write(&p, &req.content).map_err(|e| format!("写入失败: {}", e))?;
            }
            done!(format!("已{} {} 字节 → {}", if is_append { "追加" } else { "写入" }, req.content.len(), path))
        }

        /* ---------- 复制 ---------- */
        "copy" => {
            let dst = req.target.trim();
            if dst.is_empty() {
                return Err("复制需要提供目标路径".to_string());
            }
            // 目标同样要落在授权范围内：只校验源的话，
            // 可以把授权区内的文件复制到区外任意位置（写穿）。
            let dst_p = resolve_within(dst, &roots)?;
            if dry {
                return skip!(format!("复制 {} → {}", path, dst));
            }
            if !p.exists() {
                return Err(format!("源不存在: {}", path));
            }
            copy_all(&p, &dst_p)?;
            done!(format!("已复制 {} → {}", path, dst))
        }

        /* ---------- 移动 / 重命名 ---------- */
        "move" => {
            let dst = req.target.trim();
            if dst.is_empty() {
                return Err("移动需要提供目标路径".to_string());
            }
            let dst_p = resolve_within(dst, &roots)?;
            if dry {
                return skip!(format!("移动 {} → {}", path, dst));
            }
            if !p.exists() {
                return Err(format!("源不存在: {}", path));
            }
            if let Some(parent) = dst_p.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
                }
            }
            // 跨设备（跨卷 / 跨挂载点）时 rename 必然失败，
            // rename_with_fallback 会回退到"复制 + 删除"，且复制没成功前不删源
            crate::fpx::fsutil::rename_with_fallback(&p, &dst_p)
                .map_err(|e| format!("移动失败: {e}"))?;
            done!(format!("已移动 {} → {}", path, dst))
        }

        /* ---------- 删除 ---------- */
        "delete" => {
            if is_forbidden_delete(&p) {
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
                std::fs::remove_dir_all(&p).map_err(|e| format!("删除目录失败: {}", e))?;
            } else {
                std::fs::remove_file(&p).map_err(|e| format!("删除文件失败: {}", e))?;
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
            let items = list_dir(&p, req.recursive, &req.exts)?;
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
            std::fs::create_dir_all(&p).map_err(|e| format!("创建目录失败: {}", e))?;
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
            let meta = std::fs::metadata(&p).map_err(|e| format!("读取元信息失败: {}", e))?;
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
            // 逐个回验：pattern 本身在授权区内，但符号链接可能把命中项指到区外。
            let kept: Vec<String> = hits
                .into_iter()
                .filter(|h| resolve_within(h, &roots).is_ok())
                .collect();
            if kept.is_empty() {
                done!("".to_string())
            } else {
                done!(kept.join("\n"))
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

/// 音频文件的大小上限。
///
/// 与图片不同，这里走 base64 是无奈之举（见下方函数注释），
/// 膨胀 1/3 之后 30MB 的音频会变成 40MB 的字符串，
/// 再大就会明显拖慢通道与解码，没有实用价值。
const MAX_AUDIO_BYTES: usize = 30 * 1024 * 1024;

/// 读取本地音频文件，返回可直接放进 `<audio src>` 的 data URL。
///
/// 与 af_read_image_data_url 的关系：那边按魔数判图片类型
/// （截图工具常存成无扩展名的临时文件，只能靠魔数）；
/// 音频格式靠魔数判断要处理 ID3/RIFF/fMP4 等多种容器，容易误判，
/// 而音频文件几乎都有正确扩展名，所以这里按扩展名判。
///
/// 为什么读成 base64 而不是直接给路径：
/// 本插件跑在 iframe 里，没有磁盘访问权限，所有文件访问必须经 Rust。
/// 用 asset 协议（convertFileSrc）本可避免这次拷贝，
/// 但它要求在配置里开启 scope，本项目没开，改配置的影响面更大。
#[tauri::command]
pub fn af_read_audio_data_url(path: String) -> Result<String, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("音频路径为空".into());
    }
    let f = Path::new(p);
    if !f.is_file() {
        return Err(format!("文件不存在或不是普通文件: {p}"));
    }

    let bytes = std::fs::read(f).map_err(|e| format!("读取失败: {e}"))?;
    if bytes.is_empty() {
        return Err("文件为空".into());
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(format!(
            "音频过大（约 {} MB），上限 30 MB。可先转码压缩",
            bytes.len() / 1024 / 1024
        ));
    }

    let ext = f
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    let mime = match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "opus" => "audio/opus",
        "webm" => "audio/webm",
        _ => {
            return Err(format!(
                "不支持的音频格式：.{ext}（支持 mp3 / wav / ogg / m4a / aac / flac / opus / webm）"
            ))
        }
    };

    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
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


/*
 * 为什么要有这个。
 *
 * 保险箱主密钥原本只有两个来源：
 *
 *   auto        本机特征派生（UA/语言/时区/屏幕/核数 + 盐）
 *               盐就明文躺在应用数据目录里 —— **谁拷走整个目录，
 *               谁就能离线复现密钥、解开全部凭据**。
 *   passphrase  用户每次输口令（能防，但每次都要输）
 *
 * 第三条路：把主密钥交给 OS 保管 ——
 *   Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service。
 *   钥匙不在数据目录里，而在 OS 手里，且与用户登录态绑定。
 *   既不用每次输口令，又防得住"拷走整个目录"。
 *
 * ------------------------------------------------------------------ */

/// 在 OS 凭据管理器里的定位。service + account 一起确定一条记录。
const OS_KEYRING_SERVICE: &str = "nexus-panel.agent-flow";
const OS_KEYRING_ACCOUNT: &str = "credential-vault-key";

/// 取主密钥。Ok(None) = 还没存过（**不是错误**）。
#[tauri::command]
pub fn af_os_keyring_get() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(OS_KEYRING_SERVICE, OS_KEYRING_ACCOUNT)
        .map_err(|e| format!("OS 凭据管理器不可用: {e}"))?;

    match entry.get_password() {
        Ok(v) => {
            /*
             * 空串当"没有"。
             * 有些后端在记录不存在时返回空串而不是 NoEntry；
             * 若当成真密钥去解密，会得到"口令不对"的错，
             * 而正确的处理是"新建一条" —— 两者要修的方向完全不同。
             */
            if v.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(v))
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取 OS 凭据管理器失败: {e}")),
    }
}

/// 存主密钥。
#[tauri::command]
pub fn af_os_keyring_set(value: String) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("拒绝写入空的主密钥".to_string());
    }
    let entry = keyring::Entry::new(OS_KEYRING_SERVICE, OS_KEYRING_ACCOUNT)
        .map_err(|e| format!("OS 凭据管理器不可用: {e}"))?;

    entry
        .set_password(&value)
        .map_err(|e| format!("写入 OS 凭据管理器失败: {e}"))
}

/// 删主密钥。切换模式离开 OS 凭据管理器时调用 ——
/// 留着等于在数据目录之外又留了一把能解开旧密文的钥匙，而用户以为已经换掉了。
#[tauri::command]
pub fn af_os_keyring_delete() -> Result<(), String> {
    let entry = keyring::Entry::new(OS_KEYRING_SERVICE, OS_KEYRING_ACCOUNT)
        .map_err(|e| format!("OS 凭据管理器不可用: {e}"))?;

    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // 本来就没有 —— 正是想要的结果，不算失败
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除 OS 凭据管理器记录失败: {e}")),
    }
}
#[cfg(test)]
mod tests {
    /* P1-2：进程树终止。
       只测"能枚举到子孙"这一环 —— 真去 kill 会把测试进程自己牵连进去，
       不适合在单测里做。逻辑本身（自底向上、深度上限）靠代码审查保证。 */

    /// 起一个 sleep 子进程，验证能按 ppid 找到它。

/* ================================================================== */
/* OS 凭据管理器 —— 保险箱主密钥                                      */
/* ================================================================== */

    #[cfg(target_os = "linux")]
    #[test]
    fn lists_child_pids() {
        use std::process::{Command, Stdio};
        let Ok(mut kid) = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return; // 没有 sleep 就跳过，不算失败
        };
        let me = std::process::id();
        let kids = super::child_pids_of(me);
        assert!(kids.contains(&kid.id()), "没能在子进程列表里找到刚起的 sleep: {kids:?}");
        let _ = kid.kill();
        let _ = kid.wait();
    }
}
