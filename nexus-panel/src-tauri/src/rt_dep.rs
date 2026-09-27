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

/// 整包卸载的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub name: String,
    /// 实际删掉的份数。0 = 这个包本来就没装（不算失败）。
    pub removed: usize,
    pub files: Vec<String>,
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

/// 包名安全化：与前端 js/runtime-deps.js 的 safeNameOf 必须一致。
///
/// 单独抽出来，是因为"整包卸载"要按它算前缀 —— 前缀规则再写一份，
/// 就可能和落盘规则漂移（见 fpx_rt_dep_purge）。
fn safe_name_of(name: &str) -> String {
    name.chars()
        .map(|c| if c == '@' || c == '/' || c == '\\' { '_' } else { c })
        .collect()
}

/// 文件名安全化：与前端 js/runtime-deps.js 的 safeFileOf 必须一致。
///
/// 两边不一致的后果：前端按 A 名字去 import，后端按 B 名字落盘 ——
/// 安装报成功，加载永远找不到文件，且不报错。
fn safe_file_of(name: &str, version: &str) -> String {
    let n = safe_name_of(name);
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

/// 整包卸载：把一个包在 deps 目录里的**所有文件**一次删掉。
///
/// 【为什么需要它，而不只是逐条 remove】
/// 一个包可能装着多份（换过声明版本后旧文件仍在），逐条删要求每一份都
/// 在界面上有对应的一行。而"已装但清单里没有"的那些（装过之后又从
/// package.json 移除）压根不会出现在清单行里 —— 界面看不见，也就删不掉，
/// 只能在磁盘上越堆越多。整包卸载按包名走，与清单无关。
///
/// 【判归属必须用 `安全名 + "@"` 前缀，不能用 startsWith(name)】
/// 反例：包 `md` 的前缀 `md@` 不会误伤 `md-viewer@1.0.0.mjs`；
/// 而按 `startsWith("md")` 判就会把它一起删掉 —— **跨包删除**，
/// 且被删的那个在界面上根本没出现过，用户无从察觉。
///
/// 【删不掉要报，不能跳过继续】
/// 单个文件删除失败（被占用 / 权限）如果静默跳过，返回成功，
/// 用户刷新后看到"还有一份" —— 那时已经不知道是没删还是又装回来了。
#[tauri::command]
pub fn fpx_rt_dep_purge(app: tauri::AppHandle, name: String) -> Result<PurgeResult, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("包名为空".into());
    }
    let prefix = format!("{}@", safe_name_of(&name));
    let dir = deps_dir(&app)?;
    let rd = fs::read_dir(&dir).map_err(|e| format!("读取 deps 目录失败: {}", e))?;
    let mut files: Vec<String> = Vec::new();
    for entry in rd.flatten() {
        let f = entry.file_name().to_string_lossy().to_string();
        if !f.ends_with(".mjs") || !f.starts_with(&prefix) {
            continue;
        }
        fs::remove_file(dir.join(&f)).map_err(|e| format!("删除 {} 失败: {}", f, e))?;
        files.push(f);
    }
    Ok(PurgeResult {
        name,
        removed: files.len(),
        files,
    })
}

/// npm 包名合法性。拼进 URL 之前必须过这一道。
///
/// 不校验的后果不是"报错难看"，而是能拼出任意路径段（比如 `../`），
/// 请求被发到不该发的地方 —— 而由于目标是只读的 GET，表面上还看不出异常。
fn is_npm_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 214 {
        return false;
    }
    if name.contains("..") || name.contains("//") {
        return false;
    }
    let chars_ok = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@' | '/'));
    if !chars_ok {
        return false;
    }
    match name.matches('/').count() {
        // 普通包名
        0 => true,
        // scope 包：必须是 @scope/name 这种形式
        1 => name.starts_with('@') && name.len() > 2 && !name[1..].starts_with('/'),
        _ => false,
    }
}

/// 取回某包在 CDN 上的可用版本列表 —— 界面上那个版本下拉的数据来源。
///
/// 【为什么走后端而不是前端 fetch】
/// 页面的 connect-src 只放行 self / ipc，前端直接 fetch 外部域名会被拦，
/// 而报出来的是 CSP 违规而不是"网络不通"，很容易被误判成代码写错了。
/// 这里与下载走同一条路（Rust 直连），CSP 一个字都不用改。
///
/// 【失败必须明确报，不能返回空列表】
/// "这个包没有可用版本"和"这次没取到"是两种提示：后者要告诉用户可以手填。
/// 返回空列表会把两者混成一种，用户会以为是包的问题。
///
/// 【为什么过滤掉预发布版本】
/// `1.2.3-beta.1` 这类在 CDN 上未必有 `+esm` 构建，装进去可能是个空壳文件，
/// 而报错离这一步已经很远。宁可少给几个选项。
///
/// 【为什么不在后端排序】
/// 排序规则（自然序）前端 js/runtime-deps.js 的 cmpVersion 已经有一份，
/// 两边各写一份迟早漂移，而漂移的表现只是"列表顺序怪怪的"，没人会去查。
#[tauri::command]
pub async fn fpx_rt_dep_versions(name: String) -> Result<Vec<String>, String> {
    if !is_npm_name(&name) {
        return Err(format!("包名不合法: {}", name));
    }
    let url = format!("https://data.jsdelivr.com/v1/package/npm/{}", name);
    let text = fetch_text(&url).await?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("版本列表解析失败: {}", e))?;
    let arr = v
        .get("versions")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "版本列表里没有 versions 字段".to_string())?;
    let out: Vec<String> = arr
        .iter()
        .filter_map(|x| x.get("version").and_then(|s| s.as_str()))
        .map(|s| s.to_string())
        .filter(|s| !s.contains('-'))
        .collect();
    if out.is_empty() {
        return Err("没取到任何正式版本（可能是包名不对，或 CDN 上没有这个包）".into());
    }
    Ok(out)
}
