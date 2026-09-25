//! 无界面的命令行模式
//! ------------------------------------------------------------------
//! 对应 junction_link 的 App.xaml.cs 里那几个 `--xxx` 入口，供脚本 / 排错 / 批量整理用。
//! 全部在 Tauri 启动**之前**处理（见 main.rs），不创建窗口、不进事件循环。
//!
//!   --self-check <config> <record> <outDir>   数据层自检（只读真实文件，写临时副本）
//!   --migrate-hierarchy [config] [record]     项目搬到「新建项目父目录\页签名\名称」
//!   --migrate-groups-hierarchy [config] [record]  项目组同上，搬完重建指向它的链接
//!       ↑ 两条都可加 --dry-run：只打印计划、不动任何东西。
//!         迁移会物理搬目录并覆写 config，跑之前先预演一次。
//!         执行前还会自动把 config / link-record 各留一份 .bak 副本。
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

    // ---- 4. ACL 系统级往返（TEMP 探针目录，不碰用户数据）----
    /*
     * #181 原版 `DataSelfCheck` 有一整段 ACL 用例，本版此前**没有**。
     *
     * 为什么必须有：锁是"用户以为防住了"的东西，而它可能**根本没生效**
     * —— icacls 会失败、用户可能在资源管理器里手动改过、还可能缺目录自身
     * 那条 ACE（见 `sys::apply_lock` 的注释）。这些全表现为
     * "界面说锁着、磁盘上其实没锁"，且**没有任何报错**。
     * 自检是唯一能把它暴露出来的地方。
     *
     * **用探针目录而不是 config 里的真实路径**：后者会在自检期间真的去改
     * 用户的目录权限。跑完立即删除。
     *
     * 这里手工复刻 `with_unlock` 的内核（摘 → 执行 → 恢复），
     * **不能直接调 `with_unlock`**：它按 `config.locks` 查覆盖该路径的祖先锁，
     * 而探针目录不在配置里 → `covering` 为空 → 直接透传，什么也测不到。
     * 若"简化"成调它，测试会永远通过且毫无意义。
     *
     * 用 `cfg!(windows)`（布尔常量）而不是 `#[cfg(windows)]`：
     * 两个分支都要参与编译，否则非 Windows 下这段语法根本不被检查。
     */
    lines.push(String::new());
    if !cfg!(windows) {
        lines.push("[INFO] 非 Windows：锁退化为只读近似（无独立防删除档），跳过 ACL 用例".to_string());
    } else {
        lines.push("== ACL 系统级往返（临时探针目录，不碰用户数据）==".to_string());
        let probe = out.join("_acl-probe");
        let probe_s = probe.to_string_lossy().to_string();
        let acl: Result<(), String> = (|| {
            if probe.exists() {
                let _ = std::fs::remove_dir_all(&probe);
            }
            std::fs::create_dir_all(&probe).map_err(|e| format!("建探针目录失败: {e}"))?;

            // 1) Protect(防删除) → 读回一致
            super::sys::apply_lock(&probe_s, true, false)?;
            let st = super::sys::lock_state(&probe_s)?;
            if !(st.deny_delete && !st.deny_write) {
                return Err(format!(
                    "Protect(防删除) 后读回不一致: denyDelete={} denyWrite={}",
                    st.deny_delete, st.deny_write));
            }

            // 2) 防删除档下删除子文件应被拒（缺目录自身 ACE 时这一条会过）
            let f1 = probe.join("probe.txt");
            std::fs::write(&f1, "x").map_err(|e| format!("探针文件写入失败: {e}"))?;
            if std::fs::remove_file(&f1).is_ok() {
                return Err("防删除档下删除子文件未被拒绝（等于没锁住）".to_string());
            }

            // 3) 摘锁窗口内可删
            super::sys::apply_lock(&probe_s, false, false)?;
            if f1.exists() {
                std::fs::remove_file(&f1).map_err(|e| format!("摘锁窗口内仍删不掉: {e}"))?;
            }

            // 4) 窗口结束恢复后保护仍在
            super::sys::apply_lock(&probe_s, true, false)?;
            let st2 = super::sys::lock_state(&probe_s)?;
            if !st2.deny_delete {
                return Err("解锁窗口结束后 denyDelete 未恢复".to_string());
            }

            // 5) 防写入档：新建被拒 → 摘锁后可写 → 恢复
            super::sys::apply_lock(&probe_s, false, true)?;
            let f2 = probe.join("w.txt");
            if std::fs::write(&f2, "x").is_ok() {
                return Err("防写入档下新建文件未被拒绝（等于没锁住）".to_string());
            }
            super::sys::apply_lock(&probe_s, false, false)?;
            std::fs::write(&f2, "x").map_err(|e| format!("摘锁窗口内仍写不进: {e}"))?;
            super::sys::apply_lock(&probe_s, false, true)?;

            // 6) Unprotect → 不应残留本工具的 deny
            super::sys::apply_lock(&probe_s, false, false)?;
            let st3 = super::sys::lock_state(&probe_s)?;
            if st3.any() {
                return Err(format!(
                    "Unprotect 后仍有残留: denyDelete={} denyWrite={}",
                    st3.deny_delete, st3.deny_write));
            }
            Ok(())
        })();
        match acl {
            Ok(()) => check(
                true,
                "ACL 往返：Protect → 拒删 → 窗口内可删 → 恢复 → 防写入 → Unprotect".to_string(),
                &mut lines, &mut pass),
            Err(e) => check(false, format!("ACL 往返失败: {e}"), &mut lines, &mut pass),
        }
        /* 探针目录无论成败都删：留下来会让下一次自检撞上"已存在"。
           先摘一次锁 —— 用例中途失败时它可能还锁着，直接删会失败并留下残骸。 */
        let _ = super::sys::apply_lock(&probe_s, false, false);
        let _ = std::fs::remove_dir_all(&probe);
    }

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
/**
 * 层级迁移：把页签里的目录搬到「新建父目录\页签名\名称」。
 *
 * `dry_run` = true 时**只输出计划、不动任何东西**。
 *
 * 为什么必须有这个开关：迁移会**物理搬目录**并**覆写 config**，
 * 是不可逆操作。没有预演的话，用户只能"跑了才知道会发生什么" ——
 * 而那时候目录已经搬走了。给一个只看不做的通道，成本极低，
 * 却是这类命令唯一能让人放心按下去的东西。
 */
/**
 * #314 把页签名收敛为合法的单级目录片段；不合法返回 `None`。
 *
 * 不合法 = 空 / 纯空白 / `.` / `..` / 含路径分隔符或 Windows 文件名非法字符 / 含控制符。
 *
 * 字符集用 **Windows 的**非法集（`\ / : * ? " < > |`）而不是"当前平台"的：
 * 迁移目标是给资源管理器用的目录名，按当前平台判的话同一份 config
 * 换台机器跑就会得出不同结论 —— 而用户名/页签名里出现这些字符本就不该被接受。
 */
pub fn safe_segment(name: &str) -> Option<String> {
    if name.trim().is_empty() { return None; }
    let s = name.trim();
    if s == "." || s == ".." { return None; }
    for c in s.chars() {
        if c.is_control() { return None; }
        if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { return None; }
    }
    Some(s.to_string())
}

fn migrate(
    cfg_path: &str,
    rec_path: &str,
    kind: &str,
    dry_run: bool,
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

    /*
     * 先做不可变计划：搬迁过程中要改 config，不能边枚举边改。
     *
     * 计划项带一个 `skip`：被排除 / 不是真实目录 / 页签名不合法的项目
     * **也要进计划**，而不像原版那样 `continue` 掉。
     *
     * 原版 `HierarchyMigrator` 里这两种情况都是直接 continue ——
     * 既不 moved 也不 skipped，**连一条记录都没有**。用户跑完看到
     * "100 个项目只处理了 80 个"，另外 20 个完全没有任何说明，
     * 只会以为丢了。这个**不照搬**：不搬的决定是对的，静默略过不是。
     */
    struct PlanItem {
        /// 页签名（层级片段）；页签名不合法时为空
        seg: String,
        src: String,
        /// 非空 = 跳过，值为原因
        skip: String,
    }
    let mut plan: Vec<PlanItem> = Vec::new();
    for t in tabs {
        for p in &t.items {
            let k = reloc_key(p);
            let mut skip = String::new();
            if excludes.iter().any(|e| e.eq_ignore_ascii_case(&k)) {
                skip = "跳过：排除目录（数据目录 / 目标根）".to_string();
            } else if !super::fsutil::is_real_dir(Path::new(p)) {
                /* 不跟随链接：搬迁一个 junction 会把链接背后的目录搬走，
                   而不是搬链接本身。这里必须说明原因 ——
                   "文件夹不存在"和"是链接所以不搬"是两种不同的补救。 */
                skip = if Path::new(p).exists() {
                    "跳过：是链接，不是真实目录".to_string()
                } else {
                    "跳过：文件夹不存在".to_string()
                };
            }
            /*
             * #314 页签名收敛为合法的**单级**目录片段。
             *
             * 原版 `SafeSegment` 注释："含非法路径字符、控制符、空白、'.'、'..' 时返回 null"，
             * 命中则**该页签整体不搬**。
             *
             * 为什么必须挡：页签名直接拿去 `root.join(seg)`，含 `\` 或 `/` 的页签名
             * 会拼出**多层级**路径（甚至越出目标根，比如 `..\..\x`），
             * 于是项目被搬到用户完全没指定的地方 —— 而报告里只写"已搬迁"。
             */
            let seg = safe_segment(&t.name);
            if skip.is_empty() && seg.is_none() {
                skip = format!("跳过：页签名「{}」含非法字符，该页签整体不搬", t.name);
            }
            plan.push(PlanItem { seg: seg.unwrap_or_default(), src: p.clone(), skip });
        }
    }

    /* 预演：只报计划，不做任何事。
       放在"计划算完、动手之前" —— 计划本身是纯计算（不碰磁盘），
       所以 dry-run 能完整展示"哪些会搬、哪些会跳过、为什么跳过"。 */
    if dry_run {
        let mut pre: Vec<MigItem> = Vec::new();
        for it in &plan {
            let src = &it.src;
            if !it.skip.is_empty() {
                pre.push(MigItem { src: src.clone(), dst: String::new(), note: it.skip.clone() });
                continue;
            }
            let name = Path::new(src).file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name.is_empty() {
                pre.push(MigItem { src: src.clone(), dst: String::new(), note: "跳过：无法解析文件夹名".into() });
                continue;
            }
            let dst = root.join(&it.seg).join(&name);
            let note = if reloc_key(src).eq_ignore_ascii_case(&reloc_key(&dst.to_string_lossy())) {
                "跳过：已在目标位置".to_string()
            } else if dst.exists() {
                "跳过：目标已存在同名目录".to_string()
            } else {
                "将搬迁".to_string()
            };
            pre.push(MigItem { src: src.clone(), dst: dst.to_string_lossy().to_string(), note });
        }
        let yes = pre.iter().filter(|i| i.note == "将搬迁").count();
        return format!("预演（未做任何改动）：共 {} 项，其中将搬迁 {} 项\n{}",
            /* 预演阶段还没动过链接，relink_errors 自然是空的。 */
            pre.len(), yes, render(yes, pre.len() - yes, 0, 0, &[], &pre));
    }

    /* 动手之前先把两份数据文件的**副本**留下来。
       迁移会物理搬目录 + 覆写 config，中途失败就是半完成状态：
       目录搬了一半、config 已改、链接可能已重建。
       没有副本的话唯一能抢救的原文就被覆盖掉了 ——
       这个代价和收益完全不成比例（复制两个几 KB 的文件而已）。 */
    let backup_note = match backup_before_migrate(cfg_path, rec_path) {
        Ok(paths) => format!("已备份原文件：{}", paths.join("、")),
        Err(e) => format!("[警告] 备份失败（仍继续）：{e}"),
    };

    let mut items: Vec<MigItem> = Vec::new();
    let (mut moved, mut skipped, mut failed) = (0, 0, 0);

    for it in &plan {
        let src = &it.src;
        if !it.skip.is_empty() {
            /* 原版这里是**不计入** skipped 的（连记录都没有）。
               本版照搬"不搬"的决定，但不照搬"静默" ——
               否则总数对不上，用户只会以为项目丢了。 */
            skipped += 1;
            items.push(MigItem { src: src.clone(), dst: String::new(), note: it.skip.clone() });
            continue;
        }
        let name = Path::new(src).file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            skipped += 1;
            items.push(MigItem { src: src.clone(), dst: String::new(), note: "跳过：无法解析文件夹名".into() });
            continue;
        }

        let dst_dir = root.join(&it.seg);
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

        // 跨卷时 rename 会失败，此时回退到"复制 + 删除"（复制没成功就不删源）
        if let Err(e) = std::fs::create_dir_all(&dst_dir) {
            failed += 1;
            items.push(MigItem { src: src.clone(), dst: dst.to_string_lossy().to_string(), note: format!("失败：无法创建目标目录 {e}") });
            continue;
        }
        match super::fsutil::rename_with_fallback(Path::new(src), &dst) {
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
        /* #13 两套图标都要挪。只挪 folder_icons 的话，
           搬完家界面专属图标**静默失效**（卡片显示回默认图标且无任何报错）。 */
        cfg.folder_gui_icons = remap(cfg.folder_gui_icons.clone(), &key, &it.dst);
        cfg.tag_colors = remap(cfg.tag_colors.clone(), &key, &it.dst);
        /* #113 同 #13：两套都要挪，漏了静默失效 */
        cfg.tag_gui_colors = remap(cfg.tag_gui_colors.clone(), &key, &it.dst);
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
    /*
     * 重建失败的**必须说出来**。此前这里是 `Err(_) => {}`（完全吞掉），
     * 于是报告只写「重建链接 N 条」：失败的那几条既不计进 N，
     * 也没有任何一行提到它们。
     *
     * 用户拿到一份干干净净的"完成"报告，而那些链接实际仍指向
     * 搬走之前的旧路径（已经失效的 junction）—— 界面上表现为红色断链，
     * 他却不知道是这次迁移造成的，更不知道有哪几条要手动补。
     *
     * 与 mod.rs 两条搬家路径保持一致（那边进 `relink_errors` 一并回传）。
     */
    let mut relink_errors: Vec<String> = Vec::new();
    if kind == "group" {
        for r in records.iter_mut() {
            // 同上：不跟随链接
            if !super::fsutil::is_real_dir(Path::new(&r.project)) { continue; }
            let names: Vec<String> = r.names.clone();
            if names.is_empty() { continue; }
            // 先删旧的（可能已断），再建新的
            let _ = super::junction::remove(&r.project, &names);
            match super::junction::create(&r.project, &r.group, &names) {
                Ok(_) => relinked += 1,
                Err(e) => relink_errors.push(format!(
                    "{}（{}）：{e}", r.project, names.join("、")
                )),
            }
        }
    }

    if let Err(e) = store::write_json_any(Path::new(cfg_path), &cfg) {
        return format!("搬迁完成但写回 config 失败: {e}\n{}", render(moved, skipped, failed, relinked, &relink_errors, &items));
    }
    if let Err(e) = store::save_records_to(Path::new(rec_path), &records) {
        return format!("搬迁完成但写回 link-record 失败: {e}\n{}", render(moved, skipped, failed, relinked, &relink_errors, &items));
    }

    format!("{}\n{}", backup_note, render(moved, skipped, failed, relinked, &relink_errors, &items))
}

/// 迁移前把 config 与 link-record 各复制一份带时间戳的副本。
///
/// 刻意**不覆盖**已有的备份。
/// 连着跑两次迁移时，第二次要是把第一次的备份盖了，就等于没有备份 ——
/// 而第一次搬完的那份才是有用的现场。
/// 所以撞名就换一个后缀，不删旧的。
fn backup_before_migrate(cfg_path: &str, rec_path: &str) -> Result<Vec<String>, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut out = Vec::new();
    for src in [cfg_path, rec_path] {
        let p = Path::new(src);
        if !p.exists() { continue; }
        for n in 0..100 {
            let dst = p.with_extension(format!("mig-{stamp}{}.bak", if n == 0 { String::new() } else { format!("-{n}") }));
            if dst.exists() { continue; }
            std::fs::copy(p, &dst).map_err(|e| format!("复制 {} 失败: {e}", p.display()))?;
            out.push(dst.to_string_lossy().to_string());
            break;
        }
    }
    Ok(out)
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
    relink_errors: &[String],
    items: &[MigItem],
) -> String {
    let mut s = format!("== 层级迁移完成 ==\n已搬 {moved} 条，跳过 {skipped} 条，失败 {failed} 条");
    if relinked > 0 {
        s.push_str(&format!("，重建链接 {relinked} 条"));
    }
    if !relink_errors.is_empty() {
        s.push_str(&format!("，重建链接**失败** {} 条", relink_errors.len()));
    }
    s.push_str("\n\n");
    for it in items {
        if it.note.is_empty() {
            s.push_str(&format!("[OK]   {} → {}\n", it.src, it.dst));
        } else {
            s.push_str(&format!("[{}] {} → {}\n", it.note, it.src, it.dst));
        }
    }
    if !relink_errors.is_empty() {
        s.push_str("\n[链接重建失败] 以下链接仍指向旧位置，请手动处理：\n");
        for e in relink_errors {
            s.push_str(&format!("  - {e}\n"));
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
        /* 两条迁移命令都认 --dry-run：它是这类不可逆命令唯一的"看一眼"通道。
           放在迁移名之后任意位置都行（扫全参而不是只看第 3 个），
           免得用户记不清顺序。 */
        "--migrate-hierarchy" => {
            let (c, r) = default_paths(&args[2..]);
            Some(migrate(&c, &r, "project", args.iter().any(|a| a == "--dry-run")))
        }
        "--migrate-groups-hierarchy" => {
            let (c, r) = default_paths(&args[2..]);
            Some(migrate(&c, &r, "group", args.iter().any(|a| a == "--dry-run")))
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

/// 必须与 `tauri.conf.json` 的 `identifier` 一致。
///
/// **有测试守护**（`mcp-stdio-test.mjs` 会比对 tauri.conf.json）：
/// 改了配置里的 identifier 而忘了改这里，两个模式就会各读一份配置，
/// 症状是"CLI/stdio 里看不到 GUI 里登记的项目"，且很难往这方面想。
pub const APP_IDENTIFIER: &str = "com.nexus.panel";

/// 与 `store::resolve_data_dir` **同一个**落点，只是这里拿不到 AppHandle。
///
/// 原实现拼的是 `$APPDATA/nexus-panel`（Win）/ `~/.nexus-panel`（其它），
/// 而 Tauri 的 `app_data_dir()` 走的是：
///   Windows  `%APPDATA%/<identifier>`
///   macOS    `~/Library/Application Support/<identifier>`
///   Linux    `$XDG_DATA_HOME/<identifier>` 或 `~/.local/share/<identifier>`
/// identifier 是 `com.nexus.panel`，所以**两边指向的不是同一个目录** ——
/// CLI 模式一直在读写另一份配置，而注释还写着"相同落点"。
///
/// stdio 模式同样拿不到 AppHandle，若沿用旧实现会把这个 bug 复制一份，
/// 所以这里按 Tauri 的规则对齐（含 XDG_DATA_HOME 优先）。
pub fn dirs_data_dir() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from)?
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)?
            .join("Library")
            .join("Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|h| h.join(".local").join("share"))
            })?
    };
    Some(base.join(APP_IDENTIFIER).join("project-group"))
}
