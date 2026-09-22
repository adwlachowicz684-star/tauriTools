//! 项目组分配插件 · 数据模型
//! ------------------------------------------------------------------
//! 字段命名与 junction_link（C# 版）的 分配项目组-config.json / link-record.json
//! 保持一致（camelCase），将来想共用同一份数据时无需转换。

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// 一个页签：名称 + 卡片路径列表。
/// 项目页签字段叫 projects、项目组页签叫 groups（原版如此），这里统一用 items，
/// 序列化时按 kind 还原成原字段名由 store 层处理（本插件独立存储，直接用 items 即可）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TabItem {
    pub name: String,
    #[serde(default)]
    pub items: Vec<String>,
}

/// ACL 保护项：路径 + 两个档位。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LockItem {
    pub path: String,
    #[serde(default)]
    pub deny_delete: bool,
    #[serde(default)]
    pub deny_write: bool,
    /*
     * 「账面固定」（#21）：只是**登记在案**，不落任何系统权限。
     *
     * 与 ACL 是两件事：ACL 是真的拦住删除/写入，账面固定只是标记
     * "这个目录别乱动"。它存在的意义是给用户一个**轻量**的选择 ——
     * 不动系统权限（不会把自己锁死、也不需要管理员权限），
     * 但界面上能看出哪些是"定下来的"。
     *
     * 两者可以同时存在（既固定又上 ACL），互不排斥。
     */
    #[serde(default)]
    pub account_only: bool,
}

/// 文件夹图标引用：路径 → "图标文件路径" 或 "DLL路径|索引"。
pub type IconMap = HashMap<String, String>;

/// config.json 的 schema 版本。
///
/// **为什么要有它**：此前全靠 `#[serde(default)]` 兼容旧配置，
/// 那只解决了"新字段缺失"，解决不了"旧字段被悄悄丢掉" ——
/// 字段改名或废弃后，JSON 里那个旧键还在，而新结构没有对应字段，
/// serde 默认忽略未知键，于是用户的数据**静默消失**（清单 #454 记过
/// 一次 clusters 就这么丢的，查了好久才发现）。
///
/// 有了版本号，就能知道"这份配置是哪个版本写的"，从而：
///   · 逐级跑迁移函数，把旧键搬到新字段
///   · 发现"我不认识的键"时提示，而不是当没看见
///
/// 缺失 = 1（这个字段本身是新加的，老配置里没有它）。
pub const CURRENT_SCHEMA: u32 = 2;

/// 插件独立配置（对应 data-dir/config.json）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FpxConfig {
    /// schema 版本；老配置里没有这个键，反序列化时按 1 处理。
    /// 加载路径会把它升到 `CURRENT_SCHEMA` 并写回。
    #[serde(default = "default_schema")]
    pub schema_version: u32,
    /// 项目页签。
    #[serde(default)]
    pub project_tabs: Vec<TabItem>,
    /// 项目组页签。
    #[serde(default)]
    pub group_tabs: Vec<TabItem>,
    /// agent 链接名开关：目录名 → 是否启用（缺失视为开启）。
    #[serde(default)]
    pub link_agents: HashMap<String, bool>,
    /// 用户自定义的 agent 链接名。
    #[serde(default)]
    pub custom_link_agents: Vec<String>,
    /// 链接名备注。
    #[serde(default)]
    pub link_agent_remarks: HashMap<String, String>,
    /// 链接名厂商标注覆盖。
    #[serde(default)]
    pub link_agent_vendors: HashMap<String, String>,
    /// 预设链接名重命名：预设原名 → 新名。改名后实际创建的链接目录名随之改变，
    /// 开关 / 备注 / 厂商 的键也以新名为准（与原 C# 版 LinkAgentCatalog 语义一致）。
    #[serde(default)]
    pub link_agent_renames: HashMap<String, String>,
    /// 置顶的链接名列表（链接名面板里排在最前，按此列表顺序；预设与自定义均可置顶）。
    #[serde(default)]
    pub link_agents_pinned: Vec<String>,
    /// 卡片标签颜色：路径 → #RRGGBB。
    #[serde(default)]
    pub tag_colors: HashMap<String, String>,
    /// #113 界面专属标签色：路径 → 颜色。
    ///
    /// 与 `tag_colors` 两套、互不覆盖。界面上**优先显示这一套**，
    /// 它是原版 GuiFolderColors 的语义：界面里用一套配色，
    /// 但不影响以颜色为语义的其它用途（比如把颜色当分类标记传给外部脚本）。
    #[serde(default)]
    pub tag_gui_colors: HashMap<String, String>,
    /// 用户在色盘里保存的自定义常用色（#RRGGBB，最多 24 个）。
    #[serde(default)]
    pub custom_colors: Vec<String>,
    /// 文件夹图标（**会同步到资源管理器**的那套）：路径 → 图标引用。
    #[serde(default)]
    pub folder_icons: IconMap,
    /// #13 界面专属图标：路径 → 图标引用。
    ///
    /// 与 `folder_icons` 是**两套、互不覆盖**：
    ///   · `folder_icons` 写进 desktop.ini，资源管理器里看得见
    ///   · `folder_gui_icons` 只在界面内生效，**从不碰 desktop.ini**
    ///
    /// 界面上**优先显示这一套**（原版 SetGuiOnlyIconFile 的语义）：
    /// 想在界面里用一套好看的图标、又不想动资源管理器的显示时用它。
    #[serde(default)]
    pub folder_gui_icons: IconMap,
    /// ACL 保护清单。
    #[serde(default)]
    pub locks: Vec<LockItem>,
    /// 新建项目时的预设父目录。
    #[serde(default)]
    pub create_project_dir: Option<String>,
    /// 新建项目组时的预设父目录。
    #[serde(default)]
    pub create_group_dir: Option<String>,
    /// 新建项目组时拷贝的模板目录。
    #[serde(default)]
    pub create_group_template_dir: Option<String>,
    /// 跨类别移动卡片（项目⇄项目组）时是否同步物理搬家文件夹。
    #[serde(default = "default_true")]
    pub move_folder_on_cross_move: bool,
    /// 跨类别移动时的物理搬家范围：
    /// "defaultRoots"=仅在默认根目录下的卡片才搬、已在目标根内的保持原位；
    /// "defaultRootsFlatten"=默认根下的卡片才搬，嵌套层级也扁平化搬到目标根；
    /// "anywhere"=任意位置的卡片都搬。
    #[serde(default = "default_move_scope")]
    pub move_folder_scope: String,
    /// 用户手动添加的连锁客户端（不在自动检测范围内，强制显示）。
    #[serde(default)]
    pub custom_chain_clients: Vec<CustomChainClient>,
    /// 「打开编辑」候选程序缓存（免每次重新全盘搜索）。
    #[serde(default)]
    pub editor_pick_cache: Vec<EditorPickCacheItem>,
    /// 项目备份目标目录；空 = 回退 backupDir，再空则数据目录 backup/。
    #[serde(default)]
    pub backup_project_dir: Option<String>,
    /// 项目组备份目标目录；空 = 回退 backupDir，再空则数据目录 backup/。
    #[serde(default)]
    pub backup_group_dir: Option<String>,
    /// 预览区「打开编辑」使用的编辑器路径。
    #[serde(default)]
    pub edit_tool_path: Option<String>,
    /// 图标是否写进资源管理器（desktop.ini）；false = 仅本插件界面显示。
    #[serde(default = "default_true")]
    pub icon_affect_explorer: bool,
    /// 分配后自动选中被分配的卡片。
    #[serde(default = "default_true")]
    pub auto_select: bool,
    /// 快速链接：跨栏拖放卡片时直接建链，不再弹确认。
    /// 关闭则要再点一次确认按钮才建。
    #[serde(default)]
    pub quick_link: bool,
    /// 新建项目 / 项目组时，路径是否携带当前活动页签层级：
    /// true = 父目录\页签名\名称。
    #[serde(default)]
    pub create_path_carries_hierarchy: bool,
    /// 备份根目录（留空回退到数据目录 backup/）。项目 / 项目组各建一个子目录。
    #[serde(default)]
    pub backup_dir: Option<String>,
    /// true = 只新增/更新（源里删了的在备份中保留）；false = 镜像同步。
    #[serde(default = "default_true")]
    pub backup_append_only: bool,
    /// 自动备份间隔（分钟）；0 = 关闭。
    /// 预设档位 1/2/5/10/15/30/60/120/360/720/1440（#93 补齐了短档位）。
    /// **后端不校验取值** —— 手改 config.json 存别的值也能跑，
    /// 前端 select 要把这种值显示出来，否则界面显示空白。
    #[serde(default)]
    pub backup_auto_minutes: u32,
    /// MCP 服务总开关：false 时即使已启动也拒绝请求。
    #[serde(default = "default_true")]
    pub mcp_enabled: bool,
    /// 退出软件时一并关闭 MCP 后台进程（原版 `closeMcpOnExit`）。
    /// 进程启停本身是外壳行为，这里只存配置，由外壳读取后决定。
    #[serde(default)]
    pub close_mcp_on_exit: bool,
    /// MCP 工具开关：工具名 → 是否暴露（缺失视为开启，兼容旧配置）。
    #[serde(default)]
    pub mcp_tools: HashMap<String, bool>,
    /// MCP 服务的访问令牌。空 / 缺失 = 首次启动时自动生成并落盘。
    ///
    /// HTTP 模式强制校验（`Authorization: Bearer <token>` 或 `X-Token`）；
    /// stdio 模式由拉起方注入，不校验。
    /// 生成后**不再变**：改了令牌，AI 客户端里配好的那条就失效了，
    /// 而用户只会看到"连不上"，无从下手。
    #[serde(default)]
    pub mcp_token: Option<String>,
    /// Agent 连锁默认客户端 id（opencode / cursor / vscode / trae …）。
    #[serde(default)]
    pub chain_client: Option<String>,
    /// 连锁指令模板；{path} 替换为对象完整路径，{name} 替换为文件夹名。
    /// 旧字段：仅在 chainActions 尚未迁移时用于初始化「自由任务」动作。
    #[serde(default)]
    pub chain_prompt: Option<String>,
    /// 连锁动作有序清单。null = 尚未迁移，首次读取时由内置默认值生成
    /// （并把旧的 chainPrompt 填进「自由任务」动作，避免老配置丢失）。
    #[serde(default)]
    pub chain_actions: Option<Vec<ChainActionItem>>,
    /// 受保护目录被外部改动时是否提醒（文件夹监听）。
    #[serde(default)]
    pub watch_enabled: bool,
    /// 监听轮询间隔（秒，最小 5）。
    #[serde(default = "default_watch_interval")]
    pub watch_interval_secs: u64,
    /// 日志区最多保留多少条（#32）。
    ///
    /// 同时决定「界面显示」与「复制全部能拿到多少」——两者合一，
    /// 显示多少就是能复制多少，语义自洽。早先是"存 200、显示 40"，
    /// 多存的那 160 条既显示不出来也复制不到（日志是内存态，重启即失），
    /// 属于无效占用。
    ///
    /// 范围在设置界面与 `store` 侧双重夹取（见 LOG_MAX_LINES_MIN / MAX），
    /// 这里只给默认值；手改 config.json 写出界也会被夹回合法区间。
    #[serde(default = "default_log_max_lines")]
    pub log_max_lines: u32,
    /// 三栏宽度比例（star 值，依次 项目 / 项目组 / 内容浏览）。
    ///
    /// null = 用默认。写盘前已在前端夹取，这里再夹一次是为了挡住
    /// "手改 config.json" 的情形（与 log_max_lines 同理）。
    #[serde(default)]
    pub col_stars: Option<Vec<f64>>,
    /// 日志区高度（px）。null = 用默认。
    #[serde(default)]
    pub log_row_height: Option<u32>,
    /// 设置浮层高度（px）。null = 自适应内容高度。
    #[serde(default)]
    pub settings_panel_height: Option<u32>,
    /// MCP 服务浮层高度（px）。null = 自适应。
    #[serde(default)]
    pub mcp_panel_height: Option<u32>,
    /// 使用说明浮层高度（px）。null = 自适应。
    #[serde(default)]
    pub tips_panel_height: Option<u32>,
    /// 在按钮上显示快捷键提示（#50）。默认开。
    ///
    /// 关掉它的理由是"按钮变挤"，所以默认开着 —— 原版也是默认开：
    /// 快捷键看不见就等于不存在，用户根本不会去按。
    #[serde(default = "default_show_shortcuts")]
    pub show_shortcuts: bool,
    /// 开发者模式（#46）。
    ///
    /// 开启后允许删除内置连锁动作 —— 那四个是常用入口，
    /// 而 `ensure_actions` 只在清单为空时才重建，删错了用户会以为软件坏了。
    /// 这道闸门的意义是"我知道我在做什么"。
    #[serde(default)]
    pub dev_mode: bool,
    /// 预设图标（内置名，前端兜底展示用）。
    #[serde(default)]
    pub preset_icons: Vec<String>,
    /// 图标分组：每组一个名字 + 组内图标显示名列表。
    /// 内置图标的物理文件随插件发布，用户导入的落在数据目录 icons/；
    /// 分组只记录"名字归到哪一组"，名字本身在两个来源里都能解析。
    #[serde(default)]
    pub icon_groups: Vec<IconGroup>,
    /// 常规快捷键的自定义覆盖（动作 id → combo 字符串，如 `"open": "mod+o"`）。
    ///
    /// 只存**改过的**项，没改过的走内置默认值 —— 这样将来调整默认键位时，
    /// 老用户的自定义项不会被悄悄重置，未改的却能跟着更新。
    /// `None` 与空表等价，都表示「全部用默认」。
    #[serde(default)]
    pub hotkeys: Option<HashMap<String, String>>,
}

/// 一个图标分组。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IconGroup {
    pub name: String,
    #[serde(default)]
    pub icons: Vec<String>,
}

fn default_true() -> bool { true }

/// 老配置没有 schemaVersion 键 → 视为 1。
fn default_schema() -> u32 {
    1
}
fn default_watch_interval() -> u64 { 30 }
fn default_move_scope() -> String { "defaultRootsFlatten".to_string() }

/* ---------------- 日志条数（#32）----------------
 * 数值与前端 utils/log.ts 一一对应，log-test.mjs 会比对两边。
 */

/// 日志保留条数的合法区间。
///
/// 下限 10：再少就失去"流水"的意义，出错时看不到前因。
/// 上限 2000：日志每条都带时间戳字符串，且界面一次全渲染，
/// 上万条会明显拖慢渲染；2000 足够回溯，也是 render 能承受的量级。
pub const LOG_MAX_LINES_MIN: u32 = 10;
pub const LOG_MAX_LINES_MAX: u32 = 2000;
pub const LOG_MAX_LINES_DEFAULT: u32 = 40;

fn default_log_max_lines() -> u32 { LOG_MAX_LINES_DEFAULT }

fn default_show_shortcuts() -> bool { true }

/// 把任意输入夹回合法区间（含非数字配置、越界手改）。
pub fn clamp_log_max_lines(v: u32) -> u32 {
    v.clamp(LOG_MAX_LINES_MIN, LOG_MAX_LINES_MAX)
}

/* ---------------- 布局记忆（#54 #55 #56 #193）----------------
 * 数值与前端 utils/layout.ts 一一对应，layout-test.mjs 会比对两边。
 * 改任一侧都要同步另一侧。
 */

/// 三栏 star 默认/下限/上限
pub const COL_STAR_MIN: f64 = 0.4;
pub const COL_STAR_MAX: f64 = 4.0;
pub const COL_STARS_DEFAULT: [f64; 3] = [1.0, 1.0, 1.4];

/// 日志区高度（px）
pub const LOG_HEIGHT_MIN: u32 = 60;
pub const LOG_HEIGHT_MAX: u32 = 600;
pub const LOG_HEIGHT_DEFAULT: u32 = 132;

/// 浮层面板高度（px）：设置 / MCP / 使用说明三个共用同一范围
pub const PANEL_HEIGHT_MIN: u32 = 200;
pub const PANEL_HEIGHT_MAX: u32 = 2000;

/// 星值归一化：数量不对就整体回默认（栏数是布局结构的一部分，
/// 补零会造出"某一栏消失"），逐项夹取。
pub fn normalize_col_stars(v: Option<Vec<f64>>) -> Option<Vec<f64>> {
    let arr = v?;
    if arr.len() != COL_STARS_DEFAULT.len() {
        return None; // None = 用默认
    }
    Some(
        arr.into_iter()
            .map(|x| if x.is_finite() { x.clamp(COL_STAR_MIN, COL_STAR_MAX) } else { COL_STAR_MIN })
            .collect(),
    )
}

/// 高度夹取；None 表示"未设置"，原样保留（界面走自适应）。
pub fn clamp_px(v: Option<u32>, lo: u32, hi: u32) -> Option<u32> {
    v.map(|x| x.clamp(lo, hi))
}

impl Default for FpxConfig {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA,
            project_tabs: vec![TabItem { name: "默认".into(), items: vec![] }],
            group_tabs: vec![TabItem { name: "默认".into(), items: vec![] }],
            link_agents: HashMap::new(),
            custom_link_agents: vec![],
            link_agent_remarks: HashMap::new(),
            link_agent_vendors: HashMap::new(),
            link_agent_renames: HashMap::new(),
            link_agents_pinned: vec![],
            tag_colors: HashMap::new(),
            tag_gui_colors: HashMap::new(),
            custom_colors: Vec::new(),
            folder_icons: HashMap::new(),
            folder_gui_icons: HashMap::new(),
            locks: vec![],
            create_project_dir: None,
            create_group_dir: None,
            create_group_template_dir: None,
            move_folder_on_cross_move: true,
            move_folder_scope: default_move_scope(),
            custom_chain_clients: vec![],
            editor_pick_cache: vec![],
            backup_project_dir: None,
            backup_group_dir: None,
            edit_tool_path: None,
            icon_affect_explorer: true,
            auto_select: true,
            quick_link: false,
            create_path_carries_hierarchy: false,
            preset_icons: vec![],
            icon_groups: vec![],
            hotkeys: None,
            backup_dir: None,
            backup_append_only: true,
            backup_auto_minutes: 0,
            mcp_enabled: true,
            close_mcp_on_exit: false,
            mcp_tools: HashMap::new(),
            mcp_token: None,
            chain_client: None,
            chain_prompt: None,
            chain_actions: None,
            watch_enabled: false,
            watch_interval_secs: 30,
            log_max_lines: LOG_MAX_LINES_DEFAULT,
            // 布局三项一律 None = 用前端默认；写了具体值反而会
            // 把"改过默认"这件事冻结在首次保存那一刻
            col_stars: None,
            log_row_height: None,
            settings_panel_height: None,
            mcp_panel_height: None,
            tips_panel_height: None,
            dev_mode: false,
            show_shortcuts: default_show_shortcuts(),
        }
    }
}

/// 一个 Agent 连锁动作（config.chainActions 有序列表）。
/// 内置四项（自由任务/审查/归并/部署）与用户自定义动作同表存储，列表顺序即展示顺序。
///
/// 与 C# 版的差异（有意为之，非遗漏）：
///   - `shortcut` 是**应用级**快捷键（窗口前台时生效），不是操作系统全局热键；
///     后者需要额外的 Tauri 插件与依赖，这里选择零依赖方案；
///   - `icon` 用 emoji 而非 Segoe MDL2 字形——后者在 macOS/Linux 上是豆腐块。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainActionItem {
    /// 唯一标识：内置为 chain/review/merge/deploy；自定义为 c+8 位随机串。
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// 内置动作标识（= id）；空串 = 自定义动作。
    #[serde(default)]
    pub builtin: String,
    /// 显示图标（emoji）。
    #[serde(default)]
    pub icon: String,
    /// 是否加入卡片右键菜单。
    #[serde(default = "default_true")]
    pub show_context_menu: bool,
    /// 是否挂到外壳侧边栏（由插件注入，卸载时自动移除）。
    #[serde(default)]
    pub show_sidebar: bool,
    /// 应用级快捷键，形如 "Ctrl+Shift+1"；空 = 不注册。
    #[serde(default)]
    pub shortcut: Option<String>,
    /// 项目模板；null/空白 = 使用内置默认（自定义动作空白 = 发送前提示补写）。
    #[serde(default)]
    pub project: Option<String>,
    /// 项目组模板；语义同 project。
    #[serde(default)]
    pub group: Option<String>,
    /// 本动作专属发送客户端 id；null/空 = 跟随全局默认。
    #[serde(default)]
    pub client: Option<String>,
}

/// 跨类别移动的结果：新快照 + 物理搬家后的路径（未搬家为 null，供前端提示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveAcrossResult {
    pub snapshot: Snapshot,
    pub relocated: Option<String>,
}

/// 文件夹改名 / 搬家的结果：新快照 + 新路径 + 同步改动的登记数量（供前端提示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub snapshot: Snapshot,
    pub new_path: String,
    /// 受影响的项目/项目组页签登记条数
    pub tab_hits: usize,
    /// 受影响的链接记录条数
    pub rec_hits: usize,
    /// 重建成功的链接数（项目组改名 / 搬家才有；项目改名恒为 0）
    pub relinked: usize,
    /// 重建失败的项目清单（路径：原因）。非空说明有链接需要手动复查。
    ///
    /// 刻意不因重建失败而回滚整个搬家——目录已经挪过去了，
    /// 回滚反而可能二次破坏；把失败明细交回前端提示用户更诚实。
    pub relink_errors: Vec<String>,
    /// 备份目录同步改名的提示（空串=无对应备份目录或未发生改名）。
    ///
    /// 让用户知道"备份里那份也跟着改名了"——否则他在备份目录里
    /// 看到两个名字会以为是自己操作错了。
    pub backup_note: String,
}

/// 清除无效项的结果：新快照 + 被移除的路径清单 + 各类计数。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult {
    pub snapshot: Snapshot,
    /// 被移除的无效路径（前端可展示给用户复核）
    pub removed: Vec<String>,
    /// 从页签里摘掉的条数
    pub tab_hits: usize,
    /// 清理掉的失效链接记录条数
    pub rec_hits: usize,
}

/// 用户手动添加的连锁客户端（不在自动检测目录内，强制出现在客户端列表）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomChainClient {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// 可执行文件路径：发送时优先用它打开客户端。
    #[serde(default)]
    pub exe: Option<String>,
    /// URL scheme：exe 不可用/未填时用它唤起。
    #[serde(default)]
    pub scheme: Option<String>,
}

/// 编辑器候选缓存一条（仅存名称与 exe；图标位置不落盘，显示时用统一的占位符）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorPickCacheItem {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub exe: String,
}

/// MCP 工具清单里的一行（设置面板逐个开关用）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolRow {
    pub name: String,
    pub desc: String,
    /// 缺失视为开启，这里把默认值算好再发给前端，避免前端重复实现
    pub enabled: bool,
}

/// 一条链接记录（对应 link-record.json 的 links 元素）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRecord {
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub lib: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub names: Vec<String>,
}

impl LinkRecord {
    /// 旧数据（names 缺失）回退为单个默认名 .opencode。
    pub fn link_names(&self) -> Vec<String> {
        if self.names.is_empty() {
            vec![".opencode".to_string()]
        } else {
            self.names.clone()
        }
    }
}

/* ---------------------------- 出参 DTO ---------------------------- */

/// 一张卡片（项目 / 项目组文件夹）的运行时状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardInfo {
    pub path: String,
    pub name: String,
    pub exists: bool,
    pub has_link: bool,
    pub has_broken: bool,
    pub has_conflict: bool,
    pub link_count: usize,
    pub linked_group: Option<String>,
    pub locked: bool,
    pub deny_delete: bool,
    pub deny_write: bool,
    /// 「账面固定」（#21）：仅登记在案，无系统权限。
    #[serde(default)]
    pub account_fixed: bool,
    /// 资源管理器那套图标（会写进 desktop.ini）
    pub icon: Option<String>,
    /// #13 界面专属图标。**界面上优先显示这一套**，为空则回退到 `icon`。
    #[serde(default)]
    pub gui_icon: Option<String>,
    pub tag_color: Option<String>,
    /// tag_color 是否为继承自所链接项目组的颜色（界面上淡化显示，避免误以为改过）。
    #[serde(default)]
    pub tag_color_inherited: bool,
    /// 逐条链接明细（界面上"展开链接"时用）。
    ///
    /// 只凭 `link_count` 用户只知道"连了 N 条"，不知道连的是谁、哪条坏了。
    /// 每条给出**链接名**与它的状态；同一链接名指向多个项目组时会展开成多行。
    #[serde(default)]
    pub link_details: Vec<LinkDetail>,
}

/// 一条链接的明细。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkDetail {
    /// 链接名（如 `.opencode`、`agents`）
    pub name: String,
    /// 指向的项目组名字（可能为空：记录缺失时）
    pub group_name: String,
    /// 指向的项目组路径
    pub group: String,
    /// valid / broken / conflict
    pub state: String,
    /// 建立时间（记录里没有则空串）
    pub created: String,
    /*
     * 逐行**真实**指向（对齐原版 `ScanProjectCard` 里的 row 级反查）。
     *
     * 一个项目可以有多条链接，每条**指向不同的组**（用户手工建了
     * 多个 junction 就会出现）。此前整卡共用一个 group，于是
     * 界面上某些行显示的组名是**错的**，而它看起来完全正常 ——
     * #82「点链接名编辑那一条」拿到的 group 也就跟着错，
     * 改的仍然是另一条。这类"改了不该改的地方"没有报错。
     *
     * 这里按**磁盘实际**反查逐名目标，与账本不一致时以磁盘为准：
     * 用户看到的应该是"现在到底连到哪"，而不是"当初登记到哪"。
     */
    pub real_group_name: String,
    pub real_group: String,
    /// 项目文件夹本身是否还在
    pub project_exists: bool,
    /// 这一行指向的项目组文件夹是否还在
    pub group_exists: bool,
    /// 逐行提示（区分"项目不存在/项目组不存在/冲突/破坏"）
    pub tip: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub name: String,
    pub items: Vec<CardInfo>,
}

/// 链接记录展示行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRow {
    pub project: String,
    pub group: String,
    pub group_name: String,
    pub created: String,
    pub names: Vec<String>,
    pub state: String, // valid | broken | conflict | partial
}

/// 图标改名结果（#10）。
///
/// `affected` 是**同步了多少张卡片的引用** —— 必须回报给前端。
/// 它不为 0 说明这次改名连带改了别人的配置，
/// 用户应当知道"有 N 张卡片的图标跟着更新了"，而不是静默完成。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameIconResult {
    /// 改名后的图标路径（绝对路径）
    pub path: String,
    /// 同步更新的卡片图标引用数
    pub affected: usize,
    /// 改名后的图标文件列表（省一次往返）
    pub icons: Vec<String>,
    /// 最新快照
    pub snapshot: Snapshot,
}

/// 一次操作后的状态快照：配置 + 两侧页签 + 链接表。
///
/// 放在 model.rs 而不是命令层：它和 Bootstrap / LinkRow / TabInfo 同为发给前端的 DTO。
/// 原先定义在 mod.rs，导致 model.rs 里引用它的三个 Result 类型拿不到这个名（E0425）——
/// 让数据模型去依赖命令层是反的，所以挪过来。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub config: FpxConfig,
    pub project_tabs: Vec<TabInfo>,
    pub group_tabs: Vec<TabInfo>,
    pub links: Vec<LinkRow>,
}

/// 前端启动所需的一次性数据。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub data_dir: String,
    pub platform: String,
    /// config.json 的体检结果：未知键、迁移记录等（见 `config_issues`）。
    /// 空 = 一切正常。由前端在启动时提示一次。
    #[serde(default)]
    pub config_notices: Vec<String>,
    pub config: FpxConfig,
    pub project_tabs: Vec<TabInfo>,
    pub group_tabs: Vec<TabInfo>,
    pub links: Vec<LinkRow>,
    pub preset_agents: Vec<PresetAgent>,
    /// 全部链接名（预设显示名 + 自定义），已按置顶排序；前端按此顺序渲染。
    pub all_names: Vec<String>,
}

/// 预设 agent 链接名（与 junction_link 的 LinkAgentCatalog 对齐）。
/// original 是预设的固有键（.opencode 等），name 是应用改名后的显示名；
/// 前端改名时要把 renames 的键写成 original，否则后端 display_name 查不到。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetAgent {
    pub name: String,
    pub original: String,
    pub vendor: String,
}

/// agent / skill / rule 条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentItem {
    /// agent | skill | rule
    pub kind: String,
    /// 显示名（去扩展名）
    pub name: String,
    /// 相对源目录的路径（反斜杠分隔；Windows 风格，与原版一致）
    pub rel_path: String,
    /// 绝对路径（可能是目录：目录型 skill）
    pub path: String,
    pub is_dir: bool,
}

/// 内容区（agent / skill / rule）条目改名的结果。
///
/// 内容条目不进配置（不在页签 / 链接记录里留痕），所以这里没有快照，
/// 前端拿到 new_path 后重新扫一遍目录即可。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentRenameResult {
    /// 改名后的绝对路径
    pub new_path: String,
}

/// 目录选择器用的一条目录项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryLite {
    pub name: String,
    pub path: String,
    pub has_child: bool,
}
