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
        let perm = format!("Everyone:(OI)(CI)({rights})");
        let out = run_cmd("icacls", &[path.to_string(), "/deny".to_string(), perm])?;
        if !out.status.success() {
            return Err(format!("icacls 失败: {}", String::from_utf8_lossy(&out.stderr).trim()));
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

        if icon_ref.trim().is_empty() {
            if ini.exists() {
                let _ = run_cmd("attrib", &[format!("-s"), "-h".to_string(), ini.to_string_lossy().to_string()]);
                fs::remove_file(&ini).ok();
            }
            let _ = run_cmd("attrib", &["-s".to_string(), p.to_string_lossy().to_string()]);
            return Ok("已恢复默认图标".into());
        }

        let content = format!("[.ShellClassInfo]\r\nIconResource={file},{index}\r\n");
        fs::write(&ini, content).map_err(|e| format!("写入 desktop.ini 失败: {e}"))?;
        // +s 让资源管理器读取该 ini；+h 隐藏 ini 本身
        let _ = run_cmd("attrib", &["+s".to_string(), p.to_string_lossy().to_string()]);
        let _ = run_cmd("attrib", &["+h".to_string(), "+s".to_string(), ini.to_string_lossy().to_string()]);
        Ok("已写入资源管理器图标（资源管理器可能需要按 F5 刷新）".into())
    }
}

#[cfg(windows)]
fn split_icon_ref(icon_ref: &str) -> (String, i32) {
    let mut parts = icon_ref.splitn(2, '|');
    let file = parts.next().unwrap_or("").trim().to_string();
    let index = parts.next().and_then(|s| s.trim().parse::<i32>().ok()).unwrap_or(0);
    (file, index)
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
