//! 一键备份：把配置里登记的项目 / 项目组增量同步到备份目录。
//! ------------------------------------------------------------------
//! 对齐 junction_link 的 Services/BackupService.cs：
//!   - 差异比对 = 文件大小 + 修改时间（2 秒容差，照顾 FAT/exFAT 的低精度时间戳）
//!   - junction / 符号链接一律不深入也不复制（本项目大量用链接，防循环与重复内容）
//!   - 源与备份目录互相嵌套时跳过该源，防自我复制
//!   - append_only：只新增/更新；否则镜像同步（多余文件与空目录一并清除）
//! 纯 std::fs 实现，无第三方依赖。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use super::fsutil::{is_real_dir, replace_file};
use super::model::FpxConfig;

/* ---------------------------- 自动备份调度 ---------------------------- */
/*
 * 每 30 秒醒一次重新读配置，而不是"睡满整个间隔"：
 * 用户在设置里把 60 分钟改成 15 分钟时，最多 30 秒后就能生效；
 * 若直接睡满，改动要等上一轮睡完才被看见，体验像是没保存。
 */
const TICK_SECS: u64 = 30;

static AUTO_RUNNING: AtomicBool = AtomicBool::new(false);
/// 自动备份线程的「代次」，与 watch.rs 的 GEN 同理。
///
/// stop_auto() 只置标志，老线程要等分段 sleep 走完才检查到；那段窗口里
/// start_auto() 会正常起新线程，而老线程醒来发现标志又是 true 就继续跑 ——
/// 结果两个线程各备份一遍。每次 start 领新代次，老线程发现代次变了就自行退出。
static AUTO_GEN: AtomicU64 = AtomicU64::new(0);
static AUTO_LAST: Mutex<Option<SystemTime>> = Mutex::new(None);

/// 自动备份状态（给设置面板显示）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStatus {
    pub running: bool,
    pub minutes: u32,
    /// 上次自动备份时刻，未跑过为 null
    pub last_run: Option<String>,
}

/// #29 实际生效的备份目录（两类各一 + 数据目录）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTargets {
    /// 项目备份落点
    pub project: String,
    /// 项目组备份落点
    pub group: String,
    /// 数据目录（留空时从这里退出的 backup/，显示出来好对照）
    pub data_dir: String,
}

/// 启动自动备份线程；已在运行则忽略。间隔为 0 时不启动（视为关闭）。
pub fn start_auto(app: AppHandle) -> bool {
    // 间隔可能尚未设置，先看一眼配置，为 0 就别起线程
    let minutes = match super::store::resolve_data_dir(&app) {
        Ok(dir) => super::store::load_config(&dir).backup_auto_minutes,
        Err(_) => 0,
    };
    if minutes == 0 { return false; }

    let gen = AUTO_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    AUTO_RUNNING.store(true, Ordering::SeqCst);

    thread::spawn(move || {
        let mut last: Option<SystemTime> = None;
        while AUTO_RUNNING.load(Ordering::SeqCst) && AUTO_GEN.load(Ordering::SeqCst) == gen {
            // 分段睡，方便响应"停止"与间隔改动
            for _ in 0..TICK_SECS {
                if !AUTO_RUNNING.load(Ordering::SeqCst)
                    || AUTO_GEN.load(Ordering::SeqCst) != gen { return; }
                thread::sleep(Duration::from_secs(1));
            }
            if AUTO_GEN.load(Ordering::SeqCst) != gen { return; }

            let dir = match super::store::resolve_data_dir(&app) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let cfg = super::store::load_config(&dir);
            let mins = cfg.backup_auto_minutes;

            // 关掉了就自行退出，下次保存配置时会被重新拉起
            if mins == 0 && AUTO_GEN.load(Ordering::SeqCst) == gen {
                AUTO_RUNNING.store(false, Ordering::SeqCst);
                return;
            }

            // 首次进入只记起点不执行：刚开软件就整树备份会明显卡顿，
            // 等一个完整间隔再跑更符合"定时备份"的预期
            let Some(prev) = last else {
                last = Some(SystemTime::now());
                continue;
            };
            let elapsed = SystemTime::now()
                .duration_since(prev)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if elapsed < u64::from(mins) * 60 { continue; }

            last = Some(SystemTime::now());
            let _ = run(&cfg, &dir, "project", cfg.backup_append_only);
            let _ = run(&cfg, &dir, "group", cfg.backup_append_only);
            if let Ok(mut g) = AUTO_LAST.lock() {
                *g = last;
            }
        }
    });
    true
}

pub fn stop_auto() {
    AUTO_GEN.fetch_add(1, Ordering::SeqCst);
    AUTO_RUNNING.store(false, Ordering::SeqCst);
}

pub fn is_auto_running() -> bool {
    AUTO_RUNNING.load(Ordering::SeqCst)
}

/// 供设置面板展示：是否运行中、当前间隔、上次自动备份时间。
pub fn auto_status(app: &AppHandle) -> AutoStatus {
    let minutes = super::store::resolve_data_dir(app)
        .map(|d| super::store::load_config(&d).backup_auto_minutes)
        .unwrap_or(0);
    let last_run = AUTO_LAST.lock().ok().and_then(|g| *g).and_then(|t| {
        t.duration_since(UNIX_EPOCH).ok().map(|d| {
            // 与 store/mod 里的日期换算保持一致：这里是秒级时间戳转本地可读串
            super::format_time(d.as_secs() as i64)
        })
    });
    AutoStatus { running: is_auto_running(), minutes, last_run }
}

const MTIME_TOLERANCE_SECS: i64 = 2;

/// 一次备份的统计结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub target: String,
    pub sources: usize,
    pub missing_sources: usize,
    pub new_files: usize,
    pub updated_files: usize,
    pub deleted_files: usize,
    pub skipped_links: usize,
    pub errors: Vec<String>,
}

impl BackupResult {
    pub fn summary(&self) -> String {
        let s = format!(
            "源 {} 个：新增 {}、更新 {}、删除 {}、跳过链接 {}、缺失源 {}",
            self.sources, self.new_files, self.updated_files,
            self.deleted_files, self.skipped_links, self.missing_sources
        );
        if self.errors.is_empty() { s } else { format!("{s}，异常 {} 条", self.errors.len()) }
    }
}

/// 解析实际备份目标目录。
/// 优先级：按类型专属目录（backupProjectDir / backupGroupDir）→ 统一目录（backupDir）→ 数据目录 backup/。
/// 仅用统一目录时才再按类型建子目录，避免同名互相覆盖；
/// 用户已指定专属目录时不再加子层——那是他明确选定的位置。
pub fn resolve_dir(cfg: &FpxConfig, data_dir: &Path, kind: &str) -> PathBuf {
    let specific = if kind == "group" { cfg.backup_group_dir.as_deref() } else { cfg.backup_project_dir.as_deref() };
    if let Some(d) = specific.map(str::trim) {
        if !d.is_empty() { return PathBuf::from(d); }
    }
    let base = match cfg.backup_dir.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => data_dir.join("backup"),
    };
    base.join(if kind == "group" { "backkup_项目组备份" } else { "backkup_项目备份" })
}

/// 收集全部页签中的路径（去重、保序）。
pub fn collect_paths(tabs: &[super::model::TabItem]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for t in tabs {
        for raw in &t.items {
            let p = raw.trim().trim_end_matches(['/', '\\']);
            if p.is_empty() { continue; }
            // 去重键必须用 normalize_key（按平台决定是否忽略大小写），不能无条件小写：
            // Linux / macOS 上 /a/Foo 与 /b/foo 是**两个不同的项目**，
            // 无条件小写会把后者当成重复项丢掉 —— 它压根不会被备份，且无报错无日志。
            let key = super::store::normalize_key(&p);
            if seen.insert(key) { out.push(p.to_string()); }
        }
    }
    out
}

/// 执行备份。kind: project | group
pub fn run(cfg: &FpxConfig, data_dir: &Path, kind: &str, append_only: bool) -> BackupResult {
    let target = resolve_dir(cfg, data_dir, kind);
    let tabs = if kind == "group" { &cfg.group_tabs } else { &cfg.project_tabs };
    let paths = collect_paths(tabs);
    let mut r = BackupResult {
        target: target.to_string_lossy().to_string(),
        sources: 0, missing_sources: 0, new_files: 0, updated_files: 0,
        deleted_files: 0, skipped_links: 0, errors: Vec::new(),
    };
    if paths.is_empty() { return r; }

    if let Err(e) = fs::create_dir_all(&target) {
        r.errors.push(format!("[失败] 创建备份目录 {}: {e}", target.display()));
        return r;
    }

    // 备份名冲突（不同源同名）在此剔除
    let mut by_name: HashMap<String, String> = HashMap::new();
    let mut sources: Vec<(String, PathBuf)> = Vec::new();
    for src in &paths {
        let name = safe_folder_name(src);
        if name.is_empty() {
            r.errors.push(format!("[跳过] 无法从路径解析文件夹名: {src}"));
            continue;
        }
        let key = name.to_lowercase();
        if let Some(owner) = by_name.get(&key) {
            r.errors.push(format!("[跳过] 备份名冲突「{name}」：{src} 与 {owner} 同名，请改名其一"));
            continue;
        }
        by_name.insert(key, src.clone());
        sources.push((name, PathBuf::from(src)));
    }

    for (name, src) in sources {
        // 不跟随链接：备份源里若混着指向上级的软链，会一边复制一边绕回自身
        if !is_real_dir(&src) {
            r.missing_sources += 1;
            continue;
        }
        if is_nested(&src, &target) {
            r.errors.push(format!("[跳过] 源目录与备份目录互相嵌套，为防自我复制已忽略: {}", src.display()));
            continue;
        }
        r.sources += 1;
        if let Err(e) = sync_tree(&src, &target.join(&name), append_only, &mut r) {
            r.errors.push(format!("[失败] 备份 {}: {e}", src.display()));
        }
    }
    r
}

fn safe_folder_name(full: &str) -> String {
    let p = full.trim_end_matches(['/', '\\']);
    let name = Path::new(p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    name.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect::<String>().trim().to_string()
}

/// 两目录是否存在包含关系（任一方是另一方的前代）。
fn is_nested(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase() + "/";
    let x = norm(a);
    let y = norm(b);
    x == y || x.starts_with(&y) || y.starts_with(&x)
}

fn mtime_secs(p: &Path) -> Option<i64> {
    fs::metadata(p).ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// 是否链接点（junction / symlink）：symlink_metadata 的 file_type 能识别，
/// 比 Windows 的 FILE_ATTRIBUTE_REPARSE_POINT 更跨平台。
fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// 递归收集源树：files = 相对路径 → (长度, 修改时间)；dirs = 相对路径集合。
///
/// 除跳过链接点外，还带一个"已访问目录"集合：
/// 光跳过链接挡不住硬链接环与绑定挂载构成的回路，
/// 那种情况下 read_dir 会一路成功、栈只会越来越深。
fn collect_source(
    root: &Path, rel: &Path,
    files: &mut HashMap<String, (u64, i64)>, dirs: &mut HashSet<String>,
    r: &mut BackupResult,
    seen: &mut HashSet<(u64, u64)>,
) {
    let abs = if rel.as_os_str().is_empty() { root.to_path_buf() } else { root.join(rel) };
    if !super::fsutil::WalkGuard::mark(seen, &abs) {
        r.errors.push(format!("[跳过] 检测到目录回路，不再深入: {}", abs.display()));
        return;
    }
    let entries = match fs::read_dir(&abs) {
        Ok(e) => e,
        Err(e) => { r.errors.push(format!("[失败] 枚举 {}: {e}", abs.display())); return; }
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let child_rel = match rel.as_os_str().is_empty() {
            true => PathBuf::from(entry.file_name()),
            false => rel.join(entry.file_name()),
        };
        let rel_key = child_rel.to_string_lossy().replace('\\', "/");
        if is_link(&p) { r.skipped_links += 1; continue; }
        if is_real_dir(&p) {
            dirs.insert(rel_key.clone());
            collect_source(root, &child_rel, files, dirs, r, seen);
        } else if let Ok(m) = fs::metadata(&p) {
            files.insert(rel_key, (m.len(), mtime_secs(&p).unwrap_or(0)));
        }
    }
}

fn sync_tree(src_root: &Path, dst_root: &Path, append_only: bool, r: &mut BackupResult) -> Result<(), String> {
    fs::create_dir_all(dst_root).map_err(|e| e.to_string())?;

    let mut src_files: HashMap<String, (u64, i64)> = HashMap::new();
    let mut src_dirs: HashSet<String> = HashSet::new();
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    collect_source(src_root, Path::new(""), &mut src_files, &mut src_dirs, r, &mut seen);

    // 1) 新增 / 更新
    for (rel, (len, mt)) in &src_files {
        let dst = dst_root.join(rel);
        let from = src_root.join(rel);
        match fs::metadata(&dst) {
            Err(_) => {
                if let Err(e) = copy_atomic(&from, &dst) {
                    r.errors.push(format!("[失败] {}: {e}", from.display()));
                } else { r.new_files += 1; }
            }
            Ok(m) => {
                let same_len = m.len() == *len;
                let same_time = (mtime_secs(&dst).unwrap_or(0) - mt).abs() <= MTIME_TOLERANCE_SECS;
                if !same_len || !same_time {
                    if let Err(e) = copy_atomic(&from, &dst) {
                        r.errors.push(format!("[失败] {}: {e}", from.display()));
                    } else { r.updated_files += 1; }
                }
            }
        }
    }

    if append_only { return Ok(()); }

    // 2) 镜像删除多余文件
    for p in walk(dst_root, true) {
        if is_link(&p) { r.skipped_links += 1; continue; }
        let rel = match p.strip_prefix(dst_root) {
            Ok(x) => x.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if !src_files.contains_key(&rel) {
            match fs::remove_file(&p) {
                Ok(()) => r.deleted_files += 1,
                Err(e) => r.errors.push(format!("[失败] 删除 {}: {e}", p.display())),
            }
        }
    }
    // 3) 自深至浅清理多余空目录
    let mut dirs_all = walk(dst_root, false);
    dirs_all.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for p in dirs_all {
        if is_link(&p) { continue; }
        let rel = match p.strip_prefix(dst_root) {
            Ok(x) => x.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if !src_dirs.contains(&rel) && fs::read_dir(&p).map(|mut it| it.next().is_none()).unwrap_or(false) {
            if let Err(e) = fs::remove_dir(&p) {
                r.errors.push(format!("[失败] 删除目录 {}: {e}", p.display()));
            }
        }
    }
    Ok(())
}

/// 原子复制：先写临时文件再 rename 覆盖，中途被打断不会留下半截正式文件。
fn copy_atomic(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 临时名 = 原名 + 后缀（不能用 with_extension：a.md 与 a.txt 会撞成同一个临时名）
    let mut tmp = dst.as_os_str().to_owned();
    tmp.push(".bktmp~");
    let tmp = PathBuf::from(tmp);
    fs::copy(src, &tmp).map_err(|e| e.to_string())?;
    // 临时文件与正式文件同目录，rename 一定同设备；跨设备的兜底留着纯粹为保险
    replace_file(&tmp, dst)
}

/// 遍历目录树；files_only 选择只要文件还是要目录。枚举异常降级为尽力而为。
fn walk(root: &Path, files_only: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    while let Some(dir) = stack.pop() {
        // 与 collect_source 同样的回路保护
        if !super::fsutil::WalkGuard::mark(&mut seen, &dir) { continue; }
        let entries = match fs::read_dir(&dir) { Ok(e) => e, Err(_) => continue };
        for entry in entries.flatten() {
            let p = entry.path();
            if is_real_dir(&p) {
                if !files_only { out.push(p.clone()); }
                stack.push(p);
            } else if files_only {
                out.push(p);
            }
        }
    }
    out
}
