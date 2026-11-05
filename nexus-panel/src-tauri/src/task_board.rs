//! task_board — 任务管理器本地 HTTP API 服务。
//!
//! 定位：给「多 AI 窗口 + agent-flow 流程」提供统一的任务存取通道。
//! 数据落在单一 tasks.json（数据目录由插件设置决定，默认 app_data_dir/task-board/），
//! 看板 UI、AI 窗口（curl）、agent-flow（generic-http 节点）三方共用这一份数据。
//!
//! 路由（全部 JSON，端口默认 9911，绑 127.0.0.1）：
//!   GET    /api/health              服务探活
//!   GET    /api/tasks               任务列表 + 窗口身份 + defs；支持 status/priority/
//!                                   type/group/tag/assignee/q 过滤（重复键累加）
//!   GET    /api/tasks/{id}          单条任务 + defs
//!   POST   /api/tasks               新建 {title, detail?, summary?, priority?, tags?,
//!                                   type?, group?, assignee?, estimate?, deps?, reporter?}
//!   PATCH  /api/tasks/{id}          改字段/流转 {status?, assignee?, type?, group?,
//!                                   priority?, title?, detail?, summary?, reporter?,
//!                                   tags?, deps?, estimate?, by?, note?}（三个多值列也认数组）
//!   DELETE /api/tasks/{id}          删除任务（不可撤销；响应带 dependents）
//!   POST   /api/tasks/{id}/events   追加事件 {by, action, note?}
//!   POST   /api/agents              注册窗口身份 {id, name?, role?}
//!   POST   /mcp                     MCP JSON-RPC 2.0（7 个工具，支持 batch）
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
/// 合法任务状态（**默认值**；用户可在界面上改，改后存在 tasks.json 的 flow 里）。
/// 前端 core.mjs 的 STATUSES 与本行逐项同序（守卫第 22 节盯着）。
const STATUSES: [&str; 7] = ["todo", "claimed", "doing", "hold", "review", "done", "cancelled"];

/// 默认流转图。与前端 `DEFAULT_FLOW.transitions` 同一份。
/// ⛔ 原先这份字面量只存在于 `can_transition` 内部，defs 想给 AI 看流转图
/// 就只能再抄一遍 —— 两份字面量必然漂移。抽成常量，两处共用。
const DEFAULT_TRANSITIONS: &[(&str, &[&str])] = &[
    ("todo", &["claimed", "doing", "hold", "cancelled"]),
    ("claimed", &["doing", "todo", "hold", "cancelled"]),
    ("doing", &["review", "todo", "hold", "cancelled"]),
    ("hold", &["doing", "todo", "cancelled"]),
    ("review", &["done", "doing", "hold", "cancelled"]),
    ("done", &["review"]),
    ("cancelled", &["todo"]),
];

/// 默认状态**完整定义**（id / 名字 / 颜色 / 进入动词 / 是否完成态）。
/// 与前端 `DEFAULT_FLOW.statuses` 逐项对齐；跨端守卫按名字集合比对。
/// 没配自定义流程时，defs.statusDefs 就回这份 —— AI 也看得见"待审查"对应 review。
const DEFAULT_STATUS_DEFS: &[(&str, &str, &str, &str, bool)] = &[
    ("todo", "待办", "#78716c", "退回", false),
    ("claimed", "已认领", "#0ea5e9", "认领", false),
    ("doing", "进行中", "#3b82f6", "开始", false),
    ("hold", "挂起", "#f59e0b", "挂起", false),
    ("review", "待审查", "#a855f7", "提交审查", false),
    ("done", "已完成", "#22c55e", "通过", true),
    ("cancelled", "已取消", "#ef4444", "取消", false),
];

/// 合法优先级 **P0~P5 六档**，与前端 types.ts 的 PRIORITY_ORDER 逐项同序
/// （守卫钉着，不一致时 AI 通道会拒掉界面上明明能选的档位）。
///
/// ⛔ 以前这里写死四档，且 create_task 会**硬拒** P4/P5：
/// 界面扩到六档之后，AI 经 HTTP/MCP 建一条 P4 任务直接得到
/// 「非法优先级 P4（合法值: P0/P1/P2/P3）」—— 前端能选、后端不认。
/// schema、create、update 三处共用这一份，不再各写各的字面量。
const PRIORITIES: [&str; 6] = ["P0", "P1", "P2", "P3", "P4", "P5"];

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
            /* 与 MCP tb_list_tasks 同一份过滤判据；count 也一并对齐 */
            Ok(store) => {
                let f = TaskFilter::from_query(req);
                let hit: Vec<&Value> = store
                    .get("tasks")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter(|t| f.matches(t, &store)).collect())
                    .unwrap_or_default();
                ok_json(json!({"ok": true, "count": hit.len(), "tasks": hit,
                       "agents": store.get("agents").cloned().unwrap_or(json!([])),
                       "defs": defs_of(&store)}))
            }
            Err(e) => (api_status(&e), err_json(&e), None),
        },
        ("GET", ["api", "tasks", id]) => {
            let id = match norm_path_id(id) {
                Ok(v) => v,
                Err(e) => return (api_status(&e), err_json(&e), None),
            };
            match load_tasks(dir) {
                Ok(store) => match find_task(&store, &id) {
                    /* 与全量读通道同一口径：AI 取单条后也要能查可选值 */
                    Some(t) => ok_json(json!({"ok": true, "task": t, "defs": defs_of(&store)})),
                    /*
                      ⛔ 原 404 是硬编码英文 "task not found"、不带 id、也不走 api_status，
                      而 MCP tb_get_task 回的是「任务 {id} 不存在」。
                      前几轮把两条通道的字段/能力/错误码都对齐了，唯独错误体没对齐 ——
                      AI 拿到 "task not found" 分不清是路径写错还是任务真没了。
                    */
                    None => {
                        let e = format!("任务 {} 不存在", id);
                        (api_status(&e), err_json(&e), None)
                    }
                },
                Err(e) => (api_status(&e), err_json(&e), None),
            }
        },
        ("POST", ["api", "tasks"]) => match parse_write_body(&req.body, TB_CREATE, None) {
            Ok(body) => match create_task(dir, &body) {
                Ok(t) => ok_json(json!({"ok": true, "task": t})),
                Err(e) => (api_status(&e), err_json(&e), None),
            },
            Err(e) => (400, err_json(&e), None),
        },
        ("PATCH", ["api", "tasks", id]) => {
            let id = match norm_path_id(id) {
                Ok(v) => v,
                Err(e) => return (api_status(&e), err_json(&e), None),
            };
            match parse_write_body(&req.body, TB_UPDATE, Some(id.as_str())) {
            Ok(body) => match patch_task(dir, &id, &body, notify_status) {
                Ok((t, entered_notify)) => {
                    /*
                      进入**通知状态**即通知（agent-flow 审查流程的触发源）。
                      状态由配置决定，不写死 review —— 理由见 tb_http_start 处。
                    */
                    let notice = entered_notify.then(|| {
                        /*
                          ⛔ 原来发整条任务（"task": t）。而前端 notifyWebhook 发的只是
                          { id, title, status, assignee: 显示串 } —— 同一个
                          submit-review 事件两种形状。对端按字符串读 assignee 时，
                          AI 通道送过去的是数组 → 显示成 "张三,李四" 或解析失败；
                          整条任务还带 history / deps / estimate，一起 POST 出去没有用途。
                          现在与前端用同一份契约（多值认领人用「、」连成显示串）。
                        */
                        json!({
                            "source": "task-board",
                            "event": "submit-review",
                            "task": json!({
                                "id": t.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                                "title": t.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                                "status": t.get("status").and_then(|v| v.as_str()).unwrap_or(""),
                                "assignee": vals_of(&t, "assignee").join("、"),
                            }),
                        })
                        .to_string()
                    });
                    /* ⛔ MCP 分支有 entered_notify_status，HTTP 原来没有 ——
                       同一个「本次是否进入通知状态」的结论两条通道给得不一样。 */
                    (200, json!({"ok": true, "entered_notify_status": entered_notify, "task": t}).to_string(), notice)
                }
                Err(e) => (api_status(&e), err_json(&e), None),
            },
            Err(e) => (400, err_json(&e), None),
            }
        },
        ("DELETE", ["api", "tasks", id]) => {
            let id = match norm_path_id(id) {
                Ok(v) => v,
                Err(e) => return (api_status(&e), err_json(&e), None),
            };
            match delete_task(dir, &id) {
                Ok(v) => {
                    let mut out = Map::new();
                    out.insert("ok".to_string(), json!(true));
                    if let Some(obj) = v.as_object() {
                        /* ⛔ 显式 UFCS：k/val 都是引用，`k.clone()` 可能解析成
                           `<&String as Clone>::clone` 返回 &String（insert 要 String）。
                           用 to_string / Value::clone 消掉歧义，编译更稳。 */
                        for (k, val) in obj {
                            out.insert(k.to_string(), Value::clone(val));
                        }
                    }
                    ok_json(Value::Object(out))
                }
                Err(e) => (api_status(&e), err_json(&e), None),
            }
        },
        ("POST", ["api", "tasks", id, "events"]) => {
            let id = match norm_path_id(id) {
                Ok(v) => v,
                Err(e) => return (api_status(&e), err_json(&e), None),
            };
            match parse_write_body(&req.body, TB_EVENT, Some(id.as_str())) {
            Ok(body) => match add_event(dir, &id, &body) {
                Ok(t) => (200, json!({"ok": true, "task": t}).to_string(), None),
                Err(e) => (api_status(&e), err_json(&e), None),
            },
            Err(e) => (400, err_json(&e), None),
            }
        },
        ("POST", ["api", "agents"]) => match parse_write_body(&req.body, TB_AGENT, None) {
            Ok(body) => match register_agent(dir, &body) {
                Ok(agents) => (200, json!({"ok": true, "agents": agents}).to_string(), None),
                Err(e) => (api_status(&e), err_json(&e), None),
            },
            Err(e) => (400, err_json(&e), None),
        },
        ("POST", ["mcp"]) => {
            // MCP JSON-RPC 2.0 端点：鉴权已在上游 handle_conn 统一做过
            let (code, body) = mcp_handle(&req.body, dir, notify_status);
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
        /*
          ⛔ 原来 `let _ = write_all(...)` 把 TCP 写失败也吞了。
          和前端 fetch 那边的坑同理：写不出去一声不吭。
        */
        /* 顺序闭包写法：避免 and_then 链里嵌套 &mut stream 的借用争议 */
        let write_result = (|| -> std::io::Result<()> {
            stream.write_all(head.as_bytes())?;
            stream.write_all(body.as_bytes())?;
            stream.flush()
        })();
        if let Err(e) = write_result {
            eprintln!("[task-board] 通知写出失败 {}: {}", host_port, e);
            return;
        }
        /*
          ⛔ 原来"不读响应"：URL 配错(404)、对端接口报错(500)、网关挂了(502)
          全都当成发出去了，这一侧一声不吭。前端 notifyWebhook 早就改成
          检查 !res.ok 并提示，AI 通道是**同一根因、另一条路**。
          这里没有 UI 可弹 toast，至少把状态行读出来写进 stderr，
          让用户/日志能查到"不是对端没收到，是它回了错误"。
          只读状态行就够，body 不必消费（Connection: close 随后断开）。
        */
        let mut reader = BufReader::new(stream);
        let mut status_line = String::new();
        match reader.read_line(&mut status_line) {
            Ok(0) => eprintln!("[task-board] 通知对端未返回响应: {}", url),
            Ok(_) => {
                let code = status_line.split_whitespace().nth(1).unwrap_or("?");
                if !code.starts_with('2') {
                    eprintln!("[task-board] 通知没发出去（对端返回 {}）: {}", code.trim(), url);
                }
            }
            Err(e) => eprintln!("[task-board] 通知读响应失败 {}: {}", host_port, e),
        }
    });
}

/*
  ⛔ 业务错误原来**一律 500**。而同一个 route 里，GET 单条「没找到」已经是 404、
  parse_body 失败已经是 400 —— 同一函数内两种判据。

  后果不只是"码不好看"：AI 客户端看到 5xx 会判定服务端故障，去查端口 / token /
  重试（很多 HTTP 客户端对 5xx 自动重试），而错误其实是确定性的参数问题
  （非法优先级、任务不存在、没有可应用的变更、空事件、流转不允许）。
  排查方向整个反了 —— 与前几轮修的「流转失败文案把人往任务不存在上引」
  「通知失败静默让用户在 对端 排查」是同一族：报错把人往反方向引。

  分类集中在这一处：不带 I/O 特征的业务错误 = 400；目标不存在 = 404；
  load_tasks / save_tasks 的 `?` 传播错误带这些固定前缀 = 500（真的服务端/文件问题）。
  守卫钉住前缀清单覆盖所有 I/O 错误文案，改文案时不会静默失准。
*/
fn api_status(e: &str) -> u16 {
    const IO_PREFIXES: &[&str] = &[
        "读取 tasks.json 失败", "tasks.json 已损坏", "tasks.json 顶层不是对象",
        "序列化失败", "写临时文件失败", "替换 tasks.json 失败",
        "tasks 不是数组", "agents 不是数组", "任务不是对象",
    ];
    /*
      ⛔ 原来是 `e.contains("不存在")` —— 子串匹配太宽：
        · 自定义状态名恰好叫「不存在」→ 「非法状态 不存在…」被判 404
        · IO 错误的 detail 里带「目录不存在」→ 文件故障被判 404
        · 「任务不存在于当前项目」这类别的文案也被判 404
      先判 IO 前缀（真的服务端/文件故障 = 500），再按**形状**判目标不存在
      （`任务 {id} 不存在`），其余一律 400。与前面反复修的
      「indexOf 子串匹配导致守卫假绿」是同一类：判据要看形状，不看子串。
    */
    if IO_PREFIXES.iter().any(|p| e.starts_with(p)) {
        500
    } else if e.starts_with("任务 ") && e.ends_with("不存在") {
        404
    } else {
        400
    }
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

/// MCP 工具表。7 个工具覆盖任务全生命周期，参数与 HTTP API 一致。
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
            "列出任务看板全部任务（可按状态/优先级/类型/分组/标签/认领人/关键词过滤；除 q 外每个参数都可传数组表示 OR 命中，HTTP GET /api/tasks 的 query string 也支持同一套参数、重复键累加）。响应里的 defs 带了各列定义表（groupDefs/typeDefs/tagDefs/assigneeDefs/priorityDefs）、生效状态清单（statuses）、状态完整定义 statusDefs（名字/颜色/是否完成态）、界面实际生效的流转图 transitions、以及新建任务必须落在的初始状态 initial——建任务或改字段前先读它，才知道各列有哪些可选值、当前状态能流转到哪。⛔ 过滤参数里的 "__none__" 只是查询「空值」的标记，不是可以写进任务的值；写入侧会把它清掉，清空某一列请传空串或空数组",
            json!({
                "status":   { "type": ["string", "array"], "description": "按状态过滤，缺省=全部；传数组=多个状态 OR 命中。⛔ 不写 enum：用户可能自定义过流程，写死那 7 个会让严格校验 schema 的 MCP 客户端在本地就拒掉自定义状态；实际生效的状态看响应里的 defs.statuses" },
                "priority": { "type": ["string", "array"], "enum": PRIORITIES, "description": "按优先级过滤；传数组=多档 OR 命中" },
                "tag":      { "type": ["string", "array"], "description": "按标签过滤；传数组=任一命中；传 \"__none__\" 查无标签（与 assignee/type/group 同一判据）" },
                "assignee": { "type": ["string", "array"], "description": "按认领人过滤（该列可多选，任务上数组里的任一值命中即算；参数本身也能传数组=多人 OR）；传 \"__none__\" 查未认领" },
                "type":     { "type": ["string", "array"], "description": "按任务类型 id 过滤（任务上可多选，任一命中即算；参数也能传数组=多类型 OR）；传 \"__none__\" 查未分类。可选值看响应 defs.typeDefs" },
                "group":    { "type": ["string", "array"], "description": "按分组名过滤（任务上可多选，任一命中即算；参数也能传数组=多分组 OR）；传 \"__none__\" 查未分组。可选值看响应 defs.groupDefs" },
                "q":        { "type": ["string", "array"], "description": "关键词，匹配 id/标题/详情/说明，以及状态/优先级/分组/认领人/类型/标签的原始值与定义表显示名（多值列逐个匹配；自定义流程的状态按流程里配的名字，默认流程按状态 id）。字符串或字符串数组都认；多个关键词 OR（任一命中即可），与其余过滤参数判据一致" },
            }),
            vec![],
        ),
        tool(
            "tb_create_task",
            "新建任务（发现问题→建任务交给其他窗口认领）。新建只允许落在初始状态（看 defs.initial），想流转走 tb_update_task",
            json!({
                "title":    { "type": "string", "description": "一句话说清问题" },
                "detail":   { "type": "string", "description": "复现步骤/期望行为，可选" },
                "summary":  { "type": "string", "description": "任务说明（与详情分开：说明是要做什么，详情是复现/期望行为）" },
                "priority": { "type": "string", "enum": PRIORITIES, "description": "默认 P2" },
                "tags":     { "type": ["string", "array"], "items": { "type": "string" }, "description": "标签 id 数组；单个标签写成字符串也认（会自动转成数组），数组里的空值/重复会清掉。先调 tb_list_tasks 看 defs.tagDefs 里已有哪些（用已有项的 id，不要自造裸名字——裸名字没有定义、没有颜色）" },
                "type":     { "type": ["string", "array"], "items": { "type": "string" }, "description": "任务类型 id 或 id 数组（该列可多选）；先调 tb_list_tasks 看 defs.typeDefs 里已有哪些（默认 dev/bug/opt/research/review/plan，用户可能自定义过）；缺省=未分类" },
                "estimate": { "type": ["number", "string"], "description": "预估工作量，单位人日，可小数（0.5=半天）；写成数字字符串（如 \"2.5\"）也认；缺省 0=没估；负数无意义，会被拒绝" },
                "group":    { "type": ["string", "array"], "items": { "type": "string" }, "description": "分组名或名字数组（该列可多选；留空=不分组）。先调 tb_list_tasks 看 defs.groupDefs 里已有哪些——归到已有分组，不要自造近义名（'登录'和'登陆'会分成两组）" },
                /*
                  ⛔ 原来 create schema **没有 assignee**：实现里明明写了
                  `enum_value(body, "assignee")`、文件里也显式存了这一列、
                  update 也能改 —— AI 却在工具表里看不见这个参数，
                  建任务时永远不填，只能建完再 PATCH 认领。
                  与「create 不写 summary / deps」是同一族：看得见却填不了。
                */
                "assignee": { "type": ["string", "array"], "items": { "type": "string" }, "description": "认领人名字或名字数组（该列可多选）；留空=未认领，交给其他窗口后续认领。先调 tb_list_tasks 看 defs.assigneeDefs 里已有哪些" },
                "reporter": { "type": "string", "description": "报告人窗口 ID，缺省 manual" },
                /* ⛔ 实现里 str_field(body,"status") 读了这一项，schema 却一直没列 ——
                   与「create 漏 assignee / reporter / deps」同族：严格客户端按
                   additionalProperties=false 校验时连传都不让传。写明只能填 initial。 */
                "status":   { "type": "string", "description": "初始状态 id。**只允许填 defs.initial**，其它值会被拒绝；不填即用 initial。后续流转走 tb_update_task / PATCH" },
                "deps":     { "type": ["string", "array"], "items": { "type": "string" }, "description": "前置任务 id 数组（单个写成字符串也认）；空值/重复/指向自己会被清掉，指向不存在任务的 id 会保留（界面会标「前置不存在」）。缺省=[]" },
            }),
            vec!["title"],
        ),
        tool(
            "tb_get_task",
            "查单条任务详情（含全部历史事件），响应同样带 defs 各列定义表",
            json!({ "id": { "type": "string", "description": "任务 id，如 tb-0001" } }),
            vec!["id"],
        ),
        tool(
            "tb_update_task",
            "流转/修改任务：认领、开工、提交审查、通过、打回、退回、改字段。返回 entered_notify_status 只表示本次进入了通知状态；webhook 由 HTTP PATCH 通道发出，MCP 通道不发通知",
            json!({
                "id":       { "type": "string", "description": "任务 id" },
                "status":   { "type": "string", "description": "目标状态（流转图校验，服务端按本项目 flow 校验）。⛔ 不写 enum：写死默认 7 个会让自定义流程的状态在客户端被拒；先调 tb_list_tasks 看 defs.statuses（合法 id）、defs.statusDefs（名字/完成态）、defs.transitions（当前状态能去哪）" },
                "assignee": { "type": ["string", "array"], "items": { "type": "string" }, "description": "认领人；传数组=整体替换（共同认领，须保留已有认领人否则拒绝）；传单个名字且任务上已是数组时按追加处理（不会挤掉他人）；空串或空数组=释放全部认领" },
                "priority": { "type": "string", "enum": PRIORITIES, "description": "改优先级" },
                "title":    { "type": "string", "description": "改标题" },
                "detail":   { "type": "string", "description": "改详情" },
                "summary":  { "type": "string", "description": "改任务说明" },
                "tags":     { "type": ["string", "array"], "items": { "type": "string" }, "description": "整体替换标签；单个标签写成字符串也认，空值/重复会清掉。先调 tb_list_tasks 看 defs.tagDefs 里已有哪些" },
                "type":     { "type": ["string", "array"], "items": { "type": "string" }, "description": "任务类型 id 或 id 数组（数组=整体替换）；先调 tb_list_tasks 看 defs.typeDefs 里已有哪些；传单个 id 且任务上已是数组时按追加处理（不会丢已有类型）；传空串或空数组=清成未分类" },
                "estimate": { "type": ["number", "string"], "description": "预估工作量，单位人日，可小数；写成数字字符串也认；负数无意义，会被拒绝" },
                "group":    { "type": ["string", "array"], "items": { "type": "string" }, "description": "分组名或名字数组（数组=整体替换）；先调 tb_list_tasks 看 defs.groupDefs 里已有哪些；传单个名字且任务上已是数组时按追加处理（不会丢已有分组）；传空串或空数组=取消分组" },
                "deps":     { "type": ["string", "array"], "items": { "type": "string" }, "description": "整体替换前置任务 id 数组（单个写成字符串也认）；空值/重复/指向自己会被清掉，传 [] =清空全部前置" },
                "by":       { "type": "string", "description": "操作者窗口 ID，进历史" },
                "note":     { "type": "string", "description": "备注；打回时必填原因" },
                /* ⛔ 原来漏了 reporter：patch_task 的 for 循环早就能改它，
                   create schema 也列了，唯独 update schema 看不见 ——
                   严格按 inputSchema 做本地校验的 MCP 客户端会拒掉一个
                   服务端其实接受的参数。与「create 漏 assignee」同族。 */
                "reporter": { "type": "string", "description": "报告人窗口 ID（与 create 的 reporter 同一字段）" },
            }),
            vec!["id"],
        ),
        tool(
            "tb_add_event",
            "给任务追加备注/进展（不改状态）。空事件（无 note 且 action 缺省/为 note）会被拒绝，不写盘",
            json!({
                "id":     { "type": "string", "description": "任务 id" },
                "by":     { "type": "string", "description": "操作者窗口 ID" },
                "action": { "type": "string", "description": "事件类型，缺省 note" },
                "note":   { "type": "string", "description": "内容。⛔ note 为空且 action 缺省/为 note 时不写盘（事件内容为空）——空事件不该刷新任务的更新时刻" },
            }),
            vec!["id"],
        ),
        tool(
            "tb_register_agent",
            "注册本窗口身份（首次使用先登记，认领/流转时署名用它）",
            json!({
                "id":   { "type": "string", "description": "窗口 ID，如 dev-a" },
                "name": { "type": "string", "description": "显示名，可选" },
                /*
                  ⛔ 原来写死 enum ["dev","review","manual"]，而前端 Agent.role
                  是普通 string、normalizeStore 认任意非空串、HTTP POST /api/agents
                  也完全不校验 —— 严格按 inputSchema 做本地校验的 MCP 客户端
                  会把一个服务端其实接受的值直接拒掉。与之前两处 status 写死
                  7 个默认状态是同一类：**schema 把门关着、实现却开着**。
                  这里只是显示标签，不参与任何判据，不做枚举。
                */
                "role": { "type": "string", "description": "窗口角色，自由文本（界面只作显示，不参与任何判据）；缺省 dev" },
            }),
            vec!["id"],
        ),
        tool(
            "tb_delete_task",
            "删除一条任务（⛔ 不可撤销；调用前先 tb_get_task 确认 id 与标题）。与界面单条删除同一判据：不清其它任务的 deps，而是在响应 dependents 里列出把它列为前置的任务（界面会标「前置不存在」）——AI 没有确认框，必须靠这个字段知道自己是制造了悬空依赖。删除不存在的 id 返回 404「任务 {id} 不存在」",
            json!({
                "id": { "type": "string", "description": "要删除的任务 id；首尾空白与百分号编码会自动还原" },
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
pub fn mcp_call_tool(name: &str, args: &Value, dir: &PathBuf, notify_status: &str) -> Value {
    /* ⛔ 必须走 norm_id：与 str_field 的统一 trim 同一判据。
       修前取值原样，"  tb-0001  " 让三个工具都报「任务不存在」。

       ⛔ 也不叫 `s`：上一轮把「通用取值闭包」改成了带 pct_decode 的
       id 专属行为，而名字完全看不出来 —— 将来谁写 id_of("note") 之类的
       复用，会把正文里的 %20 静默解成空格。四个调用点全是 id，
       改名把语义钉死：这个函数只用于 id。 */
    let id_of = |k: &str| args.get(k).and_then(|v| v.as_str()).map(norm_id);
    /* 双保险：mcp_dispatch 已校验，这里再兜一次（内置单测/直接调用也指对路） */
    if let Err(e) = check_write_args(name, args, None) {
        return json!({ "content": [{ "type": "text", "text": err_json(&e) }],
                       "isError": true });
    }
    let result: Result<Value, String> = match name {
        "tb_list_tasks" => (|| -> Result<Value, String> {
            let store = load_tasks(dir)?;
            /* 与 HTTP GET /api/tasks 同一份 TaskFilter，不再各写一套 */
            let f = TaskFilter::from_args(args);
            let hit: Vec<&Value> = store
                .get("tasks")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter(|t| f.matches(t, &store)).collect())
                .unwrap_or_default();
            Ok(json!({ "count": hit.len(), "tasks": hit,
                       "agents": store.get("agents").cloned().unwrap_or(json!([])),
                       "ok": true,
                       "defs": defs_of(&store) }))
        })(),
        /* ⛔ 旧名 created/updated 保留（不破坏已有客户端），但同一个动作
           HTTP 用的是 task —— 取「刚操作的任务 id」要记三个名字。
           现在两条通道都能用 ok / task 解析，旧名继续可用。 */
        "tb_create_task" => create_task(dir, args).map(|t| json!({
            "ok": true, "created": &t, "task": &t })),
        "tb_get_task" => (|| -> Result<Value, String> {
            let id = id_of("id").unwrap_or_default();
            let store = load_tasks(dir)?;
            match find_task(&store, &id) {
                /* 与 GET /api/tasks/{id} / tb_list_tasks 同一口径 */
                Some(t) => Ok(json!({ "ok": true, "task": t, "defs": defs_of(&store) })),
                None => Err(format!("任务 {id} 不存在")),
            }
        })(),
        "tb_update_task" => {
            /*
              ⛔ 原来这里写死 "review"，而 HTTP PATCH 用的是配置里的 notify_status。
              自定义流程把送审那步改叫 gate 之后：HTTP 通道认得、MCP 通道不认，
              同一个动作两条通道结论相反（AI 经 MCP 送审永远不算"进入通知状态"）。
              默认流程下恰好都是 review，所以这个坑只在自定义流程下暴露 ——
              与之前修过的「通知状态写死 review」是同一个根因、另一条通道。

              现在由 route 一路透传（POST /mcp 也在 HTTP 服务内，拿得到配置）。

              ⛔ 返回值也不能叫 `review_notice_sent`：MCP 通道**不发 webhook**
              （/mcp 分支不产生通知 body，handle_conn 不会 spawn_notify）。
              真正的 POST 只在 HTTP PATCH 请求里发生。原来返回 true 是假话 ——
              AI 以为 agent-flow 已经被触发了，实际什么都没发。
              现在改为 `entered_notify_status`：只如实报告"本次进入了通知状态"，
              schema 描述里也写明通知由 HTTP PATCH 通道发出。
            */
            patch_task(dir, &id_of("id").unwrap_or_default(), args, notify_status).map(|(t, entered)| {
                json!({ "ok": true, "updated": &t, "task": &t,
                        "entered_notify_status": entered })
            })
        }
        "tb_add_event" => {
            add_event(dir, &id_of("id").unwrap_or_default(), args).map(|t| json!({ "ok": true, "task": &t }))
        }
        "tb_register_agent" => {
            register_agent(dir, args).map(|a| json!({ "ok": true, "agents": a }))
        }
        "tb_delete_task" => delete_task(dir, &id_of("id").unwrap_or_default()),
        other => Err(format!("未知工具: {other}")),
    };

    match result {
        Ok(v) => json!({
            "content": [{ "type": "text", "text": v.to_string() }],
        }),
        /*
          ⛔ 原来是裸错误文案，而**成功**的 text 是 JSON 串（v.to_string()）：
          同一通道内成功/失败两种形状，客户端统一写 JSON.parse(text) 时
          失败分支直接抛 SyntaxError —— 会把「任务不存在」误判成
          「服务端返回坏数据」。上一轮刚把两条通道的成功响应统一成
          resp.ok / resp.task.id，失败侧却没跟上：HTTP 是
          {"ok":false,"error":...}，MCP 既没有 ok:false 也没有 error。
          现在 text 也走 err_json，isError:true 保留（协议要求，不能删）。
        */
        Err(e) => json!({
            "content": [{ "type": "text", "text": err_json(&e) }],
            "isError": true,
        }),
    }
}

/// JSON-RPC 2.0 分发。返回 None = 通知（无 id），调用方回 202 空体。
fn mcp_dispatch(req: &Value, dir: &PathBuf, notify_status: &str) -> Option<Value> {
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
            /*
              ⛔ 原来 `arguments` 传字符串 / 数组 / null 时一律静默当空对象：
              `args.get(k)` 全返 None → 业务层报「title 不能为空」「id 不能为空」，
              AI 会去改参数值反复重试，而真正错的是**参数形状**。
              与「流转失败文案把人往任务不存在上引」同一族：报错指错方向。
              JSON-RPC 2.0 规定 params / arguments 必须是对象；给标准 -32602。
            */
            let params = req.get("params").cloned().unwrap_or(json!({}));
            if !params.is_object() {
                return Some(json!({"jsonrpc":"2.0","id":id,
                    "error":{"code":-32602,"message":"Invalid params: params 必须是对象"}}));
            }
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            if !args.is_object() {
                return Some(json!({"jsonrpc":"2.0","id":id,
                    "error":{"code":-32602,"message":"Invalid params: arguments 必须是对象"}}));
            }
            /* ⛔ 原来 `unwrap_or("")`：缺 name / name 是数字都变成空串，
               _ arm 报「未知工具: 」—— 真正错的是参数，不是工具名。 */
            let name = match params.get("name") {
                Some(Value::String(v)) => v.as_str(),
                None => return Some(json!({"jsonrpc":"2.0","id":id,
                    "error":{"code":-32602,"message":"Invalid params: 缺少必填参数 name（tools/call 要指定工具名）"}})),
                Some(_) => return Some(json!({"jsonrpc":"2.0","id":id,
                    "error":{"code":-32602,"message":"Invalid params: name 必须是字符串"}})),
            };
            if let Err(e) = check_write_args(name, &args, None) {
                return Some(json!({"jsonrpc":"2.0","id":id,
                    "error":{"code":-32602,"message":format!("Invalid params: {}", e)}}));
            }
            Ok(mcp_call_tool(name, &args, dir, notify_status))
        }
        other => Err(json!({ "code": -32601, "message": format!("未知方法: {other}") })),
    };

    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    })
}

/// POST /mcp 的请求体可能是一批 JSON-RPC（数组=batch），逐条分发。
fn mcp_handle(body: &str, dir: &PathBuf, notify_status: &str) -> (u16, String) {
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

    /* JSON-RPC 2.0 §6：batch 的响应**必须**是数组，哪怕只有一条。
       修前 `responses.len()==1` 一律返回单个对象 —— 一个含 1 条调用 +
       1 条无 id 通知的 batch 会让严格客户端解析失败。 */
    let is_batch = parsed.is_array();
    let responses: Vec<Value> = match parsed {
        Value::Array(batch) => batch
            .iter()
            .filter_map(|req| mcp_dispatch(req, dir, notify_status))
            .collect(),
        single => match mcp_dispatch(&single, dir, notify_status) {
            Some(resp) => vec![resp],
            None => vec![], // 纯通知：202 空体
        },
    };

    if responses.is_empty() {
        (202, String::new())
    } else if !is_batch && responses.len() == 1 {
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

/*
 * 三张**定义表**（分组 / 任务类型 / 标签）。
 *
 * ⛔ 为什么读通道必须带上它们：
 * tb_create_task 的 schema 要求 `type` 填"任务类型 id（dev/bug/… 或**自定义类型**的 id）"、
 * `group` 填"分组名"、而 `tags` 实际也挂着一张带颜色的定义表 ——
 * 但两条读通道（GET /api/tasks、tb_list_tasks）原来只返回 tasks + agents，
 * AI **看不到这些 id 有哪些**，只能瞎猜：
 *
 *   · 填一个不存在的类型 id → 那列显示成原始 id，任务看着像没分类
 *   · 填一个新的分组名 → 凭空造出一个没有定义的分组（无颜色、也改不了色）
 *   · 标签写裸名字 → 脱离定义表，永远选不到颜色
 *
 * 让 AI 先看见再填，比事后纠正便宜得多。
 */
fn defs_of(store: &Value) -> Value {
    /*
      ⛔ statuses 不能省 —— 它是**最该让 AI 看见**的一项。

      MCP schema 是**静态**的（mcp_tools() 拿不到 dir，没法按项目动态生成 enum），
      早期两处 status 参数写了写死的 7 个默认状态 enum，结果是：
        · 严格校验 schema 的客户端会在**本地**拒掉自定义状态
        · 描述里却说"实际生效的状态看 defs.statuses" —— 指了路却把门关着
      现已去掉那两处 enum，只留 type: string + 指向 defs.statuses 的描述；
      服务端仍按 statuses_for(store) 校验。把当前生效的状态清单放进 defs，
      AI 才有得查（自定义流程下唯一可信的来源）。
    */
    let list = |legacy: &str, key: &str| -> Value {
        match defs_list(store, legacy, key) {
            Some(a) => Value::Array(a.clone()),
            None => json!([]),
        }
    };
    json!({
        "groupDefs": list("groupDefs", "group"),
        "typeDefs":  list("typeDefs", "type"),
        "tagDefs":   list("tagDefs", "tag"),
        /*
          ⛔ 这两张表不能省：defs 的目的是「让 AI 看见有哪些可选值」，
          而认领人与优先级同样是可枚举的列。缺了它们，AI 建任务时
          只能自造裸名字（没颜色、不在候选里），或按写死的四档猜优先级。
          两者都由 toDisk 展开成平级字段，随 tasks.json 导入导出原样带回。
        */
        "assigneeDefs": list("assigneeDefs", "assignee"),
        "priorityDefs": list("priorityDefs", "priority"),
        "statuses":  statuses_for(store),
        /*
          ⛔ 只有 id 列表不够：AI 看不见名字/颜色/完成态，也看不见流转图，
          于是只能靠一次次 PATCH 失败（还全是 500）去试哪条边能走。
          三个字段都是**从 tasks.json 的 flow 派生**，不新增落盘字段，
          导入导出原样带回。statuses（id 列表）保留，不破坏已有客户端。
        */
        "statusDefs": status_defs_of(store),
        "transitions": flow_for_ai(store),
        "initial": statuses_for(store).first().cloned()
                    .unwrap_or_else(|| "todo".to_string()),
    })
}

fn str_field(body: &Value, key: &str) -> Option<String> {
    /*
      ⛔ 一律 trim。修前写入侧是逐处补的（title / summary / priority /
      register_agent / PATCH 五字段），而 create 的 detail / reporter / status、
      patch 的 by / note / status、add_event 的 by / action / note 仍原样写入 ——
      补一轮漏一轮，正是下面改成统一归一的原因。

      后果和前几轮修过的完全一样：
        · 判空用 trim、写入用原值 → 同一个实体带空格存进文件，
          AI 读原始 JSON 与界面读盘（会 trim）看到的是两份不同数据
        · `"status": "  todo  "` 被判「新建任务只允许 status=todo」直接拒绝，
          而 `"priority": "  P4  "` 上一轮刚修成可用 —— 同一份请求两种待遇
        · 历史里 by="  dev-a  " 显示成一个前后带空格的名字

      与其继续逐处打补丁，不如把**取值函数**改成统一归一：
      以后新增任何文本字段自动生效，不会再漏。这就是「改定义、不动调用点」。
    */
    body.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
}

/// 与前端 `normalizeTask` 里的 `Number(v)` 等价：数字、**数字字符串**都认。
///
/// ⛔ 原来 `estimate_of` 只走 `as_f64()` —— AI 手写 JSON 把数字写成
/// 字符串（`"estimate": "2.5"`）是常事，于是明明填了却静默落成 0（没估）。
/// 前端那一侧早修过（`Number.isFinite("2.5")` 是 false 的坑），
/// AI 通道是**同一根因、另一条路**。PATCH 里读旧值也必须用同一判据，
/// 否则旧值是字符串时 cur=0，会误判"有变化"并写一条无意义历史。
fn num_of(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().filter(|x| x.is_finite()),
        _ => None,
    }
}

/*
  ⛔ 筛选用的「空值哨兵」是内部标记（__none__ / __notype__ / __nogroup__ /
  __notag__ / __noestimate__，每列不同但都是 __xxx__ 形状），**不是真实值**。

  读侧 TaskFilter.matches 早就把它们排除在"真实值"之外；写侧却一直不认：
  AI 在 list schema 里读到「传 "__none__" 查未分类」，很容易把同一个值
  填进 create / update 表示"清空这一列" —— 于是文件里存下 "__none__"，
  界面上那一列显示成一串内部标记（labelFor 只认**本列**的哨兵，跨列的
  原样显示；认领人恰好同名的那个则显示成空白）。
  更矛盾的是：筛"未认领"时读侧把它当哨兵排除 → 真能筛到，
  而列表里明明写着 "__none__" —— 两条线索打架，不报错。

  判据只存在这一处：写侧（清洗函数 / 单值入口）与读侧（matches / 守卫）
  共用，以后加一列哨兵不用再回来补第二份。前端 normalizeTask 读盘也按
  同一形状兜底，老数据里的残留同样被清掉。
*/
fn is_sentinel(v: &str) -> bool {
    v.starts_with("__") && v.ends_with("__")
}

/// 字符串数组清洗：逐元素 trim、去空、去重（与前端 `oneOrMany` / `ids` 一致）。
fn clean_str_array(a: &[Value]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for x in a.iter().filter_map(|x| x.as_str()) {
        let t = x.trim().to_string();
        if !t.is_empty() && !is_sentinel(&t) && !seen.contains(&t) {
            seen.push(t);
        }
    }
    seen
}

/// 建/改任务时的「标签」列：字符串也认（转单项），数组逐元素清洗。
///
/// ⛔ 原来 create 只 `filter(is_array)`、PATCH 直接 `tags.clone()`：
///   · AI 传 `"tags": "tg1"`（少写了方括号）→ 静默丢成 []，任务没标签
///   · 数组里 `["", "  ", "tg1", "tg1"]` 原样写盘 → 界面冒出零宽度 chip、
///     重复标签让"有 N 个标签"计数虚高（前端读盘会清，但 AI 读原始文件看到的是脏的）
/// 写入侧就归一，两条通道看到同一份干净数据。
fn tags_value(body: &Value) -> Value {
    match body.get("tags") {
        Some(Value::String(v)) => {
            let t = v.trim();
            if t.is_empty() || is_sentinel(t) { json!([]) } else { json!([t]) }
        }
        Some(Value::Array(a)) => Value::Array(
            clean_str_array(a).into_iter().map(Value::String).collect(),
        ),
        _ => json!([]),
    }
}

/// 前置依赖 id 列表。与前端 `normalizeTask` 的 `ids()` + 去自依赖 **同一判据**：
///   trim → 去空 → 去重（保序）→ 去掉指向自己的 id。
/// 单个字符串也认（AI 少写方括号时不该静默丢成 []）。
///
/// ⛔ **不清掉指向不存在任务的 id**：前端特意保留（lockOf 会标 "前置不存在（可能已被删除）"），
/// 清掉的话那个提示永远不会出现，用户不知道为什么解锁不了。
///
/// ⛔ 去自依赖是必须的：`deps=['自己']` 让 lockOf 判定 pending=['自己'] + cyclic=true，
/// 它等的是"自己完成"，而"自己完成"的前提是它先解锁 —— 永远解不开的死局。
/// 界面的下拉挡得住，AI 直接写 JSON 不受那层约束。
fn deps_value(body: &Value, self_id: &str) -> Value {
    let raw: Vec<Value> = match body.get("deps") {
        Some(Value::String(v)) => vec![json!(v)],
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    /*
      ⛔ id 字段（path / JSON 参数 / agent id）全走 norm_id，deps 里的 id
      原来只 trim —— 同一份数据两种归一。AI 手写 %20 或带空格时，
      用 norm_id 能查到任务 A，把同一个 id 写进 deps 却对不上：
      lockOf 精确匹配失败 → 前置永远解锁不了，界面标「前置不存在
      （可能已被删除）」，用户以为是任务被删了。与「流转失败文案把人往
      任务不存在上引」同族。保留不存在 id 的策略不变（见上方注释）。
    */
    let self_norm = norm_id(self_id);
    let list: Vec<String> = clean_str_array(&raw)
        .into_iter()
        .map(|d| norm_id(&d))
        .filter(|d| !d.is_empty() && d != &self_norm)
        .collect();
    Value::Array(list.into_iter().map(Value::String).collect())
}

/// 下一个任务 id 的序号：**max(nextId, 库里实际最大编号 + 1)**。
///
/// ⛔ 原来只信 `nextId` 字段。一旦它落后于数据（AI 自建 id、导入、手改文件），
/// 新建任务就和已有任务**撞号** —— 而 id 是依赖、历史、筛选、详情的键，
/// `find_task` / `patch_task` 都用 `.find()` 只取第一个，
/// 撞号之后改一条会动到另一条，完全不报错。
/// 前端 `normalizeStore` / `nextTaskId` 早就是这个判据。
fn next_seq_for(store: &Value) -> u64 {
    let declared = store.get("nextId").and_then(|v| v.as_u64()).unwrap_or(1);
    let mut max_seq = 0u64;
    if let Some(arr) = store.get("tasks").and_then(|v| v.as_array()) {
        for t in arr.iter() {
            if let Some(id) = t.get("id").and_then(|v| v.as_str()) {
                if let Some(rest) = id.strip_prefix("tb-") {
                    if let Ok(x) = rest.parse::<u64>() {
                        if x > max_seq { max_seq = x; }
                    }
                }
            }
        }
    }
    declared.max(max_seq.saturating_add(1))
}

/// 把任务上某个字段**统一展开成字符串数组**。
///
/// ⛔ 多选列（tags / type / group / assignee）在列设置里勾了「多选」之后
/// 存的是数组，老数据与单选时是字符串。只认字符串的话：
///   `t["assignee"].as_str()` 对数组返回 None → unwrap_or("") → 空串
/// 于是多值任务在 AI 通道里被当成「未认领」：
///   · 筛 `assignee=张三` → 0 条（界面列表里明明挂着张三）
///   · 筛 `assignee=__none__` → **误命中**（多值任务被算成未认领）
/// 两种都不报错，只是筛出来的条数不对，查错方向完全反了。
fn vals_from_map(task: &Map<String, Value>, key: &str) -> Vec<String> {
    match task.get(key) {
        Some(Value::String(s)) => {
            let v = s.trim();
            if v.is_empty() { Vec::new() } else { vec![v.to_string()] }
        }
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str())
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn vals_of(task: &Value, key: &str) -> Vec<String> {
    match task.as_object() {
        Some(m) => vals_from_map(m, key),
        None => Vec::new(),
    }
}

/// 建任务时读一个「可以是多值」的列：字符串、字符串数组都认。
///
/// ⛔ 原来一律 `str_field(...)` —— AI 传数组时返回 None → 静默落成空串。
/// 界面上这些列勾了「多选」之后就是数组，AI 通道建多值任务必须能写。
fn enum_value(body: &Value, key: &str) -> Value {
    match body.get(key) {
        Some(Value::String(v)) => {
            let t = v.trim();
            if t.is_empty() || is_sentinel(t) { json!("") } else { json!(t) }
        }
        Some(Value::Array(a)) => Value::Array(
            clean_str_array(a).into_iter().map(Value::String).collect(),
        ),
        _ => json!(""),
    }
}

/// PATCH 里改一个「可以是多值」的列（type / group / assignee）。
///
/// ⛔ 原来 `as_str().unwrap_or("")` 把数组读成空串，于是：
///   · 每次都认为有变化（写盘 + 记一条无意义历史）
///   · 把**数组覆盖成单值字符串** —— 静默丢掉其它值
/// 界面上同类问题修过（批量改类型覆盖），AI 通道是同一根因。
///
/// 形状跟随数据：原本是数组就追加去重（与界面多选一致），
/// 原本是字符串就替换（老行为不变），空串 = 清空。
/// 列配置存在插件偏好里、Rust 读不到，所以以「数据自己长什么样」为准 ——
/// 与前端 multiOfTask 的第二个来源同理（关掉多选但还没压缩完时仍是数组）。
fn patch_vals(
    obj: &mut Map<String, Value>,
    key: &str,
    incoming: &str,
    by: &str,
    empty_label: &str,
) -> bool {
    let cur = vals_from_map(obj, key);
    let was_array = obj.get(key).map(|v| v.is_array()).unwrap_or(false);
    /* 哨兵不是真实值：传它就是「清空这一列」，别把内部标记写进文件 */
    let v = { let t = incoming.trim(); if is_sentinel(t) { "" } else { t } };
    let next: Vec<String> = if v.is_empty() {
        Vec::new()
    } else if was_array {
        let mut n = cur.clone();
        if !n.iter().any(|x| x == v) {
            n.push(v.to_string());
        }
        n
    } else {
        vec![v.to_string()]
    };
    if cur == next {
        return false;
    }
    let stored: Value = if was_array {
        Value::Array(next.iter().map(|x| Value::String(x.clone())).collect())
    } else if next.is_empty() {
        /* ⛔ 原来写 Value::Null：create_task 的 enum_value 写 ""、前端写盘写 ""，
           只有 PATCH 写 null。AI 读 tasks.json 看到 null，按读到的形状回写
           又要绕一圈 —— 同一字段三种形状表示同一件「空」。 */
        json!("")
    } else {
        json!(next[0])
    };
    obj.insert(key.to_string(), stored);
    let fmt = |a: &Vec<String>| {
        if a.is_empty() { empty_label.to_string() } else { a.join("、") }
    };
    push_history(obj, by, key, &format!("{} -> {}", fmt(&cur), fmt(&next)));
    true
}

/// 数组形状 = **整体替换**：AI 明确写出了这一列的完整集合。
///
/// ⛔ 修前 PATCH 的 type/group/assignee 一律走 `str_field`（只认字符串），
/// 而 create 走 `enum_value`（认数组）、读侧过滤参数上一轮刚改成认数组。
/// 于是同一份 `{"type":["dev","bug"]}`：建任务成功、改任务被静默当作「没传」，
/// body 里只有它时报错「没有可应用的变更」—— 报错把人往「你没改东西」上引，
/// 实际是形状不认。AI 读 tasks.json 看到 type 是数组，按读到的形状回写就撞上。
///
/// 单值路径仍走 `patch_vals`（追加/替换/清空），两条路共用判等与历史格式。
fn patch_vals_set(
    obj: &mut Map<String, Value>,
    key: &str,
    next: &[String],
    by: &str,
    empty_label: &str,
) -> bool {
    let cur = vals_from_map(obj, key);
    if cur == next {
        return false;
    }
    let stored: Value = if next.is_empty() {
        /* 数组形状清空就写空数组，保持「形状跟随输入」 */
        Value::Array(Vec::new())
    } else {
        Value::Array(next.iter().cloned().map(Value::String).collect())
    };
    obj.insert(key.to_string(), stored);
    let fmt = |a: &[String]| {
        if a.is_empty() { empty_label.to_string() } else { a.join("、") }
    };
    push_history(obj, by, key, &format!("{} -> {}", fmt(&cur), fmt(next)));
    true
}

/// 认领守卫：**只看最终集合是否保留了所有现有认领人**，不管传入形状。
///
/// ⛔ 修前守卫写的是「PATCH 是覆盖语义」，而 `patch_vals` 早已改成追加 ——
/// 两份判据。实测：任务已有 ["张三"]，AI 传 `{"assignee":"李四"}` 想共同认领，
/// 守卫判 `!cur.contains(next)` 直接拒绝，可 patch_vals 本来会追加成
/// ["张三","李四"]（不挤掉任何人）。界面支持共同认领，AI 通道却加不了第二个人。
///
///   · 单值 + 原数据是数组 → 追加，不丢人 → 放行
///   · 单值 + 原数据是字符串 → 替换，会丢人 → 拒绝
///   · 数组 → 显式集合，含全部 cur 才放行（加人 OK，踢人不行）
///   · 空串 / 空数组 → 显式释放 → 放行
/// 哨兵值（__none__ 之类）不是真实认领人，不参与判断。
fn guard_assignee(cur: &[String], next: &[String]) -> Result<(), String> {
    if next.is_empty() {
        return Ok(());
    }
    let dropped: Vec<String> = cur
        .iter()
        .filter(|c| !is_sentinel(c))
        .filter(|c| !next.iter().any(|n| n == *c))
        .cloned()
        .collect();
    if dropped.is_empty() {
        return Ok(());
    }
    Err(format!(
        "任务已被 {} 认领；如需接手先与其确认或先退回 todo",
        cur.join("、")
    ))
}

/// 定义表：优先读**平级字段**（前端 toDisk 总是写），回退 `defs.<key>`。
///
/// ⛔ 只认平级字段的话，导入一份「只有 defs」的文件时 defs_of 返回空表，
/// AI 建任务只能自造裸名字（没颜色、不在候选里）。两种格式都要认。
fn defs_list<'a>(store: &'a Value, legacy: &str, key: &str) -> Option<&'a Vec<Value>> {
    store
        .get(legacy)
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .or_else(|| {
            store
                .get("defs")
                .and_then(|d| d.get(key))
                .and_then(|v| v.as_array())
        })
}

/// 定义表里的 id → 显示名；没有定义就退回 id 本身（至少能按 id 搜）。
fn label_of(store: &Value, legacy: &str, key: &str, id: &str) -> String {
    if let Some(arr) = defs_list(store, legacy, key) {
        for d in arr.iter() {
            if d.get("id").and_then(|v| v.as_str()) == Some(id) {
                if let Some(n) = d.get("name").and_then(|v| v.as_str()) {
                    if !n.trim().is_empty() {
                        return n.trim().to_string();
                    }
                }
            }
        }
    }
    id.to_string()
}

/// 自定义流程里状态 id → 名字（flow.statuses[].name）。没配过就退回 id。
fn status_label(store: &Value, id: &str) -> String {
    if let Some(arr) = store
        .get("flow")
        .and_then(|f| f.get("statuses"))
        .and_then(|v| v.as_array())
    {
        for one in arr.iter() {
            if one.get("id").and_then(|v| v.as_str()) == Some(id) {
                if let Some(n) = one.get("name").and_then(|v| v.as_str()) {
                    if !n.trim().is_empty() {
                        return n.trim().to_string();
                    }
                }
            }
        }
    }
    id.to_string()
}

/// AI 通道 `q` 的搜索串 —— 与界面顶栏全局搜索**同一口径**。
///
/// ⛔ 原来只拼 id / title / detail，而上一轮把 MCP schema 里 q 的描述
/// 写成了「匹配标题/详情/说明/id，以及状态/优先级/分组/认领人/类型/标签的显示名」——
/// **描述成了假话**：AI 照着描述搜「开发中」「重要」全是 0 条，界面却能搜到。
/// 「文档说了、代码没做」比不写更误导 —— AI 会反复重试同一个词。
fn search_hay(task: &Value, store: &Value) -> String {
    let s = |k: &str| task.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut parts = vec![s("id"), s("title"), s("detail"), s("summary")];
    /*
      列清单与前端 core.mjs 的 LIST_COLUMNS（kind='enum'）**集合一致**
      （顺序不影响拼串，跨端守卫按集合比）。每个值都放**原始值 + 显示名**：
        · 按 id 能搜（AI 读 tasks.json 看到的就是 id）
        · 按显示名能搜（界面上看到的字，改名后自动跟着变）
    */
    let cols: [(&str, &str, &str); 6] = [
        ("status", "", ""),
        ("priority", "priorityDefs", "priority"),
        ("group", "groupDefs", "group"),
        ("assignee", "assigneeDefs", "assignee"),
        ("type", "typeDefs", "type"),
        ("tags", "tagDefs", "tag"),
    ];
    for &(field, legacy, key) in cols.iter() {
        for v in vals_of(task, field) {
            parts.push(v.clone());
            if field == "status" {
                parts.push(status_label(store, &v));
            } else {
                parts.push(label_of(store, legacy, key, &v));
            }
        }
    }
    parts.join(" ").to_lowercase()
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
/// 百分比解码（query string 里的 `%XX` / `+`）。不引第三方 crate，
/// 手写就够：AI 传的中文分组名、带空格的 q 都要能还原。
fn pct_decode_with(s: &str, plus_as_space: bool) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let h = (b[i + 1] as char).to_digit(16);
                let l = (b[i + 2] as char).to_digit(16);
                if let (Some(a), Some(c)) = (h, l) {
                    out.push((a * 16 + c) as u8);
                    i += 3;
                    continue;
                }
                out.push(b[i]);
                i += 1;
            }
            /*
              `+` 只在 **query string** 里表示空格（form-urlencoded）。
              MCP 的 JSON 参数里 `+` 是字面量 —— 分组名「C++」「a+b」被
              静默解成「C  」「a b」，筛不到且不报错。开关由调用方给，
              这是协议差异，不是判据分歧。
            */
            b'+' if plus_as_space => { out.push(b' '); i += 1; }
            c => { out.push(c); i += 1; }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// query string 专用：把 `+` 当空格。签名与语义保持原样（守卫钉着）。
/* ⛔ 删掉 pct_decode（= pct_decode_with(s, true) 的一层包装）。
   它唯一的调用点曾是本文件里的 norm_id —— 而 norm_id 处理的是
     · HTTP **path** 段：`+` 在 path 里是字面量（RFC 3986 sub-delims），
       只有 query 的 application/x-www-form-urlencoded 才把 + 当空格
     · MCP **JSON 参数**：`+` 更是字面量
   两处都该用 plus_as_space=false。上一轮特意为 norm_text 区分了协议，
   却漏了同一个 pct_decode_with 的第三个调用点，还用守卫把它钉死在
   「pct_decode 保留」上 —— 正是「相似问题没一次性扫干净」。
   现在 id 归一直接走 norm_text(raw, false)，与 MCP 过滤值同一判据。

   实测修前：register_agent {"id":"C++"} → agents 里存 "C  "；
             GET /api/tasks/a+b → 找的是 "a b"（任务 a+b 明明在）。
   修后：两者都原样保留。 */

/// **所有过滤值 / 关键词的归一化**：百分号解码 + 首尾空白，一处定义。
///
/// ⛔ 修前两个构造函数各写各的：
///   · from_args 只 `.trim()` → MCP 传 `{"group":"%E7%99%BB%E5%BD%95"}`
///     筛不到，而 HTTP `?group=%E7%99%BB%E5%BD%95` 能筛到
///   · from_query 只 `pct_decode()` 不 trim → `?status=%20todo%20` 是
///     " todo "，不命中；MCP 的 `{"status":" todo "}` 却命中
/// 上一轮刚给 MCP 的 **id** 加了 norm_id（解码+trim），理由写的是
/// "AI 手写 %20 常见" —— 同一份请求里的过滤值却没跟上。
/// 现在两条通道只共用这一份，差别仅在协议要求的 `+` 语义。
fn norm_text(s: &str, plus_as_space: bool) -> String {
    pct_decode_with(s, plus_as_space).trim().to_string()
}

/// **所有入口的 id 都过这里**：百分号解码 + 首尾空白。
///
/// ⛔ 上一轮把 `str_field` 改成统一 trim（"改定义、不动调用点"），
/// 但 MCP 分发的 `s("id")`、HTTP path 切出来的 id 段都没跟上：
///   · AI 传 `"  tb-0001  "` 给 tb_get_task / tb_update_task / tb_add_event
///     → 「任务  tb-0001  不存在」，而任务明明在；报错把人往"任务不存在"上引
///   · AI 请求 `GET /api/tasks/%20tb-0001` → path 段没解码，也找不到
/// 三条读写入口 + 新增的删除入口共用这一份，不再逐处补 trim。
fn norm_id(raw: &str) -> String {
    norm_text(raw, false)
}

/* ⛔ MCP 的 id 由 check_required 判空（"必填参数 id 不能为空（工具 …）"），
   而 HTTP 的 id 来自 **URL 路径**：`GET/PATCH/DELETE/events /api/tasks/%20`
   norm_id 之后是空串，一路走到 find_task / patch_task，回「任务  不存在」→ 404。
   同一个「没给 id」，一条通道报参数错、一条报没找到，AI 查错方向又反了。
   与上一轮「必填校验套到路径分支」是同一根因的两面：id 有两种来源，
   判空却只做在了其中一种上。四个分支共用这一份，不再各写一遍。 */
fn norm_path_id(raw: &str) -> Result<String, String> {
    let id = norm_id(raw);
    if id.is_empty() {
        Err("必填参数 id 不能为空（路径）".to_string())
    } else {
        Ok(id)
    }
}

/// 读通道的过滤条件。**HTTP GET /api/tasks 与 MCP tb_list_tasks 共用这一份**。
///
/// ⛔ 修前两条通道的字段一致了（都带 tasks/agents/defs），**能力却不一致**：
/// MCP 有 7 个过滤参数，HTTP 一个都没有 —— route 里
/// `req.path.split('?')` 取完 path 就把 query 丢了，从不解析。
/// AI 经 HTTP 想「列出 todo 的任务」只能拉全量自己筛。
/// 而若两边各写一份过滤，必然又漂移成「同一判据两个入口」（前十几轮反复抓到）。
///
/// 多值也在这里统一：写入侧早就能传数组，读侧过滤原来只 `as_str()`，
/// 传 `{"status":["todo","doing"]}` 会被静默忽略成"不过滤"。
#[derive(Default)]
struct TaskFilter {
    status: Vec<String>,
    priority: Vec<String>,
    tag: Vec<String>,
    assignee: Vec<String>,
    typ: Vec<String>,
    group: Vec<String>,
    q: Vec<String>,
}

impl TaskFilter {
    /// MCP：每个键认字符串或字符串数组（数组 = OR）。
    fn from_args(args: &Value) -> Self {
        let vals = |k: &str| -> Vec<String> {
            match args.get(k) {
                Some(Value::String(v)) => {
                    let t = norm_text(v, false);
                    if t.is_empty() { Vec::new() } else { vec![t] }
                }
                /* JSON 参数里 `+` 是字面量，不按空格解 */
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|x| x.as_str())
                    .map(|x| norm_text(x, false))
                    .filter(|x| !x.is_empty())
                    .collect(),
                _ => Vec::new(),
            }
        };
        Self {
            status: vals("status"),
            priority: vals("priority"),
            tag: vals("tag"),
            assignee: vals("assignee"),
            typ: vals("type"),
            group: vals("group"),
            /* ⛔ 原来 .into_iter().next() 只取第一个，而其它 6 个参数都是 OR 全用；
               HTTP 的 q 更是 `= Some(...)` 重复键只留最后一个。
               同一个 struct 里两种判据，且都被静默丢弃 —— 与「过滤参数只认单值」同族。 */
            q: vals("q").into_iter().map(|x| x.to_lowercase()).collect(),
        }
    }

    /// HTTP：query string。**重复键累加**（`?status=todo&status=doing`），
    /// 不拆逗号 —— 分组名本身可能含逗号，拆了会静默筛错。
    fn from_query(req: &Request) -> Self {
        let mut f = Self::default();
        let raw = req.path.split_once('?').map(|(_, q)| q).unwrap_or("");
        for pair in raw.split('&') {
            if pair.is_empty() { continue; }
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let key = norm_text(k, true);
            let val = norm_text(v, true);
            if val.is_empty() { continue; }
            match key.as_str() {
                "status" => f.status.push(val),
                "priority" => f.priority.push(val),
                "tag" => f.tag.push(val),
                "assignee" => f.assignee.push(val),
                "type" => f.typ.push(val),
                "group" => f.group.push(val),
                "q" => f.q.push(val.to_lowercase()),
                _ => {} /* 未知参数忽略，不报错：AI 可能多带 */
            }
        }
        f
    }

    /// 一条任务是否命中。所有枚举列的判据集中在此，两条通道共用。
    fn matches(&self, t: &Value, store: &Value) -> bool {
        /* status / priority 是单值字段；多值 OR 不改变单值时的行为 */
        for (field, wants) in [("status", &self.status), ("priority", &self.priority)] {
            if wants.is_empty() { continue; }
            let cur = t.get(field).and_then(|v| v.as_str()).unwrap_or("");
            if !wants.iter().any(|w| w.as_str() == cur) { return false; }
        }
        /*
          四个 enum 列（含标签）**共用同一份判据**：任一命中；__none__ 查空值；
          哨兵值不算真实值。

          ⛔ 标签列原来单独一块：只跟真实值比，传 __none__ 永远 0 条，
          而界面筛选面板里标签列明明有「无标签」可筛 —— AI 通道筛不了。
          更隐蔽的是任务上残留 __notag__ 时它被当成真实标签，
          三列早已用 is_sentinel 排除、标签没有 —— **上一轮刚抽的共用判据，
          这个消费点没跟上**。合并进循环，四列自动同判据。
        */
        for (field, wants) in [
            ("assignee", &self.assignee),
            ("type", &self.typ),
            ("group", &self.group),
            ("tags", &self.tag),
        ] {
            if wants.is_empty() { continue; }
            let cur = vals_of(t, field);
            let real: Vec<&String> = cur
                .iter()
                .filter(|v| !is_sentinel(v))
                .collect();
            let mut ok = false;
            for w in wants {
                if w == "__none__" {
                    if real.is_empty() { ok = true; break; }
                } else if real.iter().any(|v| v.as_str() == w.as_str()) {
                    ok = true;
                    break;
                }
            }
            if !ok { return false; }
        }
        if !self.q.is_empty() {
            /* 多个关键词 = OR，与其它 6 个过滤参数同一判据 */
            let hay = search_hay(t, store);
            if !self.q.iter().any(|q| hay.contains(q.as_str())) { return false; }
        }
        true
    }
}

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

/// **界面实际生效**的流转表。与前端 `normalizeFlow` 同一判据：
///   自定义表优先（from / to 不在当前状态清单里的边裁掉）；
///   没配或全空时用默认图**裁到当前状态清单** —— 不留指向已删状态的边。
///
/// ⛔ 永不为 None。原来 `flow_transitions` 在空表时返回 None，
/// `can_flow(None, …)` 就退回**不裁剪**的默认图：自定义状态删掉 review 后，
/// 界面上那条边已经没了，服务端却还按默认图认它（只靠 allowed 兜底，
/// 一旦 allowed 的顺序/内容变化就会漏）。defs 与 patch_task 共用这一份，
/// AI 看到的流转图就是服务端真正用来校验的那张。
fn flow_for_ai(store: &Value) -> HashMap<String, Vec<String>> {
    let ids = statuses_for(store);
    let has = |id: &str| ids.iter().any(|i| i.as_str() == id);
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(obj) = store
        .get("flow")
        .and_then(|f| f.get("transitions"))
        .and_then(|v| v.as_object())
    {
        for (k, v) in obj.iter() {
            if !has(k.as_str()) {
                continue;
            }
            let arr: Vec<String> = match v.as_array() {
                Some(a) => a
                    .iter()
                    .filter_map(|x| x.as_str())
                    .map(|x| x.to_string())
                    .filter(|x| has(x.as_str()))
                    .collect(),
                None => Vec::new(),
            };
            /* 即使数组被裁空也保留 key（与前端一致：有 key 就不回退默认表） */
            out.insert(k.clone(), arr);
        }
    }
    if out.is_empty() {
        for &(from, tos) in DEFAULT_TRANSITIONS {
            if !has(from) {
                continue;
            }
            let arr: Vec<String> = tos
                .iter()
                .map(|x| x.to_string())
                .filter(|x| has(x.as_str()))
                .collect();
            out.insert(from.to_string(), arr);
        }
    }
    out
}

/// 状态的**完整定义**：id / name / color / enter / done。
///
/// ⛔ defs.statuses 只有 id 列表，AI 想「把任务流转到开发中」不知道该填 s2，
/// 也不知道哪个是完成态 —— 而 defs.priorityDefs / groupDefs 都是带 name 的
/// 完整对象，同一份 defs 里两种形状。自定义流程越用得多，这个坑越明显。
/// 归一判据与前端 `normalizeFlow` 一致（id trim / name 缺省用 id / done 布尔）。
fn status_defs_of(store: &Value) -> Value {
    let ids = statuses_for(store);
    let raw = store
        .get("flow")
        .and_then(|f| f.get("statuses"))
        .and_then(|v| v.as_array());
    let mut out: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    if let Some(arr) = raw {
        for one in arr.iter() {
            let id = match one.as_str() {
                Some(v) => v.trim().to_string(),
                None => one
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
            };
            if id.is_empty() || seen.contains(&id) {
                continue;
            }
            seen.push(id.clone());
            let name = match one.get("name").and_then(|v| v.as_str()) {
                Some(v) if !v.trim().is_empty() => v.trim().to_string(),
                _ => id.clone(),
            };
            let color = match one.get("color").and_then(|v| v.as_str()) {
                Some(v) if !v.trim().is_empty() => v.trim().to_string(),
                _ => "#78716c".to_string(),
            };
            let enter = match one.get("enter").and_then(|v| v.as_str()) {
                Some(v) if !v.trim().is_empty() => v.trim().to_string(),
                _ => format!("标为「{}」", name),
            };
            let done = one.get("done").and_then(|v| v.as_bool()) == Some(true);
            out.push(json!({ "id": id, "name": name, "color": color,
                            "enter": enter, "done": done }));
        }
    }
    if out.is_empty() {
        for &(id, name, color, enter, done) in DEFAULT_STATUS_DEFS {
            if !ids.iter().any(|i| i.as_str() == id) {
                continue;
            }
            out.push(json!({ "id": id, "name": name, "color": color,
                            "enter": enter, "done": done }));
        }
    }
    Value::Array(out)
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
    DEFAULT_TRANSITIONS
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
    match num_of(body.get("estimate")) {
        Some(x) if x.is_finite() && x > 0.0 => x,
        _ => 0.0,
    }
}

/*
  ⛔ 标题必填的判据以前只写在 create_task 里，`patch_task` 没有：
  AI 经 PATCH 传 {"title": "  "} 能把标题清空（str_field 统一 trim 之后
  就是空串）。而前端两处都挡着 —— 新建弹窗 `disabled={!title.trim()}`、
  列表行内编辑 `onCommit={(v) => { if (v) ... }}`，界面**自己永远造不出**
  空标题的任务；前端读盘虽有 `str(t.title,'') || '(无标题)'` 兜底，
  于是 AI 读 tasks.json 看到 title:""、界面显示「(无标题)」，
  两条通道说法不一致，且这个状态只有 AI 能造出来。

  抽成一份共用判据：create 与 patch 都调它，以后加第三个写入口也不会漏。
*/
fn validate_title(v: &str) -> Result<String, String> {
    let t = v.trim().to_string();
    if t.is_empty() {
        return Err("title 不能为空".to_string());
    }
    Ok(t)
}

/*
  ⛔ 可选**标量枚举/身份**字段的空串 = 「没给」，不是「清空」，更不是非法值。
  修前 create 与 patch 各自 `str_field(...)`：统一 trim 之后空串变成 Some("")，
  unwrap_or_else 不触发 → 四个消费点一起出问题：

    create {"priority":""} → "非法优先级 "（AI 以为是默认值，反复改值重试）
    create {"status":""}   → "新建任务只允许 status=todo（收到 ）"
    patch  {"priority":""} → 校验段报错；若只修校验段，下面 for 循环
                              又会把 "" 写进 tasks.json（同一字段两个消费点）
    patch  {"reporter":""} → for 循环把已有 reporter 清成 ""
    patch  {"status":""}   → "非法状态 "

  而前端 normalizeTask 读盘是 `|| 'P2' / 'todo' / 'manual'` 兜底：
  AI 写进去的空串界面会显示成默认值，tasks.json 里却是 "" —— 两条线索不一致。
  HTTP 列表过滤的空值、add_event 的 note/action、register_agent 的 name/role
  早都按「空串=没给」处理，这三个字段是同一族的漏网。

  ⛔ detail / summary 的空串**不在这里**：那两个字段允许清空，空串是合法值；
  estimate 的空串也合法（check_shapes 特意放行，estimate_of 归 0 = 没估）。
  title 是必填，空串由 validate_title 明确报错，不能当「没给」。

  判据只存在这一份，create / patch 的所有消费点共用，不再逐处补 filter。
*/
fn opt_str(body: &Value, key: &str) -> Option<String> {
    str_field(body, key).filter(|v| !v.is_empty())
}

fn create_task(dir: &PathBuf, body: &Value) -> Result<Value, String> {
    let title = validate_title(&str_field(body, "title").unwrap_or_default())?;
    /* 文本字段一律 trim：AI 手写 "  P4  " 不该因为多了空格就建不了任务 */
    let priority = opt_str(body, "priority").unwrap_or_else(|| "P2".to_string());
    if !PRIORITIES.contains(&priority.as_str()) {
        return Err(format!("非法优先级 {}（合法值: {}）", priority, PRIORITIES.join("/")));
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
    if let Some(s) = opt_str(body, "status") {
        if s != initial {
            return Err(format!(
                "新建任务只允许 status={}（收到 {}）；填的是定义表里的 id，不是显示名，可选值看响应 defs.statusDefs / initial；后续流转走 PATCH",
                initial, s
            ));
        }
    }
    /* 提升后的值一并写回，导出/导入后不会重新撞号（与前端 normalizeStore 一致） */
    let next_id = next_seq_for(&store);
    let id = format!("tb-{:04}", next_id);
    store["nextId"] = json!(next_id.saturating_add(1));

    /*
      ⛔ str_field 统一 trim 后空串是 Some("")，unwrap_or_else 不触发 →
      文件里 reporter=""；而前端 normalizeTask 是 `str(...) || 'manual'`
      —— 界面显示「manual」，tasks.json 里是空串，两条线索不一致。
      与上一轮 register_agent 的空串覆盖是同一族：空串应视为「没给」。
    */
    let reporter = str_field(body, "reporter")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "manual".to_string());
    let mut task = Map::new();
    task.insert("id".to_string(), json!(id));
    task.insert("title".to_string(), json!(title));
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
    task.insert("type".to_string(), enum_value(body, "type"));
    task.insert("tags".to_string(), tags_value(body));
    /*
      分组列：相当于以前的"手动分组"，但只是一列字符串值 ——
      归拢由"按列分组"机制表达，不再有组记录/父子层级。
      显式写进文件（哪怕为空）：这份 JSON 是给 AI 直接读改的，
      字段在文件里**看得见**它才会去填。
    */
    task.insert("group".to_string(), enum_value(body, "group"));
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
    task.insert("assignee".to_string(), enum_value(body, "assignee"));
    /*
      前置依赖：与 title/type/group/summary 一样**显式写进文件**。
      ⛔ 原来 AI 通道根本没有这个入口：create 不写、PATCH 不改、两处 schema 不列，
      而界面详情里有依赖下拉、文件里别的任务也有 deps —— 又是「看得见却填不了」
      （和 summary 那个 bug 一模一样）。AI 传 {"deps":["tb-0002"]} 被静默忽略，
      不报错，任务建出来永远没有前置。
    */
    task.insert("deps".to_string(), deps_value(body, &id));
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
    /* 与 defs.transitions 同一份归一表：AI 看到的图就是这里校验的图 */
    let flow = Some(flow_for_ai(&store));
    let by = match str_field(body, "by") {
        Some(s) if !s.is_empty() => s,
        _ => "manual".to_string(),
    };
    let note = str_field(body, "note").unwrap_or_default();
    /* 与 create 同一份判据：PATCH 不许把标题清空（界面两处都挡着） */
    if let Some(v) = str_field(body, "title") {
        validate_title(&v)?;
    }

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
        /* note 是否已被状态流转那条历史消费（作为后缀）。末尾据此决定
           要不要再单独记一条 action=note —— 不能记两遍。 */
        let mut note_in_status = false;
        /*
          ⛔ priority 与 create_task **必须同一判据**。
          原来 PATCH 直接把任意字符串塞进 obj，create 却校验 ——
          于是「新建时 P4 被拒、改优先级时乱写却成功」，
          同一份数据两条路说法不一致，而前端 normalizeTask 会把乱写的
          静默归到 P2，用户看到的是"改了又变回去"。
        */
        if let Some(v) = opt_str(body, "priority") {
            if !PRIORITIES.contains(&v.as_str()) {
                return Err(format!("非法优先级 {}（合法值: {}）", v, PRIORITIES.join("/")));
            }
        }
        // ⛔ summary 必须在这里：任务说明是显式写进文件的字段，
        // AI 看得见却改不了，等于这个字段对 AI 通道只读。
        /*
          ⛔ 这五个字段原来无条件 `insert + changed = true`，而同一个函数里
          status / type / group / estimate / tags / assignee **全都判了等** ——
          同一函数内两种判据。后果：AI 传一个没变化的 title：
            · 写盘 + updatedAt 刷新 → 任务从「超 7 天未动」里消失、
              按更新排序顶到最前，界面上确实"动了"，而什么都没改
            · 返回 200「已改」
          与前几轮修的「自环状态不加无变化历史」「认领要更新时间戳」
          是互补的一族：无变化的操作污染时间戳 / 该变没变。

          ⛔ 值也要 trim：create_task 的 title 存的是 trim 后的，
          而 PATCH 原样写入 —— 同一条任务新建时干净、改一次就带空格。
          前端 normalizeTask 读盘会 trim（界面看着干净），
          但 AI 直接读 tasks.json 看到的是带空格的，两条通道数据不一致。
        */
        for key in ["title", "detail", "summary", "priority", "reporter"] {
            if let Some(v) = str_field(body, key) {
                let next = v.trim();
                /* ⛔ 与 opt_str 同一份判据：这两个是**枚举/身份**字段，
                   空串 = 没给。只修校验段不够 —— 校验跳过后这里照样会
                   把 "" 写进文件，前端读盘又兜成 P2 / manual，两条线索打架。
                   detail / summary 不在此列：它们允许清空。 */
                if next.is_empty() && (key == "priority" || key == "reporter") {
                    continue;
                }
                if obj.get(key).and_then(|x| x.as_str()) != Some(next) {
                    obj.insert(key.to_string(), json!(next));
                    changed = true;
                }
            }
        }
        /*
          数组形状优先：三个「可以是多值」的列都认整体替换。
          ⛔ 与 create 的 enum_value、读侧 TaskFilter 的过滤参数同一形状口径。
          放在单值分支之前 —— 一个 key 只能有一种形状，单值的 str_field
          对数组返回 None，不会重复处理。
        */
        for (key, label) in [
            ("assignee", "未认领"),
            ("type", "未分类"),
            ("group", "未分组"),
        ] {
            if let Some(arr) = body.get(key).and_then(|v| v.as_array()) {
                let next = clean_str_array(arr);
                if key == "assignee" {
                    guard_assignee(&vals_from_map(obj, key), &next)?;
                }
                if patch_vals_set(obj, key, &next, &by, label) {
                    changed = true;
                }
            }
        }
        // 认领守卫：已被别人认领的任务不能被悄悄抢走。
        // 传空串 = 主动释放认领。判据见 guard_assignee（不再内联）。
        if let Some(v) = str_field(body, "assignee") {
            /*
              ⛔ 认领守卫也必须认多值：原来 cur 读数组得空串 →
              对共同认领的任务完全失效（AI 能把别人挤掉还返回 200）。
              现在算出「追加/替换后的最终集合」交给共用守卫：
              原数据是数组时单值是追加（不丢人），不再误挡共同认领。
            */
            let cur = vals_from_map(obj, "assignee");
            let was_array = obj.get("assignee").map(|x| x.is_array()).unwrap_or(false);
            let next = v.trim();
            let final_set: Vec<String> = if next.is_empty() {
                Vec::new()
            } else if was_array {
                let mut set = cur.clone();
                if !set.iter().any(|x| x == next) {
                    set.push(next.to_string());
                }
                set
            } else {
                vec![next.to_string()]
            };
            guard_assignee(&cur, &final_set)?;
            if patch_vals(obj, "assignee", next, &by, "未认领") {
                changed = true;
            }
        }
        if let Some(v) = str_field(body, "type") {
            if patch_vals(obj, "type", &v, &by, "未分类") {
                changed = true;
            }
        }
        if let Some(v) = str_field(body, "group") {
            if patch_vals(obj, "group", &v, &by, "未分组") {
                changed = true;
            }
        }
        if let Some(v) = body.get("estimate") {
            let cur = num_of(obj.get("estimate")).unwrap_or(0.0);
            let next = estimate_of(&json!({ "estimate": v.clone() }));
            if (cur - next).abs() > 1e-9 {
                obj.insert("estimate".to_string(), json!(next));
                changed = true;
                push_history(obj, &by, "estimate", &format!("{} -> {}", fmt_est(cur), fmt_est(next)));
            }
        }
        if let Some(status) = opt_str(body, "status") {
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
                /* 与前端 applyTransitionIn 同一份形状：note 是 status 历史的后缀，
                   不再另写一条 action=note（否则同一备注在详情里出现两遍）。 */
                note_in_status = !note.is_empty();
            }
        }
        /*
          ⛔ 整体替换也要清洗：原来 `tags.clone()` 原样写入，
          空串 / 全空格 / 重复 id 都进了文件。create 用 tags_value，
          两条入口必须同一判据（前端读盘虽会清，但 AI 读的是原始文件）。
        */
        if body.get("tags").is_some() {
            let next = tags_value(body);
            if obj.get("tags") != Some(&next) {
                obj.insert("tags".to_string(), next);
                changed = true;
            }
        }
        /* deps 与 tags 同一判据：清洗 + 判等（不自依赖 / 去空 / 去重） */
        if body.get("deps").is_some() {
            let self_id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let next = deps_value(body, self_id);
            if obj.get("deps") != Some(&next) {
                obj.insert("deps".to_string(), next);
                changed = true;
            }
        }
        if !changed {
            /*
              ⛔ 修前统一报「没有可应用的变更」——只传备注时 AI 会反复重试
              各种参数，而正确做法是改用 tb_add_event。报错不指路，
              和「流转失败文案把人往任务不存在上引」是同一类。
              PATCH 的 note 语义是「随字段变更附带的备注」，不是独立事件。
            */
            if !note.is_empty() {
                return Err("只有备注没有字段变更：追加备注请用 tb_add_event（POST /api/tasks/{id}/events）".to_string());
            }
            return Err("没有可应用的变更".to_string());
        }
        /*
          ⛔ 修前无条件 push 一条 action=note：状态流转时 note 已作为 status
          历史的后缀写过一遍（见上方 suffix），末尾再写一次 → 同一个备注
          在详情面板里出现两条，用户以为发生了两件事。
          实测 {"status":"doing","note":"开始"} 修前落盘 2 条历史、修后 1 条。
          只有「没走状态流转」的变更（改标题/优先级/加类型…）才单独记备注。
        */
        if !note.is_empty() && !note_in_status {
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

/// 删除一条任务。**HTTP DELETE /api/tasks/{id} 与 MCP tb_delete_task 共用**。
///
/// ⛔ AI 通道原来完全没有删除入口：界面有单条删除 + 批量删除，
/// 6 个工具里却只有 create/update/list/get/add_event/register_agent ——
/// AI 误建一条任务、或清理废弃任务，只能让用户去界面点。
/// 与「create 不写 summary / deps」「create schema 漏 assignee」同族：
/// 看得见却用不了。
///
/// ⛔ **不清其它任务的 deps**：界面 doDelete 刻意保留（lockOf 会标
/// 「前置不存在（可能已被删除）」），只在确认框里警告有多少条会受影响。
/// AI 没有确认框，所以把 dependents 放进**响应**（界面提示的等价物）——
/// 否则 AI 不知道自己制造了一批永远解锁不了的任务。
/// 同样不刷新其它任务的 updatedAt（界面也不刷新）。
fn delete_task(dir: &PathBuf, id: &str) -> Result<Value, String> {
    let id = id.trim();
    let mut store = load_tasks(dir)?;
    let (removed, dependents) = {
        let tasks = store["tasks"].as_array_mut().ok_or("tasks 不是数组")?;
        let pos = tasks
            .iter()
            .position(|t| t.get("id").and_then(|v| v.as_str()) == Some(id))
            .ok_or_else(|| format!("任务 {} 不存在", id))?;
        let removed = tasks.remove(pos);
        /* remove 之后只剩「其它任务」，正好是要检查依赖的对象 */
        let dependents: Vec<String> = tasks
            .iter()
            .filter(|t| vals_of(t, "deps").iter().any(|d| d.as_str() == id))
            .filter_map(|t| t.get("id").and_then(|v| v.as_str()).map(|x| x.to_string()))
            .collect();
        (removed, dependents)
    };
    save_tasks(dir, &store)?;
    Ok(json!({
        "ok": true,
        "deleted": id,
        "task": removed,
        "dependents": dependents,
        "dependentsCount": dependents.len(),
    }))
}

fn add_event(dir: &PathBuf, id: &str, body: &Value) -> Result<Value, String> {
    /*
      ⛔ 原来 add_event 没有任何判等：body={} 也会 push 一条
      {action:"note", note:""} 历史 + 刷新 updatedAt。
      这与上一轮修的「PATCH 传无变化的值不该刷新 updatedAt」是同一个后果 ——
      一次空操作把任务"救活"了：从「超 7 天未动」里消失、按更新排序顶到最前，
      而用户/AI 什么都没做。
      显式给了非 "note" 的 action（如 action:"deploy"）仍然算一次有意义的事件。
    */
    let note = str_field(body, "note").unwrap_or_default();
    let action_given = str_field(body, "action").filter(|v| !v.is_empty());
    /* ⛔ 原来 Some("") 会原样写进历史：{"action":"","note":"进展"}。
       AI 读原始 tasks.json 看到一条没有动作的记录，而界面优先显示 note
       看不出来 —— 静默脏数据。空串归一到默认的 "note"。 */
    let action = action_given.clone().unwrap_or_else(|| "note".to_string());
    if note.is_empty() && (action_given.is_none() || action.is_empty() || action == "note") {
        return Err("事件内容为空（请提供 note 或非 note 的 action）".to_string());
    }
    let by = match str_field(body, "by") {
        Some(s) if !s.is_empty() => s,
        _ => "manual".to_string(),
    };
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
    /*
      ⛔ 判空用 trim、写入却用原值：id="  a  " 能通过检查，
      然后带着空格存进 agents，界面显示一个前后带空格的名字，
      而下次用 "a" 注册又会当成另一个 agent（同一个实体被拆成两个）。
      与前端 normalizeTask 的文本字段判据一致：一律先 trim。
    */
    /* ⛔ 原来只 trim：MCP 的 id 参数与 check_required 都走 norm_id（解码+trim），
       AI 传 "agent%20A" 时校验认为有效、这里却存成字面量 "agent%20A"，
       界面显示带 %20 的窗口名，下次用 "agent A" 注册又拆成两个。 */
    let id_raw = str_field(body, "id").unwrap_or_default();
    let id = norm_id(&id_raw);
    if id.is_empty() {
        return Err("id 不能为空".to_string());
    }
    /*
      ⛔ 原来 `str_field` 返回 Some("") 也照样 insert：AI 传 {"name":""} 或
      {"role":""} 就把已有身份静默清空。而前端 normalizeStore 会兜成 id/'dev'
      —— 界面显示「a（dev）」，tasks.json 里却是 ""，两条线索不一致；
      下次注册还会把一个实体拆成两份（id 相同、名字不同）。
      缺失与空串都视为「不修改」，新建时回退到 id / 'dev'。
    */
    let name_in = str_field(body, "name").filter(|v| !v.is_empty());
    let role_in = str_field(body, "role").filter(|v| !v.is_empty());
    let mut store = load_tasks(dir)?;
    {
        let agents = store["agents"].as_array_mut().ok_or("agents 不是数组")?;
        if let Some(a) = agents
            .iter_mut()
            .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        {
            if let Some(obj) = a.as_object_mut() {
                if let Some(name) = &name_in {
                    obj.insert("name".to_string(), json!(name.as_str()));
                }
                if let Some(role) = &role_in {
                    obj.insert("role".to_string(), json!(role.as_str()));
                }
                obj.insert("lastSeen".to_string(), json!(now_ms()));
            }
        } else {
            agents.push(json!({
                "id": id,
                "name": name_in.clone().unwrap_or_else(|| id.clone()),
                "role": role_in.clone().unwrap_or_else(|| "dev".to_string()),
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
        202 => "Accepted",
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
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-TB-Token\r\nConnection: close\r\n\r\n",
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

/*
  ⛔ 必填参数缺失 / 形状不对时，原来一路静默变成空串流到业务层：
    · params.name 缺失 → "" → 「未知工具: 」
    · tb_get_task / tb_update_task / tb_add_event / tb_delete_task 缺 id
      → "" → 「任务  不存在」（AI 会以为任务被删了，去查 id 值反复重试）
    · tb_create_task 传 {"title": 123} → str_field 返回 None
      → 「title 不能为空」（真正错的是类型，不是没填）
  与「流转失败文案把人往任务不存在上引」「只传备注时报错不指路」
  是同一族：静默空串 + 报错指错方向。

  修法仍是「改定义、不动调用点」：必填清单只有这一份，
  mcp_tools 的 inputSchema.required 由守卫动态比对，防止加工具时只改一处。
*/
fn required_of(name: &str) -> &'static [&'static str] {
    match name {
        "tb_create_task" => &["title"],
        "tb_get_task" | "tb_update_task" | "tb_add_event" | "tb_delete_task"
        | "tb_register_agent" => &["id"],
        _ => &[],
    }
}

fn check_required(name: &str, args: &Value, path_id: Option<&str>) -> Result<(), String> {
    for &k in required_of(name) {
        /* ⛔ HTTP 的 PATCH / events 分支，id 来自**路径**，不在 body 里。
           上一轮把「必填校验」一并套到这两个分支，于是所有 HTTP PATCH
           （{"title":"Y"}）都报「缺少必填参数 id」—— 界面流转 / 改名 /
           送审全走这条链，等于整条写通道被掐断，而 MCP 侧完全正常。
           与「同一判据两个入口」相反：这次是「一份必填清单、两种 id 来源」。
           path_id 只跳过 id，**其它必填字段一个都不放过**。 */
        if k == "id" && path_id.is_some() { continue; }
        match args.get(k) {
            None | Some(Value::Null) => {
                return Err(format!("缺少必填参数 {}（工具 {} 需要它）", k, name));
            }
            Some(Value::String(v)) => {
                /* id 要走 norm_id：AI 手写 "%20" 解码后是空白，也算没给 */
                let blank = if k == "id" { norm_id(v).is_empty() } else { v.trim().is_empty() };
                if blank {
                    return Err(format!("必填参数 {} 不能为空（工具 {}）", k, name));
                }
            }
            Some(other) => {
                return Err(format!(
                    "必填参数 {} 必须是字符串，收到 {}（工具 {}）", k, other, name
                ));
            }
        }
    }
    Ok(())
}


/*
  ⛔ 上一轮只给 **MCP 通道**加了必填参数校验（check_required），
  HTTP 的 4 个写分支仍只 parse_body —— 同样的坏输入，两条通道两种结果：

    POST /api/tasks {"title":123}  → str_field 返回 None → 「title 不能为空」
    MCP  tb_create_task {"title":123} → -32602「必填参数 title 必须是字符串」

  而且**可选字段**形状错了两侧都静默吞：
    {"note":123} → patch 当作没传 → 「没有可应用的变更」（AI 反复重试）
    {"tags":[1,2]} → 非字符串元素被悄悄丢掉 → 标签少了一半
    {"type":42}    → 整列静默变空
    {"estimate":{"v":2}} → num_of 返回 None → 0（AI 以为设了 2）

  与「必填参数静默空串」「arguments 形状错了却报参数的错」是同一族。
  修法仍是「一份定义、两条通道共用」：check_write_args = required + shapes，
  mcp_dispatch / mcp_call_tool / HTTP 四个写分支都调它，不再各写一份。

  ⛔ 新函数必须留在 mcp_tools **之后**：上一轮把 required_of 放前面，
  里面的 "tb_create_task" 抢了 rsSeg('"tb_create_task"', 1200) 的首次命中，
  一次性让 16 条守卫恒红。
*/
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape { Str, StrOrArr, NumOrStr, Ignore }
fn shape_label(sh: Shape) -> &'static str {
    match sh {
        Shape::Str => "字符串",
        Shape::StrOrArr => "字符串或字符串数组",
        Shape::NumOrStr => "非负数字或数字字符串（0 表示没估）",
        Shape::Ignore => "任意",
    }
}
/* 工具名全集：与 mcp_tools 的 vec![] 一一对应（守卫动态比对，防止加工具漏校验） */
/* ⛔ HTTP 分支不许直接写 "tb_create_task" 这类字面量：它在 route 里比
   mcp_tools 更靠前，会抢走 rsSeg('"tb_create_task"', 1200) 的首次命中，
   一次性让 9 条守卫恒红。常量定义在工具表之后，首次出现仍归工具表。 */
const TB_CREATE: &str = "tb_create_task";
const TB_UPDATE: &str = "tb_update_task";
const TB_EVENT: &str = "tb_add_event";
const TB_AGENT: &str = "tb_register_agent";
const KNOWN_TOOLS: &[&str] = &[
    "tb_list_tasks", "tb_create_task", "tb_get_task", "tb_update_task",
    "tb_add_event", "tb_register_agent", "tb_delete_task",
];
const FILTER_FIELDS: &[&str] = &["status", "priority", "tag", "type", "group", "assignee", "q"];
const WRITE_ARR_FIELDS: &[&str] = &["type", "group", "assignee", "tags", "deps"];
const WRITE_STR_FIELDS: &[&str] = &[
    "id", "title", "detail", "summary", "reporter", "by", "note", "action",
    "name", "role", "status", "priority",
];
fn field_shape(tool: &str, key: &str) -> Shape {
    if !KNOWN_TOOLS.contains(&tool) { return Shape::Ignore; }  /* 未知工具交给 _ arm 报「未知工具」 */
    if tool == "tb_list_tasks" {
        return if FILTER_FIELDS.contains(&key) { Shape::StrOrArr } else { Shape::Ignore };
    }
    if tool == "tb_get_task" || tool == "tb_delete_task" {
        return if key == "id" { Shape::Str } else { Shape::Ignore };
    }
    if tool == "tb_add_event" {
        return if ["id", "by", "action", "note"].contains(&key) { Shape::Str } else { Shape::Ignore };
    }
    if tool == "tb_register_agent" {
        return if ["id", "name", "role"].contains(&key) { Shape::Str } else { Shape::Ignore };
    }
    /* create / update 共用同一张写字段表 */
    if WRITE_ARR_FIELDS.contains(&key) { return Shape::StrOrArr; }
    if key == "estimate" { return Shape::NumOrStr; }
    if WRITE_STR_FIELDS.contains(&key) { return Shape::Str; }
    Shape::Ignore   /* 未知字段忽略：AI 可能多带 */
}

fn check_shapes(tool: &str, args: &Value) -> Result<(), String> {
    let obj = args.as_object().ok_or("arguments 必须是 JSON 对象")?;
    for (k, v) in obj {
        let sh = field_shape(tool, k);
        let ok = match sh {
            Shape::Ignore => true,
            Shape::Str => v.is_string(),
            Shape::StrOrArr => match v {
                Value::String(_) => true,
                Value::Array(a) => a.iter().all(|x| x.is_string()),
                _ => false,
            },
            Shape::NumOrStr => match v {
                Value::Number(n) => n.as_f64().map(|x| x.is_finite() && x >= 0.0).unwrap_or(false),
                /* ⛔ 原来只判 finite：负数也被放行，而 estimate_of 是 `> 0.0`，
                   于是 create 落盘 0、PATCH 报「没有可应用的变更」——
                   AI 明明传了值，得到的却是「没改」/ 静默归零，反复重试。
                   与「只传备注时报错不指路」同族：校验得把路指对。 */
                Value::String(x) => {
                    let t = x.trim();
                    t.is_empty() || t.parse::<f64>().map(|n| n.is_finite() && n >= 0.0).unwrap_or(false)
                }
                _ => false,
            },
        };
        if !ok {
            return Err(format!(
                "参数 {} 形状不对（工具 {} 期望 {}，收到 {}）", k, tool, shape_label(sh), v
            ));
        }
    }
    Ok(())
}

fn check_write_args(tool: &str, args: &Value, path_id: Option<&str>) -> Result<(), String> {
    check_required(tool, args, path_id)?;
    check_shapes(tool, args)
}

/* HTTP 四个写分支共用：解析 + 必填 + 形状，一次做完。
   path_id = Some(...) 时 id 由 URL 路径提供（PATCH / events），
   None 时 id/title 都必须在 body 里（create / agents 与 MCP 全体）。 */
fn parse_write_body(body: &str, tool: &str, path_id: Option<&str>) -> Result<Value, String> {
    let v = parse_body(body)?;
    if !v.is_object() {
        return Err("请求体必须是 JSON 对象".to_string());
    }
    check_write_args(tool, &v, path_id)?;
    Ok(v)
}

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
        assert_eq!(tools.len(), 7);
        for t in &tools {
            assert!(t.get("inputSchema").is_some(), "工具缺 inputSchema");
        }
    }

    #[test]
    fn notification_gets_no_response() {
        // 无 id = 通知，不回包
        let req = serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        assert!(mcp_dispatch(&req, &PathBuf::new(), "review").is_none());
    }

    #[test]
    fn initialize_shape() {
        let req = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}});
        let resp = mcp_dispatch(&req, &PathBuf::new(), "review").unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(resp["result"]["serverInfo"]["name"], "nexus-panel-task-board");
    }

    #[test]
    fn call_create_then_list_roundtrip() {
        let dir = tmp_dir("roundtrip");
        let call = |name: &str, args: serde_json::Value| {
            let req = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
                "params":{"name":name,"arguments":args}});
            mcp_dispatch(&req, &dir, "review").unwrap()["result"].clone()
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
        let (code, text) = mcp_handle(&body, &dir, "review");
        assert_eq!(code, 200);
        assert!(text.contains("\"id\":7"));

        // 坏 JSON → -32700
        let (code, text) = mcp_handle("{oops", &dir, "review");
        assert_eq!(code, 400);
        assert!(text.contains("-32700"));
    }
}
