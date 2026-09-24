//! 配置与链接记录的持久化（插件独立的一份数据，存在 Tauri appDataDir 下）

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use super::model::{CURRENT_SCHEMA, FpxConfig, LinkRecord, LinkRow, TabInfo, CardInfo, LinkDetail};

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

/* ---------------------------- 数据损坏保护 ---------------------------- */
// config.json 与 link-record.json 都是**唯一副本**：没有别的副本能兜底，
// 也没有版本号能做迁移。所以「读不出来」这件事必须被当成事故处理，
// 而不是退回默认值继续跑。

/**
 * 一份数据的加载结果。
 *
 * 为什么必须区分「文件不存在」与「读不出来」：
 * 解析失败时若静默返回默认值，下一次保存就会拿默认值**整份覆盖**那个损坏文件——
 * 损坏的原文（唯一能人工抢救的线索）没了，用户的登记也没了，两头空。
 * 这不是理论风险：config 是整份覆盖写回的，一次误覆盖就不可逆。
 */
pub enum LoadOutcome<T> {
    /// 正常读到。文件不存在（全新/首次运行）也算正常，给默认值。
    Ok(T),
    /// 文件存在但读不出来：现场已另存为 `backup`，`reason` 是失败原因。
    Corrupted { backup: PathBuf, reason: String },
}

impl<T> LoadOutcome<T> {
    /// 只取可用的值；损坏时给 `fallback`。
    /// **仅用于只读展示**；写入路径必须显式处理 Corrupted，不能退化成默认值。
    pub fn unwrap_or(self, fallback: T) -> T {
        match self {
            LoadOutcome::Ok(v) => v,
            LoadOutcome::Corrupted { .. } => fallback,
        }
    }

    /// 同上，惰性版本（构造默认值有开销时用）。
    pub fn unwrap_or_else(self, f: impl FnOnce() -> T) -> T {
        match self {
            LoadOutcome::Ok(v) => v,
            LoadOutcome::Corrupted { .. } => f(),
        }
    }
}

/// 一个被保护文件的损坏现场。
#[derive(Clone)]
struct CorruptSite {
    /// 原始文件路径（规范化后，用于比对）
    file: String,
    /// 现场备份路径
    backup: PathBuf,
    reason: String,
}

/// 进程内记录的损坏现场。
///
/// 为什么只记进程内：损坏现场是**一次性**的——一旦被覆盖就再也找不回来。
/// 记在磁盘上意义不大（进程退出后用户多半已经处理了），而记在内存里
/// 足以拦住本进程内后续所有写入，这正是要防的（界面开着、用户点了几下）。
static CORRUPT_SITES: Mutex<Vec<CorruptSite>> = Mutex::new(Vec::new());

/// 记下某文件已损坏（含现场备份位置）。重复记录时保留首次的现场。
fn mark_corrupt(site: CorruptSite) {
    let mut list = CORRUPT_SITES
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if list.iter().any(|s| s.file == site.file) {
        return;
    }
    list.push(site);
}

/**
 * 写入前的拦截：若该文件已被标记为损坏，拒绝写入。
 *
 * 这是整套保护的关键——检测到损坏只是第一步，
 * **拦住后续写入**才是真正保住现场的那道闸。
 */
pub fn guard_against_corrupt(path: &Path) -> Result<(), String> {
    let key = normalize_key(&path.to_string_lossy());
    let mut list = CORRUPT_SITES.lock().unwrap_or_else(|p| p.into_inner());
    let idx = match list.iter().position(|s| s.file == key) {
        Some(i) => i,
        None => return Ok(()),
    };

    // 用户已自行处理：文件被删掉了。现场还在（另存的那份），
    // 所以可以安全放行——程序会按"首次运行"重建，不会丢东西。
    if !path.exists() {
        list.remove(idx);
        return Ok(());
    }

    // 注意：format! 里统一用隐式捕获，不混用位置参数（混用会编译失败）
    let file = path.display().to_string();
    let backup_path = list[idx].backup.display().to_string();
    let reason = list[idx].reason.clone();
    Err(format!(
        "{file} 读取失败（{reason}），已暂停一切写入以保护现场。\n\
         损坏内容已另存为：{backup_path}\n\
         请检查并修好该文件，或删除它让程序重建（现场副本不会丢）。"
    ))
}

/// 把损坏文件另存为现场（复制而非移动，原件保持原样便于人工比对）。
fn quarantine(path: &Path, reason: &str) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "data".into());
    let backup = path.with_file_name(format!("{name}.corrupt-{stamp}.bak"));

    fs::copy(path, &backup).map_err(|e| {
        let dst = backup.display().to_string();
        format!("无法保存损坏现场到 {dst}: {e}")
    })?;

    mark_corrupt(CorruptSite {
        file: normalize_key(&path.to_string_lossy()),
        backup: backup.clone(),
        reason: reason.to_string(),
    });
    Ok(backup)
}

/// 读文件原文，失败原因带出来（不像 read_json 那样吞掉）。
fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path)
        .map_err(|e| format!("读取失败：{e}"))
}

/**
 * 严格加载一份 JSON：读不出来就隔离现场并报告，绝不静默退回默认值。
 *
 * `default` 只在文件不存在（首次运行）时使用。
 */
fn load_strict<T: serde::de::DeserializeOwned + Default>(path: &Path) -> LoadOutcome<T> {
    if !path.exists() {
        return LoadOutcome::Ok(T::default());
    }
    let text = match read_text(path) {
        Ok(t) => t,
        Err(e) => {
            return match quarantine(path, &e) {
                Ok(backup) => LoadOutcome::Corrupted { backup, reason: e },
                Err(qe) => {
                    let orig = path.display().to_string();
                    LoadOutcome::Corrupted {
                        backup: path.to_path_buf(),
                        reason: format!("{e}；且{qe}（现场未能另存，请手动备份：{orig}）"),
                    }
                }
            };
        }
    };
    match serde_json::from_str::<T>(&text) {
        Ok(v) => LoadOutcome::Ok(v),
        Err(e) => {
            let reason = format!("JSON 解析失败：{e}");
            match quarantine(path, &reason) {
                Ok(backup) => LoadOutcome::Corrupted { backup, reason },
                Err(qe) => LoadOutcome::Corrupted {
                    backup: path.to_path_buf(),
                    reason: format!("{reason}；且{qe}"),
                },
            }
        }
    }
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
    // 临时文件与正式文件同目录，rename 必然同设备；
    // 仍走 replace_file 是为了在异常情况下（如数据目录被换成挂载点）不至于丢配置
    if let Err(e) = super::fsutil::replace_file(&tmp, path) {
        // 失败时清理临时文件，别在目录里留垃圾
        fs::remove_file(&tmp).ok();
        return Err(format!("写入 {} 失败: {e}", path.display()));
    }
    Ok(())
}

/// 兜底整理：两侧页签都至少有一个（界面依赖「永远有当前页签」）。
fn ensure_default_tabs(cfg: &mut FpxConfig) {
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

    /*
     * **已存在的**页签名若为空白也要兜底（对齐原版 ConfigService.Normalize：
     * `if (string.IsNullOrWhiteSpace(t.Name)) t.Name = "页签"`）。
     *
     * 不兜底的后果：手改 config.json 把页签名设成空串或纯空格，
     * 界面上那个页签按钮是**空白的、宽度塌到几乎为零** —— 用户不知道它存在、
     * 点不中它、也没法给它改名（因为根本找不到它在哪）。
     * 而它里面的卡片也就这样被"藏"起来了，且没有任何报错。
     *
     * 用 is_empty 判定空白（等价于 trim 后为空）而不是只判 empty，
     * 纯空格名同样看不出是什么。
     */
    for t in cfg.project_tabs.iter_mut() {
        if t.name.trim().is_empty() { t.name = "页签".into(); }
    }
    for t in cfg.group_tabs.iter_mut() {
        if t.name.trim().is_empty() { t.name = "页签".into(); }
    }
    /*
     * 图标分组只兜底**空名**，不兜底"一个分组都没有"。
     *
     * 为什么不能补一个空分组：前端 `PresetIconGrid` 的兜底是
     * `groups.length > 0 ? groups : [{ 默认, 全部内置图标 }]` ——
     * 只有"一个分组都没有"才会展示全部内置图标。后端一旦补出空分组，
     * 这个兜底就永远不触发，图标区变成**彻底空白**
     * （用户既看不到内置图标，也分不清是没图标还是加载失败）。
     * 本轮先补了空分组、正是踩了这个坑，已回退。
     */
    for g in cfg.icon_groups.iter_mut() {
        if g.name.trim().is_empty() { g.name = "分组".into(); }
    }
}

/**
 * 把配置里"手改越界"的数值夹回合法区间（目前只有日志条数，#32）。
 *
 * 为什么加载时要夹，而不是只靠 `#[serde(default)]`：
 * `default` 只管**字段缺失**。用户手改 config.json 写成 `logMaxLines: 99999`
 * 能正常反序列化，随后界面会真的尝试渲染近十万行 —— 卡的是用户自己。
 * 所以读进来就统一夹一次，写回时自然也是合法值。
 */
fn ensure_ranges(cfg: &mut FpxConfig) {
    use super::model as m;
    cfg.log_max_lines = m::clamp_log_max_lines(cfg.log_max_lines);
    // 布局三项：None 原样保留（界面走自适应 / 默认比例），只夹"手改过界"的值
    cfg.col_stars = m::normalize_col_stars(cfg.col_stars.take());
    cfg.log_row_height = m::clamp_px(cfg.log_row_height, m::LOG_HEIGHT_MIN, m::LOG_HEIGHT_MAX);
    cfg.settings_panel_height =
        m::clamp_px(cfg.settings_panel_height, m::PANEL_HEIGHT_MIN, m::PANEL_HEIGHT_MAX);
    cfg.mcp_panel_height =
        m::clamp_px(cfg.mcp_panel_height, m::PANEL_HEIGHT_MIN, m::PANEL_HEIGHT_MAX);
    cfg.tips_panel_height =
        m::clamp_px(cfg.tips_panel_height, m::PANEL_HEIGHT_MIN, m::PANEL_HEIGHT_MAX);
}

/// 只读用途的宽松加载：损坏时给默认值（界面仍能出快照），
/// 但**损坏状态已被记下**，随后的任何写入都会被 guard 拦住。
/**
 * config.json 的合法字段名集合。
 *
 * **由 `FpxConfig::default()` 序列化推导，不是手写清单**。
 * 手写的清单必然与实际字段漂移（加了字段忘了补清单），
 * 而漂移在"未知键检测"上的表现最坏：要么漏报（旧键照样静默丢），
 * 要么误报（新字段被当成未知，每次启动都弹提示）。
 * 序列化自身则永远与实际一致 —— 加字段自动进集合，删字段自动出集合。
 */
pub fn known_config_keys() -> HashSet<String> {
    serde_json::to_value(FpxConfig::default())
        .ok()
        .and_then(|v| v.as_object().map(|o| o.keys().cloned().collect()))
        .unwrap_or_default()
}

/// 找出 JSON 里出现、但 `FpxConfig` 不认识的键。
///
/// 这些键会被 serde 静默忽略 —— 用户以为存了，其实没读进来。
/// 常见于：字段改名后留下的旧键、别的版本写进去的键、手改 config 写错的名字。
/// 报出来比当没看见好：至少用户知道该去看一眼。
pub fn unknown_config_keys(raw: &serde_json::Value) -> Vec<String> {
    let known = known_config_keys();
    let mut out: Vec<String> = raw
        .as_object()
        .map(|o| o.keys().filter(|k| !known.contains(*k)).cloned().collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// 把配置从它自己的版本逐级升到 `CURRENT_SCHEMA`。
///
/// 返回做过的事（供日志）；已是最新版则返回空 ——
/// 启动时不该每次都刷一句"已迁移"，那会淹没真正的提示。
///
/// 现在只有 v1→v2 一级，且它**不做任何数据搬运**（v2 只是加了版本号本身）。
/// 框架先立起来：以后真要改字段名/语义，在这里加一级即可，
/// 不用再去每个读配置的地方补丁。
pub fn migrate_config(cfg: &mut FpxConfig) -> Vec<String> {
    let mut done: Vec<String> = Vec::new();
    /* 直接写 CURRENT_SCHEMA：本文件的 use 里带的就是 super::model 下的名字，
       加 `model::` 前缀会找不到模块（model 没被引入作用域）。 */
    while cfg.schema_version < CURRENT_SCHEMA {
        let from = cfg.schema_version;
        match from {
            // v1 → v2：只打版本标记。此前所有字段都带着 #[serde(default)]，
            // 老配置缺任何新字段都能正常读出默认值，没有真实的数据要搬。
            1 => {}
            // 走到这里说明有人加了 CURRENT_SCHEMA 却忘了写迁移
            other => {
                done.push(format!("未知的配置版本 {other}，已直接标记为最新"));
            }
        }
        cfg.schema_version = from + 1;
        done.push(format!("配置 schema {from} → {}", cfg.schema_version));
    }
    done
}

pub fn load_config(dir: &Path) -> FpxConfig {
    let mut cfg = load_config_strict(dir).unwrap_or_else(FpxConfig::default);
    ensure_default_tabs(&mut cfg);
    ensure_ranges(&mut cfg);
    migrate_config(&mut cfg);
    cfg
}

/// 加载时顺带体检：返回值得提醒用户的事（未知键、迁移记录）。
///
/// 与"读配置"分开，是因为**读路径不该顺手改文件** ——
/// 只读的地方（MCP、后台线程）拿这个看一眼就行，写回由调用方决定。
pub fn config_issues(dir: &Path) -> Vec<String> {
    let p = dir.join("config.json");
    if !p.exists() { return Vec::new(); }
    let text = match read_text(&p) { Ok(t) => t, Err(_) => return Vec::new() };
    let raw: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),   // 解析失败由加载路径负责报错，这里不重复
    };
    let mut out = Vec::new();
    let unknown = unknown_config_keys(&raw);
    if !unknown.is_empty() {
        /* 点名"会被忽略"，不说用户听不懂的 serde 术语。
           列出键名而不是只报数量 —— 用户得知道是哪个键才有得改。 */
        out.push(format!(
            "config.json 里有 {} 个不被识别的键，它们会被忽略：{}",
            unknown.len(),
            unknown.join("、")));
    }
    if let Ok(mut cfg) = serde_json::from_value::<FpxConfig>(raw) {
        out.extend(migrate_config(&mut cfg));
    }
    out
}

/// 严格加载：写入路径必须用它，损坏时返回 Corrupted 而不是默认值。
pub fn load_config_strict(dir: &Path) -> LoadOutcome<FpxConfig> {
    let p = dir.join("config.json");
    match load_strict::<FpxConfig>(&p) {
        LoadOutcome::Ok(mut cfg) => {
            ensure_default_tabs(&mut cfg);
            ensure_ranges(&mut cfg);
            LoadOutcome::Ok(cfg)
        }
        LoadOutcome::Corrupted { backup, reason } => {
            LoadOutcome::Corrupted { backup, reason }
        }
    }
}

pub fn save_config(dir: &Path, cfg: &FpxConfig) -> Result<(), String> {
    let p = dir.join("config.json");
    // 损坏现场未处理前，禁止覆盖——否则唯一能抢救的原文就没了
    guard_against_corrupt(&p)?;
    write_json(&p, cfg)
}

/**
 * config.json 的写入互斥锁（**进程内**）。
 *
 * 注意：它挡不住另一个进程。本程序有两个独立进程会写同一份数据：
 *   · GUI 主进程（前端命令、自动备份定时器）
 *   · `exe --mcp` 拉起的 MCP 实例（AI 客户端启动，关窗口只跑服务）
 * 所以进程内 Mutex 只是第一层；真正的跨进程互斥由下面的 `data_lock()` 提供。
 * 两层都要：进程内锁让同进程的并发走快路径（无文件 IO），
 * 跨进程锁负责拦住另一个进程。
 */
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// 账本（link-record.json）的进程内锁。
static RECORDS_LOCK: Mutex<()> = Mutex::new(());

/**
 * 整个数据目录的跨进程锁。
 *
 * config 与账本**共用一把**：绝大多数操作同时改两者（建链既写账本也改页签登记），
 * 分成两把就有 AB-BA 死锁的风险，收益却几乎没有。
 */
fn data_lock(dir: &Path) -> super::fsutil::FileLock {
    super::fsutil::FileLock::new(dir.join(".data.lock"))
}

thread_local! {
    /// 本线程已持有的跨进程锁层数。
    ///
    /// 为什么要可重入：`with_config` 的闭包里可能会再走 `with_records`
    /// （例如改名既要改页签登记又要重建链接记录）。文件锁本身不可重入，
    /// 直接再拿一次就是自己等自己——死锁，且没有任何提示。
    /// 这里记层数：外层已持有时，内层直接跳过获取，由最外层统一释放。
    static LOCK_DEPTH: std::cell::Cell<usize> = std::cell::Cell::new(0);
}

/// 进入事务前获取跨进程锁；嵌套调用时复用外层已持有的锁。
///
/// 返回值：外层拿到锁时是 `Some(guard)`，内层复用时是 `None`（什么都不用放）。
fn acquire_data_lock(dir: &Path) -> Result<Option<super::fsutil::FileLockGuard>, String> {
    let already = LOCK_DEPTH.with(|d| d.get() > 0);
    if already {
        LOCK_DEPTH.with(|d| d.set(d.get() + 1));
        return Ok(None);
    }
    let guard = data_lock(dir).lock()?;
    LOCK_DEPTH.with(|d| d.set(1));
    Ok(Some(guard))
}

/// 配 `acquire_data_lock` 用：退出作用域时把深度减回去。
///
/// 声明时必须**晚于**锁 guard，这样 Rust 的逆序 drop 会先减深度、再放锁。
struct LockDepthGuard;

impl Drop for LockDepthGuard {
    fn drop(&mut self) {
        LOCK_DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
    }
}

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
    // 第二层：拦住另一个进程（GUI 与 `--mcp` 实例）。RAII，panic 也会释放。
    let _xguard = acquire_data_lock(dir)?;
    let _depth = LockDepthGuard;

    // 拿默认值写回损坏文件 = 用户登记全部丢失，不可逆。
    // 所以这里必须用严格加载，损坏时直接中止事务，一次都不写。
    let mut cfg = match load_config_strict(dir) {
        LoadOutcome::Ok(c) => c,
        LoadOutcome::Corrupted { backup, reason } => {
            let backup_path = backup.display().to_string();
            return Err(format!(
                "config.json 读取失败（{reason}），已中止本次操作以保护数据。\n\
                 损坏内容已另存为：{backup_path}\n\
                 请检查或删除该文件后重试（现场副本不会丢）。"
            ));
        }
    };
    let r = f(&mut cfg)?;
    save_config(dir, &cfg)?;
    Ok(r)
}

/**
 * 在持锁状态下完成「读账本 → 修改 → 写回」的整个事务。
 *
 * 与 `with_config` 对称，共用同一把跨进程锁。
 *
 * 为什么必须走事务而不是直接 `load_records` / `save_records`：
 * 账本是全量覆盖写的，两个写入者各自 load→改→save，
 * 后写的会把先写的**整条记录**抹掉——链接还在磁盘上，但账本里查不到，
 * 界面显示"未链接"，用户以为丢了。这类 bug 极难定位（数据看起来是好的）。
 */
pub fn with_records<F, R>(dir: &Path, f: F) -> Result<R, String>
where
    F: FnOnce(&mut Vec<LinkRecord>) -> Result<R, String>,
{
    let _guard = RECORDS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _xguard = acquire_data_lock(dir)?;
    let _depth = LockDepthGuard;

    let mut records = match load_records_strict(dir) {
        LoadOutcome::Ok(v) => v,
        LoadOutcome::Corrupted { backup, reason } => {
            let backup_path = backup.display().to_string();
            return Err(format!(
                "link-record.json 读取失败（{reason}），已中止本次操作以保护数据。\n\
                 损坏内容已另存为：{backup_path}\n\
                 请检查或删除该文件后重试（现场副本不会丢）。"
            ));
        }
    };
    let r = f(&mut records)?;
    save_records(dir, &records)?;
    Ok(r)
}

/// 账本文件（link-record.json）的**两种历史形态**。
///
/// 对齐原版 `LinkRecordService.LoadStrict`，它明写：
/// 「兼容 `{clusters,links}` 对象 或 **裸数组** 两种历史格式」。
///
///   · `{ "links": [...] }` —— 对象形态（当前写入格式）
///   · `[...]`              —— **裸数组**（更早版本原版工具写出来的）
///
/// 只认对象形态的后果：老账本会被判成"损坏" ——
/// 文件本身完好、数据一条不少，但工具报「JSON 解析失败」并顺带
/// **拦住全部写入**（`guard_against_corrupt`）。
/// 用户看到的只是"账本坏了"，而真相是"我们不认这个格式" ——
/// 报错完全指向不了原因，他也无从知道该手动改什么。
#[derive(serde::Deserialize)]
#[serde(untagged)]
pub enum RecordFile {
    Object {
        #[serde(default)]
        links: Vec<LinkRecord>,
    },
    Array(Vec<LinkRecord>),
}

impl Default for RecordFile {
    fn default() -> Self { RecordFile::Object { links: Vec::new() } }
}

impl RecordFile {
    pub fn into_links(self) -> Vec<LinkRecord> {
        match self {
            RecordFile::Object { links } => links,
            RecordFile::Array(v) => v,
        }
    }
}

/// 严格加载账本（写入路径专用）。
pub fn load_records_strict(dir: &Path) -> LoadOutcome<Vec<LinkRecord>> {
    match load_strict::<RecordFile>(&dir.join("link-record.json")) {
        LoadOutcome::Ok(f) => LoadOutcome::Ok(f.into_links()),
        LoadOutcome::Corrupted { backup, reason } => {
            LoadOutcome::Corrupted { backup, reason }
        }
    }
}

pub fn load_records(dir: &Path) -> Vec<LinkRecord> {
    // 账本同样是唯一副本：读不出来时**绝不能以空列表继续**——
    // 后续 save_records 会把空列表整份写回，所有链接记录瞬间蒸发。
    // 这里给空列表只为让界面仍能渲染，但损坏状态会被记下，
    // 随后的 save_records 会被 guard_against_corrupt 拦住。
    load_strict::<RecordFile>(&dir.join("link-record.json"))
        .unwrap_or_else(RecordFile::default)
        .into_links()
}

pub fn save_records(dir: &Path, records: &[LinkRecord]) -> Result<(), String> {
    #[derive(serde::Serialize)]
    struct File<'a> { links: &'a [LinkRecord] }
    let p = dir.join("link-record.json");
    // 同上：损坏现场未处理前，禁止用（可能是空的）内存数据覆盖
    guard_against_corrupt(&p)?;
    write_json(&p, &File { links: records })
}

/// 配置里的某个路径是否被 ACL 保护。
pub fn lock_of<'a>(cfg: &'a FpxConfig, path: &str) -> Option<&'a super::model::LockItem> {
    let key = normalize_key(path);
    cfg.locks.iter().find(|l| normalize_key(&l.path) == key)
}

/**
 * 找出所有「保护范围覆盖 path」的锁（`#427`）。
 *
 * **为什么不能只用 `lock_of`（精确相等）**：ACL 是加在目录根上、靠继承传播的，
 * 所以 `locks` 里记的可能是**祖先目录**。而要写入的文件常常在更深的层级 ——
 * 比如保护的是 `<组>/skill/`，要写的是 `<组>/skill/foo/SKILL.md`。
 * 按精确相等去查，一条都查不到，于是锁没被摘、写入被自己拦住（自伤）。
 *
 * 判定：锁的路径是 path 本身，或 path 位于它之下（按分隔符边界，
 * 避免 `/foo` 被当成 `/foobar` 的祖先）。
 */
pub fn locks_covering<'a>(cfg: &'a FpxConfig, path: &str) -> Vec<&'a super::model::LockItem> {
    let key = normalize_key(path);
    cfg.locks
        .iter()
        .filter(|l| {
            let lk = normalize_key(&l.path);
            lk == key || key.starts_with(&format!("{lk}/"))
        })
        .collect()
}

/// Windows 下路径比较忽略大小写与尾斜杠。
/// 路径比较用的规范化 key —— **全项目唯一一套规则**，任何按路径查表的地方都必须用它。
///
/// 规则：去首尾空白 → 去尾部分隔符 → 统一分隔符为正斜杠 → 仅在 Windows 转小写。
///
/// 为什么只在 Windows 转小写：NTFS / FAT 的文件名大小写不敏感，`Foo` 与 `foo` 是同一个
/// 文件；而 Linux（ext4 等）与 macOS（APFS 默认）是敏感的，它们是**两个不同的目录**。
/// 无条件小写会让大小写不同的两个项目被判成同一个 key，标签色 / 图标 / ACL 锁 / 链接记录
/// 互相覆盖 —— 即"数据串档"。
///
/// 为什么必须统一分隔符：同一个目录可能有 `C:\Foo` 与 `C:/Foo` 两种写法（手动改配置、
/// 跨工具粘贴都可能产生）。不统一的话同一份数据会查出两种结果。
///
/// 历史教训：这个文件原先不带分隔符统一，而 sys.rs 另有一份"无条件小写"的副本，
/// 前端 api.ts 又是第三份"无条件小写"。三套规则并存，是多个路径匹配 bug 的共同根因。
pub fn normalize_key(path: &str) -> String {
    let p = path.trim().trim_end_matches(|c| c == '\\' || c == '/');
    let p = p.replace('\\', "/");
    if cfg!(windows) { p.to_lowercase() } else { p }
}

/// 把配置中的页签（路径列表）转成带运行时状态的 TabInfo。
pub fn build_tabs(
    tabs: &[super::model::TabItem],
    cfg: &FpxConfig,
    records: &[LinkRecord],
    preset_names: &[String],
    kind: &str,
) -> Vec<TabInfo> {
    // 组路径清单算一次、逐卡复用（见 collect_group_paths 的注释）
    let group_paths = collect_group_paths(cfg);
    tabs.iter()
        .map(|t| TabInfo {
            name: t.name.clone(),
            items: t.items
                .iter()
                .map(|p| build_card(p, cfg, records, preset_names, kind, &group_paths))
                .collect(),
        })
        .collect()
}

/// 取某路径自身的标签色；没有则（仅项目卡片）继承它链接到的项目组的颜色。
fn resolve_tag_color(path: &str, cfg: &FpxConfig, records: &[LinkRecord], kind: &str)
    -> (Option<String>, bool)
{
    /*
     * #113 两套标签色，界面上**GUI 那套优先**。
     *
     * 继承（项目组 → 项目）也按同一优先级走：
     * 自身 GUI > 自身普通 > 组 GUI > 组普通。
     * 不这么排的话，"组设了 GUI 色而项目设了普通色"会显示错的那个。
     */
    if let Some(c) = cfg.tag_gui_colors.get(path).or_else(|| cfg.tag_colors.get(path)) {
        return (Some(c.clone()), false);
    }
    // 项目组变色传播到所有引用它的项目（与原 C# 版 PropagateGroupColor 一致）
    if kind == "project" {
        let key = normalize_key(path);
        if let Some(rec) = records.iter().find(|r| normalize_key(&r.project) == key) {
            let from_gui = cfg.tag_gui_colors.get(&rec.lib)
                .or_else(|| cfg.tag_gui_colors.get(&rec.group));
            if let Some(c) = from_gui {
                return (Some(c.clone()), true);
            }
            if let Some(c) = cfg.tag_colors.get(&rec.lib).or_else(|| cfg.tag_colors.get(&rec.group)) {
                return (Some(c.clone()), true);
            }
        }
    }
    (None, false)
}

/// 收集配置里登记的全部项目组路径（去重、去尾部分隔符）。
///
/// 给磁盘兜底反查用。放在 `build_tabs` 里算一次、逐张卡片复用 ——
/// 若每张卡都重扫一遍页签，卡片上百时就是几百次无谓的字符串分配。
fn collect_group_paths(cfg: &FpxConfig) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for t in &cfg.group_tabs {
        for g in &t.items {
            let g = g.trim().trim_end_matches(|c| c == '\\' || c == '/');
            if g.is_empty() { continue; }
            if seen.insert(normalize_key(g)) { out.push(g.to_string()); }
        }
    }
    out
}

/**
 * 磁盘兜底（#181 #215）：账本里没有这条记录时，扫描项目目录下真实存在的链接，
 * 用它的指向反查项目组。
 *
 * 为什么需要：junction 可以在本工具之外被创建 —— 手工 mklink、别的脚本、
 * 旧版本迁移遗漏。那种情况下账本没有记录，卡片就显示不出"链到了哪个项目组"，
 * 而链接明明在磁盘上好好存在着，用户只会觉得"这软件没认出来"。
 *
 * 代价可控：只在账本确实没记录时才扫，且**找到就停**。
 * `link_state` 的探测在 `build_card` 里本来就要做，这里只是顺带读一次目标。
 *
 * 返回 (组名, 组路径)。组路径**优先取已登记的那条**：junction 里的原始值
 * 可能与登记值差一个结尾分隔符或大小写，用已登记的更利于后续比对与跳转。
 * 指向的不是已登记项目组时，仍如实给出目标本身 —— 链接确实存在，
 * 显示出来比空着有用。
 */
fn disk_group_of(
    project: &str,
    names: &[String],
    group_paths: &[String],
) -> Option<(String, String)> {
    for n in names {
        if super::junction::link_state(project, n) != super::junction::LinkState::Valid {
            continue;
        }
        let lp = super::junction::link_path(project, n);
        let Some(target) = super::junction::resolve_target(&lp) else { continue };
        let raw = target.trim().trim_end_matches(|c| c == '\\' || c == '/').to_string();
        if raw.is_empty() { continue; }
        let tk = normalize_key(&raw);
        let path = group_paths
            .iter()
            .find(|g| normalize_key(g) == tk)
            .cloned()
            .unwrap_or(raw);
        let name = Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        return Some((name, path));
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn build_card(
    path: &str,
    cfg: &FpxConfig,
    records: &[LinkRecord],
    preset_names: &[String],
    kind: &str,
    group_paths: &[String],
) -> CardInfo {
    let key = normalize_key(path);
    let rec = records.iter().find(|r| normalize_key(&r.project) == key);
    let names: Vec<String> = match rec {
        Some(r) => r.link_names(),
        None => preset_names.to_vec(),
    };
    /* 账本没记录时，靠磁盘上真实存在的链接反查项目组（#181 #215）。
       有记录就**不覆盖** —— 显式登记过的信息优先于推断出来的。 */
    let fb = if rec.is_none() { disk_group_of(path, &names, group_paths) } else { None };
    let fb_name = fb.as_ref().map(|f| f.0.clone());
    let fb_path = fb.as_ref().map(|f| f.1.clone());
    let mut has_link = 0usize;
    let mut broken = 0usize;
    let mut conflict = 0usize;
    let mut details: Vec<LinkDetail> = Vec::with_capacity(names.len());
    let project_exists = std::path::Path::new(path).exists();
    for n in &names {
        let state = match super::junction::link_state(path, n) {
            super::junction::LinkState::Valid => { has_link += 1; "valid" }
            super::junction::LinkState::Broken => { broken += 1; "broken" }
            super::junction::LinkState::Conflict => { conflict += 1; "conflict" }
        };
        /*
         * 逐行反查真实目标（原版 row 级 ResolveTarget）。
         *
         * 只在**读得到且确实存在**时才覆盖 —— 读不到（权限、损坏的
         * junction）就留着账本值，不能把"查不出来"显示成"没连"。
         */
        let real = super::junction::resolve_target(&super::junction::link_path(path, n))
            .filter(|t| !t.is_empty() && std::path::Path::new(t).exists());
        let (gname, gpath) = match (&real, rec) {
            (Some(t), _) => (
                std::path::Path::new(t)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                t.clone(),
            ),
            (None, Some(r)) => (r.group.clone(), r.lib.clone()),
            (None, None) => (
                fb_name.clone().unwrap_or_default(),
                fb_path.clone().unwrap_or_default(),
            ),
        };
        let group_exists = std::path::Path::new(&gpath).exists();
        /*
         * 逐行提示：四种情况要分得清。
         *
         * 只给一个笼统的"链接异常"是不够的 ——
         * "项目文件夹没了"和"项目组文件夹没了"是两种完全不同的补救方式，
         * 用户看不出区别就只能瞎试。
         */
        let tip = if !project_exists {
            format!("项目文件夹不存在: {path}")
        } else if !gpath.is_empty() && !group_exists {
            format!("项目组文件夹不存在: {gpath}")
        } else if state == "conflict" {
            format!("链接冲突: {n} 被普通目录/文件占用")
        } else if state == "valid" {
            if gname.is_empty() { format!("已创建链接（{n}）") }
            else { format!("链接项目组: {gname}（{n}）") }
        } else {
            format!("链接已破坏: {n}")
        };
        details.push(LinkDetail {
            name: n.clone(),
            group_name: rec.map(|r| r.group.clone())
                .or_else(|| fb_name.clone())
                .unwrap_or_default(),
            group: rec.map(|r| r.lib.clone())
                .or_else(|| fb_path.clone())
                .unwrap_or_default(),
            state: state.to_string(),
            // 创建时间只有账本知道，磁盘上读不出来 —— 空着比编一个强
            created: rec.map(|r| r.created.clone()).unwrap_or_default(),
            real_group_name: gname,
            real_group: gpath,
            project_exists,
            group_exists,
            tip,
        });
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
        linked_group: rec.map(|r| r.group.clone()).filter(|s| !s.is_empty())
            .or_else(|| fb_name.filter(|s| !s.is_empty())),
        locked: lock.map(|l| l.deny_delete || l.deny_write).unwrap_or(false),
        /* #21 账面固定：与 ACL 是两件事，单独给一个字段，
           界面据此决定显示盾牌（有 ACL）还是小锁（仅固定）。 */
        account_fixed: lock.map(|l| l.account_only).unwrap_or(false),
        deny_delete: lock.map(|l| l.deny_delete).unwrap_or(false),
        deny_write: lock.map(|l| l.deny_write).unwrap_or(false),
        icon: cfg.folder_icons.get(path).cloned(),
        gui_icon: cfg.folder_gui_icons.get(path).cloned(),
        tag_color,
        tag_color_inherited,
        link_details: details,
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

/* ---------------------------- 命令行模式用的公开读写口 ---------------------------- */
// cli.rs 拿不到 AppHandle，需要按**显式路径**读写；这里把已有的内部函数开放出去。

/// 按显式路径读一个 JSON（失败直接返回 Err，不像内部 read_json 那样吞掉错误）。
pub fn read_json_any<T: serde::de::DeserializeOwned>(path: &std::path::Path) -> Result<T, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读取失败 {}: {e}", path.display()))?;
    serde_json::from_str::<T>(&text)
        .map_err(|e| format!("解析失败 {}: {e}", path.display()))
}

/// 按显式路径写 JSON（同样走原子写，避免写到一半留下坏文件）。
pub fn write_json_any<T: serde::Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
    write_json(path, value)
}

/// 按**完整文件路径**读链接记录（与 load_records 不同：那个收的是目录）。
pub fn load_records_from_exact(path: &std::path::Path) -> Result<Vec<LinkRecord>, String> {
    // 同上：这里读的是同一个 link-record.json，两种形态都要认。
    if !path.exists() { return Ok(Vec::new()); }
    read_json_any::<RecordFile>(path).map(|f| f.into_links())
}

/// 按完整文件路径读链接记录；文件不存在时返回空（首次运行属正常）。
pub fn load_records_from(path: &std::path::Path) -> Vec<LinkRecord> {
    load_records_from_exact(path).unwrap_or_default()
}

/// 按**完整文件路径**写链接记录（与 save_records 不同：那个收的是目录）。
pub fn save_records_to(path: &std::path::Path, records: &[LinkRecord]) -> Result<(), String> {
    #[derive(serde::Serialize)]
    struct File<'a> {
        links: &'a [LinkRecord],
    }
    write_json(path, &File { links: records })
}

/// 返回**不超过** max、且落在 UTF-8 字符边界上的最大下标。
///
/// 为什么需要它：`String::truncate(n)` 与 `&s[..n]` 在 n 不在字符边界时会**直接 panic**。
/// 中文每字 3 字节，按字节数截断中文文本极易命中 —— 预览文件、`deploy_skill`
/// 生成目录名都会踩到。截断前先退到最近的合法边界即可。
pub fn safe_truncate_at(s: &str, max: usize) -> usize {
    if max >= s.len() { return s.len(); }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}
