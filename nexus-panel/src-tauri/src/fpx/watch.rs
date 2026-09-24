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
//!     注意 `is_symlink` 挡不住 Windows 的 junction（它不算 symlink），
//!     所以指纹遍历另有三重防环，见 fingerprint。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

static RUNNING: AtomicBool = AtomicBool::new(false);
/// 监听线程的「代次」。
///
/// 为什么需要它：stop() 只是置标志，线程要等本次 sleep 结束才会检查到。
/// 若 stop 后立刻 start，老线程醒来发现 RUNNING 又被新线程置成 true，
/// 就会继续跑 —— 于是两个线程同时轮询，事件重复上报一遍。
/// 每次 start 领一个新的代次号，线程发现代次变了就自行退出。
static GEN: AtomicU64 = AtomicU64::new(0);
/// 待前端取走的事件（后进先出无所谓，前端按序展示即可）。
static PENDING: Mutex<Vec<WatchEvent>> = Mutex::new(Vec::new());
/// #177 队列溢出标记：存**第一条**被丢弃的路径（None = 未曾溢出）。
/// 由 `push_event` 在丢弃时置位，`pull` 取走提示时复位。
static TRUNCATED: Mutex<Option<String>> = Mutex::new(None);

/// 当前轮询间隔（秒）。抑制时长按它推算，见 `suppress`。
static INTERVAL_SECS: AtomicU64 = AtomicU64::new(30);

/**
 * 被临时抑制的路径（归一化键 → 抑制到什么时候）。
 *
 * **为什么需要它**：自己搬家 / 改名会改变自己正在监控的目录，
 * 于是监控器把"你刚做的事"当成"有人动了受保护的文件夹"，
 * 弹一堆告警 —— 用户改个名就被自己吓一次，久了只能把告警整个关掉，
 * 那监控就形同虚设了（#411）。
 */
static SUPPRESSED: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

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

/// 该路径当前是否处于抑制窗口内（过期视为未抑制）。
fn suppressed(p: &str) -> bool {
    let key = super::store::normalize_key(p);
    match SUPPRESSED.lock() {
        Ok(v) => v
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, u)| *u > Instant::now())
            .unwrap_or(false),
        Err(_) => false,
    }
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

/// 遍历深度上限：见 fingerprint 里关于环的说明。
const SCAN_MAX_DEPTH: usize = 32;
/// 单次遍历的条目上限：超大目录树扫到一半就该收手，
/// 否则一次指纹的耗时能顶上好几个轮询周期。
const SCAN_MAX_ENTRIES: usize = 200_000;

/// 目录指纹：条目数 + 树内最大修改时间。
///
/// **三重防环**（清单 P1-9）。原先只靠 `is_symlink` 挡，但那不够：
/// Windows 的 junction 在 `symlink_metadata` 里**不是** symlink，而是
/// 「目录重解析点」，于是 `p.is_dir() && !is_symlink(&p)` 判断为 true、照样进栈。
/// 而本项目恰恰大量用 junction 把项目链接到项目组的 agents/skills ——
/// 一旦某个目录链回自己的祖先，跟随遍历就是死循环：线程卡住、栈无限增长。
///
/// 所以按「判定不可靠」来设计，三道保险一起上：
///   1. canonicalize 后去重（visited）——环上的目录只进一次
///   2. 深度上限
///   3. 条目总数上限
fn fingerprint(dir: &Path) -> (usize, i64) {
    let mut count = 0usize;
    let mut newest = 0i64;
    let mut visited: HashSet<PathBuf> = HashSet::new();
    // 起点也算访问过：子目录若链回它，就不会再展开一遍
    if let Ok(c) = dir.canonicalize() {
        visited.insert(c);
    }
    let mut stack: Vec<(PathBuf, usize)> = vec![(dir.to_path_buf(), 0)];
    'outer: while let Some((d, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            count += 1;
            newest = newest.max(mtime_secs(&p));
            if count >= SCAN_MAX_ENTRIES {
                break 'outer;
            }
            if depth + 1 >= SCAN_MAX_DEPTH {
                continue;
            }
            if p.is_dir() && !is_symlink(&p) {
                if let Ok(c) = p.canonicalize() {
                    if !visited.insert(c) {
                        continue; // 已经扫过（多半是链接绕回来了）
                    }
                }
                stack.push((p, depth + 1));
            }
        }
    }
    (count, newest)
}

fn push_event(ev: WatchEvent, app: &AppHandle) {
    if let Ok(mut q) = PENDING.lock() {
        if q.len() < PULL_LIMIT * 4 {
            q.push(ev.clone());
        } else if let Ok(mut tr) = TRUNCATED.lock() {
            /*
             * #177 队列满 → **不能静默丢弃**。
             *
             * 原版 `FolderWatchService.Entry.Truncated` 同语义：
             * 超 MaxPending 则置位，Flush 冲刷完后补一条 "Overflow" 告警。
             * 注释写明"短时间事件过多，部分记录已截断"。
             *
             * 静默丢弃的后果：用户看到监控日志不全，但日志本身**看起来
             * 一切正常** —— 他会以为"真的只有这些改动"，进而误判
             * "AI 没动我的文件"。而真相是我们漏报了。
             *
             * 只记**第一条**被丢的路径：原版 Truncated 是 bool 而非计数，
             * 目的是"告知有丢"，不是"统计丢了几个"。
             */
            if tr.is_none() {
                *tr = Some(ev.path.clone());
            }
        }
    }
    // 同页挂载模式 / 宿主补上转发后可直接收到；iframe 模式下这一路会被忽略
    let _ = app.emit("fpx://watch", &ev);
}

/// 启动监听线程（已在运行则忽略）。
pub fn start(app: AppHandle, interval_secs: u64, paths: Vec<String>) {
    // 先领代次：老线程（若有）看到代次变化会自行退出。
    // 不能再沿用「已在运行就直接 return」——stop 只置标志，老线程要等 sleep
    // 结束才退出，那段窗口里 start 会被误判成"重复启动"而拒绝，于是彻底没人监听。
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    RUNNING.store(true, Ordering::SeqCst);
    let interval = Duration::from_secs(interval_secs.max(5));
    INTERVAL_SECS.store(interval.as_secs().max(1), Ordering::SeqCst);
    let mut last: HashMap<String, (usize, i64)> = HashMap::new();
    for p in &paths {
        last.insert(p.clone(), fingerprint(Path::new(p)));
    }

    thread::spawn(move || {
        while RUNNING.load(Ordering::SeqCst) && GEN.load(Ordering::SeqCst) == gen {
            thread::sleep(interval);
            // 代次变了说明有新线程接管，自己必须退出，否则两个线程重复上报
            if !RUNNING.load(Ordering::SeqCst) || GEN.load(Ordering::SeqCst) != gen { break; }

            let dir = match super::store::resolve_data_dir(&app) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let cfg_paths: Vec<String> = super::store::load_config(&dir)
                .locks.iter().map(|l| l.path.clone()).collect();

            let mut changed: Vec<WatchEvent> = Vec::new();
            for p in &cfg_paths {
                let path = Path::new(p);
                /* 搬家 / 改名期间抑制（#411）。
                   **关键：抑制期间照常更新指纹，只是不报事件。**
                   若这里跳过不更新，抑制结束后第一次比对会看到
                   "搬家造成的全部差异"，一次性弹出一大堆 ——
                   那只是把误报推迟，问题一点没解决。 */
                if suppressed(p) {
                    if path.exists() {
                        last.insert(p.clone(), fingerprint(path));
                    } else {
                        last.remove(p);
                    }
                    continue;
                }
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
        // 只有自己这代仍是最新时才清标志：否则会把刚启动的新线程状态误清掉
        if GEN.load(Ordering::SeqCst) == gen {
            RUNNING.store(false, Ordering::SeqCst);
        }
    });
}

pub fn stop() {
    // 递增代次让当前线程尽快失效，不等它 sleep 结束
    GEN.fetch_add(1, Ordering::SeqCst);
    RUNNING.store(false, Ordering::SeqCst);
}

pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// 登记「这些路径在接下来一段时间内不要报事件」。
///
/// 抑制时长 = 当前轮询间隔 + 10 秒余量：目的是盖住**下一次轮询**，
/// 因为事件是在轮询那一刻比对出来的。给足一个周期，
/// 搬家 / 改名这种秒级操作无论落在周期的哪个位置都能被盖住。
pub fn suppress(paths: &[String]) {
    if paths.is_empty() { return; }
    let secs = INTERVAL_SECS.load(Ordering::SeqCst).saturating_add(10);
    let until = Instant::now() + Duration::from_secs(secs);
    let keys: Vec<String> = paths
        .iter()
        .map(|p| super::store::normalize_key(p))
        .collect();
    if let Ok(mut v) = SUPPRESSED.lock() {
        // 顺手清掉已过期的，否则这个列表会无限增长
        v.retain(|(_, u)| *u > Instant::now());
        for k in keys {
            match v.iter_mut().find(|(p, _)| *p == k) {
                Some(e) => e.1 = until,   // 连续两次搬家：按最后一次顺延
                None => v.push((k, until)),
            }
        }
    }
}

/// 取走待处理事件（取完即清空）。前端轮询用。
///
/// #177：队列曾溢出时，末尾补一条 `kind: "overflow"` 的提示事件。
///
/// 补在**末尾**（对齐原版：Flush 冲刷完待处理队列后才补一条 Overflow 告警），
/// 且一次只补一条 —— 提示是"有过截断"这件事本身，不是逐条补记。
pub fn pull() -> Vec<WatchEvent> {
    let mut out = match PENDING.lock() {
        Ok(mut q) => {
            if q.len() <= PULL_LIMIT {
                std::mem::take(&mut *q)
            } else {
                q.drain(..PULL_LIMIT).collect()
            }
        }
        Err(_) => Vec::new(),
    };
    /*
     * 即使本次取到的 `out` 为空也要补：置位发生在**之前**某次 push，
     * 那时队列已满；现在队列空了不代表没丢过。（若只在 out 非空时补，
     * 恰好在这次取空的场景下提示就永远发不出去。）
     */
    if let Ok(mut tr) = TRUNCATED.lock() {
        if let Some(p) = tr.take() {
            out.push(WatchEvent { path: p, kind: "overflow".into(), at: super::now_string() });
        }
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir()
            .join(format!("nexus_watch_{tag}_{}_{}", std::process::id(), nanos));
        std::fs::create_dir_all(&p).expect("建临时目录失败");
        p
    }

    /* 清单 P1-9：遍历必须能终止。
       junction 环在 Linux 上造不出来（那是 Windows 的重解析点），
       所以这里用"深到超过上限的树"验证深度上限确实生效 ——
       能返回就说明没有无限展开。 */

    #[test]
    fn fingerprint_terminates_on_deep_tree() {
        let base = tmpdir("deep");
        let mut cur = base.clone();
        // 造 60 层，超过 SCAN_MAX_DEPTH
        for _ in 0..60 {
            cur = cur.join("d");
            std::fs::create_dir_all(&cur).unwrap();
        }
        std::fs::write(cur.join("leaf.txt"), "x").unwrap();
        let (count, newest) = fingerprint(&base);
        assert!(count > 0);
        assert!(newest > 0, "应当读到文件的修改时间");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fingerprint_counts_entries_and_newest_mtime() {
        let base = tmpdir("fp");
        std::fs::write(base.join("a.txt"), "a").unwrap();
        let sub = base.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("b.txt"), "b").unwrap();
        let (count, newest) = fingerprint(&base);
        // 3 个条目：a.txt / sub / b.txt
        assert_eq!(count, 3);
        assert!(newest > 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fingerprint_of_missing_dir_is_empty() {
        let base = tmpdir("missing");
        let gone = base.join("nope");
        let (count, newest) = fingerprint(&gone);
        assert_eq!((count, newest), (0, 0));
        let _ = std::fs::remove_dir_all(&base);
    }
}
