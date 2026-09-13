//! 配置与链接记录的持久化（插件独立的一份数据，存在 Tauri appDataDir 下）

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use super::model::{FpxConfig, LinkRecord, LinkRow, TabInfo, CardInfo};

/// 数据目录缓存：插件子目录 <appDataDir>/project-group
pub struct FpxState {
    inner: Mutex<Option<PathBuf>>,
}

impl FpxState {
    pub fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }
}

/// 无缓存版：解析并确保数据目录存在。
/// 后台线程（监听）、MCP server 这类拿不到 State 的场景用它；
/// 与 data_dir 指向同一目录，只是不做缓存。
pub fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    let dir = base.join("project-group");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录 {}: {e}", dir.display()))?;
    Ok(dir)
}

/// 解析并确保数据目录存在（带缓存，命令层专用）。
pub fn data_dir(app: &AppHandle, state: &FpxState) -> Result<PathBuf, String> {
    let mut guard = state.inner.lock().map_err(|e| format!("状态锁损坏: {e}"))?;
    if let Some(p) = guard.as_ref() {
        return Ok(p.clone());
    }
    let dir = resolve_data_dir(app)?;
    *guard = Some(dir.clone());
    Ok(dir)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<T>(&text).ok()
}

/// 原子写：先写同目录临时文件，成功后再 rename 覆盖。
/// 配置是全部页签登记的唯一副本，写到一半崩溃会让它变成半截 JSON、
/// 下次启动整个回默认——用户等于丢光所有登记，代价太大。
fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent).ok();

    let text = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;

    // 临时名带进程号+序号，避免多实例/并发调用撞车
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
        stamp
    ));

    if let Err(e) = fs::write(&tmp, &text) {
        return Err(format!("写入临时文件 {} 失败: {e}", tmp.display()));
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // rename 失败时清理临时文件，别在目录里留垃圾
            fs::remove_file(&tmp).ok();
            Err(format!("写入 {} 失败: {e}", path.display()))
        }
    }
}

pub fn load_config(dir: &Path) -> FpxConfig {
    let cfg: Option<FpxConfig> = read_json(&dir.join("config.json"));
    let mut cfg = cfg.unwrap_or_default();
    if cfg.project_tabs.is_empty() {
        cfg.project_tabs.push(Default::default());
        if let Some(first) = cfg.project_tabs.first_mut() {
            if first.name.is_empty() { first.name = "默认".into(); }
        }
    }
    if cfg.group_tabs.is_empty() {
        cfg.group_tabs.push(Default::default());
        if let Some(first) = cfg.group_tabs.first_mut() {
            if first.name.is_empty() { first.name = "默认".into(); }
        }
    }
    cfg
}

pub fn save_config(dir: &Path, cfg: &FpxConfig) -> Result<(), String> {
    write_json(&dir.join("config.json"), cfg)
}

/**
 * config.json 的写入互斥锁。
 *
 * 所有写入者都在**同一个进程内**：前端命令（Tauri command）、MCP server 线程、
 * 自动备份定时器。所以进程内的 `Mutex` 就足够，**不需要 OS 文件锁（flock）**——
 * 后者只在多进程同时写同一个文件时才必要，这里用不上，还会引入跨平台差异。
 */
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/**
 * 在持锁状态下完成「读配置 → 修改 → 写回」的整个事务。
 *
 * 为什么必须整体加锁，而不是只在 save 时加锁：
 * 只在写时加锁能保证两次写不交错，但**挡不住过期快照覆盖**——
 *   A: cfg = load()            // 读到版本 1
 *   B: load → 改 → save()      // 版本 2 落盘
 *   A: 基于手里的版本 1 改完 save()   // 版本 3 落盘，**B 的改动被整份覆盖**
 * 所以 load 与 save 必须在同一个临界区内，中间不能被别人的写插进来。
 *
 * 闭包返回 `Err` 时**不落盘**，与原先「提前 return 错误即不保存」的语义一致。
 * 返回值 R 用于把闭包里算出的东西（如新快照）带出来。
 *
 * 注意：闭包内做耗时操作（建 junction、rename、写 desktop.ini）会延长持锁时间。
 * 这些都是毫秒级且低频（用户主动触发），可以接受；但不要在闭包里做秒级网络请求。
 */
pub fn with_config<F, R>(dir: &Path, f: F) -> Result<R, String>
where
    F: FnOnce(&mut FpxConfig) -> Result<R, String>,
{
    // 持锁线程 panic 会让 Mutex 中毒；这里选择继续用（数据本身仍在磁盘上，
    // 且 with_config 会重新 load，不会因为中毒读到脏内存）
    let _guard = CONFIG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut cfg = load_config(dir);
    let r = f(&mut cfg)?;
    save_config(dir, &cfg)?;
    Ok(r)
}

pub fn load_records(dir: &Path) -> Vec<LinkRecord> {
    #[derive(serde::Deserialize)]
    struct File { #[serde(default)] links: Vec<LinkRecord> }
    read_json::<File>(&dir.join("link-record.json"))
        .map(|f| f.links)
        .unwrap_or_default()
}

pub fn save_records(dir: &Path, records: &[LinkRecord]) -> Result<(), String> {
    #[derive(serde::Serialize)]
    struct File<'a> { links: &'a [LinkRecord] }
    write_json(&dir.join("link-record.json"), &File { links: records })
}

/// 配置里的某个路径是否被 ACL 保护。
pub fn lock_of<'a>(cfg: &'a FpxConfig, path: &str) -> Option<&'a super::model::LockItem> {
    let key = normalize_key(path);
    cfg.locks.iter().find(|l| normalize_key(&l.path) == key)
}

/// Windows 下路径比较忽略大小写与尾斜杠。
pub fn normalize_key(path: &str) -> String {
    let p = path.trim().trim_end_matches(|c| c == '\\' || c == '/');
    if cfg!(windows) { p.to_lowercase() } else { p.to_string() }
}

/// 把配置中的页签（路径列表）转成带运行时状态的 TabInfo。
pub fn build_tabs(
    tabs: &[super::model::TabItem],
    cfg: &FpxConfig,
    records: &[LinkRecord],
    preset_names: &[String],
    kind: &str,
) -> Vec<TabInfo> {
    tabs.iter()
        .map(|t| TabInfo {
            name: t.name.clone(),
            items: t.items
                .iter()
                .map(|p| build_card(p, cfg, records, preset_names, kind))
                .collect(),
        })
        .collect()
}

/// 取某路径自身的标签色；没有则（仅项目卡片）继承它链接到的项目组的颜色。
fn resolve_tag_color(path: &str, cfg: &FpxConfig, records: &[LinkRecord], kind: &str)
    -> (Option<String>, bool)
{
    if let Some(c) = cfg.tag_colors.get(path) {
        return (Some(c.clone()), false);
    }
    // 项目组变色传播到所有引用它的项目（与原 C# 版 PropagateGroupColor 一致）
    if kind == "project" {
        let key = normalize_key(path);
        if let Some(rec) = records.iter().find(|r| normalize_key(&r.project) == key) {
            if let Some(c) = cfg.tag_colors.get(&rec.lib).or_else(|| cfg.tag_colors.get(&rec.group)) {
                return (Some(c.clone()), true);
            }
        }
    }
    (None, false)
}

#[allow(clippy::too_many_arguments)]
fn build_card(
    path: &str,
    cfg: &FpxConfig,
    records: &[LinkRecord],
    preset_names: &[String],
    kind: &str,
) -> CardInfo {
    let key = normalize_key(path);
    let rec = records.iter().find(|r| normalize_key(&r.project) == key);
    let names: Vec<String> = match rec {
        Some(r) => r.link_names(),
        None => preset_names.to_vec(),
    };
    let mut has_link = 0usize;
    let mut broken = 0usize;
    let mut conflict = 0usize;
    for n in &names {
        match super::junction::link_state(path, n) {
            super::junction::LinkState::Valid => has_link += 1,
            super::junction::LinkState::Broken => broken += 1,
            super::junction::LinkState::Conflict => conflict += 1,
        }
    }
    let lock = lock_of(cfg, path);
    let (tag_color, tag_color_inherited) = resolve_tag_color(path, cfg, records, kind);
    CardInfo {
        path: path.to_string(),
        name: Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string()),
        exists: Path::new(path).exists(),
        has_link: has_link > 0,
        has_broken: broken > 0,
        has_conflict: conflict > 0,
        link_count: has_link,
        linked_group: rec.map(|r| r.group.clone()).filter(|s| !s.is_empty()),
        locked: lock.map(|l| l.deny_delete || l.deny_write).unwrap_or(false),
        deny_delete: lock.map(|l| l.deny_delete).unwrap_or(false),
        deny_write: lock.map(|l| l.deny_write).unwrap_or(false),
        icon: cfg.folder_icons.get(path).cloned(),
        tag_color,
        tag_color_inherited,
    }
}

/// 把记录转成展示行（顺带算三态）。
pub fn build_link_rows(records: &[LinkRecord]) -> Vec<LinkRow> {
    records
        .iter()
        .map(|r| {
            let names = r.link_names();
            let mut valid = 0usize;
            let mut conflict = false;
            for n in &names {
                match super::junction::link_state(&r.project, n) {
                    super::junction::LinkState::Valid => valid += 1,
                    super::junction::LinkState::Conflict => conflict = true,
                    super::junction::LinkState::Broken => {}
                }
            }
            let state = if conflict {
                "conflict"
            } else if valid == 0 {
                "broken"
            } else if valid < names.len() {
                "partial"
            } else {
                "valid"
            };
            LinkRow {
                project: r.project.clone(),
                group: r.lib.clone(),
                group_name: r.group.clone(),
                created: r.created.clone(),
                names,
                state: state.to_string(),
            }
        })
        .collect()
}
