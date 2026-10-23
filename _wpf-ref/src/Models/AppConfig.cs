using System.Text.Json.Serialization;

namespace FenPeiXiangMuZu.Models;

/// <summary>项目页签（config.projectTabs），容器字段名固定为 projects。</summary>
public sealed class ProjectTab
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "默认";

    [JsonPropertyName("projects")]
    public List<string> Projects { get; set; } = new();
}

/// <summary>项目组页签（config.groupTabs），容器字段名固定为 groups（与 projectTabs 的 projects 不同，勿混）。</summary>
public sealed class GroupTab
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "默认";

    [JsonPropertyName("groups")]
    public List<string> Groups { get; set; } = new();
}

/// <summary>预设图标分组（config.iconGroups），每个分组包含名称和组内图标显示名列表。</summary>
public sealed class IconGroup
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "默认";

    [JsonPropertyName("icons")]
    public List<string> Icons { get; set; } = new();
}

/// <summary>folderLock.items 一条：受 ACL 保护的路径及其强度（Services/FolderLockService 消费）。</summary>
public sealed class FolderLockItem
{
    /// <summary>受保护的文件夹完整路径（JSON 字段名 path；属性名避开 System.IO.Path 遮蔽）。</summary>
    [JsonPropertyName("path")]
    public string TargetPath { get; set; } = "";

    /// <summary>防删除档：Deny Everyone Delete 子树递归（重命名随之被拦）。</summary>
    [JsonPropertyName("denyDelete")]
    public bool DenyDelete { get; set; }

    /// <summary>防写入档：Deny Everyone 全部写入（目录变只读）。</summary>
    [JsonPropertyName("denyWrite")]
    public bool DenyWrite { get; set; }
}

/// <summary>ACL 文件夹保护配置（config.folderLock）。账面固定仍复用顶层 locked 列表。</summary>
public sealed class FolderLockConfig
{
    /// <summary>监控告警开关：FileSystemWatcher 监听受保护路径的外部改动并写日志。</summary>
    [JsonPropertyName("watchAlerts")]
    public bool WatchAlerts { get; set; } = true;

    /// <summary>受保护路径清单（路径粒度登记，项目组/项目通用）。</summary>
    [JsonPropertyName("items")]
    public List<FolderLockItem> Items { get; set; } = new();
}

/// <summary>Agent 连锁单动作配置（config.agentChain.<动作>）：按对象类型区分预填模板 + 确认弹窗记忆。</summary>
public sealed class AgentChainAction
{
    /// <summary>选中「项目」卡片时发送的指令模板；null/空白 = 使用内置默认。</summary>
    [JsonPropertyName("project")]
    public string? Project { get; set; }

    /// <summary>选中「项目组」卡片时发送的指令模板；null/空白 = 使用内置默认。</summary>
    [JsonPropertyName("group")]
    public string? Group { get; set; }

    /// <summary>确认弹窗「本次客户端期间不再提示」的会话级记忆（不入盘，仅运行时借用该字段传递）。</summary>
    [JsonIgnore]
    public bool SkipConfirmSession { get; set; }
}

/// <summary>Agent 连锁总配置（config.agentChain）。四个动作各自维护项目/项目组两份指令模板。</summary>
public sealed class AgentChainConfig
{
    /// <summary>agent 连锁：自由任务（原 opencode 任务）。</summary>
    [JsonPropertyName("chain")]
    public AgentChainAction Chain { get; set; } = new();

    /// <summary>一键审查：全面代码审查任务。</summary>
    [JsonPropertyName("review")]
    public AgentChainAction Review { get; set; } = new();

    /// <summary>快速归并：冗余内容归并整理任务。</summary>
    [JsonPropertyName("merge")]
    public AgentChainAction Merge { get; set; } = new();

    /// <summary>快速部署：构建与发布验证任务。</summary>
    [JsonPropertyName("deploy")]
    public AgentChainAction Deploy { get; set; } = new();
}

/// <summary>
/// Agent 连锁动作项（config.chainActions 有序列表）：内置三项（审查/归并/部署）与用户自定义动作的统一载体。
/// 侧栏与卡片右键菜单按 ShowSidebar/ShowContextMenu 动态渲染；列表顺序即展示顺序（内置固定在前）。
/// </summary>
public sealed class ChainActionItem : System.ComponentModel.INotifyPropertyChanged
{
    private string _name = "";

    /// <summary>唯一标识：内置为 review/merge/deploy；自定义为 c+8 位随机串。</summary>
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary>显示名（设置页页签 / 侧栏按钮 / 右键菜单共用；可变更需通知）。</summary>
    [JsonPropertyName("name")]
    public string Name { get => _name; set { if (_name == value) return; _name = value; RaisePropertyChanged(); } }

    /// <summary>内置动作标识（=Id）；空串 = 自定义动作。</summary>
    [JsonPropertyName("builtin")]
    public string Builtin { get; set; } = "";

    private string _icon = "\uE99A";

    /// <summary>侧栏/页签图标字符（Segoe MDL2 字形；可变更需通知刷新）。</summary>
    [JsonPropertyName("icon")]
    public string Icon { get => _icon; set { if (_icon == value) return; _icon = value; RaisePropertyChanged(); } }

    private string _shortcut = "";

    /// <summary>自定义快捷键（规范串，如 Ctrl+Shift+R）；空 = 未设置。变更需通知（页签提示与快捷键面板）。</summary>
    [JsonPropertyName("shortcut")]
    public string Shortcut
    {
        get => _shortcut;
        set
        {
            if (_shortcut == value) return;
            _shortcut = value;
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(ShortcutDisplay));
        }
    }

    /// <summary>页签提示用键位显示串（未设置时空串）。</summary>
    public string ShortcutDisplay => string.IsNullOrEmpty(Shortcut) ? "" : Services.ShortcutGesture.Display(Shortcut);

    /// <summary>是否加入侧边栏动态按钮区。</summary>
    [JsonPropertyName("showSidebar")]
    public bool ShowSidebar { get; set; } = true;

    /// <summary>是否加入卡片右键菜单。</summary>
    [JsonPropertyName("showContextMenu")]
    public bool ShowContextMenu { get; set; } = true;

    /// <summary>项目模板；null/空白 = 使用内置默认（自定义动作空白 = 发送前提示补写）。</summary>
    [JsonPropertyName("project")]
    public string? Project { get; set; }

    /// <summary>项目组模板；语义同 Project。</summary>
    [JsonPropertyName("group")]
    public string? Group { get; set; }

    /// <summary>本动作专属发送客户端 Id（opencode/trae/trae-cn/cursor/vscode）；null/空 = 跟随全局默认。</summary>
    [JsonPropertyName("client")]
    public string? Client { get; set; }

    public event System.ComponentModel.PropertyChangedEventHandler? PropertyChanged;

    private void RaisePropertyChanged([System.Runtime.CompilerServices.CallerMemberName] string? propertyName = null) =>
        PropertyChanged?.Invoke(this, new System.ComponentModel.PropertyChangedEventArgs(propertyName));
}

/// <summary>editorPickCache 一条：程序显示名 + exe + 图标位置（路径+索引，加载时重建 ImageSource）。</summary>
public sealed class EditorPickCacheItem
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("exe")]
    public string Exe { get; set; } = "";

    [JsonPropertyName("iconPath")]
    public string IconPath { get; set; } = "";

    [JsonPropertyName("iconIndex")]
    public int IconIndex { get; set; }
}

/// <summary>强类型 config，对应 分配项目组-config.json。与原 PS 版数据格式完全兼容。</summary>
public sealed class AppConfig
{
    [JsonPropertyName("autoSelect")]
    public bool AutoSelect { get; set; } = true;

    [JsonPropertyName("quickLink")]
    public bool QuickLink { get; set; } = false;

    [JsonPropertyName("aiAgentCmd")]
    public string? AiAgentCmd { get; set; } = "";

    [JsonPropertyName("lastLib")]
    public string? LastLib { get; set; }

    [JsonPropertyName("projectTabs")]
    public List<ProjectTab> ProjectTabs { get; set; } = new();

    [JsonPropertyName("groupTabs")]
    public List<GroupTab> GroupTabs { get; set; } = new();

    /// <summary>顶层冗余快照：当前活动项目页签的项目列表（读入时若 projectTabs 缺失可迁移为"默认"页签）。</summary>
    [JsonPropertyName("projects")]
    public List<string>? LegacyProjects { get; set; }

    /// <summary>顶层冗余快照：当前活动项目组页签的项目组列表。</summary>
    [JsonPropertyName("groups")]
    public List<string>? LegacyGroups { get; set; }

    /// <summary>锁定（即使不存在也不清除）的文件夹路径列表。</summary>
    [JsonPropertyName("locked")]
    public List<string> Locked { get; set; } = new();

    /// <summary>MCP 工具开关：工具名 → 是否暴露给 AI 客户端（缺失视为开启，兼容旧配置）。</summary>
    [JsonPropertyName("mcpTools")]
    public Dictionary<string, bool> McpTools { get; set; } = new();

    /// <summary>MCP 服务功能总开关：是否将本工具作为 MCP server 暴露给 AI 客户端（默认开启，兼容旧配置）。</summary>
    [JsonPropertyName("mcpEnabled")]
    public bool McpEnabled { get; set; } = true;

    /// <summary>Agent 链接名开关：各家 agent 的项目目录名 → 是否在创建链接时生成对应 junction。缺失视为开启（默认全开，兼容旧配置）。</summary>
    [JsonPropertyName("linkAgents")]
    public Dictionary<string, bool> LinkAgents { get; set; } = new();

    /// <summary>用户自定义 agent 链接名列表（预设名单之外手动添加；开关状态仍存 linkAgents，缺失视为开启）。</summary>
    [JsonPropertyName("customLinkAgents")]
    public List<string> CustomLinkAgents { get; set; } = new();

    /// <summary>置顶的 agent 链接名列表（排序时置顶项在前，按此列表顺序；预设与自定义均可置顶）。</summary>
    [JsonPropertyName("linkAgentsPinned")]
    public List<string> LinkAgentsPinned { get; set; } = new();

    /// <summary>自定义链接名备注：链接名 → 备注文本（预设/自定义均可带备注）。</summary>
    [JsonPropertyName("linkAgentRemarks")]
    public Dictionary<string, string> LinkAgentRemarks { get; set; } = new();

    /// <summary>厂商/标注覆盖：链接名 → 厂商标注（预设/自定义均可覆盖；缺失用预设默认或"自定义"）。</summary>
    [JsonPropertyName("linkAgentVendors")]
    public Dictionary<string, string> LinkAgentVendors { get; set; } = new();

    /// <summary>预设链接名重命名覆盖：预设原名 → 新名（缺失表示未改名；改名后开关/置顶/备注/厂商键随新名迁移）。</summary>
    [JsonPropertyName("linkAgentRenames")]
    public Dictionary<string, string> LinkAgentRenames { get; set; } = new();

    /// <summary>预设图标分组列表：每个分组含名称和组内图标显示名。物理文件在 数据\preseticons\&lt;名&gt;.ico。</summary>
    [JsonPropertyName("iconGroups")]
    public List<IconGroup> IconGroups { get; set; } = new();

    /// <summary>顶层冗余快照：所有分组的图标名平铺（兼容旧配置读取，读入时若 iconGroups 缺失可迁移为"默认"分组）。</summary>
    [JsonPropertyName("presetIcons")]
    public List<string> PresetIcons { get; set; } = new();

    /// <summary>快捷键自定义：动作键 → 键位字符串（如 "LockToggle" → "Ctrl+L"）；缺失用默认键位，空串表示禁用该快捷键。</summary>
    [JsonPropertyName("shortcuts")]
    public Dictionary<string, string> Shortcuts { get; set; } = new();

    /// <summary>是否在 GUI 面板按钮上显示对应快捷键提示（设置面板「基础设置」勾选；默认开启）。</summary>
    [JsonPropertyName("showShortcuts")]
    public bool ShowShortcuts { get; set; } = true;

    /// <summary>侧边栏名称浮层展示形式：true=勾选「展开侧边栏常驻」，切换按钮控制浮层常驻显隐；false（默认）=鼠标悬停侧边栏图标时临时浮出。图标条本身始终窄宽不变。</summary>
    [JsonPropertyName("sidebarPersistent")]
    public bool SidebarPersistent { get; set; }

    /// <summary>修改图标是否同步生效到资源管理器（写 desktop.ini）。false = 仅本工具 GUI 显示自定义图标；默认开启保持传统行为。</summary>
    [JsonPropertyName("iconAffectExplorer")]
    public bool IconAffectExplorer { get; set; } = true;

    /// <summary>软件自身自定义图标路径（数据目录\appicon\custom-app.ico）；空 = 使用内置默认图标。</summary>
    [JsonPropertyName("customAppIcon")]
    public string? CustomAppIcon { get; set; }

    /// <summary>
    /// 仅 GUI 生效的自定义图标映射：文件夹完整路径 → 图标引用。
    /// 引用格式："图标文件路径"（.ico/png 等副本）或 "DLL路径|索引"（系统图标）。
    /// 仅在 iconAffectExplorer=false 时写入；GUI 解析时优先级高于 desktop.ini。
    /// </summary>
    [JsonPropertyName("guiFolderIcons")]
    public Dictionary<string, string> GuiFolderIcons { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// 仅 GUI 生效的卡片标签自定义颜色映射：文件夹完整路径 → 颜色（#RRGGBB）。
    /// 键与 GuiFolderIcons 同策略（规范化完整路径）；缺失表示该标签用默认外观。
    /// </summary>
    [JsonPropertyName("tagColors")]
    public Dictionary<string, string> TagColors { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>用户在色盘中保存的自定义常用色列表（#RRGGBB），显示在预设色之后。</summary>
    [JsonPropertyName("customColors")]
    public List<string> CustomColors { get; set; } = new();

    /// <summary>ACL 文件夹保护（Services/FolderLockService + AclLockDialog）；null 视为全默认。</summary>
    [JsonPropertyName("folderLock")]
    public FolderLockConfig? FolderLock { get; set; }

    /// <summary>插件（plugins）状态：插件 id → 安装状态记录。插件的物理文件位于数据目录\plugins\。</summary>
    [JsonPropertyName("plugins")]
    public Dictionary<string, PluginStatus>? Plugins { get; set; }

    /// <summary>
    /// 本工具写 desktop.ini 图标时给这些文件夹加过 +s(System) 属性（完整路径）。
    /// 恢复默认图标时仅对此列表内的路径执行 -s，避免误清文件夹原有的 System 属性（共享目录等场景）。
    /// </summary>
    [JsonPropertyName("systemAttribByTool")]
    public List<string> SystemAttribByTool { get; set; } = new();

    // ---- 预览区「打开编辑」（AgentSkillService.OpenWithEditor 消费）----

    /// <summary>预览区「打开编辑」使用的编辑器程序完整路径；空/空白 = 跟随系统默认关联程序打开。</summary>
    [JsonPropertyName("editToolPath")]
    public string? EditToolPath { get; set; } = "";

    // ---- 一键备份（Services/BackupService；GUI 与 MCP 共用）----

    /// <summary>项目备份目标目录（完整路径）；null/空白 = exe 所在目录\backkup_项目备份。</summary>
    [JsonPropertyName("backupProjectDir")]
    public string? BackupProjectDir { get; set; }

    /// <summary>项目组备份目标目录（完整路径）；null/空白 = exe 所在目录\backkup_项目组备份。</summary>
    [JsonPropertyName("backupGroupDir")]
    public string? BackupGroupDir { get; set; }

    /// <summary>只增模式：true=仅新增与更新（源中已删除的文件在备份中保留）；false=镜像同步（默认）。</summary>
    [JsonPropertyName("backupAppendOnly")]
    public bool BackupAppendOnly { get; set; } = false;

    /// <summary>自动备份间隔（分钟）；0=关闭（默认）。预设：15/30/60/120/360/720/1440。</summary>
    [JsonPropertyName("backupAutoMinutes")]
    public int BackupAutoMinutes { get; set; } = 0;

    // ---- 脑图滚动备份（MindMapPanel 每分钟判定 + MindMapBackupStore 消费）----

    /// <summary>脑图自动备份间隔（分钟）；0=关闭。默认 1（每分钟）。</summary>
    [JsonPropertyName("mindMapBackupMinutes")]
    public int MindMapBackupMinutes { get; set; } = 1;

    /// <summary>同一份脑图最多保留的备份份数；默认 3。</summary>
    [JsonPropertyName("mindMapBackupMax")]
    public int MindMapBackupMax { get; set; } = 3;

    /// <summary>脑图备份目录（完整路径）；null/空白 = 数据目录\mindmap-backups。</summary>
    [JsonPropertyName("mindMapBackupDir")]
    public string? MindMapBackupDir { get; set; }

    /// <summary>脑图打开画布/展开收起分支时的布局过渡动画：true=保留 300ms 节点扩散动画；false（默认）=直接显示最终布局无过渡。</summary>
    [JsonPropertyName("mindMapLayoutAnimation")]
    public bool MindMapLayoutAnimation { get; set; } = false;

    // ---- 新建项目/项目组（设置面板「创建预设」+ 主窗口新建按钮）----

    /// <summary>新建项目时的预设父目录（完整路径）；空 = 每次弹文件夹选择框。</summary>
    [JsonPropertyName("createProjectDir")]
    public string? CreateProjectDir { get; set; }

    /// <summary>新建项目组时的预设父目录（完整路径）；空 = 每次弹文件夹选择框。</summary>
    [JsonPropertyName("createGroupDir")]
    public string? CreateGroupDir { get; set; }

    /// <summary>新建项目组时拷贝的模板文件夹（完整路径）；空 = 使用内置默认模板（MainViewModel.DefaultGroupTemplateDir）。</summary>
    [JsonPropertyName("createGroupTemplateDir")]
    public string? CreateGroupTemplateDir { get; set; }

    /// <summary>新建项目/项目组时，路径是否携带当前活动页签/集群层级：true = 父目录\页签名\名称（项目组同理用集群名）。</summary>
    [JsonPropertyName("createPathCarriesHierarchy")]
    public bool CreatePathCarriesHierarchy { get; set; } = false;

    // ---- opencode 任务（侧边栏按钮经深链接新建会话）----

    /// <summary>「opencode 任务」预填到会话输入框的指令模板；支持 {路径} / {文件夹名} 占位符；null/空白 = 使用默认模板。已被 agentChain.chain 取代，仅作旧配置兼容读取。</summary>
    [JsonPropertyName("opencodePromptTemplate")]
    public string? OpencodePromptTemplate { get; set; }

    /// <summary>Agent 连锁总配置（四个动作的项目/项目组模板与确认弹窗记忆）；null 视为全默认。已被 chainActions 取代，仅作旧配置迁移读取。</summary>
    [JsonPropertyName("agentChain")]
    public AgentChainConfig? AgentChain { get; set; }

    /// <summary>
    /// Agent 连锁动作有序清单（config.chainActions）：内置三项 + 用户自定义动作；
    /// null = 尚未迁移（首次使用时由 agentChain / opencodePromptTemplate 旧字段生成，见 MainViewModel.EnsureChainActions）。
    /// </summary>
    [JsonPropertyName("chainActions")]
    public List<ChainActionItem>? ChainActions { get; set; }

    /// <summary>连锁发送的全局默认桌面客户端 Id（opencode/trae/trae-cn/cursor/vscode）；null/未知 = 回退 opencode。单个动作可用自带的 Client 覆盖。</summary>
    [JsonPropertyName("defaultChainClient")]
    public string? DefaultChainClient { get; set; }

    /// <summary>用户手动添加的连锁客户端（不在自动检测目录内，强制显示；发送时按其 exe/scheme 打开并复制指令粘贴）。</summary>
    [JsonPropertyName("customChainClients")]
    public List<CustomChainClientConfig>? CustomChainClients { get; set; }

    /// <summary>开发者模式：开启后设置页允许删除/重命名内置连锁页签。</summary>
    [JsonPropertyName("devMode")]
    public bool DevMode { get; set; }

    /// <summary>「打开编辑」最近一次搜索结果缓存（启动免搜索直接展示；搜索按钮=手动刷新）。图标按路径+索引延迟重建。</summary>
    [JsonPropertyName("editorPickCache")]
    public List<EditorPickCacheItem>? EditorPickCache { get; set; }

    /// <summary>全屏/最大化时是否隐藏 Windows 任务栏（true = 铺满全屏盖住任务栏；false = 仅在工作区内最大化、任务栏可见）。默认保留现状 = 真。</summary>
    [JsonPropertyName("hideTaskbarInFullscreen")]
    public bool HideTaskbarInFullscreen { get; set; } = true;

    /// <summary>点标题栏关闭按钮/Alt+F4 时默认隐藏到托盘而非退出（true = 最小化到托盘；false = 直接退出）。默认关。</summary>
    [JsonPropertyName("hideToTrayOnClose")]
    public bool HideToTrayOnClose { get; set; } = false;

    /// <summary>退出 GUI 时是否同时关闭 MCP 后台进程（设置面板「基础设置」勾选；默认关）。</summary>
    [JsonPropertyName("closeMcpOnExit")]
    public bool CloseMcpOnExit { get; set; } = false;

    /// <summary>跨类别移动卡片（项目⇄项目组）时是否同步物理搬家文件夹（默认开启；设置面板「基础设置」勾选）。</summary>
    [JsonPropertyName("moveFolderOnCrossMove")]
    public bool MoveFolderOnCrossMove { get; set; } = true;

    /// <summary>跨类别移动时的物理搬家范围（配合 MoveFolderOnCrossMove）：
    /// "defaultRoots"=仅默认根目录（项目/项目组根）下的卡片才搬、已在目标根内嵌套的保持原位；
    /// "defaultRootsFlatten"=默认根下的卡片才搬，位于默认根内的嵌套层级路径也扁平化搬到目标根；
    /// "anywhere"=任意位置的卡片都搬（嵌套在目标根内的也扁平化）。</summary>
    [JsonPropertyName("moveFolderScope")]
    public string MoveFolderScope { get; set; } = "defaultRootsFlatten";

    // ---- 窗口/面板布局（下次打开恢复）----

    /// <summary>上次关闭时的窗口宽度（像素）。</summary>
    [JsonPropertyName("windowWidth")]
    public double? WindowWidth { get; set; }

    /// <summary>上次关闭时的窗口高度（像素）。</summary>
    [JsonPropertyName("windowHeight")]
    public double? WindowHeight { get; set; }

    /// <summary>四栏宽度比例（star 值，如 [20,20,46,38]），依次为 项目/项目组/AgentSkill/记录。</summary>
    [JsonPropertyName("panelColWidths")]
    public List<double>? PanelColWidths { get; set; }

    /// <summary>底部日志/预览区高度（像素）。</summary>
    [JsonPropertyName("logRowHeight")]
    public double? LogRowHeight { get; set; }

    /// <summary>设置面板高度（用户拖动底边调整，像素；与预览窗口高度无关）。</summary>
    [JsonPropertyName("settingsPanelHeight")]
    public double? SettingsPanelHeight { get; set; }

    /// <summary>MCP 面板高度（用户拖动底边调整，像素；与预览窗口高度无关）。</summary>
    [JsonPropertyName("mcpPanelHeight")]
    public double? McpPanelHeight { get; set; }

    /// <summary>使用说明面板高度（用户拖动底边调整，像素；与预览窗口高度无关）。</summary>
    [JsonPropertyName("tipsPanelHeight")]
    public double? TipsPanelHeight { get; set; }

    // ---- 运行时状态（不入 JSON）----
    [JsonIgnore]
    public int ActiveProjectTabIndex { get; set; } = 0;

    [JsonIgnore]
    public int ActiveGroupTabIndex { get; set; } = 0;
}

/// <summary>用户手动添加的连锁桌面客户端（绕过自动检测，强制出现在客户端列表）。</summary>
public sealed class CustomChainClientConfig
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary>客户端显示名（建议取应用名）。</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    /// <summary>可执行文件路径：发送时优先用它打开客户端（为空则尝试 Scheme）。</summary>
    [JsonPropertyName("exe")]
    public string? Exe { get; set; }

    /// <summary>URL scheme（可选）：exe 不可用时用它唤起客户端。</summary>
    [JsonPropertyName("scheme")]
    public string? Scheme { get; set; }
}

/// <summary>插件安装状态（config.plugins["<id>"]）。物理文件位于数据目录\plugins\，离线包 zip 保留可随时重装。</summary>
public sealed class PluginStatus
{
    /// <summary>插件显示名（如「思维导图」）。</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    /// <summary>是否已安装（界面入口随此显隐）。</summary>
    [JsonPropertyName("installed")]
    public bool Installed { get; set; }

    /// <summary>入口文件相对路径（相对插件根目录，如 index.html）。</summary>
    [JsonPropertyName("entry")]
    public string Entry { get; set; } = "index.html";
}