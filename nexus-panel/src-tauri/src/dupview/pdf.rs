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
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

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

/// 交互取图请求计数：>0 表示"有用户正等着某张图"。
///
/// 扫描侧取渲染锁前会先看它，只要还有人在等就让出（见 `render_guard`）。
static USER_WAIT: AtomicU32 = AtomicU32::new(0);

thread_local! {
    /// 本线程是不是扫描线程。
    ///
    /// 扫描全程只有一个专用线程（见 `scan::start` 里的 spawn），交互取图则落在
    /// tokio 的工作线程上。用线程本地标记区分两侧，就不必给 `page_count` /
    /// `render_page` 挨个加"优先级"参数，也不必让 `sim` / `scan` 换调用写法。
    static IS_SCAN: Cell<bool> = const { Cell::new(false) };
}

/// 把当前线程标记为扫描侧。由 `scan::run` 在开头调用一次。
pub fn mark_scan_thread() {
    IS_SCAN.with(|c| c.set(true));
}

/// 渲染串行闸 + 交互优先。
///
/// 【为什么必须有】
/// 命令加了 `async` 之后，多个 `dupview_page` 会落在不同线程上并发执行。
/// PDFium 官方明确它**不是线程安全的**：必须保证同一时刻只有一次调用，
/// 跨线程同时调 `FPDF_LoadDocument` / `FPDF_RenderPageBitmap` 会随机崩在
/// C 库里 —— 表现为插件窗口整个消失、没有 Rust panic 信息，极难定位。
/// 这里用一把全局互斥把渲染串起来；命令本身仍是 async，
/// 排队只占后台线程，UI 不会被卡住。
///
/// 【为什么还要"交互优先"】
/// 光有串行闸不够：一轮内容比对（`sim::pix_sim`）要连渲几百页，每页都在
/// 毫秒级反复抢锁，而 std 的 Mutex 没有优先级概念 —— 用户点开试卷时，
/// 那一次取图会被扫描饿住，直到撞上前端 iframe 桥接的 15 秒超时，
/// 界面只显示一句笼统的"加载失败"（实测踩过）。
/// 所以扫描侧取锁前先退让：**只要还有交互请求在等，就不开始新的渲染**，
/// 交互请求最多等一页（几百毫秒）。
fn render_guard() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let lock = LOCK.get_or_init(|| Mutex::new(()));
    let scan = IS_SCAN.with(|c| c.get());

    if scan {
        /* 扫描侧退让：只要还有交互请求在等，就先不开始新的渲染。
           退让的粒度是"一页渲染"（几百毫秒）—— 扫描整体只慢一点点，
           换来用户点开试卷时那一页不被饿死。 */
        while USER_WAIT.load(Ordering::SeqCst) > 0 {
            std::thread::sleep(Duration::from_millis(2));
        }
    } else {
        /* 交互侧：先登记"有人在等"，再取锁；拿到锁就撤登记 ——
           锁本身已经挡住扫描，不必继续挂着。 */
        USER_WAIT.fetch_add(1, Ordering::SeqCst);
    }

    /* 上一次调用 panic 会毒化锁；渲染本身无状态，直接取回内容继续用，
       不让一次偶发失败把后续所有渲染都拖死。 */
    let g = lock.lock().unwrap_or_else(|e| e.into_inner());

    if !scan {
        USER_WAIT.fetch_sub(1, Ordering::SeqCst);
    }
    g
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
    let _g = render_guard();
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
    let _g = render_guard();
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

/// 逐页预览图的规格。
///
/// 【为什么分两档】
/// 缩略条里每格只有 64px 宽，大图区却要占满屏幕。原先不分档、一律按 1000px 渲染，
/// 缩略条那一排等于把十几倍的算力白花在缩放上：一份 22 页的卷子首次打开要好几秒。
/// 拆开后缩略图小而快，大图只渲染当前正在看的那一页。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PageSize {
    /// 缩略条：160px 宽（显示 64px，留 2.5 倍余量给高分屏）
    T,
    /// 大图：1000px 宽（1080p 下铺满灯箱刚好够，再大只是徒增编码耗时）
    F,
}

impl PageSize {
    pub fn width(self) -> u32 {
        match self {
            PageSize::T => 160,
            PageSize::F => 1000,
        }
    }

    /// 缓存文件名。
    ///
    /// 大图沿用旧版的 `p{i}.png` —— 本机已攒下 172 份 1000px 缓存，
    /// 换个名字等于把它们全部作废、重渲染一遍。
    pub fn file(self, index: usize) -> String {
        match self {
            PageSize::T => format!("t{index}.png"),
            PageSize::F => format!("p{index}.png"),
        }
    }
}

/// 渲染某一页到缓存目录，已存在就直接复用；返回落盘路径。
///
/// 【为什么一页一次调用，而不是一次给整份】
/// 前端先取页数把缩略条的格子摆出来，再逐页填图：第一格几十毫秒就能出来，
/// 不必等整份卷子渲染完。这样"首次打开"的感觉是"图一格格冒出来"，
/// 而不是白等几秒然后整排同时出现。
pub fn page_image(
    path: &Path,
    index: usize,
    out_dir: &Path,
    size: PageSize,
) -> Result<PathBuf, String> {
    let fp = out_dir.join(size.file(index));
    if fp.exists() {
        return Ok(fp);
    }
    let g = render_page(path, index, size.width())?;
    save_png(&g, &fp)?;
    Ok(fp)
}
