//! PDF 渲染：pdfium 封装。
//!
//! 【为什么是 pdfium 而不是 mupdf】
//! 同类的两个候选都试过：
//!   · mupdf（Rust binding）—— 绑定靠 bindgen 生成，**需要 libclang**。
//!     本机没有，`mupdf-sys` 的 build.rs 直接 panic
//!     （Unable to find libclang），装一套 LLVM 只为它不值。
//!   · pdfium-render 0.9 —— 绑定是手写的 FFI，**不依赖 libclang**，
//!     实测 `cargo check` 8 秒过。代价是要一份 pdfium.dll 随包分发，
//!     而本项目当前是纯 Windows 桌面端，只维护一个平台的二进制即可。
//!
//! 【dll 在哪】
//! 按"越具体越优先"找，与插件脚本的定位思路一致：
//!   1. DUPVIEW_PDFIUM 环境变量（排查/覆盖用）
//!   2. 资源目录（生产构建，bundle.resources 打进安装包）
//!   3. 插件目录（开发态，用编译期 CARGO_MANIFEST_DIR 定位，不依赖 cwd）
//!   4. 系统库路径（Pdfium::default 的行为）
//! 找不到时**如实报错并把试过的路径列出来** —— 这类问题在 UI 上
//! 表现为"扫描没反应"，没有路径列表就只能猜。

use image::{DynamicImage, GrayImage, ImageBuffer};
use pdfium_render::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// pdfium 实例。整个进程只初始化一次（FPDF_InitLibrary 是全局的，
/// 重复初始化会报 PdfiumLibraryBindingsAlreadyInitialized）。
///
/// `Option` 而非直接存值：dll 缺失时第一次调用要能把错误交出去，
/// 之后每次调用都返回同一句错误，而不是反复尝试加载。
fn engine() -> Result<&'static Pdfium, String> {
    static CELL: OnceLock<Result<Pdfium, String>> = OnceLock::new();
    CELL.get_or_init(|| {
        let dll = find_library();
        match dll {
            Some(p) => Pdfium::bind_to_library(&p)
                .map(Pdfium::new)
                .map_err(|e| format!("加载 {} 失败：{e}", p.display())),
            /* 走到这里表示没找到随包的 dll —— 退到系统库路径。
               这一支在装了 pdfium 的开发机上能直接跑通，不视为错误。 */
            None => Ok(Pdfium::default()),
        }
    })
    .as_ref()
    .map_err(|e| e.clone())
}

/// 定位 pdfium.dll。返回 None 表示"交给系统库路径兜底"。
fn find_library() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("DUPVIEW_PDFIUM") {
        if !p.trim().is_empty() {
            cands.push(PathBuf::from(p));
        }
    }
    /* 与 exe 同目录：生产构建把 dll 打在资源里，调试态也可以直接丢一份
       到 target/debug/ 旁边。放在这里而不是"资源目录"，是因为解析资源
       目录需要 AppHandle，而渲染是在扫描线程里做的，那边拿不到。 */
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            cands.push(dir.join("pdfium.dll"));
        }
    }
    cands.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/dupview/pdfium.dll"),
    );
    cands.into_iter().find(|p| p.is_file())
}

/// 一页的灰度像素，带尺寸。所有比对都在灰度上做：
/// 试卷是黑白扫描件，颜色对"是否同一份卷子"没有区分度，
/// 转灰度能让后续采样与阈值少一个通道的干扰。
pub struct Gray {
    pub w: u32,
    pub h: u32,
    pub buf: Vec<u8>,
}

/// 打开 PDF 读页数。损坏件（xref 错误）pdfium 多数能容错打开，
/// 打不开就返回 Err —— 扫描主流程会把它们单独记下来，不中断整轮扫描。
pub fn page_count(path: &Path) -> Result<usize, String> {
    let pdfium = engine()?;
    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("{e}"))?;
    Ok(doc.pages().len() as usize)
}

/// 渲染指定页为灰度图，目标宽度 `width`（高度按原比例）。
///
/// 为什么统一按宽度缩放而不是固定 DPI：同一份卷子的两个副本可能被
/// 不同工具导出，页面点阵尺寸（PdfPoints）相同但 DPI 不同；按宽度归一
/// 后两边像素网格一致，逐像素比对才有意义。
pub fn render_page(path: &Path, index: usize, width: u32) -> Result<Gray, String> {
    let pdfium = engine()?;
    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("{e}"))?;
    let page = doc
        .pages()
        .get(index as i32)
        .map_err(|e| format!("第 {} 页打不开：{e}", index + 1))?;
    let pw = page.width().value as f32;
    let ph = page.height().value as f32;
    if pw <= 0.0 || ph <= 0.0 {
        return Err("页面尺寸为 0".into());
    }
    let height = ((width as f32) * ph / pw).round().max(1.0) as u32;
    let bitmap = page
        .render(width as i32, height as i32, None)
        .map_err(|e| format!("渲染第 {} 页失败：{e}", index + 1))?;
    let img: DynamicImage = bitmap
        .as_image()
        .map_err(|e| format!("取第 {} 页像素失败：{e}", index + 1))?;
    Ok(Gray {
        w: img.width(),
        h: img.height(),
        buf: img.to_luma8().into_raw(),
    })
}

/// 首页缩略图：宽 320 的灰度图，用于感知哈希与前端列表卡片。
pub fn first_page_gray(path: &Path) -> Result<Gray, String> {
    render_page(path, 0, 320)
}

/// 把灰度图存成 PNG。落盘而不是只在内存里流转：
/// 前端列表要展示几百张缩略图，每次现渲染会卡死，
/// 而磁盘上的 PNG 可以被 webview 直接缓存（走 asset 协议）。
pub fn save_png(gray: &Gray, out: &Path) -> Result<(), String> {
    let img: GrayImage = ImageBuffer::from_raw(gray.w, gray.h, gray.buf.clone())
        .ok_or_else(|| "像素缓冲与尺寸不匹配".to_string())?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }
    img.save(out).map_err(|e| format!("写 PNG 失败：{e}"))
}

/// 生成逐页预览 PNG（前端点开某个文件时看的那组图），返回落盘路径列表。
///
/// 已经存在就跳过 —— 一份卷子 12 页、429 份就是 5000 次渲染，
/// 重复渲染是这里最主要的性能浪费。
pub fn page_images(path: &Path, index: usize, out_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let n = page_count(path)?;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let fp = out_dir.join(format!("p{}.png", i));
        if !fp.exists() {
            let g = render_page(path, i, 1000)?;
            save_png(&g, &fp)?;
        }
        out.push(fp);
    }
    Ok(out)
}
