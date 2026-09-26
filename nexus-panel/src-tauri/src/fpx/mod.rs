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
    Bootstrap, ContentItem, DirEntryLite, FavDir, FpxConfig, LinkRecord, LinkRow, Snapshot, TabInfo,
    RenameIconResult,
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
        link_notices: Vec::new(),
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
    /*
     * #77 GUI 那套图标**同样**要进白名单。
     *
     * 只登记 explorer 那套的话，勾了「仅界面生效」设的图标文件**读不出来**
     * —— 而前端对读取失败是静默处理的，卡片图标默默变回占位符。
     * 取消勾选又能显示，表现得就像"这个开关有毛病"。
     */
    for v in cfg.folder_gui_icons.values() {
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

    /*
     * 与 `core_move_folder` 一样拆成三段，耗时 IO 不进事务。
     *
     * 此前整个「改名 → 同步 → 写回」都塞在 `with_config` 里，加上本轮要补的
     * junction 重建（项目组被十个项目引用就是二十次磁盘 IO），
     * 跨进程锁会被占住好几秒，而 `--mcp` 拉起的那个实例会因此等锁超时报错
     * （`core_move_folder` 那段注释讲过同一个道理）。
     */
    let cfg0 = store::load_config(dir);
    let lock_before = store::lock_of(&cfg0, path)
        .map(|l| (l.deny_delete, l.deny_write))
        .filter(|(d, w)| *d || *w);
    // 仅项目组改名需要重建 junction（项目改名的 junction 是其子项，随目录一起走）
    let kind_is_group = kind == "group";

    /* 抑制监控器（#411）：接下来要改名，而这个目录可能正被监控着。
       不抑制的话，监控线程下一次轮询会把它当成"有人动了受保护的文件夹"，
       弹一堆告警 —— 用户改个名就被自己吓一次。
       **必须在动手之前**登记，事后再补就漏掉了中间那次轮询。
       新旧路径都要登记：抑制键是路径，改名后监控的是新路径。 */
    watch::suppress(&[path.to_string(), new_path.clone()]);
    // 摘锁后才能 rename：受 ACL 保护的目录 rename 会被系统拒绝
    let _guard = LockGuard::new(path, store::lock_of(&cfg0, path));
    // 跨卷时 rename 必然失败，回退到"复制 + 删除"；
    // 回退的语义是"复制没成功就绝不删源"，不会留下两份残缺数据
    crate::fpx::fsutil::rename_with_fallback(old, std::path::Path::new(&new_path))
        .map_err(|e| format!("改名失败：{e}"))?;
    drop(_guard);

    /*
     * 原路径受 ACL 保护 → 对**新**路径重建保护（对齐原版 `RelocateCard` 第 4 步）。
     *
     * `LockGuard` 的 drop 是对**旧路径**恢复，而改名后旧路径已经不存在了 ——
     * 于是保护**静默丢失**：盾牌徽章还在（config 里的条目随后被 remap 成新路径），
     * 但磁盘上其实没锁。用户以为受着保护，实际一删就掉。
     */
    if let Some((dd, dw)) = lock_before {
        if let Err(e) = sys::apply_lock(&new_path, dd, dw) {
            eprintln!("[fpx] 对新路径重建 ACL 保护失败: {e}");
        }
    }

    /*
     * 改名时把备份根目录下对应的备份子目录一并改名（对齐原版
     * `RenameBackupFolder`：末级名对末级名）。
     *
     * 不同步的后果：备份目录里还留着旧名字的子目录，下次备份会**新建**一个
     * 新名字的目录 —— 于是同一个项目在备份区里躺了两份，一份是旧的、
     * 一份是新的，而用户在备份目录里翻的时候根本分不清该恢复哪一个。
     *
     * 失败只记录不中断：备份目录改名属于"顺手对齐"，
     * 不能因为它失败就把整个改名回滚（文件夹已经改完了）。
     */
    let mut backup_note = String::new();
    {
        let old_seg = std::path::Path::new(path)
            .file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let new_seg = std::path::Path::new(&new_path)
            .file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if !old_seg.is_empty() && !new_seg.is_empty() && !old_seg.eq_ignore_ascii_case(&new_seg) {
            let bkind = if kind_is_group { "group" } else { "project" };
            let root = backup::resolve_dir(&cfg0, dir, bkind);
            let old_bak = root.join(&old_seg);
            let new_bak = root.join(&new_seg);
            // 目标已存在则跳过：绝不覆盖一份已有的备份
            if old_bak.is_dir() && !new_bak.exists() {
                match std::fs::rename(&old_bak, &new_bak) {
                    Ok(_) => backup_note = format!("备份目录已同步改名：{}", new_seg),
                    Err(e) => eprintln!("[fpx] 备份目录改名失败 {} → {}: {e}", old_bak.display(), new_bak.display()),
                }
            }
        }
    }

    /*
     * 项目组改名要重建指向它的 junction（对齐原版 `RelocateCard` 第 2 步：
     * 「项目组改名/搬家须把指向旧路径的所有 junction 重建到新路径」）。
     *
     * 此前这里写死 `relinked: 0`，注释还写着"原版同样如此" ——
     * **那条注释是错的**：原版只在"项目搬家"时不重建（junction 是项目目录
     * 的子项，随目录一起挪走），项目组改名与搬家**都要**重建。
     *
     * 不重建的后果：改个名，所有指向它的链接**全部断掉**。
     * 界面上链接图标变红而用户不知道为什么 —— 他只是改了个名字。
     */
    let guide = store::load_records(dir);
    let mut relinked = 0usize;
    let mut relink_errors: Vec<String> = Vec::new();
    if kind_is_group {
        for r in guide.iter() {
            if store::normalize_key(&r.lib) != old_key { continue; }
            if !std::path::Path::new(&r.project).is_dir() { continue; }
            let names = r.link_names();
            if names.is_empty() { continue; }
            // 与搬家同一套：先删旧的（可能已断），再建指向新路径的。
            // 失败不中断：记录下来一并回传，让前端提示用户手动复查。
            let _ = junction::remove(&r.project, &names);
            match junction::create(&r.project, &new_path, &names) {
                Ok(_) => relinked += 1,
                Err(e) => relink_errors.push(format!("{}：{e}", r.project)),
            }
        }
    }
    drop(guide);

    // 整个「同步所有登记 → 写回」放进一个事务：
    // 期间不能被别的写入者（MCP 线程 / 其它命令）插进来，否则两边各自基于
    // 旧快照写回，后写的会把先写的整份覆盖。
    let (snap, tab_hits, rec_hits) = store::with_config(dir, |cfg| {
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
        /* #13 同上：改名后 GUI 图标若不跟着换键，等于静默丢掉 */
        cfg.folder_gui_icons = remap_keys(std::mem::take(&mut cfg.folder_gui_icons), &old_key, &new_path);
        cfg.tag_colors = remap_keys(std::mem::take(&mut cfg.tag_colors), &old_key, &new_path);
        /* #113 同上：改名换键两套都要跟着 */
        cfg.tag_gui_colors = remap_keys(std::mem::take(&mut cfg.tag_gui_colors), &old_key, &new_path);
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
        // 走 with_records：与 core_create_link / core_remove_link 保持一致。
        // 手写的 load → 改 → save 拿不到跨进程锁，AI 侧（--mcp 实例）若同时改账本，
        // 两边各自的整份写回会互相覆盖。
        // 这里嵌套在 with_config 内，acquire_data_lock 支持重入，复用外层已持有的锁。
        let rec_hits = store::with_records(dir, |records| {
            let mut hits = 0usize;
            for r in records.iter_mut() {
                if store::normalize_key(&r.project) == old_key {
                    r.project = new_path.clone();
                    hits += 1;
                }
                if store::normalize_key(&r.lib) == old_key {
                    r.lib = new_path.clone();
                    if !new_name.is_empty() { r.group = new_name.clone(); }
                }
            }
            Ok(hits)
        })?;

        Ok((snapshot(dir, cfg), tab_hits, rec_hits))
    })?;

    Ok(model::RenameResult {
        snapshot: snap,
        new_path,
        tab_hits,
        rec_hits,
        relinked,
        relink_errors,
        backup_note,
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

    /* 搬家拆成两段，中间不持跨进程锁。
       ------------------------------------------------------------------
       junction 的删与建是实打实的磁盘 IO：项目组被十个项目引用就是二十次，
       加上 rename，整段做下来是秒级。若整段塞进 with_config，跨进程锁会被
       占住好几秒，而 `--mcp` 拉起的那个实例会因此等锁超时报错
       （本文件里 fpx_list_editors 那段注释讲过同一个道理）。

       所以：耗时 IO 在外面做，只有"读 → 改 → 写"那一小段进临界区。 */

    // ---- 阶段一：摘 ACL 锁 + 物理移动（不持数据锁）----
    // lock_of 只需要读配置判断受保护与否，用只读快照即可，不必进事务。
    let cfg0 = store::load_config(dir);
    let lock_before = store::lock_of(&cfg0, path)
        .map(|l| (l.deny_delete, l.deny_write))
        .filter(|(d, w)| *d || *w);
    // 抑制监控器（#411），理由同上；源与目标都登记
    watch::suppress(&[path.to_string(), new_path.clone()]);
    let _guard = LockGuard::new(path, store::lock_of(&cfg0, path));
    std::fs::rename(old, &new_path).map_err(|e| format!("移动文件夹失败：{e}"))?;
    drop(_guard);

    /*
     * 与改名同理：受保护目录搬家后，要对**新**路径重建保护
     * （对齐原版 `RelocateCard` 第 4 步）。
     *
     * `LockGuard` 的 drop 恢复的是**旧路径**，而旧路径已经不存在 ——
     * 保护会静默丢失，盾牌徽章却还在（config 条目随后被 remap 到新路径），
     * 显示与实际情况不一致。
     */
    if let Some((dd, dw)) = lock_before {
        if let Err(e) = sys::apply_lock(&new_path, dd, dw) {
            eprintln!("[fpx] 对新路径重建 ACL 保护失败: {e}");
        }
    }

    // ---- 阶段二：junction 重建（不持数据锁）----
    // 项目组搬家：所有指向旧路径的 junction 全断了，必须逐个重建到新路径
    // （WPF RelocateCard / cli.rs 迁移脚本都是这么做的）。
    // 项目搬家则无需重建 —— junction 是项目目录的子项，随目录一起挪过去了。
    //
    // 只读一份账本来指路（谁引用了它）；写回在阶段三的事务里做。
    let guide = store::load_records(dir);
    let mut relinked = 0usize;
    let mut relink_errors: Vec<String> = Vec::new();

    // 只有项目组搬家需要重建（项目搬家时 lib 不指向它）
    if kind_is_group {
        for r in guide.iter() {
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
    drop(guide);

    // ---- 阶段三：事务内同步 config 与账本（临界区只有这段）----
    let (snap, tab_hits, rec_hits) = store::with_config(dir, |cfg| {
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
        /*
         * #13 同上：**跨栏搬家必须挪 GUI 图标表**。
         *
         * 此前这里只挪了两套（explorer 图标 + 普通色），而改名那条路径
         * 四套齐全。三处做的是同一件事，只有这里漏了 —— 表现为：
         * 勾了「仅界面生效」的图标 / 标签色，搬完家**静默回到默认**，
         * 一点报错都没有，用户只会以为搬家把设置弄丢了。
         */
        cfg.folder_gui_icons = remap_keys(std::mem::take(&mut cfg.folder_gui_icons), &old_key, &new_path);
        cfg.tag_colors = remap_keys(std::mem::take(&mut cfg.tag_colors), &old_key, &new_path);
        /* #113 同上：GUI 标签色同样是"仅界面生效"那套，漏了同样静默丢失 */
        cfg.tag_gui_colors = remap_keys(std::mem::take(&mut cfg.tag_gui_colors), &old_key, &new_path);
        for l in cfg.locks.iter_mut() {
            if store::normalize_key(&l.path) == old_key {
                l.path = new_path.clone();
            }
        }

        // 账本同样走事务，理由与改名那条注释一致：手写 load → 改 → save
        // 拿不到跨进程锁，AI 侧的改动会被这里的整份写回盖掉。
        // 嵌套在 with_config 内，acquire_data_lock 支持重入，复用外层已持有的锁。
        let rec_hits = store::with_records(dir, |records| {
            let mut hits = 0usize;
            for r in records.iter_mut() {
                if store::normalize_key(&r.project) == old_key {
                    r.project = new_path.clone();
                    hits += 1;
                }
                if store::normalize_key(&r.lib) == old_key {
                    r.lib = new_path.clone();
                }
            }
            Ok(hits)
        })?;

        Ok((snapshot(dir, cfg), tab_hits, rec_hits))
    })?;

    Ok(model::RenameResult {
        snapshot: snap,
        new_path: new_path.clone(),
        tab_hits,
        rec_hits,
        relinked,
        relink_errors,
        // 搬家不改末级名，备份子目录名不变，无需同步
        backup_note: String::new(),
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
      //
      // 走 with_records 而不是手写的 load → 改 → save：后者只在 save 那一刻
      // 碰得到磁盘，挡不住"过期快照覆盖"——MCP 侧若在此期间新增/删除了链接，
      // 这里的整份写回会把它的改动盖掉，且没有任何提示。
      let rec_hits = store::with_records(dir, |records| {
          let before = records.len();
          records.retain(|r| std::path::Path::new(&r.project).exists());
          Ok(before - records.len())
      })?;

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
        /* 版本号一律改写为**当前**的，不沿用前端传来的值。
           前端拿到的快照可能是旧版本（比如刚从 v1 配置读出来还没写回），
           照抄就会把"未迁移"这个状态一直传下去。 */
        cfg.schema_version = model::CURRENT_SCHEMA;
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

/**
 * #200 把该项目的链接**同步成**指定的这几个名字（取消勾选 = 删掉、释放名字）。
 *
 * 与 `core_create_link` 的区别必须分清：
 *   · create = **补充建**（并入已有清单），不删任何东西
 *   · sync   = **设成这几个**（多退少补），未列名的会被删掉
 * 两者混用会让"取消勾选"看起来生效了（对话框关了），链接却还在。
 *
 * ## 为什么未列名的要全部删，而不是只删"本组已占用"的
 *
 * 账本里一个项目**只有一条**记录，`group` 字段只有一个值 ——
 * 它表达不了"A 名字指向甲组、B 名字指向乙组"。
 * 所以只要这次的目标组与记录里的不同（换绑），旧链接就必须全部断掉：
 * 留着它们在磁盘上指向旧组，账本里却查不到，正是 #202 那类"静默残骸"。
 *
 * ## 含"已失效旧名"一并清理
 *
 * 账本里可能记着早已不存在（被手动删掉）的名字。它们不在 `names` 里，
 * 走同一条删除路径 —— `junction::remove` 对不存在的链接是安全的，
 * 于是"账本里的垃圾名"顺便被清掉，不必另写一遍清理逻辑。
 */
pub(crate) fn core_sync_links(
    dir: &std::path::Path,
    project: &str,
    group: &str,
    names: Vec<String>,
) -> Result<Snapshot, String> {
    let cfg = store::load_config(dir);
    ensure_path_in(dir, &cfg, project)?;
    ensure_path_in(dir, &cfg, group)?;
    guard::reject_forbidden_raw(project)?;
    guard::reject_forbidden_raw(group)?;

    let key = store::normalize_key(project);
    let prev: Vec<String> = store::load_records(dir)
        .iter()
        .find(|r| store::normalize_key(&r.project) == key)
        .map(|r| r.link_names())
        .unwrap_or_default();

    /*
     * 逐名查**磁盘实际**目标（对齐原版 ApplyLinkPick 里的 ownedByThis /
     * InspectOwnership）。读不到或目标已不存在 = None。
     */
    let target_key = store::normalize_key(group);
    let resolve_of = |n: &str| -> Option<String> {
        junction::resolve_target(&junction::link_path(project, n))
            .filter(|t| !t.is_empty() && std::path::Path::new(t).exists())
    };

    // 不在本次名单里的才需要判断去留（大小写不敏感比对，理由同 #91）
    let outside: Vec<String> = prev
        .iter()
        .filter(|n| !names.iter().any(|x| x.eq_ignore_ascii_case(n)))
        .cloned()
        .collect();

    /*
     * 被**普通目录/文件**占用的名字（不是链接）。
     *
     * 这些绝不能删：里面是用户的真实内容，删了就找不回来。
     * 但也不能**静默略过** —— 用户以为勾了就建好了，实际那个名字没动。
     * 所以单独收集、写进说明带回前端。
     */
    let occupied: Vec<String> = outside
        .iter()
        .filter(|n| junction::link_state(project, n) == junction::LinkState::Conflict)
        .cloned()
        .collect();

    let mut notices: Vec<String> = Vec::new();
    for n in &occupied {
        notices.push(format!(
            "{} 已被普通目录/文件占用，为避免误删内容已跳过，请手动处理",
            junction::link_path(project, n).display()
        ));
    }

    /*
     * 删 junction：只删**确实指向本次目标组**的那些（原版 ownedByThis）。
     *
     * 为什么不能"不在名单里的全删"：
     * 一个项目的不同链接名**可以指向不同的组**（手工建、或从别处迁移过来
     * 就会出现）。用户这次只是在「乙组」下加/改链接，若把账本里所有没勾的
     * 都删掉，指向「甲组」的那几个**会一起消失** ——
     * 而他根本没对甲组做过任何操作。这类"改了不该改的地方"没有任何报错，
     * 用户只会发现别处的链接莫名其妙断了。
     */
    let to_remove: Vec<String> = outside
        .iter()
        .filter(|n| resolve_of(n)
            .map(|t| store::normalize_key(&t) == target_key)
            .unwrap_or(false))
        .cloned()
        .collect();

    /*
     * 账本要剔除的：不在名单里**且未被其它组占用**的。
     *
     * 比 `to_remove` 多一类「已失效的旧名」（读不到实际目标）——
     * 它们没有真实链接，留着只会让界面显示一条连不上的链接。
     * 而**指向别组的一律保留在账本里**（原版 InspectOwnership 判定），
     * 否则那个链接会变成账本里查不到的"静默残骸"（同 #202）。
     */
    let cancelled: Vec<String> = outside
        .iter()
        .filter(|n| match resolve_of(n) {
            None => true,                                              // 失效
            Some(t) => store::normalize_key(&t) == target_key,         // 本组
        })
        /* 被真实内容占用的**保留在账本里**：剔掉会变成账本里查不到的
           "静默残骸"（同 #202）—— 链接还在、界面却不显示，用户无从处理。 */
        .filter(|n| !occupied.iter().any(|x| x.eq_ignore_ascii_case(n)))
        .cloned()
        .collect();

    let mut err: Option<String> = None;
    let _guard = LockGuard::new(project, store::lock_of(&cfg, project));
    for n in &names {
        match junction::create(project, group, std::slice::from_ref(n)) {
            Ok(_) => {}
            Err(e) => { err = Some(e); break; }
        }
    }
    if err.is_none() && !to_remove.is_empty() {
        if let Err(e) = junction::remove(project, &to_remove) {
            err = Some(e);
        }
    }
    drop(_guard);

    /*
     * 账本写成**磁盘实际状态**：建成功的 + 删除失败的。
     * 不直接写 names —— 那样"删失败但记录已删"会让磁盘上仍存在的链接
     * 在账本里消失（同 #202）。
     */
    let removed_ok: Vec<String> = if err.is_none() {
        to_remove.clone()
    } else {
        /* 中途失败：只把确实已删掉的排除掉，逐个确认过才算 */
        to_remove.iter()
            .filter(|n| !junction::link_path(project, n).exists())
            .cloned()
            .collect()
    };
    /*
     * 从账本里真正剔除的 = 删成功的 ∪ 本来就失效的。
     *
     * **不**直接剔除 `cancelled`：里面可能包含"删失败"的（junction 还在），
     * 剔掉会让磁盘上仍存在的链接在账本里消失（同 #202 那类静默残骸）。
     */
    let gone: Vec<String> = cancelled
        .iter()
        .filter(|n| removed_ok.iter().any(|x| x.eq_ignore_ascii_case(n))
            || resolve_of(n).is_none())
        .cloned()
        .collect();
    let final_names: Vec<String> = {
        let mut acc: Vec<String> = Vec::new();
        for n in &prev {
            if gone.iter().any(|x| x.eq_ignore_ascii_case(n)) { continue; }
            merge_link_names(&mut acc, vec![n.clone()]);
        }
        merge_link_names(&mut acc, names.clone());
        acc
    };

    store::with_records(dir, |records| {
        if final_names.is_empty() {
            /* #201 一个链接都不剩 → 移除整条记录，而不是留一条空 names 的 */
            records.retain(|r| store::normalize_key(&r.project) != key);
        } else {
            upsert_record(records, project, group, final_names);
        }
        Ok(())
    })?;

    let mut snap = snapshot(dir, &cfg);
    /*
     * 说明**始终**带回：操作成功时它是唯一能把"有名字没处理"告诉用户的通道。
     * 走 Err 会把一次成功报成失败。
     */
    snap.link_notices = std::mem::take(&mut notices);

    if let Some(e) = err {
        /*
         * 部分失败时把说明**并进**错误信息：
         * 否则这条 Err 返回后快照整个丢了，说明也随之消失 ——
         * 恰恰是最需要说明的场合（有名字没处理 + 有操作失败）反而看不见。
         */
        let extra = if snap.link_notices.is_empty() {
            String::new()
        } else {
            format!("；{}", snap.link_notices.join("；"))
        };
        return Err(format!("同步链接时部分失败：{e}{extra}"));
    }
    Ok(snap)
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
    account_only: bool,
) -> Result<Snapshot, String> {
    /* ACL 是写操作：给系统目录设防删/防写，等于把系统锁死一半。
       这一条不加会是什么后果 —— 用户误选了 C:\Windows 加锁，
       界面上点"解锁"还不一定解得开（ACL 已被改写）。 */
    guard::reject_forbidden_raw(path)?;
    ensure_path_allowed(dir, path)?;
    store::with_config(dir, |cfg| {
        let key = store::normalize_key(path);
        let prev = cfg.locks.iter()
            .find(|l| store::normalize_key(&l.path) == key)
            .map(|l| (l.deny_delete, l.deny_write));

        /*
         * **账面固定不落 ACL**（#21）：只登记，不碰系统权限。
         *
         * 但**从 ACL 切回账面固定时，原来那条 ACL 必须真的撤掉** ——
         * 否则系统会拦着删/写，界面却显示"仅固定、没保护"，
         * 用户照着界面去删，撞上一条看不见的权限。
         * 这正是"两件事"最容易出错的接缝处。
         */
        let want_acl = deny_delete || deny_write;
        if want_acl || prev.unwrap_or((false, false)).0 || prev.unwrap_or((false, false)).1 {
            // 先落 ACL 再记配置：apply_lock 失败时闭包返回 Err，配置不会落盘
            sys::apply_lock(path, deny_delete, deny_write)?;
        }

        cfg.locks.retain(|l| store::normalize_key(&l.path) != key);
        if want_acl || account_only {
            cfg.locks.push(model::LockItem {
                path: path.to_string(),
                deny_delete,
                deny_write,
                account_only,
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
    gui_only: bool,
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
    /* #113 两套标签色：只动目标那一套（与 core_set_tag_color 同一规则） */
    let color_table = if gui_only { &mut cfg.tag_gui_colors } else { &mut cfg.tag_colors };
    match color {
        Some(c) => { color_table.insert(path.to_string(), c); }
        None => { color_table.remove(path); }
    }

    let icon = icon_ref.unwrap_or_default();
    let icon = icon.trim().to_string();
    /*
     * #77 图标**同样**要按 gui_only 分流。
     *
     * 此前只分流了标签色，图标这半边被无条件写进 `folder_icons`。
     * 而 `StyleDialog`（右键「图标与标签…」）走的就是这条路径 —— 也就是
     * 用户勾「仅界面生效」设图标的那个入口。三重后果，一条都不报错：
     *   1. `folder_gui_icons` 永远写不进去 —— 界面那套根本没登记；
     *   2. 反而把 `folder_icons`（资源管理器那套）**覆盖掉** —— 两套的定义
     *      就是"互不覆盖"，用户只是想在本工具里换个图标，
     *      资源管理器里那个也被换了；
     *   3. desktop.ini 照写 —— 与"不影响资源管理器"直接矛盾。
     */
    let key = store::normalize_key(path);
    if gui_only {
        cfg.folder_gui_icons.retain(|k, _| store::normalize_key(k) != key);
        if !icon.is_empty() {
            cfg.folder_gui_icons.insert(path.to_string(), icon.clone());
        }
    } else {
        cfg.folder_icons.retain(|k, _| store::normalize_key(k) != key);
        if !icon.is_empty() {
            cfg.folder_icons.insert(path.to_string(), icon.clone());
        }
    }

    // desktop.ini 是 Windows 资源管理器专属机制，其它平台只记在配置里（界面内仍生效）
    // GUI 专属图标**不写** desktop.ini —— 它的定义就是"不影响资源管理器"。
    if cfg.icon_affect_explorer && !gui_only && cfg!(windows) {
        /* #427：写 desktop.ini 就是往这个目录里写点。
           目录自己被设了「防写入」的话，这次写入会被**自己的锁**拦掉 ——
           用户设了保护之后就再也换不了图标，且报错信息完全指向不了原因。
           所以要放进临时摘锁窗口。 */
        /* 中文/含空格的图标路径写进 desktop.ini 可能让 Shell 读不出来 ——
           这里换成一个纯 ASCII 的副本路径（见 stable_icon_ref）。 */
        let shell_icon = stable_icon_ref(&dir.join("icons"), &icon);
        with_unlock(dir, path, || sys::apply_icon(path, &shell_icon))?;
    }

    Ok(snapshot(dir, cfg))
    })
}


/// 只改标签色，不碰图标。
///
/// 与 core_save_style 分开是为了避免「为了保留旧图标而先读一次配置」的写法：
/// 那种写法在并发下会把读到的旧图标值写回，覆盖期间别人设的新图标。
/// 只改自己关心的字段，其余留给事务里的磁盘最新值。
/**
 * #165 合法色值：`#RGB` 或 `#RRGGBB`（字母大小写不限，存之前统一转大写）。
 *
 * 为什么要在**写入时**挡住：非法值存进配置后，前端 `brushVars` 会返回 `{}`
 * （解析失败即降级），卡片就走"无标签色"分支 —— 界面上**看不出任何异常**，
 * 只是"设了颜色却不生效"，也没有报错。这正是最难被发现的那一类问题。
 *
 * 注意**只在写时校验，读时不动**：存量配置里可能已经躺着非法值，
 * 读时一并拒绝会让这些卡片连现有颜色都显示不出来，比现状更糟。
 */
pub(crate) fn is_hex_color(c: &str) -> bool {
    let b = c.as_bytes();
    if b.first() != Some(&b'#') { return false; }
    let hex = &b[1..];
    (hex.len() == 3 || hex.len() == 6) && hex.iter().all(|x| x.is_ascii_hexdigit())
}

pub(crate) fn core_set_tag_color(
    dir: &std::path::Path,
    path: &str,
    color: Option<String>,
    gui_only: bool,
) -> Result<Snapshot, String> {
    store::with_config(dir, |cfg| {
        // 空串 / null 视为恢复默认（删除记录）
        let c = color.as_deref().unwrap_or_default().trim().to_uppercase();
        /*
         * #113 两套标签色：**只动目标那一套**。
         * 设 GUI 色不该把普通色也删掉（反之亦然）——
         * 两套是独立的，清空其中一套不能影响另一套。
         */
        let table = if gui_only { &mut cfg.tag_gui_colors } else { &mut cfg.tag_colors };
        if c.is_empty() {
            table.remove(path);
        } else {
            /* #165 挡在写入前：存进去再降级，用户只会觉得"设了没反应" */
            if !is_hex_color(&c) {
                return Err(format!("非法色值「{c}」，应为 #RRGGBB 或 #RGB"));
            }
            table.insert(path.to_string(), c);
        }
        Ok(snapshot(dir, cfg))
    })
}

/// 常用文件夹上限。前端 fav-dirs.js 的 FAV_MAX 必须与这里一致，
/// 否则会出现"界面上能加、存回去被截断"，且不报错。
pub(crate) const FAV_DIR_MAX: usize = 40;

/// 路径归一化：统一斜杠、去尾部斜杠。
///
/// 【为什么必须归一化】
/// 不去尾部斜杠，`D:\work` 与 `D:\work\` 会被判成两条收藏 ——
/// 界面上出现两个一模一样的条目，删掉一个另一个还在，且不报错。
///
/// 【根目录要留那一根斜杠】
/// `/` 去尾会变成空串，Unix 下就回不到根了。
fn fav_norm_path(p: &str) -> String {
    let s = p.trim().replace('\\', "/");
    if s.is_empty() { return String::new(); }
    if s.len() == 1 { return s; }
    let t = s.trim_end_matches('/');
    if t.is_empty() { return "/".to_string(); }
    t.to_string()
}

pub(crate) fn core_list_fav_dirs(dir: &std::path::Path) -> Vec<FavDir> {
    let cfg = match store::load_config(dir) { Ok(c) => c, Err(_) => return Vec::new() };
    cfg.fav_dirs.clone()
}

/// 整表替换（去重保序、归一化、截断）。
///
/// 【为什么是整表替换而不是单条增删改】
/// 三个界面（选择器 / 设置页 / 将来的调用方）都要改这张表，
/// 单条增删改要给每种改动配一条命令（add/remove/rename），
/// 而"改名"本质是"先读全表、改一条、写回"—— 前端已经在做了，
/// 再拆成命令只是把同样的逻辑在 Rust 侧重写一遍。
pub(crate) fn core_save_fav_dirs(
    dir: &std::path::Path,
    dirs: Vec<FavDir>,
) -> Result<Snapshot, String> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<FavDir> = Vec::new();
    for d in dirs {
        let path = fav_norm_path(&d.path);
        if path.is_empty() || out.len() >= FAV_DIR_MAX { continue; }
        let key = path.to_lowercase();
        if seen.contains(&key) { continue; }
        seen.push(key);
        let label = d.label
            .as_deref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        out.push(FavDir { path, label });
    }
    store::with_config(dir, |cfg| {
        cfg.fav_dirs = out.clone();
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
    /*
     * 启动自愈：按 config.locks **幂等**重建 ACE（对齐原版 SweepRepair）。
     *
     * 解决的是"上次异常退出 / icacls 中途失败 / 外部拆锁"留下的不一致。
     * 只在**实际状态与期望不符**时才写（sweep_repair 内部先 lock_state 比对），
     * 已符合就免写 —— 不为每条锁白跑一次 icacls /deny。
     *
     * 两条硬约束：
     *   · account_only（账面固定）**必须跳过**：它明确"不动系统权限"，
     *     自愈若给它落 ACL，等于替用户取消了这个选择，且他会以为自己没开过锁；
     *   · 失败**绝不阻断启动**，只把逐条错误并进 notices ——
     *     因自愈失败而让软件起不来是最糟的结果。
     */
    let mut notices = store::config_issues(&dir);
    if !cfg.locks.is_empty() {
        let desired: Vec<(String, bool, bool)> = cfg.locks.iter()
            .filter(|l| !l.account_only)
            .map(|l| (l.path.clone(), l.deny_delete, l.deny_write))
            .collect();
        if !desired.is_empty() {
            for e in sys::sweep_repair(&desired, &[]) {
                notices.push(format!("[ACL 自愈] {e}"));
            }
        }
    }

    Ok(Bootstrap {
        // 体检放在构造里算一次：启动只读一处，不值得单独暴露成命令
        config_notices: notices,
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

/// #200 把项目的链接同步成指定的这几个名字（取消勾选 = 删除并释放名字）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_sync_links(
    app: AppHandle,
    state: State<'_, FpxState>,
    project: String,
    group: String,
    names: Vec<String>,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    core_sync_links(&dir, &project, &group, names)
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

/// 移除卡片（#83）。
///
/// 除了把它从页签里摘掉，还可以一并清理**它留下的痕迹**：
/// 链接（junction）、图标登记、标签色。
///
/// 三个开关都是"**保留**"语义且默认 true —— 与改造前的行为一致
/// （此前移除只摘页签、其它一律留着），不会有人因为升级就丢数据。
///
/// ## 一个必须守住的约束：只在"已经不在任何页签里"时才清理
///
/// 同一张卡片可以同时登记在多个页签里。从页签 A 移除时若顺手清掉图标，
/// **页签 B 里那张卡也跟着没了图标**，而用户只要求移除 A 里的那张。
/// 这种"改了不该改的地方"没有报错，用户只会觉得图标莫名其妙丢了。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_remove_card(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    kind: Option<String>,
    tab_index: Option<usize>,
    keep_link: Option<bool>,
    keep_icon: Option<bool>,
    keep_color: Option<bool>,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    let kind = kind.as_deref().unwrap_or("project");
    let key = store::normalize_key(&path);
    let still = |cfg: &FpxConfig| -> bool {
        let tabs = if kind == "group" { &cfg.group_tabs } else { &cfg.project_tabs };
        tabs.iter().any(|t| t.items.iter().any(|p| store::normalize_key(p) == key))
    };

    // 1) 摘页签 + 清图标 / 标签色（一个事务）
    let (snap, need_unlink) = store::with_config(&dir, |cfg| {
        let tabs = if kind == "group" { &mut cfg.group_tabs } else { &mut cfg.project_tabs };
        match tab_index {
            Some(i) => {
                /*
                 * 越界必须**报错**，不能 `if let` 静默跳过。
                 *
                 * 静默时：不删、不报错，外层照常返回一份"成功"的快照
                 * （只是没变）。调用方照常记一句"已移除"，卡片却还在
                 * 界面上 —— 用户点删除没有任何反馈，刷新后卡片仍在，
                 * 只能归结为"按钮坏了"。
                 *
                 * 与 MCP `add_card_to_tab` 保持一致：那边越界本来就是
                 * 报错的，同类操作一个报错一个静默，静默那个迟早变成
                 * 查不出来的问题。
                 */
                /* 先把长度取出来：写进闭包里会和 get_mut 的可变借用打架（E0502）。 */
                let n_tabs = tabs.len();
                let t = tabs.get_mut(i).ok_or_else(|| {
                    format!("页签下标 {i} 越界（共 {n_tabs} 个页签）")
                })?;
                t.items.retain(|p| store::normalize_key(p) != key);
            }
            None => {
                for t in tabs.iter_mut() {
                    t.items.retain(|p| store::normalize_key(p) != key);
                }
            }
        }

        if !still(cfg) {
            if !keep_icon.unwrap_or(true) {
                cfg.folder_icons.retain(|k, _| store::normalize_key(k) != key);
                cfg.folder_gui_icons.retain(|k, _| store::normalize_key(k) != key);
            }
            if !keep_color.unwrap_or(true) {
                cfg.tag_colors.retain(|k, _| store::normalize_key(k) != key);
                cfg.tag_gui_colors.retain(|k, _| store::normalize_key(k) != key);
            }
        }
        let unlink = !still(cfg)
            && !keep_link.unwrap_or(true)
            && kind == "project";
        Ok((snapshot(&dir, cfg), unlink))
    })?;

    // 2) 断链会删 junction（动文件系统），单独一步；失败直接抛给前端
    if need_unlink {
        return core_remove_link(&dir, &path);
    }
    Ok(snap)
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

    let target = sys::resolve_new_target(parent, name, h)?;
    /*
     * 创建必须走**摘锁窗口**（对齐原版 FolderCreateService 的
     * `WithUnlockForPath(full, () => Directory.CreateDirectory(full))`）。
     *
     * 不走窗口的后果：用户给某个目录上了「防写入」后，在这个目录下
     * 新建项目一律失败（deny 会继承到子层级）。而报错只有一句
     * "创建文件夹失败"，**不含原因** —— 用户不知道是自己刚上的锁挡住了自己，
     * 只会以为功能坏了。
     *
     * 这正是"锁"的设计意图：它挡的是第三方（AI 会话进程），
     * 不是本工具代表用户执行的写入。所以本工具自己的操作要过窗口。
     */
    let target_key = target.to_string_lossy().to_string();
    with_unlock(dir, &target_key, || sys::create_folder_at(&target, template))
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
    account_only: Option<bool>,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    /* Option 而非 bool：MCP 等旧调用方不带这个参数，
       用 Option 才不会让它们直接报错（默认 false = 不固定）。 */
    core_set_lock(&dir, &path, deny_delete, deny_write, account_only.unwrap_or(false))
}

/// 一次性保存卡片外观（图标 + 标签色），避免前端分两次写入互相覆盖。
///
/// #13/#113 `gui_only` 决定改的是界面那套还是资源管理器那套
/// （两套图标 + 两套标签色，互不覆盖）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_save_style(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    icon_ref: Option<String>,
    color: Option<String>,
    gui_only: Option<bool>,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    core_save_style(&dir, &path, icon_ref, color, gui_only.unwrap_or(false))
}

/// 设置文件夹图标。
///
/// #13 两套图标：
///   · `gui_only = false`（默认）→ 写 `folder_icons`，并按 `affect_explorer`
///     决定是否同步到资源管理器（desktop.ini）
///   · `gui_only = true`         → 只写 `folder_gui_icons`，**从不碰 desktop.ini**
///
/// 后者是原版 `SetGuiOnlyIconFile` 的语义：想在界面里换一套好看的图标，
/// 但不想动资源管理器里那个 —— 两套互不覆盖。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_set_icon(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    icon_ref: Option<String>,
    affect_explorer: Option<bool>,
    gui_only: Option<bool>,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    // 同 core_save_style：会写 desktop.ini，只认已登记的卡片
    ensure_path_allowed(&dir, &path)?;
    let icon = icon_ref.unwrap_or_default();
    let key = store::normalize_key(&path);
    let gui = gui_only.unwrap_or(false);

    // desktop.ini 写入失败只算警告：配置改动仍要落盘，所以不做成闭包 Err
    // （闭包返回 Err 会跳过保存），而是带出来交给外层决定。
    let (snap, warn) = store::with_config(&dir, |cfg| {
        let affect = affect_explorer.unwrap_or(cfg.icon_affect_explorer);

        /*
         * 只清**目标那套**的旧键，另一套保持不动 ——
         * 两套是独立的，设 GUI 图标不该把资源管理器那套也抹掉。
         * （清空图标 icon 为空串时，删的是对应那套的登记。）
         */
        if gui {
            cfg.folder_gui_icons.retain(|k, _| store::normalize_key(k) != key);
            if !icon.trim().is_empty() {
                cfg.folder_gui_icons.insert(path.clone(), icon.clone());
            }
        } else {
            cfg.folder_icons.retain(|k, _| store::normalize_key(k) != key);
            if !icon.trim().is_empty() {
                cfg.folder_icons.insert(path.clone(), icon.clone());
            }
        }

        // desktop.ini 是 Windows 资源管理器专属机制，其它平台只记在配置里（界面内仍生效）
        let mut warn: Option<String> = None;
        /* **GUI 专属图标不写 desktop.ini** —— 它的定义就是"不影响资源管理器"。
           这里若也写，两套图标就没区别了。 */
        if affect && !gui && cfg!(windows) {
            // #427：同 core_save_style，写 desktop.ini 要进临时摘锁窗口
            let shell_icon = stable_icon_ref(&dir.join("icons"), &icon);
            if let Err(e) = with_unlock(&dir, &path, || sys::apply_icon(&path, &shell_icon)) {
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

/// 读取某目录**磁盘上实际生效**的保护状态（对齐原版 LockToggle 打开弹窗前先读一次）。
///
/// 与"配置里登记了什么"是两件事 —— 只按登记值显示的话，
/// icacls 失败、外部手动改过 ACL、缺目录自身那条 ACE（15.1）
/// 这些情况都会表现为"界面说锁着、实际没锁"，且**没有任何报错**。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_lock_state(path: String) -> serde_json::Value {
    let exists = std::path::Path::new(&path).is_dir();
    let live = if exists { sys::lock_state(&path).ok() } else { None };
    serde_json::json!({
        "path": path,
        "exists": exists,
        "denyDelete": live.map(|l| l.deny_delete).unwrap_or(false),
        "denyWrite": live.map(|l| l.deny_write).unwrap_or(false),
        /* 读不到时明确给 error 而不是默认 false：
           "不知道"与"确定没锁"是两回事，混在一起会让用户以为保护没生效而重复加锁。 */
        "error": live.is_none().then(|| "目录不存在或读取 ACL 失败".to_string()),
    })
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
        /*
         * 数据目录**读不到**时不能按 0 处理。
         *
         * 按 0 会一路走到 `stop_auto()`，把**正在运行**的备份悄悄停掉 ——
         * 而这次调用多半只是用户改了设置触发的一次同步，并不是真的想关掉备份。
         * 读不到时"保持现状 + 如实回传当前是否在跑"才是对的：
         * 错的只是这一次的判断，不该顺手改变实际行为。
         */
        Ok(dir) => store::load_config(&dir).backup_auto_minutes,
        Err(_) => return backup::is_auto_running(),
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

/**
 * 清洗图标文件名：防路径穿越与非法字符。
 *
 * 抽出来是因为**改名和保存都要用**。抄两份的话，
 * 哪天改了清洗规则（比如允许某个字符），另一个就会悄悄用旧规则 ——
 * 表现为"能保存但不能改名"，或反之。
 */
pub(crate) fn sanitize_icon_name(name: &str) -> String {
    name.chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/**
 * 为"同步到资源管理器"准备一个**路径纯 ASCII** 的图标引用。
 *
 * --------------------------------------------------------------------
 * 对齐原版 `FolderIconService.CopyIconToCache` / `GetStableName`：
 *
 * > desktop.ini 中的 IconResource 路径若含非 ASCII 字符（中文、空格、
 * > 特殊符号），不同编码下极易乱码导致图标加载失败。
 *
 * 本版图标名直接来自用户文件，中文**是常态**。中文名写进 desktop.ini 后，
 * 资源管理器可能读不出来 —— 而界面里却显示得好好的（界面走的是配置里的
 * 另一条路径）。用户看到的是"同步了但资源管理器没变"，无从下手。
 *
 * 做法：非 ASCII 时复制一份到 `icons/_shellcache/<稳定名>`，
 * desktop.ini 引用那份副本。**不动** `folder_icons` 里登记的原路径 ——
 * 改登记值会让界面里的图标跟着变，那是另一套东西，不该被牵连。
 *
 * @param icons_dir 数据目录下的 icons/
 * @param icon_ref  形如 `文件路径|索引`
 */
#[cfg(windows)]
pub(crate) fn stable_icon_ref(icons_dir: &std::path::Path, icon_ref: &str) -> String {
    let mut parts = icon_ref.splitn(2, '|');
    let file = parts.next().unwrap_or("").trim();
    let index = parts.next().and_then(|s| s.trim().parse::<i32>().ok()).unwrap_or(0);
    if file.is_empty() { return icon_ref.to_string(); }

    /*
     * 已经是纯 ASCII 且不含空格 → 原样返回。
     * 空格由 `build_icon_resource_line` 的引号处理，不必为此复制一份。
     */
    if file.is_ascii() && !file.contains(' ') { return icon_ref.to_string(); }

    let src = std::path::Path::new(file);
    if !src.is_file() { return icon_ref.to_string(); }

    let cache = icons_dir.join("_shellcache");
    if std::fs::create_dir_all(&cache).is_err() { return icon_ref.to_string(); }

    /*
     * 稳定名 = 哈希前缀 + ASCII 化的原名。
     *
     * 哈希只用来**避免重名**，不需要密码学强度 ——
     * 所以不引 sha1 依赖（动 Cargo.toml 的代价远大于收益），
     * 用 FNV-1a 64：同一路径永远得到同一前缀，重名概率足够低。
     */
    let mut h: u64 = 0xcbf29ce484222325;
    for b in file.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let prefix = format!("{:08x}", h);
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "icon".to_string());
    /* 只留 ASCII 字母数字与 - _，其余（含中文、空格）统一换成 _ */
    let safe: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let ext = src
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_else(|| ".ico".to_string());
    let dest = cache.join(format!("{prefix}_{safe}{ext}"));

    /*
     * 复制失败就退回原路径 —— 不能因为取不到副本就不写 desktop.ini，
     * 那会让"同步到资源管理器"整个功能静默失效。
     * 中文路径至少还有机会被 Shell 正确解析（本版 ini 是按 UTF-16 写的）。
     */
    if std::fs::copy(src, &dest).is_err() { return icon_ref.to_string(); }

    format!("{}|{}", dest.to_string_lossy(), index)
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

/**
 * 清洗图标文件名：防路径穿越与非法字符。
 *
 * 抽出来是因为**改名和保存都要用**。抄两份的话，
 * 哪天改了清洗规则（比如允许某个字符），另一个就会悄悄用旧规则 ——
 * 表现为"能保存但不能改名"，或反之。
 */
pub(crate) fn sanitize_icon_name(name: &str) -> String {
    name.chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/**
 * 为"同步到资源管理器"准备一个**路径纯 ASCII** 的图标引用。
 *
 * --------------------------------------------------------------------
 * 对齐原版 `FolderIconService.CopyIconToCache` / `GetStableName`：
 *
 * > desktop.ini 中的 IconResource 路径若含非 ASCII 字符（中文、空格、
 * > 特殊符号），不同编码下极易乱码导致图标加载失败。
 *
 * 本版图标名直接来自用户文件，中文**是常态**。中文名写进 desktop.ini 后，
 * 资源管理器可能读不出来 —— 而界面里却显示得好好的（界面走的是配置里的
 * 另一条路径）。用户看到的是"同步了但资源管理器没变"，无从下手。
 *
 * 做法：非 ASCII 时复制一份到 `icons/_shellcache/<稳定名>`，
 * desktop.ini 引用那份副本。**不动** `folder_icons` 里登记的原路径 ——
 * 改登记值会让界面里的图标跟着变，那是另一套东西，不该被牵连。
 *
 * @param icons_dir 数据目录下的 icons/
 * @param icon_ref  形如 `文件路径|索引`
 */
#[cfg(windows)]
pub(crate) fn stable_icon_ref(icons_dir: &std::path::Path, icon_ref: &str) -> String {
    let mut parts = icon_ref.splitn(2, '|');
    let file = parts.next().unwrap_or("").trim();
    let index = parts.next().and_then(|s| s.trim().parse::<i32>().ok()).unwrap_or(0);
    if file.is_empty() { return icon_ref.to_string(); }

    /*
     * 已经是纯 ASCII 且不含空格 → 原样返回。
     * 空格由 `build_icon_resource_line` 的引号处理，不必为此复制一份。
     */
    if file.is_ascii() && !file.contains(' ') { return icon_ref.to_string(); }

    let src = std::path::Path::new(file);
    if !src.is_file() { return icon_ref.to_string(); }

    let cache = icons_dir.join("_shellcache");
    if std::fs::create_dir_all(&cache).is_err() { return icon_ref.to_string(); }

    /*
     * 稳定名 = 哈希前缀 + ASCII 化的原名。
     *
     * 哈希只用来**避免重名**，不需要密码学强度 ——
     * 所以不引 sha1 依赖（动 Cargo.toml 的代价远大于收益），
     * 用 FNV-1a 64：同一路径永远得到同一前缀，重名概率足够低。
     */
    let mut h: u64 = 0xcbf29ce484222325;
    for b in file.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let prefix = format!("{:08x}", h);
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "icon".to_string());
    /* 只留 ASCII 字母数字与 - _，其余（含中文、空格）统一换成 _ */
    let safe: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let ext = src
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_else(|| ".ico".to_string());
    let dest = cache.join(format!("{prefix}_{safe}{ext}"));

    /*
     * 复制失败就退回原路径 —— 不能因为取不到副本就不写 desktop.ini，
     * 那会让"同步到资源管理器"整个功能静默失效。
     * 中文路径至少还有机会被 Shell 正确解析（本版 ini 是按 UTF-16 写的）。
     */
    if std::fs::copy(src, &dest).is_err() { return icon_ref.to_string(); }

    format!("{}|{}", dest.to_string_lossy(), index)
}

/// 非 Windows 下原样返回（那里根本不写 desktop.ini）。
#[cfg(not(windows))]
pub(crate) fn stable_icon_ref(_icons_dir: &std::path::Path, icon_ref: &str) -> String {
    icon_ref.to_string()
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

    // 清洗文件名，防路径穿越与非法字符（与改名共用同一套规则）
    let safe = sanitize_icon_name(&name);
    if safe.is_empty() { return Err("图标名为空".into()); }

    let bytes = base64::decode(&data_base64)?;
    if bytes.len() > 2 * 1024 * 1024 { return Err("图标数据超过 2MB".into()); }

    /*
     * 重名自动加 `(1)`（对齐原版 `PresetIconService.UniqueIconName`）。
     *
     * 此前直接按原名 `write` —— 同名就**静默覆盖**用户已有的图标。
     * 用户导入一张也叫 logo.png 的图，旧的那张就没了，且没有任何提示；
     * 等他在分组里点到那一项时，看到的是新图却以为是旧的。
     *
     * 两条判据都要查（与原版一致）：
     *   ① 磁盘上已有同名文件 —— 这是真会覆盖的那种
     *   ② 配置各分组里已有同名 —— 不查的话会出现两个"同名项"指向同一个文件，
     *      之后 #12「清理失效预设」或改名时会分不清是谁
     */
    let name = unique_icon_name(&dest_dir, &dir, &safe);
    let path = dest_dir.join(format!("{name}.ico"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/**
 * 生成一个不与现有图标冲突的名字。
 *
 * `base` 已清洗过（不含路径分隔符）。冲突时追加 `(2)` `(3)`…，
 * 上限 999 次后放弃（防止异常输入下无限循环）。
 */
fn unique_icon_name(dest_dir: &std::path::Path, data_dir: &std::path::Path, base: &str) -> String {
    // 各分组登记过的名字（大小写不敏感，与原版 StringComparer.OrdinalIgnoreCase 一致）
    let known: Vec<String> = store::load_config(data_dir)
        .icon_groups
        .iter()
        .flat_map(|g| g.icons.iter())
        .map(|n| n.to_lowercase())
        .collect();

    let taken = |n: &str| {
        dest_dir.join(format!("{n}.ico")).exists()
            || known.iter().any(|k| k == &n.to_lowercase())
    };

    if !taken(base) { return base.to_string(); }
    for i in 2..=999 {
        let cand = format!("{base}({i})");
        if !taken(&cand) { return cand; }
    }
    base.to_string()
}

/**
 * 重命名数据目录 icons/ 下的图标（#10）。
 *
 * 两件必须一起做的事：
 *   1. 物理改名文件
 *   2. **同步引用了它的卡片**（#13 两套图标：`folder_icons` 与 `folder_gui_icons`）
 *
 * 只做 1 不做 2 会怎样：卡片上配的图标路径还指向旧文件名，
 * 文件已经不在这个名字下了 —— **卡片图标全部显示不出来**，
 * 而界面上没有任何报错，用户只会看到图标位置空了一块。
 * 这类"静默断链"比报错难查得多，且改名这个操作本身看起来毫无风险。
 *
 * 只做 2 不做 1 同样是断链（路径指到不存在的文件），所以两者必须在同一事务里。
 */
pub(crate) fn core_rename_icon(
    dir: &std::path::Path,
    old_path: &str,
    new_name: &str,
) -> Result<RenameIconResult, String> {
    let icons_dir = dir.join("icons");

    /*
     * **old 必须落在数据目录 icons/ 下**。
     *
     * 不校验的话，这个命令就变成"重命名任意文件" ——
     * 配合 MCP 或注入，能把系统文件挪走。
     */
    let old_canon = guard::must_be_under(
        old_path.trim(),
        &[guard::canonical_root(&icons_dir.to_string_lossy())
            .ok_or_else(|| "图标目录不可用".to_string())?],
    )?;

    let safe = sanitize_icon_name(new_name);
    if safe.is_empty() { return Err("图标名为空".into()); }

    /* **保留原扩展名**：原来是 .png 的图标改完名还是 .png。
       一律写成 .ico 的话，PNG 内容被当成 ICO 解析，图标直接显示不出来。 */
    let ext = old_canon.extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_else(|| ".ico".to_string());
    let dest = icons_dir.join(format!("{safe}{ext}"));

    if !old_canon.is_file() { return Err("图标文件不存在".into()); }
    if dest.exists() {
        return Err(format!("已存在同名图标「{safe}{ext}」"));
    }

    let new_path = dest.to_string_lossy().to_string();
    let old_key = store::normalize_key(&old_canon.to_string_lossy());

    /*
     * 物理改名**先做**，失败就直接返回：配置一行未动，状态是一致的。
     *
     * 反过来（先改配置再改文件）更糟 ——
     * 配置改了、文件改名失败，全部引用指向不存在的文件，且无从回滚。
     */
    std::fs::rename(&old_canon, &dest).map_err(|e| format!("改名失败：{e}"))?;

    let r = store::with_config(dir, |cfg| {
        let mut n = 0usize;
        /* **精确匹配，不能子串替换**：
           `icons/foo.ico` 与 `icons/foo2.ico` 若用子串替换会互相污染。
           按规范化后的路径相等来比，确保只动真正引用了这一个图标的卡片。 */
        /* #13 两套图标都要同步。只同步 folder_icons 的话，
           被当作界面专属图标用的那些会**静默断链**（同一类问题）。 */
        for v in cfg.folder_icons.values_mut() {
            if store::normalize_key(v) == old_key {
                *v = new_path.clone();
                n += 1;
            }
        }
        for v in cfg.folder_gui_icons.values_mut() {
            if store::normalize_key(v) == old_key {
                *v = new_path.clone();
                n += 1;
            }
        }
        Ok((snapshot(dir, cfg), n))
    });

    /*
     * 配置写入失败（磁盘满 / 锁冲突）时**必须把文件改名回去**：
     * 否则配置还指向旧路径、文件已经在新名字下 —— 又是断链，
     * 而且是用户完全不知道的一次操作造成的。
     */
    let (snap, affected) = match r {
        Ok(v) => v,
        Err(e) => {
            /*
             * 回滚失败**不能**用 `let _ =` 吞掉。
             *
             * 用户看到的只有"配置写入失败"，以为什么都没动；
             * 实际文件已经在新名字下、配置还指向旧名 —— 一条断链，
             * 而这个状态没有任何地方告诉他。必须把"文件现位于何处"
             * 一起说出来，否则他不知道该去改哪个。
             */
            if let Err(e2) = std::fs::rename(&dest, &old_canon) {
                return Err(format!(
                    "{e}；且改名回滚失败（{e2}），图标文件现位于 {new_path}，\
                     而配置仍指向旧名，请手动改回",
                ));
            }
            return Err(e);
        }
    };

    Ok(RenameIconResult {
        path: new_path,
        affected,
        icons: sys::list_icons(dir),
        snapshot: snap,
    })
}

/// 重命名数据目录 icons/ 下的图标（#10），并同步已引用它的卡片。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_rename_icon(
    app: AppHandle,
    state: State<'_, FpxState>,
    old_path: String,
    new_name: String,
) -> Result<model::RenameIconResult, String> {
    let dir = store::data_dir(&app, &state)?;
    core_rename_icon(&dir, &old_path, &new_name)
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

/// 列出常用文件夹（工具级，所有目录选择器共用）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_list_fav_dirs(
    app: AppHandle,
    state: State<'_, FpxState>,
) -> Vec<FavDir> {
    let dir = match store::data_dir(&app, &state) { Ok(d) => d, Err(_) => return Vec::new() };
    core_list_fav_dirs(&dir)
}

/// 保存常用文件夹（整表替换）。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_save_fav_dirs(
    app: AppHandle,
    state: State<'_, FpxState>,
    dirs: Vec<FavDir>,
) -> Result<Snapshot, String> {
    let dir = store::data_dir(&app, &state)?;
    core_save_fav_dirs(&dir, dirs)
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

    /*
     * 目录还不存在就**先建出来再打开**（对齐原版 SettingsPanel：
     * 「目录不存在则先创建（备份目录尚未执行过备份时可能为空）」）。
     *
     * 不建的话，用户在执行过备份之前点这个按钮会拿到「路径不存在」，
     * 而这个报错完全指向不了原因 —— 他只会以为功能坏了，
     * 或者以为备份目录设置有误（其实设置是对的，只是还没备份过）。
     *
     * 建失败不该拦住打开：让它照原样去 open_path，
     * 由 open_path 给出"路径不存在"这个**真实**的原因 ——
     * 换成"创建目录失败"反而掩盖了真正的问题。
     */
    if !target.exists() {
        let _ = std::fs::create_dir_all(&target);
    }
    sys::open_path(&target.to_string_lossy(), "dir", "")
}

/// #29 查询**实际生效**的备份目录（两类各一）。
///
/// 设置里只显示用户填的规则，看不出最终落在哪儿 ——
/// 而 backupDir 留空时会退到数据目录下的 backup/ 并**再按类型加一层子目录**，
/// 这一层用户根本猜不到。出问题时（备份没找到、要手动清理）
/// 需要的正是那个真实路径。
///
/// 与备份时用的是同一个 `resolve_dir`，保证显示的与实际写入的是同一个，
/// 前端不要自己按规则推 —— 推出来的会和后端漂移。
#[tauri::command]
pub fn fpx_backup_targets(
    app: AppHandle,
    state: State<'_, FpxState>,
) -> Result<backup::BackupTargets, String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    Ok(backup::BackupTargets {
        project: backup::resolve_dir(&cfg, &dir, "project").to_string_lossy().to_string(),
        group: backup::resolve_dir(&cfg, &dir, "group").to_string_lossy().to_string(),
        data_dir: dir.to_string_lossy().to_string(),
    })
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

/// 读一个文本文件内容（#33：供内置 Markdown 编辑器载入）。
///
/// 为什么单独加一条、而不是复用已有的读取：已有的内容读取都假设
/// "要解析成条目清单"，而编辑器要的是**原始文本** —— 任何加工
/// （补 BOM、裁剪空行）都会让"打开→保存"悄悄改掉文件。
///
/// 只收文本文件：二进制文件读进来是乱码，编辑后再写回等于损坏它。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_read_text(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
) -> Result<String, String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    ensure_path_in(&dir, &cfg, &path)?;
    // 目录 → 取其下的 SKILL.md（与 fpx_edit_file 同一个解析规则，别两处各写一套）
    let target = if std::path::Path::new(&path).is_dir() {
        content::skill_md_of(&path).unwrap_or(path.clone())
    } else {
        path.clone()
    };
    let bytes = std::fs::read(&target).map_err(|e| format!("读取失败: {e}"))?;
    if bytes.contains(&0u8) {
        return Err("不是文本文件（含二进制内容），已拒绝打开".to_string());
    }
    /* BOM 要剥掉再交给编辑器，否则用户看到开头一个不可见字符，
       且保存时会被当成内容写回去。剥的是**副本**，落盘仍按原样判断。 */
    let text = String::from_utf8(bytes).map_err(|_| "不是 UTF-8 文本，已拒绝打开".to_string())?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// 写回文本文件（#33：内置 Markdown 编辑器保存）。
///
/// **原子写**：先写同目录临时文件再 rename。理由与配置写入一样 ——
/// 写到一半崩溃会把文件变成半截，而这里写的是用户的 skill / rule 正文，
/// 代价不比丢配置小。
///
/// 不顺带改编码：读进来是什么就写回什么（UTF-8 无 BOM），
/// 自作主张补 BOM 会让某些工具把它们当不同文件。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_write_text(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    text: String,
) -> Result<(), String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    // 写操作比读更该收口：读错了只是看到乱码，写错了是损坏用户文件
    ensure_path_in(&dir, &cfg, &path)?;
    let target = if std::path::Path::new(&path).is_dir() {
        content::skill_md_of(&path).unwrap_or(path.clone())
    } else {
        path.clone()
    };
    if !std::path::Path::new(&target).is_file() {
        return Err(format!("只能写回已存在的文件，不能新建: {}", target));
    }
    let parent = std::path::Path::new(&target).parent().unwrap_or(std::path::Path::new("."));
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        std::path::Path::new(&target).file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
        stamp
    ));
    /* #427：写 SKILL.md / rule 正文同样是往受保护目录里写点。
       保护的是 `<组>/skill/` 而要写 `<组>/skill/foo/SKILL.md` 时，
       ACL 靠继承生效，写入会被自己拦住 —— 这正是需要 `with_unlock`
       按**祖先**摘锁的原因（精确相等查不到这一条）。 */
    with_unlock(&dir, &target, || {
        std::fs::write(&tmp, text.as_bytes()).map_err(|e| format!("写入临时文件失败: {e}"))?;
        fsutil::replace_file(&tmp, std::path::Path::new(&target))
    })
        .map_err(|e| format!("写回失败: {e}"))
}

/// F9 导出 —— 新建文件并写入文本。
///
/// 为什么不能复用 `fpx_write_text`：那条命令里有
///   `if !target.is_file() { return Err("只能写回已存在的文件，不能新建") }`
/// 而**导出必然是新建** —— 拿它做导出只会稳定报"不能新建"，
/// 且从错误信息看不出该换命令。
///
/// 三条收口一条都不能少：
///   ① `ensure_path_in` —— 落在数据目录或已登记 root 内。
///      它对**尚不存在**的目标也能校验（guard::canonical_or_with_parent
///      会退化成"父目录 canonicalize + 文件名"），所以新建不会绕过白名单。
///   ② 扩展名白名单 —— 少了这条，本命令就是"在允许的目录里写 .exe/.bat/.lnk"。
///      导出只需要 html/md/txt，多一个扩展名都是纯风险。
///   ③ 默认不覆盖 —— 覆盖用户已有文件是丢数据，必须调用方显式要求
///      （overwrite: true）才覆盖。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_export_text(
    app: AppHandle,
    state: State<'_, FpxState>,
    path: String,
    text: String,
    overwrite: Option<bool>,
) -> Result<String, String> {
    let dir = store::data_dir(&app, &state)?;
    let cfg = store::load_config(&dir);
    ensure_path_in(&dir, &cfg, &path)?;

    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "html" | "htm" | "md" | "markdown" | "txt") {
        return Err(format!("只允许导出 html / md / txt，收到 .{ext}"));
    }
    if p.exists() && !overwrite.unwrap_or(false) {
        return Err(format!("目标已存在，未覆盖：{path}"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目录：{e}"))?;
    }
    std::fs::write(p, text.as_bytes()).map_err(|e| format!("写入失败：{e}"))?;
    Ok(path)
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

/// skill 虚拟层重命名：批量替换子树条目物理名中对应的 `_` 段（#213 / #342 / #344）。
///
/// 计划（from / to 配对）由前端算好传进来 —— 段下标与扩展名保留这类
/// 最容易算错的逻辑放在可单测的 TS 里；**原子性与权限仍在这里**：
///   · 全部目标先做存在性检查，**任一冲突即整体取消**，不做半截改动（#344）
///   · 逐条经 `with_unlock` 执行（同 E009b：条目可能位于受保护的项目组内）
///   · 要求 from 与 to **同父目录**：这条不变量把"批量改名"钉死在改名语义上，
///     避免配对算错或被误用成任意移动
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_rename_skill_segment(
    app: AppHandle,
    state: State<'_, FpxState>,
    moves: Vec<model::SegmentMoveIn>,
    new_name: String,
) -> Result<model::SegmentRenameResult, String> {
    let dir = store::data_dir(&app, &state)?;

    /*
     * 层级名**禁止下划线**：skill 层级是靠 `_` 拆出来的，
     * 段名里再含 `_` 会把层级拆乱（原版 ValidateSegmentName 明写）。
     */
    let name = sys::validate_name(&new_name)?;
    if name.contains('_') {
        return Err("层级名不能包含下划线 _（会破坏层级拆分）".into());
    }
    if moves.is_empty() {
        return Err("没有匹配的条目可改名，请刷新后重试".into());
    }

    let mut skipped = 0usize;
    let mut plan: Vec<(String, String)> = Vec::new();
    for m in &moves {
        ensure_path_allowed(&dir, &m.from)?;
        ensure_path_allowed(&dir, &m.to)?;
        let from = std::path::Path::new(&m.from);
        let to = std::path::Path::new(&m.to);
        if !from.exists() { skipped += 1; continue; }
        if from.parent() != to.parent() {
            return Err(format!("改名配对非法（不在同一目录）：{}", m.to));
        }
        plan.push((m.from.clone(), m.to.clone()));
    }

    /* #344 冲突整体取消：先全量检查，再动手。
       边查边改的话，前几条改完才发现后面冲突 —— 目录已经半改，
       用户看到的是"改了一半"，且无从还原。 */
    for (_, to) in &plan {
        if std::path::Path::new(to).exists() {
            return Err(format!("目标位置已存在同名条目：{}\n（未做任何改动）", to));
        }
    }

    let mut moved = 0usize;
    for (from, to) in &plan {
        with_unlock(&dir, from, || {
            std::fs::rename(from, to).map_err(|e| format!("改名失败：{e}"))
        })?;
        moved += 1;
    }
    Ok(model::SegmentRenameResult { moved, skipped })
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

/// 内置动作的**默认模板**（按 id → 项目/项目组两份）。
///
/// 为什么要把默认值送到前端：界面里"留空 = 用内置默认"，
/// 于是用户**看不到默认到底是什么**，想在默认基础上改一点点都无从下手 ——
/// 只能凭空把整段重打一遍。原版的做法是"恢复默认后回显默认文案"，
/// 本版保留"留空即默认"的语义，另给一个「填入默认模板」入口，
/// 让想改的人能先把默认取出来再改。
///
/// 只给内置动作的：自定义动作没有默认，给了也是空串。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_chain_defaults() -> std::collections::HashMap<String, [String; 2]> {
    let mut m = std::collections::HashMap::new();
    for (id, _, _) in chain::BUILTIN {
        m.insert(
            (*id).to_string(),
            [
                chain::default_project(id).to_string(),
                chain::default_group(id).to_string(),
            ],
        );
    }
    m
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

    /*
     * 与内置默认**逐字一致**的模板存成 null（对齐原版 `SetChainTemplate`：
     * 「与内置默认一致时存 null 防膨胀」）。
     *
     * 不归一化的话会有两个后果：
     *   ① config 里多出一大坨与默认值完全重复的模板文本；
     *   ② 更要紧的 —— 这份副本被**冻结**了。以后内置默认改进了
     *      （比如补了占位符、改了措辞），这位用户仍停在旧的那份，
     *      而界面上看不出它"不是默认值"，他也无从知道该清空。
     *
     * 只对**内置动作**做：自定义动作没有内置默认，清空是真清空。
     */
    for a in list.iter_mut() {
        if a.builtin.trim().is_empty() { continue; }
        if let Some(v) = a.project.as_ref() {
            if v.trim() == chain::default_project(&a.builtin).trim() {
                a.project = None;
            }
        }
        if let Some(v) = a.group.as_ref() {
            if v.trim() == chain::default_group(&a.builtin).trim() {
                a.group = None;
            }
        }
    }

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

/// 预览某动作将要发出的**指令全文**（#43 发送前确认弹窗用）。
///
/// 为什么要有这一条：占位符替换发生在后端（`fill_all` / `resolve_prompt`），
/// 前端拿不到"实际会发出去的那段文字"。没有它，确认弹窗就只能显示模板原文
/// —— 满屏 `{项目名称}` 让用户去脑补替换结果，等于没确认。
///
/// 与 `fpx_chain_send_action` 用**同一套**解析（resolve_prompt），
/// 保证"看到的"与"发出的"是同一份。两边各写一套迟早会漂。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_chain_preview(
    app: AppHandle,
    state: State<'_, FpxState>,
    action_id: String,
    kind: String,
    path: String,
) -> Result<String, String> {
    let dir = store::data_dir(&app, &state)?;
    let mut cfg = store::load_config(&dir);
    let list = chain::ensure_actions(&mut cfg);
    let item = chain::find(&list, &action_id)
        .ok_or_else(|| format!("找不到连锁动作：{action_id}"))?;
    // path 只用于占位符替换，不落到磁盘 —— 但仍要在允许范围内，
    // 否则可以靠"预览"把任意路径的内容读进指令里（略过路径收口）。
    guard::must_be_under(&path, &content_roots(&dir, &cfg))?;
    let dir_str = dir.to_string_lossy().to_string();
    Ok(chain::resolve_prompt(item, &kind, &path, &dir_str))
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

/// 手动触发一次 MCP 客户端注册自愈。
///
/// 启动时会自愈一次（main.rs），但那只覆盖"进程刚起来那一刻"：
/// 之后用户挪了 exe、或手工删了客户端配置里的条目，界面上没有
/// "再来一次"的入口，只能重启应用。这条命令就是那个入口。
/// 幂等 —— 没变化就什么都不写，返回值直接给人看。
#[tauri::command(rename_all = "snake_case")]
pub fn fpx_mcp_register() -> String {
    mcp::register_clients()
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

/**
 * 在「临时摘锁窗口」内执行一次写入（`#427`）。
 *
 * **为什么要它**：防写入档的 ACL 会把**工具自己**也拦在外面 ——
 * 写 SKILL.md、写 desktop.ini 都是往受保护目录里写点，于是操作失败，
 * 用户看到的是"我明明是自己设的锁，却连自己也改不动了"。
 *
 * 与 `LockGuard` 的区别：
 *   · `LockGuard` 摘的是**精确相等**的那一条，用于 rename / 移动这种
 *     "路径本身就是锁的路径"的场景；
 *   · `with_unlock` 摘的是**所有覆盖该路径的祖先锁**（见 `locks_covering`），
 *     用于往受保护目录的**子层级**里写文件的场景。
 *
 * 两个必须守住的点：
 *
 * 1. **窗口要小**。f 里只能放毫秒级的文件写入，不能放秒级 IO ——
 *    期间目录是**无保护**的，任何第三方（包括 AI 会话进程）都能写进去。
 *
 * 2. **恢复失败绝不静默**。摘了锁没恢复 = 目录**永久**失去保护，
 *    这比写入失败严重得多。所以恢复失败时返回 `Err`，
 *    且错误信息明说"内容已写入" —— 否则用户会以为写入没成功，
 *    然后重试一次，造成重复写入。
 *
 * 3. **并发边界**：同一路径上并发进入本函数**不是严格互斥**的 ——
 *    两个调用者各自 load 一份配置、各自摘锁与恢复，恢复动作会交错。
 *    对本工具安全：GUI 单线程 + MCP 单请求串行，实际不会并发。
 *    但**不要把它放进多线程热点路径** —— 那时窗口会被别人的恢复动作
 *    延长或提前收掉，表现为"保护被悄悄摘掉一段时间"，而日志里什么都没有。
 *
 *    （这条是写给后来人的：原版 `FolderLockService.cs:65` 有同样一句说明。
 *     缺了它现在不出错，但哪天有人把它挪进并发路径，就是最难查的那一类失效。）
 */
pub(crate) fn with_unlock<T, F>(
    dir: &std::path::Path,
    path: &str,
    f: F,
) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let cfg = store::load_config(dir);
    let covering = store::locks_covering(&cfg, path);
    // 没有任何保护时直接执行，连一次 icacls 都不跑（省一次外部进程）
    if covering.is_empty() {
        return f();
    }

    /* 注意是 `model::` 不是 `super::model::`：本文件就是 fpx/mod.rs，
       它的 super 是 crate 根，那里没有 model。store.rs 里才用 super::model。 */
    let mut taken: Vec<model::LockItem> = Vec::new();
    for l in covering {
        match sys::apply_lock(&l.path, false, false) {
            Ok(_) => taken.push(model::LockItem {
                path: l.path.clone(),
                deny_delete: l.deny_delete,
                deny_write: l.deny_write,
                /* 账面固定是**登记性**字段（不落系统权限），摘锁/回滚都碰不到它，
                   必须原样带过来 —— 丢了等于把用户标记的"这个目录别乱动"抹掉。 */
                account_only: l.account_only,
            }),
            Err(e) => {
                // 摘不下来：把已经摘掉的先恢复回去，再让写入按原状尝试 ——
                // 这样失败原因是真实的（"没有权限"），而不是"我们弄丢了一半锁"
                for d in taken.iter().rev() {
                    let _ = sys::apply_lock(&d.path, d.deny_delete, d.deny_write);
                }
                return Err(format!("临时摘锁失败，已放弃写入（保护未被改动）: {e}"));
            }
        }
    }

    let r = f();

    // 无论 f 成功与否都必须恢复：否则一次失败的写入也会让目录失去保护
    let mut errs: Vec<String> = Vec::new();
    for d in taken.iter().rev() {
        let mut ok = sys::apply_lock(&d.path, d.deny_delete, d.deny_write);
        if ok.is_err() {
            // 重试一次：icacls 偶尔会因资源管理器持有句柄而短暂失败
            std::thread::sleep(std::time::Duration::from_millis(120));
            ok = sys::apply_lock(&d.path, d.deny_delete, d.deny_write);
        }
        if let Err(e) = ok {
            errs.push(format!("{}（{e}）", d.path));
        }
    }

    match (r, errs.is_empty()) {
        (Ok(v), true) => Ok(v),
        (Ok(v), false) => Err(format!(
            "内容已写入，但 ACL 保护未能恢复：{}。请到「保护」里重新加锁，否则该目录当前不受保护。",
            errs.join("、")
        )),
        // 写入本身就失败：恢复情况一并说明，但主因是写入失败
        (Err(e), true) => Err(e),
        (Err(e), false) => Err(format!("{e}；且 ACL 保护未能恢复：{}", errs.join("、"))),
    }
}

/**
 * #202 把新建的链接名**并入**已有清单（去重，大小写不敏感）。
 *
 * 不能直接整份覆盖：账本里的 `names` 是"这个项目当前有哪些链接"，
 * 而本次只建了传进来的那几个 —— 覆盖会丢掉之前已建、且**磁盘上仍然存在**
 * 的链接。表现是：junction 还在，界面却显示"未链接"，而没有任何报错。
 *
 * 首次建链时原清单为空，覆盖与并入结果相同，所以这个 bug 只在
 * "补充建链 / 部分指定名字"时出现 —— 更难被发现。
 *
 * 大小写不敏感的理由同 #91：Windows 下 `.OpenCode` 与 `.opencode`
 * 是同一个目录，按精确比较去重会漏掉真正的重名。
 */
pub(crate) fn merge_link_names(existing: &mut Vec<String>, added: Vec<String>) {
    for n in added {
        let dup = existing.iter().any(|e| e.eq_ignore_ascii_case(&n));
        if !dup {
            existing.push(n);
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
        /* #202 并入而不是覆盖 —— 理由见 merge_link_names */
        merge_link_names(&mut r.names, names);
    } else {
        let mut acc: Vec<String> = Vec::new();
        merge_link_names(&mut acc, names);
        records.push(LinkRecord {
            project: project.to_string(),
            lib: group.to_string(),
            group: group_name,
            created: now,
            names: acc,
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
