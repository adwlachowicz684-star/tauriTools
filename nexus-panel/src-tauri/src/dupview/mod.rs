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

pub mod docx;
pub mod pack;
pub mod pdf;
pub mod rename;
pub mod scan;
pub mod sim;

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
/// 【字段名为什么必须和旧版 python 一模一样】
/// 前端的 index.html 是**网页版与原生版共用同一份**：它读的是旧版 python 数据的
/// 字段名（`dim` 已删除、`txtsame` 内容一致、`pages` 页数）。所以这里不能用
/// Rust 风格的命名（`deleted` / `csim`）—— 一旦改错，前端不会报错，
/// 只会静默走进"没有这个字段"的分支：卡片不置灰、按钮不变「恢复」、
/// 页数显示成 undefined。改字段名前先在前端搜一遍。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    pub name: String,
    /// 稳定编号：取路径 MD5 前 8 位。
    /// 同一个文件在多次扫描间保持不变，缩略图与逐页图都挂在它下面。
    pub idx: String,
    pub subj: String,
    /// 计划目标名 —— 由改名规则引擎（rename.rs）算出，不是"原名去掉 _2"。
    pub fam: String,
    pub size: u64,
    /// 页数。docx 按转换后的 PDF 算。
    #[serde(default)]
    pub pages: u32,
    #[serde(default)]
    pub md5: String,
    /// 字节级完全相同
    #[serde(default)]
    pub md5same: bool,
    /// 疑似（黄框）：撞名但内容不一致
    #[serde(default)]
    pub ylw: bool,
    /// 内容一致（红框）：文件名不同但内容相同。
    /// 字段名是 `txtsame` 而不是 `csim` —— 见结构体上方的说明。
    #[serde(default)]
    pub txtsame: bool,
    /// 已删除（卡片置暗、按钮变「恢复」）。字段名是 `dim`，同上。
    #[serde(default)]
    pub dim: bool,
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

/// 从 python 版遗留数据导入一次（幂等）。
///
/// 【为什么必须导入，而不是让用户重扫】
/// 本机这份数据里有 **2006 个文件条目、2205 张已渲染好的缩略图、
/// 737 份转好的 docx→PDF**。重扫一遍要重新渲染几千页、重转几百份 docx。
/// 所以首次运行时把旧数据读一次、写进插件自有的格式，之后不再碰它们。
///
/// 【运行期为什么是闭环的】
/// 两份导入各自带"已就位就跳过"的判断：条目看 `_work/map.json` 在不在，
/// docx 缓存看每个 docx 自己的新编号缓存是否已就位。都就位之后，插件只读写
/// `_work/`、`_imgs/`、`_docx_pdf/`、`_trash/` 这些自有目录，不再打开任何旧文件。
///
/// 由 `dupview_roots` / `dupview_list` 在每次打开插件时调用；导入完成后
/// 它就是几次 `is_file()`，可以放心反复调用。
pub fn migrate_legacy(app: &AppHandle) -> Result<(), String> {
    let dir = data_dir(app)?;
    migrate_map(app)?;
    migrate_docx_cache(&dir);
    Ok(())
}

/// 旧索引 `dup_map.json` → 插件自有的 `_work/map.json`。已有 map.json 就跳过。
///
/// 旧数据里除了 `img` 是相对路径、`idx` 是序号（不是路径 MD5），其余字段都能直接用，
/// 所以这里只做这两件事的转换；缩略图目录同名（都是 <data>/_imgs），原地复用不搬文件。
fn migrate_map(app: &AppHandle) -> Result<(), String> {
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
        items.push(Item {
            /* fam 先沿用旧数据里的值，下面 refresh_plan 会按改名规则统一重算
               （规则要看整棵树才能定模次/卷别，逐条算不出来）。 */
            fam: v["fam"].as_str().unwrap_or("").to_string(),
            subj: v["subj"].as_str().unwrap_or("?").to_string(),
            /* 旧索引没有 size，MD5 分组又要靠它分桶，这里现取。
               文件不存在的（已删/移走）记 0，分桶时会被跳过。 */
            size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            pages: v["pages"].as_u64().unwrap_or(0) as u32,
            md5same: v["md5same"].as_bool().unwrap_or(false),
            /* 旧版的 txtsame（文本一致）与新版的内容一致判据不同
               （一个是抽文本比、一个是像素比），但结论都是"同一份卷子"，
               沿用过来比重新算一遍划算得多。 */
            txtsame: v["txtsame"].as_bool().unwrap_or(false),
            ylw: v["ylw"].as_bool().unwrap_or(false),
            dim: deleted.iter().any(|d| *d == path),
            path,
            name,
            idx,
            md5: String::new(),
            img,
        });
    }

    /* roots / done 两个小文件先搬：refresh_plan 要靠 roots.json 才知道该在
       哪些树上跑规则，顺序反了它会以为"还没有根目录"而直接返回。 */
    for f in ["roots.json", "done.json"] {
        let src = dir.join(f);
        let dst = dir.join("_work").join(f);
        if src.exists() && !dst.exists() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
    let _ = refresh_plan(app, &mut items);
    write_json(&new_map, &items)?;
    Ok(())
}

/// 旧版按序号命名的 docx→PDF 缓存，一次性挂到新版编号名下。
///
/// 【为什么需要它】
/// 旧版 idx 是序号（797、798…），新版是路径 MD5 前 8 位，缓存文件名对不上；
/// 而 `_docx_pdf` 里那 737 份转好的 PDF 是实打实的成果，重转要几十分钟。
/// 这里按旧索引 `dup_map.json` 查出 path→序号，给每份缓存补一个新编号名字。
///
/// 【为什么用硬链接】
/// 同目录同卷，硬链接零拷贝零耗时，旧文件以后被清掉也不影响新版；
/// 文件系统不支持硬链接时回落到复制（851MB 的一份拷贝，能接受）。
///
/// 【它为什么会自己退休】
/// 先看 `_work/map.json` 里还有哪些 docx 缺新编号缓存；一个都不缺就直接返回，
/// 连 `dup_map.json` 都不会打开。所以旧索引只在真正缺缓存时才被读到 ——
/// 全部补齐后，运行期就再也碰不到它。
fn migrate_docx_cache(dir: &Path) {
    let map: Vec<Item> = read_json(&dir.join("_work/map.json"));
    let pending: Vec<&Item> = map
        .iter()
        .filter(|it| {
            it.path.to_ascii_lowercase().ends_with(".docx")
                && !docx::cache_path(dir, &it.idx).is_file()
        })
        .collect();
    if pending.is_empty() {
        return;
    }
    let old: Vec<serde_json::Value> = read_json(&dir.join("dup_map.json"));
    if old.is_empty() {
        return;
    }
    let seq: HashMap<String, String> = old
        .iter()
        .filter_map(|v| Some((v["path"].as_str()?.to_string(), v["idx"].as_str()?.to_string())))
        .collect();
    for it in pending {
        let Some(s) = seq.get(&it.path) else { continue };
        let src = docx::cache_path(dir, s);
        if !src.is_file() {
            continue;
        }
        let dst = docx::cache_path(dir, &it.idx);
        if let Some(p) = dst.parent() {
            if std::fs::create_dir_all(p).is_err() {
                continue;
            }
        }
        /* 硬链接失败就复制；两者都失败只影响这一个文件（扫描时现场重转）。 */
        if std::fs::hard_link(&src, &dst).is_err() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
}

/* ---------------------------------------------------------------------------
 * 改名计划（计划目标名的唯一来源）
 * -------------------------------------------------------------------------*/

/// 用改名规则重算全部条目的「计划目标名」，并把计划落盘到 `_work/dup_families.json`。
///
/// 【为什么是全量重算，而不是像旧版那样只追加】
/// 旧版只给**新文件**追加计划行、其余行一律沿用，于是同一个目录里
/// "离线引擎算过的行"和"扫描器追加的行"两套口径混在一起 ——
/// 后者只是"原名去掉 _2"，卡片上的目标名因此一半对一半不对。
/// 这里改成每次都按同一套规则把整棵树重算一遍，两边不会再分叉。
///
/// 【手工改过名的行例外】
/// 那类行带着 pin 标记（见 `rename::rename_in_plan`）：名字是人为定的终稿，
/// 不该被规则再改一遍，重算时原样搬过来。
///
/// 只在扫描 / 迁移 / 改名之后调用。列表接口直接读 map.json 里回填好的 fam，
/// 免得每次打开面板都重走一遍全树解析。
pub(crate) fn refresh_plan(app: &AppHandle, items: &mut [Item]) -> Result<(), String> {
    let dir = data_dir(app)?;
    let roots: Vec<Root> = read_json(&dir.join("_work/roots.json"));
    if roots.is_empty() {
        return Ok(());
    }
    let pairs: Vec<(String, String)> = roots
        .iter()
        .map(|r| (r.name.clone(), r.path.clone()))
        .collect();

    /* 只要有一个根目录当前不可访问（盘没挂上），算出来的就是一份残缺计划 ——
       写回去会把那一整棵树的目标名抹掉，所以这一轮只算不落盘。 */
    if !pairs.iter().all(|(_, p)| Path::new(p).is_dir()) {
        return Ok(());
    }

    let mut plan = rename::build_plan(&pairs);
    let pp = rename::plan_path(&dir);
    let prev: rename::PlanFile = read_json(&pp);
    rename::carry_pins(&mut plan, &prev);

    /* 先把 fam 回填进内存条目，再落盘计划 —— 顺序反过来的话，一旦计划文件
       写不进去（被别的进程占着），已经算好的目标名就跟着一起丢了。 */
    let base_map = plan.base_map();
    for it in items.iter_mut() {
        /* 计划里没有的（已删除、`_疑似错卷`、根目录外的）保持原值 ——
           删除过的文件在磁盘上已经看不见了，规则算不出它的目标名，
           但卡片上原来那行名字得留着。 */
        if let Some(b) = base_map.get(&it.path) {
            it.fam = b.clone();
        }
    }

    /* 第一次覆盖前留个底：那份文件是离线管线攒了很久的成果（797 行规则名），
       被重算覆盖后想回退就只剩它了。只留一份，不反复备份。 */
    let bak = pp.with_extension("json.bak_before_native");
    if pp.exists() && !bak.exists() {
        let _ = std::fs::copy(&pp, &bak);
    }
    write_json(&pp, &plan)?;
    Ok(())
}

/// 渲染 / 比对时实际要打开的文件：docx 走转换后的 PDF 缓存，其余就是它自己。
pub(crate) fn src_path(dir: &Path, it: &Item) -> PathBuf {
    if it.path.to_ascii_lowercase().ends_with(".docx") {
        docx::pdf_cache(dir, &it.idx, &it.path)
            .unwrap_or_else(|| PathBuf::from(&it.path))
    } else {
        PathBuf::from(&it.path)
    }
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

/// 逐页图要打开的文件 + 该文件的缓存目录。
///
/// 【为什么不查 map.json】
/// 逐页取图会被连续调用几十次（一份卷子一页一次），每次都解析一遍
/// 1.5MB 的索引纯属浪费。`idx` 由前端从列表数据里带过来 ——
/// 它就是 map.json 里那一项的值，权威且零成本。
///
/// 【已删除的文件从哪取】
/// 删除 = 移进 `<data>/_trash/<idx>_<name>`（见 dupview_delete），条目仍留在
/// 列表里、原路径已经空了。所以原路径不存在时回落到回收目录，让"已删除"的
/// 卡片照样能预览。回收文件名带 idx 前缀，同名副本不会互相覆盖，
/// 按同一个 idx 就能精确定位 —— 与 dupview_restore 用的是同一套命名。
fn page_target(dir: &Path, path: &str, idx: &str) -> PathBuf {
    let src = if Path::new(path).exists() {
        PathBuf::from(path)
    } else {
        let name = Path::new(path)
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let t = dir.join("_trash").join(format!("{}_{}", idx, name));
        if t.exists() {
            t
        } else {
            PathBuf::from(path)
        }
    };
    /* docx 要打开的是转换后的 PDF（pdf_cache 负责转换/取缓存），
       直接开 docx 会让 pdfium 报错，前端表现为"逐页图加载失败"。
       缓存按 idx 命名，与源文件是否已被移进回收目录无关，命中即复用。 */
    if src.to_string_lossy().to_ascii_lowercase().ends_with(".docx") {
        let s = src.to_string_lossy().to_string();
        docx::pdf_cache(dir, idx, &s).unwrap_or(src)
    } else {
        src
    }
}

/// `idx` 会被拼进缓存路径，所以只收 8 位十六进制 ——
/// 前端传什么都改不了它指向的目录，`..` 之类进不来。
fn safe_idx(idx: &str) -> Option<&str> {
    (idx.len() == 8 && idx.bytes().all(|b| b.is_ascii_hexdigit())).then_some(idx)
}

/// 逐页图的页数。只读一次 PDF 头，不做任何渲染 ——
/// 前端拿到它就能立刻把缩略条的格子摆出来，再逐页填图。
#[tauri::command(async, rename_all = "snake_case")]
pub fn dupview_pageinfo(app: AppHandle, path: String, idx: String) -> serde_json::Value {
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let Some(idx) = safe_idx(&idx) else {
        return err("badidx");
    };
    let p = page_target(&dir, &path, idx);
    if !p.exists() {
        return err("nofile");
    }
    match pdf::page_count(&p) {
        Ok(n) => ok(serde_json::json!({"n": n})),
        Err(e) => err(&format!("渲染失败：{e}")),
    }
}

/// 取某一页的图。`size` = `"t"` 缩略（160px，填缩略条）/ `"f"` 大图（1000px）。
///
/// 一页一次：前端拿到页数后逐页来取，第一格几十毫秒就出来。
#[tauri::command(async, rename_all = "snake_case")]
pub fn dupview_page(
    app: AppHandle,
    path: String,
    idx: String,
    index: usize,
    size: String,
) -> serde_json::Value {
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    let Some(idx) = safe_idx(&idx) else {
        return err("badidx");
    };
    let p = page_target(&dir, &path, idx);
    if !p.exists() {
        return err("nofile");
    }
    let sz = if size == "f" {
        pdf::PageSize::F
    } else {
        pdf::PageSize::T
    };
    let pdir = dir.join("_imgs").join(format!("{idx}_pages"));
    match pdf::page_image(&p, index, &pdir, sz) {
        Ok(fp) => ok(serde_json::json!({"url": fp.to_string_lossy()})),
        Err(e) => err(&format!("渲染失败：{e}")),
    }
}

/* ---------------------------------------------------------------------------
 * 命令：处置（改名 / 删除 / 还原 / 标记完成）
 * -------------------------------------------------------------------------*/

/// 改名。返回新路径、新编号与新家族名 —— 家族名会随文件名变化
/// （`xxx_2.pdf` 改成 `xxx.pdf` 后，它就归到另一个撞名家族里）。
///
/// 【为什么必须连带搬缓存】
/// 缓存（缩略图 / 逐页图 / docx→PDF）都以 `idx`（路径 MD5）命名，改名后路径变、
/// idx 跟着变。不搬的话旧缓存成孤儿、新 idx 下什么都没有 ——
/// 表现是"改完名卡片变白图、docx 要重转"。所以改名成功就立刻 `migrate_idx_cache`。
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
    if let Err(e) = std::fs::rename(docx::lp(src), docx::lp(&dst)) {
        return err(&format!("改名失败：{e}"));
    }
    let newpath = dst.to_string_lossy().to_string();
    let new_idx = scan::idx_of(&newpath);
    migrate_idx_cache(&dir, &idx, &new_idx);

    /* 计划文件要跟着改名走（旧版 rename_in_plan 的同一套语义）：
       该行的 old/new/base/path 一起更新、从旧家族移入新基底家族，
       否则"卡片上的目标名"与"磁盘上的文件名"会分叉。
       顺带把这一行钉住（pin）—— 名字是人为定的终稿，
       下次扫描全量重算计划时不该被规则改写。 */
    let pp = rename::plan_path(&dir);
    let mut plan: rename::PlanFile = read_json(&pp);
    rename::rename_in_plan(&mut plan, &path, &newpath, &newname);
    if let Err(e) = write_json(&pp, &plan) {
        return err(&e);
    }

    let fam = rename::base_of(&newname);
    if let Some(it) = map.iter_mut().find(|x| x.idx == idx) {
        it.path = newpath.clone();
        it.name = newname.clone();
        it.idx = new_idx.clone();
        it.fam = fam.clone();
        /* img 也要指向新编号下的缩略图，否则卡片是白图。 */
        if it.img.is_some() {
            let p = dir.join("_imgs").join(format!("{new_idx}.png"));
            it.img = p.is_file().then(|| p.to_string_lossy().to_string());
        }
    }
    if let Err(e) = write_json(&f, &map) {
        return err(&e);
    }
    ok(serde_json::json!({"newname": newname, "newpath": newpath, "idx": new_idx, "fam": fam}))
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
        it.dim = true;
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
        it.dim = false;
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

/* ---------------------------------------------------------------------------
 * 命令：文件树右键菜单（批量已解决 / 批量改名 / 打包 ZIP）
 * -------------------------------------------------------------------------*/

/// 归一化目录路径，**仅用于比较**（不做真实路径解析）。
///
/// 【为什么必须归一化】
/// 前端的 `full` 是"根路径 + 段名"拼出来的（`format!("{}\\{}", …)`），
/// 根路径若以 `\` 结尾就会拼出重复分隔符；而计划里的 path 来自 `read_dir`，
/// 是规范形态。直接比字符串会把同一个目录判成两个，改名就成了"找不到文件"。
/// 统一成"小写 + 单反斜杠 + 去尾分隔符"后比较，Windows 的大小写不敏感也一并覆盖。
pub(crate) fn norm_dir(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    let mut prev_sep = false;
    for c in p.chars() {
        if c == '\\' || c == '/' {
            if prev_sep {
                continue;
            }
            prev_sep = true;
            out.push('\\');
        } else {
            prev_sep = false;
            out.extend(c.to_lowercase());
        }
    }
    while out.ends_with('\\') {
        out.pop();
    }
    out
}

/// 把某个 idx 名下的三处缓存挂到新 idx 名下：首页缩略图、逐页图目录、docx→PDF。
///
/// 改名后路径变、idx 跟着变（idx = 路径 MD5），不搬就全成孤儿 ——
/// 表现是"改完名缩略图没了、docx 要重转"。
fn migrate_idx_cache(dir: &Path, old_idx: &str, new_idx: &str) {
    if old_idx == new_idx || old_idx.is_empty() {
        return;
    }
    let img = dir.join("_imgs");
    move_path(
        &img.join(format!("{old_idx}.png")),
        &img.join(format!("{new_idx}.png")),
    );
    move_path(
        &img.join(format!("{old_idx}_pages")),
        &img.join(format!("{new_idx}_pages")),
    );
    let dx = dir.join("_docx_pdf");
    move_path(
        &dx.join(format!("{old_idx}.pdf")),
        &dx.join(format!("{new_idx}.pdf")),
    );
}

/// 移动一个文件或目录：`rename` 优先（同卷零拷贝），失败再试硬链接 + 删源、
/// 复制 + 删源。
///
/// 目录只有 `rename` 一条路（硬链接与复制都不支持目录），失败就放着不动 ——
/// 顶多这份缓存要重渲，不影响改名本身。目标已存在时不动，避免覆盖已有的新缓存。
fn move_path(src: &Path, dst: &Path) {
    if !src.exists() || dst.exists() {
        return;
    }
    if let Some(p) = dst.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    if std::fs::rename(docx::lp(src), docx::lp(dst)).is_ok() {
        return;
    }
    if src.is_dir() {
        return;
    }
    if std::fs::hard_link(src, dst).is_ok() {
        let _ = std::fs::remove_file(src);
        return;
    }
    if std::fs::copy(src, dst).is_ok() {
        let _ = std::fs::remove_file(src);
    }
}

/// 一条待改名记录。
struct RenAction {
    old_path: PathBuf,
    new_path: PathBuf,
    old_name: String,
    new_name: String,
    /// 旧编号（路径 MD5），迁移缓存用。
    old_idx: String,
    /// 计划里的相对目录（根目录下直接放的文件为 "."），仅用于预览分组。
    rel: String,
}

/// 从改名计划里筛出目标目录下"当前名与计划目标名不同"的行。
///
/// `dir` 是**绝对目录路径**（前端树节点带过来的 `full`）；`recursive` 决定是否下探子目录。
/// 计划里没有的行（说明类文件、`_疑似错卷`、根目录外的）不参与 —— 那些本来就不该改名；
/// 磁盘上已不存在的行（已删除）也跳过，免得报一堆"找不到文件"。
fn plan_actions(data: &Path, dir: &str, recursive: bool) -> Vec<RenAction> {
    let plan: rename::PlanFile = read_json(&rename::plan_path(data));
    let want = norm_dir(dir);
    let prefix = format!("{}\\", want);
    let mut out = Vec::new();
    for row in &plan.rows {
        if row.old == row.new {
            continue;
        }
        let p = Path::new(&row.path);
        let parent = match p.parent() {
            Some(x) => x,
            None => continue,
        };
        let in_scope = if recursive {
            let full = norm_dir(&row.path);
            full == want || full.starts_with(&prefix)
        } else {
            norm_dir(&parent.to_string_lossy()) == want
        };
        if !in_scope || !p.is_file() {
            continue;
        }
        out.push(RenAction {
            old_path: p.to_path_buf(),
            new_path: parent.join(&row.new),
            old_name: row.old.clone(),
            new_name: row.new.clone(),
            old_idx: scan::idx_of(&row.path),
            rel: row.dir.clone(),
        });
    }
    /* 稳定顺序：预览列表按（相对目录, 新名）排，反复打开不会跳。 */
    out.sort_by(|a, b| (&a.rel, &a.new_name).cmp(&(&b.rel, &b.new_name)));
    out
}

/// 目标被占判定 —— 预览与执行**共用同一判据**，避免"预览说能改、执行却跳过"。
///
/// 两种冲突：
///   ① `dup`      —— 计划内部撞车：两条不同来源的文件算出同一个目标路径
///                   （dedup 理论上已排除，仍兜底）；
///   ② `occupied` —— 目标名已在磁盘上存在，且那份文件**不参与**本轮改名。
///                   参与改名的会先被挪到临时名（见 exec 的两阶段），不算冲突。
fn collide_of(
    a: &RenAction,
    target_cnt: &HashMap<String, u32>,
    old_set: &HashSet<String>,
) -> (bool, &'static str) {
    let tkey = norm_dir(&a.new_path.to_string_lossy());
    if target_cnt.get(&tkey).copied().unwrap_or(0) > 1 {
        return (true, "dup");
    }
    if a.new_path.exists() && !old_set.contains(&tkey) {
        return (true, "occupied");
    }
    (false, "")
}

/// 批量设置「已解决」：右键菜单一次把某目录下所有学科标成已解决 / 取消。
///
/// `keys` 是 `目录|学科`（与 done.json 同格式），由前端从树节点下的文件汇总而来 ——
/// 前端本来就有这份数据（DONEMAP 就按这个格式读写），不必在后端再扫一遍 map.json。
#[tauri::command(rename_all = "snake_case")]
pub fn dupview_done_set(app: AppHandle, keys: Vec<String>, on: bool) -> serde_json::Value {
    let d = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    if keys.is_empty() {
        return ok(serde_json::json!({"changed": 0}));
    }
    let f = d.join("_work/done.json");
    let mut m: Vec<String> = read_json(&f);
    let changed;
    if on {
        let mut n = 0u32;
        for k in &keys {
            if !m.contains(k) {
                m.push(k.clone());
                n += 1;
            }
        }
        changed = n;
    } else {
        let before = m.len();
        m.retain(|x| !keys.contains(x));
        changed = (before - m.len()) as u32;
    }
    match write_json(&f, &m) {
        Ok(()) => ok(serde_json::json!({"changed": changed})),
        Err(e) => err(&e),
    }
}

/// 批量改名的预览：列出"要改成什么"，并标出会冲突的项。
///
/// 执行前先看一遍是必要的 —— 批量改名一次动几十上百个文件，改完再想找回来很麻烦。
/// 前端据此弹预览窗，冲突项加描边突出。
#[tauri::command(async, rename_all = "snake_case")]
pub fn dupview_rename_preview(app: AppHandle, path: String, recursive: bool) -> serde_json::Value {
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    if !Path::new(&path).is_dir() {
        return err("目录不存在");
    }
    let acts = plan_actions(&dir, &path, recursive);
    let old_set: HashSet<String> = acts
        .iter()
        .map(|a| norm_dir(&a.old_path.to_string_lossy()))
        .collect();
    let mut target_cnt: HashMap<String, u32> = HashMap::new();
    for a in &acts {
        *target_cnt
            .entry(norm_dir(&a.new_path.to_string_lossy()))
            .or_insert(0) += 1;
    }
    let mut rows = Vec::with_capacity(acts.len());
    let mut collide = 0u32;
    for a in &acts {
        let (c, why) = collide_of(a, &target_cnt, &old_set);
        if c {
            collide += 1;
        }
        rows.push(serde_json::json!({
            "old": a.old_name,
            "new": a.new_name,
            "path": a.old_path.to_string_lossy(),
            "dir": a.rel,
            "collide": c,
            "why": why,
        }));
    }
    ok(serde_json::json!({"rows": rows, "total": rows.len(), "collide": collide}))
}

/// 批量改名：把目录下（可选含子目录）的文件改成计划目标名。
///
/// 【两阶段改名】
/// 直接逐个改会踩到"甲的目标名正是乙的当前名"：先改甲会因为乙还占着而失败，
/// 甲乙互换时更是谁都改不动。所以先把待改文件全部挪到唯一临时名，
/// 再从临时名落到最终名 —— 任何顺序都不会撞。
///
/// 冲突项（目标被计划外文件占着）**跳过不改**，判据与预览一致，
/// 在返回里报出条数，由用户自行处理。
#[tauri::command(async, rename_all = "snake_case")]
pub fn dupview_rename_all(app: AppHandle, path: String, recursive: bool) -> serde_json::Value {
    let dir = match data_dir(&app) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    if !Path::new(&path).is_dir() {
        return err("目录不存在");
    }
    let acts = plan_actions(&dir, &path, recursive);
    if acts.is_empty() {
        return ok(serde_json::json!({"renamed": 0, "skipped": 0, "errs": []}));
    }
    let old_set: HashSet<String> = acts
        .iter()
        .map(|a| norm_dir(&a.old_path.to_string_lossy()))
        .collect();
    let mut target_cnt: HashMap<String, u32> = HashMap::new();
    for a in &acts {
        *target_cnt
            .entry(norm_dir(&a.new_path.to_string_lossy()))
            .or_insert(0) += 1;
    }

    let mut todo: Vec<usize> = Vec::new();
    let mut skipped = 0u32;
    for (i, a) in acts.iter().enumerate() {
        if collide_of(a, &target_cnt, &old_set).0 {
            skipped += 1;
            continue;
        }
        todo.push(i);
    }

    /* 第一阶段：全部挪到临时名。临时名带下标，同一目录内也不会互相撞。 */
    let mut errs: Vec<String> = Vec::new();
    let mut staged: Vec<(PathBuf, usize)> = Vec::new();
    for &i in &todo {
        let a = &acts[i];
        let tmp = a.old_path.with_file_name(format!(".dvtmp_{i}"));
        match std::fs::rename(docx::lp(&a.old_path), docx::lp(&tmp)) {
            Ok(()) => staged.push((tmp, i)),
            Err(e) => errs.push(format!("{}：{}", a.old_name, e)),
        }
    }

    /* 第二阶段：临时名 → 最终名，同时搬缓存、更新索引与计划。 */
    let mapf = dir.join("_work/map.json");
    let mut map: Vec<Item> = read_json(&mapf);
    let pp = rename::plan_path(&dir);
    let mut plan: rename::PlanFile = read_json(&pp);
    let mut renamed = 0u32;
    for (tmp, i) in &staged {
        let a = &acts[*i];
        match std::fs::rename(docx::lp(tmp), docx::lp(&a.new_path)) {
            Ok(()) => {
                renamed += 1;
                let new_path = a.new_path.to_string_lossy().to_string();
                let new_idx = scan::idx_of(&new_path);
                migrate_idx_cache(&dir, &a.old_idx, &new_idx);
                let fam = rename::base_of(&a.new_name);
                if let Some(it) = map.iter_mut().find(|x| x.idx == a.old_idx) {
                    it.path = new_path.clone();
                    it.name = a.new_name.clone();
                    it.idx = new_idx.clone();
                    it.fam = fam;
                    if it.img.is_some() {
                        let p = dir.join("_imgs").join(format!("{new_idx}.png"));
                        it.img = p.is_file().then(|| p.to_string_lossy().to_string());
                    }
                }
                rename::rename_in_plan(
                    &mut plan,
                    &a.old_path.to_string_lossy(),
                    &new_path,
                    &a.new_name,
                );
            }
            Err(e) => {
                /* 落位失败：把临时名还原回原名，别把文件留在 .dvtmp 下。 */
                let _ = std::fs::rename(docx::lp(tmp), docx::lp(&a.old_path));
                errs.push(format!("{}：{}", a.old_name, e));
            }
        }
    }
    if renamed > 0 {
        if let Err(e) = write_json(&mapf, &map) {
            errs.push(format!("索引写入失败：{e}"));
        }
        if let Err(e) = write_json(&pp, &plan) {
            errs.push(format!("计划写入失败：{e}"));
        }
    }
    ok(serde_json::json!({"renamed": renamed, "skipped": skipped, "errs": errs}))
}

/// 本地时间戳 `yyyyMMdd-HHmmss`。
///
/// 纯 std 只能拿 UTC，而项目刻意不引 chrono（见 af_flow.rs 的同类注释）。
/// 这条支路只在"目标 ZIP 已存在、用户选择加时间戳"时才走到，低频、
/// 且本来就要等打包耗时，起一次 PowerShell 取本地时间可以接受 ——
/// 与 dupview_browse 选目录是同一取舍。取不到就退化成 Unix 秒（名字仍唯一）。
fn local_stamp() -> String {
    if let Ok(o) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Get-Date -Format 'yyyyMMdd-HHmmss'"])
        .output()
    {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || c == '-') {
                return s;
            }
        }
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

/// 把目录打包成 ZIP，落在它的**父目录**下（ZIP 内保留顶层目录名）。
///
/// `mode` 决定"目标已存在"时怎么办：
///   · `auto`（默认）—— 不覆盖，返回 `{ok:false, err:"exists", target}` 让前端弹窗问；
///   · `overwrite`  —— 直接覆盖；
///   · `timestamp`  —— 改成 `<目录名>_<时间戳>.zip`。
#[tauri::command(async, rename_all = "snake_case")]
pub fn dupview_pack_zip(path: String, mode: String) -> serde_json::Value {
    let src = Path::new(&path);
    if !src.is_dir() {
        return err("目录不存在");
    }
    let name = match src.file_name() {
        Some(n) => n.to_string_lossy().to_string(),
        None => return err("无法确定目录名"),
    };
    let parent = match src.parent() {
        Some(p) => p,
        None => return err("无法确定父目录"),
    };
    let mut target = parent.join(format!("{name}.zip"));
    if target.exists() {
        match mode.as_str() {
            "overwrite" => {}
            "timestamp" => target = parent.join(format!("{name}_{}.zip", local_stamp())),
            _ => {
                return serde_json::json!({
                    "ok": false,
                    "err": "exists",
                    "target": target.to_string_lossy(),
                })
            }
        }
    }
    match pack::pack_into(src, &target) {
        Ok(st) => ok(serde_json::json!({
            "target": st.target,
            "files": st.files,
            "bytes": st.bytes,
        })),
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

/// 在系统文件管理器中打开目录（文件树右键菜单「在资源管理器中打开」）。
///
/// 目录不存在时不启动 explorer —— 否则 explorer.exe 会拿这个不存在的路径
/// 去解析，用户看到的是一个**看起来正常但内容不对**的窗口（或干脆没反应），
/// 查起来比报错麻烦得多，所以先判存在。
///
/// 只接受**目录**：右键菜单给的是树节点，都是目录。若传进来的是文件，
/// 这里取它所在目录 —— 但要注意「目录」不是随口取的：Windows 上若把
/// 文件路径交给 explorer，它会**选中**该文件（不同版本行为不一致，
/// 有时还会顺带打开它）。统一落到父目录更可预期。
#[tauri::command(rename_all = "snake_case")]
pub fn dupview_open_in_explorer(path: String) -> serde_json::Value {
    let p = Path::new(&path);
    if !p.exists() {
        return err("路径不存在（可能已被移动或删除）");
    }
    let dir = if p.is_dir() {
        p.to_path_buf()
    } else {
        match p.parent() {
            Some(d) => d.to_path_buf(),
            None => return err("无法确定所在目录"),
        }
    };
    /* 与 fpx::open_path 同一道防护：路径里若含 `&`、`%`、引号等元字符，
       经 `cmd /c start` 一类外壳二次解析时能逃出引号边界变成第二条命令。
       这里直接拒绝并给出去处，好过"能打开但可能被注入"。 */
    let s = dir.to_string_lossy().to_string();
    if !crate::fpx::safety::safe_cmd_arg(&s) {
        return err(&format!("路径含特殊字符，已拒绝用系统外壳打开：{s}"));
    }
    /* 起不来（explorer 不在 PATH、被策略挡住）要如实报给用户 ——
       静默忽略会让菜单点了完全没反应，而用户会以为是自己点错了。 */
    if let Err(e) = spawn_explorer(&dir) {
        return err(&format!("无法打开文件管理器：{e}"));
    }
    ok(serde_json::json!({"dir": s}))
}

/// 拉起系统文件管理器。只负责"能不能起来"，起不来只影响这次的观感，
/// 所以返回 `Result` 由调用方决定是否提示 —— 当前调用方只在失败时 toast。
#[cfg(windows)]
fn spawn_explorer(dir: &Path) -> std::io::Result<()> {
    std::process::Command::new("explorer").arg(dir).spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn spawn_explorer(dir: &Path) -> std::io::Result<()> {
    std::process::Command::new("open").arg(dir).spawn().map(|_| ())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn spawn_explorer(dir: &Path) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(dir).spawn().map(|_| ())
}

/// 取消正在跑的扫描。插件关闭时调用，避免后台线程继续渲染几百份卷子。
pub fn request_cancel(app: &AppHandle) {
    if let Some(st) = app.try_state::<DupState>() {
        *st.cancel.lock().unwrap() = true;
    }
}
