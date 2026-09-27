//! 运行时依赖（runtime deps）
//! ============================================================
//!
//! 把 npm 包**装进工具内部**（应用数据目录下的 `deps/`），供插件在运行时
//! 动态 import —— 补齐"打包产物里没有 node_modules"这条断链。
//!
//! 【为什么只存 ESM 单文件，不解 tarball】
//! tarball 要在客户端做 .tar.gz 解压 + 依赖树解析，既没有对应的 crate，
//! 也拿不到 npm 的解析规则；更关键的是解出来的多数是 CJS，浏览器 import
//! 不了。CDN 的 `+esm` 端点直接给出浏览器可用的 ESM 单文件，跳过了这两步。
//! 代价：只适合"纯前端、不依赖 node 内建模块"的包。
//!
//! 【为什么用 reqwest 顶层函数，不用 app.http()】
//! `app.http()` 要引 `HttpExt` trait，且受 capabilities 里 http 权限的
//! scope 约束（那份 scope 是给前端 invoke 用的）。而本文件是 Rust 直连，
//! 走 `tauri_plugin_http::reqwest` 的 re-export —— 少一个 trait、少一处
//! 权限配置，也就不存在"权限没配导致下载失败但不报错"的空。
//!
//! 【目录即清单，不另存索引】
//! 已装列表直接由 `deps/` 目录内容得出。另存一份 index.json 会引入
//! "索引说装了、文件其实没了"的不一致 —— 那种情况下界面显示已安装，
//! 插件 import 才失败，报错离真正的操作已经很远。
//!
//! ⚠️ 本文件未经过 cargo 编译验证（构建环境无 cargo）。接线见 main.rs。

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

/// 已安装的一条运行时依赖。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RtDep {
    pub name: String,
    pub version: String,
    /// 文件名（含扩展名）
    pub file: String,
    /// 磁盘完整路径 —— 前端拿它走 asset 协议转成可 import 的 URL
    pub path: String,
    /// 字节数。给界面显示用，也用来一眼看出"下载到的是不是空文件"。
    pub size: u64,
}

/// deps 目录。不存在就建 —— 首次安装时它必然不存在，
/// 不建的话后面的写入会失败，而错误信息指向写文件而不是目录缺失。
fn deps_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取不到应用数据目录: {}", e))?;
    let dir = base.join("deps");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("创建 deps 目录失败: {}", e))?;
    }
    Ok(dir)
}

/// 文件名安全化：与前端 js/runtime-deps.js 的 safeFileOf 必须一致。
///
/// 两边不一致的后果：前端按 A 名字去 import，后端按 B 名字落盘 ——
/// 安装报成功，加载永远找不到文件，且不报错。
fn safe_file_of(name: &str, version: &str) -> String {
    let n: String = name
        .chars()
        .map(|c| if c == '@' || c == '/' || c == '\\' { '_' } else { c })
        .collect();
    let v: String = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    if v.is_empty() {
        format!("{}@latest.mjs", n)
    } else {
        format!("{}@{}.mjs", n, v)
    }
}

/// 从文件名还原 name / version。解析不出就跳过该文件 ——
/// deps 目录里可能有用户自己放的东西，不能因为一条解析失败就让整个列表报错。
fn parse_file(file: &str) -> Option<(String, String)> {
    let stem = file.strip_suffix(".mjs")?;
    let at = stem.rfind('@')?;
    if at == 0 {
        return None;
    }
    Some((stem[..at].to_string(), stem[at + 1..].to_string()))
}

fn to_dep(dir: &PathBuf, file: &str) -> Option<RtDep> {
    let (name, version) = parse_file(file)?;
    let p = dir.join(file);
    let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    Some(RtDep {
        name,
        version,
        file: file.to_string(),
        path: p.to_string_lossy().to_string(),
        size,
    })
}

/// 取回远端文本。
///
/// 三处必须分开报，否则排错方向会错：
///   · 连不上（网络 / 域名）
///   · HTTP 非 2xx（CDN 上没这个包或没这个版本）
///   · 内容是空（CDN 不支持该包的 ESM 构建，会给一个空壳）
async fn fetch_text(url: &str) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err(format!("拒绝下载非 https 地址: {}", url));
    }
    let resp = tauri_plugin_http::reqwest::get(url)
        .await
        .map_err(|e| format!("下载失败（检查网络）: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败 HTTP {} —— CDN 上可能没有这个版本", resp.status()));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取下载内容失败: {}", e))?;
    if text.trim().is_empty() {
        return Err("下载到的内容是空的 —— CDN 可能不支持这个包的 ESM 构建".into());
    }
    Ok(text)
}

/// 列出已安装的运行时依赖。
#[tauri::command]
pub fn fpx_rt_dep_list(app: tauri::AppHandle) -> Result<Vec<RtDep>, String> {
    let dir = deps_dir(&app)?;
    let mut out = Vec::new();
    let rd = fs::read_dir(&dir).map_err(|e| format!("读取 deps 目录失败: {}", e))?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".mjs") {
            continue;
        }
        if let Some(d) = to_dep(&dir, &name) {
            out.push(d);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.version.cmp(&b.version)));
    Ok(out)
}

/// 下载并安装一条。
///
/// `url` / `file` 由前端给（CDN 基址与文件命名规则归前端管，避免两边漂移）。
/// 但**落盘前必须再校验一次 file** —— 前端传来的路径可能含 `..`，
/// 不校验就成了"往任意位置写文件"。
#[tauri::command]
pub async fn fpx_rt_dep_install(
    app: tauri::AppHandle,
    name: String,
    version: String,
    url: String,
    file: String,
) -> Result<RtDep, String> {
    if name.is_empty() {
        return Err("包名为空".into());
    }
    let file = if file.is_empty() {
        safe_file_of(&name, &version)
    } else {
        file
    };
    if file.contains("..") || file.contains('/') || file.contains('\\') {
        return Err(format!("文件名不合法: {}", file));
    }
    if !file.ends_with(".mjs") {
        return Err(format!("只允许 .mjs: {}", file));
    }

    let dir = deps_dir(&app)?;
    let text = fetch_text(&url).await?;
    let target = dir.join(&file);
    fs::write(&target, text.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;

    to_dep(&dir, &file).ok_or_else(|| "写完了却读不回来（文件名解析失败）".to_string())
}

/// 移除一条。文件不存在也算成功 —— 目标是"这条不再存在"，
/// 纠结它此前在不在没有意义，还会让界面上出现无法恢复的错误态。
#[tauri::command]
pub fn fpx_rt_dep_remove(app: tauri::AppHandle, file: String) -> Result<bool, String> {
    if file.is_empty() {
        return Err("文件名为空".into());
    }
    if file.contains("..") || file.contains('/') || file.contains('\\') {
        return Err(format!("文件名不合法: {}", file));
    }
    let dir = deps_dir(&app)?;
    let target = dir.join(&file);
    if !target.exists() {
        return Ok(true);
    }
    fs::remove_file(&target).map_err(|e| format!("删除失败: {}", e))?;
    Ok(true)
}
