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
        .manage(fpx::store::FpxState::new())
        .manage(af_flow::ProcRegistry(std::sync::Mutex::new(std::collections::HashMap::new())))
        .manage(af_flow::WatchRegistry(std::sync::Mutex::new(std::collections::HashMap::new())))
        .manage(af_flow::WebhookRegistry(std::sync::Mutex::new(std::collections::HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            rust_ping, app_version, window_action, set_window_icon,
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
            af_flow::af_fs_allow_root, af_flow::af_fs_list_roots, af_flow::af_fs_disallow_root
        ])
        .setup(move |app| {
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
