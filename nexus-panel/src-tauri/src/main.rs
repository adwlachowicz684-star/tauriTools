// 防止 Windows 上 release 构建弹出额外控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::WebviewWindow;
// get_webview_window / package_info 等方法定义在 Manager 这个 trait 上，
// 不导入它编译器就"看不见"这些方法（E0599），即使类型本身是对的。
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

mod af_flow;
mod fpx;
/*
 * 应用更新。三条命令全是 M 类（联网 / 下载安装 / 重启进程），
 * 只给内置 updater 插件用（第三方禁 M）。
 *
 * ⚠️ 这一行此前被同步提交覆盖丢失过两次：updater.rs 文件还在、
 * 命令也在，但少了 mod 声明就**不参与编译**，注册列表里自然也没有它们 ——
 * 结果是运行时 "command not found"，界面上表现为「检查更新」点了没反应，
 * 而编译和实际报错都指向别处。改这个文件后请跑 `npm run scan:commands`。
 */
mod updater;

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

/* ---------------- 主窗口的显隐 ---------------- */

/// 把主窗口带到前台。三步都不能省：
///   unminimize —— 最小化状态下直接 set_focus 在部分平台无效
///   show       —— 被 hide 过（Ctrl+~ / --mcp）的窗口不会因 set_focus 而显示
///   set_focus  —— 真正把它带到前台
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        eprintln!("[tray] 没有 main 窗口，无法聚焦");
    }
}

/// 主窗口当前是否可见。查不到窗口 / 查询失败都当作不可见 ——
/// 这样"切换"逻辑会走 show 分支，最坏情况是多调一次 show（无害）；
/// 反过来若当作可见，用户就永远切不回来了。
fn main_window_visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// 自定义标题栏的窗口控制：minimize / maximize / close / topmost / hide
///
/// `hide` 是"藏到托盘"：窗口关掉但进程还在，靠托盘或 Ctrl+~ 唤回。
/// 与 `close` 的区别是 close 会**销毁**窗口 —— 之后 single-instance 回调
/// 里没有窗口可聚焦，表现为"双击图标点了没反应"（见 --mcp 那段的说明）。
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
        "hide" => window.hide(),
        "topmost" => {
            let next = !window.is_always_on_top().unwrap_or(false);
            window.set_always_on_top(next)
        }
        other => return Err(format!("unknown window action: {}", other)),
    }
    .map_err(|e| e.to_string())
}

/// 供托盘点击调用：窗口可见则藏起来，不可见则唤回。
#[tauri::command]
fn tray_toggle_window(app: tauri::AppHandle) {
    if main_window_visible(&app) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    } else {
        focus_main_window(&app);
    }
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

    /* --stdio：以 stdio 方式跑 MCP server（供 Claude Desktop 这类客户端拉起）。
       ------------------------------------------------------------------
       **必须在这里处理，不能放进 Builder 之后。**

       stdio 模式下 stdout 只能有 JSON-RPC 消息，客户端按行解析；
       Tauri 一旦 run() 起来，往 stdout 打了什么就不可控了（webview
       在部分平台会输出信息），一行杂讯就会让客户端解析失败。

       所以这里先算好数据目录（拿不到 AppHandle，走与 Tauri 相同的规则），
       起 stdio server，进程就一直待在下面那行 —— 根本不会进 Tauri。 */
    if argv.len() > 1 && argv[1] == "--stdio" {
        let dir = fpx::cli::dirs_data_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("project-group"));
        if let Err(e) = fpx::mcp::serve_stdio(dir) {
            // 走 stderr：stdout 是协议通道，不能被污染
            eprintln!("[mcp:stdio] 退出: {e}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }

    // --mcp：只跑 MCP server，不显示窗口（供 AI 客户端拉起）
    let mcp_only = argv.len() > 1 && argv[1] == "--mcp";

    tauri::Builder::default()
        // single-instance：同时只允许一个实例。
        // 第二个实例会被插件直接结束，并由此处（**已有实例**）执行回调。
        // 刻意放在最前面：第二个实例要尽早退出，少做无用初始化。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            /* 回调运行在已有实例里，所以这里拿到的就是那个还活着的窗口。
               三步都不能省：
                 unminimize —— 最小化状态下直接 set_focus 在部分平台无效
                 show       —— --mcp 拉起的实例窗口是隐藏的
                 set_focus  —— 真正把它带到前台 */
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            } else {
                eprintln!("[single-instance] 已有实例没有 main 窗口，无法聚焦");
            }
        }))
        // OCR / 翻译节点要调大模型 API：经官方 http 插件发出，
        // 绕过 webview 的同源策略（多数大模型 API 不允许浏览器直连）。
        // 依赖已在 Cargo.toml 声明，这里只是启用它。
        // shell：agent-flow 用它启动 traecli / codebuddy 子进程
        .plugin(tauri_plugin_shell::init())
        // http：OCR / 翻译 / 订阅源抓取，绕过 webview 同源策略
        .plugin(tauri_plugin_http::init())
        /*
         * updater：应用自更新。
         *
         * ⚠️ 少了这一行是**编译错误**不是运行时问题：updater.rs 里
         * `app.updater_builder()` 来自 `UpdaterExt` 这个 trait，插件没初始化
         * 编译器就"看不见"它（E0599）—— 和开头必须 `use tauri::Manager`
         * 是同一类坑（get_webview_window 也是 trait 方法）。
         *
         * 而它的报错信息指向 updater.rs，很容易被当成 updater.rs 写错了，
         * 实际缺的是 main.rs 这一行。改这个文件后请跑 `npm run scan:commands`。
         */
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(fpx::store::FpxState::new())
        .manage(af_flow::ProcRegistry(std::sync::Mutex::new(std::collections::HashMap::new())))
        .manage(af_flow::WatchRegistry(std::sync::Mutex::new(std::collections::HashMap::new())))
        .manage(af_flow::WebhookRegistry(std::sync::Mutex::new(std::collections::HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            rust_ping, app_version, window_action, set_window_icon,
            mm_print, mm_print_support, mm_svg_to_pdf, mm_pdf_vector_support, mm_open_devtools,
            fpx::fpx_bootstrap, fpx::fpx_save_config, fpx::fpx_create_link, fpx::fpx_remove_link,
            fpx::fpx_sync_links,
            fpx::fpx_scan_content, fpx::fpx_read_file, fpx::fpx_open_path, fpx::fpx_list_dirs,
            fpx::fpx_quick_roots, fpx::fpx_copy_text, fpx::fpx_create_folder, fpx::fpx_set_lock, fpx::fpx_lock_state, fpx::fpx_set_icon,
            fpx::fpx_remove_card,
            fpx::fpx_save_style, fpx::fpx_list_icons, fpx::fpx_icon_data, fpx::fpx_save_icon_data,
            fpx::fpx_rename_icon,
            fpx::fpx_pick_color, fpx::fpx_save_custom_colors, fpx::fpx_open_data_dir, fpx::fpx_open_backup_dir,
            fpx::fpx_backup, fpx::fpx_list_editors, fpx::fpx_set_editor, fpx::fpx_edit_file,
            fpx::fpx_read_text, fpx::fpx_write_text, fpx::fpx_export_text,
            fpx::fpx_chain_clients, fpx::fpx_save_chain_clients, fpx::fpx_move_card_across,
            fpx::fpx_chain_actions, fpx::fpx_save_chain_actions, fpx::fpx_chain_send_action, fpx::fpx_chain_defaults,
            fpx::fpx_chain_send, fpx::fpx_chain_preview, fpx::fpx_capture_screen,
            fpx::fpx_watch_start,
            fpx::fpx_watch_stop, fpx::fpx_watch_poll, fpx::fpx_mcp_start, fpx::fpx_mcp_tools,
            fpx::fpx_backup_auto_status, fpx::fpx_backup_auto_sync, fpx::fpx_mcp_stop,
            fpx::fpx_backup_targets,
            fpx::fpx_mcp_status, fpx::fpx_import_icons, fpx::fpx_rename_folder, fpx::fpx_clear_invalid,
            fpx::fpx_mcp_register,
            fpx::fpx_move_folder, fpx::fpx_rename_content_item, fpx::fpx_rename_skill_segment,
            af_flow::run_node, af_flow::kill_node, af_flow::check_cli,
            af_flow::watch_start, af_flow::watch_stop,
            af_flow::webhook_start, af_flow::webhook_stop,
            af_flow::fs_op, af_flow::af_read_image_data_url, af_flow::af_read_audio_data_url,
            af_flow::af_fs_allow_root, af_flow::af_fs_list_roots, af_flow::af_fs_disallow_root,
            /* 这两条此前**定义了却没注册**：带了 #[tauri::command] 但不在
               generate_handler! 里 —— 编译不报错，只在运行时报
               "command not found"，而前端确实在调它们
               （plugins/agent-flow/lib/tauri.ts 的凭据加密与对话监听）。 */
            af_flow::af_fs_tail, af_flow::af_device_salt,
            /*
             * OS 凭据管理器三条（af_flow.rs 里有 #[tauri::command] 和完整实现，
             * 但此前没进 generate_handler!）—— 不注册的话前端调它们只会被拒，
             * 表现为"凭据中心的 oskeyring 模式点了没反应"，且不报具体原因。
             * 一致性扫描器（npm run scan:commands）就是为抓这类缺口而建的。
             */
            af_flow::af_os_keyring_get, af_flow::af_os_keyring_set,
            af_flow::af_os_keyring_delete,
            tray_toggle_window,
            /* 应用更新三条。缺了的表现是设置页「检查更新」点了没反应 ——
               前端 invoke 被拒，且不报具体原因。 */
            updater::updater_check, updater::updater_install, updater::updater_relaunch
        ])
        .setup(move |app| {
            /* 托盘图标。
               ------------------------------------------------------------------
               为什么要它：Ctrl+~ 把窗口藏起来之后，**没有任何入口能把它唤回来**
               —— 窗口隐藏时收不到键盘事件（那需要全局快捷键插件），
               任务栏里也没有它的身影。托盘是唯一的回路。

               所以托盘必须在 setup 里无条件创建，`--mcp` 模式下也一样：
               那种模式窗口本来就是隐藏的，没有托盘的话进程只能靠任务管理器杀。

               图标用应用自带的默认图标取不到时（理论上不该发生，bundle 里
               已经配了 icons/）仍然创建托盘 —— 无图标的托盘在多数平台上
               仍可点击，功能不丢，只是不美观。 */
            let show_item = MenuItemBuilder::with_id("show", "显示面板").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Nexus Panel")
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => focus_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                /* 左键单击 = 切换显隐。用 Up 而不是 Down：
                   部分平台在 Down 时就会触发，随后系统又弹右键菜单，
                   两者叠在一起会出现"点了显示却先弹菜单"的错乱。 */
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if main_window_visible(app) {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        } else {
                            focus_main_window(app);
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            } else {
                eprintln!("[tray] 应用默认图标不可用，托盘将无图标（功能仍可用）");
            }
            tray.build(app)?;

            if mcp_only {
                /* 隐藏主窗口：AI 客户端拉起的实例不需要界面。
                   ------------------------------------------------------------------
                   这里用 hide 而不是 close —— close 会**销毁**窗口，
                   之后用户再双击图标启动时，已有实例没有窗口可聚焦，
                   single-instance 回调只能干瞪眼，表现为"点了没反应"。

                   hide 保留窗口，回调里 show() 就能直接把它带回来。
                   代价是多留一个隐藏窗口（几十 MB），换来的是行为正确；
                   而且顺带避免了原先担心的"窗口关闭导致进程退出"。 */
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                let port = argv_opt_port(&argv);
                match fpx::mcp::serve(app.handle().clone(), port) {
                    Ok(addr) => eprintln!("[mcp] listening on http://{addr}/mcp"),
                    Err(e) => eprintln!("[mcp] 启动失败: {e}"),
                }
            }
            /*
             * #42 MCP 注册自愈（原版 `McpRegistrationService`，启动时后台跑）。
             *
             * 只修**已经登记过**的条目（把 exe 路径与启动参数校正到当前版本），
             * 绝不主动创建 —— 用户全局配置里有什么是他自己的事，
             * 凭空加一条等于替他改了别的软件的配置。
             *
             * 失败只记 stderr：这是锦上添花，不能因为自愈失败就起不来界面。
             */
            let reg = fpx::mcp::register_clients();
            if !reg.is_empty() {
                eprintln!("[mcp] 注册自愈：{reg}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Nexus Panel 失败")
        .run(|app_handle, event| {
            /*
             * #53 退出时关闭 MCP 后台进程（原版 `closeMcpOnExit`）。
             *
             * 此前这是个**死配置项**：model.rs 里有字段、有 Default，
             * 但全库无读取点。表现是"界面上有个开关，勾了没反应" ——
             * 不报错，用户只会以为自己没设对。
             *
             * 为什么挂 RunEvent::Exit 而不是窗口关闭事件：
             *   · 窗口 close/hide 不意味着进程退出（本项目用 hide 隐藏窗口，
             *     第二个实例靠 single-instance 回调唤回）；
             *   · 托盘「退出」走 app.exit(0)，也不经过窗口事件。
             * RunEvent::Exit 是唯一能覆盖**所有**退出路径的钩子。
             *
             * 注意：Tauri 2 的 RunEvent 只在 `App::run(|h, event| ..)` 回调里给，
             * Builder 上没有 on_event —— 挂在 Builder 上编译不过。
             *
             * 只在配置为 true 时关：有人把 MCP 当常驻服务用
             * （关掉面板仍想让客户端连着），所以由开关决定。
             */
            if let tauri::RunEvent::Exit = event {
                let should_stop = crate::fpx::store::resolve_data_dir(app_handle)
                    .map(|dir| crate::fpx::store::load_config(&dir).close_mcp_on_exit)
                    .unwrap_or(false);
                if should_stop {
                    crate::fpx::mcp::stop();
                    eprintln!("[mcp] 退出时已按配置关闭 MCP 后台进程");
                }
            }
        });
}

/// 解析 `--mcp [port]` 里可选的端口号，没给则 0（由系统分配）。
fn argv_opt_port(argv: &[String]) -> u16 {
    argv.get(2)
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(0)
}
