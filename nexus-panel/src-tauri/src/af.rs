//! agent_flow 插件在 Rust 侧的能力。
//!
//! 目前只有一项：读取本地图片转 base64，供 OCR 节点发给视觉大模型。
//! 刻意只用标准库 —— 不引 base64 / image 等 crate，少一个依赖就少一类编译失败。

use std::path::Path;

/// 单张图片的大小上限。
///
/// base64 会再膨胀约 1/3，20MB 的图片编码后接近 27MB，
/// 已经足以让多数 API 网关直接拒绝请求，再大没有意义。
const MAX_BYTES: usize = 20 * 1024 * 1024;

/// 读取本地图片，返回可直接放进 `image_url.url` 的 data URL。
///
/// 前端（iframe）没有磁盘权限，必须经 Rust 读。
#[tauri::command]
pub fn af_read_image_data_url(path: String) -> Result<String, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("图片路径为空".into());
    }
    let f = Path::new(p);
    if !f.is_file() {
        return Err(format!("文件不存在或不是普通文件: {p}"));
    }

    let bytes = std::fs::read(f).map_err(|e| format!("读取失败: {e}"))?;
    if bytes.is_empty() {
        return Err("文件为空".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "图片过大（约 {} MB），上限 20 MB。可先压缩再识别",
            bytes.len() / 1024 / 1024
        ));
    }

    // 按文件头判断类型，而不是看扩展名：
    // 截图工具常存成没有扩展名的临时文件，只看扩展名会误判。
    let mime = detect_mime(&bytes)
        .ok_or("不是支持的图片格式（支持 png / jpeg / gif / webp / bmp）")?;

    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// 用魔数判断图片类型
fn detect_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if b.starts_with(b"BM") {
        return Some("image/bmp");
    }
    // RIFF....WEBP
    if b.len() >= 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 标准 base64 编码（含末尾 = 填充）
fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);

    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);

        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
