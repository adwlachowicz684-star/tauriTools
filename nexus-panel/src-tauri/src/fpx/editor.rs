//! 编辑器候选枚举：给「打开编辑」挑程序用。
//! ------------------------------------------------------------------
//! 对齐 junction_link 的 Services/EditorPickService.cs（枚举系统「打开方式」里能开 .md 的程序）。
//! 原版走 Shell COM（SHAssocEnumHandlers）+ 注册表兜底；这里为免引入 COM 依赖，
//! 改成三路并集，覆盖度足够且跨平台一致：
//!   1) 已知编辑器的常见安装位置（Windows / macOS / Linux 各自的固定路径）
//!   2) PATH 中查找已知命令名（code / cursor / nvim …）
//!   3) Windows 再补一步 `reg query` 读 .md 的打开方式；macOS 扫 /Applications/*.app
//! 只读操作，结果按 exe 路径去重。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::fpx::safety::{check_executable, safe_cmd_arg};

/// 一个编辑器候选。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCandidate {
    pub name: String,
    pub exe: String,
}

/// 已知编辑器：显示名 + 命令名/相对路径（用于在 PATH 与固定位置中定位）。
const KNOWN: &[(&str, &[&str])] = &[
    ("Visual Studio Code", &["code", "code.cmd", "Code.exe"]),
    ("Cursor", &["cursor", "cursor.cmd", "Cursor.exe"]),
    ("Trae", &["trae", "trae.cmd", "Trae.exe"]),
    ("Trae-CN", &["trae-cn", "trae-cn.cmd", "Trae CN.exe"]),
    ("Windsurf", &["windsurf", "Windsurf.exe"]),
    ("Sublime Text", &["subl", "sublime_text", "Sublime Text.exe"]),
    ("Neovim", &["nvim"]),
    ("Vim", &["vim"]),
    ("Emacs", &["emacs"]),
    ("Typora", &["typora", "Typora.exe"]),
    ("Obsidian", &["obsidian", "Obsidian.exe"]),
    ("Notepad++", &["notepad++", "notepad++.exe"]),
    ("Notepad", &["notepad", "notepad.exe"]),
    ("gedit", &["gedit"]),
    ("Kate", &["kate"]),
    ("TextEdit", &["TextEdit"]),
];

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default()
}

fn is_file(p: &Path) -> bool { p.is_file() }

/// PATH 中按命令名查找（Windows 追加 PATHEXT 尝试）。
fn find_in_path(names: &[&str]) -> Option<PathBuf> {
    let dirs = path_dirs();
    let exts: Vec<String> = std::env::var("PATHEXT")
        .map(|v| v.split(';').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    for name in names {
        for dir in &dirs {
            let direct = dir.join(name);
            if is_file(&direct) { return Some(direct); }
            for ext in &exts {
                let with_ext = dir.join(format!("{name}{ext}"));
                if is_file(&with_ext) { return Some(with_ext); }
            }
        }
    }
    None
}

/// 本机常见安装位置（按平台返回候选目录，逐个探测）。
fn fixed_locations(display: &str) -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let mut out: Vec<PathBuf> = Vec::new();

    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let pf = std::env::var_os("ProgramFiles").map(PathBuf::from);
        let pf86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
        let bases: Vec<PathBuf> = [local, pf, pf86].into_iter().flatten().collect();
        for base in bases {
            match display {
                "Visual Studio Code" => {
                    out.push(base.join("Programs").join("Microsoft VS Code").join("Code.exe"));
                    out.push(base.join("Microsoft VS Code").join("Code.exe"));
                }
                "Cursor" => {
                    let d = base.join("Programs").join("Cursor");
                    out.push(d.join("Cursor.exe"));
                }
                "Trae" => {
                    let d = base.join("Programs").join("Trae");
                    out.push(d.join("Trae.exe"));
                }
                "Trae-CN" => {
                    let d = base.join("Programs").join("Trae CN");
                    out.push(d.join("Trae CN.exe"));
                }
                "Windsurf" => {
                    let d = base.join("Programs").join("Windsurf");
                    out.push(d.join("Windsurf.exe"));
                }
                "Sublime Text" => out.push(base.join("Sublime Text").join("sublime_text.exe")),
                "Notepad++" => out.push(base.join("Notepad++").join("notepad++.exe")),
                "Typora" => out.push(base.join("Typora").join("Typora.exe")),
                "Obsidian" => out.push(base.join("Obsidian").join("Obsidian.exe")),
                _ => {}
            }
        }
    } else if cfg!(target_os = "macos") {
        let apps = PathBuf::from("/Applications");
        match display {
            "Visual Studio Code" => out.push(apps.join("Visual Studio Code.app")),
            "Cursor" => out.push(apps.join("Cursor.app")),
            "Trae" => out.push(apps.join("Trae.app")),
            "Trae-CN" => out.push(apps.join("Trae CN.app")),
            "Windsurf" => out.push(apps.join("Windsurf.app")),
            "Sublime Text" => out.push(apps.join("Sublime Text.app")),
            "Typora" => out.push(apps.join("Typora.app")),
            "Obsidian" => out.push(apps.join("Obsidian.app")),
            "TextEdit" => out.push(apps.join("TextEdit.app")),
            _ => {}
        }
        if let Some(h) = &home {
            let user_apps = PathBuf::from(h).join("Applications");
            // 用户级安装（~/Applications）同样值得一探
            for sub in ["Visual Studio Code", "Cursor", "Trae", "Windsurf", "Sublime Text", "Typora", "Obsidian"] {
                if sub == display { out.push(user_apps.join(format!("{sub}.app"))); }
            }
        }
    } else {
        // Linux：常见 bin 名已在 KNOWN 里由 PATH 覆盖，这里补几个 snap / flatpak / 固定路径
        for p in ["/usr/bin/code", "/snap/bin/code", "/usr/bin/cursor", "/usr/bin/trae",
                  "/usr/bin/windsurf", "/usr/bin/subl", "/usr/bin/typora", "/usr/bin/obsidian",
                  "/usr/bin/gedit", "/usr/bin/kate"] {
            let pb = PathBuf::from(p);
            if pb.file_name().map(|f| f.to_string_lossy().to_lowercase())
                .map(|f| display.to_lowercase().contains(&f.replace(".exe", ""))).unwrap_or(false)
            {
                out.push(pb);
            }
        }
    }
    out
}

/// Windows：用 reg query 读 .md 的默认打开程序（Shell/COM 之外的轻量替代）。
#[cfg(windows)]
fn from_registry() -> Vec<EditorCandidate> {
    let mut out = Vec::new();
    let queries = [
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice",
        r"HKCR\.md",
    ];
    for key in queries {
        let text = std::process::Command::new("reg")
            .args(["query", key, "/v", "ProgId"])
            .output()
            .ok()
            // 必须 &：from_utf8_lossy 要的是 &[u8]，而 out.stdout 是 Vec<u8>，
            // Vec 不会自动转切片（本文件 184 行那处同类调用就带了 &）
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        // 输出形如 "    ProgId    REG_SZ    VSCode.md"
        if let Some(rest) = text.split("REG_SZ").nth(1) {
            let progid = rest.trim();
            if progid.is_empty() { continue; }
            // progid 是注册表里读出来的字符串，会被拼进下一条 reg query 的键名。
            // 它理论上可被任意程序写入（HKCU 分支），拼进命令行前必须校验字符集，
            // 否则一条带元字符的 ProgId 就能改写整条 reg 命令的参数结构。
            if !safe_cmd_arg(progid) { continue; }
            if let Some(cmd) = reg_query(&format!(r"HKCR\{progid}\shell\open\command")) {
                if let Some(exe) = parse_command(&cmd) {
                    let p = PathBuf::from(&exe);
                    // 注册表里的命令同样可被任意程序写入（HKCU 分支），
                    // 这里只做存在性 + 扩展名白名单校验，不放行脚本类宿主
                    if check_executable(&p).is_ok() {
                        out.push(EditorCandidate {
                            name: progid.trim_end_matches(".md").to_string(),
                            exe,
                        });
                    }
                }
            }
        }
    }
    out
}

#[cfg(windows)]
fn reg_query(key: &str) -> Option<String> {
    let o = std::process::Command::new("reg").args(["query", key]).output().ok()?;
    let text = String::from_utf8_lossy(&o.stdout).to_string();
    for line in text.lines() {
        if let Some(rest) = line.split("REG_SZ").nth(1) {
            let v = rest.trim();
            if !v.is_empty() { return Some(v.to_string()); }
        }
    }
    None
}

/// 从 shell\open\command 提取主程序路径（带引号取引号内，否则按 .exe 边界截断）。
#[cfg(windows)]
fn parse_command(cmd: &str) -> Option<String> {
    let cmd = cmd.trim();
    if cmd.is_empty() { return None; }
    let raw = if cmd.starts_with('"') {
        let end = cmd[1..].find('"')? + 1;
        cmd[1..end].to_string()
    } else {
        let lower = cmd.to_lowercase();
        match lower.find(".exe").or_else(|| lower.find(".bat")) {
            Some(i) => cmd[..(i + 4)].to_string(),
            None => cmd.split_whitespace().next().unwrap_or("").to_string(),
        }
    };
    let raw = raw.trim().trim_matches('"').to_string();
    if raw.is_empty() { None } else { Some(raw) }
}

#[cfg(not(windows))]
fn from_registry() -> Vec<EditorCandidate> { Vec::new() }

/// macOS 上「一眼就是编辑器/IDE」的应用名关键词。
/// /Applications 里可能塞着上百个 .app，必须过滤，否则会把 Safari、计算器
/// 之类一起列成「可打开 .md 的程序」。
#[cfg(target_os = "macos")]
const APP_KEYWORDS: &[&str] = &[
    "code", "cursor", "trae", "windsurf", "sublime", "typora", "obsidian",
    "textedit", "vim", "emacs", "nova", "zed", "atom", "notepad", "writer",
    "markdown", "editor", "text",
];

#[cfg(target_os = "macos")]
fn is_editor_app(name: &str) -> bool {
    let lower = name.to_lowercase();
    APP_KEYWORDS.iter().any(|k| lower.contains(k))
}

/// macOS：/Applications 下的 .app，只保留名字像编辑器的那些。
#[cfg(target_os = "macos")]
fn from_applications() -> Vec<EditorCandidate> {
    let mut out = Vec::new();
    for dir in ["/Applications", &format!("{}/Applications", std::env::var("HOME").unwrap_or_default())] {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "app").unwrap_or(false) {
                let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                if name.is_empty() || !is_editor_app(&name) { continue; }
                out.push(EditorCandidate { name, exe: p.to_string_lossy().to_string() });
            }
        }
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn from_applications() -> Vec<EditorCandidate> { Vec::new() }

/// 枚举全部候选：去重、按名称排序。
pub fn enumerate() -> Vec<EditorCandidate> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<EditorCandidate> = Vec::new();

    // 用 exists() 而非 is_file()：macOS 的 .app 是目录，用 is_file 会把它们全漏掉；
    // Windows/Linux 侧传进来的都是具体可执行文件路径，不存在"恰好撞上同名目录"的隐患。
    let mut push = |name: String, exe: PathBuf| {
        let exe_s = exe.to_string_lossy().to_string();
        let key = exe_s.to_lowercase();
        if exe.exists() && seen.insert(key) {
            out.push(EditorCandidate { name, exe: exe_s });
        }
    };

    for (display, cmds) in KNOWN {
        for loc in fixed_locations(display) {
            push((*display).to_string(), loc);
        }
        if let Some(p) = find_in_path(cmds) {
            push((*display).to_string(), p);
        }
    }

    for c in from_registry() {
        if seen.insert(c.exe.to_lowercase()) { out.push(c); }
    }
    for c in from_applications() {
        if seen.insert(c.exe.to_lowercase()) { out.push(c); }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}
