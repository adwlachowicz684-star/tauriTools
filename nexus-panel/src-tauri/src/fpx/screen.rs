//! 屏幕截图：给卡片配图 / 记录现场用。
//! ------------------------------------------------------------------
//! 全部走系统自带能力，不引任何图像/FFI 依赖：
//!   Windows → PowerShell + System.Drawing（与 sys.rs 的取色同因：避开 windows-sys 句柄类型歧义）
//!   macOS   → screencapture
//!   Linux   → ImageMagick 的 import / gnome-screenshot / spectacle / grim
//! 一个都拿不到就明确报错，不假装成功。

use std::path::{Path, PathBuf};

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
