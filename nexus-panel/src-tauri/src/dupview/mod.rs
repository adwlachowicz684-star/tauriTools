//! 「试卷查重」插件的原生后端。
//!
//! 【这一层曾经是什么】
//! 早期版本是一个 python 服务（plugins/dupview/server/，2175 行），
//! 宿主负责拉起它、前端通过 http://127.0.0.1:8767 的 11 个路由访问。
//! 那套架构带进来一堆与"查重"无关的东西：端口占用、CSP 放行、
//! CORS 白名单、python 解释器定位、依赖分发（PyMuPDF/Pillow/pytesseract）。
//!
//! 【现在是什么】
//! 全部搬进 Rust：扫描、渲染、哈希、比对都在进程内完成，
//! 11 个 HTTP 路由换成 12 条 Tauri 命令。前端唯一的变化是
//! `fetch(API + ...)` → `ctx.invoke(...)`，图片从 HTTP 地址改成
//! 本地路径 + convertFileSrc（asset 协议）。
//!
//! 【返回形状为什么统一是 {ok, ...}】
//! 前端 index.html 是按 python 那套 JSON 写的，到处是 `if(!j.ok)`。
//! 这里沿用同一形状，前端只需要把 fetch 换成 invoke，不必重写判断逻辑。
//! 改动返回结构前先确认前端对应分支，否则会静默走进"失败"分支。

pub mod pdf;
pub mod scan;
pub mod sim;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// 面板数据目录下的插件子目录名
const DATA_SUBDIR: &str = "dupview";

/* ---------------------------------------------------------------------------
 * 数据模型
 * -------------------------------------------------------------------------*/

/// 一个文件条目（对应扫描产物 _work/map.json 里的一项）。
///
/// 字段名与前端 index.html 直接对应，改名必须同步改前端 ——
/// 前端有大量 `it.md5same` / `it.fam` / `it.img` 这样的直接引用。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    pub name: String,
    /// 稳定编号：取路径 MD5 前 8 位。
    /// 同一个文件在多次扫描间保持不变，缩略图与逐页图都挂在它下面。
    pub idx: String,
    pub subj: String,
    /// 撞名家族基底名（去空白、去 _2 这类副本后缀）
    pub fam: String,
    pub size: u64,
    #[serde(default)]
    pub md5: String,
    /// 字节级完全相同
    #[serde(default)]
    pub md5same: bool,
    /// 疑似（黄框）：撞名但内容不一致
    #[serde(default)]
    pub ylw: bool,
    /// 内容一致（红框）：文件名不同但内容相同
    #[serde(default)]
    pub csim: bool,
    #[serde(default)]
    pub deleted: bool,
    /// 首页缩略图的本地绝对路径（前端用 convertFileSrc 转 asset URL）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub img: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Root {
    pub path: String,
    #[serde(default)]
    pub name: String,
}

/// 扫描进度。前端靠轮询它画进度条，字段名与 python 版保持一致。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub running: bool,
    pub path: String,
    pub name: String,
    pub phase: String,
    pub done: u32,
    pub total: u32,
    pub msg: String,
    /// 本轮新登记的文件数（增量扫描时才有意义）
    pub added: u32,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub err: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full: Option<String>,
    #[serde(default)]
    pub done_subs: Vec<String>,
    pub kids: Vec<TreeNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<Item>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ListOut {
    pub subjects: Vec<String>,
    pub roots: Vec<TreeNode>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RootOut {
    pub name: String,
    pub path: String,
    /// 该根目录下已登记的文件数
    pub files: u32,
}

pub struct DupState {
    pub status: Arc<Mutex<ScanStatus>>,
    /// 取消标志：关掉插件时置位，扫描循环每处理一个文件查一次。
    pub cancel: Arc<Mutex<bool>>,
}

impl DupState {
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(ScanStatus::default())),
            cancel: Arc::new(Mutex::new(false)),
        }
    }
}

/* ---------------------------------------------------------------------------
 * 数据目录与缓存
 * -------------------------------------------------------------------------*/

/// 面板数据目录 <appDataDir>/dupview，并确保 _work / _imgs / _trash 存在。
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    let dir = base.join(DATA_SUBDIR);
    for sub in ["_work", "_imgs", "_trash"] {
        let p = dir.join(sub);
        std::fs::create_dir_all(&p).map_err(|e| format!("无法创建 {}: {e}", p.display()))?;
    }
    Ok(dir)
}

pub(crate) fn read_json<T: for<'de> Deserialize<'de> + Default>(p: &Path) -> T {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<T>(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn write_json<T: Serialize>(p: &Path, v: &T) -> Result<(), String> {
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }
    /* 先写 .tmp 再 rename：中途崩溃不会留下半个 JSON，
       否则下次启动读到一个截断文件，插件表现为"列表空白"且没有报错。 */
    let tmp = p.with_extension("json.tmp");
    let s = serde_json::to_string(v).map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(&tmp, s).map_err(|e| format!("写临时文件失败：{e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("落盘失败：{e}"))
}

/// 从 python 版遗留数据迁移一次（幂等，只在 _work/map.json 不存在时做）。
///
/// 为什么必须迁移而不是让用户重扫：本机这份数据里有 **2006 个文件条目
/// 和 2205 张已渲染好的缩略图**。重扫一遍要重新渲染几千页 ——
/// 而旧数据里除了 `img` 是相对路径、`idx` 是序号（不是路径 MD5），
/// 其余字段都能直接用。迁移只做这两件事的转换，缩略图原地复用。
///
/// 缩略图目录同名（都是 <data>/_imgs），所以不需要搬文件。
pub fn migrate_legacy(app: &AppHandle) -> Result<(), String> {
    let dir = data_dir(app)?;
    let new_map = dir.join("_work/map.json");
    if new_map.exists() {
        return Ok(());
    }
    let old_map = dir.join("dup_map.json");
    if !old_map.exists() {
        return Ok(());
    }
    let txt = std::fs::read_to_string(&old_map)
        .map_err(|e| format!("读旧索引失败：{e}"))?;
    let arr: Vec<serde_json::Value> = serde_json::from_str(&txt).unwrap_or_default();

    /* 已删除的文件：旧版单独记在一个 deleted 列表里，
       新版把删除状态并进条目（deleted:true），所以要在这里并回来。 */
    let deleted: Vec<String> = read_json::<Vec<serde_json::Value>>(&dir.join("deleted.json"))
        .into_iter()
        .filter_map(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| v["path"].as_str().map(|s| s.to_string()))
        })
        .collect();

    let mut items: Vec<Item> = Vec::new();
    for v in arr {
        let path = match v["path"].as_str() {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => continue,
        };
        let name = v["name"].as_str().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let idx = v["idx"].as_str().unwrap_or("").to_string();
        if idx.is_empty() {
            continue;
        }
        /* img 在旧数据里是 "_imgs/797.png" 这种相对路径 ——
           新版一律给绝对路径（前端直接用它调 convertFileSrc）。 */
        let img = v["img"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| dir.join(s).to_string_lossy().to_string());
        let fam = v["fam"].as_str().unwrap_or("").to_string();
        items.push(Item {
            fam: if fam.is_empty() {
                scan::family_of(&name)
            } else {
                fam
            },
            subj: v["subj"].as_str().unwrap_or("?").to_string(),
            /* 旧索引没有 size，MD5 分组又要靠它分桶，这里现取。
               文件不存在的（已删/移走）记 0，分桶时会被跳过。 */
            size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            md5same: v["md5same"].as_bool().unwrap_or(false),
            /* 旧版的 txtsame（文本一致）与新版 csim（内容一致）判据不同
               （一个是抽文本比、一个是像素比），但结论都是"同一份卷子"，
               沿用过来比重新算一遍划算得多。 */
            csim: v["txtsame"].as_bool().unwrap_or(false),
            ylw: v["sup"].as_bool().unwrap_or(false),
            deleted: deleted.iter().any(|d| *d == path),
            path,
            name,
            idx,
            md5: String::new(),
            img,
        });
    }
    write_json(&new_map, &items)?;

    /* roots / done 两个小文件直接搬：格式与新版一致。 */
    for f in ["roots.json", "done.json"] {
        let src = dir.join(f);
        let dst = dir.join("_work").join(f);
        if src.exists() && !dst.exists() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
    Ok(())
}

fn ok(extra: serde_json::Value) -> serde_json::Value {
    let mut m = serde_json::json!({"ok": true});
    if let (Some(a), Some(b)) = (m.as_object_mut(), extra.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
    m
}

fn err(msg: &str) -> serde_json::Value {
    serde_json::json!({"ok": false, "err": msg})
}

/* ---------------------------------------------------------------------------
 * 命令：根目录管理
 * -------------------------------------------------------------------------*/

#[tauri::command(rename_all = "snake_case")]
pub fn dupview_roots(app: AppHandle) -> serde_json::Value {
    if let Err(e) = migrate_legacy(&app) {
        return err(&e);
    }
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let roots: Vec<Root> = read_json(&dir.join("_work/roots.json"));
    let map: Vec<Item> = read_json(&dir.join("_work/map.json"));
    let mut out: Vec<RootOut> = Vec::new();
    for r in &roots {
        let n = map
            .iter()
            .filter(|it| {
                let d = match Path::new(&it.path).parent() {
                    Some(p) => p.to_string_lossy().to_string(),
                    None => return false,
                };
                d == r.path || d.starts_with(&format!("{}\\", r.path))
            })
            .count() as u32;
        out.push(RootOut {
            name: r.name.clone(),
            path: r.path.clone(),
            files: n,
        });
    }
    let st = app.state::<DupState>();
    let status = st.status.lock().unwrap().clone();
    ok(serde_json::json!({"roots": out, "status": status}))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dupview_addroot(app: AppHandle, path: String) -> serde_json::Value {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return err(&format!("目录不存在：{path}"));
    }
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let f = dir.join("_work/roots.json");
    let mut rs: Vec<Root> = read_json(&f);
    if rs.iter().any(|r| r.path == path) {
        /* 已存在：python 版这里也会顺手启动一次扫描，行为保持一致。 */
        return match scan::start(&app, vec![path]) {
            Ok(started) => ok(serde_json::json!({"started": started})),
            Err(e) => err(&e),
        };
    }
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    rs.push(Root { path: path.clone(), name });
    if let Err(e) = write_json(&f, &rs) {
        return err(&e);
    }
    match scan::start(&app, vec![path]) {
        Ok(started) => ok(serde_json::json!({"started": started})),
        Err(e) => err(&e),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dupview_delroot(app: AppHandle, path: String) -> serde_json::Value {
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let f = dir.join("_work/roots.json");
    let rs: Vec<Root> = read_json::<Vec<Root>>(&f)
        .into_iter()
        .filter(|r| r.path != path)
        .collect();
    match write_json(&f, &rs) {
        Ok(()) => ok(serde_json::json!({})),
        Err(e) => err(&e),
    }
}

/* ---------------------------------------------------------------------------
 * 命令：扫描
 * -------------------------------------------------------------------------*/

#[tauri::command(rename_all = "snake_case")]
pub fn dupview_scan_status(app: AppHandle) -> serde_json::Value {
    let st = app.state::<DupState>().status.lock().unwrap().clone();
    ok(serde_json::json!({"status": st}))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dupview_scan(app: AppHandle, path: String) -> serde_json::Value {
    match scan::start(&app, vec![path]) {
        Ok(started) => ok(serde_json::json!({"started": started})),
        Err(e) => err(&e),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dupview_scanall(app: AppHandle) -> serde_json::Value {
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let rs: Vec<Root> = read_json(&dir.join("_work/roots.json"));
    if rs.is_empty() {
        return err("还没有添加任何根目录");
    }
    match scan::start(&app, rs.into_iter().map(|r| r.path).collect()) {
        Ok(started) => ok(serde_json::json!({"started": started})),
        Err(e) => err(&e),
    }
}

/* ---------------------------------------------------------------------------
 * 命令：列表与逐页图
 * -------------------------------------------------------------------------*/

#[tauri::command(rename_all = "snake_case")]
pub fn dupview_list(app: AppHandle) -> Result<ListOut, String> {
    migrate_legacy(&app)?;
    scan::build_list(&app)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dupview_pages(app: AppHandle, path: String) -> serde_json::Value {
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let map: Vec<Item> = read_json(&dir.join("_work/map.json"));
    let it = match map.iter().find(|x| x.path == path) {
        Some(x) => x,
        None => return err("nofile"),
    };
    let p = Path::new(&it.path);
    if !p.exists() {
        return err("nofile");
    }
    let pdir = dir.join("_imgs").join(format!("{}_pages", it.idx));
    match pdf::page_images(p, 0, &pdir) {
        Ok(v) => ok(serde_json::json!({
            "name": it.name,
            "pages": v.iter().map(|x| x.to_string_lossy().to_string()).collect::<Vec<_>>(),
        })),
        Err(e) => err(&format!("渲染失败：{e}")),
    }
}

/* ---------------------------------------------------------------------------
 * 命令：处置（改名 / 删除 / 还原 / 标记完成）
 * -------------------------------------------------------------------------*/

/// 改名。返回新路径与新家族名 —— 家族名会随文件名变化
/// （`xxx_2.pdf` 改成 `xxx.pdf` 后，它就归到另一个撞名家族里）。
#[tauri::command(rename_all = "snake_case")]
pub fn dupview_rename(app: AppHandle, path: String, newname: String) -> serde_json::Value {
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let f = dir.join("_work/map.json");
    let mut map: Vec<Item> = read_json::<Vec<Item>>(&f);
    let (oldname, idx) = match map.iter().find(|x| x.path == path) {
        Some(it) => (it.name.clone(), it.idx.clone()),
        None => return err("文件不在扫描结果里"),
    };
    if newname.is_empty() || newname == oldname {
        return err("新文件名无效");
    }
    let src = Path::new(&path);
    let dst = match src.parent() {
        Some(p) => p.join(&newname),
        None => return err("无法定位所在目录"),
    };
    if dst.exists() {
        return err("目标文件名已存在");
    }
    if let Err(e) = std::fs::rename(src, &dst) {
        return err(&format!("改名失败：{e}"));
    }
    let newpath = dst.to_string_lossy().to_string();
    let fam = scan::family_of(&newname);
    if let Some(it) = map.iter_mut().find(|x| x.idx == idx) {
        it.path = newpath.clone();
        it.name = newname.clone();
        it.fam = fam.clone();
    }
    if let Err(e) = write_json(&f, &map) {
        return err(&e);
    }
    ok(serde_json::json!({"newname": newname, "newpath": newpath, "fam": fam}))
}

/// 删除 = 移到 <data>/_trash，**不真删**。
///
/// 这个插件的全部意义就是让人批量删重复卷子，而批量删除最容易误删。
/// 回收目录里的文件名带 idx 前缀，因此同名副本不会互相覆盖，
/// 还原时能精确定位回去。
#[tauri::command(rename_all = "snake_case")]
pub fn dupview_delete(app: AppHandle, path: String) -> serde_json::Value {
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let f = dir.join("_work/map.json");
    let mut map: Vec<Item> = read_json::<Vec<Item>>(&f);
    let (idx, name) = match map.iter().find(|x| x.path == path) {
        Some(it) => (it.idx.clone(), it.name.clone()),
        None => return err("文件不在扫描结果里"),
    };
    let src = Path::new(&path);
    if !src.exists() {
        return err("文件已不存在");
    }
    let dst = dir.join("_trash").join(format!("{}_{}", idx, name));
    if let Err(e) = std::fs::rename(src, &dst) {
        return err(&format!("移入回收目录失败：{e}"));
    }
    if let Some(it) = map.iter_mut().find(|x| x.idx == idx) {
        it.deleted = true;
    }
    if let Err(e) = write_json(&f, &map) {
        return err(&e);
    }
    ok(serde_json::json!({}))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dupview_restore(app: AppHandle, path: String) -> serde_json::Value {
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let f = dir.join("_work/map.json");
    let mut map: Vec<Item> = read_json::<Vec<Item>>(&f);
    let (idx, name) = match map.iter().find(|x| x.path == path) {
        Some(it) => (it.idx.clone(), it.name.clone()),
        None => return err("文件不在扫描结果里"),
    };
    let src = dir.join("_trash").join(format!("{}_{}", idx, name));
    if !src.exists() {
        return err("回收目录里找不到该文件");
    }
    if let Err(e) = std::fs::rename(&src, Path::new(&path)) {
        return err(&format!("还原失败：{e}"));
    }
    if let Some(it) = map.iter_mut().find(|x| x.idx == idx) {
        it.deleted = false;
    }
    if let Err(e) = write_json(&f, &map) {
        return err(&e);
    }
    ok(serde_json::json!({}))
}

/// 标记"这个目录下的这个学科已处理完"。纯状态，不动文件。
#[tauri::command(rename_all = "snake_case")]
pub fn dupview_dir_done(app: AppHandle, dir: String, subj: String) -> serde_json::Value {
    let d = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let f = d.join("_work/done.json");
    let mut m: Vec<String> = read_json(&f);
    let key = format!("{}|{}", dir, subj);
    /* 取反而不是收一个 on 参数：前端那个按钮就是"已解决/未解决"来回切，
       让它自己传状态等于把状态存两份，两边迟早对不上。 */
    let on = if m.contains(&key) {
        m.retain(|x| x != &key);
        false
    } else {
        m.push(key);
        true
    };
    match write_json(&f, &m) {
        Ok(()) => ok(serde_json::json!({"done": on})),
        Err(e) => err(&e),
    }
}

/// 打开目录选择对话框。
///
/// 走 PowerShell + Windows Forms，与 fpx_pick_color 同一套路：
/// 项目刻意不引 windows-sys（句柄类型在各版本间是 isize 或 *mut c_void，
/// 猜错就是硬编译错误），而选目录是低频操作，多花几百毫秒启动 PowerShell
/// 完全可以接受。代价是只在 Windows 上可用 —— 本项目当前就是纯 Windows。
#[tauri::command(rename_all = "snake_case")]
pub fn dupview_browse() -> serde_json::Value {
    let out = match std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-STA",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; \
             $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
             $d.Description = '选择试卷根目录'; \
             if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }",
        ])
        .output()
    {
        Ok(o) => o,
        Err(e) => return err(&format!("无法启动 PowerShell：{e}")),
    };
    /* -STA 是必需的：FolderBrowserDialog 是 COM 组件，
       默认的多线程套间下 ShowDialog 会直接抛异常。 */
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        /* 前端对 err==='cancel' 有单独的文案，不要报成失败。 */
        err("cancel")
    } else {
        ok(serde_json::json!({"path": s}))
    }
}

/// 取消正在跑的扫描。插件关闭时调用，避免后台线程继续渲染几百份卷子。
pub fn request_cancel(app: &AppHandle) {
    if let Some(st) = app.try_state::<DupState>() {
        *st.cancel.lock().unwrap() = true;
    }
}
