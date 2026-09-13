//! 受保护目录监听：外部程序改动时提醒。
//! ------------------------------------------------------------------
//! 对齐 junction_link 的 Services/FolderWatchService.cs。
//!
//! 实现要点：
//!   - 不引 notify / inotify，改用**轮询**：后台线程按间隔对每个受保护目录算轻量指纹
//!     （条目数 + 树内最大修改时间），变了就记一条事件。
//!   - **事件靠拉取，不靠 emit**：本插件跑在 iframe 沙箱里，宿主明确禁用 listenTauri
//!     （见 js/host.js：`iframe 模式不支持 listenTauri`），Rust 侧 app.emit 到不了插件。
//!     所以事件先堆在 PENDING 队列里，前端用 fpx_watch_poll 定期取走。
//!     同时仍 emit 一份，将来若改同页挂载或宿主补上转发即可直接生效。
//!   - 链接点（junction/symlink）不深入，与备份策略一致，防循环。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

static RUNNING: AtomicBool = AtomicBool::new(false);
/// 待前端取走的事件（后进先出无所谓，前端按序展示即可）。
static PENDING: Mutex<Vec<WatchEvent>> = Mutex::new(Vec::new());

/// 单次拉取上限：防止长期没人取导致一次返回巨量数据。
const PULL_LIMIT: usize = 200;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub path: String,
    /// added | removed | changed
    pub kind: String,
    pub at: String,
}

fn mtime_secs(p: &Path) -> i64 {
    std::fs::metadata(p).ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_symlink(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// 目录指纹：条目数 + 树内最大修改时间。
fn fingerprint(dir: &Path) -> (usize, i64) {
    let mut count = 0usize;
    let mut newest = 0i64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            count += 1;
            newest = newest.max(mtime_secs(&p));
            if p.is_dir() && !is_symlink(&p) {
                stack.push(p);
            }
        }
    }
    (count, newest)
}

fn push_event(ev: WatchEvent, app: &AppHandle) {
    if let Ok(mut q) = PENDING.lock() {
        if q.len() < PULL_LIMIT * 4 {
            q.push(ev.clone());
        }
    }
    // 同页挂载模式 / 宿主补上转发后可直接收到；iframe 模式下这一路会被忽略
    let _ = app.emit("fpx://watch", &ev);
}

/// 启动监听线程（已在运行则忽略）。
pub fn start(app: AppHandle, interval_secs: u64, paths: Vec<String>) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let interval = Duration::from_secs(interval_secs.max(5));
    let mut last: HashMap<String, (usize, i64)> = HashMap::new();
    for p in &paths {
        last.insert(p.clone(), fingerprint(Path::new(p)));
    }

    thread::spawn(move || {
        while RUNNING.load(Ordering::SeqCst) {
            thread::sleep(interval);
            if !RUNNING.load(Ordering::SeqCst) { break; }

            let dir = match super::store::resolve_data_dir(&app) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let cfg_paths: Vec<String> = super::store::load_config(&dir)
                .locks.iter().map(|l| l.path.clone()).collect();

            let mut changed: Vec<WatchEvent> = Vec::new();
            for p in &cfg_paths {
                let path = Path::new(p);
                let fp = fingerprint(path);
                match last.get(p) {
                    None => {
                        if path.exists() {
                            last.insert(p.clone(), fp);
                            changed.push(WatchEvent {
                                path: p.clone(), kind: "added".into(), at: super::now_string(),
                            });
                        }
                    }
                    Some(prev) => {
                        if !path.exists() {
                            last.remove(p);
                            changed.push(WatchEvent {
                                path: p.clone(), kind: "removed".into(), at: super::now_string(),
                            });
                        } else if *prev != fp {
                            last.insert(p.clone(), fp);
                            changed.push(WatchEvent {
                                path: p.clone(), kind: "changed".into(), at: super::now_string(),
                            });
                        }
                    }
                }
            }
            // 配置里删掉的目录不再监控，避免解除保护后仍被盯着
            last.retain(|k, _| cfg_paths.contains(k));

            for ev in changed {
                push_event(ev, &app);
            }
        }
    });
}

pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
}

pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// 取走待处理事件（取完即清空）。前端轮询用。
pub fn pull() -> Vec<WatchEvent> {
    match PENDING.lock() {
        Ok(mut q) => {
            if q.len() <= PULL_LIMIT {
                std::mem::take(&mut *q)
            } else {
                q.drain(..PULL_LIMIT).collect()
            }
        }
        Err(_) => Vec::new(),
    }
}

/// 供诊断：当前监控的路径（调试用，顺带校验数据目录可达）。
#[allow(dead_code)]
pub fn watched_paths(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = super::store::resolve_data_dir(app) else { return Vec::new() };
    super::store::load_config(&dir).locks.iter().map(|l| l.path.clone()).collect()
}

/// 数据目录（shots / backup 等同级目录都挂在它下面）。
#[allow(dead_code)]
pub fn data_dir_of(app: &AppHandle) -> Option<PathBuf> {
    super::store::resolve_data_dir(app).ok()
}
