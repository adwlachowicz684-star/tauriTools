using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Linq;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.Services;
using FenPeiXiangMuZu.Views;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>
/// 一张项目组/项目卡片的状态数据（UI 数据流，对应 PS 版 New-FolderCard 返回的 Tag + Update-CardStyle 的数据部分）。
/// 只承载数据与通知，绘制交给 UI 层绑定（选中高亮/置灰/链接标记据此决策）。
/// </summary>
public sealed class FolderCardViewModel : ViewModelBase
{
    private bool _isSelected;
    private bool _isLocked;
    private bool _isAclProtected;
    private bool _exists = true;
    private bool _hasLink;
    private bool _hasBroken;
    private bool _hasConflict;
    private string _linkedGroup = "";
    private string _linkedGroupPath = "";
    private ImageSource? _linkedGroupIcon;
    private string? _linkTip;
    private ImageSource? _icon;
    private int _linkCount;
    private bool _isExpanded = true;

    public FolderCardViewModel(string kind, string fullPath, ImageSource? icon)
    {
        Kind = kind;
        FullPath = fullPath;
        Icon = icon;
        DisplayName = System.IO.Path.GetFileName(fullPath.TrimEnd('\\'));
    }

    /// <summary>卡片类别：'group' 或 'project'。</summary>
    public string Kind { get; }

    /// <summary>完整路径（命名 FullPath 避免遮蔽 System.IO.Path）。</summary>
    public string FullPath { get; }

    /// <summary>显示名（路径末级）。</summary>
    public string DisplayName { get; }

    public ImageSource? Icon { get => _icon; set => Set(ref _icon, value); }

    public bool IsSelected { get => _isSelected; set => Set(ref _isSelected, value); }

    public bool IsLocked { get => _isLocked; set => Set(ref _isLocked, value); }

    private string? _aclTip;

    /// <summary>是否受 ACL 保护（config.folderLock 登记；实际 ACE 由启动自愈保证一致）。</summary>
    public bool IsAclProtected { get => _isAclProtected; set { if (Set(ref _isAclProtected, value)) Raise(nameof(IsAclProtected)); } }

    /// <summary>ACL 保护悬浮提示（如「ACL 已保护 · 防删除」；未保护为 null）。</summary>
    public string? AclTip { get => _aclTip; set => Set(ref _aclTip, value); }

    /// <summary>路径是否真实存在（目录）。</summary>
    public bool Exists { get => _exists; set { if (Set(ref _exists, value)) Raise(nameof(IsGrayed)); } }

    /// <summary>置灰：路径不存在（文件夹丢失提示，与锁定无关；锁定仅表示删除时保留该项目）。</summary>
    public bool IsGrayed => !Exists;

    /// <summary>是否有有效链接标记（项目：.opencode 正常；项目组：有项目链接到它）。</summary>
    public bool HasLink { get => _hasLink; set { if (Set(ref _hasLink, value)) Raise(nameof(HasAnyLink)); } }

    /// <summary>链接被破坏/冲突（记录存在但 .opencode 失效）→ 显示破坏图标。</summary>
    public bool HasBroken { get => _hasBroken; set { if (Set(ref _hasBroken, value)) Raise(nameof(HasAnyLink)); } }

    /// <summary>链接冲突（链接名被普通目录/文件占用）→ 橙黄色高亮（区别于失效的红色）。</summary>
    public bool HasConflict { get => _hasConflict; set => Set(ref _hasConflict, value); }

    /// <summary>是否处于任意链接状态（有效或破坏）——用于右侧项目组名是否显示。</summary>
    public bool HasAnyLink => _hasLink || _hasBroken;

    /// <summary>实时显示的链接项目组名（无链接时为空）。</summary>
    public string LinkedGroup { get => _linkedGroup; set => Set(ref _linkedGroup, value); }

    /// <summary>链接的项目组完整路径（供点击小按钮跳转定位）。</summary>
    public string LinkedGroupPath { get => _linkedGroupPath; set => Set(ref _linkedGroupPath, value); }

    /// <summary>链接的项目组图标（右侧小按钮显示）。</summary>
    public ImageSource? LinkedGroupIcon { get => _linkedGroupIcon; set => Set(ref _linkedGroupIcon, value); }

    /// <summary>链接悬浮提示文本。</summary>
    public string? LinkTip { get => _linkTip; set => Set(ref _linkTip, value); }

    /// <summary>已连接项目组的链接总数（用于项目标签右侧小蓝点旁的计数）。</summary>
    public int LinkCount { get => _linkCount; set => Set(ref _linkCount, value); }

    /// <summary>是否展开显示链接的项目组信息（项目标签上的展开/折叠按钮两态）。</summary>
    public bool IsExpanded { get => _isExpanded; set => Set(ref _isExpanded, value); }

    private string? _tagColor;

    /// <summary>卡片标签自定义颜色（#RRGGBB；null=默认外观）。变更时同步派生各状态画刷。</summary>
    public string? TagColor
    {
        get => _tagColor;
        set
        {
            if (!Set(ref _tagColor, value)) return;
            _tagBrush = ToBrush(value);
            _tagBrushHover = DeriveBrush(value, c => Lighten(c, 0.14));
            _tagBrushPress = DeriveBrush(value, c => Darken(c, 0.16));
            _tagText = TextBrushFor(value);
            Raise(nameof(TagBrush));
            Raise(nameof(TagBrushHover));
            Raise(nameof(TagBrushPress));
            Raise(nameof(TagTextBrush));
            Raise(nameof(HasTagColor));
        }
    }

    private Brush? _tagBrush;
    private Brush? _tagBrushHover;
    private Brush? _tagBrushPress;
    private Brush? _tagText;

    /// <summary>标签背景画刷（由 TagColor 派生；null 时 UI 回退默认 NeuSurface）。</summary>
    public Brush? TagBrush => _tagBrush;

    /// <summary>悬浮态背景：自定义色调亮派生（无自定义色为 null，走默认样式）。</summary>
    public Brush? TagBrushHover => _tagBrushHover;

    /// <summary>按下态背景：自定义色加深派生。</summary>
    public Brush? TagBrushPress => _tagBrushPress;

    /// <summary>自定义色背景上的自适应文字画刷（亮底配柔深字，暗底用默认主字色；无自定义色为 null）。</summary>
    public Brush? TagTextBrush => _tagText;

    /// <summary>是否设置了自定义标签色（供模板 MultiDataTrigger 判定）。</summary>
    public bool HasTagColor => _tagColor != null;

    /// <summary>#RRGGBB → 冻结的 SolidColorBrush；非法/空返回 null（UI 回退默认外观）。</summary>
    public static Brush? ToBrush(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex)) return null;
        var s = hex.Trim();
        if (s.Length != 7 || s[0] != '#' || !s[1..].All(char.IsAsciiHexDigit)) return null;
        try
        {
            var b = new SolidColorBrush((Color)ColorConverter.ConvertFromString(s));
            b.Freeze();
            return b;
        }
        catch { return null; }
    }

    /// <summary>按 hex 派生状态画刷：fn 对颜色做变换；hex 无效返回 null（该状态回退默认样式）。</summary>
    public static Brush? DeriveBrush(string? hex, Func<Color, Color> fn)
    {
        var b = ToBrush(hex);
        if (b == null) return null;
        var d = new SolidColorBrush(fn(((SolidColorBrush)b).Color));
        d.Freeze();
        return d;
    }

    /// <summary>向白色插值（悬浮提亮）。</summary>
    public static Color Lighten(Color c, double f) => Color.FromRgb(
        (byte)(c.R + (255 - c.R) * f),
        (byte)(c.G + (255 - c.G) * f),
        (byte)(c.B + (255 - c.B) * f));

    /// <summary>按比例加深（按下压暗）。</summary>
    public static Color Darken(Color c, double f) => Color.FromRgb(
        (byte)(c.R * (1 - f)),
        (byte)(c.G * (1 - f)),
        (byte)(c.B * (1 - f)));

    /// <summary>Rec.601 亮度估计：高于阈值视为亮底，需要配深色文字保证对比度。</summary>
    public static bool IsBright(Color c) =>
        (0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B) / 255.0 > 0.6;

    /// <summary>自适应文字画刷：亮底配柔深墨色，暗底用主题主字色；hex 无效返回 null。</summary>
    public static Brush? TextBrushFor(string? hex)
    {
        var b = ToBrush(hex);
        if (b == null) return null;
        return IsBright(((SolidColorBrush)b).Color) ? SoftInk() : MainBrushOrNull();
    }

    /// <summary>主题柔深墨色（与现有深色系同调，用于亮底文字；美术标准：不用纯黑纯白）。</summary>
    public static Brush SoftInk()
    {
        var b = new SolidColorBrush(Color.FromRgb(0x1F, 0x22, 0x2B));
        b.Freeze();
        return b;
    }

    public static Brush? MainBrushOrNull() =>
        Application.Current?.TryFindResource("MainBrush") as Brush;

    /// <summary>项目下的逐条链接行（每行一条链接名 → 项目组）。</summary>
    public ObservableCollection<ProjectLinkRowViewModel> LinkRows { get; } = new();
}

/// <summary>
/// 项目卡片下的一条链接行：一条链接名（如 .opencode）指向一个项目组。
/// 同名案：同一项目用多个链接名（如 .opencode / .trae）连到同一项目组时，每名一行。
/// </summary>
public sealed class ProjectLinkRowViewModel : ViewModelBase
{
    private bool _hasLink;
    private bool _hasBroken;
    private bool _hasConflict;
    private bool _projectFolderExists = true;
    private bool _groupFolderExists = true;
    private string _group = "";
    private string _groupPath = "";
    private ImageSource? _groupIcon;
    private string? _linkTip;
    private string? _groupTagHex;
    private Brush? _groupTagBrush;
    private Brush? _groupTagBrushHover;
    private Brush? _groupTagBrushPress;
    private Brush? _groupTagText;

    public string Name { get; }

    /// <summary>所属项目完整路径（供链接名重命名定位 junction）。</summary>
    public string ProjectFullPath { get; set; } = "";

    public ProjectLinkRowViewModel(string name) => Name = name;

    /// <summary>该链接名是否有效（junction 正常）。</summary>
    public bool HasLink { get => _hasLink; set { if (Set(ref _hasLink, value)) Raise(nameof(HasAnyLink)); } }

    /// <summary>该链接名是否被破坏（junction 缺失）→ 红色。</summary>
    public bool HasBroken { get => _hasBroken; set { if (Set(ref _hasBroken, value)) Raise(nameof(HasAnyLink)); } }

    /// <summary>该链接名是否冲突（被普通目录/文件占用）→ 橙黄色高亮。</summary>
    public bool HasConflict { get => _hasConflict; set => Set(ref _hasConflict, value); }

    /// <summary>所属项目文件夹是否存在（丢失时整行降灰+⚠️）。</summary>
    public bool ProjectFolderExists { get => _projectFolderExists; set => Set(ref _projectFolderExists, value); }

    /// <summary>链接目标项目组文件夹是否存在（丢失时项目组按钮降灰+⚠️）。</summary>
    public bool GroupFolderExists { get => _groupFolderExists; set => Set(ref _groupFolderExists, value); }

    /// <summary>行仅在存在链接时创建，恒为 true 以驱动通用样式常显。</summary>
    public bool HasAnyLink => _hasLink || _hasBroken;

    /// <summary>该链接名连到的项目组名。</summary>
    public string Group { get => _group; set => Set(ref _group, value); }

    /// <summary>该链接名连到的项目组完整路径（供点击跳转定位）。</summary>
    public string GroupPath { get => _groupPath; set => Set(ref _groupPath, value); }

    /// <summary>该链接名连到的项目组图标。</summary>
    public ImageSource? GroupIcon { get => _groupIcon; set => Set(ref _groupIcon, value); }

    /// <summary>该链接行悬浮提示。</summary>
    public string? LinkTip { get => _linkTip; set => Set(ref _linkTip, value); }

    /// <summary>链接的项目组标签自定义颜色（#RRGGBB；null=默认外观），由项目组改色时传播。</summary>
    public string? GroupTagColor
    {
        get => _groupTagHex;
        set
        {
            if (!Set(ref _groupTagHex, value)) return;
            _groupTagBrush = FolderCardViewModel.ToBrush(value);
            _groupTagBrushHover = FolderCardViewModel.DeriveBrush(value, c => FolderCardViewModel.Lighten(c, 0.14));
            _groupTagBrushPress = FolderCardViewModel.DeriveBrush(value, c => FolderCardViewModel.Darken(c, 0.16));
            _groupTagText = FolderCardViewModel.TextBrushFor(value);
            Raise(nameof(GroupTagBrush));
            Raise(nameof(GroupTagBrushHover));
            Raise(nameof(GroupTagBrushPress));
            Raise(nameof(GroupTagTextBrush));
            Raise(nameof(HasGroupTagColor));
        }
    }

    /// <summary>链接的项目组标签背景画刷（null 时 UI 回退默认 NeuSurface）。</summary>
    public Brush? GroupTagBrush => _groupTagBrush;

    /// <summary>悬浮态背景：项目组自定义色调亮派生。</summary>
    public Brush? GroupTagBrushHover => _groupTagBrushHover;

    /// <summary>按下态背景：项目组自定义色加深派生。</summary>
    public Brush? GroupTagBrushPress => _groupTagBrushPress;

    /// <summary>自适应文字画刷（亮底配柔深字，暗底用默认主字色）。</summary>
    public Brush? GroupTagTextBrush => _groupTagText;

    /// <summary>是否设置了链接项目组的自定义标签色（供模板 MultiDataTrigger 判定）。</summary>
    public bool HasGroupTagColor => _groupTagHex != null;
}

/// <summary>
/// 多选链接对话框的一项：链接名、厂商标注、是否固定（原置顶）、当前是否已选。
/// IsOwnedElsewhere=true 表示该名称当前已被另一个项目组占用（junction 指向它组）；仍可选择，
/// 勾选后该名称的链接将被改指向本次目标项目组（"同名改连/换绑"）。OwnedBy 为当前占用它的项目组名。
/// </summary>
public sealed record LinkPickOption(string Name, string Vendor, bool IsFixed, bool IsActive,
                                    bool IsOwnedElsewhere = false, string? OwnedBy = null);

/// <summary>一个页签容器（对应 PS 版 groupTabs/projectTabs 每项 + Rebuild-*Tabs 的标题与计数徽章）。</summary>
public sealed class TabViewModel : ViewModelBase
{
    private readonly string _name;
    private readonly string _kind = "";
    private bool _isActive;

    public TabViewModel(string name, string kind, IEnumerable<FolderCardViewModel>? cards = null)
    {
        _name = name;
        _kind = kind;
        _activateCommand = new RelayCommand(_ => Activate?.Invoke());
        if (cards != null) foreach (var c in cards) Items.Add(c);
        Items.CollectionChanged += (s, e) =>
        {
            Raise(nameof(Count));
            Raise(nameof(ProjectCount));
            Raise(nameof(GroupCount));
            Raise(nameof(CountLabel));
        };
    }

    /// <summary>页签类别："project"=项目页签，"group"=项目组集群。</summary>
    public string Kind => _kind;

    public string Name => _name;

    /// <summary>是否当前活动页签（页签高亮；由 Switch-*Tab 维护）。</summary>
    public bool IsActive { get => _isActive; set => Set(ref _isActive, value); }

    /// <summary>是否处于内联重命名编辑态（双击页签进入：显示 TextBox、隐藏名称 TextBlock）。</summary>
    private bool _isEditing;
    public bool IsEditing { get => _isEditing; set => Set(ref _isEditing, value); }

    /// <summary>项目组集群是否折叠（折叠后仅显示标题栏，隐藏内部卡片）。</summary>
    private bool _isCollapsed;
    public bool IsCollapsed { get => _isCollapsed; set => Set(ref _isCollapsed, value); }

    /// <summary>是否处于编辑列表（幽灵按钮面板）的内联重命名态（独立于页签条/分框头的 IsEditing，避免互相干扰）。</summary>
    private bool _isListEditing;
    public bool IsListEditing { get => _isListEditing; set => Set(ref _isListEditing, value); }

    /// <summary>由所属 MainViewModel 注入：点击页签时切到本页签。模板按钮绑定 ActivateCommand。</summary>
    public Action? Activate { get; set; }

    // readonly 缓存命令实例（避免 getter 每次 new），lambda 延迟读取实例的 Activate
    private readonly ICommand _activateCommand;
    public ICommand ActivateCommand => _activateCommand;

    /// <summary>当前页签下的卡片集合（原 children.Clear()/Add() 的手动刷新 → ObservableCollection 自动同步）。</summary>
    public ObservableCollection<FolderCardViewModel> Items { get; } = new();

    /// <summary>页签计数徽章：对应 PS 标题右侧 "组数/项目数"。</summary>
    public int Count => Items.Count;

    /// <summary>本页签/分框内的「项目」卡片数（Kind=="project"）。</summary>
    public int ProjectCount => Items.Count(c => c.Kind == "project");

    /// <summary>本页签/分框内的「项目组」卡片数（Kind=="group"）。</summary>
    public int GroupCount => Items.Count(c => c.Kind == "group");

    /// <summary>编辑面板「数量」列文本：项目面板只显示项目数，项目组面板只显示项目组数。</summary>
    public string CountLabel => Kind == "group" ? $"项目组 {GroupCount}" : $"项目 {ProjectCount}";
}

/// <summary>
/// 主界面 ViewModel：核心 UI 数据流，忠实复刻 PS 版——
/// 页签构建、卡片构建、单选互斥(Select-FolderCard)、页签切换清选中(Switch-*Tab)、
/// 卡片有效性/链接标记刷新(Update-AllCardsValidity/Update-CardStyle 数据部分)。
/// </summary>
public sealed partial class MainViewModel : ViewModelBase
{
    private readonly LinkRecordService _recSvc;
    private readonly ConfigService _configSvc;
    private readonly AppConfig _config;
    private readonly IconService _icons;
    private readonly string _dataDir;
    private readonly string _projectRoot;

    // 全量卡片索引（用于跨页签单选清理 / 全量有效性刷新）
    private readonly List<FolderCardViewModel> _allGroupCards = new();
    private readonly List<FolderCardViewModel> _allProjectCards = new();
    private List<Models.LinkRecord> _records = new();

    // 本地扫描结果：项目路径(归一) → (扫到的链接名集合, 首个有效 junction 目标)。
    // 用于无账本记录时也能显示磁盘上真实存在的链接（如旧版/手动建的 junction）。
    private readonly Dictionary<string, (List<string> Names, string Target)> _scannedLinks = new();

    public MainViewModel(AppConfig config, ConfigService configSvc, LinkRecordService recSvc, IconService icons, string dataDir)
    {
        _config = config;
        _configSvc = configSvc;
        _recSvc = recSvc;
        _icons = icons;
        _dataDir = dataDir;
        // 项目根 = 数据目录的上级（离线插件包位于 <项目根>\资源\<id>.ui.zip）；散放回退时以数据目录记
        _projectRoot = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(dataDir)) ?? dataDir;
        Plugins = new PluginService(dataDir, config, configSvc);

        // 构建页签 + 卡片
        for (int i = 0; i < config.ProjectTabs.Count; i++)
        {
            var tab = new TabViewModel(config.ProjectTabs[i].Name, "project",
                config.ProjectTabs[i].Projects.Select(p => MakeCard("project", p)));
            var idx = i;
            tab.Activate = () => SwitchProjectTab(idx);
            ProjectTabs.Add(tab);
            foreach (var c in tab.Items) _allProjectCards.Add(c);
        }
        for (int i = 0; i < config.GroupTabs.Count; i++)
        {
            var tab = new TabViewModel(config.GroupTabs[i].Name, "group",
                config.GroupTabs[i].Groups.Select(g => MakeCard("group", g)));
            var idx = i;
            tab.Activate = () => SwitchGroupTab(idx);
            GroupTabs.Add(tab);
            foreach (var c in tab.Items) _allGroupCards.Add(c);
        }

        ActiveProjectTabIndex = config.ActiveProjectTabIndex;
        ActiveGroupTabIndex = config.ActiveGroupTabIndex;
        SyncActiveTabs();

        _records = _recSvc.Load();
        RefreshAllValidity();

        Mcp = new McpViewModel(config, configSvc);
        LinkSettings = new LinkAgentViewModel(config, configSvc);
        PresetIcons = new PresetIconViewModel(config, configSvc, dataDir);
        Shortcuts = new ShortcutSettingsViewModel(config, configSvc);
        RebuildShortcutHints();
        Shortcuts.Changed += (_, _) => RebuildShortcutHints();
        // 构造期即初始化中列浏览区 VM，保证 Content 永不为 null（InitBrokerPanels 幂等）
        InitBrokerPanels();
        // Agent 连锁：迁移/装载统一动作清单（侧栏与右键菜单的动态数据源）
        EnsureChainActions();
        // 一键备份：按配置启动自动备份定时器（backupAutoMinutes=0 时为空操作）
        RestartAutoBackupTimer();

        // ACL 自愈：按 folderLock.items 幂等重建受保护路径 ACE（清扫残留/补齐缺失）。
        // 上次异常退出或外部拆锁后在此恢复一致性；单条失败不阻断启动，仅记日志。
        var lockCfg0 = config.FolderLock;
        if (lockCfg0 is { Items.Count: > 0 })
        {
            foreach (var e in FolderLockService.SweepRepair(
                lockCfg0.Items.Select(i => (i.TargetPath, i.DenyDelete, i.DenyWrite))))
                Log($"[ACL 自愈] {e}", true);
        }

        // 监控告警：watchAlerts 开启时对受保护路径挂 FileSystemWatcher（B 层兜底）
        _watch.Alert += OnWatchAlert;
        SyncWatchers();
    }

    private readonly FolderWatchService _watch = new();

    /// <summary>按 config 当前 watchAlerts/items 同步监控器（ACL 配置变化后调用）。</summary>
    private void SyncWatchers()
    {
        var cfg = _config.FolderLock;
        if (cfg is not { Items.Count: > 0 } || !cfg.WatchAlerts) { _watch.Sync(Enumerable.Empty<string>()); return; }
        _watch.Sync(cfg.Items.Select(i => i.TargetPath));
    }

    /// <summary>监控告警回调：线程池线程 → 封送 UI 线程写日志（删除/改名红色告警）。</summary>
    private void OnWatchAlert(FolderWatchAlert a)
    {
        var app = Application.Current;
        if (app == null) return;
        app.Dispatcher.BeginInvoke(() =>
            Log($"[监控] {Name(a.RootPath)}: {a.Detail}", a.IsDestructive));

        static string Name(string p)
        {
            try { return System.IO.Path.GetFileName(p.TrimEnd('\\')); }
            catch { return p; }
        }
    }

    /// <summary>MCP 工具开关面板的视图模型（标题栏 MCP 按钮浮层绑定）。</summary>
    public McpViewModel Mcp { get; }

    /// <summary>插件装卸服务（kityminder 思维导图等离线插件包）。</summary>
    public PluginService Plugins { get; }

    /// <summary>安装思维导图插件（离线包解压到运行期目录并登记 config）。</summary>
    public bool InstallMindMap() => Plugins.Install(PluginService.KityMinderId, _projectRoot, "思维导图");

    /// <summary>卸载思维导图插件（运行期目录回收为离线包，随时可重装）。</summary>
    public bool UninstallMindMap() => Plugins.Uninstall(PluginService.KityMinderId);

    /// <summary>Agent 链接名开关的视图模型（设置面板绑定）。</summary>
    public LinkAgentViewModel LinkSettings { get; }

    /// <summary>预设图标库的视图模型（设置面板绑定；主窗口「修改图标」弹窗据此构建选项）。</summary>
    public PresetIconViewModel PresetIcons { get; }

    /// <summary>快捷键自定义的视图模型（设置面板绑定；主窗口据此动态应用 KeyBinding）。</summary>
    public ShortcutSettingsViewModel Shortcuts { get; }

    /// <summary>按钮快捷键提示：固定动作键 → 友好显示串（仅含已设置非空的键位；侧栏/顶栏按钮绑定）。</summary>
    public IReadOnlyDictionary<string, string> ShortcutHints => _shortcutHints;

    private readonly Dictionary<string, string> _shortcutHints = new();

    /// <summary>重建按钮快捷键提示映射（启动及快捷键改动时调用；改动即通知所有按钮刷新）。</summary>
    private void RebuildShortcutHints()
    {
        _shortcutHints.Clear();
        foreach (var def in ShortcutCatalog.All)
        {
            var g = Shortcuts.GetGesture(def.ActionKey);
            _shortcutHints[def.ActionKey] = string.IsNullOrWhiteSpace(g) ? "" : ShortcutGesture.Display(g);
        }
        Raise(nameof(ShortcutHints));
    }

    /// <summary>GUI 面板按钮是否显示对应快捷键提示（设置面板「基础设置」勾选；改动即落盘）。</summary>
    public bool ShowShortcuts
    {
        get => _config.ShowShortcuts;
        set
        {
            if (_config.ShowShortcuts == value) return;
            _config.ShowShortcuts = value;
            Raise(nameof(ShowShortcuts));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>侧边栏名称浮层是否常驻（设置面板「基础设置」勾选；false 默认临时悬停浮出）。改动即落盘。</summary>
    public bool SidebarPersistent
    {
        get => _config.SidebarPersistent;
        set
        {
            if (_config.SidebarPersistent == value) return;
            _config.SidebarPersistent = value;
            Raise(nameof(SidebarPersistent));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>全屏/最大化时是否隐藏 Windows 任务栏（设置面板「基础设置」勾选；改动即落盘）。</summary>
    public bool HideTaskbarInFullscreen
    {
        get => _config.HideTaskbarInFullscreen;
        set
        {
            if (_config.HideTaskbarInFullscreen == value) return;
            _config.HideTaskbarInFullscreen = value;
            Raise(nameof(HideTaskbarInFullscreen));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>点关闭时默认隐藏到托盘而非退出（设置面板「基础设置」勾选；改动即落盘）。</summary>
    public bool HideToTrayOnClose
    {
        get => _config.HideToTrayOnClose;
        set
        {
            if (_config.HideToTrayOnClose == value) return;
            _config.HideToTrayOnClose = value;
            Raise(nameof(HideToTrayOnClose));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>退出 GUI 时是否同时关闭 MCP 后台进程（设置面板「基础设置」勾选；改动即落盘）。</summary>
    public bool CloseMcpOnExit
    {
        get => _config.CloseMcpOnExit;
        set
        {
            if (_config.CloseMcpOnExit == value) return;
            _config.CloseMcpOnExit = value;
            Raise(nameof(CloseMcpOnExit));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>跨类别移动卡片（项目⇄项目组）时是否同步物理搬家文件夹（设置面板「基础设置」勾选；改动即落盘）。</summary>
    public bool MoveFolderOnCrossMove
    {
        get => _config.MoveFolderOnCrossMove;
        set
        {
            if (_config.MoveFolderOnCrossMove == value) return;
            _config.MoveFolderOnCrossMove = value;
            Raise(nameof(MoveFolderOnCrossMove));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>跨类别移动时的物理搬家范围（设置面板「基础设置」下拉；改动即落盘）。</summary>
    public string MoveFolderScope
    {
        get => _config.MoveFolderScope;
        set
        {
            if (string.Equals(_config.MoveFolderScope, value, StringComparison.Ordinal)) return;
            _config.MoveFolderScope = value;
            Raise(nameof(MoveFolderScope));
            _configSvc.SaveConfig(_config);
        }
    }

    public ObservableCollection<TabViewModel> GroupTabs { get; } = new();
    public ObservableCollection<TabViewModel> ProjectTabs { get; } = new();

    private int _activeGroupTabIndex;
    public int ActiveGroupTabIndex
    {
        get => _activeGroupTabIndex;
        set { if (Set(ref _activeGroupTabIndex, value)) Raise(nameof(CurrentGroupCards)); }
    }

    private int _activeProjectTabIndex;
    public int ActiveProjectTabIndex
    {
        get => _activeProjectTabIndex;
        set
        {
            if (Set(ref _activeProjectTabIndex, value))
            {
                Raise(nameof(CurrentProjectCards));
                Raise(nameof(CurrentProjectCount));
            }
        }
    }

    /// <summary>空卡片集合：页签集合意外为空时的安全回退（避免索引越界崩溃）。</summary>
    private static readonly ObservableCollection<FolderCardViewModel> EmptyCards = new();

    /// <summary>当前活动项目组集群下的卡片集合（切页签时刷新）。</summary>
    public ObservableCollection<FolderCardViewModel> CurrentGroupCards
    {
        get
        {
            if (GroupTabs.Count == 0) return EmptyCards;
            var i = ActiveGroupTabIndex;
            return (i >= 0 && i < GroupTabs.Count) ? GroupTabs[i].Items : GroupTabs[0].Items;
        }
    }

    /// <summary>当前活动项目页签下的卡片集合。</summary>
    public ObservableCollection<FolderCardViewModel> CurrentProjectCards
    {
        get
        {
            if (ProjectTabs.Count == 0) return EmptyCards;
            var i = ActiveProjectTabIndex;
            return (i >= 0 && i < ProjectTabs.Count) ? ProjectTabs[i].Items : ProjectTabs[0].Items;
        }
    }

    /// <summary>项目组总数量（标题计数徽章，格式对齐 agents 的 AgentCount）。</summary>
    public int GroupCount => _allGroupCards.Count;

    /// <summary>项目组集群（页签）数量（标题「项目组集群」）。</summary>
    public int GroupClusterCount => GroupTabs.Count;

    /// <summary>项目总数量（标题计数徽章）。</summary>
    public int ProjectCount => _allProjectCards.Count;

    /// <summary>当前活动项目页签下的项目数（标题「当前页签」）。</summary>
    public int CurrentProjectCount => CurrentProjectCards.Count;

    // ---- UI 命令（XAML 绑定入口；??= 首次访问创建并缓存实例，避免 getter 每次 new 造成 CommandManager 订阅堆积）----
    private ICommand? _switchGroupTabCommand;
    public ICommand SwitchGroupTabCommand => _switchGroupTabCommand ??= new RelayCommand(o =>
    { if (o is int i) SwitchGroupTab(i); });
    private ICommand? _switchProjectTabCommand;
    public ICommand SwitchProjectTabCommand => _switchProjectTabCommand ??= new RelayCommand(o =>
    { if (o is int i) SwitchProjectTab(i); });
    private ICommand? _selectCardCommand;
    public ICommand SelectCardCommand => _selectCardCommand ??= new RelayCommand(o =>
    { if (o is FolderCardViewModel c) SelectCard(c.Kind, c.FullPath); });

    /// <summary>点击项目卡右侧链接的项目组小按钮：切到该项目组所在集群并选中它。</summary>
    private ICommand? _selectLinkedGroupCommand;
    public ICommand SelectLinkedGroupCommand => _selectLinkedGroupCommand ??= new RelayCommand(o =>
    {
        switch (o)
        {
            case FolderCardViewModel c when !string.IsNullOrEmpty(c.LinkedGroupPath): SelectLinkedGroup(c.LinkedGroupPath); break;
            case ProjectLinkRowViewModel r when !string.IsNullOrEmpty(r.GroupPath): SelectLinkedGroup(r.GroupPath); break;
        }
    });

    /// <summary>定位并选中项目卡链接的项目组（跨集群：先切页签再选中）。</summary>
    public void SelectLinkedGroup(string path)
    {
        if (string.IsNullOrEmpty(path)) return;
        for (int i = 0; i < GroupTabs.Count; i++)
        {
            if (GroupTabs[i].Items.Any(g =>
                string.Equals(Norm(g.FullPath), Norm(path), StringComparison.OrdinalIgnoreCase)))
            {
                if (i != ActiveGroupTabIndex) SwitchGroupTab(i);
                SelectCard("group", path);
                return;
            }
        }
        Log($"未找到链接的项目组: {path}", true);
    }

    /// <summary>当前选中卡片（单选）：PS selectedGroup / selectedProject 的单一归一。</summary>
    private FolderCardViewModel? _selectedCard;
    public FolderCardViewModel? SelectedCard { get => _selectedCard; private set => Set(ref _selectedCard, value); }

    private string? _selectedKind;
    public string? SelectedKind { get => _selectedKind; private set => Set(ref _selectedKind, value); }

    /// <summary>目标路径（对应 PS 版 pathBox.Text）：分配/取消分配操作的项目路径；选中项目卡时自动填入。</summary>
    private string _targetPath = "";
    public string TargetPath
    {
        get => _targetPath;
        set => Set(ref _targetPath, value ?? "");
    }

    private FolderCardViewModel MakeCard(string kind, string path)
    {
        var full = Path.TrimEndingDirectorySeparator(path);
        ImageSource? icon = null;
        try { icon = ResolveFolderIcon(full); } catch { /* 无 shell 会话等环境，图标降级为 null */ }
        return new FolderCardViewModel(kind, full, icon) { TagColor = FindTagColor(full) };
    }

    /// <summary>
    /// 文件夹图标统一解析，优先级：GUI 专属映射（iconAffectExplorer=false 时写入）&gt; desktop.ini 自定义 &gt; Shell 默认。
    /// 任一级加载失败自动回退下一级。
    /// </summary>
    private ImageSource? ResolveFolderIcon(string full)
    {
        var guiRef = GetGuiIconRef(full);
        if (guiRef != null)
        {
            var img = IconService.LoadCustomIcon(guiRef.Value.Path, guiRef.Value.Index);
            if (img != null) return img;
        }
        var iniRef = FolderIconService.GetCustomIconReference(full);
        if (iniRef != null)
        {
            var img = IconService.LoadCustomIcon(iniRef.Value.Path, iniRef.Value.Index);
            if (img != null) return img;
        }
        try { return _icons.GetFolderIcon(full); } catch { return null; }
    }

    // ---------------- 图标 / 标签色的规范化查找表（C3：O(n) 逐键比较 → O(1) 查询） ----------------

    private Dictionary<string, (string Path, int Index)>? _guiIconLookup;
    private Dictionary<string, string>? _tagColorLookup;

    /// <summary>重建两张查找表（config 加载后首查惰性触发；增删改入口成功后调用）。变更频率为用户操作级，全量重建即可。</summary>
    private void RebuildIconColorLookups()
    {
        var icons = new Dictionary<string, (string Path, int Index)>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in _config.GuiFolderIcons)
        {
            var val = kv.Value ?? "";
            var sep = val.LastIndexOf('|');
            if (sep > 0 && int.TryParse(val[(sep + 1)..].Trim(), out var idx))
                icons[Norm(kv.Key)] = (val[..sep].Trim(), idx);
            else
                icons[Norm(kv.Key)] = (val, 0);
        }
        _guiIconLookup = icons;

        var colors = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in _config.TagColors)
            if (!string.IsNullOrWhiteSpace(kv.Value))
                colors[Norm(kv.Key)] = kv.Value;
        _tagColorLookup = colors;
    }

    /// <summary>查某文件夹的 GUI 专属图标引用（"文件路径" 或 "DLL路径|索引"）；无则返回 null。</summary>
    private (string Path, int Index)? GetGuiIconRef(string fullPath)
    {
        if (_guiIconLookup == null) RebuildIconColorLookups();
        var key = Norm(Path.GetFullPath(fullPath));
        return _guiIconLookup!.TryGetValue(key, out var hit) ? hit : null;
    }

    /// <summary>记录 GUI 专属自定义图标（文件来源）：复制进缓存副本目录保证源文件移动/删除后仍可显示。</summary>
    public bool SetGuiOnlyIconFile(string fullPath, string iconFile)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(fullPath) || !Directory.Exists(fullPath)) return false;
            if (string.IsNullOrWhiteSpace(iconFile) || !File.Exists(iconFile)) return false;
            var cached = FolderIconService.CopyToCache(iconFile);
            if (cached == null) return false;
            _config.GuiFolderIcons[Norm(Path.GetFullPath(fullPath))] = cached;
            _configSvc.SaveConfig(_config);
            RebuildIconColorLookups();
            return true;
        }
        catch { return false; }
    }

    /// <summary>记录 GUI 专属自定义图标（DLL/EXE 系统图标来源），引用格式 "dllPath|index"。</summary>
    public bool SetGuiOnlyIconDll(string fullPath, string dllPath, int iconIndex)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(fullPath) || !Directory.Exists(fullPath)) return false;
            if (string.IsNullOrWhiteSpace(dllPath) || !File.Exists(dllPath)) return false;
            if (iconIndex < 0) iconIndex = 0;
            _config.GuiFolderIcons[Norm(Path.GetFullPath(fullPath))] = dllPath + "|" + iconIndex;
            _configSvc.SaveConfig(_config);
            RebuildIconColorLookups();
            return true;
        }
        catch { return false; }
    }

    /// <summary>清除某文件夹的 GUI 专属图标覆盖（设置 desktop.ini 图标前调用，避免旧映射遮蔽新图）。返回是否发生变更。</summary>
    public bool ClearGuiOnlyIcon(string fullPath)
    {
        try
        {
            var key = Norm(Path.GetFullPath(fullPath));
            string? foundKey = null;
            foreach (var k in _config.GuiFolderIcons.Keys)
                if (string.Equals(Norm(k), key, StringComparison.OrdinalIgnoreCase)) { foundKey = k; break; }
            if (foundKey == null) return false;
            _config.GuiFolderIcons.Remove(foundKey);
            _configSvc.SaveConfig(_config);
            RebuildIconColorLookups();
            return true;
        }
        catch { return false; }
    }

    // ---------------- System 属性标记（D3：+s 仅对本工具加过的文件夹精确还原） ----------------

    /// <summary>记录"本工具给该文件夹加过 +s"。desktop.ini 图标设置成功后调用。</summary>
    public void MarkSystemAttribAdded(string folderPath)
    {
        try
        {
            var key = Norm(Path.GetFullPath(folderPath));
            if (!_config.SystemAttribByTool.Contains(key, StringComparer.OrdinalIgnoreCase))
                _config.SystemAttribByTool.Add(key);
            _configSvc.SaveConfig(_config);
        }
        catch { /* 标记失败不影响主流程：恢复时最多保留原属性 */ }
    }

    /// <summary>查询 +s 是否为本工具所加（不改动标记）。</summary>
    public bool HasSystemAttribMark(string folderPath)
    {
        try
        {
            var key = Norm(Path.GetFullPath(folderPath));
            return _config.SystemAttribByTool.Any(p =>
                string.Equals(Norm(p), key, StringComparison.OrdinalIgnoreCase));
        }
        catch { return false; }
    }

    /// <summary>清除标记（恢复流程确认已 -s 后调用）。</summary>
    public void ClearSystemAttribMark(string folderPath)
    {
        try
        {
            var key = Norm(Path.GetFullPath(folderPath));
            int removed = _config.SystemAttribByTool.RemoveAll(p =>
                string.Equals(Norm(p), key, StringComparison.OrdinalIgnoreCase));
            if (removed > 0) _configSvc.SaveConfig(_config);
        }
        catch { }
    }

    // ---------------- 标签自定义颜色（色盘） ----------------

    /// <summary>用户自定义常用色（供色盘弹窗展示；增删经 SaveCustomColors 落盘）。</summary>
    public IReadOnlyList<string> CustomColors => _config.CustomColors;

    /// <summary>查某路径的标签颜色（#RRGGBB）；未设置/路径无效返回 null（键匹配策略同 GuiFolderIcons）。</summary>
    public string? FindTagColor(string? fullPath)
    {
        if (string.IsNullOrWhiteSpace(fullPath)) return null;
        try
        {
            if (_tagColorLookup == null) RebuildIconColorLookups();
            return _tagColorLookup!.TryGetValue(Norm(Path.GetFullPath(fullPath)), out var hex) ? hex : null;
        }
        catch { /* 路径非法按无色处理 */ }
        return null;
    }

    /// <summary>拖动色盘时的实时预览：仅改内存 UI 不落盘。项目组变色同步传播到所有项目中链接它的行标签。</summary>
    public void ApplyTagColorPreview(FolderCardViewModel card, string? hex)
    {
        card.TagColor = hex;
        if (card.Kind == "group") PropagateGroupColor(card.FullPath, hex);
    }

    /// <summary>确定应用标签颜色：写入 tagColors 并落盘（hex=null 表示恢复默认，删除记录）。</summary>
    public void SetTagColor(FolderCardViewModel card, string? hex)
    {
        try
        {
            var key = Norm(Path.GetFullPath(card.FullPath));
            foreach (var k in _config.TagColors.Keys
                .Where(k => string.Equals(Norm(k), key, StringComparison.OrdinalIgnoreCase)).ToList())
                _config.TagColors.Remove(k);
            if (!string.IsNullOrWhiteSpace(hex)) _config.TagColors[key] = hex;
            _configSvc.SaveConfig(_config);
            RebuildIconColorLookups();
        }
        catch { /* 落盘失败仍应用内存色，下次保存时再写入 */ }
        ApplyTagColorPreview(card, hex);
    }

    /// <summary>保存用户自定义常用色（整表替换，去重保序）并落盘。</summary>
    public void SaveCustomColors(IEnumerable<string> colors)
    {
        _config.CustomColors = colors
            .Where(c => !string.IsNullOrWhiteSpace(c))
            .Select(c => c.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        _configSvc.SaveConfig(_config);
    }

    /// <summary>把某项目组的颜色传播到所有引用它的链接行（跨页签/跨集群实时跟色）。</summary>
    private void PropagateGroupColor(string groupPath, string? hex)
    {
        string? key = null;
        try { key = Norm(Path.GetFullPath(groupPath)); } catch { return; }
        foreach (var p in _allProjectCards)
            foreach (var row in p.LinkRows)
                if (!string.IsNullOrEmpty(row.GroupPath) &&
                    string.Equals(Norm(row.GroupPath), key, StringComparison.OrdinalIgnoreCase))
                    row.GroupTagColor = hex;
    }

    /// <summary>按统一优先级（GUI 专属映射 &gt; desktop.ini &gt; Shell）重新解析并更新选中卡片图标。</summary>
    public void RefreshSelectedCardIcon()
    {
        var card = SelectedCard;
        if (card == null || string.IsNullOrEmpty(card.FullPath)) return;
        try
        {
            _icons.InvalidateFolder(card.FullPath);
            card.Icon = ResolveFolderIcon(card.FullPath);
        }
        catch
        {
            // 刷新失败保持原图，不崩溃
        }
    }

    // ---------------- 页签切换（对应 Switch-GroupTab / Switch-ProjectTab） ----------------

    public void SwitchGroupTab(int index)
    {
        if (index < 0 || index >= GroupTabs.Count) return;
        ActiveGroupTabIndex = index;
        _config.ActiveGroupTabIndex = index;   // 同步 config 活动索引：SaveConfig 顶层冗余快照按它取页签，不同步则快照滞后
        SyncActiveTabs();
        // 复刻：selectedGroup=null；若当前种类是 group 则种类清空
        if (SelectedKind == "group") SelectedKind = null;
        ClearAllSelection();
    }

    public void SwitchProjectTab(int index)
    {
        if (index < 0 || index >= ProjectTabs.Count) return;
        ActiveProjectTabIndex = index;
        _config.ActiveProjectTabIndex = index;   // 同上（N1）
        SyncActiveTabs();
        if (SelectedKind == "project") SelectedKind = null;
        ClearAllSelection();
    }

    /// <summary>按当前活动索引刷新所有页签的高亮态。</summary>
    private void SyncActiveTabs()
    {
        for (int i = 0; i < GroupTabs.Count; i++) GroupTabs[i].IsActive = i == ActiveGroupTabIndex;
        for (int i = 0; i < ProjectTabs.Count; i++) ProjectTabs[i].IsActive = i == ActiveProjectTabIndex;
    }

    // ---------------- 单选互斥（对应 Select-FolderCard） ----------------

    /// <summary>选中指定类别+路径的卡片；成功返回该卡片，找不到返回 null。选中始终全局唯一（用户/组互斥）。</summary>
    public FolderCardViewModel? SelectCard(string kind, string path)
    {
        ClearAllSelection();
        var target = Find(kind, path);
        if (target != null)
        {
            target.IsSelected = true;
            SelectedCard = target;
            SelectedKind = kind;
            // 选中项目卡 → 填入目标路径（对应 PS Select-FolderCard 的 pathBox.Text = key）
            if (kind == "project")
            {
                TargetPath = target.FullPath;
            }
            // 选中项目组 → 联动中列 Agent/Skill 内容区（对应 PS Update-ContentPanel）
            if (kind == "group" && Content != null)
            {
                Content.ShowGroup(target.FullPath);
            }
        }
        return target;
    }

    /// <summary>清除全部卡片选中（复刻 Select-FolderCard 中"清另一面板+本面板"的所有取消选中）。</summary>
    public void ClearAllSelection()
    {
        foreach (var c in _allGroupCards) c.IsSelected = false;
        foreach (var c in _allProjectCards) c.IsSelected = false;
        SelectedCard = null;
        SelectedKind = null;
    }

    public FolderCardViewModel? Find(string kind, string path)
    {
        var key = Path.TrimEndingDirectorySeparator(path);
        var pool = kind == "group" ? _allGroupCards : _allProjectCards;
        return pool.FirstOrDefault(c => string.Equals(
            Path.TrimEndingDirectorySeparator(c.FullPath), key, StringComparison.OrdinalIgnoreCase));
    }

    // ---------------- 键盘导航（上下相邻卡片 / Ctrl+左右切换面板） ----------------

    /// <summary>请求主窗口将指定卡片滚动到可视区域（键盘导航后调用）。</summary>
    public event Action<FolderCardViewModel>? RequestScrollToCard;

    /// <summary>上下键：在当前活动面板内选中相邻卡片（delta=-1 上 / +1 下，越界不做）。</summary>
    public void NavigateAdjacent(int delta)
    {
        var list = SelectedKind == "project" ? CurrentProjectCards : CurrentGroupCards;
        if (list.Count == 0) return;
        var idx = SelectedCard != null ? list.IndexOf(SelectedCard) : -1;
        var next = idx < 0 ? 0 : idx + delta;
        if (next < 0 || next >= list.Count) return;
        var card = list[next];
        if (SelectCard(card.Kind, card.FullPath) != null)
            RequestScrollToCard?.Invoke(card);
    }

    /// <summary>Ctrl+左右键：在项目与项目组面板间切换（direction=-1 左→项目 / +1 右→项目组）。
    /// 未选中卡片时同样生效：落到目标面板第一张（与 NavigateAdjacent 的 idx&lt;0→0 策略一致）。</summary>
    public void SwitchPane(int direction)
    {
        if (direction > 0) { if (SelectedKind != "project") SelectGroupPaneCard(); }
        else { if (SelectedKind != "group") SelectProjectPaneCard(); }
    }

    private ICommand? _switchToProjectPaneCommand;
    /// <summary>快捷键「切到项目面板」：SwitchPane(-1)。</summary>
    public ICommand SwitchToProjectPaneCommand => _switchToProjectPaneCommand ??= new RelayCommand(_ => SwitchPane(-1));

    private ICommand? _switchToGroupPaneCommand;
    /// <summary>快捷键「切到项目组面板」：SwitchPane(+1)。</summary>
    public ICommand SwitchToGroupPaneCommand => _switchToGroupPaneCommand ??= new RelayCommand(_ => SwitchPane(1));

    /// <summary>切到项目组面板：优先选中当前项目链接的项目组，否则选活动页签第一个项目组。</summary>
    private void SelectGroupPaneCard()
    {
        var groups = CurrentGroupCards;
        if (groups.Count == 0) return;
        FolderCardViewModel? target = null;
        if (SelectedCard != null && !string.IsNullOrEmpty(SelectedCard.LinkedGroupPath))
        {
            var lp = Norm(SelectedCard.LinkedGroupPath);
            target = groups.FirstOrDefault(g => string.Equals(Norm(g.FullPath), lp, StringComparison.OrdinalIgnoreCase));
        }
        target ??= groups[0];
        if (SelectCard("group", target.FullPath) != null)
            RequestScrollToCard?.Invoke(target);
    }

    /// <summary>切到项目面板：优先选中链接到当前项目组的项目，否则选活动页签第一个项目。</summary>
    private void SelectProjectPaneCard()
    {
        var projects = CurrentProjectCards;
        if (projects.Count == 0) return;
        FolderCardViewModel? target = null;
        if (SelectedCard != null)
        {
            var gp = Norm(SelectedCard.FullPath);
            target = projects.FirstOrDefault(p => !string.IsNullOrEmpty(p.LinkedGroupPath)
                && string.Equals(Norm(p.LinkedGroupPath), gp, StringComparison.OrdinalIgnoreCase));
        }
        target ??= projects[0];
        if (SelectCard("project", target.FullPath) != null)
            RequestScrollToCard?.Invoke(target);
    }

    // ---------------- 卡片有效性 / 链接标记（对应 Update-AllCardsValidity + Update-CardStyle 数据部分） ----------------

    #region 有效性刷新（同步/异步共用「快照→扫描→应用」管线）

    /// <summary>一条链接记录的不可变快照（消除后台扫描期间与 UI 线程账本变更的竞态）。</summary>
    private sealed record RecordSnapshot(string? Project, string? Lib, string? Group, List<string> Names);

    /// <summary>一张链接行的扫描产物（纯数据，UI 线程据此重建 ProjectLinkRowViewModel）。</summary>
    private sealed class RowScan
    {
        public string Name = "";
        public bool HasLink, HasBroken, HasConflict;
        public string GroupPath = "", Group = "";
        public bool ProjectFolderExists = true, GroupFolderExists = true;
        public string? LinkTip;
    }

    /// <summary>一张卡片的扫描产物。</summary>
    private sealed class CardScan
    {
        public FolderCardViewModel Card = null!;
        public bool Exists;
        public bool HasLink, HasBroken, HasConflict;
        public string LinkedGroup = "", LinkedGroupPath = "";
        public string? LinkTip;
        public List<RowScan> Rows = new();
    }

    /// <summary>扫描快照：进入后台前在 UI 线程一次性取齐，后台不再触碰任何 UI/配置对象。
    /// UseCachedScans=true 时跳过盘上重扫，直接以快照携带的 ScannedLinks 为准（同步单卡刷新语义：只读缓存）。</summary>
    private sealed class ScanSnapshot
    {
        public List<(FolderCardViewModel Card, string Key, bool IsProject)> Cards = new();
        public string BaseRoot = "";
        public List<string> KnownNames = new();
        public List<RecordSnapshot> Records = new();
        public Dictionary<string, (List<string> Names, string Target)> ScannedLinks = new();
        public bool UseCachedScans;
    }

    /// <summary>异步全量刷新（GUI 入口）：UI 线程取快照 → 后台纯 IO 扫描 → UI 线程应用，期间界面不冻结。
    /// 重入保护：上一次未完成时忽略本次请求。</summary>
    private bool _validityBusy;
    public async void RefreshAllValidityAsync()
    {
        if (_validityBusy) return;
        _validityBusy = true;
        try
        {
            var snap = BuildScanSnapshot();
            var result = await Task.Run(() => ScanAllValidity(snap));
            ApplyScanResult(result);
        }
        catch (Exception ex)
        {
            Log("刷新有效性失败: " + ex.Message, true);
        }
        finally { _validityBusy = false; }
    }

    /// <summary>同步全量刷新（自检/低频入口）：同一条管线的串行执行。</summary>
    public void RefreshAllValidity()
    {
        var snap = BuildScanSnapshot();
        ApplyScanResult(ScanAllValidity(snap));
    }

    /// <summary>[UI] 收集扫描快照：卡片清单、已知链接名、记录不可变副本。</summary>
    private ScanSnapshot BuildScanSnapshot()
    {
        var snap = new ScanSnapshot
        {
            BaseRoot = Norm(_recSvc.BaseRoot),
            KnownNames = CollectKnownLinkNames(),
        };
        foreach (var c in _allGroupCards) snap.Cards.Add((c, Path.TrimEndingDirectorySeparator(c.FullPath), false));
        foreach (var c in _allProjectCards) snap.Cards.Add((c, Path.TrimEndingDirectorySeparator(c.FullPath), true));
        foreach (var r in _records)
            snap.Records.Add(new RecordSnapshot(r.Project, r.Lib, r.Group,
                r.GetLinkNames().ToList()));
        return snap;
    }

    /// <summary>已知链接名全集（预设当前名 + 自定义名），供本地扫描逐名探测。</summary>
    private List<string> CollectKnownLinkNames()
        => LinkAgentCatalog.All
            .Select(a => LinkAgentCatalog.CurrentName(_config, a.Name))
            .Concat(LinkAgentCatalog.CustomNames(_config))
            .Distinct()
            .ToList();

    /// <summary>[UI] 单卡快照：同步刷新走与全量同一条扫描管线；本地链接用现有缓存（不重扫，行为与旧单卡实现一致）。</summary>
    private ScanSnapshot BuildSingleCardSnapshot(FolderCardViewModel card)
    {
        var snap = new ScanSnapshot
        {
            BaseRoot = Norm(_recSvc.BaseRoot),
            KnownNames = CollectKnownLinkNames(),
            UseCachedScans = true,
        };
        var isProject = string.Equals(card.Kind, "project", StringComparison.OrdinalIgnoreCase);
        snap.Cards.Add((card, Path.TrimEndingDirectorySeparator(card.FullPath), isProject));
        foreach (var r in _records)
            snap.Records.Add(new RecordSnapshot(r.Project, r.Lib, r.Group,
                r.GetLinkNames().ToList()));
        foreach (var kv in _scannedLinks) snap.ScannedLinks[kv.Key] = kv.Value;
        return snap;
    }

    /// <summary>[BG] 纯文件系统扫描：存在性、锁定外信息、链接状态、逐行链接明细。不触碰任何 UI 对象。
    /// 本地链接扫描（原 ScanLocalLinks）：无账本记录也能显示磁盘上真实存在的 junction；
    /// UseCachedScans 时跳过重扫，直接沿用快照携带的上次扫描缓存（同步单卡刷新语义）。</summary>
    private static ScanOutput ScanAllValidity(ScanSnapshot snap)
    {
        var output = new ScanOutput();
        if (snap.UseCachedScans)
        {
            foreach (var kv in snap.ScannedLinks) output.ScannedLinks[kv.Key] = kv.Value;
        }
        else
        {
            foreach (var (card, key, isProject) in snap.Cards)
            {
                if (!isProject) continue;
                if (!Directory.Exists(key)) continue;
                var found = new List<string>();
                string? target = null;
                foreach (var n in snap.KnownNames)
                {
                    var state = JunctionService.GetLinkState(key, n);
                    if (state == JunctionService.LinkState.Broken) continue;
                    found.Add(n);
                    if (state == JunctionService.LinkState.Valid)
                        target ??= JunctionService.ResolveTarget(JunctionService.LinkPath(key, n));
                }
                if (found.Count > 0) output.ScannedLinks[key] = (found, target ?? "");
            }
        }

        foreach (var (card, key, isProject) in snap.Cards)
        {
            var cs = new CardScan { Card = card };
            cs.Exists = Directory.Exists(key);
            if (isProject) ScanProjectCard(snap, output, key, cs);
            else ScanGroupCard(snap, output, key, cs);
            output.Cards.Add(cs);
        }
        return output;
    }

    private sealed class ScanOutput
    {
        public List<CardScan> Cards = new();
        public Dictionary<string, (List<string> Names, string Target)> ScannedLinks = new();
    }

    /// <summary>[BG] 项目卡扫描：区分 有效/破坏/冲突，并产出逐行链接明细。</summary>
    private static void ScanProjectCard(ScanSnapshot snap, ScanOutput output, string key, CardScan cs)
    {
        // 排除指向 baseRoot 自身的陈旧记录（project="."），根目录不算链接项目
        var baseRoot = snap.BaseRoot;
        var rec = snap.Records.FirstOrDefault(r =>
            !string.Equals(NormStatic(baseRoot), NormStatic(ToAbs(snap, r.Project)), StringComparison.OrdinalIgnoreCase)
            && string.Equals(NormStatic(ToAbs(snap, r.Project)), key, StringComparison.OrdinalIgnoreCase));
        output.ScannedLinks.TryGetValue(key, out var scanned);

        var names = new List<string>();
        if (rec != null) names.AddRange(rec.Names);
        if (scanned.Names != null)
            foreach (var n in scanned.Names)
                if (!names.Contains(n)) names.Add(n);

        string group, groupPath;
        if (rec != null)
        {
            group = rec.Group is { Length: > 0 } ? rec.Group : System.IO.Path.GetFileName(ToAbs(snap, rec.Lib) ?? "") ?? "";
            groupPath = NormStatic(ToAbs(snap, rec.Lib) ?? "");
        }
        else if (scanned.Names is { Count: > 0 })
        {
            groupPath = NormStatic(scanned.Target);
            group = System.IO.Path.GetFileName(groupPath);
        }
        else { group = ""; groupPath = ""; }

        cs.LinkedGroup = group;
        cs.LinkedGroupPath = groupPath;

        if (names.Count == 0) return;

        bool conflict = names.Any(n =>
            JunctionService.GetLinkState(key, n) == JunctionService.LinkState.Conflict);
        bool valid = !conflict && names.All(n =>
            JunctionService.GetLinkState(key, n) == JunctionService.LinkState.Valid);
        bool broken = !conflict && !valid;

        cs.HasLink = valid;
        cs.HasBroken = broken || conflict;
        cs.HasConflict = conflict;
        cs.LinkTip = valid
            ? (group.Length > 0 ? "链接项目组: " + group : "已创建链接") + $"（{names.Count} 个链接）"
            : conflict ? "链接冲突: 有链接名被普通目录/文件占用"
            : broken ? "链接已破坏: " + group
            : null;

        foreach (var n in names.Distinct())
        {
            var state = JunctionService.GetLinkState(key, n);
            var row = new RowScan
            {
                Name = n,
                HasLink = state == JunctionService.LinkState.Valid,
                HasBroken = state == JunctionService.LinkState.Broken,
                HasConflict = state == JunctionService.LinkState.Conflict,
                GroupPath = groupPath,
                Group = group,
            };
            var realTarget = JunctionService.ResolveTarget(JunctionService.LinkPath(key, n));
            if (!string.IsNullOrEmpty(realTarget) && Directory.Exists(realTarget))
            {
                row.GroupPath = NormStatic(realTarget);
                row.Group = System.IO.Path.GetFileName(row.GroupPath);
            }
            row.ProjectFolderExists = Directory.Exists(key);
            row.GroupFolderExists = row.GroupPath.Length > 0 && Directory.Exists(row.GroupPath);
            row.LinkTip = !row.ProjectFolderExists
                ? $"项目文件夹不存在: {key}"
                : !row.GroupFolderExists && row.GroupPath.Length > 0
                ? $"项目组文件夹不存在: {row.GroupPath}"
                : state == JunctionService.LinkState.Valid
                ? (row.Group.Length > 0 ? "链接项目组: " + row.Group : "已创建链接") + "（" + n + "）"
                : state == JunctionService.LinkState.Conflict ? $"链接冲突: {n} 被普通目录/文件占用"
                : $"链接已破坏: {n}";
            cs.Rows.Add(row);
        }
    }

    /// <summary>[BG] 项目组卡扫描：记录中 Lib 指向它、或本地扫描有项目 junction 指向它。</summary>
    private static void ScanGroupCard(ScanSnapshot snap, ScanOutput output, string key, CardScan cs)
    {
        var hits = snap.Records.Where(r =>
            string.Equals(NormStatic(ToAbs(snap, r.Lib)), key, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(NormStatic(ToAbs(snap, r.Project)), snap.BaseRoot, StringComparison.OrdinalIgnoreCase)).ToList();
        var scannedHits = output.ScannedLinks
            .Where(kv => string.Equals(NormStatic(kv.Value.Target), key, StringComparison.OrdinalIgnoreCase))
            .Select(kv => kv.Key).ToList();

        if (hits.Count == 0 && scannedHits.Count == 0) return;

        cs.HasLink = true;
        var linkNames = hits.Select(r => System.IO.Path.GetFileName(ToAbs(snap, r.Project)!))
            .Concat(scannedHits.Select(p => System.IO.Path.GetFileName(p)))
            .Where(n => !string.IsNullOrWhiteSpace(n)).Distinct().ToList();
        cs.LinkTip = linkNames.Count <= 5
            ? "链接项目:\n- " + string.Join("\n- ", linkNames)
            : $"链接项目 {linkNames.Count} 个:\n- " + string.Join("\n- ", linkNames.Take(5)) + "\n…";
    }

    private static string ToAbs(ScanSnapshot snap, string? rel)
        => string.IsNullOrWhiteSpace(rel) ? snap.BaseRoot : System.IO.Path.GetFullPath(System.IO.Path.Combine(snap.BaseRoot, rel));

    private static string NormStatic(string p) => Path.TrimEndingDirectorySeparator(p);

    /// <summary>[UI] 把扫描产物应用到卡片（含 LinkRows 重建、图标与标签色查询——均需 UI 线程的配置访问）。</summary>
    private void ApplyScanResult(ScanOutput output)
    {
        _scannedLinks.Clear();
        foreach (var kv in output.ScannedLinks) _scannedLinks[kv.Key] = kv.Value;

        foreach (var cs in output.Cards) ApplyCardScan(cs);
    }

    /// <summary>[UI] 应用单卡扫描产物：存在性/锁定/链接标记/逐行明细重建（同步单卡刷新与异步全量刷新共用）。</summary>
    private void ApplyCardScan(CardScan cs)
    {
        var card = cs.Card;
        card.Exists = cs.Exists;
        card.IsLocked = IsLockedPath(card.FullPath);
        RefreshAclBadge(card);

        if (card.Kind != "project")
        {
            card.HasLink = cs.HasLink;
            card.HasBroken = false;
            card.HasConflict = false;
            card.LinkTip = cs.LinkTip;
            return;
        }

        // 链接的项目组卡片：取图标与完整路径（查内存卡片池，UI 线程）
        var linkedGroupCard = cs.LinkedGroupPath.Length > 0
            ? _allGroupCards.FirstOrDefault(g =>
                string.Equals(Norm(g.FullPath), cs.LinkedGroupPath, StringComparison.OrdinalIgnoreCase))
            : null;

        card.HasLink = cs.HasLink;
        card.HasBroken = cs.HasBroken;
        card.HasConflict = cs.HasConflict;
        card.LinkedGroup = cs.LinkedGroup;
        card.LinkedGroupPath = cs.LinkedGroupPath;
        card.LinkedGroupIcon = linkedGroupCard?.Icon;
        card.LinkTip = cs.LinkTip;

        card.LinkRows.Clear();
        foreach (var rs in cs.Rows)
        {
            var row = new ProjectLinkRowViewModel(rs.Name)
            {
                ProjectFullPath = Path.TrimEndingDirectorySeparator(card.FullPath),
                HasLink = rs.HasLink,
                HasBroken = rs.HasBroken,
                HasConflict = rs.HasConflict,
                GroupPath = rs.GroupPath,
                Group = rs.Group,
            };
            row.GroupIcon = row.GroupPath.Length > 0
                ? _allGroupCards.FirstOrDefault(g =>
                    string.Equals(Norm(g.FullPath), row.GroupPath, StringComparison.OrdinalIgnoreCase))?.Icon
                : null;
            row.GroupTagColor = FindTagColor(row.GroupPath);
            row.LinkTip = rs.LinkTip;
            card.LinkRows.Add(row);
        }
        card.LinkCount = card.LinkRows.Count;
    }

    #endregion

    /// <summary>记录变更后重载账本并刷新全部链接标记（供建链等调用；扫描走后台不冻结界面）。</summary>
    public void ReloadRecordsAndRefresh()
    {
        _records = _recSvc.Load();
        RefreshAllValidityAsync();
    }

    /// <summary>刷新单卡片：存在性、锁定、链接标记与悬浮提示。
    /// 链接判定 = .opencode junction 实时状态 × 链接记录账本：
    /// 有效=junction 正常；已破坏=记录存在但 junction 失效（旧版体验）；冲突=.opencode 被普通目录占用。
    /// 与异步全量刷新共用同一「快照 → 扫描 → 应用」纯函数管线（C1 去重）；本地链接沿用 _scannedLinks 缓存，行为同旧实现。</summary>
    public void RefreshCardValidity(FolderCardViewModel card)
    {
        var snap = BuildSingleCardSnapshot(card);
        var output = ScanAllValidity(snap);
        ApplyCardScan(output.Cards[0]);
    }

    /// <summary>收集某项目当前的全部链接名（账本记录 ∪ 本地扫描；供占用冲突校验）。</summary>
    private List<string> CollectLinkNames(string key)
    {
        var names = new List<string>();
        var rec = _records.FirstOrDefault(r => string.Equals(Norm(_recSvc.ToAbsPath(r.Project)), key, StringComparison.OrdinalIgnoreCase));
        if (rec != null) names.AddRange(rec.GetLinkNames());
        if (_scannedLinks.TryGetValue(key, out var scanned) && scanned.Names != null)
            foreach (var n in scanned.Names)
                if (!names.Contains(n)) names.Add(n);
        return names;
    }

    /// <summary>
/// 构建某项目可勾选的链接清单：预设当前名 + 自定义 + 已在盘上的链接名；固定(原置顶)项排最前并带 IsFixed。
/// targetGroupPath 为本次编辑/建链针对的项目组：名称的 junction 若指向其它项目组则标记 IsOwnedElsewhere（仍可选，
/// 勾选 = 把该名称链接改连到本项目组，即"同名改连"）；被它组占用的名称默认不勾选，需显式选择。
/// assignMode=true 时未被它组占用的启用名默认勾选（提议集）。
/// </summary>
    public List<LinkPickOption> BuildLinkPickOptions(string projectFullPath, bool assignMode = false, string? targetGroupPath = null)
    {
        var key = Path.TrimEndingDirectorySeparator(projectFullPath);
        var tgp = targetGroupPath == null ? null
            : Norm(Path.GetFullPath(targetGroupPath));
        var active = CollectLinkNames(key).ToHashSet(StringComparer.OrdinalIgnoreCase);
        HashSet<string> proposed = assignMode
            ? new HashSet<string>(LinkAgentCatalog.EnabledNames(_config), StringComparer.OrdinalIgnoreCase)
            : new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pinned = new HashSet<string>(_config.LinkAgentsPinned ?? new(), StringComparer.OrdinalIgnoreCase);
        var opts = new List<LinkPickOption>();

        void Add(string name, string vendor)
        {
            if (opts.Any(o => string.Equals(o.Name, name, StringComparison.OrdinalIgnoreCase))) return;
            (bool ownedElsewhere, string? ownerBy) = InspectOwnership(key, name, tgp);
            bool isActive = !ownedElsewhere && (active.Contains(name) || proposed.Contains(name));
            opts.Add(new LinkPickOption(name, vendor, pinned.Contains(name), isActive, ownedElsewhere, ownerBy));
        }

        foreach (var def in LinkAgentCatalog.All)
            Add(LinkAgentCatalog.CurrentName(_config, def.Name), def.Vendor);
        foreach (var n in LinkAgentCatalog.CustomNames(_config))
            Add(n, "自定义");
        // 已在盘上但不在预设/自定义候选里的（如改名后的任意名），补上以便可取消勾选移除。
        foreach (var n in active)
            if (!opts.Any(o => string.Equals(o.Name, n, StringComparison.OrdinalIgnoreCase)))
            {
                (bool ownedElsewhere, string? ownerBy) = InspectOwnership(key, n, tgp);
                opts.Add(new LinkPickOption(n, "自定义", pinned.Contains(n), !ownedElsewhere, ownedElsewhere, ownerBy));
            }
        return opts.OrderByDescending(o => o.IsFixed).ThenBy(o => o.IsOwnedElsewhere).ToList();
    }

    /// <summary>判断某链接名当前是否被"另一个项目组"占用（junction 目标存在且 != 本次 target）。</summary>
    private static (bool ownedElsewhere, string? ownerBy) InspectOwnership(string project, string name, string? tgp)
    {
        var real = JunctionService.ResolveTarget(JunctionService.LinkPath(project, name));
        if (string.IsNullOrEmpty(real) || !Directory.Exists(real)) return (false, null);
        var rt = Path.GetFullPath(real).TrimEnd(Path.DirectorySeparatorChar);
        if (tgp != null && !string.Equals(rt, tgp, StringComparison.OrdinalIgnoreCase))
            return (true, Path.GetFileName(rt));
        return (false, null);
    }

    /// <summary>应用"编辑某项目组"的多选结果：只增删【指向 targetGroupPath 这一项目组】的链接，不动其它项目组的链接；账本记录项目全部链接名。</summary>
    public string? ApplyLinkPick(string projectFullPath, string targetGroupPath, string targetGroup, IEnumerable<string> wantedNames)
    {
        if (string.IsNullOrWhiteSpace(targetGroupPath) || !Directory.Exists(targetGroupPath))
            return "项目组文件夹不存在，无法建链。";
        var key = Path.TrimEndingDirectorySeparator(projectFullPath);
        var tgp = Norm(Path.GetFullPath(targetGroupPath));
        var wanted = wantedNames?
            .Where(n => !string.IsNullOrWhiteSpace(n)).Select(n => n.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList() ?? new List<string>();
        // 预检：待新建名若被普通目录/文件占用则整体阻断（防误删内容）。
        foreach (var n in wanted)
        {
            var lp = JunctionService.LinkPath(key, n);
            if ((Directory.Exists(lp) || File.Exists(lp))
                && JunctionService.GetLinkState(key, n) != JunctionService.LinkState.Valid)
                return $"{lp} 已被普通目录/文件占用，无法创建。";
        }
        try
        {
            // 仅处理"本组已占用"的链接名：取消勾选 → 删除（释放该名称）
            var ownedByThis = CollectLinkNames(key).Where(n =>
            {
                var t = JunctionService.ResolveTarget(JunctionService.LinkPath(key, n));
                return !string.IsNullOrEmpty(t) && Directory.Exists(t)
                    && string.Equals(Norm(Path.GetFullPath(t)), tgp, StringComparison.OrdinalIgnoreCase);
            }).ToList();
            foreach (var a in ownedByThis)
                if (!wanted.Any(n => string.Equals(n, a, StringComparison.OrdinalIgnoreCase)))
                    JunctionService.RemoveLink(key, a);
            // 新勾选的空闲名 → 建链到本组；已被其它组占用的同名 → 改连到本组（同名换绑）。
            foreach (var n in wanted)
            {
                var lp = JunctionService.LinkPath(key, n);
                if (Directory.Exists(lp) || File.Exists(lp))
                {
                    // 指向它组的 junction：选中 = 把该名称链接改指向本组（Create 内部删旧 junction 重建）。
                    // 预检已保证这里的既有项只会是 junction（普通目录/文件会被整体阻断）。
                    var t = JunctionService.ResolveTarget(lp);
                    var targetNorm = string.IsNullOrEmpty(t) ? null : Norm(Path.GetFullPath(t)).TrimEnd('\\');
                    if (targetNorm != null && !string.Equals(targetNorm, tgp, StringComparison.OrdinalIgnoreCase))
                        JunctionService.Create(lp, targetGroupPath);
                }
                else
                    JunctionService.Create(lp, targetGroupPath);
            }

            // 本次取消的名称 = 旧记录/扫描中的链接名，未再勾选且未被其它项目组占用（含已失效的旧名，一并清理）。
            // 用预操作状态判定：被其它组占用的名称（ownedElsewhere）即使不在 wanted 也保留在记录里。
            var cancelled = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var n in CollectLinkNames(key))
            {
                if (wanted.Any(w => string.Equals(w, n, StringComparison.OrdinalIgnoreCase))) continue;
                var (ownedElsewhere, _) = InspectOwnership(key, n, tgp);
                if (!ownedElsewhere) cancelled.Add(n);
            }

            // 账本记录项目全部链接名（跨项目组并集）：旧记录/扫描剔除本次取消项，再并入本次 wanted；无任何链接时移除记录。
            var all = new List<string>();
            foreach (var n in CollectLinkNames(key))
                if (!cancelled.Contains(n)) all.Add(n);
            foreach (var n in wanted)
                if (!all.Contains(n, StringComparer.OrdinalIgnoreCase)) all.Add(n);
            if (all.Count > 0)
                _recSvc.Upsert(key, targetGroupPath, targetGroup, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), all);
            else
                _recSvc.Remove(key);
            ReloadRecordsAndRefresh();
            Log(wanted.Count > 0
                ? $"已更新「{targetGroup}」链接（{wanted.Count} 个）: {string.Join(", ", wanted)}"
                : $"已移除「{targetGroup}」的链接。", false);
            return null;
        }
        catch (Exception ex) { return ex.Message; }
    }

    // ---------------- 动态按钮交互（对应 create/remove/lock/open/收藏/清除无效 等按钮） ----------------

    private ICommand? _lockToggleCommand;
    public ICommand LockToggleCommand => _lockToggleCommand ??= new RelayCommand(_ => LockToggle());
    private ICommand? _openSelectedCommand;
    public ICommand OpenSelectedCommand => _openSelectedCommand ??= new RelayCommand(_ => OpenSelected());
    private ICommand? _removeFavoriteCommand;
    public ICommand RemoveFavoriteCommand => _removeFavoriteCommand ??= new RelayCommand(_ => RemoveFavorite());
    private ICommand? _clearInvalidCommand;
    public ICommand ClearInvalidCommand => _clearInvalidCommand ??= new RelayCommand(_ => ClearInvalid());
    private ICommand? _refreshAllCommand;
    public ICommand RefreshAllCommand => _refreshAllCommand ??= new RelayCommand(_ => RefreshAllValidityAsync());

    /// <summary>下一个项目组页签（循环）。</summary>
    private ICommand? _groupTabNextCommand;
    public ICommand GroupTabNextCommand => _groupTabNextCommand ??= new RelayCommand(_ => SwitchGroupTabRelative(1));
    /// <summary>上一个项目组页签（循环）。</summary>
    private ICommand? _groupTabPrevCommand;
    public ICommand GroupTabPrevCommand => _groupTabPrevCommand ??= new RelayCommand(_ => SwitchGroupTabRelative(-1));
    /// <summary>下一个项目页签（循环）。</summary>
    private ICommand? _projectTabNextCommand;
    public ICommand ProjectTabNextCommand => _projectTabNextCommand ??= new RelayCommand(_ => SwitchProjectTabRelative(1));
    /// <summary>上一个项目页签（循环）。</summary>
    private ICommand? _projectTabPrevCommand;
    public ICommand ProjectTabPrevCommand => _projectTabPrevCommand ??= new RelayCommand(_ => SwitchProjectTabRelative(-1));

    /// <summary>相对当前活动页签切换项目组页签（delta=±1，越界循环）。</summary>
    public void SwitchGroupTabRelative(int delta)
    {
        if (GroupTabs.Count == 0) return;
        SwitchGroupTab((ActiveGroupTabIndex + delta + GroupTabs.Count) % GroupTabs.Count);
    }

    /// <summary>相对当前活动页签切换项目页签（delta=±1，越界循环）。</summary>
    public void SwitchProjectTabRelative(int delta)
    {
        if (ProjectTabs.Count == 0) return;
        SwitchProjectTab((ActiveProjectTabIndex + delta + ProjectTabs.Count) % ProjectTabs.Count);
    }

    private string? _message;
    /// <summary>最近一条操作反馈（后续可绑定日志区；当前用于命令级可观测性）。</summary>
    public string? Message { get => _message; set => Set(ref _message, value); }

    /// <summary>底部滚动日志（集合由日志区 ItemsControl 绑定；读写经 Log()）。</summary>
    public LogViewModel Logs { get; } = new();

    /// <summary>拖入文件夹默认选中（对应 config.autoSelect；设置面板 CheckBox 绑定）。</summary>
    public bool AutoSelect
    {
        get => _config.AutoSelect;
        set
        {
            if (_config.AutoSelect == value) return;
            _config.AutoSelect = value;
            Raise(nameof(AutoSelect));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>修改图标是否同步生效到资源管理器（写 desktop.ini）；关闭则仅本工具 GUI 显示（设置面板「图标」页签绑定）。</summary>
    public bool IconsAffectExplorer
    {
        get => _config.IconAffectExplorer;
        set
        {
            if (_config.IconAffectExplorer == value) return;
            _config.IconAffectExplorer = value;
            Raise(nameof(IconsAffectExplorer));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>统一日志入口（公开供窗口层图标/颜色等操作写日志区 + 状态栏）。</summary>
    public void Log(string text, bool isError = false)
    {
        Message = (isError ? "[错误] " : "") + text;
        if (isError) Logs.Error(text); else Logs.Info(text);
        System.Diagnostics.Debug.WriteLine(text);
    }

    // ==================== 软件自身图标（设置面板「软件图标」） ====================

    /// <summary>当前生效的自定义软件图标路径；null = 使用内置默认图标（config.customAppIcon，文件缺失视为默认）。</summary>
    public string? CustomAppIcon
    {
        get => _config.CustomAppIcon is { } p && File.Exists(p) ? p : null;
        private set
        {
            if (_config.CustomAppIcon == value) return;
            _config.CustomAppIcon = value;
            Raise(nameof(CustomAppIcon));
            Raise(nameof(HasCustomAppIcon));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>是否已设置自定义软件图标（驱动设置面板预览/重置按钮状态）。</summary>
    public bool HasCustomAppIcon => CustomAppIcon != null;

    /// <summary>当前软件图标预览（自定义已存则用之，否则显示内置默认）。</summary>
    public ImageSource? CurrentAppIcon
    {
        get
        {
            var custom = CustomAppIcon;
            return custom != null
                ? AppIconService.LoadAppIcon(_dataDir, custom)
                : AppIconService.LoadAppIcon(_dataDir, null);
        }
    }

    /// <summary>应用用户选择的软件图标（文件或剪贴板位图）：生成 .ico、写 config，返回成功与否。</summary>
    public bool ApplyCustomAppIcon(BitmapSource? image, string? imageFile)
    {
        var path = AppIconService.SaveCustomIcon(_dataDir, image, imageFile);
        if (path == null)
        {
            Log("软件图标生成失败（图片格式不支持或已损坏）。", true);
            return false;
        }
        CustomAppIcon = path;
        Raise(nameof(CurrentAppIcon));
        Log($"已设置软件图标，重启后生效：{path}");
        return true;
    }

    /// <summary>恢复内置默认软件图标：删磁盘副本并清 config 引用。</summary>
    public void ResetCustomAppIcon()
    {
        AppIconService.DeleteCustomIcon(_dataDir);
        CustomAppIcon = null;
        Raise(nameof(CurrentAppIcon));
        Log("已恢复默认软件图标，重启后生效。");
    }

    /// <summary>拖拽建链接（由界面先用多选弹窗确认勾选名单后调用）：为项目 proj 新增指向项目组 grpPath 的勾选链接。不动其它项目组的链接。</summary>
    public string? AssignPicked(string proj, string grpPath, IEnumerable<string> names)
    {
        if (string.IsNullOrWhiteSpace(proj)) return "项目路径为空。";
        if (string.IsNullOrWhiteSpace(grpPath)) return "项目组路径为空。";
        if (!Directory.Exists(grpPath)) return $"项目组文件夹不存在: {grpPath}";
        if (!Directory.Exists(proj)) return $"项目文件夹不存在: {proj}";
        var key = Path.TrimEndingDirectorySeparator(proj);
        var want = names?.Where(n => !string.IsNullOrWhiteSpace(n)).Select(n => n.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList() ?? new List<string>();

        try
        {
            // 冲突预检：任一待建名被普通目录/文件占用则整体阻断（防误删内容，避免部分建成）
            foreach (var n in want)
            {
                var lp = JunctionService.LinkPath(key, n);
                if ((Directory.Exists(lp) || File.Exists(lp))
                    && JunctionService.GetLinkState(key, n) != JunctionService.LinkState.Valid)
                    return $"{lp} 已存在且不是链接（普通目录/文件），为避免误删内容，请手动处理。";
            }

            // 为勾选名单建链：已指向 grpPath 的保留；指向它组的同名 → 改连到 grpPath（同名换绑）；
            // 空闲名新建 → grpPath。（仍支持"同一项目经不同链接名连到多个项目组"）
            foreach (var n in want)
            {
                var lp = JunctionService.LinkPath(key, n);
                if (Directory.Exists(lp) || File.Exists(lp))
                {
                    var t = JunctionService.ResolveTarget(lp);
                    var targetNorm = string.IsNullOrEmpty(t) ? null : Norm(Path.GetFullPath(t)).TrimEnd('\\');
                    if (targetNorm != null && !string.Equals(targetNorm, Norm(grpPath), StringComparison.OrdinalIgnoreCase))
                        JunctionService.Create(lp, grpPath); // 同名被它组占用 → 选中即改连到本项目组
                }
                else JunctionService.Create(lp, grpPath);
            }

            // 账本记录项目全部链接名（跨项目组并集）：旧记录/扫描缓存 ∪ 本次新建名。
            // 必须并入 want：CollectLinkNames 只含上次加载的账本与上次全量扫描缓存，
            // 刚创建的 junction 名两者都没有，漏并入会让账本缺失本次链接名（首次建链则整条记录丢失）。
            var all = CollectLinkNames(key);
            foreach (var n in want)
                if (!all.Contains(n, StringComparer.OrdinalIgnoreCase)) all.Add(n);
            if (all.Count > 0)
                _recSvc.Upsert(key, grpPath, Path.GetFileName(grpPath), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), all);
            else
                _recSvc.Remove(key);
            ReloadRecordsAndRefresh();
            Log($"已建立链接: {key} → {grpPath}（{want.Count} 个: {string.Join(", ", want)}）", false);
            return null;
        }
        catch (Exception ex) { return ex.Message; }
    }

    /// <summary>folderLock 配置访问器（旧配置缺失时惰性初始化，保证读写一致）。</summary>
    public FolderLockConfig LockCfg => _config.FolderLock ??= new FolderLockConfig();

    /// <summary>ACL 保护设置入口（侧边栏按钮 / Ctrl+L）：读当前状态 → 弹窗 → 应用或解除。
    /// 账面固定为强制勾选项：应用后路径至少加入 config.Locked（等价旧锁定语义）。</summary>
    public void LockToggle()
    {
        var card = SelectedCard;
        if (card == null) { Log("请先选择一个项目组或项目。", true); return; }
        var key = Path.TrimEndingDirectorySeparator(card.FullPath);

        FolderLockState acl;
        try { acl = Directory.Exists(key) ? FolderLockService.GetState(key) : new FolderLockState(false, false); }
        catch (Exception ex)
        {
            acl = new FolderLockState(false, false);
            Log($"读取 ACL 状态失败（按未保护处理）: {ex.Message}", true);
        }

        AclLockResult? r;
        try { r = Views.AclLockDialog.Show(key, card.Kind, acl, IsLockedPath(key), LockCfg.WatchAlerts); }
        catch (Exception ex) { Log($"无法打开保护设置: {ex.Message}", true); return; }
        if (r == null) return;

        if (r.RemoveAll)
        {
            var errRm = RemoveAllProtection(key, card);
            if (errRm != null) Log(errRm, true);
            return;
        }
        var err = ApplyAcl(card, r.DenyDelete, r.DenyWrite, r.WatchAlerts);
        if (err != null) Log(err, true);
    }

    /// <summary>ACL 强度文案。</summary>
    private static string AclStrength(bool denyDelete, bool denyWrite) => (denyDelete, denyWrite) switch
    {
        (true, true) => "只读保护",
        (true, false) => "防删除",
        (false, true) => "防写入",
        _ => "仅固定",
    };

    /// <summary>
    /// 应用 ACL 保护到磁盘与配置（弹窗「应用」回调；DataSelfCheck 直测入口）：
    /// 写 DACL → 更新 folderLock.items → 联动账面固定 → 存盘 → 刷卡片徽章。
    /// 返回错误消息；null=成功。半途失败时回退清理该路径 ACE，避免状态不一致。
    /// </summary>
    public string? ApplyAcl(FolderCardViewModel? card, bool denyDelete, bool denyWrite, bool watchAlerts)
    {
        if (card == null) return "未选中任何文件夹。";
        var key = Path.TrimEndingDirectorySeparator(card.FullPath);
        try
        {
            FolderLockService.Protect(key, denyDelete, denyWrite);
        }
        catch (Exception ex)
        {
            try { FolderLockService.Unprotect(key); } catch { /* 尽力回退 */ }
            return $"ACL 设置失败（已回退清理）: {ex.Message}";
        }
        var cfg = LockCfg;
        cfg.WatchAlerts = watchAlerts;
        var item = cfg.Items.FirstOrDefault(i => string.Equals(
            Path.TrimEndingDirectorySeparator(i.TargetPath), key, StringComparison.OrdinalIgnoreCase));
        if (item == null) { item = new FolderLockItem { TargetPath = key }; cfg.Items.Add(item); }
        item.DenyDelete = denyDelete;
        item.DenyWrite = denyWrite;

        // 账面固定联动（强制勾选基础项）
        if (!IsLockedPath(key)) _config.Locked.Add(key);

        _configSvc.SaveConfig(_config);
        SyncWatchers();
        RefreshCardValidity(card);
        Log(denyDelete || denyWrite
            ? $"ACL 已保护 [{AclStrength(denyDelete, denyWrite)}]: {card.FullPath}"
            : $"已改为仅账面固定: {card.FullPath}");
        return null;
    }

    /// <summary>解除某路径全部保护（ACL + 账面固定 + 配置条目）；返回错误消息，null=成功。</summary>
    public string? RemoveAllProtection(string fullPath, FolderCardViewModel? card)
    {
        var key = Path.TrimEndingDirectorySeparator(fullPath);
        try { FolderLockService.Unprotect(key); }
        catch (Exception ex) { return $"解除失败: {ex.Message}"; }
        var cfg = _config.FolderLock;
        cfg?.Items.RemoveAll(i => string.Equals(
            Path.TrimEndingDirectorySeparator(i.TargetPath), key, StringComparison.OrdinalIgnoreCase));
        var idx = _config.Locked.FindIndex(l => string.Equals(
            Path.TrimEndingDirectorySeparator(l), key, StringComparison.OrdinalIgnoreCase));
        if (idx >= 0) _config.Locked.RemoveAt(idx);
        _configSvc.SaveConfig(_config);
        SyncWatchers();
        if (card != null) RefreshCardValidity(card);
        Log($"已解除全部保护: {fullPath}");
        return null;
    }

    /// <summary>按 config.folderLock 登记刷新卡片盾牌徽章（读快照无 IO；实际 ACE 一致性由启动自愈保证）。</summary>
    private void RefreshAclBadge(FolderCardViewModel card)
    {
        var key = Path.TrimEndingDirectorySeparator(card.FullPath);
        var item = _config.FolderLock?.Items.FirstOrDefault(i => string.Equals(
            Path.TrimEndingDirectorySeparator(i.TargetPath), key, StringComparison.OrdinalIgnoreCase));
        if (item == null || !(item.DenyDelete || item.DenyWrite))
        {
            card.IsAclProtected = false;
            card.AclTip = null;
            return;
        }
        card.IsAclProtected = true;
        card.AclTip = "ACL 已保护 · " + AclStrength(item.DenyDelete, item.DenyWrite);
    }

    /// <summary>用资源管理器打开选中文件夹。</summary>
    public void OpenSelected()
    {
        var card = SelectedCard;
        if (card == null) { Log("请先选中一个项目组或项目。", true); return; }
        if (!Directory.Exists(card.FullPath)) { Log($"文件夹不存在: {card.FullPath}", true); return; }
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", card.FullPath) { UseShellExecute = true });
            Log($"已打开: {card.FullPath}");
        }
        catch (Exception ex) { Log($"打开失败: {ex.Message}", true); }
    }

    /// <summary>把 TargetPath 加入当前活动页签收藏（kind: group/project）。</summary>
    public void AddFavorite(string kind) => AddFavoriteCore(kind, null, TargetPath);

    /// <summary>把指定路径加入当前活动页签收藏（拖入收藏区/输入框共用入口）。路径需为已存在的目录。</summary>
    public void AddFavoritePath(string kind, string? pathRaw) => AddFavoriteCore(kind, null, pathRaw);

    /// <summary>把文件夹加入指定页签（用于从面板外拖到页签上）。跨页签去重，存盘。</summary>
    public void AddFavoriteToTab(string kind, int tabIndex, string? pathRaw) => AddFavoriteCore(kind, tabIndex, pathRaw);

    /// <summary>收藏落地的单一实现（C2 去重）：tabIndex=null 表示"当前活动页签"，越界时报错；
    /// 指定 tabIndex 时越界静默返回（拖拽场景不打扰）。group/project 分支保留字段名差异，其余流程一致。
    /// config 落库 + 落盘在这里；UI 卡片经 AddCardToUI 补建。</summary>
    private void AddFavoriteCore(string kind, int? tabIndex, string? pathRaw)
    {
        var path = (pathRaw ?? "").Trim();
        if (path.Length == 0)
        {
            if (tabIndex == null) Log("请先输入文件夹路径。", true);
            return;
        }
        var full = new DirectoryInfo(path).FullName.TrimEnd('\\');
        if (!Directory.Exists(full)) { Log($"无效的文件夹: {path}", true); return; }

        if (kind == "group")
        {
            if (FindDuplicate(_config.GroupTabs.Select(t => t.Groups), full)) return;
            var gi = tabIndex ?? ActiveGroupTabIndex;
            if (gi < 0 || gi >= GroupTabs.Count)
            {
                if (tabIndex == null) Log("无有效的项目组页签。", true);
                return;
            }
            AddCardToUI("group", full, gi);
            _config.GroupTabs[gi].Groups.Add(full);
            _configSvc.SaveConfig(_config);
            Log(tabIndex == null ? $"已添加项目组: {full}" : $"已添加项目组到页签『{GroupTabs[gi].Name}』: {full}");
        }
        else
        {
            if (FindDuplicate(_config.ProjectTabs.Select(t => t.Projects), full)) return;
            var pi = tabIndex ?? ActiveProjectTabIndex;
            if (pi < 0 || pi >= ProjectTabs.Count)
            {
                if (tabIndex == null) Log("无有效的项目页签。", true);
                return;
            }
            AddCardToUI("project", full, pi);
            _config.ProjectTabs[pi].Projects.Add(full);
            _configSvc.SaveConfig(_config);
            Log(tabIndex == null ? $"已添加项目: {full}" : $"已添加项目到页签『{ProjectTabs[pi].Name}』: {full}");
        }
        Raise(nameof(GroupCount));
        Raise(nameof(ProjectCount));
        Raise(nameof(CurrentProjectCount));
    }

    /// <summary>仅建 UI 卡片并加入对应集合（config 已由调用方落库；新建/收藏两条路径共用）。</summary>
    private void AddCardToUI(string kind, string full, int tabIndex)
    {
        if (kind == "group")
        {
            if (tabIndex < 0 || tabIndex >= GroupTabs.Count) return;
            var card = MakeCard("group", full);
            RefreshCardValidity(card);   // 立即补齐存在性/链接徽章，不等下一次全量刷新
            GroupTabs[tabIndex].Items.Add(card);
            _allGroupCards.Add(card);
            return;
        }
        if (tabIndex < 0 || tabIndex >= ProjectTabs.Count) return;
        var pcard = MakeCard("project", full);
        RefreshCardValidity(pcard);
        ProjectTabs[tabIndex].Items.Add(pcard);
        _allProjectCards.Add(pcard);
    }

    private static bool FindDuplicate(IEnumerable<List<string>> tabs, string full)
        => FolderCreateService.FindDuplicate(tabs, full);

    /// <summary>删除当前选中收藏（从所在页签移除 + 存盘）。已锁定项不可删除。
    /// 已分配（存在有效链接）时先弹窗确认：是=解除分配后删除收藏；否=保留链接仅删除收藏。</summary>
    public void RemoveFavorite()
    {
        var card = SelectedCard;
        if (card == null) { Log("请先选择一个项目组或项目。", true); return; }
        if (card.IsLocked) { Log($"「{card.DisplayName}」已锁定，无法删除。", true); return; }
        var key = Path.TrimEndingDirectorySeparator(card.FullPath);
        var isGroup = card.Kind == "group";

        if (!RunPreRemoveCleanup(key, isGroup, card)) { Log("已取消删除。"); return; }

        if (isGroup)
        {
            var gi = ActiveGroupTabIndex;
            if (gi < 0 || gi >= GroupTabs.Count) return;
            var vmTab = GroupTabs[gi];
            var configTab = _config.GroupTabs[gi];
            if (RemoveCardFrom(vmTab.Items, _allGroupCards, key))
            {
                configTab.Groups.RemoveAll(p => string.Equals(TrimEnd(p), key, StringComparison.OrdinalIgnoreCase));
                _configSvc.SaveConfig(_config);
                ClearAllSelection();
                Log($"已删除项目组: {card.FullPath}");
            }
        }
        else
        {
            var pi = ActiveProjectTabIndex;
            if (pi < 0 || pi >= ProjectTabs.Count) return;
            var vmTab = ProjectTabs[pi];
            var configTab = _config.ProjectTabs[pi];
            if (RemoveCardFrom(vmTab.Items, _allProjectCards, key))
            {
                configTab.Projects.RemoveAll(p => string.Equals(TrimEnd(p), key, StringComparison.OrdinalIgnoreCase));
                _configSvc.SaveConfig(_config);
                ClearAllSelection();
                Log($"已删除项目: {card.FullPath}");
            }
        }
        Raise(nameof(GroupCount));
        Raise(nameof(ProjectCount));
        Raise(nameof(CurrentProjectCount));
    }

    /// <summary>删除收藏前的可选清理（链接/图标/颜色）。任一项命中即弹窗确认；
    /// 勾选=保留该项；取消勾选=删除时执行对应清理。返回 false 表示用户取消删除。</summary>
    private bool RunPreRemoveCleanup(string key, bool isGroup, FolderCardViewModel card)
    {
        var groupLinks = isGroup ? FindLinksToGroup(key) : null;
        var projectNames = isGroup ? null : ValidLinkNames(key);
        var hasLinks = isGroup ? groupLinks!.Count > 0 : projectNames!.Count > 0;
        bool hasIcon, hasColor;
        try { hasIcon = FolderIconService.HasCustomIcon(card.FullPath); } catch { hasIcon = false; }
        hasColor = HasTagColorRecord(key);

        if (!hasLinks && !hasIcon && !hasColor) return true;

        string msg;
        if (isGroup)
        {
            msg = $"项目组「{card.DisplayName}」";
            if (hasLinks)
            {
                var projCount = groupLinks!.Select(l => l.Project).Distinct(StringComparer.OrdinalIgnoreCase).Count();
                msg += $"正被 {projCount} 个项目的 {groupLinks!.Count} 个链接使用。";
            }
        }
        else
        {
            msg = $"项目「{card.DisplayName}」";
            if (hasLinks)
            {
                var names = projectNames!;
                var shown = string.Join("、", names.Take(4)) + (names.Count > 4 ? " 等" : "");
                msg += $"已被分配（{names.Count} 个链接：{shown}）。";
            }
        }

        var choice = Dialog.Service.ConfirmDeleteFavorite("删除收藏", msg, hasLinks, hasIcon, hasColor);
        if (choice == null) return false;

        if (hasLinks && !choice.KeepLinks)
        {
            var links = isGroup ? groupLinks! : projectNames!.Select(n => (key, n)).ToList();
            UnassignLinks(links);
            Log($"已解除 {links.Count} 个链接: {key}");
        }
        if (hasIcon && !choice.KeepIcon)
        {
            if (FolderIconService.RestoreDefaultIcon(card.FullPath))
                Log($"已恢复默认图标: {card.FullPath}");
            else
                Log($"恢复默认图标失败（目录可能被占用，可稍后手动还原）: {card.FullPath}", true);
        }
        if (hasColor && !choice.KeepColor)
            SetTagColor(card, null);

        return true;
    }

    /// <summary>该路径在 tagColors 中是否存在颜色记录。</summary>
    private bool HasTagColorRecord(string key)
    {
        try
        {
            var full = Norm(Path.GetFullPath(key));
            return _config.TagColors.Keys.Any(k => string.Equals(Norm(k), full, StringComparison.OrdinalIgnoreCase));
        }
        catch { return false; }
    }

    /// <summary>某项目下当前有效的链接名（junction 在盘）。</summary>
    private List<string> ValidLinkNames(string projectKey)
        => CollectLinkNames(projectKey)
            .Where(n => JunctionService.GetLinkState(projectKey, n) == JunctionService.LinkState.Valid)
            .ToList();

    /// <summary>扫描全部已知项目（账本 ∪ 扫描缓存 ∪ 项目卡），收集指向指定项目组的有效链接。</summary>
    private List<(string Project, string Name)> FindLinksToGroup(string groupKey)
    {
        var result = new List<(string Project, string Name)>();
        var gk = Norm(Path.GetFullPath(groupKey));
        var projects = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in _records)
        {
            try { projects.Add(Norm(_recSvc.ToAbsPath(r.Project))); } catch { /* 畸形记录跳过 */ }
        }
        foreach (var k in _scannedLinks.Keys) projects.Add(Norm(k));
        foreach (var c in _allProjectCards) projects.Add(Norm(c.FullPath));

        foreach (var p in projects)
        {
            foreach (var n in CollectLinkNames(p))
            {
                try
                {
                    if (JunctionService.GetLinkState(p, n) != JunctionService.LinkState.Valid) continue;
                    var t = JunctionService.ResolveTarget(JunctionService.LinkPath(p, n));
                    if (string.IsNullOrEmpty(t) || !Directory.Exists(t)) continue;
                    if (string.Equals(Norm(Path.GetFullPath(t)), gk, StringComparison.OrdinalIgnoreCase))
                        result.Add((p, n));
                }
                catch { /* 单个链接探测失败不阻断整体 */ }
            }
        }
        return result;
    }

    /// <summary>解除一批链接（按项目分组，ACL 锁定目录内经解锁窗口执行），并逐项目同步账本。</summary>
    private void UnassignLinks(List<(string Project, string Name)> links)
    {
        foreach (var grp in links.GroupBy(l => l.Project, StringComparer.OrdinalIgnoreCase))
        {
            var p = grp.Key;
            var names = grp.Select(l => l.Name).ToList();
            FolderLockService.WithUnlock(p, () =>
            {
                foreach (var n in names)
                {
                    try { JunctionService.RemoveLink(p, n); }
                    catch (Exception ex) { Log($"解除链接失败 {JunctionService.LinkPath(p, n)}：{ex.Message}", true); }
                }
            });
            SyncRecordAfterUnassign(p, names);
        }
        ReloadRecordsAndRefresh();
    }

    /// <summary>账本同步：把本次解除的链接名从该项目记录中剔除；无残留名字则移除整条记录。</summary>
    private void SyncRecordAfterUnassign(string projectKey, List<string> removedNames)
    {
        var rec = _records.FirstOrDefault(r =>
            string.Equals(Norm(_recSvc.ToAbsPath(r.Project)), projectKey, StringComparison.OrdinalIgnoreCase));
        if (rec == null) return;
        var remain = rec.GetLinkNames()
            .Where(n => !removedNames.Contains(n, StringComparer.OrdinalIgnoreCase))
            .ToList();
        if (remain.Count == 0)
            _recSvc.Remove(projectKey);
        else
            _recSvc.Upsert(projectKey, rec.Lib ?? projectKey, rec.Group ?? "",
                rec.Created ?? DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), remain);
    }

    private static bool RemoveCardFrom(ObservableCollection<FolderCardViewModel> tabItems,
        List<FolderCardViewModel> all, string key)
    {
        var card = tabItems.FirstOrDefault(c =>
            string.Equals(Path.TrimEndingDirectorySeparator(c.FullPath), key, StringComparison.OrdinalIgnoreCase));
        if (card == null) return false;
        tabItems.Remove(card);
        // 仅移除当前实例：同路径可能被收藏到多个页签，按路径 RemoveAll 会把其他页签的同路径卡
        // 也踢出索引池（脱离有效性刷新/清除选中/查找），与 Drag.cs RemoveCardFromTab 的先例一致。
        all.Remove(card);
        return true;
    }

    /// <summary>清除所有页签中不存在且未锁定的文件夹收藏。</summary>
    public void ClearInvalid()
    {
        int g = 0, p = 0;
        foreach (var tab in _config.GroupTabs)
        {
            var before = tab.Groups.Count;
            tab.Groups = tab.Groups.Where(x => IsValidOrLocked(x)).ToList();
            g += before - tab.Groups.Count;
        }
        foreach (var tab in _config.ProjectTabs)
        {
            var before = tab.Projects.Count;
            tab.Projects = tab.Projects.Where(x => IsValidOrLocked(x)).ToList();
            p += before - tab.Projects.Count;
        }
        if (g + p == 0) { Log("没有需要清除的无效文件夹（或均已锁定）。"); return; }
        _configSvc.SaveConfig(_config);
        RebuildAllCards();
        RefreshAllValidityAsync();
        Log($"已清除无效文件夹：项目组 {g} 个、项目 {p} 个（已锁定跳过）。");
    }

    private bool IsValidOrLocked(string path)
    {
        var key = Path.TrimEndingDirectorySeparator(path);
        if (Directory.Exists(key)) return true;
        return _config.Locked.Any(l => string.Equals(
            Path.TrimEndingDirectorySeparator(l), key, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>路径是否在锁定列表中（锁定项不可删除/移除）。</summary>
    private bool IsLockedPath(string path)
    {
        var key = Path.TrimEndingDirectorySeparator(path);
        return _config.Locked.Any(l => string.Equals(
            Path.TrimEndingDirectorySeparator(l), key, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>全量重建所有页签卡片（增删后保一致；会清空选中）。</summary>
    public void RebuildAllCards()
    {
        _allGroupCards.Clear();
        _allProjectCards.Clear();
        for (int i = 0; i < ProjectTabs.Count; i++)
        {
            ProjectTabs[i].Items.Clear();
            foreach (var p in _config.ProjectTabs[i].Projects)
            {
                var c = MakeCard("project", p);
                ProjectTabs[i].Items.Add(c);
                _allProjectCards.Add(c);
            }
        }
        for (int i = 0; i < GroupTabs.Count; i++)
        {
            GroupTabs[i].Items.Clear();
            foreach (var g2 in _config.GroupTabs[i].Groups)
            {
                var c = MakeCard("group", g2);
                GroupTabs[i].Items.Add(c);
                _allGroupCards.Add(c);
            }
        }
        ClearAllSelection();
        Raise(nameof(GroupCount));
        Raise(nameof(ProjectCount));
        Raise(nameof(CurrentProjectCount));
    }

    private static string Norm(string p) => Path.TrimEndingDirectorySeparator(p);

    private static string TrimEnd(string p) => Path.TrimEndingDirectorySeparator(p);

    // ---------------- 窗口/面板布局持久化 ----------------

    /// <summary>读取上次保存的布局（窗口宽高、四栏 star 比例、日志区高度）；无记录时返回 null。</summary>
    public (double? Width, double? Height, double[]? ColStars, double? LogRowHeight) LoadWindowLayout()
        => (_config.WindowWidth, _config.WindowHeight,
            _config.PanelColWidths?.ToArray(), _config.LogRowHeight);

    /// <summary>保存窗口/面板布局到 config 并落盘。</summary>
    public void SaveWindowLayout(double width, double height, double[] colStars, double logRowHeight)
    {
        _config.WindowWidth = width;
        _config.WindowHeight = height;
        _config.PanelColWidths = colStars.ToList();
        _config.LogRowHeight = logRowHeight;
        _configSvc.SaveConfig(_config);
    }

    /// <summary>读取三个浮层面板（设置/MCP/使用说明）上次保存的高度；无记录时返回 null。</summary>
    public (double? Settings, double? Mcp, double? Tips) LoadPanelHeights()
        => (_config.SettingsPanelHeight, _config.McpPanelHeight, _config.TipsPanelHeight);

    /// <summary>保存三个浮层面板高度到 config 并落盘（用户拖动面板底边调整后）。</summary>
    public void SavePanelHeights(double settings, double mcp, double tips)
    {
        _config.SettingsPanelHeight = settings;
        _config.McpPanelHeight = mcp;
        _config.TipsPanelHeight = tips;
        _configSvc.SaveConfig(_config);
    }

    // ---------------- 项目 / 项目组改名与搬家 ----------------

    /// <summary>改名 / 搬家共用的路径归一（完整路径 + 去尾斜杠，大小写不敏感匹配的依据）。</summary>
    private static string RelocKey(string p) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));

    /// <summary>改名输入校验（PromptDialog 实时提示与 RenameFolder 共用）：返回错误文案或 null。
    /// 单一实现源 = FolderCreateService.ValidateName（MCP 新建工具共用）。</summary>
    public string? ValidateRenameInput(string? raw) => FolderCreateService.ValidateName(raw);

    /// <summary>重命名选中的项目 / 项目组文件夹（成功返回 null，失败返回错误文案且零持久化变更）。</summary>
    public string? RenameFolder(FolderCardViewModel card, string? newName)
    {
        var vErr = ValidateRenameInput(newName);
        if (vErr != null) return vErr;
        var name = (newName ?? "").Trim();
        if (card == null) return "未选中任何项目 / 项目组。";
        var oldPath = RelocKey(card.FullPath);
        var parent = Path.GetDirectoryName(oldPath);
        if (string.IsNullOrEmpty(parent)) return "无法确定该文件夹的父目录。";
        var newPath = Path.Combine(parent, name);
        return RelocateCard(card, oldPath, newPath, folderNameChanged: true);
    }

    /// <summary>搬家调试打点（低频率手动操作，保留开关便于排查后整体关闭）。</summary>
    private static bool MoveDbgEnabled = true;
    private void MoveDbg(string msg) { if (MoveDbgEnabled) Log("[搬家调试] " + msg); }

    /// <summary>把选中的项目 / 项目组文件夹移动到 destDir（保持原名；成功返回 null）。</summary>
    public string? MoveFolder(FolderCardViewModel card, string destDir)
    {
        MoveDbg($"MoveFolder 进入: Card='{card?.DisplayName}' FullPath='{card?.FullPath}' Kind='{card?.Kind}'");
        if (card == null) { MoveDbg("return: card 为 null"); return "未选中任何项目 / 项目组。"; }
        if (string.IsNullOrWhiteSpace(destDir)) { MoveDbg("return: 目标目录为空"); return "目标目录不能为空。"; }
        if (!Directory.Exists(destDir)) { MoveDbg($"return: 目标目录不存在 {destDir}"); return $"目标目录不存在: {destDir}"; }
        var oldPath = RelocKey(card.FullPath);
        var oldName = Path.GetFileName(oldPath);
        if (string.IsNullOrEmpty(oldName)) { MoveDbg($"return: 无法确定文件夹名 oldPath={oldPath}"); return "无法确定该文件夹名称。"; }
        var newPath = RelocKey(Path.Combine(Path.GetFullPath(destDir), oldName));
        MoveDbg($"old='{oldPath}' new='{newPath}'");
        if (string.Equals(RelocKey(oldPath), newPath, StringComparison.OrdinalIgnoreCase)) { MoveDbg("return: 目标与当前位置相同"); return "目标位置与当前位置相同。"; }
        if (newPath.StartsWith(RelocKey(oldPath) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) { MoveDbg("return: 目标在自身子目录内"); return "不能把文件夹移动到它自己的子目录里。"; }
        MoveDbg("预检通过，进入 RelocateCard");
        return RelocateCard(card, oldPath, newPath, folderNameChanged: false);
    }

    /// <summary>在受保护目录局部摘锁（自祖先定位锁根）后执行 Directory.Move；成功返回 true，失败置 err。</summary>
    private static bool MoveUnlocked(string oldPath, string newPath, out string err)
    {
        string? caught = null;
        bool ok = FolderLockService.WithUnlockForPath(oldPath, () =>
        {
            try { Directory.Move(oldPath, newPath); return true; }
            catch (Exception ex) { caught = ex.Message; return false; }
        });
        err = caught ?? "";
        return ok;
    }

    /// <summary>物理位移 + 全引用更新 + 链接重建 的统一管线。移动本身失败则零改动返回；移动成功后各引用逐步落地。</summary>
    private string? RelocateCard(FolderCardViewModel card, string oldPath, string newPath, bool folderNameChanged)
    {
        MoveDbg($"RelocateCard 进入: old='{oldPath}' new='{newPath}'");
        if (!Directory.Exists(oldPath)) { MoveDbg($"return: 源不存在 {oldPath}"); return $"文件夹不存在，无法操作: {oldPath}"; }
        if (Directory.Exists(newPath) || File.Exists(newPath)) { MoveDbg($"return: 目标同名已存在 {newPath}"); return $"目标位置已存在同名文件夹 / 文件: {newPath}"; }
        if (!string.Equals(Path.GetPathRoot(oldPath), Path.GetPathRoot(newPath), StringComparison.OrdinalIgnoreCase))
            { MoveDbg($"return: 跨盘 oldRoot='{Path.GetPathRoot(oldPath)}' newRoot='{Path.GetPathRoot(newPath)}'"); return "目标位置与源不在同一磁盘分区，暂不支持跨盘搬家（请先复制再手动处理，或选择同盘目录）。"; }

        var isGroup = card.Kind == "group";
        var oldNorm = RelocKey(oldPath);
        var newNorm = RelocKey(newPath);
        MoveDbg($"isGroup={isGroup}");

        // 1. 物理移动：先记录原路径 ACL 保护状态（必须在摘锁窗口外读，窗口内已被临时摘除），
        //    再包 WithUnlockForPath（受 ACL 保护的目录/祖先运行时临时摘锁，移动后恢复）。
        bool aclDel = false, aclWr = false;
        try { var s = FolderLockService.GetState(oldPath); aclDel = s.DenyDelete; aclWr = s.DenyWrite; MoveDbg($"ACL 读取成功: DenyDelete={aclDel} DenyWrite={aclWr}"); }
        catch (Exception gex) { MoveDbg($"ACL GetState 读取异常: {gex.Message}"); }
        bool moved = false; string? moveErr = null;
        try
        {
            _watch.Suppress(oldPath, () => moved = MoveUnlocked(oldPath, newPath, out moveErr));
        }
        catch (Exception ex) { moveErr = ex.Message; }
        MoveDbg($"物理移动: moved={moved} moveErr='{moveErr}'");
        if (!moved) { MoveDbg($"return: 移动失败 moveErr='{moveErr}'"); return $"移动文件夹失败: {moveErr}"; }
        MoveDbg("物理移动成功");

        // 1.5 改名时同步重命名备份目录中的对应备份子目录（末级名对末级名）。
        var bakOp = RenameBackupFolder(isGroup, oldNorm, newNorm, folderNameChanged);

        // 2. 链接账本 + junction 重建：项目组改名/搬家须把指向旧路径的所有 junction 重建到新路径。
        //    项目搬家/改名只是其自身路径变更（junction 是其子项，随目录一并移动），仅改账本项目字段。
        var recs = _recSvc.LoadStrict();
        MoveDbg($"LoadStrict recs: {(recs == null ? "null(读取失败)" : recs.Count.ToString() + " 条")}");
        if (recs != null)
        {
            if (isGroup)
            {
                var newDisplay = folderNameChanged ? Path.GetFileName(newNorm)! : null;
                foreach (var r in recs)
                {
                    if (string.Equals(RelocKey(_recSvc.ToAbsPath(r.Lib)), oldNorm, StringComparison.OrdinalIgnoreCase))
                    {
                        MoveDbg($"匹配到组链接记录: Lib='{r.Lib}' Project='{r.Project}' Names=[{string.Join(",", r.GetLinkNames())}]");
                        var proj = _recSvc.ToAbsPath(r.Project);
                        foreach (var n in r.GetLinkNames())
                        {
                            var lp = JunctionService.LinkPath(proj, n);
                            string? tgt = null;
                            try { tgt = JunctionService.ResolveTarget(lp); } catch { }
                            if (tgt != null && string.Equals(RelocKey(tgt), oldNorm, StringComparison.OrdinalIgnoreCase))
                            {
                                try { JunctionService.RemoveLink(proj, n); JunctionService.Create(lp, newPath); }
                                catch (Exception ex) { Log($"重建链接 {JunctionService.LinkPath(proj, n)} 失败: {ex.Message}", true); }
                            }
                        }
                        r.Lib = _recSvc.ToRelPath(newPath);
                        if (folderNameChanged) r.Group = newDisplay;
                    }
                }
            }
            else
            {
                foreach (var r in recs)
                    if (string.Equals(RelocKey(_recSvc.ToAbsPath(r.Project)), oldNorm, StringComparison.OrdinalIgnoreCase))
                        r.Project = _recSvc.ToRelPath(newPath);
            }
            MoveDbg("链接账本处理后开始 Save");
            try { _recSvc.Save(recs); }
            catch (Exception ex) { MoveDbg($"return: 账本 Save 失败 {ex.Message}"); return $"更新链接记录失败（文件夹已移动，请刷新复查）: {ex.Message}"; }
            MoveDbg("账本 Save 成功");
        }

        // 3. 更新 config 内全部路径引用（页签 / 锁定 / ACL / 图标 / 标签色 / System 属性）。
        if (isGroup)
        {
            foreach (var t in _config.GroupTabs) RemapListPath(t.Groups, oldNorm, newNorm);
        }
        else
        {
            foreach (var t in _config.ProjectTabs) RemapListPath(t.Projects, oldNorm, newNorm);
        }
        RemapListPath(_config.Locked, oldNorm, newNorm);
        RemapListPath(_config.SystemAttribByTool, oldNorm, newNorm);
        if (_config.FolderLock is { } fl)
            foreach (var it in fl.Items)
                if (string.Equals(RelocKey(it.TargetPath), oldNorm, StringComparison.OrdinalIgnoreCase))
                    it.TargetPath = newNorm;
        foreach (var k in _config.GuiFolderIcons.Keys.Where(k => string.Equals(RelocKey(k), oldNorm, StringComparison.OrdinalIgnoreCase)).ToList())
        {
            _config.GuiFolderIcons[newNorm] = _config.GuiFolderIcons[k];
            _config.GuiFolderIcons.Remove(k);
        }
        foreach (var k in _config.TagColors.Keys.Where(k => string.Equals(RelocKey(k), oldNorm, StringComparison.OrdinalIgnoreCase)).ToList())
        {
            _config.TagColors[newNorm] = _config.TagColors[k];
            _config.TagColors.Remove(k);
        }

        // 4. 原路径受 ACL 保护 → 对新路径重建保护（WithUnlock 只在旧路径恢复，旧路径已消失）。
        if (aclDel || aclWr)
        {
            try { MoveDbg($"重设新路径 ACL 保护: new='{newPath}' Del={aclDel} Wr={aclWr}"); FolderLockService.Protect(newPath, aclDel, aclWr); }
            catch (Exception ex) { Log($"重设新路径 ACL 保护失败（启动时自愈兜底）: {ex.Message}", true); }
        }

        // 5. 落盘 + 重建卡片（新路径/新名）+ 重载账本并刷新。
        MoveDbg("config remap 完成，开始 SaveConfig");
        _configSvc.SaveConfig(_config);
        SyncWatchers();   // 改名后受保护路径已 Remap，重挂监控器（增量：移除旧路径 entry、挂新路径）
        RebuildIconColorLookups();
        RebuildAllCards();
        ReloadRecordsAndRefresh();
        Log($"已{(folderNameChanged ? "改名" : "搬家")}: {oldNorm} → {newNorm}" + (string.IsNullOrEmpty(bakOp) ? "" : $"；{bakOp}"));
        return null;
    }

    /// <summary>改名时把备份根目录下对应的备份子目录（末级名对末级名）一并重命名；返回日志文案。</summary>
    private string RenameBackupFolder(bool isGroup, string oldNorm, string newNorm, bool folderNameChanged)
    {
        if (!folderNameChanged) return "";
        var oldName = Path.GetFileName(oldNorm);
        var newName = Path.GetFileName(newNorm);
        if (string.IsNullOrEmpty(oldName) || string.IsNullOrEmpty(newName)
            || string.Equals(oldName, newName, StringComparison.OrdinalIgnoreCase)) return "";

        var backupRoot = BackupService.ResolveDir(
            isGroup ? _config.BackupGroupDir : _config.BackupProjectDir,
            isGroup ? BackupService.DefaultGroupDir : BackupService.DefaultProjectDir);
        var oldBak = RelocKey(Path.Combine(backupRoot, oldName));
        var newBak = RelocKey(Path.Combine(backupRoot, newName));
        if (!Directory.Exists(oldBak) || string.Equals(oldBak, newBak, StringComparison.OrdinalIgnoreCase)) return "";

        if (Directory.Exists(newBak))
        {
            Log($"备份目录改名被跳过：备份目标已存在同名目录「{newBak}」", true);
            return "";
        }
        try
        {
            bool done = FolderLockService.WithUnlockForPath(oldBak, () =>
            {
                try { Directory.Move(oldBak, newBak); return true; }
                catch { return false; }
            });
            if (done) return $"备份目录已同步改名：{oldBak} → {newBak}";
            Log($"备份目录改名失败：{oldBak} → {newBak}", true);
        }
        catch (Exception ex) { Log($"备份目录改名失败：{ex.Message}", true); }
        return "";
    }

    /// <summary>把 list 中与 oldNorm（归一完整路径）相等的条目原地替换为新路径。</summary>
    private static void RemapListPath(List<string>? list, string oldNorm, string newNorm)
    {
        if (list == null) return;
        for (int i = 0; i < list.Count; i++)
            if (string.Equals(RelocKey(list[i]), oldNorm, StringComparison.OrdinalIgnoreCase))
                list[i] = newNorm;
    }
}