//! 打包：把一个目录（含子目录）压成一个 ZIP，落在它的**父目录**下。
//!
//! 【为什么内置实现，而不是调 7z / WinRAR】
//! 那类工具在别人电脑上不一定装了；这个插件是要"下载下来就能用"的。
//! 用纯 Rust 的 `zip` crate 编译进 exe，不依赖任何外部程序 ——
//! 代价只是体积（zip + flate2），换来的是"拷到哪台机器都能打包"。
//!
//! 【压缩方式为什么是混合的】
//! 试卷目录里绝大多数是扫描件 PDF（内容已是 JPEG），再走 Deflate 几乎不缩小，
//! 白白耗 CPU；而 docx / txt / 说明类小文件压得动。所以按扩展名分流：
//! 已压过的走 Stored（原样存），其余走 Deflated。见 `STORE_EXT`。
//!
//! 【为什么每个路径都过 lp()】
//! 试卷目录层级深、文件名长，裸路径会在 260 字符处直接失败；
//! `docx::lp` 统一加 `\\?\` 前缀（`pub(crate)` 出来正是为了这里复用）。

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::docx::lp;

/// 已经压过的扩展名 —— 命中即 Stored，不浪费 CPU 再 Deflate 一遍。
///
/// 名单按"内容本身就是压缩数据"来定：
///   压缩包（zip/7z/…）、位图（jpg/png/…）、音视频、Office（docx/xlsx/pptx
///   本身就是 zip 容器），以及**扫描件 PDF** —— 试卷主体是整页 JPEG，
///   Deflate 收益接近 0，Stored 反而更快。
const STORE_EXT: [&str; 30] = [
    "zip", "7z", "rar", "gz", "bz2", "xz", "zst", "tgz", "jar", "apk",
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "avif", "tif", "tiff",
    "mp3", "m4a", "aac", "flac", "mp4", "mov",
    "docx", "xlsx", "pptx",
    "pdf",
];

/// 打包结果：目标 ZIP、收录文件数、原始字节数。
#[derive(Clone, Debug, serde::Serialize)]
pub struct PackStats {
    pub target: String,
    pub files: u64,
    pub bytes: u64,
}

fn is_stored(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((_, ext)) => STORE_EXT.iter().any(|e| e.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// 把 `source` 目录打成 ZIP 写到 `target`。
///
/// ZIP 内部**保留顶层目录名**（`source` 的末级名）—— 解压出来是一个完整文件夹，
/// 而不是散落一地的文件。`target` 由调用方决定（通常 `<父目录>/<目录名>.zip`），
/// 存在与否的处置也在调用方（这里一律覆盖写）。
pub fn pack_into(source: &Path, target: &Path) -> Result<PackStats, String> {
    let top = source
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "无法确定目录名".to_string())?;

    let file = File::create(lp(target)).map_err(|e| format!("创建 ZIP 失败：{e}"))?;
    let mut zip = ZipWriter::new(file);

    /* 目录项一律 Stored：目录没有内容，写它的意义只是让解压工具能建出空目录。 */
    let dir_opt = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.add_directory(top.as_str(), dir_opt)
        .map_err(|e| format!("写入目录项失败：{e}"))?;

    let mut files = 0u64;
    let mut bytes = 0u64;
    /* 显式栈而非递归：目录层级可能很深，递归没有上限保护。 */
    let mut stack: Vec<(PathBuf, String)> = vec![(source.to_path_buf(), top.clone())];
    while let Some((dir, rel)) = stack.pop() {
        let rd = std::fs::read_dir(lp(&dir))
            .map_err(|e| format!("读取目录失败 {}：{e}", dir.display()))?;
        for e in rd.flatten() {
            let p = e.path();
            let nm = e.file_name().to_string_lossy().to_string();
            /* ZIP 条目名固定用 `/` 分隔（Windows 的 `\` 不是合法条目分隔符）。 */
            let zname = format!("{}/{}", rel, nm);
            if p.is_dir() {
                zip.add_directory(zname.as_str(), dir_opt)
                    .map_err(|e| format!("写入目录项失败：{e}"))?;
                stack.push((p, zname));
                continue;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            let method = if is_stored(&nm) {
                CompressionMethod::Stored
            } else {
                CompressionMethod::Deflated
            };
            let mut opt = SimpleFileOptions::default().compression_method(method);
            /* 超过 4GB 的单个文件必须开 zip64，否则条目里存不下长度。 */
            if size > 0xFFFF_FFFF {
                opt = opt.large_file(true);
            }
            zip.start_file(zname.as_str(), opt)
                .map_err(|e| format!("写入文件项失败：{e}"))?;
            let mut f = File::open(lp(&p))
                .map_err(|e| format!("打开失败 {}：{e}", p.display()))?;
            io::copy(&mut f, &mut zip)
                .map_err(|e| format!("写入失败 {}：{e}", p.display()))?;
            files += 1;
            bytes += size;
        }
    }
    zip.finish().map_err(|e| format!("收尾失败：{e}"))?;

    Ok(PackStats {
        target: target.to_string_lossy().to_string(),
        files,
        bytes,
    })
}