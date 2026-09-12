using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using FenPeiXiangMuZu.Services;
using FenPeiXiangMuZu.ViewModels;
using FenPeiXiangMuZu.Views;

namespace FenPeiXiangMuZu;

    public partial class MainWindow : Window
    {
        /// <summary>侧边栏是否展开（展开=显示名称标签，收起=仅图标）。</summary>
        public static readonly DependencyProperty SidebarExpandedProperty =
            DependencyProperty.Register(nameof(SidebarExpanded), typeof(bool), typeof(MainWindow),
                new PropertyMetadata(false, OnSidebarExpandedChanged));

        public bool SidebarExpanded
        {
            get => (bool)GetValue(SidebarExpandedProperty);
            set => SetValue(SidebarExpandedProperty, value);
        }

        /// <summary>侧边栏单一数据源：图标列与名称列共用，数据驱动、杜绝镜像漂移（渲染交给 SidebarControl 组件）。</summary>
        private readonly ObservableCollection<SidebarItemModel> _sidebarItems = new();

        /// <summary>思维导图浮层左侧侧边栏数据源（复用 SidebarControl 组件，脑图自己的操作按钮，与主窗口侧边栏完全独立）。</summary>
        private readonly ObservableCollection<SidebarItemModel> _mindMapSidebarItems = new();

        /// <summary>标题栏「TIPS 左侧插件展示区」数据源：每个已注册插件一个入口按钮（titlebarPluginHost），激活态驱动入口高亮。</summary>
        private readonly ObservableCollection<PluginLauncherItem> _pluginLaunchers = new();

        /// <summary>切换前 项目组/AgentSkill 列像素宽度，用于切换后保持其宽度不变（仅项目列与日志区吸收宽度变化）。</summary>
        private double _fixedGroupPx, _fixedAgentPx;
        private bool _sidebarCompensateScheduled;

        private static void OnSidebarExpandedChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
            => ((MainWindow)d).OnSidebarExpandedChangedCore();

        private void OnSidebarExpandedChangedCore()
        {
            // 此刻布局尚未因侧边栏宽度变化而重排，记录的是切换前像素宽度
            _fixedGroupPx = colGroup.ActualWidth;
            _fixedAgentPx = colAgent.ActualWidth;
            // 立即把 项目组/AgentSkill 列钉成当前像素宽度：侧边栏宽度变化后的首次布局
            // 就按正确宽度排布，避免先按旧 star 比例错宽一帧（内容回绕+让位动画上滑）再被补偿拉回，
            // 造成集群分框「向下跳一下」的瞬态抖动。
            if (_fixedGroupPx > 0) colGroup.Width = new GridLength(_fixedGroupPx, GridUnitType.Pixel);
            if (_fixedAgentPx > 0) colAgent.Width = new GridLength(_fixedAgentPx, GridUnitType.Pixel);
            if (_sidebarCompensateScheduled) return;
            _sidebarCompensateScheduled = true;
            LayoutUpdated += OnLayoutUpdatedForCompensate;
        }

        private void OnLayoutUpdatedForCompensate(object? sender, EventArgs e)
        {
            LayoutUpdated -= OnLayoutUpdatedForCompensate;
            _sidebarCompensateScheduled = false;
            CompensateSidebarColumns();
        }

        /// <summary>重算列 star 比例使 项目组/AgentSkill/预览 保持原像素宽度，仅 项目列与日志区 吸收侧边栏宽度变化。</summary>
        private void CompensateSidebarColumns()
        {
            if (_fixedGroupPx <= 0 || _fixedAgentPx <= 0) return;
            double total = colProj.ActualWidth + colGroup.ActualWidth + colAgent.ActualWidth;
            if (total <= 0) return;
            double g = _fixedGroupPx / total * 100;
            double a = _fixedAgentPx / total * 100;
            double p = 100 - g - a;
            if (p < 1) return;   // 项目列过窄时放弃补偿，避免比例失衡
            colProj.Width = new GridLength(p, GridUnitType.Star);
            colGroup.Width = new GridLength(g, GridUnitType.Star);
            colAgent.Width = new GridLength(a, GridUnitType.Star);
            bcolLog.Width = new GridLength(p, GridUnitType.Star);
            bcolLog2.Width = new GridLength(g, GridUnitType.Star);
            bcolPreview.Width = new GridLength(a, GridUnitType.Star);
        }

        /// <summary>项目列编辑列表（幽灵按钮切换的页签管理面板）是否展开。</summary>
        public static readonly DependencyProperty IsProjectListEditingProperty =
            DependencyProperty.Register(nameof(IsProjectListEditing), typeof(bool), typeof(MainWindow), new PropertyMetadata(false));

        public bool IsProjectListEditing
        {
            get => (bool)GetValue(IsProjectListEditingProperty);
            set => SetValue(IsProjectListEditingProperty, value);
        }

        /// <summary>项目组列编辑列表（幽灵按钮切换的分框管理面板）是否展开。</summary>
        public static readonly DependencyProperty IsGroupListEditingProperty =
            DependencyProperty.Register(nameof(IsGroupListEditing), typeof(bool), typeof(MainWindow), new PropertyMetadata(false));

        public bool IsGroupListEditing
        {
            get => (bool)GetValue(IsGroupListEditingProperty);
            set => SetValue(IsGroupListEditingProperty, value);
        }

        private void OnToggleProjectEdit(object sender, RoutedEventArgs e) => IsProjectListEditing = !IsProjectListEditing;
        private void OnToggleGroupEdit(object sender, RoutedEventArgs e) => IsGroupListEditing = !IsGroupListEditing;

        public MainWindow(MainViewModel vm)
    {
        InitializeComponent();
        TrayBtnImage.Source = LoadTrayButtonImage();
        DataContext = vm;
        // 窗口（任务栏按钮）图标：优先自定义软件图标，无则回退内置默认（WindowStyle=None 下任务栏按钮据此显示）
        Icon = AppIconService.LoadAppIcon(vm.DataDir, vm.CustomAppIcon);
        vm.PropertyChanged += OnVmPropertyChanged;
        if (vm.Content != null) vm.Content.PreviewHandler = OnPreviewUpdated;
        ApplySavedLayout(vm);
        ApplyShortcuts(vm);
        vm.Shortcuts.Changed += OnShortcutsChanged;
        vm.ChainShortcutsChanged += OnShortcutsChanged;
        vm.RequestScrollToCard += OnRequestScrollToCard;
        PreviewKeyDown += OnWindowPreviewKeyDown;
        MouseRightButtonUp += OnCardMenuRequested;
        SizeChanged += OnWindowSizeChanged;
        StateChanged += OnWindowStateChanged;
        splitterProjGroup.DragCompleted += OnSplitterDragCompleted;
        splitterGroupAgent.DragCompleted += OnSplitterDragCompleted;
        splitterRow.DragCompleted += OnSplitterDragCompleted;
        RebuildSidebarItems();
        sidebar.SidebarItems = _sidebarItems;
        RebuildMindMapSidebar();
        mindMapSidebar.SidebarItems = _mindMapSidebarItems;
        mindMapPanel.InstallStateChanged += (_, _) => RebuildMindMapSidebar();
        RebuildTitlebarLaunchers();
        // chain 侧栏项或展示快捷键变化时重建侧边栏单一数据源（两列随之同步刷新）
        vm.PropertyChanged += (_, p) =>
        {
            if (p.PropertyName is nameof(MainViewModel.SidebarActions) or nameof(MainViewModel.ShowShortcuts))
                RebuildSidebarItems();
        };
    }

    // ---------------- 侧边栏单一数据源：图标列与名称列共用，杜绝镜像漂移 ----------------

    /// <summary>重建侧边栏项列表：静态操作项 + 分隔线 + Agent 连锁项 + 删除收藏，图标/名称两列同源渲染。</summary>
    private void RebuildSidebarItems()
    {
        _sidebarItems.Clear();
        if (DataContext is not MainViewModel vm) return;

        string? ShortcutOf(string key)
            => vm.ShowShortcuts && vm.ShortcutHints.TryGetValue(key, out var s) ? s : null;

        void AddOp(string name, string glyph, Action click, string? tooltip = null, string? shortcutKey = null, bool danger = false)
            => _sidebarItems.Add(new SidebarItemModel
            {
                Name = name,
                Glyph = glyph,
                Kind = SidebarItemKind.Operation,
                ToolTip = tooltip ?? name,
                Shortcut = shortcutKey == null ? null : ShortcutOf(shortcutKey),
                IsDanger = danger,
                Clicked = click,
            });

        void AddSep() => _sidebarItems.Add(new SidebarItemModel { Kind = SidebarItemKind.Separator });

        AddOp("刷新全部", "\uE72C", () => vm.RefreshAllCommand.Execute(null), "刷新全部有效性与链接标记", "RefreshValidity");
        AddOp("一键备份", "\uE74E", () => vm.BackupNowCommand.Execute(null), "一键备份：将全部项目/项目组文件夹增量同步到配置的备份目录（设置→基础设置）", "BackupNow");
        AddOp("清除无效", "\uE894", () => vm.ClearInvalidCommand.Execute(null), "清除无效文件夹", "ClearInvalid");
        AddSep();
        AddOp("打开选中", "\uE8DA", () => vm.OpenSelectedCommand.Execute(null), "打开选中文件夹", "OpenSelected");
        AddOp("ACL 锁定", "\uEA18", () => vm.LockToggleCommand.Execute(null), "ACL 保护设置：账面固定 / 防删除 / 只读（Ctrl+L）", "LockToggle");
        AddOp("改名", "\uE8AC", () => RenameFolder(), "重命名选中的项目 / 项目组文件夹", "RenameFolder");
        AddOp("搬家", "\uE8B7", () => MoveFolder(), "把选中的项目 / 项目组文件夹移动到其他目录（搬家）", "MoveFolder");
        AddOp("修改颜色", "\uE790", () => ChangeColor(), "修改选中项目 / 项目组标签颜色", "ChangeColor");
        AddOp("修改图标", "\uE70F", () => ChangeIcon(), "修改图标", "ChangeIcon");
        AddSep();

        foreach (var a in vm.SidebarActions)
        {
            var id = a.Id;
            _sidebarItems.Add(new SidebarItemModel
            {
                Name = a.Name,
                Glyph = a.Icon,
                Kind = SidebarItemKind.Chain,
                ToolTip = a.Name,
                Shortcut = (vm.ShowShortcuts && !string.IsNullOrEmpty(a.Shortcut)) ? a.ShortcutDisplay : null,
                Clicked = () => vm.ChainActionSendCommand.Execute(id),
            });
        }
        AddSep();
        AddOp("删除收藏", "\uE74D", () => vm.RemoveFavoriteCommand.Execute(null), "删除选中收藏（Delete）", "RemoveSelected", danger: true);
    }

    // ---------------- 思维导图浮层侧边栏（复用 SidebarControl，与主窗口侧边栏完全独立） ----------------

    /// <summary>重建脑图浮层左侧侧边栏：文件层操作 + 卸载（已启用时显示）。安装入口在面板占位叠层。</summary>
    private void RebuildMindMapSidebar()
    {
        _mindMapSidebarItems.Clear();
        if (DataContext is not MainViewModel vm) return;

        void AddOp(string name, string glyph, Action click, string? tooltip = null)
            => _mindMapSidebarItems.Add(new SidebarItemModel
            {
                Name = name,
                Glyph = glyph,
                Kind = SidebarItemKind.Operation,
                ToolTip = tooltip ?? name,
                Clicked = click,
            });

        AddOp("撤销", "\uE7A7", () => mindMapPanel.Undo(), "撤销上一步操作（Ctrl+Z）");
        AddOp("重做", "\uE7A6", () => mindMapPanel.Redo(), "重做已撤销的操作（Ctrl+Y）");
        AddOp("刷新", "\uE72C", () => mindMapPanel.Refresh(), "重新加载脑图页面");
        AddOp("展开一级", "\uE70E", () => mindMapPanel.ExpandSelected(1), "展开选中节点的下一层节点（更深层收起）");
        AddOp("展开二级", "\uE5DB", () => mindMapPanel.ExpandSelected(2), "展开选中节点的下两层节点（更深层收起）");
        AddOp("展开全部", "\uE8A3", () => mindMapPanel.ExpandSelected(0), "展开选中节点的全部节点");
        // 视图-展开级别：按层级从根展开画布（顶部工具栏原视图区按钮迁至此处；名称列显示层级，ToolTip 说明语义）
        AddOp("全部", "\uE8A3", () => mindMapPanel.ExpandToLevel(9999), "从根节点展开全部层级");
        AddOp("1级", "\uE70E", () => mindMapPanel.ExpandToLevel(1), "从根节点展开到一级");
        AddOp("2级", "\uE5DB", () => mindMapPanel.ExpandToLevel(2), "从根节点展开到二级");
        AddOp("3级", "\uE70E", () => mindMapPanel.ExpandToLevel(3), "从根节点展开到三级");
        AddOp("4级", "\uE5DB", () => mindMapPanel.ExpandToLevel(4), "从根节点展开到四级");
        AddOp("5级", "\uE70E", () => mindMapPanel.ExpandToLevel(5), "从根节点展开到五级");
        AddOp("6级", "\uE5DB", () => mindMapPanel.ExpandToLevel(6), "从根节点展开到六级");
        // 底部锚定分组：以下项（导入/导出/调试/卸载）置于侧边栏底部，由下向上排、顺序不变
        _mindMapSidebarItems.Add(new SidebarItemModel { Kind = SidebarItemKind.BottomAnchor });
        AddOp("导入", "\uE8B5", () => mindMapPanel.Import(), "从 XMind / JSON 文件导入思维导图（XMind 多画布原样还原）");
        // 导出：右键弹出导出方式菜单；左键保留原默认行为（直接进入 XMind 保存对话框）
        _mindMapSidebarItems.Add(new SidebarItemModel
        {
            Name = "导出",
            Glyph = "\uE898",
            Kind = SidebarItemKind.Operation,
            ToolTip = "把当前思维导图导出为文件（右键选择导出方式）",
            Clicked = () => mindMapPanel.Export(),
            Menu = BuildMindMapExportMenu(),
        });
        AddOp("调试", "\uE943", () => mindMapPanel.OpenDevTools(), "打开 WebView2 开发者控制台查看 JS 错误");
        if (vm.Plugins.IsInstalled(PluginService.KityMinderId))
        {
            _mindMapSidebarItems.Add(new SidebarItemModel { Kind = SidebarItemKind.Separator });
            AddOp("卸载", "\uE74D", () => mindMapPanel.Uninstall(), "停用思维导图组件");
        }
    }

    // ---------------- 标题栏插件展示区（TIPS 左侧）：数据驱动，每个已注册插件一个入口按钮 ----------------

    /// <summary>构造「导出」右键菜单：各导出方式 → mindMapPanel.ExportAs(格式)。</summary>
    private ContextMenu BuildMindMapExportMenu()
    {
        var menu = new ContextMenu();
        void Add(string name, string glyph, string format)
        {
            var item = new MenuItem
            {
                Header = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    Children =
                    {
                        new TextBlock { Text = glyph, FontFamily = new FontFamily("Segoe MDL2 Assets"), FontSize = 14, Foreground = new SolidColorBrush(Color.FromRgb(0xD9, 0xD9, 0xD9)), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) },
                        new TextBlock { Text = name, FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(0xE6, 0xED, 0xF3)) },
                    },
                },
            };
            item.Click += (_, _) => mindMapPanel.ExportAs(format);
            menu.Items.Add(item);
        }
        Add("XMind 文件", "\uE898", "xmind");
        Add("思维导图 JSON", "\uEA91", "json");
        Add("文本 (.txt)", "\uE8A5", "txt");
        Add("图片 (.png)", "\uEB9F", "png");
        Add("Markdown", "\uE70F", "md");
        return menu;
    }

    /// <summary>重建标题栏插件展示区（titlebarPluginHost）：当前注册思维导图入口；未来新增插件在此追加。</summary>
    private void RebuildTitlebarLaunchers()
    {
        _pluginLaunchers.Clear();
        _pluginLaunchers.Add(new PluginLauncherItem
        {
            Id = PluginService.KityMinderId,
            Name = "思维导图",
            Glyph = "\uE8A1",
            ToolTip = "思维导图（kityminder 插件，未安装时可在面板内安装）",
            Clicked = ToggleMindMapPanel,
        });
        titlebarPluginHost.ItemsSource = null;
        titlebarPluginHost.ItemsSource = _pluginLaunchers;
    }

    /// <summary>按插件 id 同步激活态（对应插件浮层打开时入口按钮高亮）。</summary>
    private void SetPluginLauncherActive(string id, bool active)
    {
        foreach (var it in _pluginLaunchers)
            if (it.Id == id) it.IsActive = active;
    }

    /// <summary>插件展示区入口按钮点击 → 执行该插件注册的打开动作。</summary>
    private void OnPluginLauncherClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is PluginLauncherItem it) it.Clicked?.Invoke();
    }

    /// <summary>脑图控件可见性调试：列出脑图浮层下所有控件，逐个取消勾选（隐藏）定位多余"底"层。</summary>
    private void OnMindMapDebugClick(object sender, RoutedEventArgs e)
        => MindMapControlVisibilityDialog.Show(this, "脑图控件可见性调试", mindMapPopup);

    // ---------------- 快捷键：按配置动态应用 KeyBinding（特性级互斥） ----------------

    /// <summary>平行功能特性标识：同一时刻仅一个特性激活，其快捷键生效，其余特性快捷键全部屏蔽。</summary>
    private const string FeatureAssign = "assign";   // 分配项目组
    private const string FeatureMindMap = "mindmap"; // 思维导图

    private string _activeFeature = FeatureAssign;
    private readonly Dictionary<string, (string Feature, KeyBinding Binding)> _shortcutBindings = new();

    /// <summary>按 config.shortcuts 重建快捷键 KeyBinding（先移除旧的，再按当前键位添加）。</summary>
    private void ApplyShortcuts(MainViewModel vm)
    {
        foreach (var kb in _shortcutBindings.Values.Select(v => v.Binding)) InputBindings.Remove(kb);
        _shortcutBindings.Clear();

        // —— 分配项目组特性快捷键：设置面板可自定义键位 + Agent 连锁动作自定义键位 ——
        foreach (var def in ShortcutCatalog.All)
        {
            var gesture = vm.Shortcuts.GetGesture(def.ActionKey);
            if (string.IsNullOrWhiteSpace(gesture)) continue;
            var command = GetShortcutCommand(vm, def.ActionKey);
            if (command == null) continue;
            try
            {
                if (new KeyGestureConverter().ConvertFromString(gesture) is KeyGesture g)
                    AddShortcutBinding(FeatureAssign, def.ActionKey, new KeyBinding(command, g));
            }
            catch { /* 非法键位串忽略，不崩窗口 */ }
        }

        foreach (var a in vm.ChainActions)
        {
            if (string.IsNullOrWhiteSpace(a.Shortcut)) continue;
            try
            {
                if (new KeyGestureConverter().ConvertFromString(a.Shortcut) is KeyGesture g)
                    AddShortcutBinding(FeatureAssign, "chain:" + a.Id,
                        new KeyBinding(vm.ChainActionSendCommand, g) { CommandParameter = a.Id });
            }
            catch { /* 非法键位串忽略 */ }
        }

        // —— 思维导图特性快捷键（当前为空，后续脑图键盘功能在此挂 FeatureMindMap 标签绑定）——
        RegisterMindMapShortcuts();

        // 只把当前激活特性的绑定挂上 InputBindings（其余特性保持摘除 = 互斥屏蔽）
        ApplyShortcutScope();
    }

    /// <summary>登记一条快捷键绑定并标记其所属特性。</summary>
    private void AddShortcutBinding(string feature, string key, KeyBinding kb)
        => _shortcutBindings[key] = (feature, kb);

    /// <summary>注册思维导图特性的快捷键（预留入口：新增脑图键盘功能时在此 AddShortcutBinding(FeatureMindMap, ...)）。</summary>
    private void RegisterMindMapShortcuts()
    {
    }

    /// <summary>切换激活特性：摘除全部绑定后，仅把当前特性的绑定挂回 InputBindings。</summary>
    private void SetActiveFeature(string feature)
    {
        if (_activeFeature == feature) return;
        _activeFeature = feature;
        ApplyShortcutScope();
    }

    /// <summary>同步 InputBindings 到当前激活特性：其余特性快捷键一律屏蔽。</summary>
    private void ApplyShortcutScope()
    {
        foreach (var (_, kb) in _shortcutBindings.Values) InputBindings.Remove(kb);
        foreach (var (f, kb) in _shortcutBindings.Values)
            if (f == _activeFeature) InputBindings.Add(kb);
    }

    /// <summary>动作键 → 命令映射（新增可自定义快捷键时在此追加）。
    /// VM 层命令走 vm.*；视图层（需要弹窗/面板访问）走本窗命令属性。</summary>
    private ICommand? GetShortcutCommand(MainViewModel vm, string actionKey) => actionKey switch
    {
        "LockToggle" => vm.LockToggleCommand,
        "OpenSelected" => vm.OpenSelectedCommand,
        "RemoveSelected" => vm.RemoveFavoriteCommand,
        "ClearInvalid" => vm.ClearInvalidCommand,
        "RefreshValidity" => vm.RefreshAllCommand,
        "GroupTabNext" => vm.GroupTabNextCommand,
        "GroupTabPrev" => vm.GroupTabPrevCommand,
        "ProjectTabNext" => vm.ProjectTabNextCommand,
        "ProjectTabPrev" => vm.ProjectTabPrevCommand,
        "SwitchToProjectPane" => vm.SwitchToProjectPaneCommand,
        "SwitchToGroupPane" => vm.SwitchToGroupPaneCommand,
        "BackupNow" => vm.BackupNowCommand,
        "ToggleSidebar" => ToggleSidebarCommand,
        "ToggleSettings" => ToggleSettingsCommand,
        "ToggleMcp" => ToggleMcpCommand,
        "ToggleTips" => ToggleTipsCommand,
        "OpenMarkdown" => OpenMarkdownCommand,
        "HideToTray" => HideToTrayCommand,
        "RenameFolder" => RenameFolderCommand,
        "MoveFolder" => MoveFolderCommand,
        "ChangeColor" => ChangeColorCommand,
        "ChangeIcon" => ChangeIconCommand,
        _ => null,
    };

    // 侧边栏 进入视图层 的 code-behind 动作命令：供快捷键 KeyBinding 复用同一逻辑
    //（按钮仍走 Click 处理器；快捷键只经命令触发同一方法，避免两套实现漂移）。
    private ICommand? _toggleSidebarCommand;
    private ICommand ToggleSidebarCommand => _toggleSidebarCommand ??= new RelayCommand(_ => ToggleSidebar());

    private ICommand? _renameFolderCommand;
    private ICommand RenameFolderCommand => _renameFolderCommand ??= new RelayCommand(_ => RenameFolder());

    private ICommand? _moveFolderCommand;
    private ICommand MoveFolderCommand => _moveFolderCommand ??= new RelayCommand(_ => MoveFolder());

    private ICommand? _changeColorCommand;
    private ICommand ChangeColorCommand => _changeColorCommand ??= new RelayCommand(_ => ChangeColor());

    private ICommand? _changeIconCommand;
    private ICommand ChangeIconCommand => _changeIconCommand ??= new RelayCommand(_ => ChangeIcon());

    private ICommand? _toggleSettingsCommand;
    private ICommand ToggleSettingsCommand => _toggleSettingsCommand ??= new RelayCommand(_ => ToggleSettingsPanel());

    private ICommand? _toggleMcpCommand;
    private ICommand ToggleMcpCommand => _toggleMcpCommand ??= new RelayCommand(_ => ToggleMcpPanel());

    private ICommand? _toggleTipsCommand;
    private ICommand ToggleTipsCommand => _toggleTipsCommand ??= new RelayCommand(_ => ToggleTipsPanel());

    private ICommand? _hideToTrayCommand;
    private ICommand HideToTrayCommand => _hideToTrayCommand ??= new RelayCommand(_ => HideToTray());

    private ICommand? _openMarkdownCommand;
    private ICommand OpenMarkdownCommand => _openMarkdownCommand ??= new RelayCommand(_ => OpenMarkdownEditor());

    private Portable.MarkdownEditor.MarkdownEditorWindow? _mdEditor;

    private void ToggleSidebar() => SidebarExpanded = !SidebarExpanded;

    /// <summary>设置面板改动快捷键后重新应用。</summary>
    private void OnShortcutsChanged(object? sender, EventArgs e)
    {
        if (DataContext is MainViewModel vm) ApplyShortcuts(vm);
    }

    // ---------------- 窗口/面板布局：启动恢复 + 改变后防抖保存 ----------------

    private DispatcherTimer? _layoutSaveTimer;

    private void ApplySavedLayout(MainViewModel vm)
    {
        var (w, h, cols, logH) = vm.LoadWindowLayout();
        var wa = SystemParameters.WorkArea;
        if (w is > 0 && h is > 0)
        {
            Width = Math.Min(w.Value, wa.Width);
            Height = Math.Min(h.Value, wa.Height);
        }
        else
        {
            // D1：无存档首启也按工作区收敛，避免 2048×1312 设计值在小屏上溢出
            Width = Math.Min(Width, wa.Width);
            Height = Math.Min(Height, wa.Height);
        }
        if (cols is { Length: >= 3 } && cols.Take(3).All(c => c > 0)) ApplyColumnStars(cols);
        if (logH is > 0) logRow.Height = new GridLength(logH.Value);
        var (sH, mH, tH) = vm.LoadPanelHeights();
        if (sH is > 0) settingsPopup.Height = sH.Value;
        if (mH is > 0) mcpPopup.Height = mH.Value;
        if (tH is > 0) tipsPopup.Height = tH.Value;
    }

    private void OnWindowSizeChanged(object sender, SizeChangedEventArgs e)
    {
        ScheduleLayoutSave();
    }

    private void OnSplitterDragCompleted(object sender, DragCompletedEventArgs e)
    {
        ScheduleLayoutSave();
    }

    /// <summary>防抖保存：最后一次变化后 400ms 落盘，避免拖拽过程中频繁写文件。</summary>
    private void ScheduleLayoutSave()
    {
        if (_layoutSaveTimer == null)
        {
            _layoutSaveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
            _layoutSaveTimer.Tick += (_, _) => SaveLayoutNow();
        }
        _layoutSaveTimer.Stop();
        _layoutSaveTimer.Start();
    }

    private void SaveLayoutNow()
    {
        _layoutSaveTimer?.Stop();
        if (DataContext is not MainViewModel vm) return;
        if (WindowState == WindowState.Maximized) return;   // 最大化尺寸随屏幕变化，不记录
        double logH = logRow.ActualHeight > 0 ? logRow.ActualHeight : logRow.Height.Value;
        vm.SaveWindowLayout(ActualWidth, ActualHeight, GetColumnStars(), logH);
    }

    /// <summary>按当前实际像素宽度换算三栏 star 比例（100 为满宽）。</summary>
    private double[] GetColumnStars()
    {
        double w0 = colProj.ActualWidth, w1 = colGroup.ActualWidth, w2 = colAgent.ActualWidth;
        double total = w0 + w1 + w2;
        if (total <= 0) return new[] { 20.0, 20.0, 46.0 };
        return new[] { w0 / total * 100, w1 / total * 100, w2 / total * 100 };
    }

    /// <summary>把三栏 star 比例同时应用到上区与底部网格（保持上下对齐）；兼容旧版四栏存档（取前三项）。</summary>
    private void ApplyColumnStars(double[] stars)
    {
        if (stars.Length < 3) return;
        colProj.Width = new GridLength(stars[0], GridUnitType.Star);
        colGroup.Width = new GridLength(stars[1], GridUnitType.Star);
        colAgent.Width = new GridLength(stars[2], GridUnitType.Star);
        bcolLog.Width = new GridLength(stars[0], GridUnitType.Star);
        bcolLog2.Width = new GridLength(stars[1], GridUnitType.Star);
        bcolPreview.Width = new GridLength(stars[2], GridUnitType.Star);
    }

    // ---------------- 页签：新增 / 删除 / 重命名（项目组列 / 项目列各自处理） ----------------

    private void OnAddGroupTabClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        try { vm.AddGroupTab(); }
        catch (Exception ex) { CaptureActionError("新增项目组集群", ex); }
    }

    private void OnAddProjectTabClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        try { vm.AddProjectTab(); }
        catch (Exception ex) { CaptureActionError("新增项目页签", ex); }
    }

    /// <summary>单击链接行上的齿轮按钮：弹出链接多选面板（可勾选建链/取消勾选删链），确认后应用。</summary>
    private void OnEditLinkName(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        if ((sender as FrameworkElement)?.DataContext is not ProjectLinkRowViewModel row) return;
        if (string.IsNullOrEmpty(row.ProjectFullPath)) return;
        var projKey = System.IO.Path.TrimEndingDirectorySeparator(row.ProjectFullPath);
        var projectName = System.IO.Path.GetFileName(projKey);
        var options = vm.BuildLinkPickOptions(row.ProjectFullPath, false, row.GroupPath);
        var chosen = LinkPickDialog.Show("编辑链接",
            $"为「{projectName}」选择要创建的链接（固定项在前，可多选）", options);
        if (chosen == null) return; // 取消，不做任何建链/删链
        try
        {
            var err = vm.ApplyLinkPick(row.ProjectFullPath, row.GroupPath, row.Group, chosen);
            if (err != null) vm.Message = $"更新链接失败：{err}";
        }
        catch (Exception ex) { CaptureActionError("编辑链接", ex); }
    }

    /// <summary>新增/保存这类落盘+重建操作若触发瞬时异常，写文件定位并只弹一次，避免刷屏。</summary>
    private static void CaptureActionError(string op, Exception ex)
    {
        try
        {
            System.IO.File.AppendAllText(
                System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fpx_add_err.txt"),
                $"[{DateTime.Now:HH:mm:ss.fff}] {op}\n{ex}\n------------------\n");
        }
        catch { }
        MessageBox.Show($"{op} 失败：\n{ex.Message}", "分配项目组", MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private void OnRemoveProjectTabClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        vm.Message = vm.RemoveProjectTab(vm.ActiveProjectTabIndex)
            ? "已删除当前项目页签。" : "删除失败（至少保留一个页签）。";
    }

    /// <summary>页签上的 × 关闭按钮：删除该页签（阻止冒泡避免误触发页签切换）。</summary>
    private void OnTabCloseClick(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        if (DataContext is not MainViewModel vm) return;
        if ((sender as FrameworkElement)?.Tag is not TabViewModel t) return;
        int idx = vm.ProjectTabs.IndexOf(t);
        if (idx < 0) return;
        vm.Message = vm.RemoveProjectTab(idx) ? $"已删除项目页签: {t.Name}" : "删除失败（至少保留一个页签）。";
    }

    /// <summary>分框标题栏右侧：删除该分组所在的分框（暂保留，待其他删除方案接入）。</summary>
    private void OnRemoveBoxClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        if ((sender as FrameworkElement)?.DataContext is not TabViewModel t) return;
        int idx = vm.GroupTabs.IndexOf(t);
        if (idx < 0) return;
        vm.Message = vm.RemoveGroupTab(idx) ? $"已删除项目组集群: {t.Name}" : "删除失败（至少保留一个项目组集群）。";
    }

    /// <summary>分框标题栏右侧：折叠/展开该组分框（原删除按钮改为此功能）。</summary>
    private void OnToggleGroupCollapse(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not TabViewModel tab) return;
        tab.IsCollapsed = !tab.IsCollapsed;
    }

    /// <summary>标题栏一键展开/收起全部项目组集群：有折叠的 → 全部展开，否则全部折叠。</summary>
    private void OnToggleExpandAllGroups(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        bool anyCollapsed = vm.GroupTabs.Any(t => t.IsCollapsed);
        foreach (var t in vm.GroupTabs) t.IsCollapsed = !anyCollapsed;
    }

    /// <summary>标题栏一键展开/收起全部项目（链接信息展开态）：有收起的 → 全部展开，否则全部收起。</summary>
    private void OnToggleExpandAllProjects(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        bool anyCollapsed = vm.CurrentProjectCards.Any(c => !c.IsExpanded);
        foreach (var c in vm.CurrentProjectCards) c.IsExpanded = anyCollapsed;
    }

    /// <summary>标题栏按下：仅文字区走延迟定时器（区分双击重命名）；非文字区由抬起事件立即折叠。文字双击编辑见 OnGroupBoxTextDoubleClick。</summary>
    private DispatcherTimer? _groupHeaderTimer;
    private TabViewModel? _groupHeaderTab;

    private void OnGroupBoxHeaderClick(object sender, MouseButtonEventArgs e)
    {
        Dbg($"HeaderClick: click={e.ClickCount} src={e.OriginalSource?.GetType().Name} dc={(sender as FrameworkElement)?.DataContext?.GetType().Name}");
        // 点击文字区域内的输入框（编辑中）或折叠按钮时不触发折叠，交给对应控件处理
        if (e.OriginalSource is DependencyObject src
            && (FindAncestor<TextBox>(src) != null || FindAncestor<Button>(src) != null)) return;

        // 非文字区（标题栏空白处）：按下时不动作，交由抬起事件立即切换（无延迟）
        if (e.OriginalSource is DependencyObject src2 && FindVisualParentTagged(src2, "GroupHeaderText") == null) return;

        if ((sender as FrameworkElement)?.DataContext is not TabViewModel tab) return;

        if (e.ClickCount == 2)
        {
            // 双击标题文字：取消待执行的单击折叠（重命名在 OnGroupBoxTextDoubleClick 处理）
            CancelGroupHeaderTimer();
            return;
        }

        if (e.ClickCount == 1)
        {
            // 单击标题文字：延迟切换折叠，等待可能的双击重命名或按住拖动
            CancelGroupHeaderTimer();
            _groupHeaderTab = tab;
            _groupHeaderTimer = new DispatcherTimer
            {
                Interval = TimeSpan.FromMilliseconds(250)
            };
            _groupHeaderTimer.Tick += OnGroupHeaderTimerTick;
            _groupHeaderTimer.Start();
            Dbg($"HeaderClick: timer started for {tab.Name}");
        }
    }

    /// <summary>标题栏抬起：非文字、非按钮/输入框、未进入拖拽时立即折叠/展开（与折叠按钮同速，零延迟）。</summary>
    private void OnGroupBoxHeaderUp(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount != 1) return;   // 双击的第二下抬起不重复切换
        if (_drag is { IsDragging: true }) return;
        if (e.OriginalSource is not DependencyObject src) return;
        // 文字区走延迟路径；按钮/输入框自行处理
        if (FindVisualParentTagged(src, "GroupHeaderText") != null
            || FindAncestor<TextBox>(src) != null || FindAncestor<Button>(src) != null) return;
        if ((sender as FrameworkElement)?.DataContext is not TabViewModel tab) return;
        tab.IsCollapsed = !tab.IsCollapsed;
    }

    /// <summary>标题文字双击：进入内联重命名并聚焦输入框（文字单击折叠由标题栏处理）。</summary>
    private void OnGroupBoxTextDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount != 2) return;
        if ((sender as FrameworkElement)?.DataContext is not TabViewModel tab) return;
        Dbg($"TextDoubleClick: enter edit for {tab.Name}");
        CancelGroupHeaderTimer();
        _drag = null;   // 进入编辑，避免后续移动误触发拖拽
        tab.IsEditing = true;
        var tb = FindVisualChild<TextBox>((DependencyObject)sender);
        if (tb != null)
            tb.Dispatcher.BeginInvoke(new System.Action(() => { tb.Focus(); tb.SelectAll(); }), DispatcherPriority.Render);
    }

    private void OnGroupHeaderTimerTick(object? sender, EventArgs e)
    {
        var tab = _groupHeaderTab;
        CancelGroupHeaderTimer();
        Dbg($"HeaderTimerTick: tab={(tab == null ? "NULL" : tab.Name)} drag={(_drag?.IsDragging == true)}");
        if (tab == null) return;
        if (_drag is { IsDragging: true }) return;   // 正在拖动，不折叠
        tab.IsCollapsed = !tab.IsCollapsed;
    }

    private void CancelGroupHeaderTimer()
    {
        if (_groupHeaderTimer != null)
        {
            _groupHeaderTimer.Stop();
            _groupHeaderTimer.Tick -= OnGroupHeaderTimerTick;
            _groupHeaderTimer = null;
        }
        _groupHeaderTab = null;
    }

    /// <summary>项目组集群重命名输入框：Enter 提交、Esc 取消。</summary>
    private void OnGroupBoxNameKeyDown(object sender, KeyEventArgs e)
    {
        if (sender is not TextBox tb || tb.DataContext is not TabViewModel tab) return;
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            tab.IsEditing = false;
            CommitGroupBoxRename(tab, tb.Text);
        }
        else if (e.Key == Key.Escape)
        {
            e.Handled = true;
            tab.IsEditing = false;
        }
    }

    /// <summary>项目组集群重命名输入框失焦：提交。</summary>
    private void OnGroupBoxNameLostFocus(object sender, RoutedEventArgs e)
    {
        if (sender is not TextBox tb || tb.DataContext is not TabViewModel tab || !tab.IsEditing) return;
        CommitGroupBoxRename(tab, tb.Text);
        tab.IsEditing = false;
    }

    private void CommitGroupBoxRename(TabViewModel tab, string newName)
    {
        if (DataContext is not MainViewModel vm) return;
        var idx = vm.GroupTabs.IndexOf(tab);
        if (idx < 0) return;
        var ok = vm.RenameGroupTab(idx, newName);
        vm.Message = ok ? $"已重命名项目组集群为: {newName}" : "重命名失败（空名或重名）。";
    }

    /// <summary>双击项目页签：进入内联重命名（显示 TextBox，隐藏名称 TextBlock 并聚焦）。</summary>
    private void OnProjectTabDoubleClick(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn || btn.DataContext is not TabViewModel tab) return;
        tab.IsEditing = true;
        var tb = FindVisualChild<TextBox>(btn);
        if (tb != null)
            tb.Dispatcher.BeginInvoke(new System.Action(() => { tb.Focus(); tb.SelectAll(); }), DispatcherPriority.Render);
    }

    /// <summary>重命名输入框：Enter 提交、Esc 取消。</summary>
    private void OnProjectTabNameKeyDown(object sender, KeyEventArgs e)
    {
        if (sender is not TextBox tb || tb.DataContext is not TabViewModel tab) return;
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            tab.IsEditing = false;
            CommitProjectTabRename(tab, tb.Text);
        }
        else if (e.Key == Key.Escape)
        {
            e.Handled = true;
            tab.IsEditing = false;
        }
    }

    /// <summary>重命名输入框失焦：提交（与 Enter 一致）。</summary>
    private void OnProjectTabNameLostFocus(object sender, RoutedEventArgs e)
    {
        if (sender is not TextBox tb || tb.DataContext is not TabViewModel tab || !tab.IsEditing) return;
        CommitProjectTabRename(tab, tb.Text);
        tab.IsEditing = false;
    }

    private void CommitProjectTabRename(TabViewModel tab, string newName)
    {
        if (DataContext is not MainViewModel vm) return;
        int idx = vm.ProjectTabs.IndexOf(tab);
        if (idx < 0) return;
        var ok = vm.RenameProjectTab(idx, newName);
        vm.Message = ok ? $"已重命名项目页签为: {newName}" : "重命名失败（空名或重名）。";
    }

    private static T? FindVisualChild<T>(DependencyObject parent) where T : DependencyObject
    {
        for (int i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is T t) return t;
            var inner = FindVisualChild<T>(child);
            if (inner != null) return inner;
        }
        return null;
    }

    /// <summary>沿视觉树向上查找指定类型的祖先（含自身），用于排除标题栏内按钮/输入框的点击。
    /// 经 GetParent 保护版：OriginalSource 为 ContentElement（如 Run）时先跨逻辑树，避免 VisualTreeHelper 抛异常。</summary>
    private static T? FindAncestor<T>(DependencyObject? current) where T : DependencyObject
    {
        while (current != null)
        {
            if (current is T t) return t;
            current = current is System.Windows.ContentElement ce ? LogicalTreeHelper.GetParent(ce) : VisualTreeHelper.GetParent(current);
        }
        return null;
    }

    /// <summary>编辑列表中双击名称（任意元素触发均可）：进入内联重命名并聚焦输入框。</summary>
    private void OnEditNameDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount != 2) return;
        if ((sender as FrameworkElement)?.DataContext is not TabViewModel tab) return;
        tab.IsListEditing = true;
        var root = ((FrameworkElement)sender).Parent as DependencyObject ?? (DependencyObject)sender;
        var tb = FindVisualChild<TextBox>(root);
        if (tb != null)
            tb.Dispatcher.BeginInvoke(new System.Action(() => { tb.Focus(); tb.SelectAll(); }), DispatcherPriority.Render);
    }

    /// <summary>编辑列表条目删除（× 按钮）：按所属列表类型删除对应页签/分框。</summary>
    private void OnEditListItemDeleteClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not TabViewModel tab) return;
        var vm = DataContext as MainViewModel; if (vm == null) return;
        var lb = FindVisualParent<ListBox>((DependencyObject)sender);
        if (lb?.Tag as string == "group")
        {
            int idx = vm.GroupTabs.IndexOf(tab);
            if (idx >= 0)
                vm.Message = vm.RemoveGroupTab(idx) ? $"已删除项目组集群: {tab.Name}" : "删除失败（至少保留一个项目组集群）。";
        }
        else
        {
            int idx = vm.ProjectTabs.IndexOf(tab);
            if (idx >= 0)
                vm.Message = vm.RemoveProjectTab(idx) ? $"已删除项目页签: {tab.Name}" : "删除失败（至少保留一个页签）。";
        }
    }

    /// <summary>编辑列表内联重命名：Enter 提交、Esc 取消（按所属列表类型路由到对应 VM 重命名）。</summary>
    private void OnEditNameKeyDown(object sender, KeyEventArgs e)
    {
        if (sender is not TextBox tb || tb.DataContext is not TabViewModel tab) return;
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            tab.IsListEditing = false;
            CommitEditRename(tb, tab, tb.Text);
        }
        else if (e.Key == Key.Escape)
        {
            e.Handled = true;
            tab.IsListEditing = false;
        }
    }

    /// <summary>编辑列表内联重命名输入框失焦：提交。</summary>
    private void OnEditNameLostFocus(object sender, RoutedEventArgs e)
    {
        if (sender is not TextBox tb || tb.DataContext is not TabViewModel tab || !tab.IsListEditing) return;
        CommitEditRename(tb, tab, tb.Text);
        tab.IsListEditing = false;
    }

    private void CommitEditRename(TextBox tb, TabViewModel tab, string newName)
    {
        var vm = DataContext as MainViewModel; if (vm == null) return;
        var lb = FindVisualParent<ListBox>(tb);
        if (lb?.Tag as string == "group")
        {
            int idx = vm.GroupTabs.IndexOf(tab);
            if (idx >= 0)
                vm.Message = vm.RenameGroupTab(idx, newName) ? $"已重命名项目组集群为: {newName}" : "重命名失败（空名或重名）。";
        }
        else
        {
            int idx = vm.ProjectTabs.IndexOf(tab);
            if (idx >= 0)
                vm.Message = vm.RenameProjectTab(idx, newName) ? $"已重命名项目页签为: {newName}" : "重命名失败（空名或重名）。";
        }
    }

    // ---------------- 编辑列表拖拽排序 ----------------

    private object? _dragItem;
    private ListBox? _dragListBox;
    private Point _dragStart;

    // ---------------- 图标/颜色非模态常驻面板 ----------------

    private Views.IconPickDialog? _iconPanel;
    private Views.ColorPickDialog? _colorPanel;

    /// <summary>拖拽手柄按下：记录被拖动的页签/分框及其所属 ListBox。</summary>
    private void OnEditGripPreviewMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.LeftButton != MouseButtonState.Pressed) return;
        var orig = (DependencyObject)e.OriginalSource;
        if (FindVisualParent<Button>(orig) != null) return;   // 删除按钮：不发起拖动
        if (FindVisualParent<TextBox>(orig) != null) return;  // 重命名输入框：不发起拖动
        if ((sender as FrameworkElement)?.DataContext is not TabViewModel tab) return;
        _dragItem = tab;
        _dragListBox = FindVisualParent<ListBox>((DependencyObject)sender);
        if (_dragListBox != null) _dragStart = e.GetPosition(_dragListBox);
    }

    /// <summary>列表内移动超过阈值即发起拖拽。</summary>
    private void OnEditListMouseMove(object sender, MouseEventArgs e)
    {
        if (_dragItem is null || _dragListBox is null || e.LeftButton != MouseButtonState.Pressed) return;
        var pos = e.GetPosition(_dragListBox);
        if (Math.Abs(pos.X - _dragStart.X) < 4 && Math.Abs(pos.Y - _dragStart.Y) < 4) return;
        DragDrop.DoDragDrop(_dragListBox, _dragItem, DragDropEffects.Move);
    }

    private void OnEditListDragOver(object sender, DragEventArgs e)
    {
        e.Effects = _dragItem != null ? DragDropEffects.Move : DragDropEffects.None;
        e.Handled = true;
    }

    /// <summary>拖放结束：计算目标位置并调用 VM 调整顺序。</summary>
    private void OnEditListDrop(object sender, DragEventArgs e)
    {
        if (sender is not ListBox lb || _dragItem is not TabViewModel fromTab) { _dragItem = null; return; }
        var targetItem = FindVisualParent<ListBoxItem>((DependencyObject)e.OriginalSource)?.DataContext as TabViewModel;
        if (targetItem is null || ReferenceEquals(targetItem, fromTab)) { _dragItem = null; return; }
        var vm = DataContext as MainViewModel; if (vm == null) { _dragItem = null; return; }
        if (lb.Tag as string == "group")
        {
            int from = vm.GroupTabs.IndexOf(fromTab);
            int to = vm.GroupTabs.IndexOf(targetItem);
            vm.MoveTab("group", from, to);   // 统一走 Drag.MoveTab 单一实现（含 config 活动索引双写）
        }
        else
        {
            int from = vm.ProjectTabs.IndexOf(fromTab);
            int to = vm.ProjectTabs.IndexOf(targetItem);
            vm.MoveTab("project", from, to);   // 同上
        }
        _dragItem = null;
    }

    // ---------------- 自定义图标（对应 PS Set-FolderCustomIcon / Restore-FolderDefaultIcon） ----------------

    /// <summary>主面板选中卡片变化时，把已打开的非模态面板同步切到新目标（只改标题/状态，不触发面板回调）。</summary>
    private void OnVmPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        if (e.PropertyName != nameof(MainViewModel.SelectedCard)) return;
        var card = vm.SelectedCard;
        if (_colorPanel != null)
        {
            var kindName = card == null ? "（未选中）" : (card.Kind == "group" ? "项目组" : "项目");
            _colorPanel.SyncToTarget(
                $"修改颜色 —— {kindName}: {card?.DisplayName ?? "无"}",
                card == null ? null : vm.FindTagColor(card.FullPath));
        }
        if (_iconPanel != null)
            _iconPanel.UpdateTarget($"选择图标 —— 当前：{card?.DisplayName ?? "（未选中）"}");
    }

    /// <summary>侧边栏常驻选择面板互斥：关闭除 keep 外的全部面板（图标/颜色）。</summary>
    private void ClosePickPanelsExcept(Window? keep)
    {
        if (_iconPanel != null && !ReferenceEquals(_iconPanel, keep)) _iconPanel.Close();
        if (_colorPanel != null && !ReferenceEquals(_colorPanel, keep)) _colorPanel.Close();
    }

    /// <summary>打开非模态图标选择面板（侧边栏按钮与快捷键共用），逻辑见 ChangeIcon。</summary>
    private void OnChangeIconClick(object sender, RoutedEventArgs e) => ChangeIcon();

    private void ChangeIcon()
    {
        try
        {
            if (DataContext is not MainViewModel vm) return;
            if (_iconPanel != null) { _iconPanel.Close(); return; }   // 再点同按钮 = 关闭面板（toggle）
            ClosePickPanelsExcept(null);                              // 互斥：打开前先关其他选择面板

            // 构建预设分组快照（打开时取一次；分组名供系统/剪贴板页签「加入分组」单选用）
            var groups = vm.PresetIcons.GroupedIcons
                .Select(g => new Views.IconPickGroup(g.GroupName,
                    g.Icons.Where(x => x.Icon != null).ToList()))
                .ToList();

            var card = vm.SelectedCard;
            _iconPanel = new Views.IconPickDialog($"选择图标 —— 当前：{card?.DisplayName ?? "（未选中）"}", groups, r => ApplyIconChoice(vm, r));
            _iconPanel.Owner = this;
            _iconPanel.Closed += (_, _) => _iconPanel = null;
            _iconPanel.Show();
            vm.Message = "图标面板已打开（非模态）：点击主面板其他卡片可切换应用目标，再点「修改图标」可关闭。";
        }
        catch (Exception ex)
        {
            try { System.IO.File.AppendAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fenpei_icon_error.log"), "[T]" + DateTime.Now.ToString("HH:mm:ss.fff") + "\n" + ex + "\n"); } catch { }
            if (DataContext is MainViewModel vmErr) IconFeedback(vmErr, $"图标面板打开失败：{ex.Message}", false);
        }
    }

    /// <summary>图标操作统一反馈：写日志区（Logs+状态栏 Message），并同步到图标面板底部反馈栏（面板未开则只记日志）。</summary>
    private void IconFeedback(MainViewModel vm, string msg, bool ok)
    {
        vm.Log(msg, !ok);
        _iconPanel?.ShowFeedback(msg, ok);
    }

    /// <summary>图标面板回调：把本次选择应用到「回调时刻」选中的卡片；面板保持打开，可连续修改多张卡。</summary>
    private void ApplyIconChoice(MainViewModel vm, Views.IconPickResult r)
    {
        try
        {
            var card = vm.SelectedCard;
            if (card == null) { IconFeedback(vm, "请先选择一个项目组或项目。", false); return; }
            if (!Directory.Exists(card.FullPath)) { IconFeedback(vm, $"文件夹不存在: {card.FullPath}", false); return; }

            // 「恢复默认图标」：直接恢复并结束
            if (r.RestoreDefault)
            {
                RestoreSelectedIcon(vm, card);
                return;
            }

            // 统一解析用户选择来源：浏览文件 / 系统 DLL 图标 / 预设图标 / 剪贴板图片
            string? sourceFile = null;
            string? sourceDll = null;
            int sourceIdx = -1;
            if (r.Browse)
            {
                var dlg = new Microsoft.Win32.OpenFileDialog
                {
                    Title = "选择自定义图标",
                    Filter = "图标/图片文件|*.ico;*.png;*.bmp;*.jpg;*.jpeg;*.gif|所有文件|*.*"
                };
                if (dlg.ShowDialog(this) != true) return;
                sourceFile = dlg.FileName;
            }
            else if (r.DllPath != null && r.DllIconIndex >= 0)
            {
                sourceDll = r.DllPath;
                sourceIdx = r.DllIconIndex;
                if (!string.IsNullOrEmpty(r.TargetGroup))
                {
                    // 同时加入预设分组：提取该图标转 .ico 入库并应用副本（分组内可复用）
                    var img = Services.IconService.LoadCustomIcon(r.DllPath, r.DllIconIndex)
                        as System.Windows.Media.Imaging.BitmapSource;
                    if (img != null)
                    {
                        var baseName = System.IO.Path.GetFileNameWithoutExtension(r.DllPath);
                        var added = vm.PresetIcons.AddBitmapToGroupFront(img, r.TargetGroup, baseName);
                        if (added != null) { sourceFile = added; sourceDll = null; sourceIdx = -1; }
                    }
                }
            }
            else if (r.PresetName != null)
            {
                var chosenFile = vm.PresetIcons.FullPath(r.PresetName);
                if (!File.Exists(chosenFile)) { IconFeedback(vm, "所选预设图标文件不存在。", false); return; }
                sourceFile = chosenFile;
            }
            else if (r.ClipboardImage != null)
            {
                // 剪贴板图片：选了目标分组则加入该分组最前面并复用其 .ico；否则写临时 .ico 直接应用。
                if (!string.IsNullOrEmpty(r.TargetGroup))
                {
                    sourceFile = vm.PresetIcons.AddClipboardToGroupFront(r.ClipboardImage, r.TargetGroup);
                    if (sourceFile == null) { IconFeedback(vm, "剪贴板图片转换失败。", false); return; }
                }
                else
                {
                    sourceFile = PresetIconService.WriteTempIco(r.ClipboardImage);
                    if (sourceFile == null) { IconFeedback(vm, "剪贴板图片转换失败。", false); return; }
                }
            }
            else
            {
                return; // 非预期结果
            }

            // 按开关分流：开=写 desktop.ini（资源管理器同步生效）；关=仅记录 GUI 专属映射，不碰文件系统。
            bool ok;
            if (vm.IconsAffectExplorer)
            {
                var iniPath = sourceDll != null
                    ? FolderIconService.SetCustomIconFromDll(card.FullPath, sourceDll, sourceIdx)
                    : FolderIconService.SetCustomIcon(card.FullPath, sourceFile!);
                ok = iniPath != null;
                if (ok)
                {
                    vm.ClearGuiOnlyIcon(card.FullPath); // 清 GUI 覆盖，避免遮蔽 desktop.ini 新图
                    vm.MarkSystemAttribAdded(card.FullPath); // D3：+s 系本工具所加，恢复时才允许 -s
                }
                IconFeedback(vm, ok ? $"已设置自定义图标: {card.FullPath}" : "设置图标失败（权限或属性写入受限）。", ok);
            }
            else
            {
                ok = sourceDll != null
                    ? vm.SetGuiOnlyIconDll(card.FullPath, sourceDll, sourceIdx)
                    : vm.SetGuiOnlyIconFile(card.FullPath, sourceFile!);
                IconFeedback(vm, ok ? $"已设置界面图标（仅本工具生效）: {card.FullPath}" : "设置图标失败。", ok);
            }
            if (ok) vm.RefreshSelectedCardIcon();
        }
        catch (Exception ex)
        {
            try { System.IO.File.AppendAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fenpei_icon_error.log"), "[T]" + DateTime.Now.ToString("HH:mm:ss.fff") + "\n" + ex + "\n"); } catch { }
            IconFeedback(vm, $"图标应用失败：{ex.Message}", false);
        }
    }

    // ---------------- 标签自定义颜色（对应侧边栏「修改颜色」） ----------------

    /// <summary>打开非模态调色板（侧边栏按钮与快捷键共用），逻辑见 ChangeColor。</summary>
    private void OnChangeColorClick(object sender, RoutedEventArgs e) => ChangeColor();

    private void ChangeColor()
    {
        try
        {
            if (DataContext is not MainViewModel vm) return;
            if (_colorPanel != null) { _colorPanel.Close(); return; }   // 再点同按钮 = 关闭面板（toggle）
            ClosePickPanelsExcept(null);                                // 互斥：打开前先关其他选择面板

            var card = vm.SelectedCard;
            var kindName = card == null ? "（未选中）" : (card.Kind == "group" ? "项目组" : "项目");
            _colorPanel = new Views.ColorPickDialog(
                $"修改颜色 —— {kindName}: {card?.DisplayName ?? "无"}",
                card == null ? null : vm.FindTagColor(card.FullPath),
                vm.CustomColors,
                hex => { var c = vm.SelectedCard; if (c != null) vm.ApplyTagColorPreview(c, hex); },
                hex =>
                {
                    var c = vm.SelectedCard;
                    if (c == null) { vm.Message = "请先选择一个项目组或项目。"; return; }
                    vm.SetTagColor(c, hex);
                    vm.Message = hex == null
                        ? $"已恢复默认外观: {c.DisplayName}"
                        : $"已设置标签颜色 {hex}: {c.DisplayName}" + (c.Kind == "group" ? "（链接它的项目已同步）" : "");
                },
                colors => vm.SaveCustomColors(colors));
            _colorPanel.Owner = this;
            // 关闭时把前台显式交还主窗：否则 Windows 会把激活交给 z 序里随后的任意窗口
            // （实测会随机切到 TRAE/OpenCode 等无关应用，用户感知为"呼出了别的程序"）
            _colorPanel.Closed += (_, _) =>
            {
                _colorPanel = null;
                try { Activate(); } catch { }
            };
            _colorPanel.Show();
            vm.Message = "调色板已打开（非模态）：修改即时保存到当前选中卡片，再点「修改颜色」可关闭。";
        }
        catch (Exception ex)
        {
            if (DataContext is MainViewModel vm2) vm2.Message = $"修改颜色失败: {ex.Message}";
        }
    }

    // ---------------- 项目 / 项目组改名与搬家（对应侧边栏「改名 / 搬家」） ----------------

    /// <summary>重命名选中项目 / 项目组文件夹（侧边栏按钮与 F2 快捷键共用）。</summary>
    private void OnRenameClick(object sender, RoutedEventArgs e) => RenameFolder();

    private void RenameFolder()
    {
        try
        {
            if (DataContext is not MainViewModel vm) return;
            var card = vm.SelectedCard;
            if (card == null) { vm.Message = "请先选择一个项目组或项目。"; return; }
            var kindName = card.Kind == "group" ? "项目组" : "项目";
            var oldName = card.DisplayName;
            var newName = Views.PromptDialog.Show($"改名 —— {kindName}", "新名称",
                oldName, vm.ValidateRenameInput);
            if (newName == null) { vm.Message = "已取消改名。"; return; }
            var err = vm.RenameFolder(card, newName);
            vm.Message = err == null ? $"已改名: {oldName} → {newName.Trim()}" : "改名失败：" + err;
        }
        catch (Exception ex)
        {
            if (DataContext is MainViewModel vm2) vm2.Message = $"改名失败: {ex.Message}";
        }
    }

    // ---------------- 新建项目 / 项目组（面板标题栏「＋ 新建项目 / ＋ 新建项目组」） ----------------

    /// <summary>新建项目：弹名称输入框，确定后按预设目录（未配置则弹文件夹选择框）创建文件夹并加入当前页签。</summary>
    private void OnCreateProjectClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if (DataContext is not MainViewModel vm) return;
            var name = PromptDialog.Show("新建项目", "项目名称", "", vm.ValidateRenameInput);
            if (name == null) { vm.Message = "已取消新建项目。"; return; }
            var parent = ResolveCreateParent(vm.CreateProjectDirText, "项目");
            if (parent == null) { vm.Message = "已取消新建项目。"; return; }
            var err = vm.CreateProjectFolder(name, parent);
            vm.Message = err.Error == null ? $"已新建项目: {err.FullPath}" : "新建项目失败：" + err.Error;
        }
        catch (Exception ex)
        {
            if (DataContext is MainViewModel vm2) vm2.Message = $"新建项目失败: {ex.Message}";
        }
    }

    /// <summary>新建项目组：弹名称输入框，确定后按预设目录（未配置则弹文件夹选择框）创建文件夹（拷贝模板）并加入当前页签。</summary>
    private void OnCreateGroupClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if (DataContext is not MainViewModel vm) return;
            var name = PromptDialog.Show("新建项目组", "项目组名称", "", vm.ValidateRenameInput);
            if (name == null) { vm.Message = "已取消新建项目组。"; return; }
            var parent = ResolveCreateParent(vm.CreateGroupDirText, "项目组");
            if (parent == null) { vm.Message = "已取消新建项目组。"; return; }
            var err = vm.CreateGroupFolder(name, parent);
            vm.Message = err.Error == null ? $"已新建项目组: {err.FullPath}" : "新建项目组失败：" + err.Error;
        }
        catch (Exception ex)
        {
            if (DataContext is MainViewModel vm2) vm2.Message = $"新建项目组失败: {ex.Message}";
        }
    }

    /// <summary>解析新建父目录：预设目录有效则用之，否则弹文件夹选择框；取消返回 null。</summary>
    private string? ResolveCreateParent(string preset, string kindName)
    {
        if (!string.IsNullOrWhiteSpace(preset) && Directory.Exists(preset)) return preset;
        var dlg = new Microsoft.Win32.OpenFolderDialog { Title = $"选择新建{kindName}的父目录" };
        return dlg.ShowDialog(this) == true ? dlg.FolderName : null;
    }

    /// <summary>把选中项目 / 项目组文件夹搬家到用户选择的目录（侧边栏按钮与快捷键共用）。</summary>
    private void OnMoveClick(object sender, RoutedEventArgs e) => MoveFolder();

    private void MoveFolder()
    {
        try
        {
            if (DataContext is not MainViewModel vm) return;
            var card = vm.SelectedCard;
            if (card == null) { vm.Message = "请先选择一个项目组或项目。"; return; }
            var kindName = card.Kind == "group" ? "项目组" : "项目";
            var dlg = new Microsoft.Win32.OpenFolderDialog { Title = $"选择「{card.DisplayName}」的新位置（{kindName}搬家）" };
            if (dlg.ShowDialog(this) != true) { vm.Message = "已取消搬家。"; return; }
            var dest = dlg.FolderName;
            var err = vm.MoveFolder(card, dest);
            vm.Message = err == null
                ? $"已搬家: {card.FullPath} → {System.IO.Path.Combine(dest, card.DisplayName)}"
                : "搬家失败：" + err;
        }
        catch (Exception ex)
        {
            if (DataContext is MainViewModel vm2) vm2.Message = $"搬家失败: {ex.Message}";
        }
    }

    /// <summary>恢复选中卡片的自定义图标：开关开则清 desktop.ini 图标行（资源管理器恢复默认），无论开关状态都清 GUI 专属覆盖。</summary>
    private void RestoreSelectedIcon(MainViewModel vm, FolderCardViewModel card)
    {
        var changed = false;
        if (vm.IconsAffectExplorer)
        {
            // D3：仅当标记显示 +s 系本工具所加时才去除 System 属性；确认还原成功后清除标记
            bool marked = vm.HasSystemAttribMark(card.FullPath);
            changed |= FolderIconService.RestoreDefaultIcon(card.FullPath, removeSystemAttrib: marked);
            if (changed && marked) vm.ClearSystemAttribMark(card.FullPath);
        }
        changed |= vm.ClearGuiOnlyIcon(card.FullPath);

        IconFeedback(vm, changed
            ? (vm.IconsAffectExplorer ? $"已恢复默认图标: {card.FullPath}" : $"已恢复界面默认图标（仅本工具）: {card.FullPath}")
            : "当前无自定义图标需要恢复。", changed);
        if (changed) vm.RefreshSelectedCardIcon();
    }

    /// <summary>日志区右键「复制该条」：CommandParameter 绑定该行 LogEntry，取展示文本入剪贴板。</summary>
    private void OnCopyLogEntryClick(object sender, RoutedEventArgs e)
    {
        if ((sender as MenuItem)?.CommandParameter is not ViewModels.LogEntry entry) return;
        try { Clipboard.SetText(entry.Display); } catch { /* 剪贴板被占用等：忽略 */ }
    }

    // ---------------- 标题栏按钮 ----------------

    private void OnTitleTipsClick(object sender, RoutedEventArgs e) => ToggleTipsPanel();

    /// <summary>打开内置 Markdown 编辑器（便携半独立窗，重复打开时聚焦已有实例）。</summary>
    private void OnTitleMarkdownClick(object sender, RoutedEventArgs e) => OpenMarkdownEditor();

    private void OpenMarkdownEditor()
    {
        if (_mdEditor is { IsLoaded: true })
        {
            _mdEditor.Activate();
            if (_mdEditor.WindowState == WindowState.Minimized) _mdEditor.WindowState = WindowState.Normal;
            return;
        }
        string? previewFile = (DataContext as MainViewModel)?.Content?.LastPreviewFile;
        _mdEditor = Portable.MarkdownEditor.MarkdownEditorWindow.ShowWindow(this, previewFile);
    }

    /// <summary>切换使用说明浮层（内嵌浮层）；打开时关闭其他浮层。</summary>
    private void ToggleTipsPanel()
    {
        try
        {
            if (tipsPopup.Visibility == Visibility.Visible)
            {
                tipsPopup.Visibility = Visibility.Collapsed;
            }
            else
            {
                settingsPopup.Visibility = Visibility.Collapsed;
                mcpPopup.Visibility = Visibility.Collapsed;
                CloseMindMapPanel();
                tipsPopup.Visibility = Visibility.Visible;
            }
            SyncTitleBtnActive();
        }
        catch (Exception ex)
        {
            try
            {
                System.IO.File.AppendAllText(
                    System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fenpei_tips_error.log"),
                    $"{System.DateTime.Now:HH:mm:ss.fff} TIPS切换异常: {ex}\r\n");
            }
            catch { }
        }
    }

    /// <summary>按各浮层可见性同步标题栏按钮的"选中高亮"外观（对应浮层打开时按钮保持 TitleBtnActive）。</summary>
    private void SyncTitleBtnActive()
    {
        btnTips.Style   = (Style)FindResource(tipsPopup.Visibility == Visibility.Visible ? "TitleBtnActive" : "TitleBtn");
        btnMcp.Style    = (Style)FindResource(mcpPopup.Visibility == Visibility.Visible ? "TitleBtnActive" : "TitleBtn");
        btnSettings.Style = (Style)FindResource(settingsPopup.Visibility == Visibility.Visible ? "TitleBtnActive" : "TitleBtn");
        // 主视图入口「分配项目组」与脑图入口互斥高亮：脑图打开时分配按钮熄灭、脑图按钮点亮；主视图时反之。
        bool mindMapOpen = mindMapPopup.Visibility == Visibility.Visible;
        btnAssign.Style = (Style)FindResource(mindMapOpen ? "TitleBtn" : "TitleBtnActive");
        SetPluginLauncherActive(PluginService.KityMinderId, mindMapOpen);
    }

    // ---------------- 浮层底部拖动调整高度（GridSplitter 分隔条，与预览窗口高度无关，高度持久化） ----------------

    /// <summary>从分隔条向上找到所属浮层 Border（分隔条 → Grid → 浮层）。</summary>
    private static Border? FindPopupBorder(DependencyObject d)
    {
        for (var cur = GetParent(d); cur != null; cur = GetParent(cur))
            if (cur is Border b && b.Name is "settingsPopup" or "mcpPopup" or "tipsPopup" or "mindMapPopup") return b;
        return null;
    }

    /// <summary>拖动浮层底部分隔条：实时改变浮层整体高度（与拖动面板移动互斥，由 GridSplitter 独占鼠标）。</summary>
    private void OnPopupResizeDelta(object sender, DragDeltaEventArgs e)
    {
        if (sender is not GridSplitter splitter) return;
        var popup = FindPopupBorder(splitter);
        if (popup == null) return;
        double newH = popup.Height + e.VerticalChange;
        double minH = 240;
        // 宿主高度不可用时回退为一个宽松上限（原 `?? 240` 因表达式永不为 null 而是死代码）
        var host = popup.Parent as FrameworkElement;
        double maxH = host != null && !double.IsNaN(host.ActualHeight) && host.ActualHeight > 0
            ? host.ActualHeight - popup.Margin.Top - 4
            : minH * 4;
        if (maxH < minH) maxH = minH;
        // 首次拖动时 Height 可能为 NaN（XAML 未给初值且无存档），此时以当前渲染高度为基准
        if (double.IsNaN(popup.Height)) newH = Math.Max(minH, popup.ActualHeight + e.VerticalChange);
        popup.Height = Math.Max(minH, Math.Min(newH, maxH));
        // 恢复 Grid 行高（内容区 * + 分隔条 Auto），避免 GridSplitter 自动调整内容区高度导致内容收缩
        if (popup.Child is Grid g && g.RowDefinitions.Count >= 2)
        {
            g.RowDefinitions[0].Height = new GridLength(1, GridUnitType.Star);
            g.RowDefinitions[1].Height = GridLength.Auto;
        }
    }

    /// <summary>拖动结束：把三个浮层当前高度写入 config 落盘（下次打开恢复）。</summary>
    private void OnPopupResizeCompleted(object sender, DragCompletedEventArgs e)
    {
        SavePopupHeights();
    }

    /// <summary>把三个浮层当前高度写入 config 落盘（下次打开恢复）。</summary>
    private void SavePopupHeights()
    {
        if (DataContext is not MainViewModel vm) return;
        vm.SavePanelHeights(settingsPopup.Height, mcpPopup.Height, tipsPopup.Height);
    }

    /// <summary>切换设置面板（内嵌浮层）。</summary>
    private void OnTitleSettingsClick(object sender, RoutedEventArgs e) => ToggleSettingsPanel();

    private void ToggleSettingsPanel()
    {
        if (settingsPopup.Visibility == Visibility.Visible)
        {
            settingsPopup.Visibility = Visibility.Collapsed;
        }
        else
        {
            tipsPopup.Visibility = Visibility.Collapsed;
            mcpPopup.Visibility = Visibility.Collapsed;
            CloseMindMapPanel();
            settingsPopup.Visibility = Visibility.Visible;
        }
        SyncTitleBtnActive();
    }

    /// <summary>切换 MCP 工具开关面板（内嵌浮层）；关闭时把勾选状态写入 config 落盘。</summary>
    private void OnTitleMcpClick(object sender, RoutedEventArgs e) => ToggleMcpPanel();

    private void ToggleMcpPanel()
    {
        if (mcpPopup.Visibility == Visibility.Visible)
        {
            CloseMcpPanel();
        }
        else
        {
            settingsPopup.Visibility = Visibility.Collapsed;
            tipsPopup.Visibility = Visibility.Collapsed;
            CloseMindMapPanel();
            mcpPopup.Visibility = Visibility.Visible;
            SyncTitleBtnActive();
        }
    }

    /// <summary>MCP 面板右上角 × 按钮触发 → 收起浮层并保存。</summary>
    private void OnMcpPanelClose(object sender, EventArgs e) => CloseMcpPanel();

    /// <summary>设置面板右上角 × 按钮触发 → 收起设置浮层。</summary>
    private void OnSettingsPanelClose(object sender, EventArgs e)
    {
        settingsPopup.Visibility = Visibility.Collapsed;
        SyncTitleBtnActive();
    }

    /// <summary>TIPS 面板右上角 × 按钮触发 → 收起使用说明浮层。</summary>
    private void OnTipsPanelClose(object sender, EventArgs e)
    {
        tipsPopup.Visibility = Visibility.Collapsed;
        SyncTitleBtnActive();
    }

    // ---------------- 思维导图（kityminder 插件）浮层 ----------------

    /// <summary>切换思维导图面板（侧边栏"思维导图"按钮触发）。</summary>
    private void OnMindMapClick(object sender, RoutedEventArgs e) => ToggleMindMapPanel();

    /// <summary>标题栏「分配项目组」入口：与脑图互斥，切回主视图（关闭脑图占满模式并聚焦主分配界面）。</summary>
    private void OnTitleAssignClick(object sender, RoutedEventArgs e) => SwitchToMainView();

    /// <summary>切到主分配视图：关掉脑图浮层/占满模式，恢复并聚焦主界面（分配项目组）。</summary>
    private void SwitchToMainView()
    {
        if (mindMapPopup.Visibility == Visibility.Visible) CloseMindMapPanel();
        else SyncTitleBtnActive();
    }

    private void ToggleMindMapPanel()
    {
        if (mindMapPopup.Visibility == Visibility.Visible)
        {
            CloseMindMapPanel();
        }
        else
        {
            settingsPopup.Visibility = Visibility.Collapsed;
            mcpPopup.Visibility = Visibility.Collapsed;
            tipsPopup.Visibility = Visibility.Collapsed;
            SyncTitleBtnActive();
            if (mindMapPanel.Host == null && DataContext is MainViewModel vm)
                mindMapPanel.Host = vm;
            mindMapPopup.Visibility = Visibility.Visible;
            EnterMindMapFullscreen();
            mindMapPanel.Show();
            // 特性互斥：切到脑图后，分配项目组的快捷键全部屏蔽（本特性的快捷键生效）
            SetActiveFeature(FeatureMindMap);
            // 脑图占满后同步一次：分配按钮熄灭、脑图按钮点亮（上文 Sync 时浮层尚不可见）
            SyncTitleBtnActive();
        }
    }

    private void CloseMindMapPanel()
    {
        if (mindMapPopup.Visibility != Visibility.Visible) return;
        ExitMindMapFullscreen();
        mindMapPopup.Visibility = Visibility.Collapsed;
        // 特性互斥：回到分配项目组，恢复其快捷键（脑图快捷键屏蔽）
        SetActiveFeature(FeatureAssign);
        SyncTitleBtnActive();
    }

    /// <summary>进入脑图占满内容区模式：隐藏左栏/四栏主区/日志+预览/主区分隔条，脑图铺满标题栏下方整个内容区，左上角标题切换为「思维导图」。</summary>
    private void EnterMindMapFullscreen()
    {
        sidebar.Visibility = Visibility.Collapsed;
        mainGrid.Visibility = Visibility.Collapsed;
        bottomGrid.Visibility = Visibility.Collapsed;
        splitterRow.Visibility = Visibility.Collapsed;
        appTitleText.Text = "思维导图";
        appSubtitleText.Text = "  思维导图编辑、主题配色、布局与导入导出";
    }

    /// <summary>退出脑图占满内容区模式，恢复左栏/四栏/日志+预览/分隔条，左上角标题恢复为「分配项目组」。</summary>
    private void ExitMindMapFullscreen()
    {
        sidebar.Visibility = Visibility.Visible;
        mainGrid.Visibility = Visibility.Visible;
        bottomGrid.Visibility = Visibility.Visible;
        splitterRow.Visibility = Visibility.Visible;
        appTitleText.Text = "分配项目组";
        appSubtitleText.Text = "  为项目快速分配项目组(agents/skills/rules和agent通用支持文件)并提供锁定迁移等辅助功能";
    }

    /// <summary>收起 MCP 浮层并把勾选状态/总开关写入 config 落盘。</summary>
    private void CloseMcpPanel()
    {
        if (mcpPopup.Visibility != Visibility.Visible) return;
        mcpPopup.Visibility = Visibility.Collapsed;
        if (DataContext is MainViewModel vm) vm.Mcp.Save();
        SyncTitleBtnActive();
    }

    // ---------------- ESC 快捷关闭浮层 + 键盘导航 ----------------

    /// <summary>ESC 关闭浮层；上下键/Ctrl+左右键做键盘导航（浮层打开或文本输入聚焦时不拦截）。</summary>
    private void OnWindowPreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Escape)
        {
            if (CloseOpenPanels()) e.Handled = true;
            return;
        }
        // 特性互斥：非「分配项目组」特性激活（如脑图）时，分配项目的键盘导航一律屏蔽
        if (_activeFeature != FeatureAssign) return;
        if (IsAnyPanelOpen()) return;
        if (IsTextInputFocused()) return;
        if (DataContext is not MainViewModel vm) return;
        switch (e.Key)
        {
            case System.Windows.Input.Key.Up:
                vm.NavigateAdjacent(-1); e.Handled = true; break;
            case System.Windows.Input.Key.Down:
                vm.NavigateAdjacent(1); e.Handled = true; break;
        }
    }

    /// <summary>是否有任一浮层（设置/MCP/使用说明）打开。</summary>
    private bool IsAnyPanelOpen()
        => settingsPopup.Visibility == Visibility.Visible
        || mcpPopup.Visibility == Visibility.Visible
        || tipsPopup.Visibility == Visibility.Visible
        || mindMapPopup.Visibility == Visibility.Visible;

    /// <summary>当前焦点是否在文本输入控件内（放行光标移动，不触发导航）。</summary>
    private static bool IsTextInputFocused()
    {
        if (System.Windows.Input.Keyboard.FocusedElement is not DependencyObject d) return false;
        return FindVisualParent<TextBox>(d) != null || FindVisualParent<RichTextBox>(d) != null;
    }

    /// <summary>键盘导航后把选中卡片滚动到可视区域。</summary>
    private void OnRequestScrollToCard(FolderCardViewModel card)
    {
        if (card.Kind == "project")
        {
            var c = projectCardsHost.ItemContainerGenerator.ContainerFromItem(card) as FrameworkElement;
            c?.BringIntoView();
            return;
        }
        if (DataContext is not MainViewModel vm) return;
        var box = groupBoxes.ItemContainerGenerator.ContainerFromIndex(vm.ActiveGroupTabIndex) as FrameworkElement;
        if (box == null) return;
        var host = FindVisualChild<ItemsControl>(box);
        var cardContainer = host?.ItemContainerGenerator.ContainerFromItem(card) as FrameworkElement;
        if (cardContainer != null) { cardContainer.BringIntoView(); return; }
        box.BringIntoView();
    }

    /// <summary>关闭当前打开的浮层面板；返回是否有面板被关闭。</summary>
    private bool CloseOpenPanels()
    {
        bool any = false;
        if (settingsPopup.Visibility == Visibility.Visible) { settingsPopup.Visibility = Visibility.Collapsed; any = true; }
        if (mcpPopup.Visibility == Visibility.Visible) { CloseMcpPanel(); any = true; }
        if (tipsPopup.Visibility == Visibility.Visible) { tipsPopup.Visibility = Visibility.Collapsed; any = true; }
        if (mindMapPopup.Visibility == Visibility.Visible) { CloseMindMapPanel(); any = true; }
        if (any) SyncTitleBtnActive();
        return any;
    }

    private void OnTitleMinClick(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    /// <summary>隐藏到系统托盘（NotifyIcon + 双击/单击恢复）。</summary>
    private System.Windows.Forms.NotifyIcon? _tray;

    private void OnTitleTrayClick(object sender, RoutedEventArgs e) => HideToTray();

    private void HideToTray()
    {
        EnsureTray();
        if (_tray == null) return;
        _tray.Visible = true;
        Hide();
        _tray.ShowBalloonTip(2000, "分配项目组", "已最小化到托盘，双击图标可恢复。",
            System.Windows.Forms.ToolTipIcon.Info);
    }

    private void EnsureTray()
    {
        if (_tray != null) return;
        var ni = new System.Windows.Forms.NotifyIcon
        {
            Icon = LoadTrayIcon(),
            Text = "分配项目组",
            Visible = false,
        };
        ni.Click += (_, _) => RestoreFromTray();
        ni.DoubleClick += (_, _) => RestoreFromTray();
        var menu = new System.Windows.Forms.ContextMenuStrip();
        var exitItem = new System.Windows.Forms.ToolStripMenuItem("退出");
        exitItem.Click += (_, _) => ExitFromTray();
        menu.Items.Add(exitItem);
        ni.ContextMenuStrip = menu;
        _tray = ni;
    }

    /// <summary>托盘菜单「退出」：置强制退出标志后关闭，绕开「关闭时隐藏到托盘」的拦截。</summary>
    private void ExitFromTray()
    {
        _forceExit = true;
        Close();
    }

    /// <summary>
    /// 加载托盘图标：优先用户自定义软件图标（config.customAppIcon，数据目录\appicon\custom-app.ico），
    /// 缺失回退程序集嵌入的 tray.ico，再回退系统默认图标。
    /// </summary>
    private System.Drawing.Icon LoadTrayIcon()
    {
        if (DataContext is MainViewModel vm)
        {
            var custom = vm.CustomAppIcon;
            if (!string.IsNullOrEmpty(custom) && File.Exists(custom))
            {
                try { return new System.Drawing.Icon(custom); } catch { }
            }
        }
        var asm = System.Reflection.Assembly.GetExecutingAssembly();
        var name = asm.GetManifestResourceNames()
            .FirstOrDefault(n => n.EndsWith("tray.ico", StringComparison.OrdinalIgnoreCase));
        if (name != null)
        {
            using var stream = asm.GetManifestResourceStream(name);
            if (stream != null) return new System.Drawing.Icon(stream);
        }
        return System.Drawing.SystemIcons.Application;
    }

    /// <summary>从嵌入资源加载标题栏「隐藏到托盘」按钮图标：优先白色 tray_btn.png，回退 tray.ico 帧；失败返回 null。</summary>
    private static ImageSource? LoadTrayButtonImage()
    {
        var asm = System.Reflection.Assembly.GetExecutingAssembly();
        var names = asm.GetManifestResourceNames().ToList();
        var png = names.FirstOrDefault(n => n.EndsWith("tray_btn.png", StringComparison.OrdinalIgnoreCase));
        var target = png
            ?? names.FirstOrDefault(n => n.EndsWith("tray.ico", StringComparison.OrdinalIgnoreCase));
        if (target == null) return null;
        try
        {
            using var stream = asm.GetManifestResourceStream(target);
            if (stream == null) return null;
            var decoder = System.Windows.Media.Imaging.BitmapDecoder.Create(
                stream, System.Windows.Media.Imaging.BitmapCreateOptions.PreservePixelFormat,
                System.Windows.Media.Imaging.BitmapCacheOption.OnLoad);
            var frame = png != null
                ? decoder.Frames.FirstOrDefault()
                : (decoder.Frames.OrderBy(f => Math.Abs(f.PixelWidth - 32)).FirstOrDefault()
                   ?? decoder.Frames.FirstOrDefault());
            frame?.Freeze();
            return frame;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>从托盘恢复主窗口（托盘图标点击/二次启动唤醒共用）。</summary>
    public void RestoreFromTray()
    {
        if (_tray != null) _tray.Visible = false;
        Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    /// <summary>「关闭时隐藏到托盘」开启后，点×/Alt+F4 拦截关闭转入托盘；true 表示本次为托盘菜单「退出」触发的真实退出。</summary>
    private bool _forceExit;

    protected override void OnClosing(CancelEventArgs e)
    {
        // 托盘「退出」或未开启隐藏到托盘时放行真实关闭
        if (_forceExit || DataContext is not MainViewModel vm || !vm.HideToTrayOnClose)
        {
            base.OnClosing(e);
            return;
        }
        e.Cancel = true;
        HideToTray();
    }

    protected override void OnClosed(EventArgs e)
    {
        SaveLayoutNow();
        // MCP 勾选兜底落盘：面板开着直接关窗时 CloseMcpPanel 不会触发，避免丢勾选
        if (DataContext is MainViewModel vmClosed)
        {
            vmClosed.Mcp.Save();
            // 勾选「退出时关闭 MCP」：通知 MCP 后台进程退出（未运行则忽略）
            if (vmClosed.CloseMcpOnExit) SignalCloseMcp();
        }
        _tray?.Dispose();
        _tray = null;
        base.OnClosed(e);
    }

    /// <summary>通知 MCP 后台进程退出（GUI 勾选「退出时关闭 MCP」时调用；MCP 未运行则忽略）。</summary>
    private static void SignalCloseMcp()
    {
        try
        {
            using var ev = System.Threading.EventWaitHandle.OpenExisting(Services.McpServer.CloseEventName);
            ev.Set();
        }
        catch { /* MCP 未运行：忽略 */ }
    }

    private void OnTitleMaxClick(object sender, RoutedEventArgs e)
        => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    /// <summary>最大化/还原按钮图标随窗口状态切换：最大化显示还原图标(两方框)，还原显示最大化图标。</summary>
    private void OnWindowStateChanged(object? sender, EventArgs e)
        => UpdateMaxButtonIcon();

    private void UpdateMaxButtonIcon()
    {
        if (btnMax == null) return;
        var maxed = WindowState == WindowState.Maximized;
        btnMax.Content = maxed ? "⧉" : "▢";
        btnMax.FontSize = maxed ? 15 : 14;
    }

    private void OnTitleCloseClick(object sender, RoutedEventArgs e) => Close();

    private void OnPreviewUpdated(string content)
    {
        previewBox.Text = content;
    }

    // ---------------- 卡片右键菜单：Agent 连锁动作（动态） ----------------

    /// <summary>右键卡片时按 ContextActions 动态构建菜单（code-behind 构建，规避弹窗树 DataContext 继承坑，见 AI_ERRATA E012）。</summary>
    private void OnCardMenuRequested(object sender, MouseButtonEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        if (FindVisualParent<Button>(e.OriginalSource as DependencyObject) is not { } btn) return;
        if (btn.DataContext is not FolderCardViewModel card) return;
        if (!card.IsSelected)
        {
            // 右键未选中卡片：菜单动作仍作用于被点卡片本身，无需改变当前选中态
        }
        var actions = vm.ContextActions.ToList();
        if (actions.Count == 0) return;

        var menu = new ContextMenu();
        foreach (var a in actions)
        {
            var id = a.Id;
            var item = new MenuItem { Header = a.Name };
            item.Click += (_, _) => vm.SendAgentChain(id, card);
            menu.Items.Add(item);
        }
        btn.ContextMenu = menu;
    }

    // ---------------- 外部文件夹拖入收藏区 / 输入框 ----------------

    /// <summary>card 流允许外部文件夹拖入：仅目录可落，返回 Copy 效果。</summary>
    private void OnCardScrollDragOver(object sender, DragEventArgs e)
    {
        if (e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            e.Effects = DragDropEffects.Copy;
            e.Handled = true;
        }
        else
        {
            e.Effects = DragDropEffects.None;
            e.Handled = true;
        }
    }

    /// <summary>
    /// 把拖入的文件夹作为收藏加入目标位置：
    /// 拖到项目卡片流 → 当前活动项目页签；拖到项目组集群滚动区 → 落入的具体分框页签。
    /// </summary>
    private void OnCardScrollDrop(object sender, DragEventArgs e)
    {
        if (DataContext is not MainViewModel vm) { e.Handled = true; return; }
        if (e.Data.GetDataPresent(DataFormats.FileDrop) && e.Data.GetData(DataFormats.FileDrop) is string[] paths)
        {
            if (ReferenceEquals(sender, groupBoxScroll))
            {
                int tabIdx = GroupBoxIndexAt(e.GetPosition(this));
                if (tabIdx < 0) tabIdx = vm.ActiveGroupTabIndex;
                foreach (var p in paths)
                    if (Directory.Exists(p)) vm.AddFavoriteToTab("group", tabIdx, p);
            }
            else
            {
                foreach (var p in paths)
                    if (Directory.Exists(p)) vm.AddFavoritePath("project", p);
            }
        }
        e.Handled = true;
    }

    // ---------------- 面板外拖入：悬停项目页签实时切换 + 拖到页签加入该页签 ----------------

    private ScrollViewer? DragTabScroll(object sender) =>
        ReferenceEquals(sender, projectTabsScroll) ? projectTabsScroll : null;

    private void OnTabDragOver(object sender, DragEventArgs e)
    {
        if (e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            e.Effects = DragDropEffects.Copy;
            e.Handled = true;
        }
        else
        {
            e.Effects = DragDropEffects.None;
            return;
        }

        if (DragTabScroll(sender) == null || DataContext is not MainViewModel vm) return;
        int idx = GetTabIndexAt(projectTabsHost, e.GetPosition(projectTabsHost));
        if (idx >= 0 && idx != vm.ActiveProjectTabIndex) vm.SwitchProjectTab(idx);
    }

    private void OnTabDrop(object sender, DragEventArgs e)
    {
        e.Handled = true;
        if (DataContext is not MainViewModel vm) return;
        if (!e.Data.GetDataPresent(DataFormats.FileDrop) || e.Data.GetData(DataFormats.FileDrop) is not string[] files)
            return;
        if (DragTabScroll(sender) == null) return;

        int idx = GetTabIndexAt(projectTabsHost, e.GetPosition(projectTabsHost));
        if (idx < 0) return;
        foreach (var f in files)
        {
            var f2 = f.Trim();
            if (Directory.Exists(f2)) vm.AddFavoriteToTab("project", idx, f2);
        }
    }
}