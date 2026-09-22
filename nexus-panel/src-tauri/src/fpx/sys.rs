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
    fs::create_dir_all(&target).map_err(|e| format!("创建文件夹失败: {e}"))?;

    if let Some(tpl) = template {
        let tpl = tpl.trim();
        if !tpl.is_empty() {
            let tpl_path = Path::new(tpl);
            if tpl_path.is_dir() {
                copy_tree(tpl_path, &target)?;
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

/// 应用 / 解除保护。Windows 走 icacls（best-effort），Unix 退化为 chmod 只读。
pub fn apply_lock(path: &str, deny_delete: bool, deny_write: bool) -> Result<String, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }

    #[cfg(windows)]
    {
        // 先清掉旧的 deny，避免叠加
        let _ = run_cmd("icacls", &[path.to_string(), "/remove:d".to_string(), "Everyone".to_string()]);
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
        let _ = run_cmd("attrib", &["-s".to_string(), "-h".to_string(), ini_arg()]);
        write_ini_text(&ini, &content)?;
        // 文件夹加 +s（让资源管理器读取 ini）；ini 本身加 +h +s（隐藏它）
        let _ = run_cmd("attrib", &["+s".to_string(), p.to_string_lossy().to_string()]);
        let _ = run_cmd("attrib", &["+h".to_string(), "+s".to_string(), ini_arg()]);
        Ok("已写入资源管理器图标（资源管理器可能需要按 F5 刷新）".into())
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
        if let Some(v) = t.strip_prefix("IconResource=").or_else(|| t.strip_prefix("iconresource=")) {
            /* 形如 `"C:\a b.ico",0` 或 `a.ico,0`：去掉索引与可选引号。
               路径本身可能含逗号，所以从**最后一个逗号**切 */
            let v = v.trim();
            let (file, idx) = match v.rfind(',') {
                Some(k) => (v[..k].trim(), v[k + 1..].trim()),
                None => (v, "0"),
            };
            let file = file.trim_matches('"');
            if file.is_empty() { return None; }
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
        if let Some(r) = from_ini {
            return ("desktopIni".into(), Some(r), ini_exists, system_attr);
        }
        if let Some(g) = gui_icon {
            return ("guiMap".into(), Some(g), ini_exists, system_attr);
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
