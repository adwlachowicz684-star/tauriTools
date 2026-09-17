//! 项目组分配插件 · 后端命令层
//! ------------------------------------------------------------------
//! 把 junction_link（C# WPF 版）里「项目组分配」「agent/skill 浏览」「新建项目/项目组」
//! 「ACL 保护」「文件夹图标」几块能力搬进 Nexus Panel 的 Rust 后端。
//! 数据独立存放在 <appDataDir>/project-group/ 下，不触碰原 C# 版的数据目录。

// 本模块是给前端插件用的命令集合，部分辅助函数暂未接入，允许存在未使用项
#![allow(dead_code)]

pub mod backup;
pub mod cli;
pub mod base64;
pub mod chain;
pub mod content;
pub mod editor;
pub mod fsutil;
/// 路径收口：所有来自调用方的路径统一过 guard::must_be_under，见模块内说明。
pub mod guard;
pub mod junction;
pub mod mcp;
pub mod model;
pub mod safety;
pub mod screen;
pub mod store;
pub mod sys;
pub mod watch;

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, State};

use model::{
    Bootstrap, ContentItem, DirEntryLite, FpxConfig, LinkRecord, LinkRow, Snapshot, TabInfo,
};
use store::FpxState;

/* ---------------------------- 快照 DTO ---------------------------- */
// Snapshot 本身定义在 model.rs（与其他 DTO 同处），这里只放构造逻辑。

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

/* ---------------------------- 允许操作的根目录 ---------------------------- */
/*
 * 为什么要有这一层：此前各命令直接吃调用方给的路径，
 * `fpx_read_file` / `fpx_icon_data` / `af_fs_tail` 因此成了三条独立的
 * 「任意文件读」通道（审查清单 P0-3 / P0-4 / P1-1）。根因不是某条命令写错了，
 * 而是**没有统一的收口** —— 各写各的迟早漏一个。
 *
 * 所以白名单只有一份实现：`guard::must_be_under`，所有接收路径的入口都调它。
 *
 * 范围取"用户亲手登记过的地方"，不是全盘：
 *   · 页签卡片（项目 / 项目组）—— 用户加进来的目录
 *   · 用户显式配置的目录（新建落点 / 备份落点）
 *   · 数据目录（兜底，保证列表永不为空，否则所有操作都会被拒）
 */

/// 本插件允许操作的根目录（已 canonicalize，可直接喂给 `guard::must_be_under`）。
pub(crate) fn content_roots(dir: &std::path::Path, cfg: &FpxConfig) -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    let mut push = |raw: &str| {
        if let Some(c) = guard::canonical_root(raw) {
            if !out.contains(&c) {
                out.push(c);
            }
        }
    };

    // 页签登记：同一路径可能出现在多个页签里，去重交给 push
    for t in cfg.project_tabs.iter().chain(cfg.group_tabs.iter()) {
        for item in &t.items {
            push(item);
        }
    }
    // 用户在设置里显式指定的目录（新建项目/项目组的落点、备份落点）
    for opt in [
        &cfg.create_project_dir,
        &cfg.create_group_dir,
        &cfg.create_group_template_dir,
        &cfg.backup_dir,
        &cfg.backup_project_dir,
        &cfg.backup_group_dir,
    ] {
        if let Some(v) = opt {
            push(v);
        }
    }
    // 兜底：数据目录恒定在内
    push(&dir.to_string_lossy());
    out
}

/// 校验路径落在允许范围内。所有"操作已登记卡片"的入口都该先过这一句。
///
/// 为什么只对**已有卡片**用（清单 P1-5/6/7）：
/// 卡片路径是用户亲手加进页签的，必然在 `content_roots` 里，收口不会误伤。
/// 而"新建落点 / 搬家目标 / 备份目标"这类**引入新位置**的入口不能这么收 ——
/// 目录是用户用选择器现挑的，还没登记过，收口等于禁止在任何新地方建项目。
/// 那几个只过 `guard::reject_forbidden_raw`（系统目录 / 整块盘），理由见各自注释。
pub(crate) fn ensure_path_allowed(dir: &std::path::Path, path: &str) -> Result<(), String> {
    let cfg = store::load_config(dir);
    guard::must_be_under(path, &content_roots(dir, &cfg)).map(|_| ())
}

/// 同上，但用调用方手上已有的配置，省一次读盘（core_* 里大多已 load 过）。
pub(crate) fn ensure_path_in(
    dir: &std::path::Path,
    cfg: &FpxConfig,
    path: &str,
) -> Result<(), String> {
    guard::must_be_under(path, &content_roots(dir, cfg)).map(|_| ())
}

/// 读取文件文本（目录型 skill 自动读其 SKILL.md），**先校验路径在允许范围内**。
///
/// 命令层与 MCP 共用：两边此前各自直连 `content::read_preview`，
/// 一边补了校验另一边没补就会出现"前端通道堵上了、MCP 还能读全盘"。
pub(crate) fn core_read_file(
    dir: &std::path::Path,
    path: &str,
    max: Option<usize>,
) -> Result<String, String> {
    let cfg = store::load_config(dir);
    let roots = content_roots(dir, &cfg);

    let target = if std::path::Path::new(path).is_dir() {
        // 目录先整体校验，再取它下面的 SKILL.md（自然也在范围内）
        let canon = guard::must_be_under(path, &roots)?;
        content::skill_md_of(&canon.to_string_lossy())
            .ok_or_else(|| "该目录下没有 SKILL.md".to_string())?
    } else {
        guard::must_be_under(path, &roots)?.to_string_lossy().to_string()
    };
    content::read_preview(&target, max.unwrap_or(20000))
}

/// 图标引用可能是「<文件>|<索引>」（DLL 里多图标），取竖线前的真实文件路径。
fn icon_file_part(raw: &str) -> String {
    match raw.rsplit_once('|') {
        Some((f, i)) if !i.trim().is_empty() && i.trim().chars().all(|c| c.is_ascii_digit()) => {
            f.to_string()
        }
        _ => raw.to_string(),
    }
}

/// 把图标文件读成 data URI。**只接受数据目录 icons/ 与用户已登记的图标引用**。
///
/// 此前唯一的"校验"是 `is_file()` + 2MB 上限 —— 任意 ≤2MB 的文件
/// （私钥、cookie、配置）都能被读成 data URI 回传前端（清单 P0-4）。
pub(crate) fn core_icon_data(dir: &std::path::Path, raw: &str) -> Result<String, String> {
    let cfg = store::load_config(dir);
    let file_part = icon_file_part(raw.trim());

    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    let mut push = |p: &str| {
        if let Some(c) = guard::canonical_root(p) {
            if !roots.contains(&c) {
                roots.push(c);
            }
        }
    };
    push(&dir.join("icons").to_string_lossy());
    push(&dir.to_string_lossy());
    // 用户自己选过的图标可以在任意位置：把它们逐个纳入白名单，
    // 既保住"自定义图标在任意盘"的用法，又不至于退回"任意文件读"
    for v in cfg.folder_icons.values() {
        push(&icon_file_part(v));
    }

    let canon = guard::must_be_under(&file_part, &roots)?;
    if !canon.is_file() {
        return Err("图标文件不存在".into());
    }
    // 限制体积：图标不该很大，防止误传大文件把整包数据塞进 IPC
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("图标文件超过 2MB，可能不是图标".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
    let ext = canon.extension().and_then(|e| e.to_str()).unwrap_or("");
    Ok(base64::data_uri(&bytes, ext))
}

/* ---------------------------- 改名 / 清除无效项 ---------------------------- */

/// 把路径中的「最后一段」换成新名字，其余部分原样保留。
/// 用于改名后同步更新页签登记、链接记录、图标/颜色/锁等所有以路径为键的映射。
fn replace_last_segment(path: &str, new_name: &str) -> String {
    let p = std::path::Path::new(path);
    let trimmed = path.trim_end_matches(|c| c == '\\' || c == '/');
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            let sep = if trimmed.contains('\\') { "\\" } else { "/" };
            let pstr = parent.to_string_lossy().to_string();
            let pstr = pstr.trim_end_matches(|c| c == '\\' || c == '/');
            // pstr 为盘符根（如 "C:"）时 sep 正好补上根分隔符，两种情况写法一致
            format!("{pstr}{sep}{new_name}")
        }
        _ => new_name.to_string(),
    }
}

/// 给项目/项目组文件夹改名：物理 rename + 同步所有按路径登记的映射。
///
/// 受 ACL 保护（防删除/防写入）时先临时摘锁，否则 rename 会被系统拒绝——
/// 与建链行为一致（对应 C# 版 FolderLockService.WithUnlockForPath）。
pub(crate) fn core_rename_folder(
    dir: &std::path::Path,
    kind: &str,
    path: &str,
    new_name: &str,
) -> Result<model::RenameResult, String> {
    // 与新建走同一套校验（sys::validate_name）。
    // 此前这里只查了空 / 路径分隔符 / 非法字符，漏掉两项：
    //   - 「.」「..」及纯点串：新建时被拒，改名却能写进去，随后路径解析会出问题；
    //   - 长度上限 120：同上，超长名能绕过新建检查。
    // 两处各写一份相同或相近的校验，迟早会漂移，所以收敛到唯一实现。
    let name = sys::validate_name(new_name)?;
    // 改名的对象必须是已登记的卡片：凭空给任意目录改名不该发生
    ensure_path_allowed(dir, path)?;

    let old = std::path::Path::new(path);
    // 不跟随链接：改名一个 junction 不该变成"给链接指向的目录改名"
    if !crate::fpx::fsutil::is_real_dir(old) {
        return Err(format!("文件夹不存在或已被移动：{path}"));
    }
    let old_name = old
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if old_name == name {
        return Err("新名称与当前名称相同".into());
    }

    let new_path = replace_last_segment(path, &name);
    if std::path::Path::new(&new_path).exists() {
        return Err(format!("目标位置已存在同名文件夹：{new_path}"));
    }

    let old_key = store::normalize_key(path);

    // 整个「读配置 → 改名 → 同步所有登记 → 写回」放进一个事务：
    // 期间不能被别的写入者（MCP 线程 / 其它命令）插进来，否则两边各自基于
    // 旧快照写回，后写的会把先写的整份覆盖。
    store::with_config(dir, |cfg| {
        // 摘锁后才能 rename：受 ACL 保护的目录 rename 会被系统拒绝
        let _guard = LockGuard::new(path, store::lock_of(cfg, path));
        // 跨卷时 rename 必然失败，回退到"复制 + 删除"；
        // 回退的语义是"复制没成功就绝不删源"，不会留下两份残缺数据
        crate::fpx::fsutil::rename_with_fallback(old, std::path::Path::new(&new_path))
            .map_err(|e| format!("改名失败：{e}"))?;
        drop(_guard);

        // ---- 同步所有以旧路径为键的登记 ----
        // 页签登记（项目 / 项目组都要改：同一路径可能被登记在多个页签里）
        let mut tab_hits = 0usize;
        for list in [&mut cfg.project_tabs, &mut cfg.group_tabs] {
            for t in list.iter_mut() {
                for item in t.items.iter_mut() {
                    if store::normalize_key(item) == old_key {
                        *item = new_path.clone();
                        tab_hits += 1;
                    }
                }
            }
        }

        // 图标 / 标签色 / ACL 锁：OrdinalIgnoreCase 语义的键需要整体重建
        cfg.folder_icons = remap_keys(std::mem::take(&mut cfg.folder_icons), &old_key, &new_path);
        cfg.tag_colors = remap_keys(std::mem::take(&mut cfg.tag_colors), &old_key, &new_path);
        for l in cfg.locks.iter_mut() {
            if store::normalize_key(&l.path) == old_key {
                l.path = new_path.clone();
            }
        }

        // 链接记录：项目改名改 project；项目组改名要改 lib 与 group。
        //
        // 注意字段语义：`lib` 存**完整路径**，`group` 存**文件夹短名**（见 upsert_record）。
        // 所以比对必须用 lib（拿短名和完整路径比永远不会相等，那行会是死代码），
        // 而 group 要跟着换成新路径的 file_name，否则链接表里仍显示旧名字。
        let new_name = std::path::Path::new(&new_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut records = store::load_records(dir);
        let mut rec_hits = 0usize;
        for r in records.iter_mut() {
            if store::normalize_key(&r.project) == old_key {
                r.project = new_path.clone();
                rec_hits += 1;
            }
            if store::normalize_key(&r.lib) == old_key {
                r.lib = new_path.clone();
                if !new_name.is_empty() { r.group = new_name.clone(); }
            }
        }
        store::save_records(dir, &records)?;

        Ok(model::RenameResult {
            snapshot: snapshot(dir, cfg),
            new_path: new_path.clone(),
            tab_hits,
            rec_hits,
            // 改名不重建 junction：原版同样如此（改名后链接会断，提示用户重新分配）
            relinked: 0,
            relink_errors: Vec::new(),
        })
    })
}

/// 搬家：把项目 / 项目组文件夹移到别的父目录下（物理移动 + 同步所有登记）。
///
/// 与「改名」共用一套同步逻辑，差别只有目标路径的构造方式：
/// 改名是「父目录不变、换末段」，搬家是「末段不变、换父目录」。
/// 语义上必须分开——WPF 原版就是两个入口，且改名会拒绝带分隔符的名字，
/// 正是为了不让它退化成搬家。
fn core_move_folder(
    dir: &std::path::Path,
    kind: &str,
    path: &str,
    dest_parent: &str,
) -> Result<model::RenameResult, String> {
    // 被搬的必须是已登记的卡片
    ensure_path_allowed(dir, path)?;
    let old = std::path::Path::new(path);
    // 与改名一致：不跟随链接。搬一个 junction 不该变成"搬链接指向的那个目录"。
    if !fsutil::is_real_dir(old) {
        return Err(format!("文件夹不存在、已被移动，或它是一个链接：{path}"));
    }
    let dest = std::path::Path::new(dest_parent);
    if !fsutil::is_real_dir(dest) {
        return Err(format!("目标目录不存在：{dest_parent}"));
    }
    // 目标父目录不能是系统目录 / 整块盘：把项目搬进 C:\Windows 只会留下烂摊子
    guard::reject_forbidden_raw(dest_parent)?;
    let name = old
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if name.is_empty() {
        return Err("无法取到文件夹名，拒绝搬家".into());
    }

    // 拼目标路径：分隔符跟着目标目录走（Windows 用 \，Unix 用 /）
    let dstr = dest_parent.trim_end_matches(|c| c == '\\' || c == '/');
    let sep = if dstr.contains('\\') { "\\" } else { "/" };
    let new_path = format!("{dstr}{sep}{name}");

    if store::normalize_key(&new_path) == store::normalize_key(path) {
        return Err("目标位置与当前位置相同".into());
    }
    if std::path::Path::new(&new_path).exists() {
        return Err(format!("目标位置已存在同名文件夹：{new_path}"));
    }
    // 把目录搬进自己的子目录会让路径无限递归，必须先挡掉
    let old_key_prefix = format!("{}\\", store::normalize_key(path));
    let old_key_prefix_u = format!("{}/", store::normalize_key(path));
    let dest_key = store::normalize_key(dest_parent);
    if dest_key == store::normalize_key(path)
        || dest_key.starts_with(&old_key_prefix)
        || dest_key.starts_with(&old_key_prefix_u)
    {
        return Err("不能把文件夹移动到它自己或其子目录下".into());
    }

    let old_key = store::normalize_key(path);
    // 项目组搬家要重建指向它的 junction；项目搬家不用（junction 是它的子项）
    let kind_is_group = kind == "group";

    // 与 WPF 原版一致：只支持同盘搬家。
    // Directory.Move / std::fs::rename 跨卷会直接失败；曾经考虑过"复制+删除"兜底，
    // 但项目目录里满是 junction（本插件的核心产物），递归复制必然跳过链接点，
    // 搬完链接全丢且毫无提示 —— 宁可明确拒绝，也不制造静默的数据损失。
    let src_root = path_root(path);
    let dst_root = path_root(&new_path);
    if src_root.is_empty() || dst_root.is_empty() || !src_root.eq_ignore_ascii_case(&dst_root) {
        return Err(format!(
            "暂不支持跨盘搬家（源在 {src_root}，目标在 {dst_root}）。请选同一磁盘分区内的目录。"
        ));
    }

    store::with_config(dir, |cfg| {
        // 与改名同理：先摘锁再移动，顺序反过来会被系统拒绝
        let _guard = LockGuard::new(path, store::lock_of(cfg, path));
        std::fs::rename(old, &new_path).map_err(|e| format!("移动文件夹失败：{e}"))?;
        drop(_guard);

        // ---- 同步所有以旧路径为键的登记（与改名完全一致）----
        let mut tab_hits = 0usize;
        for list in [&mut cfg.project_tabs, &mut cfg.group_tabs] {
            for t in list.iter_mut() {
                for item in t.items.iter_mut() {
                    if store::normalize_key(item) == old_key {
                        *item = new_path.clone();
                        tab_hits += 1;
                    }
                }
            }
        }

        cfg.folder_icons = remap_keys(std::mem::take(&mut cfg.folder_icons), &old_key, &new_path);
        cfg.tag_colors = remap_keys(std::mem::take(&mut cfg.tag_colors), &old_key, &new_path);
        for l in cfg.locks.iter_mut() {
            if store::normalize_key(&l.path) == old_key {
                l.path = new_path.clone();
            }
        }

        // ---- 链接记录 + junction 重建 ----
        // 项目组搬家：所有指向旧路径的 junction 全断了，必须逐个重建到新路径
        // （WPF RelocateCard / cli.rs 迁移脚本都是这么做的）。
        // 项目搬家则无需重建 —— junction 是项目目录的子项，随目录一起挪过去了。
        let mut records = store::load_records(dir);
        let mut rec_hits = 0usize;
        let mut relinked = 0usize;
        let mut relink_errors: Vec<String> = Vec::new();

        for r in records.iter_mut() {
            if store::normalize_key(&r.project) == old_key {
                r.project = new_path.clone();
                rec_hits += 1;
            }
            if store::normalize_key(&r.lib) == old_key {
                r.lib = new_path.clone();
            }
        }

        // 只有项目组搬家需要重建（项目搬家时 lib 不指向它）
        if kind_is_group {
            for r in records.iter() {
                if store::normalize_key(&r.lib) != old_key { continue; }
                if !std::path::Path::new(&r.project).is_dir() { continue; }
                let names = r.link_names();
                if names.is_empty() { continue; }
                // 先删旧的（可能已断），再建指向新路径的。
                // 失败不中断：记录下来一并回传，让前端提示用户手动复查。
                let _ = junction::remove(&r.project, &names);
                match junction::create(&r.project, &new_path, &names) {
                    Ok(_) => relinked += 1,
                    Err(e) => relink_errors.push(format!("{}：{e}", r.project)),
                }
            }
        }

        store::save_records(dir, &records)?;

        Ok(model::RenameResult {
            snapshot: snapshot(dir, cfg),
            new_path: new_path.clone(),
            tab_hits,
            rec_hits,
            relinked,
            relink_errors,
        })
    })
}

/// 取路径的根（Windows 为盘符如 `C:`，Unix 为 `/`）。用于判断是否跨盘。
fn path_root(p: &str) -> String {
    use std::path::Component;
    match std::path::Path::new(p).components().next() {
        Some(Component::Prefix(pre)) => pre.as_os_str().to_string_lossy().to_string(),
        Some(Component::RootDir) => "/".to_string(),
        _ => String::new(),
    }
}

/// 把 HashMap 中等于 old_key 的键换成 new_path（其余键原样保留）。
fn remap_keys(
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

/// 清除无效项：把页签里已不存在的路径摘掉，并清理指向已消失项目的链接记录。
///
/// 只动"确实不存在"的条目——链接失效（junction 断了但目录还在）不算无效，
/// 那种情况目录本身是好的，用户可能只是想重建链接。
pub(crate) fn core_clear_invalid(dir: &std::path::Path) -> Result<model::ClearResult, String> {
    // 整体事务化：与 core_rename_folder 同理，避免与 MCP 等写入者互相覆盖
    store::with_config(dir, |cfg| {
      let mut removed: Vec<String> = Vec::new();
      let mut tab_hits = 0usize;

      for list in [&mut cfg.project_tabs, &mut cfg.group_tabs] {
          for t in list.iter_mut() {
              let before = t.items.len();
              t.items.retain(|p| {
                  let ok = std::path::Path::new(p).exists();
                  if !ok && !removed.contains(p) {
                      removed.push(p.clone());
                  }
                  ok
              });
              tab_hits += before - t.items.len();
          }
      }

      // 链接记录：项目目录没了，记录自然失效，一并清掉
      let mut records = store::load_records(dir);
      let rec_before = records.len();
      records.retain(|r| std::path::Path::new(&r.project).exists());
      let rec_hits = rec_before - records.len();

      store::save_records(dir, &records)?;

      Ok(model::ClearResult {
          snapshot: snapshot(dir, cfg),
          removed,
          tab_hits,
          rec_hits,
    })
    })
}

/// 保存整份配置。
///
/// 注意 editorPickCache 由后端独家维护（`fpx_list_editors` 扫描后写入），
/// 前端拿到的 bootstrap 快照里可能还是旧值（缓存为空）。若直接照前端传来的写回，
/// 用户只要再点一次「保存设置」，刚扫出来的缓存就被清空、下次又得重扫一遍。
/// 所以该字段以磁盘上的值为准，不受前端草稿影响。
pub(crate) fn core_save_config(dir: &std::path::Path, config: &FpxConfig) -> Result<Snapshot, String> {
    // 事务化：读到的必须是磁盘最新值，且整段期间不许别人插进来。
    // 这是前端「保存设置」与 MCP 共用的入口，不锁的话两边会互相覆盖。
    store::with_config(dir, |cfg| {
        let cache = std::mem::take(&mut cfg.editor_pick_cache);
        *cfg = config.clone();
        cfg.editor_pick_cache = cache;   // 以磁盘值为准，不受前端草稿影响
        Ok(snapshot(dir, cfg))
    })
}

pub(crate) fn core_create_link(
    dir: &std::path::Path,
    project: &str,
    group: &str,
    names: Option<Vec<String>>,
) -> Result<Snapshot, String> {
    let cfg = store::load_config(dir);
    /* 两端都要在允许范围内：junction 的目标在任意位置 = 在任意位置建写入通道。
       黑名单兜的是"用户把系统目录选成卡片"这种已登记但危险的情况。 */
    ensure_path_in(dir, &cfg, project)?;
    ensure_path_in(dir, &cfg, group)?;
    guard::reject_forbidden_raw(project)?;
    guard::reject_forbidden_raw(group)?;
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

    // 无论成败，已建成的部分都要写进账本，避免"链接在、记录缺失"。
    //
    // 走事务而不是直接 load/save：账本是**全量覆盖写**的，
    // 两个写入者各自 load→改→save 时，后写的会把先写的整条记录抹掉。
    // 那样磁盘上的 junction 还在，账本里却查不到，界面显示"未链接"——
    // 数据看起来是好的，所以极难定位。
    if !created.is_empty() {
        let done: Vec<String> = use_names
            .iter()
            .take(created.len())
            .cloned()
            .collect();
        store::with_records(dir, |records| {
            upsert_record(records, project, group, done);
            Ok(())
        })?;
    }

    if let Some(e) = err {
        return Err(format!("已创建 {} 个链接后失败：{e}", created.len()));
    }
    Ok(snapshot(dir, &cfg))
}

pub(crate) fn core_remove_link(dir: &std::path::Path, project: &str) -> Result<Snapshot, String> {
    let cfg = store::load_config(dir);
    // 断链会删 junction，同样是写操作：只认已登记的卡片
    ensure_path_in(dir, &cfg, project)?;
    let key = store::normalize_key(project);
    // 只读一次账本，拿到要删的链接名（此处不改动，无需事务）
    let names: Vec<String> = store::load_records(dir)
        .iter()
        .find(|r| store::normalize_key(&r.project) == key)
        .map(|r| r.link_names())
        .unwrap_or_else(|| junction::enabled_names(&cfg));

    let _guard = LockGuard::new(project, store::lock_of(&cfg, project));
    junction::remove(project, &names)?;
    drop(_guard);

    // 同 core_create_link：账本更新必须走事务，防并发覆盖
    store::with_records(dir, |records| {
        records.retain(|r| store::normalize_key(&r.project) != key);
        Ok(())
    })?;
    Ok(snapshot(dir, &cfg))
}

pub(crate) fn core_set_lock(
    dir: &std::path::Path,
    path: &str,
    deny_delete: bool,
    deny_write: bool,
) -> Result<Snapshot, String> {
    /* ACL 是写操作：给系统目录设防删/防写，等于把系统锁死一半。
       这一条不加会是什么后果 —— 用户误选了 C:\Windows 加锁，
       界面上点"解锁"还不一定解得开（ACL 已被改写）。 */
    guard::reject_forbidden_raw(path)?;
    ensure_path_allowed(dir, path)?;
    store::with_config(dir, |cfg| {
        // 先落 ACL 再记配置：apply_lock 失败时闭包返回 Err，配置不会落盘
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
        Ok(snapshot(dir, cfg))
    })
}

/// 图标 + 标签色一次保存（避免前端分两次写入互相覆盖）。
pub(crate) fn core_save_style(
    dir: &std::path::Path,
    path: &str,
    icon_ref: Option<String>,
    color: Option<String>,
) -> Result<Snapshot, String> {
    // 会写 desktop.ini 与目录属性，只认已登记的卡片
    ensure_path_allowed(dir, path)?;
    // 图标与标签色一次改完再落盘（避免前端分两次写入互相覆盖），
    // 且整段在事务里：期间不许 MCP 等其它写入者插入。
    store::with_config(dir, |cfg| {
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

    Ok(snapshot(dir, cfg))
    })
}


/// 只改标签色，不碰图标。
///
/// 与 core_save_style 分开是为了避免「为了保留旧图标而先读一次配置」的写法：
/// 那种写法在并发下会把读到的旧图标值写回，覆盖期间别人设的新图标。
/// 只改自己关心的字段，其余留给事务里的磁盘最新值。
pub(crate) fn core_set_tag_color(
    dir: &std::path::Path,
    path: &str,
    color: Option<String>,
) -> Result<Snapshot, String> {
    store::with_config(dir, |cfg| {
        // 空串 / null 视为恢复默认（删除记录）
        let c = color.as_deref().unwrap_or_default().trim().to_uppercase();
        if c.is_empty() {
            cfg.tag_colors.remove(path);
        } else {
            cfg.tag_colors.insert(path.to_string(), c);
        }
        Ok(snapshot(dir, cfg))
    })
}

pub(crate) fn core_save_custom_colors(
    dir: &std::path::Path,
    colors: Vec<String>,
) -> Result<Snapshot, String> {
    let mut out: Vec<String> = Vec::new();
    for c in colors {
        let c = c.trim().to_uppercase();
        if c.is_empty() || out.contains(&c) || out.len() >= 24 { continue; }
        out.push(c);
    }
    store::with_config(dir, |cfg| {
        cfg.custom_colors = out.clone();
        Ok(snapshot(dir, cfg))
    })
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
///
/// 列目录也是"读"（目录结构本身就算信息），所以一并收口。
/// 前端唯一的调用点传的是"内容区焦点目录" = 选中的项目/项目组卡片，
/// 必然在允许范围内，收口不影响正常用法。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_scan_content(
    app: AppHandle,
    state: State<'_, FpxState>,
    root: String,
    kind: Option<String>,
) -> Vec<ContentItem> {
    // 收口失败时返回空列表而不是报错：这是"浏览"接口，
    // 空列表在界面上就是"没有内容"，比弹一个错误更贴合语义
    match store::data_dir(&app, &state) {
        Ok(dir) if ensure_path_allowed(&dir, &root).is_ok() => {
            content::scan(&root, kind.as_deref().unwrap_or("all"))
        }
        _ => Vec::new(),
    }
}

/// 读取文件文本（目录型 skill 自动读其 SKILL.md）。
///
/// 路径必须落在允许范围内（页签卡片 / 用户配置的目录 / 数据目录），
/// 越权一律拒绝 —— 此前这里是裸透传，等于任意文件读。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_read_file(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    max: Option<usize>,
) -> Result<String, String> {
    let dir = store::data_dir(&app, &state)?;
    core_read_file(&dir, &path, max)
}

/// 打开路径。mode: auto | dir | containing | editor
/// 写系统剪贴板。
///
/// 为什么要走后端：插件跑在沙箱 iframe 里，外壳没有给 `allow-clipboard-write`，
/// `navigator.clipboard` 拿不到权限，前端复制会**静默失败**（点了没反应也不报错）。
/// 后端直接调各平台自带命令，不受 iframe 权限限制。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_copy_text(text: String) -> Result<bool, String> {
    if text.is_empty() {
        return Err("复制内容为空".into());
    }
    Ok(chain::set_clipboard(&text))
}

#[tauri::command(rename_all = "snake_case")]
pub fn fpx_open_path(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    mode: Option<String>,
) -> Result<(), String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    /* 必须收口：mode=auto 会交给系统默认程序打开，在 Windows 上
       `start "" <path>` 对 .exe/.bat 就是**执行**，等于一条任意执行通道；
       mode=editor 则用配置的编辑器打开任意文件。
       前端的所有调用点传的都是"卡片路径 / 卡片下的内容项 / 数据目录"，
       全在允许范围内，所以收口不会影响正常用法。 */
    ensure_path_in(&dir, &cfg, &path)?;
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
    /* 父目录不能是系统目录 / 整块盘。
       为什么这条独立于白名单：用户在"选择目录"对话框里挑什么，
       白名单随后就会把它加进去 —— 只有这张表拦得住（清单 P1-5/6/7 的护栏部分）。 */
    guard::reject_forbidden_raw(parent)?;
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
    // 同 core_save_style：会写 desktop.ini，只认已登记的卡片
    ensure_path_allowed(&dir, &path)?;
    let icon = icon_ref.unwrap_or_default();
    let key = store::normalize_key(&path);

    // desktop.ini 写入失败只算警告：配置改动仍要落盘，所以不做成闭包 Err
    // （闭包返回 Err 会跳过保存），而是带出来交给外层决定。
    let (snap, warn) = store::with_config(&dir, |cfg| {
        let affect = affect_explorer.unwrap_or(cfg.icon_affect_explorer);
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
        Ok((snapshot(&dir, cfg), warn))
    })?;

    match warn {
        Some(w) => Err(w),
        None => Ok(snap),
    }
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
///
/// 只接受数据目录 icons/ 下的文件、以及配置里已登记过的图标引用 ——
/// 此前只查 `is_file()`，任意 ≤2MB 的文件都能被读成 data URI。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_icon_data(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
) -> Result<String, String> {
    let dir = store::data_dir(&app, &state)?;
    core_icon_data(&dir, &path)
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

/// 在文件管理器里打开项目 / 项目组的备份目录。
/// 目录可能还没建（一次都没备份过），这里不 create_dir_all ——
/// 让用户看到"确实还没有"，比凭空造个空目录更容易理解。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_open_backup_dir(
    app: AppHandle,
    state: State<'_, FpxState>,
    kind: String,
) -> Result<(), String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    // 与备份时用的是同一个 resolver，保证"打开的就是实际写入的那个目录"
    let target = backup::resolve_dir(&cfg, &dir, if kind == "group" { "group" } else { "project" });
    sys::open_path(&target.to_string_lossy(), "dir", "")
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

    // 目标目录是"顺带记住"，单独一次短事务，不与下面数秒的备份抢锁
    if let Some(t) = target {
        let t = t.trim().to_string();
        /* 备份目标由用户现挑，可能尚未登记 → 只过黑名单（系统目录 / 整块盘）。
           把整盘或 C:\Windows 设成备份落点会瞬间写满或污染系统目录。 */
        if !t.is_empty() {
            guard::reject_forbidden_raw(&t)?;
        }
        store::with_config(&dir, |cfg| {
            cfg.backup_dir = if t.is_empty() { None } else { Some(t.clone()) };
            Ok(())
        })?;
    }

    // 备份要整树遍历，可能持续数秒。同步命令跑在主线程会卡死窗口，
    // 所以挪到阻塞线程池（async_runtime::spawn_blocking）。
    // 关键：绝不能把这段放进 with_config —— 那会让配置锁被占住好几秒，
    // 期间 MCP 与其它命令全部阻塞。这里只读一次配置即可（备份过程不写配置）。
    let cfg = store::load_config(&dir);
    let ao = append_only.unwrap_or(cfg.backup_append_only);
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
    let want_refresh = refresh.unwrap_or(false);

    {
        let cfg = store::load_config(&dir);
        if !want_refresh && !cfg.editor_pick_cache.is_empty() {
            return Ok(cfg.editor_pick_cache.iter()
                .map(|c| editor::EditorCandidate { name: c.name.clone(), exe: c.exe.clone() })
                .collect());
        }
    }

    // 扫 PATH + reg query，可能数秒。必须在锁外跑，理由同 fpx_backup。
    let r = tauri::async_runtime::spawn_blocking(editor::enumerate)
        .await
        .map_err(|e| format!("枚举编辑器异常终止: {e}"))?;

    // 缓存只存名称与 exe；exe 可能随后被卸载，但不影响——真正打开前会再校验存在性。
    // 这里重新 load 而不是复用扫描前那份：扫描耗时数秒，期间配置很可能已经变了，
    // 拿旧快照写回会把别人的改动整份覆盖。只改自己这个字段最安全。
    store::with_config(&dir, |cfg| {
        cfg.editor_pick_cache = r.iter()
            .map(|c| model::EditorPickCacheItem { name: c.name.clone(), exe: c.exe.clone() })
            .collect();
        Ok(())
    })?;
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
    let p = path.trim().to_string();
    store::with_config(&dir, |cfg| {
        cfg.edit_tool_path = if p.is_empty() { None } else { Some(p.clone()) };
        Ok(snapshot(&dir, cfg))
    })
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
    /* 会按配置里的编辑器路径拉起外部程序打开它 —— 那是"用别的程序打开
       任意文件"，所以必须收口到已登记的卡片（清单 P1-5 的一类）。 */
    ensure_path_in(&dir, &cfg, &path)?;
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
    /* 跨栏拖动可能触发物理搬家（sys::relocate_cross_move），
       所以被拖的必须是已登记的卡片。 */
    ensure_path_allowed(&dir, &path)?;
    let idx = dst_tab_index.unwrap_or(0);

    store::with_config(&dir, |cfg| {
        // 物理搬家（可能返回"无需搬"= None）
        let relocated = if cfg.move_folder_on_cross_move {
            sys::relocate_cross_move(cfg, &path, &dst_kind)?
        } else {
            None
        };
        let final_path = relocated.clone().unwrap_or_else(|| path.clone());

        // 卡片换栏：从源类别**全部**页签摘除（同一路径可能被登记在多个页签里），
        // 再插入目标类别页签末尾。两个分支分开写，避免同时对 cfg 的两个字段做可变借用。
        if from_kind == "project" {
            sys::remove_card_from_tabs(&mut cfg.project_tabs, &path);
            sys::insert_card_into_tab(&mut cfg.group_tabs, idx, usize::MAX, &final_path);
        } else {
            sys::remove_card_from_tabs(&mut cfg.group_tabs, &path);
            sys::insert_card_into_tab(&mut cfg.project_tabs, idx, usize::MAX, &final_path);
        }

        Ok(model::MoveAcrossResult { snapshot: snapshot(&dir, cfg), relocated })
    })
}

/// 给项目/项目组文件夹改名（物理 rename + 同步页签、链接记录、图标/颜色/锁）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_rename_folder(
    app: AppHandle,
    state: State<'_, FpxState>,
    kind: String,
    path: String,
    new_name: String,
) -> Result<model::RenameResult, String> {
    let dir = store::data_dir(&app, &state)?;
    core_rename_folder(&dir, &kind, &path, &new_name)
}

/// 搬家：把项目 / 项目组文件夹移到别的父目录下。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_move_folder(
    app: AppHandle,
    state: State<'_, FpxState>,
    kind: String,
    path: String,
    dest_parent: String,
) -> Result<model::RenameResult, String> {
    let dir = store::data_dir(&app, &state)?;
    core_move_folder(&dir, &kind, &path, &dest_parent)
}

/// 给内容区（agent / skill / rule）条目改名。
///
/// 目录型 skill 整体就是一个 skill，改名即改目录名；其余改文件名（保留扩展名）。
/// 只动磁盘，不涉及配置登记——内容条目不在页签 / 链接记录里留痕。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_rename_content_item(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    new_name: String,
) -> Result<model::ContentRenameResult, String> {
    /* AppHandle / State 由 Tauri 自动注入，前端不用改调用参数 ——
       这里加上只为拿到数据目录做路径收口。 */
    let dir = store::data_dir(&app, &state)?;
    ensure_path_allowed(&dir, &path)?;

    // 同 core_rename_folder：与新建共用 sys::validate_name，
    // 补齐「. / .. / 纯点串」与「长度上限 120」两项此处漏掉的检查。
    let name = sys::validate_name(&new_name)?;

    let old = std::path::Path::new(&path);
    if !old.exists() {
        return Err(format!("条目不存在：{path}"));
    }

    // 目录（目录型 skill）直接换末段；文件则保留扩展名，只改主名
    let new_path = if old.is_dir() {
        replace_last_segment(&path, &name)
    } else {
        let ext = old
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        replace_last_segment(&path, &format!("{name}{ext}"))
    };

    let old_file = old.file_name().map(|s| s.to_string_lossy().to_string());
    let new_file = std::path::Path::new(&new_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string());
    if old_file == new_file {
        return Err("新名称与当前名称相同".into());
    }
    if std::path::Path::new(&new_path).exists() {
        return Err(format!("目标位置已存在同名条目：{new_path}"));
    }

    std::fs::rename(old, &new_path).map_err(|e| format!("改名失败：{e}"))?;
    Ok(model::ContentRenameResult { new_path })
}

/// 清除无效项：摘掉页签里已不存在的路径，并清理指向它们的链接记录。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_clear_invalid(
    app: AppHandle,
    state: State<'_, FpxState>,
) -> Result<model::ClearResult, String> {
    let dir = store::data_dir(&app, &state)?;
    core_clear_invalid(&dir)
}

/// 保存用户手动添加的连锁客户端清单。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_save_chain_clients(
    app: AppHandle,
    state: State<'_, FpxState>,
    clients: Vec<model::CustomChainClient>,
) -> Result<Vec<chain::ChainClient>, String> {
    let dir = store::data_dir(&app, &state)?;

    // 清洗放锁外：纯 CPU，不碰配置，没必要占着锁
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

    store::with_config(&dir, |cfg| {
        cfg.custom_chain_clients = list.clone();
        Ok(())
    })?;
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
    // ensure_actions 可能补齐了内置项，落盘以免下次又补一遍
    store::with_config(&dir, |cfg| Ok(chain::ensure_actions(cfg)))
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

    // 清洗放锁外：纯 CPU，不碰配置
    let mut list: Vec<model::ChainActionItem> = actions
        .into_iter()
        .filter(|a| !a.id.trim().is_empty())
        .collect();
    // id 去重：前端不会造重复，但手工改配置会，这里兜底
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    list.retain(|a| seen.insert(a.id.clone()));

    store::with_config(&dir, |cfg| {
        cfg.chain_actions = Some(list.clone());
        Ok(())
    })?;
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
    // 不能再包一层 Ok：screen::capture 本身就返回 Result，
    // 而上面只 ? 掉了 spawn_blocking 的 JoinError，
    // 此时 r 已经是 Result<CaptureResult, String>，直接返回即可。
    tauri::async_runtime::spawn_blocking(move || screen::capture(&shots))
        .await
        .map_err(|e| format!("截图任务异常终止: {e}"))?
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
pub(crate) struct LockGuard {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个本次测试专用的临时目录（进程内唯一，测完即删）。
    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir()
            .join(format!("nexus_fpx_{tag}_{}_{}", std::process::id(), nanos));
        std::fs::create_dir_all(&p).expect("建临时目录失败");
        p
    }

    /* 这两条对应审查清单的 P0-3 / P0-4：
       改动前 `core_read_file` / `core_icon_data` 的前身可以读任意文件，
       实测连 `C:/Windows/win.ini` 与应用自己的设备盐都能读出来。 */

    #[test]
    fn read_file_rejects_path_outside_roots() {
        let dir = tmpdir("read");
        let inside = dir.join("note.md");
        std::fs::write(&inside, "hello").unwrap();
        // 数据目录内：放行（它是兜底 root）
        assert!(core_read_file(&dir, &inside.to_string_lossy(), None).is_ok());

        let outside = tmpdir("read_out");
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "top secret").unwrap();
        let r = core_read_file(&dir, &secret.to_string_lossy(), None);
        assert!(r.is_err(), "范围外的文件居然读到了: {r:?}");
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn icon_data_only_accepts_data_dir_and_registered() {
        let dir = tmpdir("icon");
        let icons = dir.join("icons");
        std::fs::create_dir_all(&icons).unwrap();
        let mine = icons.join("a.ico");
        std::fs::write(&mine, "fake-icon-bytes").unwrap();
        assert!(core_icon_data(&dir, &mine.to_string_lossy()).is_ok());

        let outside = tmpdir("icon_out");
        let secret = outside.join("id_rsa");
        std::fs::write(&secret, "PRIVATE KEY").unwrap();
        let r = core_icon_data(&dir, &secret.to_string_lossy());
        assert!(r.is_err(), "任意文件被当图标读走了: {r:?}");
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn icon_file_part_strips_index_suffix() {
        assert_eq!(icon_file_part(r"C:\x\imageres.dll|3"), r"C:\x\imageres.dll");
        // 竖线后不是纯数字时不拆（那是文件名的一部分）
        assert_eq!(icon_file_part(r"C:\x\a|b.ico"), r"C:\x\a|b.ico");
        assert_eq!(icon_file_part(r"C:\x\a.ico"), r"C:\x\a.ico");
    }

    /* ---- 根约束（清单 P1-5/6/7） ---- */

    #[test]
    fn content_roots_covers_data_dir_and_cards() {
        let dir = tmpdir("roots");
        let mut cfg = FpxConfig::default();
        let card = dir.join("card");
        std::fs::create_dir_all(&card).unwrap();
        cfg.project_tabs[0].items.push(card.to_string_lossy().to_string());

        let roots = content_roots(&dir, &cfg);
        // 数据目录是兜底根，恒定在内
        let d = guard::canonical_root(&dir.to_string_lossy()).unwrap();
        assert!(roots.contains(&d), "数据目录应在允许范围内");
        // 页签卡片也要在内，否则所有卡片操作都会被拒
        let c = guard::canonical_root(&card.to_string_lossy()).unwrap();
        assert!(roots.contains(&c), "页签卡片应在允许范围内");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_path_allowed_rejects_outside() {
        let dir = tmpdir("allow");
        let inside = dir.join("card");
        std::fs::create_dir_all(&inside).unwrap();
        // 数据目录内的路径放行
        assert!(ensure_path_allowed(&dir, &inside.to_string_lossy()).is_ok());

        let outside = tmpdir("allow_out");
        let r = ensure_path_allowed(&dir, &outside.to_string_lossy());
        assert!(r.is_err(), "范围外的路径居然放行了: {r:?}");
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
