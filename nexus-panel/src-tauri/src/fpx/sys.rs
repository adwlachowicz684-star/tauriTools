//! 系统能力：目录浏览 / 新建文件夹 / 打开路径 / ACL 保护 / 资源管理器图标

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::model::{DirEntryLite, FpxConfig, TabItem};
use super::store::normalize_key;
use crate::fpx::fsutil::{copy_tree, is_real_dir, rename_with_fallback};
use crate::fpx::safety::check_executable;
// 只在 Windows 用：非 Windows 的 opener 不走 shell，无二次解析风险
#[cfg(windows)]
use crate::fpx::safety::safe_cmd_arg;
// macOS 的 .app 走 `open -a`，同样要把参数挡在 shell 元字符之外
#[cfg(target_os = "macos")]
use crate::fpx::safety::safe_cmd_arg;

/* ---------------------------- 目录浏览（给内嵌目录选择器用） ---------------------------- */

/// 列出子目录。path 为空时列出盘符（Windows）或根目录（Unix）。
pub fn list_dirs(path: &str) -> Result<Vec<DirEntryLite>, String> {
    if path.trim().is_empty() {
        return Ok(list_roots());
    }
    let dir = Path::new(path);
    // 入口路径跟随链接：这是"用户显式点进来的目录"，
    // 项目组 junction 被点开时列出其内容才是预期行为（资源管理器同样如此）。
    // 真正的递归风险不在这里 —— 列表只走一层，且下面的子项判定不跟随链接。
    if !dir.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }
    let mut out: Vec<DirEntryLite> = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("无法读取目录: {e}"))?;
    for entry in entries.flatten() {
        let p = entry.path();
        // 子项用 symlink_metadata：链接目录不再被当成"可深入的真实目录"
        if !is_real_dir(&p) { continue; }
        let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if name.is_empty() || name.starts_with('.') { continue; }
        // 系统卷信息 / 回收站等跳过
        if name.eq_ignore_ascii_case("$RECYCLE.BIN") || name.eq_ignore_ascii_case("System Volume Information") {
            continue;
        }
        out.push(DirEntryLite {
            has_child: has_subdir(&p),
            path: p.to_string_lossy().to_string(),
            name,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if out.len() > 800 { out.truncate(800); }
    Ok(out)
}

fn has_subdir(dir: &Path) -> bool {
    match fs::read_dir(dir) {
        // 同样不跟随链接：链接目录不标成"有子目录"，避免引导用户顺着链接绕回去
        Ok(entries) => entries.flatten().any(|e| is_real_dir(&e.path())),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn list_roots() -> Vec<DirEntryLite> {
    let mut out = Vec::new();
    for c in 'A'..='Z' {
        let p = format!("{c}:\\");
        if Path::new(&p).exists() {
            out.push(DirEntryLite { name: format!("{c}: 盘"), path: p, has_child: true });
        }
    }
    out
}

#[cfg(not(windows))]
fn list_roots() -> Vec<DirEntryLite> {
    // Unix：从当前用户主目录与根目录起步
    let mut out = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        out.push(DirEntryLite { name: "主目录".into(), path: home, has_child: true });
    }
    out.push(DirEntryLite { name: "根目录 /".into(), path: "/".into(), has_child: true });
    out
}

/// 常用起点（供选择器快速跳转）。
pub fn quick_roots() -> Vec<DirEntryLite> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        for (k, v) in [
            ("USERPROFILE", "用户目录"),
            ("SystemDrive", "系统盘"),
            ("APPDATA", "AppData"),
            ("PUBLIC", "公用目录"),
        ] {
            if let Ok(p) = std::env::var(k) {
                let path = if k == "SystemDrive" { format!("{p}\\") } else { p };
                out.push(DirEntryLite { name: v.into(), path, has_child: true });
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            out.push(DirEntryLite { name: "主目录".into(), path: home, has_child: true });
        }
        out.push(DirEntryLite { name: "根目录".into(), path: "/".into(), has_child: true });
    }
    out
}

/* ---------------------------- 新建项目 / 项目组 ---------------------------- */

/// 校验名称，非法返回 Err；合法返回去除首尾空白的名称。
pub fn validate_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() { return Err("名称不能为空".into()); }
    if name.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return Err("名称不能包含 \\ / : * ? \" < > | 等字符".into());
    }
    if name == "." || name == ".." || name.trim_matches('.').is_empty() {
        return Err("名称不能是 . 或 ..".into());
    }
    /*
     * 不能以句点结尾（原版 ValidateName 明写）。
     *
     * Windows 会**静默**去掉目录名末尾的句点：输入 `foo.` 实际建出 `foo`。
     * 于是配置里存的是 `foo.`，磁盘上是 `foo` —— 界面照配置显示带句点，
     * 之后所有按名字去查的操作（打开 / 改名 / 删除）都查不到。
     * 这是"显示与实际不一致"且**没有任何报错**的一类，必须在入口就挡掉。
     *
     * 末尾空格不在此列：上面 `raw.trim()` 已经把它去掉了，
     * 用户打 "foo " 得到 "foo" 是符合预期的，不必报错。
     */
    if name.ends_with('.') {
        return Err("名称不能以句点结尾（Windows 会静默去掉，导致配置里的名字与磁盘不一致）".into());
    }
    if name.len() > 120 { return Err("名称过长（上限 120 字符）".into()); }
    Ok(name.to_string())
}

/// 新建文件夹：parent 为空时用 quick_roots 首个；hierarchy 为可选的页签层级子目录。
/// kind=="group" 时可从 template 拷贝模板内容。
pub fn create_folder(
    parent: &str,
    name: &str,
    hierarchy: Option<&str>,
    template: Option<&str>,
) -> Result<String, String> {
    let target = resolve_new_target(parent, name, hierarchy)?;
    create_folder_at(&target, template)
}

/**
 * 只算目标路径、不做任何磁盘操作。
 *
 * 拆出来的原因：`core_create_folder` 需要**先知道目标路径**才能按它
 * 去摘祖先锁（原版 `WithUnlockForPath`）—— 摘锁窗口必须包住真正的创建动作，
 * 而窗口的 key 又是目标路径，所以在创建之前必须先算出来。
 */
pub fn resolve_new_target(
    parent: &str,
    name: &str,
    hierarchy: Option<&str>,
) -> Result<PathBuf, String> {
    let name = validate_name(name)?;
    let mut target = if parent.trim().is_empty() {
        let roots = quick_roots();
        match roots.first() {
            Some(r) => PathBuf::from(&r.path),
            None => return Err("无法确定父目录，请手动选择".into()),
        }
    } else {
        PathBuf::from(parent)
    };
    if let Some(h) = hierarchy {
        let h = validate_name(h)?;
        target = target.join(h);
    }
    target = target.join(&name);
    if target.exists() {
        return Err(format!("目标已存在: {}", target.display()));
    }
    Ok(target)
}

/**
 * 在**已算好的**目标路径上真正创建（含模板拷贝）。
 *
 * 调用方负责把这一步放进摘锁窗口 —— 见 `core_create_folder`。
 *
 * 模板拷贝也必须在窗口内：原版就是整个 `CopyDirectoryRecursive` 包在
 * `WithUnlockForPath` 里。只把 `CreateDirectory` 包进去的话，
 * 受保护目录下建完空目录、接着拷模板内容会被 ACL 拒绝 ——
 * 用户看到的是"新建成功但里面是空的"，而没有任何报错。
 */
pub fn create_folder_at(target: &std::path::Path, template: Option<&str>) -> Result<String, String> {
    fs::create_dir_all(target).map_err(|e| format!("创建文件夹失败: {e}"))?;

    if let Some(tpl) = template {
        let tpl = tpl.trim();
        if !tpl.is_empty() {
            let tpl_path = Path::new(tpl);
            if tpl_path.is_dir() {
                copy_tree(tpl_path, target)?;
            }
        }
    }
    Ok(target.to_string_lossy().to_string())
}

/// 递归拷贝目录树（模板内容）。
///
/// 走 fsutil::copy_tree：跳过链接点 + 已访问节点集合。
/// 原实现用跟随链接的 `is_dir()` 判断递归，模板目录里只要有一个指向上级的软链
/// 就会无限递归（边递归边建目录，几秒内撑爆磁盘）。
/// 顺带把"失败静默吞掉"改成向上抛错 —— 模板只拷了一半却报成功，更难排查。

/* ---------------------------- 打开路径 ---------------------------- */

/// mode: auto | dir | containing | editor。editor_path 为空时回退系统默认程序。
pub fn open_path(path: &str, mode: &str, editor_path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    let is_dir = p.is_dir();
    match mode {
        "dir" | "containing" => {
            let target = if is_dir || mode == "dir" {
                if is_dir { p.to_path_buf() } else { p.parent().map(|x| x.to_path_buf()).unwrap_or_else(|| p.to_path_buf()) }
            } else {
                p.parent().map(|x| x.to_path_buf()).unwrap_or_else(|| p.to_path_buf())
            };
            open_with_explorer(&target)
        }
        "editor" => {
            let editor = editor_path.trim();
            if editor.is_empty() {
                open_default(p)
            } else {
                /*
                 * macOS：`.app` 是**目录**，不是可执行文件。
                 *
                 * `editor::enumerate` 特意用 `exe.exists()` 而不是 `is_file()`
                 * 去收它们（注释里写明：用 is_file 会把 /Applications 下的编辑器全漏掉），
                 * 于是 VS Code.app / Cursor.app 这些**一定**会出现在选择列表里。
                 * 而 `check_executable` 要求 `is_file()` —— 直接过校验的话，
                 * 列表里最显眼的这几项**点了必然失败**，报「编辑器不可用（可执行文件不存在）」。
                 * 用户只会以为"这个软件选不了编辑器"，而真相是两条规则对 `.app`
                 * 的判定不一致（清单里"用 exists 收、用 is_file 验"正是这种错配）。
                 *
                 * 正解是走系统 opener：`open -a <.app> <文件>`。
                 * 不是把它从列表里剔掉 —— 那等于在 macOS 上砍掉主要那几个编辑器。
                 */
                #[cfg(target_os = "macos")]
                {
                    let ep = Path::new(editor);
                    if editor.to_lowercase().ends_with(".app") && ep.is_dir() {
                        if !safe_cmd_arg(editor) {
                            return Err(format!("编辑器路径含不安全字符，已拒绝启动: {editor}"));
                        }
                        let ps = p.to_string_lossy().to_string();
                        if !safe_cmd_arg(&ps) {
                            return Err(format!("路径含特殊字符，已拒绝打开: {ps}"));
                        }
                        return Command::new("open")
                            .args(["-a", editor])
                            .arg(p)
                            .spawn()
                            .map(|_| ())
                            .map_err(|e| format!("无法启动编辑器: {e}"));
                    }
                }
                // editor 来自配置。配置一旦被污染，"打开方式"就变成了"执行任意程序"，
                // 所以先过一遍校验：存在性 + 扩展名白名单 + 无 shell 元字符
                check_executable(Path::new(editor))
                    .map_err(|e| format!("编辑器不可用（{e}），请在设置里重新选择"))?;
                Command::new(editor).arg(p).spawn()
                    .map(|_| ())
                    .map_err(|e| format!("无法启动编辑器: {e}"))
            }
        }
        _ => if is_dir { open_with_explorer(p) } else { open_default(p) },
    }
}

#[cfg(windows)]
fn open_with_explorer(dir: &Path) -> Result<(), String> {
    Command::new("explorer").arg(dir).spawn().map(|_| ()).map_err(|e| format!("无法打开资源管理器: {e}"))
}

#[cfg(target_os = "macos")]
fn open_with_explorer(dir: &Path) -> Result<(), String> {
    Command::new("open").arg(dir).spawn().map(|_| ()).map_err(|e| format!("无法打开访达: {e}"))
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn open_with_explorer(dir: &Path) -> Result<(), String> {
    Command::new("xdg-open").arg(dir).spawn().map(|_| ()).map_err(|e| format!("无法打开文件管理器: {e}"))
}

#[cfg(windows)]
fn open_default(file: &Path) -> Result<(), String> {
    // `cmd /c start` 会做二次解析。Rust 的 Command 会给参数加引号，
    // 但路径里若自带引号、%、换行或 & 之类，仍能逃出引号边界变成第二条命令。
    // 挡掉比"能打开但可能被注入"重要：真遇到这种路径，提示用户去资源管理器里打开。
    let s = file.to_string_lossy().to_string();
    if !safe_cmd_arg(&s) {
        return Err(format!("路径含特殊字符，已拒绝用系统 Shell 打开: {s}"));
    }
    Command::new("cmd")
        .args(["/c", "start", "", &s])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开文件: {e}"))
}

#[cfg(target_os = "macos")]
fn open_default(file: &Path) -> Result<(), String> {
    Command::new("open").arg(file).spawn().map(|_| ()).map_err(|e| format!("无法打开文件: {e}"))
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn open_default(file: &Path) -> Result<(), String> {
    Command::new("xdg-open").arg(file).spawn().map(|_| ()).map_err(|e| format!("无法打开文件: {e}"))
}

/* ---------------------------- ACL 文件夹保护 ---------------------------- */

/// 磁盘上**实际生效**的保护状态（对齐原版 FolderLockState / GetState）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockState {
    pub deny_delete: bool,
    pub deny_write: bool,
}

impl LockState {
    pub fn any(&self) -> bool { self.deny_delete || self.deny_write }
}

/// 读取实际生效的保护状态（只读查询，不修改）。
///
/// 对齐原版 `FolderLockService.GetState`。与"配置里登记了什么"是两件事：
/// 读它才能回答"到底锁住没有"。
///
/// **为什么必须有它**：icacls 可能失败（资源管理器持有句柄、权限不足），
/// 用户也可能在资源管理器里手动改过 ACL。只按配置显示的话，
/// "界面说锁着、磁盘上其实没锁"这种状态**无任何报错** ——
/// 正是 15.1（缺目录自身那条 ACE）那类问题能被藏住的原因。
pub fn lock_state(path: &str) -> Result<LockState, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }

    #[cfg(windows)]
    {
        let out = run_cmd("icacls", &[path.to_string()])?;
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        /*
         * icacls 输出形如：
         *   Everyone:(DENY)(D)
         *   Everyone:(OI)(CI)(DENY)(W)
         *   BUILTIN\Administrators:(I)(OI)(CI)(F)
         *
         * 只认「身份是 Everyone」且「带 (DENY)」的行 —— 与本工具管理范围一致，
         * 不把第三方 Deny 当成自己的锁（原版 IsWorldSid + AccessControlType.Deny 同口径）。
         */
        let mut st = LockState::default();
        for line in text.lines() {
            let line = line.trim();
            if !line.starts_with("Everyone:") { continue; }
            if !line.contains("(DENY)") { continue; }
            /*
             * 权限位在 `(DENY)` **之后**的那对括号里（`(OI)(CI)` 等继承标记在前）。
             * 里面是逗号分隔的简写：D/DE=删除，W/AD/WEA/WA=各类写入，
             * WDAC/WO/RC 等属**非管理范围**，不当成本工具的锁
             * （与原版"只认权限落在 Delete/Write 管理范围内"同口径）。
             */
            let after = match line.split("(DENY)").nth(1) { Some(x) => x, None => continue };
            let inner = match after.trim_start().strip_prefix('(').and_then(|x| x.split(')').next()) {
                Some(x) => x, None => continue,
            };
            for p in inner.split(',') {
                match p.trim() {
                    "D" | "DE" => st.deny_delete = true,
                    "W" | "AD" | "WA" | "WEA" => st.deny_write = true,
                    _ => {}
                }
            }
        }
        Ok(st)
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(p).map_err(|e| format!("读取权限失败: {e}"))?.permissions().mode();
        // 非 Windows 只有只读近似：写位全无 = 只读（视为防写入生效）
        let ro = mode & 0o222 == 0;
        Ok(LockState { deny_delete: ro, deny_write: ro })
    }
}

/// 启动自愈：按期望强度**幂等**重建 ACE（对齐原版 SweepRepair）。
///
/// 处理上次异常退出、icacls 中途失败、或外部拆锁造成的不一致：
///   · desired 里每条：目录存在且与期望不符才重建（已符合就免写，省一次外部进程）；
///   · known 里不在 desired 中的（已从配置移除的旧条目）：只清残留的本工具 deny。
///
/// 单条失败不影响其余，逐条返回错误（空 vec = 全部成功）。
/// **绝不因为自愈失败阻断启动** —— 那会让软件起不来。
pub fn sweep_repair(desired: &[(String, bool, bool)], known: &[String]) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    let mut wanted: Vec<String> = Vec::new();
    for (raw, dd, dw) in desired {
        match lock_state(raw) {
            Ok(cur) if cur.deny_delete == *dd && cur.deny_write == *dw => {
                wanted.push(raw.clone());
                continue; // 已符合期望，免写
            }
            Ok(_) => {
                wanted.push(raw.clone());
                if let Err(e) = apply_lock(raw, *dd, *dw) {
                    errors.push(format!("{raw}: {e}"));
                }
            }
            // 目录不存在 / 读不到：无从谈起保护，跳过（不报错刷屏）
            Err(_) => { wanted.push(raw.clone()); }
        }
    }
    for raw in known {
        if wanted.iter().any(|w| w == raw) { continue; }
        match lock_state(raw) {
            Ok(st) if st.any() => {
                if let Err(e) = apply_lock(raw, false, false) {
                    errors.push(format!("{raw}: {e}"));
                }
            }
            _ => {}
        }
    }
    errors
}

/// 应用 / 解除保护。Windows 走 icacls（best-effort），Unix 退化为 chmod 只读。
pub fn apply_lock(path: &str, deny_delete: bool, deny_write: bool) -> Result<String, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }

    #[cfg(windows)]
    {
        /*
         * 先清掉旧的 deny，避免叠加。
         *
         * 这里**不能**再 `let _ =` 吞掉 —— 解除失败却返回 Ok("已解除保护")，
         * 是一次会留下后果的假成功：用户点了「解除保护」、界面也这么说，
         * 而目录仍然被系统拦着。之后他删不掉 / 改不动，却想不到是这次解除
         * 没生效（报错在几分钟前的那一次操作里，且当时显示的是成功）。
         *
         * 也不能**只看退出码就报错**：`icacls /remove:d` 在「没有匹配 ACE」
         * 时的退出码未经实测，若它非 0，一律报错会让"解除保护"在从未加过
         * 锁的目录上永远失败 —— 那比现在更糟（本来好好的功能变成不可用）。
         *
         * 所以分两步：退出码非 0 时**读回实际状态**再定。
         * 仍然拒绝 → 真的失败，报出来；已经没有 deny → 属于"本来就没东西可清"，
         * 放过。这样两头的错都不会犯，且不依赖退出码的具体语义。
         */
        let rm = run_cmd("icacls", &[path.to_string(), "/remove:d".to_string(), "Everyone".to_string()]);
        let removed_ok = match &rm {
            Ok(out) => out.status.success(),
            Err(_) => false,
        };
        if !removed_ok {
            /*
             * 读回失败时**不能**据此报错：那只是"我们不知道"（icacls 输出
             * 换了语言 / 解析不到），据此报错会把一次可能成功的解除判成失败。
             * 这条通路是"宁可放过，不可误报"。
             */
            let still = lock_state(path).map(|st| st.any()).unwrap_or(false);
            if still {
                let why = match &rm {
                    Err(e) => e.clone(),
                    Ok(out) => String::from_utf8_lossy(&out.stderr).trim().to_string(),
                };
                return Err(format!("解除保护失败（目录仍处于受保护状态）{}{}",
                    if why.is_empty() { String::new() } else { format!(": {why}") },
                    "；可尝试以管理员身份重试，或手动执行：icacls \"".to_string()
                        + path + "\" /remove:d Everyone"));
            }
        }
        if !deny_delete && !deny_write {
            return Ok("已解除保护".into());
        }
        // (OI)(CI) 让规则继承到子对象；D=删除，W=写入
        let mut rights = String::new();
        if deny_delete { rights.push('D'); }
        if deny_write { rights.push('W'); }
        // 两个都为 false 的情况已在上面提前返回，这里 rights 必非空
        /*
         * 必须下**两条** ACE（对齐原版 FolderLockService.Apply）：
         *
         *   · `Everyone:(OI)(CI)(…)`  —— 靠继承作用于子文件与子目录；
         *   · `Everyone:(…)`          —— **目录自身**（不带继承标记即只作用于本对象）。
         *
         * 此前只有第一条。缺第二条的实际后果：
         *
         *   · 防删除档：拒绝的是"删除该目录里的子项"这件事在子项上的落地，
         *     而**删除子项**的权限检查走的是**父目录**上的 DELETE_CHILD ——
         *     目录自身没有 deny，里面的文件仍然删得掉，只有目录本身删不掉；
         *   · 防写入档：`CreateFiles` 走父目录的 WriteData 检查，
         *     目录自身没有 deny，仍能往里**新建**文件。
         *
         * 两种情形都是"用户以为锁住了、实际没锁住"，且没有任何报错。
         */
        for perm in [format!("Everyone:(OI)(CI)({rights})"), format!("Everyone:({rights})")] {
            let out = run_cmd("icacls", &[path.to_string(), "/deny".to_string(), perm])?;
            if !out.status.success() {
                return Err(format!("icacls 失败: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
        }
        // 三个分支都得 .into()：函数返回 Result<String, _>，
        // 前两个转了而最后一个漏掉，第三个分支就会是 &str，与 String 不匹配。
        Ok(if deny_delete && deny_write { "已启用防删除 + 防写入".into() }
           else if deny_delete { "已启用防删除".into() }
           else { "已启用防写入".into() })
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        // 非 Windows 没有独立的"防删除"档，只能用只读近似：
        // 防写入 → 目录设 0o555；仅防删除 → 也设只读（否则等于没保护）。
        // 关键：消息必须与实际落地的权限一致，不能嘴上说只读、实际是 0o755。
        let read_only = deny_write || deny_delete;
        let mode = if read_only { 0o555 } else { 0o755 };
        fs::set_permissions(p, fs::Permissions::from_mode(mode))
            .map_err(|e| format!("修改权限失败: {e}"))?;
        if deny_delete && !deny_write {
            return Ok("已设为只读（当前平台不支持单独的防删除档）".into());
        }
        if read_only {
            return Ok("已设为只读".into());
        }
        Ok("已解除保护".into())
    }
}

#[cfg(windows)]
fn run_cmd(program: &str, args: &[String]) -> Result<std::process::Output, String> {
    // program 是写死的字面量（icacls / attrib），风险在参数：
    // 路径若含引号 / % / & 会被 cmd 重新解释，先挡掉再说
    for a in args {
        if !safe_cmd_arg(a) {
            return Err(format!("参数含不安全字符，已拒绝执行 {program}: {a}"));
        }
    }
    Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("无法执行 {program}: {e}"))
}

/* ---------------------------- 资源管理器图标（desktop.ini） ---------------------------- */

const INI_NAME: &str = "desktop.ini";

/*
 * 通知 Shell 某文件夹图标已变更（对齐原版 FolderIconService.NotifyShellIconChanged）。
 *
 * **为什么要它**：写完 desktop.ini 后，资源管理器仍用**旧的图标缓存**渲染 ——
 * 用户看到的是"设了图标、资源管理器却没变"，只能自己按 F5。
 * 此前本版的返回消息里就写着"可能需要按 F5 刷新"，那其实是把该做的事推给了用户。
 *
 * 三步缺一不可（原版注释逐条写明）：
 *   1. UPDATEDIR   —— 丢弃外壳对该目录的解析缓存并重读 desktop.ini
 *                     （"文件夹→图标位置"缓存失效的关键）
 *   2. UPDATEITEM  —— 精准刷新文件夹自身的显示项
 *   3. ASSOCCHANGED—— 全局关联兜底，清理图像级缓存
 *
 * 失败一律静默：刷新失败只是"图标延迟更新"，绝不能因此让设置图标这个操作失败 ——
 * desktop.ini 已经写好了，报一个跟结果相反的错更糟。
 */
#[cfg(windows)]
mod shell_notify {
    #[link(name = "shell32")]
    extern "system" {
        pub fn SHChangeNotify(w_event_id: i32, u_flags: u32, dw_item1: *const u16, dw_item2: *const u16);
    }
}

#[cfg(windows)]
const SHCNE_UPDATEDIR: i32 = 0x0000_1000;
#[cfg(windows)]
const SHCNE_UPDATEITEM: i32 = 0x0000_2000;
#[cfg(windows)]
const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;
#[cfg(windows)]
const SHCNF_PATHW: u32 = 0x0005;
#[cfg(windows)]
const SHCNF_IDLIST: u32 = 0x0000;
#[cfg(windows)]
const SHCNF_FLUSH: u32 = 0x1000;

/// 刷新某文件夹在资源管理器里的图标显示。非 Windows 为空操作。
pub fn notify_shell_icon_changed(dir: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = std::ffi::OsStr::new(dir)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            shell_notify::SHChangeNotify(
                SHCNE_UPDATEDIR, SHCNF_PATHW | SHCNF_FLUSH, wide.as_ptr(), std::ptr::null());
            shell_notify::SHChangeNotify(
                SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSH, wide.as_ptr(), std::ptr::null());
            /* 第三步不带路径（IDLIST），两个指针都传 null */
            shell_notify::SHChangeNotify(
                SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, std::ptr::null(), std::ptr::null());
        }
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
    }
}

/// 写入 / 清除文件夹图标。icon_ref 形如 "<ico 路径>" 或 "<dll 路径>|<索引>"；空 = 清除。
pub fn apply_icon(dir: &str, icon_ref: &str) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = (dir, icon_ref);
        return Err("当前平台不支持写入资源管理器图标（已记录到配置，仅界面内生效）".into());
    }

    #[cfg(windows)]
    {
        let p = Path::new(dir);
        if !p.is_dir() {
            return Err(format!("目录不存在: {dir}"));
        }
        let ini = p.join(INI_NAME);
        let (file, index) = split_icon_ref(icon_ref);
        let ini_arg = || ini.to_string_lossy().to_string();

        if icon_ref.trim().is_empty() {
            if ini.exists() {
                // 先摘属性再改，否则隐藏/系统属性可能让写入失败
                let _ = run_cmd("attrib", &["-s".to_string(), "-h".to_string(), ini_arg()]);
                // 读不出来就放弃（#510）：宁可什么都不做，也不覆盖未知内容
                if let Some(text) = read_ini_text(&ini)? {
                    let merged = remove_icon_resource(&text);
                    if merged.trim().is_empty() {
                        fs::remove_file(&ini).ok();
                    } else {
                        write_ini_text(&ini, &merged)?;
                        let _ = run_cmd("attrib", &["+h".to_string(), "+s".to_string(), ini_arg()]);
                    }
                }
            }
            // 文件夹只清系统属性；**绝不动 +h**——加 +h 会让文件夹本身
            // 在资源管理器里被隐藏，用户会以为数据丢了
            let _ = run_cmd("attrib", &["-s".to_string(), p.to_string_lossy().to_string()]);
            /* 清除也要通知：否则图标**仍显示旧的**，用户以为没删掉 */
            notify_shell_icon_changed(dir);
            return Ok("已恢复默认图标".into());
        }

        // 读原有内容（不存在则 None）；读失败时 `?` 直接放弃写入
        let content = match read_ini_text(&ini)? {
            Some(t) => set_icon_resource(&t, &file, index),
            None => format!(
                "[.ShellClassInfo]\r\n{}\r\n",
                build_icon_resource_line(&file, index)
            ),
        };
        /*
         * 摘属性这一步**可以**失败：ini 可能还不存在（下面才创建），
         * 也可能本来就没有 +s/+h。attrib 对"无属性可摘"返回非 0，
         * 据此报错会让首次设置永远失败。所以这里保留 Best-effort。
         */
        let _ = run_cmd("attrib", &["-s".to_string(), "-h".to_string(), ini_arg()]);
        write_ini_text(&ini, &content)?;
        /*
         * 文件夹的 +s **必须检查**：资源管理器只在目录带系统属性时才读
         * 它的 desktop.ini。这一步失败的话 ini 写得再对也**根本不会被读取**
         * —— 用户看到的是"设了图标、资源管理器没变"，而回包说"已写入"，
         * 无从知道是属性没加上。
         *
         * 常见失败原因就是目录被自己设了「防写入」（WriteAttributes 被 deny），
         * 那正是 #427 的 `with_unlock` 要解决的；若**在窗口内仍然失败**，
         * 说明还有别的拦截，必须说出来而不是静默继续。
         */
        let sout = run_cmd("attrib", &["+s".to_string(), p.to_string_lossy().to_string()]);
        match sout {
            Ok(out) if out.status.success() => {}
            Ok(out) => return Err(format!(
                "已写入 desktop.ini，但未能给目录加系统属性（+s），资源管理器不会读取它: {}",
                String::from_utf8_lossy(&out.stderr).trim())),
            Err(e) => return Err(format!("已写入 desktop.ini，但未能给目录加系统属性（+s）: {e}")),
        }
        // ini 自身加 +h +s 只是**外观**（不在资源管理器里显示这个文件），
        // 失败不影响图标生效，所以这里可以 Best-effort。
        let _ = run_cmd("attrib", &["+h".to_string(), "+s".to_string(), ini_arg()]);
        /*
         * 写完后必须通知 Shell，否则资源管理器仍拿旧缓存渲染 ——
         * 此前这句消息里写着"可能需要按 F5 刷新"，那是把该做的事推给了用户。
         */
        notify_shell_icon_changed(dir);
        Ok("已写入资源管理器图标".into())
    }
}

/**
 * 从 ini 文本里读出 `IconResource` 的值（#139 用来报"来源"）。
 *
 * 只认 `[.ShellClassInfo]` 段下的那一行：ini 里可能还有别的段，
 * 直接全文找 "IconResource" 会把别处的同名键当成图标来源。
 */
#[cfg(windows)]
pub fn icon_resource_in(text: &str) -> Option<String> {
    let mut in_sec = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_sec = t.eq_ignore_ascii_case("[.ShellClassInfo]");
            continue;
        }
        if !in_sec { continue; }
        /*
         * 两种键名都要认（对齐原版 GetCustomIconReference）：
         *   · `IconResource=` —— Vista+ 常用；
         *   · `IconFile=`     —— **旧格式**，XP 时代或别的工具写出来的 ini 里仍是这个。
         *
         * 只认前者的话，那些文件夹会被报成"没有自定义图标"，
         * 而资源管理器里**明明显示着图标** —— 又是显示与实际不一致，且看不出原因。
         */
        let v = t.strip_prefix("IconResource=")
            .or_else(|| t.strip_prefix("iconresource="))
            .or_else(|| t.strip_prefix("IconFile="))
            .or_else(|| t.strip_prefix("iconfile="));
        if let Some(v) = v {
            /* 形如 `"C:\a b.ico",0` 或 `a.ico,0`：去掉索引与可选引号。
               路径本身可能含逗号，所以从**最后一个逗号**切 */
            let v = v.trim();
            let (file, idx) = match v.rfind(',') {
                Some(k) => (v[..k].trim(), v[k + 1..].trim()),
                None => (v, "0"),
            };
            let file = file.trim_matches('"');
            if file.is_empty() { return None; }
            /* 无索引（如 `IconResource=C:\x\i.ico`）按 0 处理，而不是整条放弃 */
            let idx = if idx.is_empty() { "0" } else { idx };
            return Some(format!("{file}|{idx}"));
        }
    }
    None
}

/**
 * #139 图标来源查询：把"现在生效的图标是从哪儿来的"说清楚。
 *
 * 为什么需要它：只回一个图标值的话，用户分不清自己看到的是
 * **资源管理器里那个**（来自 desktop.ini）还是**界面里那个**（来自 GUI 映射），
 * 于是"界面改了图标、资源管理器没变"会被当成 bug —— 而那其实是正确的
 * （`icon_affect_explorer` 关掉时就是这样）。
 *
 * 返回：`(来源, 图标引用, ini 是否存在, 文件夹是否带 System 属性)`
 *
 * 来源取值：`guiMap`（界面专属映射，优先级最高）/ `desktopIni` / `none`。
 */
pub fn icon_source(dir: &str, gui_icon: Option<String>, affect_explorer: bool) -> (String, Option<String>, bool, bool) {
    #[cfg(windows)]
    {
        /* 这里**不读** affect_explorer：来源是直接看磁盘上有没有 ini，
           比"配置说要写"更准 —— 配置与实际可能已经不一致（比如用户手删了 ini）。 */
        let _ = affect_explorer;
        let p = Path::new(dir);
        let ini = p.join(INI_NAME);
        let ini_exists = ini.exists();
        let from_ini = if ini_exists {
            match read_ini_text(&ini) { Ok(Some(t)) => icon_resource_in(&t), _ => None }
        } else { None };
        let system_attr = has_system_attr(dir);
        /*
         * 优先级：**GUI 映射 > desktop.ini**（原版 ResolveFolderIcon 明写，
         * 本版前端 `displayIcon` 也是 `c.guiIcon ?? c.icon`）。
         *
         * 之前这里把 desktop.ini 排在前面，于是"设了 GUI 专属图标、
         * 而目录里还留着一份旧的 desktop.ini"（先开同步设过、后来关掉，
         * 或被别的工具写过）时会报成 desktopIni + 旧图标值 ——
         * 而界面上显示的是 guiIcon。**报告与实际显示不一致，且没有任何报错**，
         * MCP 调用方据此以为生效的是另一个图标。
         *
         * 反过来说：两边都设了时以哪边为准，必须和界面上真正画出来的那个一致，
         * 否则"查状态"这个动作本身就在骗人。
         */
        if let Some(g) = gui_icon {
            return ("guiMap".into(), Some(g), ini_exists, system_attr);
        }
        if let Some(r) = from_ini {
            return ("desktopIni".into(), Some(r), ini_exists, system_attr);
        }
        ("none".into(), None, ini_exists, system_attr)
    }
    #[cfg(not(windows))]
    {
        let _ = (dir, affect_explorer);
        match gui_icon {
            Some(g) => ("guiMap".into(), Some(g), false, false),
            None => ("none".into(), None, false, false),
        }
    }
}

/// 文件夹是否带 System 属性（资源管理器要靠它才会读 desktop.ini）。
#[cfg(windows)]
fn has_system_attr(dir: &str) -> bool {
    match run_cmd("attrib", &[dir.to_string()]) {
        Ok(out) => {
            /* attrib 输出形如 "S    C:\foo" 或 "    C:\foo"：
               属性字母固定在最前面几个字节里，取第一段判含 'S' 即可。
               不能全文找 'S' —— 路径里可能就有大写 S。 */
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            let head = text.split_whitespace().next().unwrap_or_default().to_string();
            head.contains('S')
        }
        Err(_) => false,
    }
}

#[cfg(windows)]
fn split_icon_ref(icon_ref: &str) -> (String, i32) {
    let mut parts = icon_ref.splitn(2, '|');
    let file = parts.next().unwrap_or("").trim().to_string();
    let index = parts.next().and_then(|s| s.trim().parse::<i32>().ok()).unwrap_or(0);
    (file, index)
}

/**
 * 拼 `IconResource=…` 这一行（`#304` `#512`）。
 *
 * **路径含空格或逗号时必须用双引号包裹**，写成：
 *
 *   IconResource="C:\My Icons\folder.ico",0
 *
 * 不包裹的话 Shell 会按空格把路径截断，图标**静默失效** ——
 * 不报错、不提示，用户只会看到"图标没换"，完全无从下手。
 * 而含空格的路径恰恰是常态（`C:\Users\张三\My Projects\…`）。
 *
 * 只在需要时才加引号：不带空格/逗号的路径保持原样输出，
 * 与修复前的字节完全一致，避免对已生效的用户造成任何变化。
 *
 * 逗号也要加引号：`IconResource=a,b.ico,0` 里哪个逗号是索引分隔符
 * 取决于解析方式，加了引号后分隔符就是最后一个逗号，语义才唯一。
 *
 * 路径里的双引号不必转义 —— Windows 文件名本就不允许这个字符。
 */
#[cfg(windows)]
fn build_icon_resource_line(file: &str, index: i32) -> String {
    let needs_quote = file.contains(' ') || file.contains(',');
    if needs_quote {
        format!("IconResource=\"{file}\",{index}")
    } else {
        format!("IconResource={file},{index}")
    }
}

/* ---------------------------- desktop.ini 的读写（编码安全 + 合并式修改） ---------------------------- */

/**
 * 按 BOM **精确**判定编码来读 desktop.ini；文件不存在返回 `Ok(None)`。
 *
 * 为什么不能"先试 UTF-8、失败再回退 UTF-16"：
 * UTF-16LE 的字节流（如 `61 00 62 00`）当 UTF-8 解析时**几乎不会报错**——
 * NUL 是合法的 UTF-8 字符，于是得到 "a\0b\0" 这种乱码，回退分支永远触发不了。
 * 乱码随后被写回，就成了永久脏数据，且用户完全不知道发生了什么。
 * 所以必须先查 BOM：FF FE → UTF-16LE；EF BB BF → UTF-8 跳过 BOM；
 * 都没有才按 UTF-8 试，且**严格解析**——失败就报错，不用 lossy 静默替换。
 *
 * 返回 `Err` 时调用方必须放弃写入（见 #510）：读不出原内容还去覆盖，
 * 等于把未知内容一次性丢掉。
 */
#[cfg(windows)]
fn read_ini_text(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| {
        let p = path.display().to_string();
        format!("读取 desktop.ini 失败（{p}）: {e}")
    })?;

    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16(&units).map(Some).map_err(|e| {
            let p = path.display().to_string();
            format!("desktop.ini 带 UTF-16 BOM 但内容非法（{p}）: {e}")
        });
    }

    let skip = if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        3
    } else {
        0
    };
    String::from_utf8(bytes[skip..].to_vec())
        .map(Some)
        .map_err(|e| {
            let p = path.display().to_string();
            format!("desktop.ini 不是合法文本（{p}）: {e}；已放弃写入以免覆盖未知内容")
        })
}

/// 写回 desktop.ini，统一用 **UTF-16LE 带 BOM**。
///
/// Windows Shell 读取 desktop.ini 时对 ANSI / 无 BOM UTF-8 的处理在不同版本上
/// 并不一致，含中文路径时尤其容易乱码；UTF-16LE 带 BOM 是它最认的格式。
#[cfg(windows)]
fn write_ini_text(path: &Path, text: &str) -> Result<(), String> {
    let mut buf: Vec<u8> = vec![0xFF, 0xFE];
    for u in text.encode_utf16() {
        buf.extend_from_slice(&u.to_le_bytes());
    }
    fs::write(path, &buf).map_err(|e| {
        let p = path.display().to_string();
        format!("写入 desktop.ini 失败（{p}）: {e}")
    })
}

/**
 * 在 ini 文本里设置 `[.ShellClassInfo]` 的 IconResource，**保留其余所有内容**。
 *
 * 为什么要合并而不是整份重写：desktop.ini 里可能有用户或其它程序写的内容
 * —— `[LocalizedFileNames]`（给文件夹起中文别名）、`[ViewState]`（视图设置）
 * 都常见。整份覆盖会把它们一次性吃掉，而且没有任何提示。
 */
#[cfg(windows)]
fn set_icon_resource(text: &str, file: &str, index: i32) -> String {
    merge_icon_line(text, Some(&build_icon_resource_line(file, index)))
}

/// 删掉 IconResource / IconIndex 行（清除图标用）；段因此变空则连带删掉段。
#[cfg(windows)]
fn remove_icon_resource(text: &str) -> String {
    merge_icon_line(text, None)
}

#[cfg(windows)]
fn merge_icon_line(text: &str, new_line: Option<&str>) -> String {
    const SEC: &str = "[.ShellClassInfo]";
    let lines: Vec<String> = text
        .lines()
        .map(|l| l.trim_end_matches('\r').to_string())
        .collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 2);
    let mut in_sec = false;
    let mut handled = false;

    for line in &lines {
        let t = line.trim();
        // 段标题：形如 [xxx]
        if t.starts_with('[') && t.ends_with(']') {
            // 刚离开目标段却还没写入新行 → 补在段末
            if in_sec && !handled {
                if let Some(nl) = new_line {
                    out.push(nl.to_string());
                }
                handled = true;
            }
            in_sec = t.eq_ignore_ascii_case(SEC);
            out.push(line.clone());
            continue;
        }
        if in_sec {
            let key = t
                .split('=')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if key == "iconresource" || key == "iconindex" {
                // 只保留新行这一条，其余同名行（含重复键）丢弃
                if !handled {
                    if let Some(nl) = new_line {
                        out.push(nl.to_string());
                    }
                    handled = true;
                }
                continue;
            }
        }
        out.push(line.clone());
    }
    // 文件末尾仍在目标段内
    if in_sec && !handled {
        if let Some(nl) = new_line {
            out.push(nl.to_string());
        }
        handled = true;
    }

    // 整个目标段都不存在 → 追加到末尾
    if new_line.is_some() && !out.iter().any(|l| l.trim().eq_ignore_ascii_case(SEC)) {
        while out.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
            out.pop();
        }
        if !out.is_empty() {
            out.push(String::new());
        }
        out.push(SEC.to_string());
        out.push(new_line.unwrap().to_string());
    }

    // 清除模式下段内已无内容 → 删掉空段标题
    if new_line.is_none() {
        for i in 0..out.len() {
            if !out[i].trim().eq_ignore_ascii_case(SEC) {
                continue;
            }
            let next = out
                .iter()
                .skip(i + 1)
                .position(|l| l.trim().starts_with('[') && l.trim().ends_with(']'))
                .map(|p| p + i + 1)
                .unwrap_or(out.len());
            if out[i + 1..next].iter().all(|l| l.trim().is_empty()) {
                out.remove(i);
            }
            break;
        }
    }

    let mut s = out.join("\r\n");
    if !s.is_empty() {
        s.push_str("\r\n");
    }
    s
}

/* ---------------------------- 屏幕取色（色盘吸管） ---------------------------- */

/**
 * 读取屏幕某点像素颜色，返回 "#RRGGBB"；坐标省略时取当前鼠标光标所在点。
 *
 * 走 PowerShell + System.Drawing，而非直接调 Win32 GDI：
 * 后者要引 windows-sys，而它的句柄类型在不同版本里是 isize 或 *mut c_void，
 * 拿捏不准就是硬编译错误；本项目其余部分（mklink / icacls）也本就靠外部命令，
 * 风格一致。代价是一次 PowerShell 启动开销（约 0.3~1 秒），取色是低频操作，可接受。
 */
#[cfg(windows)]
pub fn pick_screen_color(x: Option<i32>, y: Option<i32>) -> Result<String, String> {
    // -1 表示「跟随鼠标」；PowerShell 侧据此读 Cursor.Position
    let (px, py) = (x.unwrap_or(-1), y.unwrap_or(-1));
    // 用数组拼接而非换行：PowerShell 的续行符是反引号而非反斜杠，写错会整段解析失败
    let script = [
        "$ErrorActionPreference='Stop'",
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        &format!("$x={px}; $y={py}"),
        "if($x -lt 0){ $p=[System.Windows.Forms.Cursor]::Position; $x=$p.X; $y=$p.Y }",
        "$bmp=[System.Drawing.Bitmap]::new(1,1)",
        "$g=[System.Drawing.Graphics]::FromImage($bmp)",
        "$g.CopyFromScreen($x,$y,0,0,[System.Drawing.Size]::new(1,1))",
        "$c=$bmp.GetPixel(0,0)",
        "$g.Dispose(); $bmp.Dispose()",
        "'{0:X2}{1:X2}{2:X2}' -f $c.R,$c.G,$c.B",
    ].join("; ");

    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("无法启动 PowerShell: {e}"))?;

    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() { "取色失败".into() } else { format!("取色失败: {msg}") });
    }
    let hex = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // 只接受 6 位十六进制，避免 PowerShell 输出多余内容时拼出非法颜色
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("取色返回异常: {hex}"));
    }
    Ok(format!("#{}", hex.to_uppercase()))
}

#[cfg(not(windows))]
pub fn pick_screen_color(_x: Option<i32>, _y: Option<i32>) -> Result<String, String> {
    Err("吸管取色当前仅支持 Windows（其它平台请用 RGB/HEX 输入或系统取色器）".into())
}

/// 列出数据目录 icons/ 下可用的图标文件。
/// 路径是否位于 root 之下（root 自身不算）。比较用规范化后的完整路径，大小写不敏感。
pub fn is_under(root: &str, path: &str) -> bool {
    let r = normalize_key(root);
    let p = normalize_key(path);
    if r.is_empty() || p.is_empty() || r == p { return false; }
    // normalize_key 已把分隔符统一成正斜杠，这里只需比对一种
    p.starts_with(&format!("{r}/"))
}

/// 路径是否位于任一"默认根目录"（新建项目/项目组的预设父目录）之下。
pub fn under_any_default_root(cfg: &FpxConfig, path: &str) -> bool {
    [cfg.create_project_dir.as_deref(), cfg.create_group_dir.as_deref()]
        .into_iter()
        .flatten()
        .any(|root| !root.trim().is_empty() && is_under(root, path))
}

/// 跨类别移动时的物理搬家：把文件夹搬到目标类别默认根目录下（扁平化）。
///
/// 返回 Ok(Some(new_path)) = 已搬家；Ok(None) = 按范围设置/现状判定为"无需搬"；
/// Err = 搬家失败（调用方应中止整个移动，避免出现"卡片换栏了但文件夹没动"的半完成状态）。
pub fn relocate_cross_move(
    cfg: &FpxConfig,
    from_path: &str,
    dst_kind: &str,
) -> Result<Option<String>, String> {
    // 目标类别的默认根目录：项目→createProjectDir，项目组→createGroupDir
    let root = if dst_kind == "group" {
        cfg.create_group_dir.as_deref()
    } else {
        cfg.create_project_dir.as_deref()
    };
    let root = match root.map(str::trim) {
        Some(r) if !r.is_empty() => r,
        _ => return Ok(None), // 根目录未配置：跳过物理移动
    };
    if !Path::new(root).is_dir() { return Ok(None); }

    let old = Path::new(from_path);
    if !old.is_dir() { return Ok(None); }

    let name = old.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if name.is_empty() { return Ok(None); }

    let new_path = Path::new(root).join(&name);
    if normalize_key(&new_path.to_string_lossy()) == normalize_key(from_path) {
        return Ok(None); // 已就位
    }

    // 搬家范围
    match cfg.move_folder_scope.as_str() {
        "defaultRoots" => {
            if !under_any_default_root(cfg, from_path) { return Ok(None); }
            if is_under(root, from_path) { return Ok(None); } // 已在目标根内，保持原位
        }
        "defaultRootsFlatten" => {
            if !under_any_default_root(cfg, from_path) { return Ok(None); }
        }
        _ => {} // anywhere
    }

    if new_path.exists() {
        return Err(format!("目标位置已存在同名文件夹，未移动：{}", new_path.display()));
    }

    // 跨卷时 rename 必然失败，此时回退到"复制 + 删除"。
    // 回退的失败语义是"复制没成功就绝不删源"，所以不会留下残缺数据 ——
    // 最坏情况是源目录原地不动（返回 Err，调用方中止整个移动）。
    rename_with_fallback(old, &new_path).map_err(|e| format!("移动文件夹失败：{e}"))?;
    Ok(Some(new_path.to_string_lossy().to_string()))
}

/// 把卡片从源类别的页签中摘除（全部页签都清，避免同一路径残留在别的页签里）。
pub fn remove_card_from_tabs(tabs: &mut [TabItem], path: &str) {
    for t in tabs.iter_mut() {
        t.items.retain(|p| normalize_key(p) != normalize_key(path));
    }
}

/// 把路径插入目标类别指定页签的指定位置。
pub fn insert_card_into_tab(tabs: &mut Vec<TabItem>, tab_index: usize, to_index: usize, path: &str) {
    if tabs.is_empty() { tabs.push(TabItem { name: "默认".into(), items: vec![] }); }
    let i = tab_index.min(tabs.len() - 1);
    let items = &mut tabs[i].items;
    let at = to_index.min(items.len());
    items.insert(at, path.to_string());
}

pub fn list_icons(data_dir: &Path) -> Vec<String> {
    let dir = data_dir.join("icons");
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() { continue; }
            if let Some(ext) = p.extension() {
                let ext = ext.to_string_lossy().to_lowercase();
                if matches!(ext.as_str(), "ico" | "png" | "jpg" | "jpeg" | "bmp") {
                    out.push(p.to_string_lossy().to_string());
                }
            }
        }
    }
    out.sort();
    out
}
