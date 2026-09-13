//! 项目组分配插件 · 后端命令层
//! ------------------------------------------------------------------
//! 把 junction_link（C# WPF 版）里「项目组分配」「agent/skill 浏览」「新建项目/项目组」
//! 「ACL 保护」「文件夹图标」几块能力搬进 Nexus Panel 的 Rust 后端。
//! 数据独立存放在 <appDataDir>/project-group/ 下，不触碰原 C# 版的数据目录。

// 本模块是给前端插件用的命令集合，部分辅助函数暂未接入，允许存在未使用项
#![allow(dead_code)]

pub mod backup;
pub mod base64;
pub mod chain;
pub mod content;
pub mod editor;
pub mod junction;
pub mod mcp;
pub mod model;
pub mod screen;
pub mod store;
pub mod sys;
pub mod watch;

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, State};

use model::{
    Bootstrap, ContentItem, DirEntryLite, FpxConfig, LinkRecord, LinkRow, TabInfo,
};
use store::FpxState;

/* ---------------------------- 快照 DTO ---------------------------- */

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub config: FpxConfig,
    pub project_tabs: Vec<TabInfo>,
    pub group_tabs: Vec<TabInfo>,
    pub links: Vec<LinkRow>,
}

pub(crate) fn snapshot(dir: &std::path::Path, cfg: &FpxConfig) -> Snapshot {
    let records = store::load_records(dir);
    let names = junction::enabled_names(cfg);
    Snapshot {
        config: cfg.clone(),
        project_tabs: store::build_tabs(&cfg.project_tabs, cfg, &records, &names, "project"),
        group_tabs: store::build_tabs(&cfg.group_tabs, cfg, &records, &names, "group"),
        links: store::build_link_rows(&records),
    }
}

/* ---------------------------- 核心逻辑层 ---------------------------- */
// 与命令层一一对应，但只吃「数据目录」而不吃 State。
// 这样后台线程（监听）和 MCP server 都能复用同一套逻辑，不必拿 State。

pub(crate) fn core_snapshot(dir: &std::path::Path) -> Snapshot {
    let cfg = store::load_config(dir);
    snapshot(dir, &cfg)
}

/// 保存整份配置。
///
/// 注意 editorPickCache 由后端独家维护（`fpx_list_editors` 扫描后写入），
/// 前端拿到的 bootstrap 快照里可能还是旧值（缓存为空）。若直接照前端传来的写回，
/// 用户只要再点一次「保存设置」，刚扫出来的缓存就被清空、下次又得重扫一遍。
/// 所以该字段以磁盘上的值为准，不受前端草稿影响。
pub(crate) fn core_save_config(dir: &std::path::Path, config: &FpxConfig) -> Result<Snapshot, String> {
    let mut merged = config.clone();
    let on_disk = store::load_config(dir);
    merged.editor_pick_cache = on_disk.editor_pick_cache;
    store::save_config(dir, &merged)?;
    Ok(snapshot(dir, &merged))
}

pub(crate) fn core_create_link(
    dir: &std::path::Path,
    project: &str,
    group: &str,
    names: Option<Vec<String>>,
) -> Result<Snapshot, String> {
    let cfg = store::load_config(dir);
    let use_names = match names {
        Some(n) if !n.is_empty() => n,
        _ => junction::enabled_names(&cfg),
    };

    // 项目目录受 ACL 保护时，建链动作须临时摘锁（对应 C# 版 FolderLockService.WithUnlockForPath）
    let mut created: Vec<String> = Vec::new();
    let mut err: Option<String> = None;
    let _guard = LockGuard::new(project, store::lock_of(&cfg, project));
    for n in &use_names {
        match junction::create(project, group, std::slice::from_ref(n)) {
            Ok(paths) => created.extend(paths),
            Err(e) => { err = Some(e); break; }
        }
    }
    drop(_guard);

    // 无论成败，已建成的部分都要写进账本，避免"链接在、记录缺失"
    let mut records = store::load_records(dir);
    if !created.is_empty() {
        let done: Vec<String> = use_names
            .iter()
            .take(created.len())
            .cloned()
            .collect();
        upsert_record(&mut records, project, group, done);
        store::save_records(dir, &records)?;
    }

    if let Some(e) = err {
        return Err(format!("已创建 {} 个链接后失败：{e}", created.len()));
    }
    Ok(snapshot(dir, &cfg))
}

pub(crate) fn core_remove_link(dir: &std::path::Path, project: &str) -> Result<Snapshot, String> {
    let cfg = store::load_config(dir);
    let mut records = store::load_records(dir);
    let key = store::normalize_key(project);
    let names: Vec<String> = records
        .iter()
        .find(|r| store::normalize_key(&r.project) == key)
        .map(|r| r.link_names())
        .unwrap_or_else(|| junction::enabled_names(&cfg));

    let _guard = LockGuard::new(project, store::lock_of(&cfg, project));
    junction::remove(project, &names)?;
    drop(_guard);

    records.retain(|r| store::normalize_key(&r.project) != key);
    store::save_records(dir, &records)?;
    Ok(snapshot(dir, &cfg))
}

pub(crate) fn core_set_lock(
    dir: &std::path::Path,
    path: &str,
    deny_delete: bool,
    deny_write: bool,
) -> Result<Snapshot, String> {
    let mut cfg = store::load_config(dir);
    sys::apply_lock(path, deny_delete, deny_write)?;

    let key = store::normalize_key(path);
    cfg.locks.retain(|l| store::normalize_key(&l.path) != key);
    if deny_delete || deny_write {
        cfg.locks.push(model::LockItem {
            path: path.to_string(),
            deny_delete,
            deny_write,
        });
    }
    store::save_config(dir, &cfg)?;
    Ok(snapshot(dir, &cfg))
}

/// 图标 + 标签色一次保存（避免前端分两次写入互相覆盖）。
pub(crate) fn core_save_style(
    dir: &std::path::Path,
    path: &str,
    icon_ref: Option<String>,
    color: Option<String>,
) -> Result<Snapshot, String> {
    let mut cfg = store::load_config(dir);

    // 标签色：空串 / null 视为恢复默认（删除记录）
    let color = color.unwrap_or_default();
    let color = color.trim();
    let color = if color.is_empty() { None } else { Some(color.to_uppercase()) };
    match color {
        Some(c) => { cfg.tag_colors.insert(path.to_string(), c); }
        None => { cfg.tag_colors.remove(path); }
    }

    let icon = icon_ref.unwrap_or_default();
    let icon = icon.trim().to_string();
    if icon.is_empty() {
        cfg.folder_icons.remove(path);
    } else {
        cfg.folder_icons.insert(path.to_string(), icon.clone());
    }

    // desktop.ini 是 Windows 资源管理器专属机制，其它平台只记在配置里（界面内仍生效）
    if cfg.icon_affect_explorer && cfg!(windows) {
        sys::apply_icon(path, &icon)?;
    }

    store::save_config(dir, &cfg)?;
    Ok(snapshot(dir, &cfg))
}

pub(crate) fn core_save_custom_colors(
    dir: &std::path::Path,
    colors: Vec<String>,
) -> Result<Snapshot, String> {
    let mut cfg = store::load_config(dir);
    let mut out: Vec<String> = Vec::new();
    for c in colors {
        let c = c.trim().to_uppercase();
        if c.is_empty() || out.contains(&c) || out.len() >= 24 { continue; }
        out.push(c);
    }
    cfg.custom_colors = out;
    store::save_config(dir, &cfg)?;
    Ok(snapshot(dir, &cfg))
}

/* ---------------------------- 命令 ---------------------------- */

/// 启动加载：数据目录 + 配置 + 卡片状态 + 链接记录 + 预设 agent 名单。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_bootstrap(app: AppHandle, state: State<'_, FpxState>) -> Result<Bootstrap, String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    let records = store::load_records(&dir);
    let names = junction::enabled_names(&cfg);
    Ok(Bootstrap {
        data_dir: dir.to_string_lossy().to_string(),
        platform: std::env::consts::OS.to_string(),
        config: cfg.clone(),
        project_tabs: store::build_tabs(&cfg.project_tabs, &cfg, &records, &names, "project"),
        group_tabs: store::build_tabs(&cfg.group_tabs, &cfg, &records, &names, "group"),
        links: store::build_link_rows(&records),
        preset_agents: junction::preset_list_of(&cfg),
        all_names: junction::all_names(&cfg),
    })
}

/// 保存配置并返回刷新后的快照。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_save_config(
    app: AppHandle,
    state: State<'_, FpxState>,
    config: FpxConfig,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    core_save_config(&dir, &config)
}

/// 为项目创建指向项目组的链接（默认用配置里启用的链接名）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_create_link(
    app: AppHandle,
    state: State<'_, FpxState>,
    project: String,
    group: String,
    names: Option<Vec<String>>,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    core_create_link(&dir, &project, &group, names)
}

/// 删除项目下的链接并清除记录。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_remove_link(
    app: AppHandle,
    state: State<'_, FpxState>,
    project: String,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    core_remove_link(&dir, &project)
}

/// 扫描项目组下的 agent / skill / rule。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_scan_content(root: String, kind: Option<String>) -> Vec<ContentItem> {
    content::scan(&root, kind.as_deref().unwrap_or("all"))
}

/// 读取文件文本（目录型 skill 自动读其 SKILL.md）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_read_file(path: String, max: Option<usize>) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    let target = if p.is_dir() {
        match content::skill_md_of(&path) {
            Some(f) => f,
            None => return Err("该目录下没有 SKILL.md".into()),
        }
    } else {
        path.clone()
    };
    content::read_preview(&target, max.unwrap_or(20000))
}

/// 打开路径。mode: auto | dir | containing | editor
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_open_path(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    mode: Option<String>,
) -> Result<(), String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    sys::open_path(&path, mode.as_deref().unwrap_or("auto"), cfg.edit_tool_path.as_deref().unwrap_or(""))
}

/// 列出子目录（内嵌目录选择器）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_list_dirs(path: String) -> Result<Vec<DirEntryLite>, String> {
    sys::list_dirs(&path)
}

/// 常用起点。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_quick_roots() -> Vec<DirEntryLite> {
    sys::quick_roots()
}

/// 新建项目 / 项目组文件夹的核心逻辑（命令层与 MCP 共用，不依赖 State）。
/// hierarchy（页签名）只有 config.createPathCarriesHierarchy 为真时才拼进路径——
/// 开关由后端判定，调用方不必自己决定要不要传。
pub(crate) fn core_create_folder(
    dir: &std::path::Path,
    parent: &str,
    name: &str,
    hierarchy: Option<&str>,
    template: Option<&str>,
) -> Result<String, String> {
    let cfg = store::load_config(dir);
    let h = if cfg.create_path_carries_hierarchy { hierarchy } else { None };
    sys::create_folder(parent, name, h, template)
}

/// 新建项目 / 项目组文件夹，返回完整路径。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_create_folder(
    app: AppHandle,
    state: State<'_, FpxState>,
    parent: String,
    name: String,
    hierarchy: Option<String>,
    template: Option<String>,
) -> Result<String, String> {
    let dir = store::data_dir(&app, &state)?;
    core_create_folder(&dir, &parent, &name, hierarchy.as_deref(), template.as_deref())
}

/// 设置 ACL 保护（同时写入配置）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_set_lock(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    deny_delete: bool,
    deny_write: bool,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    core_set_lock(&dir, &path, deny_delete, deny_write)
}

/// 一次性保存卡片外观（图标 + 标签色），避免前端分两次写入互相覆盖。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_save_style(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    icon_ref: Option<String>,
    color: Option<String>,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    core_save_style(&dir, &path, icon_ref, color)
}

/// 设置文件夹图标（写入配置；Windows 下还会写 desktop.ini）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_set_icon(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    icon_ref: Option<String>,
    affect_explorer: Option<bool>,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    let mut cfg = store::load_config(&dir);
    let icon = icon_ref.unwrap_or_default();
    let affect = affect_explorer.unwrap_or(cfg.icon_affect_explorer);

    let key = store::normalize_key(&path);
    cfg.folder_icons.retain(|k, _| store::normalize_key(k) != key);
    if !icon.trim().is_empty() {
        cfg.folder_icons.insert(path.clone(), icon.clone());
    }

    // desktop.ini 是 Windows 资源管理器专属机制，其它平台只记在配置里（界面内仍生效）
    let mut warn: Option<String> = None;
    if affect && cfg!(windows) {
        if let Err(e) = sys::apply_icon(&path, &icon) {
            warn = Some(e);
        }
    }
    store::save_config(&dir, &cfg)?;
    if let Some(w) = warn {
        return Err(w);
    }
    Ok(snapshot(&dir, &cfg))
}

/// MCP 工具清单（工具名 + 说明 + 当前是否启用），供设置面板逐个开关。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_mcp_tools(
    app: AppHandle,
    state: State<'_, FpxState>,
) -> Result<Vec<model::McpToolRow>, String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    Ok(mcp::tool_rows(&cfg))
}

/// 自动备份状态（设置面板显示用）：是否运行中、间隔、上次执行时间。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_backup_auto_status(app: AppHandle) -> backup::AutoStatus {
    backup::auto_status(&app)
}

/// 按 config.backupAutoMinutes 启停定时备份。保存配置后调用，
/// 间隔改为 0 即停止；从 0 改为正数则拉起线程。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_backup_auto_sync(app: AppHandle) -> bool {
    let minutes = match store::resolve_data_dir(&app) {
        Ok(dir) => store::load_config(&dir).backup_auto_minutes,
        Err(_) => 0,
    };
    if minutes == 0 {
        backup::stop_auto();
        false
    } else {
        backup::start_auto(app)
    }
}

/// 列出数据目录 icons/ 下的图标文件。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_list_icons(app: AppHandle, state: State<'_, FpxState>) -> Result<Vec<String>, String> {
    let dir = store::data_dir(&app, &state)?;
    Ok(sys::list_icons(&dir))
}

/// 把图标文件读成 data URI，供沙箱里的前端 <img> 直接显示。
/// 数据目录是本地路径，iframe 内用 file:// 会被浏览器拦，只能这样传。
/// 内置图标不走这里（它们随插件发布，前端用相对 URL 直接取）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_icon_data(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() { return Err("图标文件不存在".into()); }
    // 限制体积：图标不该很大，防止误传大文件把整包数据塞进 IPC
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("图标文件超过 2MB，可能不是图标".into());
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    Ok(base64::data_uri(&bytes, ext))
}

/// 把前端 fetch 到的内置图标内容存进数据目录 icons/，返回落盘路径。
/// 内置图标随插件发布，若要"同步到资源管理器"（写 desktop.ini）就必须有真实文件，
/// 所以选用内置图标时会先固化一份到这里。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_save_icon_data(
    app: AppHandle,
    state: State<'_, FpxState>,
    name: String,
    data_base64: String,
) -> Result<String, String> {
    let dir = store::data_dir(&app, &state)?;
    let dest_dir = dir.join("icons");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    // 清洗文件名，防路径穿越与非法字符
    let safe: String = name.chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let safe = safe.trim().to_string();
    if safe.is_empty() { return Err("图标名为空".into()); }

    let path = dest_dir.join(format!("{safe}.ico"));
    let bytes = base64::decode(&data_base64)?;
    if bytes.len() > 2 * 1024 * 1024 { return Err("图标数据超过 2MB".into()); }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 屏幕取色（色盘吸管）。坐标省略时取当前鼠标位置。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_pick_color(x: Option<i32>, y: Option<i32>) -> Result<String, String> {
    sys::pick_screen_color(x, y)
}

/// 保存用户在色盘里维护的自定义常用色（整表替换，去重保序，上限 24）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_save_custom_colors(
    app: AppHandle,
    state: State<'_, FpxState>,
    colors: Vec<String>,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    core_save_custom_colors(&dir, colors)
}

/// 打开数据目录（方便备份 / 手工改配置）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_open_data_dir(app: AppHandle, state: State<'_, FpxState>) -> Result<(), String> {
    let dir = store::data_dir(&app, &state)?;
    sys::open_path(&dir.to_string_lossy(), "dir", "")
}

/* ---------------------------- 备份 ---------------------------- */

/// 一键备份项目 / 项目组到备份目录。
#[tauri::command(rename_all = "snake_case")]
pub async fn fpx_backup(
    app: AppHandle,
    state: State<'_, FpxState>,
    kind: String,
    target: Option<String>,
    append_only: Option<bool>,
) -> Result<backup::BackupResult, String> {
    let dir = store::data_dir(&app, &state)?;
    let mut cfg = store::load_config(&dir);
    if let Some(t) = target {
        let t = t.trim().to_string();
        cfg.backup_dir = if t.is_empty() { None } else { Some(t) };
        store::save_config(&dir, &cfg)?;
    }
    let ao = append_only.unwrap_or(cfg.backup_append_only);
    // 备份要整树遍历，可能持续数秒。同步命令跑在主线程会卡死窗口，
    // 所以挪到阻塞线程池（async_runtime::spawn_blocking）。
    let r = tauri::async_runtime::spawn_blocking(move || backup::run(&cfg, &dir, &kind, ao))
        .await
        .map_err(|e| format!("备份任务异常终止: {e}"))?;
    Ok(r)
}

/* ---------------------------- 编辑器 ---------------------------- */

/// 枚举系统里可用来打开 .md 的编辑器。
/// 要扫 PATH、探测固定安装位置，Windows 上还要跑 reg query，放到阻塞线程池。
///
/// 结果缓存进 config.editorPickCache：refresh=true 或缓存为空时才真扫，
/// 否则直接返回缓存（原版 editorPickCache 的用意）。
#[tauri::command(rename_all = "snake_case")]
pub async fn fpx_list_editors(
    app: AppHandle,
    state: State<'_, FpxState>,
    refresh: Option<bool>,
) -> Result<Vec<editor::EditorCandidate>, String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    let want_refresh = refresh.unwrap_or(false);

    if !want_refresh && !cfg.editor_pick_cache.is_empty() {
        return Ok(cfg.editor_pick_cache.iter()
            .map(|c| editor::EditorCandidate { name: c.name.clone(), exe: c.exe.clone() })
            .collect());
    }

    let r = tauri::async_runtime::spawn_blocking(editor::enumerate)
        .await
        .map_err(|e| format!("枚举编辑器异常终止: {e}"))?;

    // 缓存只存名称与 exe；exe 可能随后被卸载，但不影响——真正打开前会再校验存在性
    let mut cfg2 = cfg;
    cfg2.editor_pick_cache = r.iter()
        .map(|c| model::EditorPickCacheItem { name: c.name.clone(), exe: c.exe.clone() })
        .collect();
    store::save_config(&dir, &cfg2)?;
    Ok(r)
}

/// 选择「打开编辑」使用的编辑器（写入配置）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_set_editor(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    let mut cfg = store::load_config(&dir);
    let p = path.trim().to_string();
    cfg.edit_tool_path = if p.is_empty() { None } else { Some(p) };
    store::save_config(&dir, &cfg)?;
    Ok(snapshot(&dir, &cfg))
}

/// 用配置里的编辑器打开文件（未配置则退回系统默认打开方式）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_edit_file(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
) -> Result<(), String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    let target = if std::path::Path::new(&path).is_dir() {
        content::skill_md_of(&path).unwrap_or(path.clone())
    } else {
        path.clone()
    };
    let tool = cfg.edit_tool_path.clone().unwrap_or_default();
    if tool.trim().is_empty() {
        sys::open_path(&target, "auto", "")
    } else {
        sys::open_path(&target, "editor", tool.trim())
    }
}

/* ---------------------------- Agent 连锁 ---------------------------- */

/// 检测已安装的 AI 客户端（含用户手动添加的自定义客户端）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_chain_clients(app: AppHandle, state: State<'_, FpxState>) -> Vec<chain::ChainClient> {
    let dir = match store::data_dir(&app, &state) { Ok(d) => d, Err(_) => return chain::detect(&[]) };
    let cfg = store::load_config(&dir);
    chain::detect(&cfg.custom_chain_clients)
}

/// 跨类别移动卡片：项目 ⇄ 项目组（卡片换栏）。
/// 开启「移动文件夹」时先按目标类别默认根目录物理搬家；搬家失败则整体中止，
/// 避免出现"卡片换栏了但文件夹还在原处"的半完成状态。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_move_card_across(
    app: AppHandle,
    state: State<'_, FpxState>,
    from_kind: String,
    path: String,
    dst_kind: String,
    dst_tab_index: Option<usize>,
) -> Result<model::MoveAcrossResult, String> {
    if from_kind == dst_kind { return Err("源类别与目标类别相同".into()); }
    if from_kind != "project" && from_kind != "group" { return Err("源类别非法".into()); }
    if dst_kind != "project" && dst_kind != "group" { return Err("目标类别非法".into()); }

    let dir = store::data_dir(&app, &state)?;
    let mut cfg = store::load_config(&dir);

    // 物理搬家（可能返回"无需搬"= None）
    let relocated = if cfg.move_folder_on_cross_move {
        sys::relocate_cross_move(&cfg, &path, &dst_kind)?
    } else {
        None
    };
    let final_path = relocated.clone().unwrap_or_else(|| path.clone());

    // 卡片换栏：从源类别**全部**页签摘除（同一路径可能被登记在多个页签里），
    // 再插入目标类别页签末尾。两个分支分开写，避免同时对 cfg 的两个字段做可变借用。
    let idx = dst_tab_index.unwrap_or(0);
    if from_kind == "project" {
        sys::remove_card_from_tabs(&mut cfg.project_tabs, &path);
        sys::insert_card_into_tab(&mut cfg.group_tabs, idx, usize::MAX, &final_path);
    } else {
        sys::remove_card_from_tabs(&mut cfg.group_tabs, &path);
        sys::insert_card_into_tab(&mut cfg.project_tabs, idx, usize::MAX, &final_path);
    }

    store::save_config(&dir, &cfg)?;
    let snapshot = snapshot(&dir, &cfg);
    Ok(model::MoveAcrossResult { snapshot, relocated })
}

/// 保存用户手动添加的连锁客户端清单。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_save_chain_clients(
    app: AppHandle,
    state: State<'_, FpxState>,
    clients: Vec<model::CustomChainClient>,
) -> Result<Vec<chain::ChainClient>, String> {
    let dir = store::data_dir(&app, &state)?;
    let mut cfg = store::load_config(&dir);

    // 清洗：去空 id、id 去重、exe/scheme 至少留一个
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let list: Vec<model::CustomChainClient> = clients
        .into_iter()
        .filter_map(|mut c| {
            c.id = c.id.trim().to_string();
            c.name = c.name.trim().to_string();
            if c.id.is_empty() { return None; }
            if !seen.insert(c.id.clone()) { return None; }
            if c.exe.as_deref().map(str::trim).unwrap_or("").is_empty()
                && c.scheme.as_deref().map(str::trim).unwrap_or("").is_empty() { return None; }
            Some(c)
        })
        .collect();

    cfg.custom_chain_clients = list.clone();
    store::save_config(&dir, &cfg)?;
    Ok(chain::detect(&list))
}

/// 把指令发送给指定客户端；prompt 为空时用配置里的模板。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_chain_send(
    app: AppHandle,
    state: State<'_, FpxState>,
    client: String,
    directory: String,
    prompt: Option<String>,
) -> Result<chain::ChainSendResult, String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    let tpl = prompt.filter(|p| !p.trim().is_empty())
        .or_else(|| cfg.chain_prompt.clone())
        .unwrap_or_else(|| chain::default_prompt().to_string());
    let text = chain::fill_template(&tpl, &directory);
    Ok(chain::send(&client, &directory, &text, &cfg.custom_chain_clients))
}

/// 连锁动作清单（内置四项 + 自定义）。清单为空时自动生成内置项并落盘。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_chain_actions(
    app: AppHandle,
    state: State<'_, FpxState>,
) -> Result<Vec<model::ChainActionItem>, String> {
    let dir = store::data_dir(&app, &state)?;
    let mut cfg = store::load_config(&dir);
    let list = chain::ensure_actions(&mut cfg);
    // ensure_actions 可能补齐了内置项，落盘以免下次又补一遍
    store::save_config(&dir, &cfg)?;
    Ok(list)
}

/// 保存连锁动作清单（含增删改排序）。
/// 内置项只允许改模板/客户端/显隐/图标，不允许删除——删了下次又会被补回来，
/// 与其假装有删除不如直接不给这个入口。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_save_chain_actions(
    app: AppHandle,
    state: State<'_, FpxState>,
    actions: Vec<model::ChainActionItem>,
) -> Result<Vec<model::ChainActionItem>, String> {
    let dir = store::data_dir(&app, &state)?;
    let mut cfg = store::load_config(&dir);

    let mut list: Vec<model::ChainActionItem> = actions
        .into_iter()
        .filter(|a| !a.id.trim().is_empty())
        .collect();
    // id 去重：前端不会造重复，但手工改配置会，这里兜底
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    list.retain(|a| seen.insert(a.id.clone()));

    cfg.chain_actions = Some(list.clone());
    store::save_config(&dir, &cfg)?;
    Ok(list)
}

/// 按动作发送指令。kind: project | group。
/// prompt 传入则临时覆盖模板（用于发送前手工改动，不落盘）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_chain_send_action(
    app: AppHandle,
    state: State<'_, FpxState>,
    action_id: String,
    kind: String,
    path: String,
    prompt: Option<String>,
    client: Option<String>,
) -> Result<chain::ChainSendResult, String> {
    let dir = store::data_dir(&app, &state)?;
    let mut cfg = store::load_config(&dir);
    let list = chain::ensure_actions(&mut cfg);

    let item = chain::find(&list, &action_id)
        .ok_or_else(|| format!("找不到连锁动作：{action_id}"))?
        .clone();

    let dir_str = dir.to_string_lossy().to_string();
    let text = match prompt.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => chain::fill_all(p, &path, &dir_str),
        _ => chain::resolve_prompt(&item, &kind, &path, &dir_str),
    };

    if text.trim().is_empty() {
        return Err("该动作还没有指令模板，请先在设置里填写".into());
    }

    // 调用方显式指定时优先（发送面板里手选的）；否则按「动作专属 → 全局默认 → opencode」
    let client = match client.as_deref().map(str::trim) {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => chain::resolve_client(&cfg, &item),
    };
    Ok(chain::send(&client, &path, &text, &cfg.custom_chain_clients))
}

/* ---------------------------- 截图 ---------------------------- */

/// 截取屏幕，保存到数据目录 shots/ 下。
/// Windows 走 PowerShell，启动开销约 0.3~1 秒，故同样放到阻塞线程池。
#[tauri::command(rename_all = "snake_case")]
pub async fn fpx_capture_screen(
    app: AppHandle,
    state: State<'_, FpxState>,
) -> Result<screen::CaptureResult, String> {
    let dir = store::data_dir(&app, &state)?;
    let shots = dir.join("shots");
    let r = tauri::async_runtime::spawn_blocking(move || screen::capture(&shots))
        .await
        .map_err(|e| format!("截图任务异常终止: {e}"))?;
    Ok(r)
}

/* ---------------------------- 监听 / MCP ---------------------------- */

/// 启动受保护目录监听。
/// 注意：本插件跑在 iframe 沙箱，宿主禁用了 listenTauri，Rust 的 emit 到不了前端，
/// 所以变化先堆在后端队列里，由前端定期调 fpx_watch_poll 取走。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_watch_start(
    app: AppHandle,
    state: State<'_, FpxState>,
    interval_secs: Option<u64>,
) -> Result<bool, String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    let secs = interval_secs.unwrap_or(cfg.watch_interval_secs);
    let paths: Vec<String> = cfg.locks.iter().map(|l| l.path.clone()).collect();
    watch::start(app, secs, paths);
    Ok(watch::is_running())
}

#[tauri::command(rename_all = "snake_case")]
pub fn fpx_watch_stop() -> bool {
    watch::stop();
    !watch::is_running()
}

/// 取走累积的监听事件（取完即清空）。前端轮询调这个。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_watch_poll() -> Vec<watch::WatchEvent> {
    watch::pull()
}

/// 启动内置 MCP server，返回实际监听地址（port=0 由系统分配）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_mcp_start(app: AppHandle, port: Option<u16>) -> Result<String, String> {
    mcp::serve(app, port.unwrap_or(0))
}

#[tauri::command(rename_all = "snake_case")]
pub fn fpx_mcp_stop() -> bool {
    mcp::stop();
    !mcp::is_running()
}

#[tauri::command(rename_all = "snake_case")]
pub fn fpx_mcp_status() -> serde_json::Value {
    mcp::status()
}

/* ---------------------------- 预设图标 ---------------------------- */

/// 把某目录下的图标文件导入数据目录 icons/（用于接入原版 preseticons）。
#[tauri::command(rename_all = "snake_case")]
pub async fn fpx_import_icons(
    app: AppHandle,
    state: State<'_, FpxState>,
    from_dir: String,
) -> Result<Vec<String>, String> {
    let dir = store::data_dir(&app, &state)?;
    let src = std::path::PathBuf::from(&from_dir);
    if !src.is_dir() { return Err("源目录不存在".into()); }

    // 复制图标文件可能成百上千，放到阻塞线程池
    let dest = dir.join("icons");
    let n = tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let exts = ["ico", "png", "jpg", "jpeg", "svg", "bmp"];
        let mut count = 0usize;
        for entry in std::fs::read_dir(&src).map_err(|e| e.to_string())?.flatten() {
            let p = entry.path();
            if !p.is_file() { continue; }
            let ok = p.extension()
                .and_then(|e| e.to_str())
                .map(|e| exts.contains(&e.to_lowercase().as_str()))
                .unwrap_or(false);
            if !ok { continue; }
            if let Some(name) = p.file_name() {
                if std::fs::copy(&p, dest.join(name)).is_ok() { count += 1; }
            }
        }
        Ok(count)
    })
    .await
    .map_err(|e| format!("导入任务异常终止: {e}"))??;

    if n == 0 { return Err("该目录下没有可导入的图标文件（.ico/.png/.jpg/.svg/.bmp）".into()); }
    Ok(sys::list_icons(&dir))
}

/* ---------------------------- 内部工具 ---------------------------- */

/**
 * 临时摘锁守卫：受 ACL 保护的目录在写操作（建链 / 删链）前先解除保护，
 * 操作结束（含提前 return 的失败路径）自动按原档位恢复。
 * 对应 C# 版的 FolderLockService.WithUnlockForPath。
 */
struct LockGuard {
    path: String,
    deny_delete: bool,
    deny_write: bool,
}

impl LockGuard {
    fn new(path: &str, lock: Option<&model::LockItem>) -> Option<Self> {
        let l = lock?;
        if !l.deny_delete && !l.deny_write {
            return None;
        }
        let g = Self { path: path.to_string(), deny_delete: l.deny_delete, deny_write: l.deny_write };
        if let Err(e) = sys::apply_lock(&g.path, false, false) {
            eprintln!("[fpx] 临时摘锁失败（将按原状态尝试操作）: {e}");
        }
        Some(g)
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        if let Err(e) = sys::apply_lock(&self.path, self.deny_delete, self.deny_write) {
            eprintln!("[fpx] 恢复 ACL 保护失败: {e}");
        }
    }
}

fn upsert_record(records: &mut Vec<LinkRecord>, project: &str, group: &str, names: Vec<String>) {
    let key = store::normalize_key(project);
    let now = now_string();
    let group_name = std::path::Path::new(group)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if let Some(r) = records.iter_mut().find(|r| store::normalize_key(&r.project) == key) {
        r.lib = group.to_string();
        r.group = group_name;
        r.created = now;
        r.names = names;
    } else {
        records.push(LinkRecord {
            project: project.to_string(),
            lib: group.to_string(),
            group: group_name,
            created: now,
            names,
        });
    }
}

/// 当前时间 "yyyy-MM-dd HH:mm:ss"（UTC；不引第三方时间库，手动换算）。
pub(crate) fn now_string() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_time(secs)
}

/// 秒级时间戳（UTC）→ "yyyy-MM-dd HH:mm:ss"。与 now_string 共用一套换算。
pub(crate) fn format_time(secs: i64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 civil_from_days（days since 1970-01-01）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
