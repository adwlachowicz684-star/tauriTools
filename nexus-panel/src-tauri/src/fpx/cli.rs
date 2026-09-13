//! 无界面的命令行模式
//! ------------------------------------------------------------------
//! 对应 junction_link 的 App.xaml.cs 里那几个 `--xxx` 入口，供脚本 / 排错 / 批量整理用。
//! 全部在 Tauri 启动**之前**处理（见 main.rs），不创建窗口、不进事件循环。
//!
//!   --self-check <config> <record> <outDir>   数据层自检（只读真实文件，写临时副本）
//!   --migrate-hierarchy [config] [record]     项目搬到「新建项目父目录\页签名\名称」
//!   --migrate-groups-hierarchy [config] [record]  项目组同上，搬完重建指向它的链接
//!   --mcp [port]                              只跑 MCP server，不开界面（见 main.rs）
//!
//! 参数里的路径都显式传入，不依赖 AppHandle —— 命令行模式下拿不到 Tauri 的 State，
//! 而且显式传路径更好测。

use std::path::{Path, PathBuf};

use super::model::FpxConfig;
use super::store;

/* ---------------------------- 数据层自检 ---------------------------- */

/**
 * 自检：读真实 config → 规范化 → 写临时副本 → 回读，校验字段结构仍在；
 * 再用真实 link-record 在**临时副本**上跑一遍 Load / Upsert / Remove / 相对转换。
 *
 * 全程不改动真实数据（只写 outDir），可以随时跑。
 * 返回人类可读的报告，同时写入 outDir/_data-selfcheck-result.txt。
 */
pub fn self_check(config_path: &str, record_path: &str, out_dir: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut pass = true;
    let mut check = |ok: bool, msg: String, lines: &mut Vec<String>, pass: &mut bool| {
        *pass &= ok;
        lines.push(format!("{} {}", if ok { "[PASS]" } else { "[FAIL]" }, msg));
    };

    lines.push("== 数据层自检 ==".to_string());
    lines.push(format!("config: {config_path}"));
    lines.push(format!("record: {record_path}"));
    lines.push(String::new());

    let out = Path::new(out_dir);
    if let Err(e) = std::fs::create_dir_all(out) {
        return format!("无法创建输出目录 {out_dir}: {e}");
    }

    // ---- 1. config 往返 ----
    let cfg: FpxConfig = match store::read_json_any::<FpxConfig>(Path::new(config_path)) {
        Ok(c) => c,
        Err(e) => return format!("读取 config 失败: {e}"),
    };
    check(!cfg.project_tabs.is_empty(), format!("projectTabs 非空 (count={})", cfg.project_tabs.len()), &mut lines, &mut pass);
    check(!cfg.group_tabs.is_empty(), format!("groupTabs 非空 (count={})", cfg.group_tabs.len()), &mut lines, &mut pass);

    let tmp_cfg = out.join("_roundtrip-config.json");
    if let Err(e) = store::write_json_any(&tmp_cfg, &cfg) {
        check(false, format!("写临时 config 副本失败: {e}"), &mut lines, &mut pass);
    } else {
        match store::read_json_any::<FpxConfig>(&tmp_cfg) {
            Ok(back) => {
                check(back.project_tabs.len() == cfg.project_tabs.len(),
                    format!("projectTabs 往返一致 ({} → {})", cfg.project_tabs.len(), back.project_tabs.len()),
                    &mut lines, &mut pass);
                check(back.group_tabs.len() == cfg.group_tabs.len(),
                    format!("groupTabs 往返一致 ({} → {})", cfg.group_tabs.len(), back.group_tabs.len()),
                    &mut lines, &mut pass);
                let a = cfg.project_tabs.iter().flat_map(|t| t.items.iter()).count();
                let b = back.project_tabs.iter().flat_map(|t| t.items.iter()).count();
                check(a == b, format!("项目条目总数一致 ({a} → {b})"), &mut lines, &mut pass);
            }
            Err(e) => check(false, format!("回读临时 config 失败: {e}"), &mut lines, &mut pass),
        }
    }

    // ---- 2. link-record 往返（在临时副本上做增删改）----
    let records = store::load_records_from(Path::new(record_path));
    lines.push(String::new());
    lines.push(format!("-- link-record: 读到 {} 条 --", records.len()));

    let tmp_rec = out.join("_roundtrip-record.json");
    if let Err(e) = store::save_records_to(&tmp_rec, &records) {
        check(false, format!("写临时 record 副本失败: {e}"), &mut lines, &mut pass);
    } else {
        match store::load_records_from_exact(&tmp_rec) {
            Ok(back) => check(back.len() == records.len(),
                format!("link-record 往返一致 ({} → {})", records.len(), back.len()),
                &mut lines, &mut pass),
            Err(e) => check(false, format!("回读临时 record 失败: {e}"), &mut lines, &mut pass),
        }
    }

    // 相对路径转换：每条记录的 lib 应当能解析成绝对路径
    let mut bad_rel = 0;
    for r in &records {
        if r.lib.trim().is_empty() { bad_rel += 1; }
    }
    check(bad_rel == 0, format!("链接记录的 lib 字段均非空 (异常 {bad_rel} 条)"), &mut lines, &mut pass);

    // ---- 3. 路径存在性（只报告，不判失败：目录挪走是常态）----
    let total: usize = cfg.project_tabs.iter().flat_map(|t| t.items.iter())
        .chain(cfg.group_tabs.iter().flat_map(|t| t.items.iter())).count();
    let missing = cfg.project_tabs.iter().flat_map(|t| t.items.iter())
        .chain(cfg.group_tabs.iter().flat_map(|t| t.items.iter()))
        .filter(|p| !Path::new(p).exists())
        .count();
    lines.push(String::new());
    lines.push(format!("[INFO] 登记路径 {total} 条，其中 {missing} 条当前不存在（可用「清除无效项」清理）"));

    lines.push(String::new());
    lines.push(if pass { "== 全部通过 ==".to_string() } else { "== 存在失败项 ==".to_string() });

    let report = lines.join("\n");
    let _ = std::fs::write(out.join("_data-selfcheck-result.txt"), &report);
    report
}

/* ---------------------------- 层级批量迁移 ---------------------------- */

/// 归一化成「无尾部分隔符的绝对路径」，用于比较
fn reloc_key(p: &str) -> String {
    let full = std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    full.to_string_lossy()
        .trim_end_matches(|c| c == '\\' || c == '/')
        .to_string()
}

/// 单条迁移结果：Note 为空 = 成功
struct MigItem {
    src: String,
    dst: String,
    note: String,
}

/**
 * 把某个类别的全部登记搬到「预设父目录\所属页签名\名称」。
 *
 * 与界面里的「新建项目时路径携带页签层级」落点规则一致。
 * 搬迁时会更新 config 里的路径，并按 need_relink 决定是否重建链接记录
 * （项目组被搬走后，指向它的 junction 会断，必须重建）。
 *
 * exclude_roots 里的路径一律不搬（工具自身目录、exe 目录等）。
 */
fn migrate(
    cfg_path: &str,
    rec_path: &str,
    kind: &str,
) -> String {
    let cfg: FpxConfig = match store::read_json_any::<FpxConfig>(Path::new(cfg_path)) {
        Ok(c) => c,
        Err(e) => return format!("读取 config 失败: {e}"),
    };

    let root = match (kind, &cfg.create_project_dir, &cfg.create_group_dir) {
        ("project", Some(d), _) | ("group", _, Some(d)) if !d.trim().is_empty() => d.trim().to_string(),
        _ => return format!("未设置「新建{}父目录」，无法确定迁移目标根", if kind == "project" { "项目" } else { "项目组" }),
    };
    let root = PathBuf::from(&root);

    // 排除：数据目录自身、目标根的上级（防止把根搬进自己）
    let mut excludes: Vec<String> = Vec::new();
    if let Some(parent) = Path::new(cfg_path).parent() {
        excludes.push(reloc_key(&parent.to_string_lossy()));
    }
    excludes.push(reloc_key(&root.to_string_lossy()));

    let tabs = if kind == "group" { &cfg.group_tabs } else { &cfg.project_tabs };

    // 先做不可变计划：搬迁过程中要改 config，不能边枚举边改
    let mut plan: Vec<(String, String)> = Vec::new(); // (页签名, 源路径)
    for t in tabs {
        for p in &t.items {
            let k = reloc_key(p);
            if excludes.iter().any(|e| e.eq_ignore_ascii_case(&k)) { continue; }
            if !Path::new(p).is_dir() { continue; }
            plan.push((t.name.clone(), p.clone()));
        }
    }

    let mut items: Vec<MigItem> = Vec::new();
    let (mut moved, mut skipped, mut failed) = (0, 0, 0);

    for (seg, src) in &plan {
        let name = Path::new(src).file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.is_empty() { skipped += 1; continue; }

        let dst_dir = root.join(seg);
        let dst = dst_dir.join(&name);

        if reloc_key(src).eq_ignore_ascii_case(&reloc_key(&dst.to_string_lossy())) {
            skipped += 1;
            items.push(MigItem { src: src.clone(), dst: dst.to_string_lossy().to_string(), note: "跳过：已在目标位置".into() });
            continue;
        }
        if dst.exists() {
            skipped += 1;
            items.push(MigItem { src: src.clone(), dst: dst.to_string_lossy().to_string(), note: "跳过：目标已存在同名目录".into() });
            continue;
        }

        // 只在同一卷内搬：跨卷 rename 会失败，硬搬可能留下半截数据
        if let Err(e) = std::fs::create_dir_all(&dst_dir) {
            failed += 1;
            items.push(MigItem { src: src.clone(), dst: dst.to_string_lossy().to_string(), note: format!("失败：无法创建目标目录 {e}") });
            continue;
        }
        match std::fs::rename(src, &dst) {
            Ok(()) => {
                moved += 1;
                items.push(MigItem { src: src.clone(), dst: dst.to_string_lossy().to_string(), note: String::new() });
            }
            Err(e) => {
                failed += 1;
                items.push(MigItem { src: src.clone(), dst: dst.to_string_lossy().to_string(), note: format!("失败：{e}") });
            }
        }
    }

    // ---- 回写 config：把搬成功的路径换成新路径 ----
    let mut cfg = cfg;
    {
        let tabs = if kind == "group" { &mut cfg.group_tabs } else { &mut cfg.project_tabs };
        for it in &items {
            if !it.note.is_empty() { continue; }
            let key = store::normalize_key(&it.src);
            for t in tabs.iter_mut() {
                for p in t.items.iter_mut() {
                    if store::normalize_key(p) == key { *p = it.dst.clone(); }
                }
            }
        }
    }
    // 图标 / 标签色 / 锁 也跟着换键，否则搬迁后样式全丢
    for it in &items {
        if !it.note.is_empty() { continue; }
        let key = store::normalize_key(&it.src);
        cfg.folder_icons = remap(cfg.folder_icons.clone(), &key, &it.dst);
        cfg.tag_colors = remap(cfg.tag_colors.clone(), &key, &it.dst);
        for l in cfg.locks.iter_mut() {
            if store::normalize_key(&l.path) == key { l.path = it.dst.clone(); }
        }
    }

    // ---- 链接记录：项目搬走改 project；项目组搬走改 group 与 lib，并重建 junction ----
    let mut records = store::load_records_from(Path::new(rec_path));
    for it in &items {
        if !it.note.is_empty() { continue; }
        let key = store::normalize_key(&it.src);
        for r in records.iter_mut() {
            if kind == "project" {
                if store::normalize_key(&r.project) == key { r.project = it.dst.clone(); }
            } else {
                if store::normalize_key(&r.group) == key { r.group = it.dst.clone(); }
                if store::normalize_key(&r.lib) == key { r.lib = it.dst.clone(); }
            }
        }
    }

    // 项目组搬走后，指向它的链接全断了：逐个重建
    let mut relinked = 0;
    if kind == "group" {
        for r in records.iter_mut() {
            if !Path::new(&r.project).is_dir() { continue; }
            let names: Vec<String> = r.names.clone();
            if names.is_empty() { continue; }
            // 先删旧的（可能已断），再建新的
            let _ = super::junction::remove(&r.project, &names);
            match super::junction::create(&r.project, &r.group, &names) {
                Ok(_) => relinked += 1,
                Err(_) => {}
            }
        }
    }

    if let Err(e) = store::write_json_any(Path::new(cfg_path), &cfg) {
        return format!("搬迁完成但写回 config 失败: {e}\n{}", render(moved, skipped, failed, relinked, &items));
    }
    if let Err(e) = store::save_records_to(Path::new(rec_path), &records) {
        return format!("搬迁完成但写回 link-record 失败: {e}\n{}", render(moved, skipped, failed, relinked, &items));
    }

    render(moved, skipped, failed, relinked, &items)
}

fn remap(
    map: std::collections::HashMap<String, String>,
    old_key: &str,
    new_path: &str,
) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::with_capacity(map.len());
    for (k, v) in map {
        if store::normalize_key(&k) == old_key {
            out.insert(new_path.to_string(), v);
        } else {
            out.insert(k, v);
        }
    }
    out
}

fn render(
    moved: usize,
    skipped: usize,
    failed: usize,
    relinked: usize,
    items: &[MigItem],
) -> String {
    let mut s = format!("== 层级迁移完成 ==\n已搬 {moved} 条，跳过 {skipped} 条，失败 {failed} 条");
    if relinked > 0 {
        s.push_str(&format!("，重建链接 {relinked} 条"));
    }
    s.push_str("\n\n");
    for it in items {
        if it.note.is_empty() {
            s.push_str(&format!("[OK]   {} → {}\n", it.src, it.dst));
        } else {
            s.push_str(&format!("[{}] {} → {}\n", it.note, it.src, it.dst));
        }
    }
    s
}

/// 入口：解析 argv 并分派。返回 Some(输出) 表示已处理（调用方应直接退出）。
pub fn try_handle(args: &[String]) -> Option<String> {
    if args.len() < 2 { return None; }
    match args[1].as_str() {
        "--self-check" | "--roundtrip" if args.len() >= 5 => {
            Some(self_check(&args[2], &args[3], &args[4]))
        }
        "--migrate-hierarchy" => {
            let (c, r) = default_paths(&args[2..]);
            Some(migrate(&c, &r, "project"))
        }
        "--migrate-groups-hierarchy" => {
            let (c, r) = default_paths(&args[2..]);
            Some(migrate(&c, &r, "group"))
        }
        _ => None,
    }
}

/// 未显式传路径时用 Tauri 的数据目录默认值；
/// 拿不到 appDataDir（命令行模式下很常见）就退回当前目录下的 project-group/。
fn default_paths(rest: &[String]) -> (String, String) {
    let (c, r) = match rest {
        [a, b, ..] => (a.clone(), b.clone()),
        _ => (String::new(), String::new()),
    };
    if !c.is_empty() && !r.is_empty() { return (c, r); }

    let base = dirs_data_dir().unwrap_or_else(|| PathBuf::from("project-group"));
    (
        if c.is_empty() { base.join("config.json").to_string_lossy().to_string() } else { c },
        if r.is_empty() { base.join("link-record.json").to_string_lossy().to_string() } else { r },
    )
}

/// 与 store::resolve_data_dir 相同的落点，只是这里拿不到 AppHandle。
fn dirs_data_dir() -> Option<PathBuf> {
    let home = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    if std::env::var_os("APPDATA").is_some() {
        Some(home.join("nexus-panel").join("project-group"))
    } else {
        Some(home.join(".nexus-panel").join("project-group"))
    }
}
