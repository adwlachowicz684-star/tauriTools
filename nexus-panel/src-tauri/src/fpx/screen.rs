//! 屏幕截图：给卡片配图 / 记录现场用。
//! ------------------------------------------------------------------
//! 全部走系统自带能力，不引任何图像/FFI 依赖：
//!   Windows → PowerShell + System.Drawing（与 sys.rs 的取色同因：避开 windows-sys 句柄类型歧义）
//!   macOS   → screencapture
//!   Linux   → ImageMagick 的 import / gnome-screenshot / spectacle / grim
//! 一个都拿不到就明确报错，不假装成功。

use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::fpx::safety::safe_ps_literal;

/// 截图结果：落盘路径 + 尺寸（尺寸由后端能确定时才有值，拿不到即为 0）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// 生成截图文件名（按时间命名，避免互相覆盖）。
fn target_path(dir: &Path) -> PathBuf {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    dir.join(format!("shot_{secs}.png"))
}

#[cfg(windows)]
pub fn capture(dir: &Path) -> Result<CaptureResult, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = target_path(dir);
    let path_str = path.to_string_lossy().replace('\'', "''"); // PowerShell 单引号内转义
    // 截图目录可由 MCP 传入。除了单引号双写，还要挡住换行与反引号：
    // 它们能跳出单引号字符串所在的那一行，在脚本里另起一条语句。
    if !safe_ps_literal(&path_str) {
        return Err(format!("截图路径含不安全字符，已拒绝: {}", path.display()));
    }

    let script = [
        "$ErrorActionPreference='Stop'",
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "$bmp=[System.Drawing.Bitmap]::new($b.Width,$b.Height)",
        "$g=[System.Drawing.Graphics]::FromImage($bmp)",
        "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)",
        &format!("$bmp.Save('{path_str}',[System.Drawing.Imaging.ImageFormat]::Png)"),
        "$g.Dispose(); $bmp.Dispose()",
        "$b.Width; $b.Height",
    ].join("; ");

    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("无法启动 PowerShell: {e}"))?;

    if !out.status.success() || !path.is_file() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() { "截图失败".into() } else { format!("截图失败: {msg}") });
    }

    // 末两行是宽高（拿不到就填 0，不影响使用）
    let text = String::from_utf8_lossy(&out.stdout);
    let nums: Vec<u32> = text.lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .collect();
    let (w, h) = match nums.as_slice() {
        [a, b, ..] => (*a, *b),
        [a] => (*a, 0),
        _ => (0, 0),
    };
    Ok(CaptureResult { path: path.to_string_lossy().to_string(), width: w, height: h })
}

#[cfg(not(windows))]
pub fn capture(dir: &Path) -> Result<CaptureResult, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = target_path(dir);
    let path_s = path.to_string_lossy().to_string();

    // (命令, 固定参数, 路径参数的位置)
    //   tail: 路径直接放最后    -f: gnome-screenshot 用 -f <path>
    let candidates: &[(&str, &[&str], &str)] = if cfg!(target_os = "macos") {
        &[("screencapture", &["-x"], "tail")]
    } else {
        &[
            ("import", &["-window", "root"], "tail"),
            ("gnome-screenshot", &["-f"], "f"),
            ("spectacle", &["-b", "-n", "-o"], "tail"),
            ("grim", &[], "tail"),
        ]
    };

    for (prog, args, style) in candidates {
        let mut cmd = std::process::Command::new(prog);
        cmd.args(*args);
        if *style == "f" {
            cmd.arg("-f").arg(&path_s);
        } else {
            cmd.arg(&path_s);
        }
        if let Ok(o) = cmd.output() {
            if o.status.success() && path.is_file() {
                return Ok(CaptureResult { path: path_s, width: 0, height: 0 });
            }
        }
    }
    Err("未找到可用的截图命令（macOS 需 screencapture；Linux 需 ImageMagick 的 import、gnome-screenshot、spectacle 或 grim）".into())
}

/* ---------------------------- 窗口级截图 / 窗口列举 ---------------------------- */
// 对应原版 ScreenCaptureService 的 CaptureWindow / FindWindowTitles。
// 同样走 PowerShell，理由与上面一致：不引 windows-sys。

/// 一个可见窗口的标题（供 AI 选择截图目标）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub title: String,
    /// 窗口句柄（Windows 下为 HWND 数值），非 Windows 为 0
    pub handle: i64,
}

/// 列举标题含关键字的可见窗口。关键字为空 = 全部可见窗口。
///
/// PowerShell 脚本用 Rust 原始字符串 + PowerShell 单引号 here-string（@'…'@）包裹，
/// 这样脚本里的双引号、反斜杠都不需要转义，改脚本时不容易写出语法错误。
#[cfg(windows)]
pub fn list_windows(keyword: &str) -> Result<Vec<WindowInfo>, String> {
    let kw = keyword.trim().replace('\'', "''");
    let filter = if kw.is_empty() {
        "$_.MainWindowTitle -ne ''".to_string()
    } else {
        format!("$_.MainWindowTitle -ne '' -and $_.MainWindowTitle -like '*{kw}*'")
    };

    // 输出 句柄<TAB>标题，用制表符分隔，避免标题里含空格带来的歧义
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         Get-Process | Where-Object {{ $_.MainWindowHandle -ne 0 -and ({filter}) }} | \
         ForEach-Object {{ \"$($_.MainWindowHandle)`t$($_.MainWindowTitle)\" }}"
    );

    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("无法启动 PowerShell: {e}"))?;

    let text = String::from_utf8_lossy(&out.stdout);
    let mut list = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let (h, t) = match line.split_once('\t') {
            Some((a, b)) => (a.trim(), b.trim()),
            None => ("0", line),
        };
        if t.is_empty() { continue; }
        list.push(WindowInfo { title: t.to_string(), handle: h.parse::<i64>().unwrap_or(0) });
    }
    // 标题去重：同一进程可能有多个顶层窗口，重复标题只留第一条
    let mut seen = std::collections::HashSet::new();
    list.retain(|w| seen.insert(w.title.clone()));
    Ok(list)
}

/// 按标题关键字截取单个窗口。匹配不到就明确报错，不退回全屏（那会截错对象）。
#[cfg(windows)]
pub fn capture_window(dir: &Path, keyword: &str) -> Result<CaptureResult, String> {
    let kw = keyword.trim();
    if kw.is_empty() { return Err("缺少参数 title".into()); }

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = target_path(dir);
    let path_str = path.to_string_lossy().replace('\'', "''");
    let kw_esc = kw.replace('\'', "''");
    // 同上：路径与标题关键字都要挡住换行 / 反引号 / $( )
    if !safe_ps_literal(&path_str) {
        return Err(format!("截图路径含不安全字符，已拒绝: {}", path.display()));
    }
    if !safe_ps_literal(&kw_esc) {
        return Err("窗口标题含不安全字符，已拒绝".into());
    }

    // C# 代码走 PowerShell 的单引号 here-string：内部双引号原样保留，不用转义。
    // 先 GetWindowRect 取窗口矩形，再 CopyFromScreen 只截这一块。
    let script = format!(
        r#"$ErrorActionPreference='Stop';
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$code = @'
using System;
using System.Runtime.InteropServices;
public class WinRect {{
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT {{ public int L, T, R, B; }}
}}
'@;
Add-Type -TypeDefinition $code;
$p = Get-Process | Where-Object {{ $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*{kw_esc}*' }} | Select-Object -First 1;
if (-not $p) {{ throw 'no-window' }};
$h = $p.MainWindowHandle;
$r = New-Object WinRect+RECT;
[WinRect]::GetWindowRect($h, [ref]$r) | Out-Null;
$w = $r.R - $r.L; $ht = $r.B - $r.T;
if ($w -le 0 -or $ht -le 0) {{ throw 'empty-rect' }};
$bmp = [System.Drawing.Bitmap]::new($w, $ht);
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size);
$bmp.Save('{path_str}', [System.Drawing.Imaging.ImageFormat]::Png);
$g.Dispose(); $bmp.Dispose();
Write-Output $w;
Write-Output $ht;"#
    );

    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("无法启动 PowerShell: {e}"))?;

    if !out.status.success() || !path.is_file() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("no-window") {
            return Err(format!("没有找到标题包含「{kw}」的窗口，可先用 list_windows 查看"));
        }
        if stderr.contains("empty-rect") {
            return Err("目标窗口已最小化或尺寸为 0，请先还原窗口".into());
        }
        let msg = stderr.trim().to_string();
        return Err(if msg.is_empty() { "窗口截图失败".into() } else { format!("窗口截图失败: {msg}") });
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let nums: Vec<u32> = text.lines().filter_map(|l| l.trim().parse::<u32>().ok()).collect();
    let (w, h) = match nums.as_slice() { [a, b, ..] => (*a, *b), _ => (0, 0) };
    Ok(CaptureResult { path: path.to_string_lossy().to_string(), width: w, height: h })
}

/// 非 Windows：没有统一的窗口枚举/截图接口，明确报不支持而不是静默退化为全屏。
#[cfg(not(windows))]
pub fn list_windows(_keyword: &str) -> Result<Vec<WindowInfo>, String> {
    Err("窗口列举仅支持 Windows（其它平台请用 capture_screen 截全屏）".into())
}

#[cfg(not(windows))]
pub fn capture_window(_dir: &Path, _keyword: &str) -> Result<CaptureResult, String> {
    Err("窗口截图仅支持 Windows（其它平台请用 capture_screen 截全屏）".into())
}
