// 防止 Windows 上 release 构建弹出额外控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::WebviewWindow;
// get_webview_window / package_info 等方法定义在 Manager 这个 trait 上，
// 不导入它编译器就"看不见"这些方法（E0599），即使类型本身是对的。
use tauri::Manager;

mod af_flow;
mod fpx;

/// 连通性测试：前端 ctx.invoke('rust_ping', { payload })
#[tauri::command]
fn rust_ping(payload: String) -> String {
    format!("pong: {} (from Rust)", payload)
}

/// 返回 Cargo.toml 里的版本号
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 自定义标题栏的窗口控制：minimize / maximize / close / topmost
#[tauri::command]
fn window_action(window: WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        "topmost" => {
            let next = !window.is_always_on_top().unwrap_or(false);
            window.set_always_on_top(next)
        }
        other => return Err(format!("unknown window action: {}", other)),
    }
    .map_err(|e| e.to_string())
}

/// 更换软件窗口图标（任务栏 / 标题栏上的那一个）。外壳能力：图标属于窗口，不属于插件。
/// 依赖 tauri 的 image-ico / image-png feature（见 Cargo.toml）。
#[tauri::command]
fn set_window_icon(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::image::Image;
    // Manager 已在文件顶部导入（setup 里的 get_webview_window 也要用），
    // 这里不再重复引入，否则会触发 "imported redundantly" 警告。
    let p = path.trim();
    if p.is_empty() { return Err("图标路径为空".into()); }
    if !std::path::Path::new(p).is_file() { return Err(format!("图标文件不存在: {p}")); }
    let img = Image::from_path(p).map_err(|e| format!("读取图标失败（支持 .ico/.png）: {e}"))?;
    let win = app.get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or_else(|| "找不到窗口".to_string())?;
    win.set_icon(img).map_err(|e| format!("设置图标失败: {e}"))
}

/// 脑图打印：走 Tauri 原生打印（`WebviewWindow::print()`）。
///
/// # 关键前提：wry 目前**只在 macOS** 实现了它
///
/// Tauri 官方文档（含最新的 2.4.1）在 `WebviewWindow::print()` 上明确写着：
/// "Currently only supported on macOS on wry. window.print() works on all platforms."
///
/// 也就是说在 Windows / Linux 上它是 **no-op**：不弹对话框、也不报错。
/// 这比直接失败更难排查 —— 用户只看到「点了打印没反应」，
/// 既不知道失败，也不知道该换哪条路。
///
/// 所以这里**主动声明支持范围**，而不是让它静默失败：
///   - macOS  → 调原生打印（`NSPrintOperation`），返回 `"native"`
///   - 其它   → 返回 `Err`，由前端回退到 `window.print()`
///
/// 行为因此可预测；将来 wry 补齐别的平台，只要放开下面的 cfg 即可。
///
/// 注意：**不在这里改窗口标题**。打印前设标题能影响 PDF 默认文件名与页眉，
/// 但标题是窗口级的、打印结束时机又不确定，改了不恢复会留下副作用
/// （用户会看到窗口标题变成「画布 1」）。
#[tauri::command]
fn mm_print(window: WebviewWindow) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        return window
            .print()
            .map(|_| "native".to_string())
            .map_err(|e| e.to_string());
    }

    #[cfg(not(target_os = "macos"))]
    {
        // window 是 magic parameter，非 macOS 分支里用不到但必须存在，
        // 显式消费掉以免触发 unused 警告。
        let _ = &window;
        Err(format!(
            "wry 的原生打印目前只在 macOS 实现（当前平台 {}），请回退 window.print()",
            std::env::consts::OS
        ))
    }
}

/// 脑图：SVG → PDF（**矢量、静默**，不经浏览器）。
///
/// # 为什么这是默认通道
///
/// 另两条路都要把 SVG 塞进 HTML 再交给 webview 渲染打印：
///   - `WebviewWindow::print()`：wry **只在 macOS 实现**，Windows/Linux 是 no-op；
///   - `window.print()`：能跨平台，但必须用户在对话框里确认，做不到「无感导出」。
///
/// 而 kityminder 导出的**本身就是 SVG**，SVG → PDF 是矢量到矢量的直接转换，
/// 不需要浏览器参与。svg2pdf 是纯 Rust、跨平台、不栅格化、真静默。
///
/// 经核实 kityminder 的 SVG 只用到 path / text / image，
/// 不含 gradient / pattern / clipPath / filter / foreignObject，
/// 全部落在 svg2pdf 的能力范围内。
///
/// @param svg  完整画布的 SVG 文本（**必须带 viewBox**，否则尺寸无从确定）
/// @param dpi  可选。SVG 像素 → PDF 点 的换算基准，默认 72（1px = 1pt）。
///             前端按「缩放到 A4 内容区」算好再传进来 —— 计算逻辑放在 JS 侧，
///             一是可单测，二是让 Rust 侧保持极简以降低编译风险。
/// @returns    base64 编码的 PDF（复用 fpx::base64，不额外引 crate）
#[tauri::command]
fn mm_svg_to_pdf(svg: String, dpi: Option<f32>) -> Result<String, String> {
    let text = svg.trim();
    if text.is_empty() {
        return Err("SVG 内容为空".into());
    }

    let mut options = svg2pdf::usvg::Options::default();
    // 必须加载系统字体：SVG 里的中文（微软雅黑 / Heiti SC）要靠它解析，
    // 不加载的话文字会丢失或变成方框。
    //
    // 已知限制：Linux 上可能没有微软雅黑/Heiti SC，中文会走形。
    // 真要覆盖 Linux，得内置一款开源中文字体并用 load_font_data 注入 ——
    // 那会显著增大体积，暂不做，先把 Windows / macOS 两条主路径走通。
    options.fontdb_mut().load_system_fonts();

    let tree = svg2pdf::usvg::Tree::from_str(text, &options)
        .map_err(|e| format!("SVG 解析失败：{e}"))?;

    let page = svg2pdf::PageOptions { dpi: dpi.unwrap_or(72.0) };
    let pdf = svg2pdf::to_pdf(&tree, svg2pdf::ConversionOptions::default(), page)
        .map_err(|e| format!("PDF 生成失败：{e}"))?;

    if pdf.is_empty() {
        return Err("PDF 生成结果为空".into());
    }
    Ok(fpx::base64::encode(&pdf))
}

/// 当前平台是否支持 Tauri 原生打印。
///
/// 前端可据此决定要不要显示「打印」入口、以及提示走哪条路径，
/// 而不是等点了才知道。与 `mm_print` 的 cfg 判断必须保持一致。
#[tauri::command]
fn mm_print_support() -> bool {
    cfg!(target_os = "macos")
}

/// 脑图：打开开发者工具（对齐 WPF `OpenDevTools()`）。
///
/// 注意：`open_devtools` 只在 **debug 构建或启用 devtools feature** 时存在。
/// Cargo.toml 里已开 `devtools`，所以 release 也能用 —— 但这对最终用户没意义，
/// 反而可能被误点。因此只在 debug 下真的打开，release 明确告知不可用。
///
/// 为什么不像 C# 那样直接调：WPF 的 `Editor.OpenDevTools()` 走的是
/// WebView2 的 `OpenDevToolsWindow`；Tauri 这边对应 `open_devtools()`，
/// 同样是窗口级能力，必须放在 Rust 侧（前端无权开控制台）。
#[tauri::command]
fn mm_open_devtools(window: WebviewWindow) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
        return Ok(());
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = &window;
        Err("开发者工具仅在调试构建中可用（当前是 release 构建）".into())
    }
}

/// 当前是否具备「SVG → PDF」静默导出能力。
///
/// 与 `mm_svg_to_pdf` 不同，这个能力是**编译期就有**的（svg2pdf 是纯 Rust，
/// 不挑平台），所以恒为 true。但前端仍需要一个探测入口：
/// 万一将来裁剪掉该依赖、或换成可选 feature，前端能据此降级而不是崩溃。
#[tauri::command]
fn mm_pdf_vector_support() -> bool {
    true
}

fn main() {
    // ---- 命令行模式：不进 Tauri、不开窗口 ----
    // 必须在 Builder 之前处理：一旦 run() 起来就已经晚了。
    // 有输出时打印并直接退出，返回 0 表示成功、1 表示失败。
    let argv: Vec<String> = std::env::args().collect();
    if let Some(out) = fpx::cli::try_handle(&argv) {
        println!("{out}");
        // 自检报告里出现 [FAIL] 就给非零退出码，方便脚本判断是否要通过
        std::process::exit(if out.contains("[FAIL]") { 1 } else { 0 });
    }

    // --mcp：只跑 MCP server，不显示窗口（供 AI 客户端拉起）
    let mcp_only = argv.len() > 1 && argv[1] == "--mcp";

    tauri::Builder::default()
        // OCR / 翻译节点要调大模型 API：经官方 http 插件发出，
        // 绕过 webview 的同源策略（多数大模型 API 不允许浏览器直连）。
        // 依赖已在 Cargo.toml 声明，这里只是启用它。
        // shell：agent-flow 用它启动 traecli / codebuddy 子进程
        .plugin(tauri_plugin_shell::init())
        // http：OCR / 翻译 / 订阅源抓取，绕过 webview 同源策略
        .plugin(tauri_plugin_http::init())
        .manage(fpx::store::FpxState::new())
        .manage(af_flow::ProcRegistry(std::sync::Mutex::new(std::collections::HashMap::new())))
        .manage(af_flow::WatchRegistry(std::sync::Mutex::new(std::collections::HashMap::new())))
        .manage(af_flow::WebhookRegistry(std::sync::Mutex::new(std::collections::HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            rust_ping, app_version, window_action, set_window_icon,
            mm_print, mm_print_support, mm_svg_to_pdf, mm_pdf_vector_support, mm_open_devtools,
            fpx::fpx_bootstrap, fpx::fpx_save_config, fpx::fpx_create_link, fpx::fpx_remove_link,
            fpx::fpx_scan_content, fpx::fpx_read_file, fpx::fpx_open_path, fpx::fpx_list_dirs,
            fpx::fpx_quick_roots, fpx::fpx_copy_text, fpx::fpx_create_folder, fpx::fpx_set_lock, fpx::fpx_set_icon,
            fpx::fpx_save_style, fpx::fpx_list_icons, fpx::fpx_icon_data, fpx::fpx_save_icon_data,
            fpx::fpx_pick_color, fpx::fpx_save_custom_colors, fpx::fpx_open_data_dir, fpx::fpx_open_backup_dir,
            fpx::fpx_backup, fpx::fpx_list_editors, fpx::fpx_set_editor, fpx::fpx_edit_file,
            fpx::fpx_chain_clients, fpx::fpx_save_chain_clients, fpx::fpx_move_card_across,
            fpx::fpx_chain_actions, fpx::fpx_save_chain_actions, fpx::fpx_chain_send_action,
            fpx::fpx_chain_send, fpx::fpx_capture_screen, fpx::fpx_watch_start,
            fpx::fpx_watch_stop, fpx::fpx_watch_poll, fpx::fpx_mcp_start, fpx::fpx_mcp_tools,
            fpx::fpx_backup_auto_status, fpx::fpx_backup_auto_sync, fpx::fpx_mcp_stop,
            fpx::fpx_mcp_status, fpx::fpx_import_icons, fpx::fpx_rename_folder, fpx::fpx_clear_invalid,
            fpx::fpx_move_folder, fpx::fpx_rename_content_item,
            af_flow::run_node, af_flow::kill_node, af_flow::check_cli,
            af_flow::watch_start, af_flow::watch_stop,
            af_flow::webhook_start, af_flow::webhook_stop,
            af_flow::fs_op, af_flow::af_read_image_data_url,
            af_flow::af_device_salt, af_flow::af_fs_tail
        ])
        .setup(move |app| {
            if mcp_only {
                // 关掉主窗口：AI 客户端拉起的实例不需要界面，
                // 留着只会多占资源、还可能因为窗口关闭而退出进程。
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
                let port = argv_opt_port(&argv);
                match fpx::mcp::serve(app.handle().clone(), port) {
                    Ok(addr) => eprintln!("[mcp] listening on http://{addr}/mcp"),
                    Err(e) => eprintln!("[mcp] 启动失败: {e}"),
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Nexus Panel 失败");
}

/// 解析 `--mcp [port]` 里可选的端口号，没给则 0（由系统分配）。
fn argv_opt_port(argv: &[String]) -> u16 {
    argv.get(2)
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(0)
}
