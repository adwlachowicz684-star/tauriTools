//! 应用自更新 —— 包装 Tauri 官方 updater 插件
//! ============================================================
//!
//! 【为什么要自己包一层，而不是让前端直接用 @tauri-apps/plugin-updater】
//! 官方 JS API 的 check() 用的是 tauri.conf.json 里**写死**的 endpoints，
//! 没有运行时切换通道的入口（官方文档明确：出于安全原因，endpoints 与
//! pubkey 只能在 Rust 侧覆盖）。我们要做「正式版 / 内部测试」双通道，
//! 通道由用户在设置页里选 —— 只能走 Rust。
//!
//! 包一层还带来两个好处：
//!   · 三条命令纳入 js/command-caps.js 的分级与 js/invoke-policy.js 的白名单，
//!     第三方插件拿不到（见下）；
//!   · 前端不用装 @tauri-apps/plugin-updater，也不用给 webview 放开
//!     updater 的 ACL —— HTTP 请求由 Rust 发出，
//!     **index.html 那条锁死的 CSP 一个字都不用改**。
//!     （ErgeMD 把 connect-src 放开成 https: 是它自己的选择，不是 updater 的要求。）
//!
//! 【能力等级：三条都是 M】
//!   updater_check    对外发请求（暴露当前版本与所选通道）
//!   updater_install  下载安装包并**执行安装** —— 等价于运行下载下来的二进制
//!   updater_relaunch 结束并重启本进程
//! 按 js/command-caps.js 的定义，M = 提权 / 宿主操控 / 进程 / 网络监听。
//! 第三方插件禁 M（THIRD_DENY_CAPS），所以只有内置 updater 插件能用；
//! 且它**必须**注册为 builtin —— 否则别人注册一个同名 updater 插件
//! 就能劫持更新通道。这是供应链层面的攻击面，不能靠约定。
//!
//! 【签名公钥：为什么这里也写一份】
//! tauri.conf.json → plugins.updater.pubkey 是给默认流程用的；
//! 本模块走 updater_builder()，通道要运行时切换，所以公钥也在这里显式传一次。
//! 两份**必须一致**，否则表现是"用某个通道永远验签失败"——
//! updater-test.mjs 里有一条断言把两者钉在一起。

use tauri_plugin_updater::UpdaterExt;

/// 正式版通道
pub const CHANNEL_STABLE: &str = "stable";
/// 内部测试通道
pub const CHANNEL_BETA: &str = "beta";

/*
 * 公钥占位符标记。**不要**把真实私钥提交进仓库 ——
 * 生成方式见 docs/更新与签名.md。
 */
const PLACEHOLDER_MARK: &str = "REPLACE_WITH";

/**
 * 签名公钥（minisign，base64）。
 *
 * ⚠️ 必须与 tauri.conf.json → plugins.updater.pubkey 完全一致。
 * 生成：npx tauri signer generate --write-keys ~/.tauri/tauri.key
 * 私钥只留在构建机 / CI secret 里；**私钥丢了就再也升不了级**
 * —— 老客户端用旧公钥验不过新签名，且不可逆。
 */
const UPDATER_PUBKEY: &str = "REPLACE_WITH_YOUR_MINISIGN_PUBLIC_KEY";

/*
 * 端点模板。
 *
 * latest.json 是 Tauri 的更新清单，结构：
 *   { "version", "notes", "pub_date",
 *     "platforms": { "windows-x86_64": { "signature", "url" }, ... } }
 *
 * 双端点（GitHub + Gitee）：updater 会**依次尝试**，前者访问不通时自动走镜像，
 * 所以国内不需要额外写"选哪个源"的逻辑。
 *
 * ⚠️ Gitee 那两条的 owner 需要替换成你自己的 Gitee 用户名；
 *    仓库名与 GitHub 保持一致即可。
 */
const GH_RELEASE: &str = "https://github.com/adwlachowicz684-star/tauriTools/releases/download";
const GITEE_RELEASE: &str = "https://gitee.com/REPLACE_GITEE_OWNER/tauriTools/releases/download";

/// 把外部传入的通道名收敛成两个合法值。
///
/// 不认识的（手改 localStorage 塞进来的）一律按正式版处理 ——
/// 测试通道是**更激进**的那一个，认错方向会把普通用户推到内测版上。
fn normalize_channel(channel: Option<&str>) -> &'static str {
    match channel.unwrap_or(CHANNEL_STABLE).trim().to_ascii_lowercase().as_str() {
        CHANNEL_BETA => CHANNEL_BETA,
        _ => CHANNEL_STABLE,
    }
}

/// 通道 → 端点列表。**顺序有意义**：GitHub 在前，Gitee 在后兜底。
fn endpoints_for(channel: &str) -> Vec<String> {
    let tag = match channel {
        CHANNEL_BETA => "updater-beta",
        _ => "updater-stable",
    };
    vec![
        format!("{GH_RELEASE}/{tag}/latest.json"),
        format!("{GITEE_RELEASE}/{tag}/latest.json"),
    ]
}

/// 公钥是否还是占位符。
///
/// 没配公钥时**明确说没配**，而不是让验签失败伪装成"网络错误"或"没有更新"——
/// 后者会让人去查网络、查版本号，方向全错。
fn pubkey_ready() -> bool {
    let k = UPDATER_PUBKEY.trim();
    !k.is_empty() && !k.starts_with(PLACEHOLDER_MARK)
}

/// 用给定通道构造 updater。
fn build_updater(app: &tauri::AppHandle, channel: &str) -> Result<tauri_plugin_updater::Updater, String> {
    /* endpoints() 收的是 Vec<Url> 而不是 Vec<String>（updater 2.12）。
       端点是常量拼出来的，解析失败只可能是常量写错 —— 与其让每个 URL 的
       parse 结果单独冒泡，不如这里一次性判空，把"端点不可用"说成一句人话。 */
    let urls: Vec<tauri::Url> = endpoints_for(channel)
        .into_iter()
        .filter_map(|s| tauri::Url::parse(&s).ok())
        .collect();
    if urls.is_empty() {
        return Err("更新端点无效：URL 全部解析失败".to_string());
    }
    app.updater_builder()
        .endpoints(urls)
        .map_err(|e| format!("更新端点无效：{e}"))?
        .pubkey(UPDATER_PUBKEY)
        .build()
        .map_err(|e| format!("初始化更新器失败：{e}"))
}

/// 检查结果的**状态**。刻意做成枚举字符串而不是 `has_update: bool`：
/// "没配公钥" / "已是最新" / "网络失败" 三种情况在 bool 下全是 false，
/// 界面上只能显示一句"没有更新"，排查方向完全错。
#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct UpdateInfo {
    /// 'unconfigured' | 'uptodate' | 'available' | 'error'
    pub state: String,
    pub channel: String,
    pub current: String,
    pub latest: String,
    pub notes: String,
    pub date: String,
    /// 仅 error 态有值
    pub message: String,
}

#[tauri::command]
pub async fn updater_check(
    app: tauri::AppHandle,
    channel: Option<String>,
) -> Result<UpdateInfo, String> {
    let ch = normalize_channel(channel.as_deref()).to_string();
    let current = app.package_info().version.to_string();

    if !pubkey_ready() {
        return Ok(UpdateInfo {
            state: "unconfigured".into(),
            channel: ch,
            current,
            latest: String::new(),
            notes: String::new(),
            date: String::new(),
            message: "尚未配置签名公钥（src/updater.rs 的 UPDATER_PUBKEY）。\
                      更新必须验签，没有公钥无法安全安装。"
                .into(),
        });
    }

    let updater = build_updater(&app, &ch)?;
    match updater.check().await {
        // 服务端返回 204 也是 None —— 即"已是最新"
        Ok(None) => Ok(UpdateInfo {
            state: "uptodate".into(),
            channel: ch,
            /* latest 必须先算：结构体按书写顺序求值，`current` 一旦 move
               给 current 字段，下面再 .clone() 就是借用已移动的值。 */
            latest: current.clone(),
            current,
            notes: String::new(),
            date: String::new(),
            message: String::new(),
        }),
        Ok(Some(u)) => Ok(UpdateInfo {
            state: "available".into(),
            channel: ch,
            current,
            latest: u.version.clone(),
            notes: u.body.clone().unwrap_or_default(),
            /* UpdateInfo.date 是 String，而插件给的是 Option<OffsetDateTime>
               （没有 Default）—— 显式格式化，不靠 unwrap_or_default。 */
            date: u.date.map(|d| d.to_string()).unwrap_or_default(),
            message: String::new(),
        }),
        /* 查不到不该当成"没有更新"：端点 404 / 网络不通 / 验签失败
           都会落到这里，一律如实报出来。 */
        Err(e) => Ok(UpdateInfo {
            state: "error".into(),
            channel: ch,
            current,
            latest: String::new(),
            notes: String::new(),
            date: String::new(),
            message: format!("检查更新失败：{e}"),
        }),
    }
}

/**
 * 下载并安装所选通道的最新版本。
 *
 * 装完**不自动重启** —— 由前端问用户何时重启。
 * 自动重启会在用户正写着东西时把进程干掉，是不可接受的静默行为。
 */
#[tauri::command]
pub async fn updater_install(
    app: tauri::AppHandle,
    channel: Option<String>,
) -> Result<String, String> {
    let ch = normalize_channel(channel.as_deref()).to_string();

    if !pubkey_ready() {
        return Err("尚未配置签名公钥（src/updater.rs 的 UPDATER_PUBKEY），拒绝安装未经验签的更新。".into());
    }

    let updater = build_updater(&app, &ch)?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败：{e}"))?;

    let Some(update) = update else {
        return Ok("已是最新版本，无需安装。".into());
    };

    update
        .download_and_install(
            |_chunk_length, _content_length| { /* 进度暂不上抛：设置页只显示"下载中" */ },
            || {},
        )
        .await
        .map_err(|e| format!("下载并安装失败：{e}"))?;

    Ok(format!("已安装 v{}，重启后生效。", update.version))
}

/// 重启本进程，让已安装的更新生效。
#[tauri::command]
pub fn updater_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    app.restart();
    Ok(())
}
