// 防止 Windows 上 release 构建弹出额外控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::WebviewWindow;

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
    use tauri::Manager;
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
    tauri::Builder::default()
        .manage(fpx::store::FpxState::new())
        .invoke_handler(tauri::generate_handler![
            rust_ping, app_version, window_action, set_window_icon,
            fpx::fpx_bootstrap, fpx::fpx_save_config, fpx::fpx_create_link, fpx::fpx_remove_link,
            fpx::fpx_scan_content, fpx::fpx_read_file, fpx::fpx_open_path, fpx::fpx_list_dirs,
            fpx::fpx_quick_roots, fpx::fpx_create_folder, fpx::fpx_set_lock, fpx::fpx_set_icon,
            fpx::fpx_save_style, fpx::fpx_list_icons, fpx::fpx_icon_data, fpx::fpx_save_icon_data,
            fpx::fpx_pick_color, fpx::fpx_save_custom_colors, fpx::fpx_open_data_dir,
            fpx::fpx_backup, fpx::fpx_list_editors, fpx::fpx_set_editor, fpx::fpx_edit_file,
            fpx::fpx_chain_clients, fpx::fpx_save_chain_clients, fpx::fpx_move_card_across,
            fpx::fpx_chain_actions, fpx::fpx_save_chain_actions, fpx::fpx_chain_send_action,
            fpx::fpx_chain_send, fpx::fpx_capture_screen, fpx::fpx_watch_start,
            fpx::fpx_watch_stop, fpx::fpx_watch_poll, fpx::fpx_mcp_start, fpx::fpx_mcp_tools,
            fpx::fpx_backup_auto_status, fpx::fpx_backup_auto_sync, fpx::fpx_mcp_stop,
            fpx::fpx_mcp_status, fpx::fpx_import_icons, fpx::fpx_rename_folder, fpx::fpx_clear_invalid
        ])
        .run(tauri::generate_context!())
        .expect("启动 Nexus Panel 失败");
}
