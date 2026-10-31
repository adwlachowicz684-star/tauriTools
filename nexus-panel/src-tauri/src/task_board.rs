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
/// 合法任务状态（**默认值**；用户可在界面上改，改后存在 tasks.json 的 flow 里）。
///
/// 前端 core.mjs 的 STATUSES 与本行逐项同序（守卫第 22 节盯着）。
const STATUSES: [&str; 7] = ["todo", "claimed", "doing", "hold", "review", "done", "cancelled"];

/// 文件级全局锁：看板 UI 与 HTTP 服务两条写通道都要过它，
/// 否则「读-改-写」序列会被对方插在半途。
///
/// pub(crate)：MCP 统一网关（mcp_gate）的 native handler 也直调
/// 看板的业务函数，那是**第三条写通道** —— 不过这把锁的话，
/// AI 经网关的读-改-写会与另两条通道交叉，静默丢更新
/// （后写的覆盖先写的，双方都不报错、都看不到 TB_CONFLICT）。
pub(crate) fn file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 任务服务共享状态：端口 -> 运行中的服务 + 当前授权的数据目录。
/// 数据目录是显式授权的（tb_set_data_dir / tb_http_start 登记），
/// 读写命令只认授权目录 —— 不给自己开任意文件读写的后门。
pub struct TbState {
    pub servers: Mutex<HashMap<u16, TbServerEntry>>,
    pub data_dir: Mutex<Option<PathBuf>>,
    /// 文档目录（每个项目各自一个，改路径时用来搬文档）。
    /// 同样要显式授权 —— 不给自己开任意目录搬文件的后门。
    pub docs_dir: Mutex<Option<PathBuf>>,
    /*
      搬文档的**源**目录。tb_move_docs 需要同时授权两端，
      而 tb_set_docs_dir 一旦把 docs_dir 改成新目录，
      旧目录就掉出授权表了 —— 于是 from 端永远校验不过。

      （2026-10-28 自查发现：授权旧值被覆盖，搬家功能 100% 失败，
        且报错是"该目录尚未授权"，看着像设置没配好，实际是顺序问题。）
    */
    pub docs_dir_prev: Mutex<Option<PathBuf>>,
    /// 扫描/预览用的目标目录（用户选了但还没确认成项目文档目录）。
    /// 单独开一个槽：走 docs_dir 的话会顶掉当前项目真正的文档授权。
    pub pending_dir: Mutex<Option<PathBuf>>,
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

/// 登记文档目录（项目设置里选/改文档路径时调用）。创建目录并写入授权表。
#[tauri::command]
pub fn tb_set_docs_dir(state: State<'_, TbState>, dir: String) -> Result<String, String> {
    let path = PathBuf::from(&dir);
    if path.as_os_str().is_empty() {
        return Err("文档目录不能为空".to_string());
    }
    fs::create_dir_all(&path).map_err(|e| format!("创建文档目录失败 {}: {}", path.display(), e))?;
    let canon = path.canonicalize().unwrap_or(path);
    {
        /*
          ⛔ 旧值必须留一手：紧接着的 tb_move_docs 要用它当 **from**，
          而这里一旦覆盖，from 就掉出授权表，搬家必然失败。
          把它挪进 docs_dir_prev（仍算已授权），搬完自然失效。
        */
        let mut prev = state.docs_dir_prev.lock().unwrap_or_else(|e| e.into_inner());
        let mut guard = state.docs_dir.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = guard.take() {
            if old != canon {
                *prev = Some(old);
            }
        }
        *guard = Some(canon.clone());
    }
    Ok(canon.to_string_lossy().to_string())
}

/// 搬文档用的**严格**授权检查：只认确认过的目录，不含 pending_dir。
///
/// ⛔ 这条必须与 authorized_any 分开：pending_dir 是"用户选了、但只打算看一眼"
/// （扫描目标），而搬文档是破坏性操作（源目录会被移空）。
/// 让一个只读统计用的槽去授权搬移，等于扫一眼就能把文档搬走 ——
/// 而用户并没有确认要用那个目录。
fn authorized_move_end(state: &TbState, dir: &str) -> Result<PathBuf, String> {
    let want = PathBuf::from(dir);
    let canon = if want.exists() {
        want.canonicalize().unwrap_or(want.clone())
    } else {
        want.clone()
    };
    let data = state.data_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let docs = state.docs_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let prev = state.docs_dir_prev.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let ok = data.as_ref().map(|d| *d == canon).unwrap_or(false)
        || docs.as_ref().map(|d| *d == canon).unwrap_or(false)
        || prev.as_ref().map(|d| *d == canon).unwrap_or(false);
    if ok {
        Ok(canon)
    } else {
        Err("该目录尚未授权（请先在设置里确认目录）".to_string())
    }
}

/// 这个路径在已授权的目录里吗（数据目录或文档目录任一）。
fn authorized_any(state: &TbState, dir: &str) -> Result<PathBuf, String> {
    let want = PathBuf::from(dir);
    let canon = if want.exists() {
        want.canonicalize().unwrap_or(want.clone())
    } else {
        want.clone()
    };
    let data = state.data_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let docs = state.docs_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let prev = state.docs_dir_prev.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let pend = state.pending_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
    /*
      四个槽都算已授权 —— 每个槽里的目录都是用户在界面上显式选过的，
      不是任意路径：data_dir（任务库）/ docs_dir（当前文档）/
      docs_dir_prev（搬家的源）/ pending_dir（扫描目标）。
    */
    let ok = data.as_ref().map(|d| *d == canon).unwrap_or(false)
        || docs.as_ref().map(|d| *d == canon).unwrap_or(false)
        || prev.as_ref().map(|d| *d == canon).unwrap_or(false)
        || pend.as_ref().map(|d| *d == canon).unwrap_or(false);
    if ok {
        Ok(canon)
    } else {
        Err("该目录尚未授权（请先在设置里确认目录）".to_string())
    }
}

/// 把 `from` 目录里的**内容**（不是目录本身）整体搬到 `to`。
///
/// 为什么是"搬"而不是"复制"：两边都留一份的话，下次到底读哪边说不清，
/// 而且两份会各自演化 —— 那比没有更糟。
///
/// 安全上的三条硬约束：
///   · 两端都要已授权（走 authorized_any），不开任意路径的后门；
///   · `to` 不能位于 `from` 内部 —— 否则递归复制自己，目录会自我膨胀；
///   · 目标已存在同名项**跳过并报告**，不覆盖（覆盖是丢用户的文件，
///     而跳过至少东西还在旧位置，报出来让人自己决定）。
#[tauri::command]
pub fn tb_move_docs(
    state: State<'_, TbState>,
    from: String,
    to: String,
) -> Result<Value, String> {
    let src = authorized_move_end(&state, &from)?;
    let dst = authorized_move_end(&state, &to)?;
    if src == dst {
        return Err("源目录与目标目录相同".to_string());
    }
    /*
      ⛔ 这一条必须显式挡：目标在源内部时，复制过程会不断读到自己刚写进去的东西，
      目录自我膨胀直到磁盘写满；而调用方（改个路径）看上去只是个小操作。
    */
    if dst.starts_with(&src) {
        return Err(format!(
            "目标目录不能位于源目录内部（{} 在 {} 里）—— 会把文档复制进自己",
            dst.display(),
            src.display()
        ));
    }
    if !src.is_dir() {
        return Err(format!("源目录不存在或不是目录: {}", src.display()));
    }
    fs::create_dir_all(&dst).map_err(|e| format!("创建目标目录失败 {}: {}", dst.display(), e))?;

    let mut moved: usize = 0;
    let mut skipped: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    let entries = fs::read_dir(&src).map_err(|e| format!("读取源目录失败: {}", e))?;
    for entry in entries {
        let entry = match entry {
            Ok(x) => x,
            Err(e) => {
                failed.push(format!("<读取失败: {}>", e));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let from_path = entry.path();
        let to_path = dst.join(&name);
        if to_path.exists() {
            skipped.push(name);   // 不覆盖：覆盖是丢文件，跳过至少东西还在
            continue;
        }
        // 同一盘内 rename 是原子的；跨盘 rename 会失败，退回「复制 + 删源」。
        if fs::rename(&from_path, &to_path).is_ok() {
            moved += 1;
            continue;
        }
        let copied = if from_path.is_dir() {
            copy_dir_recursive(&from_path, &to_path)
        } else {
            fs::copy(&from_path, &to_path).map(|_| ())
        };
        match copied {
            Ok(()) => {
                // 复制成功了才删源 —— 中途失败的话文件还在旧位置，不会两头都没有
                let _ = if from_path.is_dir() {
                    fs::remove_dir_all(&from_path)
                } else {
                    fs::remove_file(&from_path)
                };
                moved += 1;
            }
            Err(e) => {
                // 复制失败要把半成品清掉，否则目标目录里留个半截文件夹
                let _ = if to_path.is_dir() {
                    fs::remove_dir_all(&to_path)
                } else {
                    fs::remove_file(&to_path)
                };
                failed.push(format!("{}（{}）", name, e));
            }
        }
    }

    Ok(json!({
        "moved": moved,
        "skipped": skipped,
        "failed": failed,
    }))
}

/// 扫描一个目录，用于**导入项目前的验证**。
///
/// 为什么要在导入前扫一遍：用户选的文件夹未必是他以为的那个 ——
/// 可能是上级目录（里面是一堆无关项目）、也可能是空目录。
/// 不验证就直接建项目，结果是建出一个指向错地方的项目，
/// 而界面上看不出来（项目名是对的，只是里面什么都没有）。
///
/// 只统计、不读文件内容：验证阶段读内容既慢又没必要。
#[tauri::command]
pub fn tb_scan_dir(state: State<'_, TbState>, dir: String) -> Result<Value, String> {
    let want = PathBuf::from(&dir);
    if want.as_os_str().is_empty() {
        return Err("目录不能为空".to_string());
    }
    if !want.is_dir() {
        return Err(format!("不是目录: {}", want.display()));
    }
    let base = want.canonicalize().unwrap_or(want);
    /*
      授权进 pending 而不是 docs_dir：
      扫描只是"看看里面有什么"，还没确认要用它 ——
      走 docs_dir 会把当前项目真正的文档授权顶掉。
    */
    {
        let mut pend = state.pending_dir.lock().unwrap_or_else(|e| e.into_inner());
        *pend = Some(base.clone());
    }
    let mut tasks_json = false;
    let mut md = 0usize;
    let mut subdirs = 0usize;
    let mut others = 0usize;
    let mut sample: Vec<String> = Vec::new();

    let entries = fs::read_dir(&base).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries {
        let entry = match entry {
            Ok(x) => x,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if path.is_dir() {
            subdirs += 1;
        } else if name == "tasks.json" {
            tasks_json = true;
        } else if name.to_lowercase().ends_with(".md") {
            md += 1;
        } else {
            others += 1;
        }
        if sample.len() < 12 {
            sample.push(name);
        }
    }

    Ok(json!({
        "dir": base.to_string_lossy(),
        "tasksJson": tasks_json,
        "mdCount": md,
        "dirCount": subdirs,
        "otherCount": others,
        "sample": sample,
    }))
}

/// 递归复制目录（跨盘搬文件时用）。只处理普通目录与文件。
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
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
/// `notify_url` 非空时：任务经 HTTP 进入 `notify_status` 会向它 POST 一份通知
/// （agent-flow webhook 触发器地址，见 docs/AGENT-FLOW.md）。
///
/// ⛔ `notify_status` 必须由前端下发，不能在这里写死 "review"：
/// 自定义流程里那一步可能叫别的名字，写死的话配了 notify_url 也**永远收不到通知**
/// （界面那条通道能收到、HTTP 这条收不到 —— 两边不一致，且没有提示）。
#[tauri::command]
pub fn tb_http_start(
    state: State<'_, TbState>,
    port: u16,
    token: String,
    data_dir: String,
    notify_url: String,
    notify_status: String,
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
    let notify_status_c = notify_status.clone();

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
                    let notify_status_t = notify_status_c.clone();
                    thread::spawn(move || {
                        let mut s = stream;
                        let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
                        // 写超时：持全局文件锁期间写响应，慢客户端不能拖死其他通道
                        let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
                        handle_conn(&mut s, &dir_t, &token_t, &notify_t, &notify_status_t);
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

fn handle_conn(
    stream: &mut TcpStream,
    dir: &PathBuf,
    expect_token: &str,
    notify_url: &str,
    notify_status: &str,
) {
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
    let resp = route(&req, dir, notify_status);
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
fn route(req: &Request, dir: &PathBuf, notify_status: &str) -> (u16, String, Option<String>) {
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
            Ok(body) => match patch_task(dir, id, &body, notify_status) {
                Ok((t, entered_notify)) => {
                    /*
                      进入**通知状态**即通知（agent-flow 审查流程的触发源）。
                      状态由配置决定，不写死 review —— 理由见 tb_http_start 处。
                    */
                    let notice = entered_notify.then(|| {
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
                "status":   { "type": "string", "enum": ["todo", "claimed", "doing", "hold", "review", "done", "cancelled"], "description": "按状态过滤，缺省=全部" },
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
                "summary":  { "type": "string", "description": "任务说明（与详情分开：说明是要做什么，详情是复现/期望行为）" },
                "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"], "description": "默认 P2" },
                "tags":     { "type": "array", "items": { "type": "string" }, "description": "自由标签" },
                "type":     { "type": "string", "description": "任务类型 id（dev/bug/opt/research/review/plan，或自定义类型的 id）；缺省=未分类" },
                "estimate": { "type": "number", "description": "预估工作量，单位人日，可小数（0.5=半天）；缺省 0=没估" },
                "group":    { "type": "string", "description": "分组名（手动分组；留空=不分组）。按此列分组即可重现手动分组的归拢效果" },
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
                "status":   { "type": "string", "enum": ["todo", "claimed", "doing", "hold", "review", "done", "cancelled"], "description": "目标状态（流转图校验：todo/claimed 不可直跳 done）" },
                "assignee": { "type": "string", "description": "认领人；已被他人认领会被拒绝；空串=释放认领" },
                "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"], "description": "改优先级" },
                "title":    { "type": "string", "description": "改标题" },
                "detail":   { "type": "string", "description": "改详情" },
                "summary":  { "type": "string", "description": "改任务说明" },
                "tags":     { "type": "array", "items": { "type": "string" }, "description": "整体替换标签" },
                "type":     { "type": "string", "description": "任务类型 id；传空串=清成未分类" },
                "estimate": { "type": "number", "description": "预估工作量，单位人日，可小数" },
                "group":    { "type": "string", "description": "分组名；传空串=取消分组" },
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
            /*
              MCP 通道没有 HTTP 服务配置可拿（那是 tb_http_start 的参数），
              这里用默认 "review"。

              注意：MCP 这个返回值只是**告诉调用方"本次进入了通知状态"**，
              真正的 POST 由 HTTP 服务侧做（那边读的是配置里的 notify_status）。
              所以两边在自定义流程下会不一致 —— 已在下方注释里标明，
              要彻底一致得把通知状态存进 tasks.json（与 flow 同库）。
            */
            patch_task(dir, &s("id").unwrap_or_default(), args, "review").map(|(t, review)| {
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
/// 读**用户自定义**的状态清单（tasks.json → flow.statuses）。没配过返回 None。
///
/// 为什么双端都要认它：只前端认的话，AI 经 HTTP/MCP 写一个自定义状态
/// 会被这里拒掉，表现为"界面上能选、API 写不进去"——两边都不报错，
/// 只是一个写不进去，这种不一致最难自查。
///
/// 认两种写法：`[{"id":"todo",...}]`（界面写的）和 `["todo",...]`（手写图省事）。
fn flow_statuses(store: &Value) -> Option<Vec<String>> {
    let arr = store.get("flow")?.get("statuses")?.as_array()?;
    let mut out: Vec<String> = Vec::new();
    for one in arr.iter() {
        let id = match one.as_str() {
            Some(s) => s.to_string(),
            None => one.get("id")?.as_str()?.to_string(),
        };
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// 这份数据认哪些状态：自定义优先，没配过用默认那套。
fn statuses_for(store: &Value) -> Vec<String> {
    match flow_statuses(store) {
        Some(v) => v,
        None => STATUSES.iter().map(|s| s.to_string()).collect(),
    }
}

/// 自定义流转表（tasks.json → flow.transitions）。**先拷成自有数据**再返回：
/// 调用点在 `store["tasks"].as_array_mut()` 的可变借用之内，
/// 那时候再借 &store 会被借用检查器拒（E0502）。
fn flow_transitions(store: &Value) -> Option<HashMap<String, Vec<String>>> {
    let obj = store.get("flow")?.get("transitions")?.as_object()?;
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for (k, v) in obj.iter() {
        let arr: Vec<String> = match v.as_array() {
            Some(a) => a.iter().filter_map(|x| x.as_str()).map(|x| x.to_string()).collect(),
            None => continue,
        };
        out.insert(k.clone(), arr);
    }
    if out.is_empty() { None } else { Some(out) }
}

/// 按这份数据的配置判断能不能流转。没配过流转表就走默认那张图。
///
/// ⛔ 表里写了起点但没列目标 → **不放行**：
/// 那是"配了这个状态却什么都不能走"，照默认放行等于配错了还照旧运行。
fn can_flow(
    table: Option<&HashMap<String, Vec<String>>>,
    from: &str,
    to: &str,
) -> bool {
    if from == to {
        return true;
    }
    match table {
        Some(t) => match t.get(from) {
            Some(arr) => arr.iter().any(|x| x == to),
            None => false,
        },
        None => can_transition(from, to),
    }
}

fn can_transition(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    let allowed: &[(&str, &[&str])] = &[
        ("todo", &["claimed", "doing", "hold", "cancelled"]),
        ("claimed", &["doing", "todo", "hold", "cancelled"]),
        ("doing", &["review", "todo", "hold", "cancelled"]),
        ("hold", &["doing", "todo", "cancelled"]),
        ("review", &["done", "doing", "hold", "cancelled"]),
        ("done", &["review"]),
        ("cancelled", &["todo"]),
    ];
    allowed
        .iter()
        .find(|(f, _)| *f == from)
        .map(|(_, ts)| ts.contains(&to))
        .unwrap_or(false)
}

/// 人日显示：去掉浮点尾巴（0.1+0.2 会算出 0.30000000000000004）
fn fmt_est(n: f64) -> String {
    let r = (n * 100.0).round() / 100.0;
    format!("{}", r)
}

/// 取预估工作量（人日，可小数）。非法/负数 → 0（"没估"）。
///
/// ⛔ 不报错：这只是个估算字段，因为填了 -1 或 "三天" 就让 AI 建任务失败，
/// 代价远大于把它当"没估"处理 —— 后者至少任务建成了，人能看到并改。
fn estimate_of(body: &Value) -> f64 {
    let n = match body.get("estimate") {
        Some(v) => v.as_f64().or_else(|| v.as_i64().map(|x| x as f64)),
        None => None,
    };
    match n {
        Some(x) if x.is_finite() && x > 0.0 => x,
        _ => 0.0,
    }
}

fn create_task(dir: &PathBuf, body: &Value) -> Result<Value, String> {
    let title = str_field(body, "title").unwrap_or_default();
    if title.trim().is_empty() {
        return Err("title 不能为空".to_string());
    }
    let priority = str_field(body, "priority").unwrap_or_else(|| "P2".to_string());
    if !["P0", "P1", "P2", "P3"].contains(&priority.as_str()) {
        return Err(format!("非法优先级 {}（合法值: P0/P1/P2/P3）", priority));
    }
    let mut store = load_tasks(dir)?;
    /*
      新建只允许落在**初始状态**：想认领/开工/送审走 PATCH，
      别在建任务时一步跳过整个流程。
      初始状态 = 本项目状态清单的第一个（配过自定义流程时不一定是 todo），
      所以这段必须放在 load_tasks 之后 —— 得先知道这个项目配了哪些状态。
    */
    let initial = statuses_for(&store)
        .first()
        .cloned()
        .unwrap_or_else(|| "todo".to_string());
    if let Some(s) = str_field(body, "status") {
        if s != initial {
            return Err(format!(
                "新建任务只允许 status={}（收到 {}）；后续流转走 PATCH",
                initial, s
            ));
        }
    }
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
    task.insert("status".to_string(), json!(initial));
    task.insert("priority".to_string(), json!(priority));
    // 预估工作量（人日，可小数）。缺省 0 = 没估。
    task.insert("estimate".to_string(), json!(estimate_of(body)));
    /*
      任务类型：存定义表里的 id（'dev'/'bug'…），不是显示名。
      每个字段都显式写进文件 —— 这份 JSON 是给 AI 直接读改的，
      字段在文件里**看得见**它才会去填；靠前端默认值补出来的字段，
      AI 根本不知道有这一项。（与前端 createTask 同一判据。）
    */
    task.insert(
        "type".to_string(),
        json!(str_field(body, "type").unwrap_or_default().trim()),
    );
    task.insert(
        "tags".to_string(),
        body.get("tags")
            .filter(|v| v.is_array())
            .cloned()
            .unwrap_or(json!([])),
    );
    /*
      分组列：相当于以前的"手动分组"，但只是一列字符串值 ——
      归拢由"按列分组"机制表达，不再有组记录/父子层级。
      显式写进文件（哪怕为空）：这份 JSON 是给 AI 直接读改的，
      字段在文件里**看得见**它才会去填。
    */
    task.insert(
        "group".to_string(),
        json!(str_field(body, "group").unwrap_or_default().trim()),
    );
    /*
      任务说明（summary）。与 detail 分开：
      说明是"要做什么"（原始要求），详情是复现/期望行为。

      ⛔ 这个字段后来才加，而**建任务时一直没写** ——
      于是 AI 建出来的任务永远没有说明，
      只能建完再改（而改的通道以前也没有，见下方 patch）。
      文件里明明有这一列（显式写出来的），AI 看得见却填不了。
    */
    task.insert(
        "summary".to_string(),
        json!(str_field(body, "summary").unwrap_or_default().trim()),
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

/// 返回 (任务快照, 本次是否进入**通知状态**)——后者驱动 webhook 通知。
/// 通知状态由 notify_status 传入（可配），不再写死 review。
fn patch_task(
    dir: &PathBuf,
    id: &str,
    body: &Value,
    notify_status: &str,
) -> Result<(Value, bool), String> {
    let mut store = load_tasks(dir)?;
    /*
      **在进入可变借用之前**把配置取成自有数据：下面 `store["tasks"].as_array_mut()`
      会一直持有 &mut store，那时候再借 &store 会被借用检查器拒（E0502）。
    */
    let allowed = statuses_for(&store);
    let flow = flow_transitions(&store);
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
        // 「本次是否从别处进入 review」：进过的不再算（见下方 became 处的注释），
        // 初值 false，由下方 status 流转段置位。此前漏了声明，编译不过（已补）。
        let mut entered_review = false;
        // ⛔ summary 必须在这里：任务说明是显式写进文件的字段，
        // AI 看得见却改不了，等于这个字段对 AI 通道只读。
        for key in ["title", "detail", "summary", "priority", "reporter"] {
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
        if let Some(v) = str_field(body, "type") {
            // 取所有权：下面 obj.insert 是可变借用，&str 借到 obj 上会冲突（E0502）
            let cur = obj.get("type").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let next = v.trim();
            if cur != next {
                obj.insert("type".to_string(), json!(next));
                changed = true;
                push_history(
                    obj,
                    &by,
                    "type",
                    &format!("{} -> {}", if cur.is_empty() { "未分类" } else { cur.as_str() },
                             if next.is_empty() { "未分类" } else { next }),
                );
            }
        }
        if let Some(v) = str_field(body, "group") {
            // 取所有权：下面 obj.insert 是可变借用，&str 借到 obj 上会冲突（E0502）
            let cur = obj.get("group").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let next = v.trim();
            if cur != next {
                obj.insert("group".to_string(), json!(next));
                changed = true;
                push_history(
                    obj,
                    &by,
                    "group",
                    &format!("{} -> {}", if cur.is_empty() { "未分组" } else { cur.as_str() },
                             if next.is_empty() { "未分组" } else { next }),
                );
            }
        }
        if let Some(v) = body.get("estimate") {
            let cur = obj.get("estimate").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let next = estimate_of(&json!({ "estimate": v.clone() }));
            if (cur - next).abs() > 1e-9 {
                obj.insert("estimate".to_string(), json!(next));
                changed = true;
                push_history(obj, &by, "estimate", &format!("{} -> {}", fmt_est(cur), fmt_est(next)));
            }
        }
        if let Some(status) = str_field(body, "status") {
            // 认这份数据自己配的状态（没配过就是默认那七个）
            if !allowed.iter().any(|x| x == &status) {
                return Err(format!(
                    "非法状态 {}（本项目合法值: {}）",
                    status,
                    allowed.join("/")
                ));
            }
            let old = obj.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if old != status {
                if !can_flow(flow.as_ref(), &old, &status) {
                    return Err(format!(
                        "不允许的流转 {} -> {}（合法路径见本项目流程配置或 docs/AI-CONVENTIONS.md 状态图）",
                        old, status
                    ));
                }
                obj.insert("status".to_string(), json!(status));
                changed = true;
                /*
                  记下"本次是不是从别处进入**通知状态**"（进过的不再算）。
                  ⛔ 判据不能写死 "review"：自定义流程里那一步可能叫别的，
                  写死的话配了 notify_url 也永远收不到通知。
                */
                let watch = if notify_status.trim().is_empty() { "review" } else { notify_status.trim() };
                if status == watch && old != watch {
                    entered_review = true;
                }
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
        /*
         * 「本次**进入** review」才算送审触发，不是「终态是 review」。
         * 判终态的话：对已在 review 的任务改个标题/备注也会再发一份
         * submit-review webhook —— agent-flow 侧重复触发审查流程，
         * 而用户只觉得"我就改了个字"。（2026-10-17 深查修）
         */
        let became = entered_review;
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
    /* 预估工作量（人日，可小数） */
    #[test]
    fn estimate_accepts_fraction() {
        assert_eq!(estimate_of(&serde_json::json!({"estimate": 2.5})), 2.5);
        assert_eq!(estimate_of(&serde_json::json!({"estimate": 0.5})), 0.5);
    }

    #[test]
    fn estimate_missing_is_zero() {
        assert_eq!(estimate_of(&serde_json::json!({})), 0.0);
        assert_eq!(estimate_of(&serde_json::json!({"estimate": null})), 0.0);
    }

    #[test]
    fn estimate_invalid_becomes_zero_not_error() {
        // 没估 / 负数 / 非数字都不报错，一律记 0 —— 这只是估算字段，
        // 因为填了 -1 或 "三天" 就让建任务失败，代价远大于当"没估"
        assert_eq!(estimate_of(&serde_json::json!({"estimate": -3})), 0.0);
        assert_eq!(estimate_of(&serde_json::json!({"estimate": "三天"})), 0.0);
    }

    #[test]
    fn fmt_est_drops_float_tail() {
        // 0.1+0.2 不该显示成 0.30000000000000004
        assert_eq!(fmt_est(0.1 + 0.2), "0.3");
        assert_eq!(fmt_est(2.0), "2");
    }

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
