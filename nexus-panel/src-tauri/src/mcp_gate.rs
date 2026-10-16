//! mcp_gate —— 统一 MCP 网关
//! ====================================================================
//!
//! 【它解决什么问题】
//! 接入 MCP 的能力散在各插件自己身上：project-group 内置一个 server
//! （26 个工具）、task-board 自带一个（6 个工具）—— 各自一个端口、
//! 各自一个令牌、各自一份客户端配置。结果是：
//!   · AI 客户端要配**两条**（甚至将来 N 条）mcpServers 条目；
//!   · 每新增一个带 MCP 的插件，用户的客户端配置就得再改一次；
//!   · 「这个工具在哪个 server 下」只有翻文档才知道。
//!
//! 网关把这些能力聚合到**一个端点**：客户端只配一次，之后新增插件的
//! MCP 工具自动出现在同一张工具表里（工具名带 `server__工具` 前缀），
//! tools/call 按前缀路由到对应插件。
//!
//! 【三条设计红线】
//! ① **只绑 127.0.0.1，HTTP 模式一律要令牌。**
//!    与 fpx::mcp 同款判据（见那里的 P1-8）：连 GET / 也校验 ——
//!    健康信息是「这个端口是不是 MCP」的指纹，可被端口扫描利用。
//!    令牌首次启动自动生成并持久化，重启不变（变了客户端就全断）。
//! ② **工具名必须带前缀，不做「猜一个」的兼容。**
//!    多个 server 提供同名工具时（两个插件都叫 list_items），
//!    裸名路由只能靠顺序挑一个 —— 挑错不报错，读的是另一个服务的数据。
//!    前缀是命名空间，模糊匹配是把命名空间的意义扔掉。
//! ③ **原生能力直调，代理能力整包转发，两种都不静默降级。**
//!    原生（Rust 闭包）直接执行业务；代理（外部 HTTP server）转发
//!    JSON-RPC 并原样回传 isError。连不上、返回不是 JSON、对方报错
//!    —— 全部变成明确的 isError 文本，绝不返回空成功。
//!
//! 【与既有三个端点的关系】
//!   · fpx::mcp（project-group 的设置面板起停）—— **不动**。
//!     存量用户按它配好的客户端继续可用；网关是新增的统一入口。
//!   · task_board 的 9911（插件设置里起停）—— **不动**，同理。
//!   · agent-flow 的 MCP 客户端引擎 —— **相反方向**（本工具调外部），
//!     与网关无关，不归这里管。
//! 网关启动时把前两者的工具**注册**进来（handler 直调同一批业务函数，
//! 不是去连它们的端口）—— 所以网关开着时，那两个端点起不起来
//! 都不影响网关里的工具可用。

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::fpx;
use crate::task_board;

/* ================================================================== */
/* 类型                                                                */
/* ================================================================== */

/// server 名与工具名的分隔符。
///
/// 用双下划线而不是单下划线：工具名自己大量使用单下划线
/// （tb_list_tasks），单下划线会让「哪个 server」变得不确定。
pub const SEP: &str = "__";

/// 内置 server 名。代理注册**不许**占用这两个名字 ——
/// 否则「project-group」可能被指到别处，而用户以为还是内置那批。
pub const SERVER_FPX: &str = "project-group";
pub const SERVER_TB: &str = "task-board";

/// 默认端口。9910：避开 fpx 的动态分配与 task-board 的 9911。
pub const DEFAULT_PORT: u16 = 9910;

/// 单个请求 body 上限（4 MiB）。与 task_board 同口径。
const MAX_BODY: usize = 4 * 1024 * 1024;

/// 同时处理的连接上限。每连接一个线程，不设限会被慢速连接堆满线程。
const MAX_CONNS: usize = 32;

/// 工具处理器。
///
/// `Ok(v)`：v 就是 **完整的 tools/call result**（可能自带 isError ——
/// 比如代理对端返回了业务失败，原样透传，不二次包装）。
/// `Err(msg)`：调用层面的失败（服务没起、目录没授权、连不上对端），
/// 由网关统一包成 isError 文本。两者都让 AI「读得到原因」。
pub type ToolHandler = Arc<dyn Fn(&Value) -> Result<Value, String> + Send + Sync>;

/// 工具来源。
pub enum ToolKind {
    /// 本进程内直接执行（fpx / task-board 的业务函数）
    Native,
    /// 转发到外部 HTTP MCP server（其它插件或第三方服务的 /mcp）
    Proxy { url: String, token: String },
}

/// 一条已注册的工具。
pub struct GatewayTool {
    /// 归属 server（如 task-board）
    pub server: String,
    /// 工具原名，**不带**前缀（如 tb_list_tasks）
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub kind: ToolKind,
    /// Native 工具的处理器；Proxy 为 None（靠 kind 里的 url/token 转发）
    pub handler: Option<ToolHandler>,
}

impl GatewayTool {
    /// 对客户端暴露的完整工具名：`server__工具`。
    pub fn full_name(&self) -> String {
        format!("{}{SEP}{}", self.server, self.name)
    }

    /// tools/list 用的一份声明。
    ///
    /// 描述前加 `[server]` 标注来源：工具表聚合后 AI 只看到一长串名字，
    /// 不标出处的话，「该用哪个 server 的工具」得靠猜名字前缀。
    pub fn decl(&self) -> Value {
        json!({
            "name": self.full_name(),
            "description": format!("[{}] {}", self.server, self.description),
            "inputSchema": self.input_schema,
        })
    }

    /// 执行一次调用（见 ToolHandler 的返回约定）。
    pub fn invoke(&self, args: &Value) -> Result<Value, String> {
        match &self.kind {
            ToolKind::Native => match &self.handler {
                Some(h) => h(args),
                // 注册时就必须带 handler；这里是内部错误，不是用户错
                None => Err(format!("内置工具 {}{SEP}{} 缺少处理器", self.server, self.name)),
            },
            ToolKind::Proxy { url, token } => {
                proxy_call(&self.name, url, token, args)
            }
        }
    }
}

/// 网关持久化配置（app_data_dir/mcp-gateway/config.json）。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct GwConfig {
    pub port: u16,
    pub token: String,
    /// 开机自动启动。默认 true —— 本功能的目的就是「接入后直接可用」，
    /// 再要用户手动开一次网关就前功尽弃。绑定回环 + 强制令牌，
    /// 暴露面与既有两个本机 server 相同。
    #[serde(default = "default_autostart")]
    pub auto_start: bool,
}

fn default_autostart() -> bool {
    true
}

impl Default for GwConfig {
    fn default() -> Self {
        Self { port: DEFAULT_PORT, token: String::new(), auto_start: true }
    }
}

/// 网关共享状态（main.rs 里 .manage）。
pub struct GatewayState {
    /// 已注册工具（内置 + 代理），启动与否都能注册
    pub tools: Mutex<Vec<GatewayTool>>,
    running: AtomicBool,
    /// 停止句柄：标志 + 条件变量（accept 是非阻塞轮询，没它要睡满一拍）
    stop: Mutex<Option<(Arc<AtomicBool>, Arc<(Mutex<bool>, Condvar)>)>>,
    /// 实际监听地址（运行中才有；界面显示用）
    addr: Mutex<Option<String>>,
    /// 当前配置（启动时从磁盘读入；保存命令更新它）。
    /// pub：main.rs 的 setup 要读它决定 auto_start（接口面仅此一次读取）。
    pub cfg: Mutex<GwConfig>,
}

impl GatewayState {
    pub fn new() -> Self {
        Self {
            tools: Mutex::new(Vec::new()),
            running: AtomicBool::new(false),
            stop: Mutex::new(None),
            addr: Mutex::new(None),
            cfg: Mutex::new(GwConfig::default()),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

impl Default for GatewayState {
    fn default() -> Self {
        Self::new()
    }
}

/* ================================================================== */
/* 配置持久化                                                          */
/* ================================================================== */

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(base.join("mcp-gateway").join("config.json"))
}

/// 读配置。文件不存在 / 损坏 → 默认值（损坏时把原文留档，不静默删）。
pub fn load_config(app: &AppHandle) -> GwConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return GwConfig::default(),
    };
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return GwConfig::default(),
    };
    match serde_json::from_str::<GwConfig>(&text) {
        Ok(cfg) => cfg,
        Err(e) => {
            // 唯一副本：读不出来不能当没配（那会把用户设的端口/令牌悄悄重置），
            // 留档让人能手工抢救。
            let broken = path.with_extension("json.broken");
            let _ = fs::rename(&path, &broken);
            eprintln!(
                "[mcp-gate] config.json 损坏，已按默认值运行（{e}）；原文已另存为 {}",
                broken.display()
            );
            GwConfig::default()
        }
    }
}

/// 原子写配置（先 .tmp 再 rename，进程中断不残留半截文件）。
fn save_config(app: &AppHandle, cfg: &GwConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建配置目录失败 {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写临时文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换配置文件失败: {e}"))?;
    Ok(())
}

/// 把磁盘配置读进 state（setup 时调一次，让界面在未启动时也看得到端口/令牌）。
pub fn refresh_config(app: &AppHandle, state: &GatewayState) {
    let cfg = load_config(app);
    if let Ok(mut g) = state.cfg.lock() {
        *g = cfg;
    }
}

/* ================================================================== */
/* 注册                                                                */
/* ================================================================== */

/// server 名校验。
///
/// 约束不止是「好看」：分隔符 `__` 是 server 与工具名的边界，server 名里
/// 含它就会让 full_name 的拆分出现歧义（拆分取第一个 `__`）。
fn validate_server_name(server: &str) -> Result<(), String> {
    let s = server.trim();
    if s.is_empty() {
        return Err("服务名不能为空".into());
    }
    if s.len() > 32 {
        return Err("服务名最长 32 个字符".into());
    }
    if s.contains(SEP) {
        return Err(format!("服务名不能包含 {SEP}（那是 server 与工具名的分隔符）"));
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("服务名只能用小写字母、数字和连字符（如 task-board、xmind）".into());
    }
    Ok(())
}

/// 注册一个原生工具。同名（server + name）覆盖旧条目 ——
/// 重注册是「更新实现」，不是错误（setup 每次启动都会全量注册一遍）。
pub fn register_native(
    state: &GatewayState,
    server: &str,
    name: &str,
    description: &str,
    input_schema: Value,
    handler: ToolHandler,
) {
    let mut guard = match state.tools.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    if let Some(existing) = guard
        .iter_mut()
        .find(|t| t.server == server && t.name == name)
    {
        existing.description = description.to_string();
        existing.input_schema = input_schema;
        existing.handler = Some(handler);
        return;
    }
    guard.push(GatewayTool {
        server: server.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        input_schema,
        kind: ToolKind::Native,
        handler: Some(handler),
    });
}

/// 注册一个代理服务：先拉取对方的 tools/list，逐个登记。
///
/// **拉不到就不落任何一条** —— 半截注册的结果是「工具表里有、调用必失败」，
/// 比没有这个服务更难排查（AI 会反复调一个必然失败的工具）。
pub fn register_proxy(
    state: &GatewayState,
    server: &str,
    url: &str,
    token: &str,
) -> Result<usize, String> {
    validate_server_name(server)?;
    if server == SERVER_FPX || server == SERVER_TB {
        return Err(format!(
            "「{server}」是内置服务名。要覆盖内置能力，请在对应插件的设置里调整"
        ));
    }
    let url = url.trim();
    if url.is_empty() {
        return Err("地址不能为空".into());
    }
    // 重名拒绝而不是覆盖：覆盖意味着「改了地址，旧工具 silently 换了一批」，
    // 而用户看到的还是同一个服务名。要改就显式先移除。
    {
        let guard = match state.tools.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        if guard.iter().any(|t| t.server == server) {
            return Err(format!("已存在同名服务「{server}」，请先移除再注册"));
        }
    }

    let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let resp = http_post_json(url, &req, token)?;
    let tools = resp
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .ok_or_else(|| {
            "对方没有返回 tools 数组（地址是对的，但那边不是一个可用的 MCP server？）"
                .to_string()
        })?;

    let mut guard = match state.tools.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let mut n = 0usize;
    for t in tools {
        let name = t
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        // 对方清单内部重名：跳过而不是覆盖（覆盖让结果取决于清单顺序）
        if guard.iter().any(|g| g.server == server && g.name == name) {
            continue;
        }
        let desc = t
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string();
        let schema = t
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        guard.push(GatewayTool {
            server: server.to_string(),
            name,
            description: desc,
            input_schema: schema,
            kind: ToolKind::Proxy {
                url: url.to_string(),
                token: token.trim().to_string(),
            },
            handler: None,
        });
        n += 1;
    }
    if n == 0 {
        // 一条都没进（清单空 / 全重名）—— 视为失败，别留个空服务名在表里
        return Err("对方工具清单为空（或全部重名被跳过）".into());
    }
    Ok(n)
}

/// 移除一个服务的全部工具。内置服务**不许**移除（重启后会重新注册，
/// 移除只会造成「现在没了、重启又回来」的假象）。
pub fn unregister_server(state: &GatewayState, server: &str) -> Result<usize, String> {
    if server == SERVER_FPX || server == SERVER_TB {
        return Err(format!("「{server}」是内置服务，不能移除"));
    }
    let mut guard = match state.tools.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let before = guard.len();
    guard.retain(|t| t.server != server);
    let removed = before - guard.len();
    if removed == 0 {
        return Err(format!("没有名为「{server}」的已注册服务"));
    }
    Ok(removed)
}

/// 注册内置能力（fpx + task-board）。main.rs setup 里调一次。
///
/// handler 里**不缓存数据目录**：目录要在调用时现取 ——
/// task-board 的数据目录是用户随时可改的（设置里换一个 = 换一套任务数据），
/// 注册时定死的话，改完目录后网关读写的还是旧库，且不报错。
pub fn register_builtins(app: &AppHandle, state: &GatewayState) {
    /* ---- fpx（project-group）的全部工具 ---- */
    for t in fpx::mcp::tools() {
        let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let desc = t
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string();
        let schema = t
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        let app_c = app.clone();
        let name_c = name.clone();
        let handler: ToolHandler = Arc::new(move |args: &Value| {
            let dir = fpx::store::resolve_data_dir(&app_c)
                .map_err(|e| format!("定位项目组数据目录失败：{e}"))?;
            fpx::mcp::invoke_tool(&name_c, args, &dir)
        });
        register_native(state, SERVER_FPX, &name, &desc, schema, handler);
    }

    /* ---- task-board 的全部工具 ---- */
    for t in task_board::mcp_tools() {
        let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let desc = t
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string();
        let schema = t
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        let app_c = app.clone();
        let name_c = name.clone();
        let handler: ToolHandler = Arc::new(move |args: &Value| {
            let dir = tb_data_dir(&app_c)?;
            let result = task_board::mcp_call_tool(&name_c, args, &dir);
            // task-board 的 MCP 层把业务失败放在 result.isError 里
            // （与 MCP 约定一致），原样回传即可，网关不拆开重包。
            Ok(result)
        });
        register_native(state, SERVER_TB, &name, &desc, schema, handler);
    }
}

/// task-board 的授权数据目录；没授权时给出**可操作**的指引。
///
/// 为什么不兜底用默认目录：用户可能把数据目录改到了别处，而插件这次会话
/// 还没打开过（授权表是内存态）。此时写默认目录 = 读写一套**错误的**
/// tasks.json，且界面看不出任何异常 —— 正是本项目最防的那种失效。
fn tb_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(st) = app.try_state::<task_board::TbState>() {
        if let Ok(g) = st.data_dir.lock() {
            if let Some(d) = g.as_ref() {
                return Ok(d.clone());
            }
        }
    }
    Err("任务数据目录尚未授权：打开一次「任务管理器」插件即自动授权（它启动时会登记数据目录）".into())
}

/* ================================================================== */
/* 路由                                                                */
/* ================================================================== */

/// 拆分完整工具名 → (server, 工具名)。
///
/// 取**第一个** `__`：server 名已禁止含分隔符，所以第一个之前的一定是
/// server；对端工具名自己含 `__` 时（代理来的怪名字）也不会切错。
fn split_full(full: &str) -> Option<(&str, &str)> {
    full.split_once(SEP)
}

/// 执行一次 tools/call。
fn call_tool(full: &str, args: &Value, state: &GatewayState) -> Result<Value, String> {
    let (server, name) = split_full(full).ok_or_else(|| {
        format!(
            "工具名「{full}」不带 server 前缀。网关里的工具名形如 task-board{SEP}tb_list_tasks，\
             可先调 tools/list 看完整清单"
        )
    })?;
    let guard = match state.tools.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let tool = guard
        .iter()
        .find(|t| t.server == server && t.name == name)
        .ok_or_else(|| format!("网关里没有工具「{full}」。可调 tools/list 查看当前全部工具"))?;
    tool.invoke(args)
}

/// 聚合 tools/list。
///
/// fpx 的启用开关**实时读配置**：用户在 project-group 设置里关掉的工具，
/// 网关里要立刻消失 —— 否则「关了还能调」，那个开关就白设计了。
/// 配置读不到时不过滤（让 handler 自己去报「服务已关闭」），
/// 宁可多列几个调用会失败的工具，也不因为读配置失败把整个清单弄没。
fn list_tools(app: &AppHandle, state: &GatewayState) -> Vec<Value> {
    let fpx_cfg = fpx::store::resolve_data_dir(app)
        .ok()
        .map(|dir| fpx::store::load_config(&dir));
    let guard = match state.tools.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let mut out = Vec::with_capacity(guard.len());
    for t in guard.iter() {
        if t.server == SERVER_FPX {
            if let Some(cfg) = &fpx_cfg {
                if !cfg.mcp_enabled || !fpx::mcp::tool_enabled(cfg, &t.name) {
                    continue;
                }
            }
        }
        out.push(t.decl());
    }
    out
}

/* ================================================================== */
/* JSON-RPC 分发                                                        */
/* ================================================================== */

/// 分发一条带 id 的请求。返回 None = 通知（没有 id 字段），按规范不回包。
fn dispatch(req: &Value, app: &AppHandle, state: &GatewayState) -> Option<Value> {
    // 「没有 id」= 通知；「id: null」= 合法请求，要回 id:null 的响应
    let has_id = req
        .as_object()
        .map(|o| o.contains_key("id"))
        .unwrap_or(false);
    if !has_id {
        return None;
    }
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "nexus-panel-gateway", "version": "1.0.0" },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": list_tools(app, state) })),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or(json!({}));
            let name = params
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            // 调用层面的失败 → MCP 约定的 isError 内容（不是 JSON-RPC error）：
            // AI 读得到失败原因并自行改参重试，而不是整个请求报协议错。
            match call_tool(&name, &args, state) {
                Ok(v) => Ok(v),
                Err(e) => Ok(json!({
                    "content": [{ "type": "text", "text": e }],
                    "isError": true,
                })),
            }
        }
        other => Err(json!({ "code": -32601, "message": format!("未知方法: {other}") })),
    };

    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    })
}

/* ================================================================== */
/* 代理转发（手写 HTTP，不引 reqwest）                                   */
/* ================================================================== */

/// 向对端 MCP server POST 一条 JSON-RPC，返回解析后的响应对象。
///
/// 只支持 http://：对端就是本机服务（插件的 /mcp、第三方本地 server），
/// 明文足够；https 反而要多带一套 TLS 依赖。遇到 https 明确报错，
/// 不静默当 http 试（那会先把令牌发给一个不对等的端点）。
fn http_post_json(url: &str, body: &Value, token: &str) -> Result<Value, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("仅支持 http:// 地址（本机服务）：{url}"))?;
    let (host_port, path) = match rest.split_once('/') {
        Some((hp, p)) => (hp.to_string(), format!("/{p}")),
        None => (rest.to_string(), "/".to_string()),
    };
    if host_port.is_empty() {
        return Err(format!("地址缺少主机名：{url}"));
    }
    let payload = serde_json::to_vec(body).map_err(|e| format!("序列化请求失败: {e}"))?;

    let mut stream =
        TcpStream::connect(&host_port).map_err(|e| format!("连不上 {host_port}：{e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

    let mut head = format!(
        "POST {path} HTTP/1.1\r\nHost: {host_port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        payload.len()
    );
    let token = token.trim();
    if !token.is_empty() {
        // 两种头都带：对端可能是 fpx 风格（Bearer/X-Token）或 task-board 风格（X-TB-Token）
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
        head.push_str(&format!("X-Token: {token}\r\n"));
    }
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(&payload))
        .and_then(|_| stream.flush())
        .map_err(|e| format!("发送请求失败: {e}"))?;

    // Connection: close → 读到 EOF 即完整响应
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取响应失败: {e}"))?;
    let text = String::from_utf8_lossy(&buf);
    let (head_part, body_part) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "对端返回的不是合法 HTTP 响应".to_string())?;
    let code: u16 = head_part
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if code != 200 {
        return Err(format!("对端返回 HTTP {code}"));
    }
    // 对端若用 chunked 编码（本机两个 server 都不是），这里会解析失败并明确报错，
    // 不会静默当成空结果。
    serde_json::from_str(body_part.trim()).map_err(|e| format!("对端响应不是合法 JSON：{e}"))
}

/// 代理一次 tools/call：转发 + 原样回传。
///
/// 对端的 result **不拆不重包**（含它自带的 isError）—— 二次包装会丢掉
/// 对端精心写的失败原因，还会让「网关包的 isError」与「对端的 isError」
/// 在 AI 眼里长得不一样。
fn proxy_call(name: &str, url: &str, token: &str, args: &Value) -> Result<Value, String> {
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": name, "arguments": args },
    });
    let resp = http_post_json(url, &req, token)?;
    if let Some(err) = resp.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("对端返回了未知错误");
        return Err(format!("对端报错：{msg}"));
    }
    resp.get("result")
        .cloned()
        .ok_or_else(|| "对端响应里没有 result 字段".to_string())
}

/* ================================================================== */
/* HTTP 服务                                                            */
/* ================================================================== */

struct Request {
    method: String,
    path: String,
    body: String,
    /// 头名统一小写（HTTP 头名大小写不敏感，见 fpx::mcp::check_auth 同款注释）
    headers: HashMap<String, String>,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_uppercase();
    let path = parts.next()?.to_string();

    let mut content_length = 0usize;
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            if key == "content-length" {
                content_length = v.trim().parse().unwrap_or(0);
            }
            headers.insert(key, v.trim().to_string());
        }
    }

    let mut body = String::new();
    if content_length > 0 {
        // Content-Length 是客户端声明的，照它直接分配等于把内存权交给对端
        if content_length > MAX_BODY {
            return None;
        }
        let mut buf = vec![0u8; content_length];
        reader.read_exact(&mut buf).ok()?;
        body = String::from_utf8_lossy(&buf).to_string();
    }

    Some(Request { method, path, body, headers })
}

/// 校验请求头里的令牌（Bearer / X-Token 两种都认）。
/// 按名字取 header，**大小写不敏感**（HTTP 头名本就不区分大小写）。
///
/// 生产路径上 read_request 已把头名统一小写，这里再做一层是给
/// 直接调用方（测试 / 将来复用）兜底 —— 键名大小写不该影响鉴权结果，
/// 否则"换了个大小写就绕过了"这类差异极难排查。
fn header_ci<'a>(headers: &'a HashMap<String, String>, name: &str) -> Option<&'a String> {
    if let Some(v) = headers.get(name) {
        return Some(v);
    }
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v)
}

fn check_auth(headers: &HashMap<String, String>, expected: &str) -> bool {
    if let Some(v) = header_ci(headers, "authorization") {
        if let Some(bearer) = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")) {
            if fpx::safety::constant_time_eq(bearer.trim(), expected) {
                return true;
            }
        }
    }
    header_ci(headers, "x-token")
        .map(|v| fpx::safety::constant_time_eq(v.trim(), expected))
        .unwrap_or(false)
}

fn unauthorized(id: Value) -> Vec<u8> {
    to_bytes(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32001,
            "message": "unauthorized：缺少或错误的访问令牌（Authorization: Bearer <token> 或 X-Token）",
        }
    }))
}

fn to_bytes(v: Value) -> Vec<u8> {
    serde_json::to_vec(&v).unwrap_or_default()
}

/// 处理一个连接。
fn handle(stream: &mut TcpStream, app: &AppHandle, state: &GatewayState, expected_token: &str) {
    let req = match read_request(stream) {
        Some(r) => r,
        None => {
            write_raw(stream, 400, br#"{"error":"bad request"}"#);
            return;
        }
    };

    if req.method == "OPTIONS" {
        write_raw(stream, 204, b"");
        return;
    }

    // 鉴权在分发之前：未授权请求拿到的仍是结构正确的 JSON-RPC 错误，
    // 不是一个空包（空包会让客户端以为是协议错误）。
    let authed = !expected_token.is_empty() && check_auth(&req.headers, expected_token);

    let (status, body): (u16, Vec<u8>) = match req.method.as_str() {
        "GET" => {
            if !authed {
                (401, unauthorized(Value::Null))
            } else {
                let n = state.tools.lock().map(|g| g.len()).unwrap_or(0);
                (
                    200,
                    to_bytes(json!({
                        "service": "nexus-panel/mcp-gateway",
                        "running": true,
                        "tools": n,
                        "endpoint": "POST /mcp",
                    })),
                )
            }
        }
        "POST" if req.path.starts_with("/mcp") || req.path == "/" => {
            let parsed: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
            if !authed {
                let id = parsed.get("id").cloned().unwrap_or(Value::Null);
                (401, unauthorized(id))
            } else if parsed.is_null() {
                (
                    400,
                    to_bytes(json!({
                        "jsonrpc": "2.0", "id": null,
                        "error": { "code": -32700, "message": "请求体不是合法 JSON" },
                    })),
                )
            } else {
                match &parsed {
                    // batch：逐条分发，通知不计入响应；全是通知 → 204
                    Value::Array(batch) => {
                        let resps: Vec<Value> = batch
                            .iter()
                            .filter_map(|r| dispatch(r, app, state))
                            .collect();
                        if resps.is_empty() {
                            (204, Vec::new())
                        } else {
                            (200, to_bytes(Value::Array(resps)))
                        }
                    }
                    single => match dispatch(single, app, state) {
                        Some(r) => (200, to_bytes(r)),
                        None => (204, Vec::new()),
                    },
                }
            }
        }
        _ => (404, to_bytes(json!({ "error": "not found" }))),
    };

    write_raw(stream, status, &body);
}

/// 写 HTTP 响应。
///
/// **不带 CORS 头**：与 fpx::mcp 同判据（P1-8）—— 浏览器同源策略管的是
/// 「读响应」，放行跨域等于允许任意网页读走 MCP 返回内容，配合弱令牌
/// 就是完整的本机数据外泄。客户端（AI 工具）不走浏览器，不需要它。
fn write_raw(stream: &mut TcpStream, status: u16, body: &[u8]) {
    let status_text = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut out = Vec::with_capacity(head.len() + body.len());
    out.extend_from_slice(head.as_bytes());
    out.extend_from_slice(body);
    let _ = stream.write_all(&out);
    let _ = stream.flush();
}

/// 启动网关。返回实际监听地址。
///
/// `port` 传 Some 时覆盖配置里的端口（并持久化）—— 设置页改端口走这条。
/// 令牌为空则自动生成并落盘：**重启不能变**，变了所有客户端当场全断，
/// 而用户只会看到「连不上」，无从归因。
pub fn start(app: &AppHandle, state: &GatewayState, port: Option<u16>) -> Result<String, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("网关已在运行".into());
    }

    let mut cfg = load_config(app);
    if let Some(p) = port {
        if p != 0 {
            cfg.port = p;
        }
    }
    if cfg.token.trim().is_empty() {
        cfg.token = fpx::safety::random_token();
    }
    if let Err(e) = save_config(app, &cfg) {
        state.running.store(false, Ordering::SeqCst);
        return Err(format!("保存网关配置失败: {e}"));
    }
    if let Ok(mut g) = state.cfg.lock() {
        *g = cfg.clone();
    }

    let listener = match TcpListener::bind(("127.0.0.1", cfg.port)) {
        Ok(l) => l,
        Err(e) => {
            state.running.store(false, Ordering::SeqCst);
            return Err(format!("绑定端口 {} 失败（可能已被占用）: {e}", cfg.port));
        }
    };
    if let Err(e) = listener.set_nonblocking(true) {
        state.running.store(false, Ordering::SeqCst);
        return Err(format!("设置非阻塞失败: {e}"));
    }
    let addr = match listener.local_addr() {
        Ok(a) => a.to_string(),
        Err(e) => {
            state.running.store(false, Ordering::SeqCst);
            return Err(e.to_string());
        }
    };
    if let Ok(mut a) = state.addr.lock() {
        *a = Some(addr.clone());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let wake = Arc::new((Mutex::new(false), Condvar::new()));
    if let Ok(mut g) = state.stop.lock() {
        *g = Some((stop.clone(), wake.clone()));
    }

    let token = cfg.token.clone();
    let app_c = app.clone();
    thread::spawn(move || {
        let live = Arc::new(AtomicUsize::new(0));
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    // 监听句柄是非阻塞的，连接要显式转回阻塞，否则读直接 WouldBlock
                    let _ = stream.set_nonblocking(false);
                    if live.load(Ordering::SeqCst) >= MAX_CONNS {
                        continue;
                    }
                    live.fetch_add(1, Ordering::SeqCst);
                    let live_c = live.clone();
                    let app_t = app_c.clone();
                    let token_t = token.clone();
                    thread::spawn(move || {
                        let mut s = stream;
                        let st = app_t.state::<GatewayState>();
                        handle(&mut s, &app_t, &st, &token_t);
                        live_c.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // 条件变量代替 sleep：stop 能立刻唤醒，无需等满一拍
                    let (lock, cv) = &*wake;
                    match lock.lock() {
                        Ok(g) => {
                            let _ = cv.wait_timeout(g, Duration::from_millis(100));
                        }
                        Err(_) => thread::sleep(Duration::from_millis(100)),
                    }
                }
                Err(_) => break,
            }
        }
        // 线程退出：清理运行态（addr 置空，界面立刻反映「已停止」）
        if let Some(st) = app_c.try_state::<GatewayState>() {
            st.running.store(false, Ordering::SeqCst);
            if let Ok(mut a) = st.addr.lock() {
                *a = None;
            }
        }
    });

    Ok(addr)
}

/// 停止网关。返回**真的停了吗**（不等满一拍，最多等 300ms）。
///
/// 为什么等：置标志后线程最多再睡 100ms 才退出、才释放端口。
/// 不等就返回的话，界面显示「已停止」而端口还占着，用户再点启动
/// 直接撞「端口已被占用」—— 而报错指不到「其实没停干净」。
pub fn stop(state: &GatewayState) -> bool {
    let handle = match state.stop.lock() {
        Ok(mut g) => g.take(),
        Err(e) => e.into_inner().take(),
    };
    let Some((flag, wake)) = handle else {
        return false; // 本来就没在跑
    };
    flag.store(true, Ordering::SeqCst);
    {
        let (lock, cv) = &*wake;
        if let Ok(mut f) = lock.lock() {
            *f = true;
        }
        cv.notify_all();
    }
    for _ in 0..30 {
        if !state.running.load(Ordering::SeqCst) {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    !state.running.load(Ordering::SeqCst)
}

/* ================================================================== */
/* Tauri 命令（前端设置面板用）                                          */
/* ================================================================== */

/// 启动（可带端口覆盖）。返回实际监听地址。
#[tauri::command(rename_all = "snake_case")]
pub fn mcp_gw_start(
    app: AppHandle,
    state: State<'_, GatewayState>,
    port: Option<u16>,
) -> Result<String, String> {
    start(&app, &state, port)
}

/// 停止。返回 false = 没停干净（端口可能仍在监听）。
#[tauri::command(rename_all = "snake_case")]
pub fn mcp_gw_stop(state: State<'_, GatewayState>) -> bool {
    stop(&state)
}

/// 状态：运行态 + 配置 + 按 server 分组的工具清单（界面渲染用）。
#[tauri::command(rename_all = "snake_case")]
pub fn mcp_gw_status(state: State<'_, GatewayState>) -> Value {
    let cfg = match state.cfg.lock() {
        Ok(g) => g.clone(),
        Err(e) => e.into_inner().clone(),
    };
    let addr = match state.addr.lock() {
        Ok(g) => g.clone(),
        Err(e) => e.into_inner().clone(),
    };
    let guard = match state.tools.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };

    // 按 server 分组（保持注册顺序：先来在前）
    let mut order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, (String, String, Vec<String>)> = HashMap::new();
    for t in guard.iter() {
        let (kind, url) = match &t.kind {
            ToolKind::Native => ("native".to_string(), String::new()),
            ToolKind::Proxy { url, .. } => ("proxy".to_string(), url.clone()),
        };
        let entry = grouped
            .entry(t.server.clone())
            .or_insert_with(|| {
                order.push(t.server.clone());
                (kind.clone(), url.clone(), Vec::new())
            });
        entry.2.push(t.full_name());
    }
    let servers: Vec<Value> = order
        .iter()
        .map(|s| {
            let (kind, url, tools) = &grouped[s];
            json!({ "name": s, "kind": kind, "url": url, "tools": tools })
        })
        .collect();

    json!({
        "running": state.is_running(),
        "addr": addr,
        "port": cfg.port,
        "token": cfg.token,
        "autoStart": cfg.auto_start,
        "servers": servers,
        "toolCount": guard.len(),
    })
}

/// 保存配置（端口 / 令牌 / 自动启动）。
///
/// 运行中改端口或令牌**不热生效**（监听和鉴权用的是启动时那一份）——
/// 返回 needRestart 让界面说明白，而不是"保存了但没变化"。
#[tauri::command(rename_all = "snake_case")]
pub fn mcp_gw_save_config(
    app: AppHandle,
    state: State<'_, GatewayState>,
    port: u16,
    token: String,
    auto_start: bool,
) -> Result<Value, String> {
    if !(1024..=65535).contains(&port) {
        return Err("端口需在 1024–65535 之间".into());
    }
    let old = match state.cfg.lock() {
        Ok(g) => g.clone(),
        Err(e) => e.into_inner().clone(),
    };
    let cfg = GwConfig {
        port,
        token: token.trim().to_string(),
        auto_start,
    };
    save_config(&app, &cfg)?;
    if let Ok(mut g) = state.cfg.lock() {
        *g = cfg;
    }
    let running = state.is_running();
    let need_restart = running && (port != old.port || old.token != token.trim());
    Ok(json!({ "saved": true, "needRestart": need_restart }))
}

/// 注册代理服务（拉取对方 tools/list 后登记）。返回登记到的工具数。
#[tauri::command(rename_all = "snake_case")]
pub fn mcp_gw_register(
    state: State<'_, GatewayState>,
    server: String,
    url: String,
    token: String,
) -> Result<Value, String> {
    let n = register_proxy(&state, &server, &url, &token)?;
    Ok(json!({ "server": server.trim(), "tools": n }))
}

/// 移除代理服务。返回移除的工具数。内置服务不可移除。
#[tauri::command(rename_all = "snake_case")]
pub fn mcp_gw_unregister(state: State<'_, GatewayState>, server: String) -> Result<Value, String> {
    let n = unregister_server(&state, &server)?;
    Ok(json!({ "server": server.trim(), "removed": n }))
}

/* ================================================================== */
/* 单测                                                                */
/* ================================================================== */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state_with(tools: Vec<GatewayTool>) -> GatewayState {
        let st = GatewayState::new();
        {
            let mut g = st.tools.lock().unwrap();
            *g = tools;
        }
        st
    }

    fn native_tool(server: &str, name: &str) -> GatewayTool {
        GatewayTool {
            server: server.into(),
            name: name.into(),
            description: "测试工具".into(),
            input_schema: json!({ "type": "object", "properties": {} }),
            kind: ToolKind::Native,
            handler: Some(Arc::new(|args: &Value| {
                Ok(json!({ "content": [{ "type": "text", "text": args.to_string() }] }))
            })),
        }
    }

    fn rpc(method: &str, id: Value, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    /* ---------- 命名 ---------- */

    #[test]
    fn full_name_uses_double_underscore() {
        let t = native_tool("task-board", "tb_list_tasks");
        assert_eq!(t.full_name(), "task-board__tb_list_tasks");
    }

    #[test]
    fn split_takes_first_separator() {
        // 对端工具名自己含 __ 时不能切错（server 名禁止含 __，第一个之前的一定是 server）
        assert_eq!(split_full("x__a__b"), Some(("x", "a__b")));
        assert_eq!(split_full("task-board__tb_get_task"), Some(("task-board", "tb_get_task")));
        assert_eq!(split_full("no_prefix"), None);
    }

    #[test]
    fn decl_marks_server_in_description() {
        let t = native_tool("task-board", "tb_list_tasks");
        let d = t.decl();
        assert_eq!(d["name"], "task-board__tb_list_tasks");
        assert_eq!(d["description"], "[task-board] 测试工具");
    }

    #[test]
    fn server_name_validation() {
        assert!(validate_server_name("task-board").is_ok());
        assert!(validate_server_name("xmind2").is_ok());
        assert!(validate_server_name("").is_err());
        assert!(validate_server_name("Task-Board").is_err()); // 大写
        assert!(validate_server_name("a b").is_err()); // 空格
        assert!(validate_server_name("a__b").is_err()); // 分隔符
        assert!(validate_server_name("project-group").is_ok()); // 名字合法，占用检查在 register_proxy
        assert!(validate_server_name(&"x".repeat(33)).is_err());
    }

    /* ---------- 分发 ---------- */

    // dispatch 需要 AppHandle（fpx 配置查询）—— 单测里造不出真 AppHandle，
    // 所以只测**不碰 app 的分支**：initialize / ping / 未知方法 / 通知 /
    // tools/call 的报错路径。tools/list 的 app 依赖由源码接线测试守。
    // 这里用一个不可能拿到的 app 指针是不行的，改用直接测 call_tool。

    #[test]
    fn call_routes_by_prefix() {
        let st = state_with(vec![native_tool("task-board", "tb_list_tasks")]);
        let r = call_tool("task-board__tb_list_tasks", &json!({"q": "x"}), &st).unwrap();
        assert_eq!(r["content"][0]["text"], r#"{"q":"x"}"#);
    }

    #[test]
    fn call_without_prefix_is_rejected_with_hint() {
        let st = state_with(vec![native_tool("task-board", "tb_list_tasks")]);
        let e = call_tool("tb_list_tasks", &json!({}), &st).unwrap_err();
        assert!(e.contains("不带 server 前缀"), "应提示前缀规则：{e}");
        assert!(e.contains("tools/list"), "应指路 tools/list：{e}");
    }

    #[test]
    fn call_unknown_tool_is_rejected_with_hint() {
        let st = state_with(vec![native_tool("task-board", "tb_list_tasks")]);
        let e = call_tool("task-board__nope", &json!({}), &st).unwrap_err();
        assert!(e.contains("没有工具"), "应说明没有该工具：{e}");
    }

    #[test]
    fn call_unknown_server_is_rejected() {
        let st = state_with(vec![native_tool("task-board", "tb_list_tasks")]);
        let e = call_tool("other__tb_list_tasks", &json!({}), &st).unwrap_err();
        assert!(e.contains("没有工具"), "server 不存在也是没有工具：{e}");
    }

    #[test]
    fn handler_error_becomes_message() {
        let st = GatewayState::new();
        register_native(
            &st,
            "s",
            "boom",
            "会失败的工具",
            json!({}),
            Arc::new(|_| Err("业务失败了".into())),
        );
        let e = call_tool("s__boom", &json!({}), &st).unwrap_err();
        assert_eq!(e, "业务失败了");
    }

    /* ---------- 注册 ---------- */

    #[test]
    fn register_native_replaces_same_name() {
        let st = GatewayState::new();
        register_native(&st, "s", "t", "第一版", json!({}), Arc::new(|_| Ok(json!({"v": 1}))));
        register_native(&st, "s", "t", "第二版", json!({}), Arc::new(|_| Ok(json!({"v": 2}))));
        let g = st.tools.lock().unwrap();
        assert_eq!(g.len(), 1, "同名重注册应覆盖而不是追加");
        assert_eq!(g[0].description, "第二版");
        let r = g[0].invoke(&json!({})).unwrap();
        assert_eq!(r["v"], 2, "覆盖后应调新 handler");
    }

    #[test]
    fn unregister_refuses_builtin_servers() {
        let st = state_with(vec![native_tool(SERVER_FPX, "list_projects")]);
        assert!(unregister_server(&st, SERVER_FPX).is_err());
        assert!(unregister_server(&st, SERVER_TB).is_err());
        // 内置工具还在
        assert_eq!(st.tools.lock().unwrap().len(), 1);
    }

    #[test]
    fn unregister_removes_only_that_server() {
        let st = state_with(vec![
            native_tool("a", "t1"),
            native_tool("a", "t2"),
            native_tool("b", "t1"),
        ]);
        let n = unregister_server(&st, "a").unwrap();
        assert_eq!(n, 2);
        let g = st.tools.lock().unwrap();
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].server, "b");
    }

    #[test]
    fn unregister_unknown_server_errors() {
        let st = state_with(vec![native_tool("a", "t1")]);
        assert!(unregister_server(&st, "zzz").is_err());
    }

    /* ---------- 鉴权 ---------- */

    #[test]
    fn auth_accepts_bearer_and_x_token() {
        let mut h = HashMap::new();
        h.insert("authorization".into(), "Bearer tk".into());
        assert!(check_auth(&h, "tk"));
        let mut h2 = HashMap::new();
        h2.insert("x-token".into(), "tk".into());
        assert!(check_auth(&h2, "tk"));
        // 大小写不敏感
        let mut h3 = HashMap::new();
        h3.insert("Authorization".into(), "bearer tk".into());
        assert!(check_auth(&h3, "tk"));
    }

    #[test]
    fn auth_rejects_wrong_and_missing() {
        let mut h = HashMap::new();
        h.insert("authorization".into(), "Bearer wrong".into());
        assert!(!check_auth(&h, "tk"));
        assert!(!check_auth(&HashMap::new(), "tk"));
        assert!(!check_auth(&HashMap::new(), ""), "期望令牌为空时一律不通过");
    }

    /* ---------- 配置 ---------- */

    #[test]
    fn default_config_autostarts() {
        let cfg = GwConfig::default();
        assert_eq!(cfg.port, DEFAULT_PORT);
        assert!(cfg.auto_start, "默认自动启动：功能目的就是免手动开启");
        assert!(cfg.token.is_empty(), "令牌首次启动才生成");
    }
}
