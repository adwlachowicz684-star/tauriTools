//! docx → PDF：让 docx 也能进查重链路。
//!
//! 【为什么要转 PDF】
//! 首页缩略图、页数、逐页像素比对全都建立在"能按页渲染"上，docx 自己渲染不了，
//! 必须先经 LibreOffice 转成 PDF，结果缓存在 `<data>/_docx_pdf/<idx>.pdf`。
//!
//! 【编号从哪来】
//! `idx` 是路径 MD5 前 8 位（见 `scan::idx_of`），插件只认这一套编号。
//! 旧版 python 按**序号**命名（797、798…），那批转好的 PDF 由
//! `super::migrate_docx_cache` 在首次运行时一次性挂到新编号名下 ——
//! 所以这里不做任何旧索引反查：缓存目录里要么是自己的编号，要么没有。
//!
//! 【soffice 从哪来】
//! 外部工具不随插件分发，按"越具体越优先"找：
//!   1. DUPVIEW_SOFFICE 环境变量（直接给 exe）
//!   2. DUPVIEW_BIN 环境变量 + soffice.exe
//!   3. PATH 上的 soffice
//! 都找不到就返回 None：该文件退化成"没有缩略图、页数 0"，不中断整轮扫描。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 定位 soffice.exe。结果只解析一次 —— 每个 docx 都去找一遍纯属浪费。
fn soffice() -> Option<&'static PathBuf> {
    static CELL: OnceLock<Option<PathBuf>> = OnceLock::new();
    CELL.get_or_init(|| {
        if let Ok(p) = std::env::var("DUPVIEW_SOFFICE") {
            let p = PathBuf::from(p);
            if p.is_file() {
                return Some(p);
            }
        }
        if let Ok(b) = std::env::var("DUPVIEW_BIN") {
            let p = PathBuf::from(b).join("soffice.exe");
            if p.is_file() {
                return Some(p);
            }
        }
        /* 交给 PATH 兜底：找不到时 spawn 会失败，按"转不出来"处理。 */
        Some(PathBuf::from("soffice.exe"))
    })
    .as_ref()
}

/// Windows 长路径前缀。旧版对传给 soffice 的路径同样做 `\\?\` 处理 ——
/// 试卷目录层级深、文件名长，不前缀化会在 260 字符处直接失败。
/// `pub(crate)`：打包 ZIP 时同样要按长路径打开文件（见 `pack.rs`）。
pub(crate) fn lp(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    if !p.is_absolute() || s.starts_with(r"\\?\") {
        return p.to_path_buf();
    }
    match s.strip_prefix(r"\\") {
        Some(rest) => PathBuf::from(format!(r"\\?\UNC\{rest}")),
        None => PathBuf::from(format!(r"\\?\{s}")),
    }
}

/// 新版缓存路径：`<data>/_docx_pdf/<idx>.pdf`。
pub fn cache_path(dir: &Path, idx: &str) -> PathBuf {
    dir.join("_docx_pdf").join(format!("{idx}.pdf"))
}

/// 拿到可渲染的 PDF：命中缓存即用，否则现场转换并落盘。
pub fn pdf_cache(dir: &Path, idx: &str, docx: &str) -> Option<PathBuf> {
    let dest = cache_path(dir, idx);
    if dest.is_file() {
        return Some(dest);
    }
    convert(dir, idx, docx)
}

/// 现场转换：soffice 无头模式输出到临时目录，再把 PDF 收进缓存目录。
///
/// 不设超时（std 的 Command 没有这项能力）：一份卷子正常几秒内出结果，
/// 卡死的情形极少，而为此引一套异步运行时得不偿失。转换失败只影响这一个文件。
fn convert(dir: &Path, idx: &str, docx: &str) -> Option<PathBuf> {
    let so = soffice()?;
    let dest = cache_path(dir, idx);
    let td = std::env::temp_dir().join(format!("dup_lo_{idx}"));
    let _ = std::fs::remove_dir_all(&td);
    std::fs::create_dir_all(&td).ok()?;

    let out = std::process::Command::new(so)
        .args(["--headless", "--convert-to", "pdf", "--outdir"])
        .arg(&td)
        .arg(lp(Path::new(docx)))
        .output();

    let mut made: Option<PathBuf> = None;
    if matches!(&out, Ok(o) if o.status.success()) {
        if let Ok(rd) = std::fs::read_dir(&td) {
            made = rd
                .flatten()
                .map(|e| e.path())
                .find(|p| {
                    p.extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x.eq_ignore_ascii_case("pdf"))
                        .unwrap_or(false)
                });
        }
    }

    let r = made.and_then(|src| {
        std::fs::create_dir_all(dest.parent()?).ok()?;
        std::fs::copy(&src, &dest).ok()?;
        Some(dest.clone())
    });
    let _ = std::fs::remove_dir_all(&td);
    r
}
