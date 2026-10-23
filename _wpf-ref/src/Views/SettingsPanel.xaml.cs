using System;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.ViewModels;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 「设置」面板（UserControl，命名空间 FenPeiXiangMuZu.Views）。
/// 不写死 DataContext：协调者通过公共属性 <see cref="Panel"/> 注入主 VM，设值即设为 DataContext，
/// XAML 直接绑定其 AutoSelect / QuickLink。面板自身只是状态展示；显示/隐藏由协调者控制。
/// </summary>
public partial class SettingsPanel : UserControl
{
    public SettingsPanel()
    {
        InitializeComponent();
        _toggleTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(300) };
        _toggleTimer.Tick += OnToggleTimerTick;
        Loaded += (_, _) => { UpdateIconListMaxHeight(); UpdateAcTemplateBoxHeight(); InitAppIconPreview(); };

        // 图标分组集群式拖拽：面板级移动/抬起驱动（按下在分组头 PreviewDown 中记录候选）
        PreviewMouseMove += OnGroupDragMove;
        PreviewMouseLeftButtonUp += OnGroupDragUp;

        // Agent 连锁页签：拖拽换序 / 右键管理钩子
        acTabs.PreviewMouseLeftButtonDown += OnAcTabDown;
        acTabs.MouseMove += OnAcTabsMove;
        acTabs.MouseLeftButtonUp += OnAcTabsUp;
        acTabs.LostMouseCapture += OnAcTabsLostCapture;
        acTabs.ContextMenuOpening += OnAcTabMenuOpening;
        acTabs.PreviewMouseWheel += OnAcTabsWheel;
    }

    /// <summary>协调者注入主视图模型（object，通常为主 VM）。设值即设为 DataContext。</summary>
    public static readonly DependencyProperty PanelProperty = DependencyProperty.Register(
        nameof(Panel), typeof(object), typeof(SettingsPanel),
        new PropertyMetadata(null, (d, e) =>
        {
            if (e.NewValue != null)
                ((SettingsPanel)d).DataContext = e.NewValue;
        }));

    public object? Panel
    {
        get => GetValue(PanelProperty);
        set => SetValue(PanelProperty, value);
    }

    /// <summary>设置面板请求关闭（右上角 × 按钮触发），由宿主（MainWindow）隐藏浮层。</summary>
    public event EventHandler? RequestClose;

    /// <summary>右上角关闭按钮点击 → 触发 RequestClose，交由 MainWindow 收起浮层。</summary>
    private void OnCloseClick(object sender, RoutedEventArgs e) => RequestClose?.Invoke(this, EventArgs.Empty);

    // ==================== 一键备份：目录浏览 / 恢复默认 ====================

    /// <summary>项目备份目录「浏览…」：选择文件夹后写回 VM（改动即时保存）。</summary>
    private void OnBackupProjectBrowseClick(object sender, RoutedEventArgs e)
        => BrowseBackupFolder("选择项目备份目录", (vm, folder) => vm.BackupProjectDirText = folder);

    /// <summary>项目组备份目录「浏览…」。</summary>
    private void OnBackupGroupBrowseClick(object sender, RoutedEventArgs e)
        => BrowseBackupFolder("选择项目组备份目录", (vm, folder) => vm.BackupGroupDirText = folder);

    /// <summary>项目备份目录「恢复默认」：清空自定义值（空 = exe 所在目录\backkup_项目备份）。</summary>
    private void OnBackupProjectResetClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is MainViewModel vm) vm.BackupProjectDirText = "";
    }

    /// <summary>项目组备份目录「恢复默认」：清空自定义值（空 = exe 所在目录\backkup_项目组备份）。</summary>
    private void OnBackupGroupResetClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is MainViewModel vm) vm.BackupGroupDirText = "";
    }

    // ==================== 创建预设：目录浏览 / 恢复默认 ====================

    /// <summary>项目创建预设目录「浏览…」。</summary>
    private void OnCreateProjectDirBrowseClick(object sender, RoutedEventArgs e)
        => BrowseBackupFolder("选择新建项目的预设父目录", (vm, folder) => vm.CreateProjectDirText = folder);

    /// <summary>项目组创建预设目录「浏览…」。</summary>
    private void OnCreateGroupDirBrowseClick(object sender, RoutedEventArgs e)
        => BrowseBackupFolder("选择新建项目组的预设父目录", (vm, folder) => vm.CreateGroupDirText = folder);

    /// <summary>项目组创建模板目录「浏览…」。</summary>
    private void OnCreateGroupTemplateBrowseClick(object sender, RoutedEventArgs e)
        => BrowseBackupFolder("选择新建项目组时拷贝的模板文件夹", (vm, folder) => vm.CreateGroupTemplateDirText = folder);

    /// <summary>项目创建预设目录「使用默认」：清空（= 每次新建时弹文件夹选择框）。</summary>
    private void OnCreateProjectDirResetClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is MainViewModel vm) vm.CreateProjectDirText = "";
    }

    /// <summary>项目组创建预设目录「使用默认」：清空（= 每次新建时弹文件夹选择框）。</summary>
    private void OnCreateGroupDirResetClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is MainViewModel vm) vm.CreateGroupDirText = "";
    }

    /// <summary>项目组创建模板目录「使用默认」：清空（= 使用内置默认模板）。</summary>
    private void OnCreateGroupTemplateResetClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is MainViewModel vm) vm.CreateGroupTemplateDirText = "";
    }

    // ==================== 预览区「打开编辑」：手动添加自定义程序 ====================

    /// <summary>「浏览…」手动添加列表中没有的程序（exe）：加入选择区并选中，改动即时保存。</summary>
    private void OnEditToolBrowseClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择编辑器程序",
            Filter = "程序|*.exe|所有文件|*.*",
            CheckFileExists = true,
        };
        var owner = Window.GetWindow(this);
        if (dlg.ShowDialog(owner) == true) vm.AddCustomEditor(dlg.FileName);
    }

    /// <summary>通用目录选择弹窗；确认后经 apply 写回对应 VM 属性。</summary>
    private void BrowseBackupFolder(string title, Action<MainViewModel, string> apply)
    {
        if (DataContext is not MainViewModel vm) return;
        var dlg = new Microsoft.Win32.OpenFolderDialog { Title = title };
        var owner = Window.GetWindow(this);
        if (dlg.ShowDialog(owner) != true) return;
        apply(vm, dlg.FolderName);
    }

    // ==================== 目录设置：快捷打开 ====================

    /// <summary>在资源管理器中打开目录；目录不存在则先创建（备份目录尚未执行过备份时可能为空）。</summary>
    private void OpenDirectory(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            System.IO.Directory.CreateDirectory(path);
            System.Diagnostics.Process.Start(
                new System.Diagnostics.ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true });
        }
        catch
        {
            // 打开失败静默；目录路径已在「数据目录」只读区展示
        }
    }

    /// <summary>「打开数据目录」：打开 config/link-record/预设图标库所在目录。</summary>
    private void OnOpenDataDirClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is MainViewModel vm) OpenDirectory(vm.DataDir);
    }

    /// <summary>「打开项目备份目录」：打开解析后的项目备份目标目录。</summary>
    private void OnOpenProjectBackupDirClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is MainViewModel vm) OpenDirectory(vm.ResolvedBackupProjectDir);
    }

    /// <summary>「打开项目组备份目录」：打开解析后的项目组备份目标目录。</summary>
    private void OnOpenGroupBackupDirClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is MainViewModel vm) OpenDirectory(vm.ResolvedBackupGroupDir);
    }

    // ==================== 脑图：备份目录修改 / 打开 ====================

    /// <summary>「修改」：选择新的脑图备份目录，并把现有备份文件整体迁移过去（改动即时保存）。</summary>
    private void OnMindMapBackupDirModifyClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        var dlg = new Microsoft.Win32.OpenFolderDialog { Title = "选择新的脑图备份目录" };
        var owner = Window.GetWindow(this);
        if (dlg.ShowDialog(owner) != true) return;
        vm.MoveMindMapBackupDir(dlg.FolderName);
    }

    /// <summary>「打开备份文件夹」：在资源管理器中打开解析后的脑图备份目录。</summary>
    private void OnOpenMindMapBackupDirClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is MainViewModel vm) OpenDirectory(vm.ResolvedMindMapBackupDir);
    }

    // ==================== 左侧页签切换 ====================

    /// <summary>页签切换：根据 RadioButton 的 Tag 显示对应内容区，隐藏其他。</summary>
    private void OnTabChecked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton rb || rb.Tag is not string tag) return;
        if (TabBasic is null || TabDirs is null || TabLinks is null || TabIcons is null || TabShortcuts is null || TabAgentChain is null || TabMindMap is null) return;

        TabBasic.Visibility = Visibility.Collapsed;
        TabDirs.Visibility = Visibility.Collapsed;
        TabLinks.Visibility = Visibility.Collapsed;
        TabIcons.Visibility = Visibility.Collapsed;
        TabShortcuts.Visibility = Visibility.Collapsed;
        TabAgentChain.Visibility = Visibility.Collapsed;
        TabMindMap.Visibility = Visibility.Collapsed;

        switch (tag)
        {
            case "Basic": TabBasic.Visibility = Visibility.Visible; break;
            case "Dirs": TabDirs.Visibility = Visibility.Visible; break;
            case "Links": TabLinks.Visibility = Visibility.Visible; break;
            case "Icons": TabIcons.Visibility = Visibility.Visible; break;
            case "Shortcuts": TabShortcuts.Visibility = Visibility.Visible; break;
            case "AgentChain":
                TabAgentChain.Visibility = Visibility.Visible;
                EnsureAcInitialSelection();
                Dispatcher.BeginInvoke(DispatcherPriority.Loaded, () => UpdateAcTemplateBoxHeight());
                break;
            case "MindMap": TabMindMap.Visibility = Visibility.Visible; break;
        }

        if (tag == "Icons")
            UpdateIconListMaxHeight();
    }

    // ==================== Agent 连锁：模板编辑框与占位符插入 ====================

    /// <summary>最近聚焦的模板框（占位符插入目标；null=尚无）。</summary>
    private TextBox? _lastTemplateBox;

    /// <summary>模板框加载完成：按 Tag（"action|kind"）从 VM 读生效模板填充。</summary>
    private void OnTemplateBoxLoaded(object sender, RoutedEventArgs e)
    {
        if (sender is not TextBox tb || tb.Tag is not string tag) return;
        var (action, kind) = SplitTemplateTag(tag);
        if (DataContext is MainViewModel vm) tb.Text = vm.GetChainTemplate(action, kind);
    }

    /// <summary>模板框获得焦点：记录为占位符插入目标。</summary>
    private void OnTemplateBoxGotFocus(object sender, RoutedEventArgs e)
    {
        if (sender is TextBox tb && tb.Tag is string) _lastTemplateBox = tb;
    }

    /// <summary>模板框失焦：提交保存（空白 = 恢复内置默认）。</summary>
    private void OnTemplateBoxLostFocus(object sender, RoutedEventArgs e)
    {
        if (sender is not TextBox tb || tb.Tag is not string tag) return;
        if (DataContext is not MainViewModel vm) return;
        var (action, kind) = SplitTemplateTag(tag);
        vm.SetChainTemplate(action, kind, tb.Text);
        // 若保存值被规范化（如恢复默认后回读默认文案），同步回显
        tb.Text = vm.GetChainTemplate(action, kind);
    }

    /// <summary>点击占位符按钮：向最近聚焦的模板框光标处插入占位符文本。</summary>
    private void OnPlaceholderInsertClick(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn || btn.Tag is not string ph) return;
        if (_lastTemplateBox == null)
        {
            MessageBox.Show("请先点击任意一个模板编辑框，再插入占位符。",
                "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var box = _lastTemplateBox;
        var caret = box.CaretIndex;
        box.Text = box.Text.Insert(caret, ph);
        box.CaretIndex = caret + ph.Length;
        box.Focus();
    }

    /// <summary>解析模板框 Tag："action|kind"。</summary>
    private static (string action, string kind) SplitTemplateTag(string tag)
    {
        var parts = tag.Split('|');
        return parts.Length == 2 ? (parts[0], parts[1]) : ("chain", "project");
    }

    // ==================== 快捷键面板：自定义连锁动作行 ====================

    /// <summary>自定义动作行「修改」：组合键捕获弹窗 → 主 VM 落盘并联动重绑。</summary>
    private void OnChainShortcutEditClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        if ((sender as FrameworkElement)?.DataContext is not ChainShortcutRow row) return;
        var it = vm.ChainActions.FirstOrDefault(a => a.Id == row.Id);
        if (it == null) return;
        EditAcShortcut(vm, it);
        // 行内容经 SyncChainRows 重建（SaveChainShortcut 内部调用），此处无需手动刷新
    }

    /// <summary>自定义动作行「清除」。</summary>
    private void OnChainShortcutClearClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        if ((sender as FrameworkElement)?.DataContext is not ChainShortcutRow row) return;
        var err = vm.SaveChainShortcut(row.Id, "");
        if (err != null) MessageBox.Show(err, "无法清除", MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    // ==================== Agent 连锁：动作页签（选择 / 详情 / 增删改排序） ====================

    /// <summary>详情区回填期间抑制勾选/子切换事件误写。</summary>
    private bool _acSuppressDetailRefresh;

    private bool _acScopeIsGroup;

    /// <summary>页签页打开时若无选中项则选第一个动作，驱动详情区首填。</summary>
    private void EnsureAcInitialSelection()
    {
        if (DataContext is not MainViewModel vm) return;
        if (vm.SelectedChainAction != null || vm.ChainActions.Count == 0) { RefreshAcDetail(); return; }
        acTabs.SelectedItem = vm.ChainActions[0];
    }

    /// <summary>页签切换：回填详情区（勾选/作用域复位/模板文本）。</summary>
    private void OnAcTabSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_acSuppressDetailRefresh) return;
        RefreshAcDetail();
    }

    /// <summary>按当前选中动作与作用域回填详情区。</summary>
    private void RefreshAcDetail()
    {
        if (DataContext is not MainViewModel vm) return;
        var it = vm.SelectedChainAction;
        _acSuppressDetailRefresh = true;
        try
        {
            if (it == null) { acTemplateBox.Text = ""; acTemplateBox.Tag = null; return; }
            acFlagSidebar.IsChecked = it.ShowSidebar;
            acFlagContext.IsChecked = it.ShowContextMenu;
            acActionClient.SelectedValue = vm.GetChainClientValue(it.Id);
            _acScopeIsGroup = false;
            acScopeProject.IsChecked = true;
            acScopeGroup.IsChecked = false;
            ApplyAcTemplateBox();
        }
        finally { _acSuppressDetailRefresh = false; }
    }

    /// <summary>把模板框切到「当前选中动作 × 当前作用域」并载入生效模板。</summary>
    private void ApplyAcTemplateBox()
    {
        if (DataContext is not MainViewModel vm) return;
        var it = vm.SelectedChainAction;
        if (it == null) { acTemplateBox.Text = ""; acTemplateBox.Tag = null; return; }
        var kind = _acScopeIsGroup ? "group" : "project";
        acTemplateBox.Tag = $"{it.Id}|{kind}";
        acTemplateBox.Text = vm.GetChainTemplate(it.Id, kind);
        _lastTemplateBox = acTemplateBox;   // 便于不点框直接插占位符
    }

    /// <summary>项目｜项目组 子切换：换载对应模板。</summary>
    private void OnAcScopeChecked(object sender, RoutedEventArgs e)
    {
        if (_acSuppressDetailRefresh) return;
        _acScopeIsGroup = ReferenceEquals(sender, acScopeGroup);
        ApplyAcTemplateBox();
    }

    /// <summary>侧边栏/右键菜单显隐勾选变更。</summary>
    private void OnAcFlagChanged(object sender, RoutedEventArgs e)
    {
        if (_acSuppressDetailRefresh) return;
        if (DataContext is not MainViewModel vm) return;
        var it = vm.SelectedChainAction;
        if (it == null) return;
        if (sender is not CheckBox cb || cb.Tag is not string t) return;
        if (t == "sidebar") vm.SetChainFlags(it.Id, cb.IsChecked == true, null);
        else if (t == "context") vm.SetChainFlags(it.Id, null, cb.IsChecked == true);
    }

    /// <summary>重新扫描已安装客户端并刷新列表（全局卡片选中由 SelectedChainClientCard 双向绑定自动恢复）。</summary>
    private void OnAcRefreshClientsClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        vm.RefreshChainClients();
        if (vm.SelectedChainAction == null) return;
        _acSuppressDetailRefresh = true;
        try { acActionClient.SelectedValue = vm.GetChainClientValue(vm.SelectedChainAction.Id); }
        finally { _acSuppressDetailRefresh = false; }
    }

    /// <summary>「手动添加…」选择客户端 exe 并设定显示名，加入默认客户端卡片并选中。</summary>
    private void OnAcAddClientClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择客户端程序",
            Filter = "程序|*.exe|所有文件|*.*",
            CheckFileExists = true,
        };
        var owner = Window.GetWindow(this);
        if (dlg.ShowDialog(owner) != true) return;
        var name = PromptDialog.Show("手动添加客户端", "客户端显示名：",
            System.IO.Path.GetFileNameWithoutExtension(dlg.FileName),
            raw => string.IsNullOrWhiteSpace(raw) ? "名称不能为空。" : null);
        if (string.IsNullOrWhiteSpace(name)) return;
        vm.AddCustomChainClient(name.Trim(), dlg.FileName);
    }

    /// <summary>动作专属「发送到」选择变更 → 保存（空串/默认项 = 跟随全局）。</summary>
    private void OnAcActionClientChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_acSuppressDetailRefresh) return;
        if (DataContext is not MainViewModel vm || sender is not ComboBox cb) return;
        var it = vm.SelectedChainAction;
        if (it == null) return;
        vm.SetChainClient(it.Id, cb.SelectedValue as string);
    }

    /// <summary>＋号：弹窗输入名称新增自定义动作并选中。</summary>
    private void OnAcAddClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        string? Validate(string raw)
        {
            var n = raw.Trim();
            if (n.Length == 0) return "名称不能为空。";
            if (n.Length > 20) return "名称过长（不超过 20 字）。";
            return vm.ChainActions.Any(a => string.Equals(a.Name, n, StringComparison.OrdinalIgnoreCase))
                ? "同名动作已存在。" : null;
        }
        var name = PromptDialog.Show("添加连锁动作", "动作名称：", "", Validate);
        if (name == null) return;
        var item = vm.AddCustomChainAction(name);
        acTabs.SelectedItem = item;
    }

    /// <summary>页签右键菜单：重命名 / 删除 / 上移 / 下移（内置项未开开发者模式时隐藏改名删除）。</summary>
    private void OnAcTabMenuOpening(object sender, ContextMenuEventArgs e)
    {
        if ((e.OriginalSource as DependencyObject) is not DependencyObject src) return;
        var itemEl = FindVisualParent<ListBoxItem>(src);
        if (itemEl?.DataContext is not ChainActionItem it) return;   // 非页签区域不弹菜单
        if (DataContext is not MainViewModel vm) return;

        var menu = new ContextMenu();
        var canEditBuiltin = it.Builtin.Length == 0 || vm.DevMode;

        var iconMi = new MenuItem { Header = "更换图标…" };
        iconMi.Click += (_, _) => OpenAcIconPicker(vm, it);
        menu.Items.Add(iconMi);

        var scMi = new MenuItem { Header = it.Shortcut.Length > 0 ? "修改快捷键…" : "设置快捷键…" };
        scMi.Click += (_, _) => EditAcShortcut(vm, it);
        menu.Items.Add(scMi);

        if (it.Shortcut.Length > 0)
        {
            var scClear = new MenuItem { Header = "清除快捷键" };
            scClear.Click += (_, _) =>
            {
                var err = vm.SaveChainShortcut(it.Id, "");
                if (err != null) MessageBox.Show(err, "无法清除", MessageBoxButton.OK, MessageBoxImage.Warning);
            };
            menu.Items.Add(scClear);
        }

        menu.Items.Add(new Separator());

        if (canEditBuiltin)
        {
            var ren = new MenuItem { Header = "重命名" };
            ren.Click += (_, _) => RenameAcAction(vm, it);
            menu.Items.Add(ren);
            var del = new MenuItem { Header = "删除" };
            del.Click += (_, _) =>
            {
                var ans = MessageBox.Show($"确定删除动作「{it.Name}」？其模板将一并清除。",
                    "删除确认", MessageBoxButton.YesNo, MessageBoxImage.Warning);
                if (ans != MessageBoxResult.Yes) return;
                var err = vm.RemoveChainAction(it.Id);
                if (err != null) MessageBox.Show(err, "无法删除", MessageBoxButton.OK, MessageBoxImage.Warning);
            };
            menu.Items.Add(del);
            menu.Items.Add(new Separator());
        }

        var up = new MenuItem { Header = "上移" };
        up.Click += (_, _) => MoveAcStep(vm, it, -1);
        var down = new MenuItem { Header = "下移" };
        down.Click += (_, _) => MoveAcStep(vm, it, +1);
        menu.Items.Add(up);
        menu.Items.Add(down);

        itemEl.ContextMenu = menu;
    }

    private void RenameAcAction(MainViewModel vm, ChainActionItem it)
    {
        string? Validate(string raw)
        {
            var n = raw.Trim();
            if (n.Length == 0) return "名称不能为空。";
            if (n.Length > 20) return "名称过长（不超过 20 字）。";
            return vm.ChainActions.Any(a => !ReferenceEquals(a, it)
                    && string.Equals(a.Name, n, StringComparison.OrdinalIgnoreCase))
                ? "同名动作已存在。" : null;
        }
        var name = PromptDialog.Show("重命名动作", "新名称：", it.Name, Validate);
        if (name == null) return;
        var err = vm.RenameChainAction(it.Id, name);
        if (err != null) MessageBox.Show(err, "无法重命名", MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private void MoveAcStep(MainViewModel vm, ChainActionItem it, int delta)
    {
        var i = vm.ChainActions.IndexOf(it);
        if (i < 0) return;
        vm.MoveChainActionTo(it.Id, i + delta);
    }

    // ---- 页签拖拽换序（对齐主面板集群标准：悬浮跟随锁单轴 + 插入条高亮 + 实时让位滑动动画 + 死区防抖） ----

    private ChainActionItem? _acDragItem;
    private FrameworkElement? _acDragEl;       // 被拖容器（渲染位移贴手，落位时滑入）
    private double _acDragGrabDelta;           // 按下点相对容器左缘的偏移（贴手用）
    private Point _acDragStart;
    private bool _acDragging;

    private void OnAcTabDown(object sender, MouseButtonEventArgs e)
    {
        if ((e.OriginalSource as DependencyObject) is not DependencyObject src) return;

        // 点击页签图标区 → 更换图标弹窗（不进入拖拽候选）
        if (src is TextBlock tb && tb.Tag as string == "AcIcon")
        {
            if (FindVisualParent<ListBoxItem>(src)?.DataContext is ChainActionItem hit
                && DataContext is MainViewModel vm0)
                OpenAcIconPicker(vm0, hit);
            e.Handled = true;
            _acDragItem = null;
            _acDragEl = null;
            return;
        }

        if (FindVisualParent<ListBoxItem>(src)?.DataContext is not ChainActionItem it) return;
        if (it.Builtin.Length > 0) return;   // 内置不参与拖拽
        _acDragItem = it;
        _acDragEl = AcContainerOf(it);
        _acDragGrabDelta = _acDragEl == null ? 0 : e.GetPosition(_acDragEl).X;
        _acDragStart = e.GetPosition(acTabs);
        _acDragging = false;
    }

    /// <summary>更换动作图标：内置字形选择弹窗（风格同侧边栏），点选即落盘刷新。</summary>
    private void OpenAcIconPicker(MainViewModel vm, ChainActionItem it)
    {
        var g = ChainIconPickDialog.Show($"更换图标 - {it.Name}", it.Icon);
        if (g == null) return;
        vm.SaveChainIcon(it.Id, g);
    }

    /// <summary>设置/修改动作快捷键：组合键捕获弹窗，落盘并联动快捷键面板与主窗口重绑。</summary>
    private void EditAcShortcut(MainViewModel vm, ChainActionItem it)
    {
        var g = ShortcutCaptureDialog.Show($"设置快捷键 - {it.Name}", it.Shortcut);
        if (g == null) return;
        var err = vm.SaveChainShortcut(it.Id, g);
        if (err != null) MessageBox.Show(err, "无法设置快捷键", MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private void OnAcTabsMove(object sender, MouseEventArgs e)
    {
        var it = _acDragItem;
        if (it == null) return;
        var pos = e.GetPosition(acTabs);
        if (!_acDragging)
        {
            if (e.LeftButton != MouseButtonState.Pressed) { _acDragItem = null; _acDragEl = null; return; }
            var dx = Math.Abs(pos.X - _acDragStart.X);
            if (dx < SystemParameters.MinimumHorizontalDragDistance) return;
            _acDragging = true;
            _ = acTabs.CaptureMouse();
        }
        if (_acDragEl == null) { _acDragEl = AcContainerOf(it); if (_acDragEl == null) return; }

        try
        {
            // 1) 悬浮跟随（锁单轴 X）：渲染位移 = 期望左缘 - 当前布局左缘
            var desiredLeft = pos.X - _acDragGrabDelta;
            var layoutX = AcLayoutX(_acDragEl);
            EnsureAcTf(_acDragEl).X = desiredLeft - layoutX;

            // 2) 换位判定（布局坐标 + 死区滞后，见 ComputeAcSwapIndex）；先于插入条，避免条随动画漂移
            var probeCenterX = desiredLeft + _acDragEl.ActualWidth / 2;   // 被拖药丸视觉中心（含跟随位移）
            var cur = IndexOfAc(it);
            var target = ComputeAcSwapIndex(probeCenterX, cur);

            // 3) 插入条高亮（布局坐标定位，不受让位动画影响）
            ShowAcInsertBar(target >= 0 ? target : cur);

            // 4) 实时让位（死区外才换位）
            if (target < 0 || target == cur) return;
            var oldLayoutXs = CaptureAcXs(exclude: _acDragEl);
            _acSuppressDetailRefresh = true;
            try
            {
                DataContextAsVm()?.MoveChainActionTo(it.Id, target);
                acTabs.UpdateLayout();
                acTabs.SelectedItem = it;   // 换位后保持被拖项选中
            }
            finally { _acSuppressDetailRefresh = false; }
            AnimateAcSlide(oldLayoutXs, exclude: _acDragEl);
            // 换位后布局左缘变化，重算贴手偏移保持视觉连续
            EnsureAcTf(_acDragEl).X = desiredLeft - AcLayoutX(_acDragEl);
            ShowAcInsertBar(IndexAcAfterMove(it));
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine(ex);
            AbortAcDrag();   // 异常安全：立即回弹清理，不留半截状态（对齐 AbortGroupDrag）
        }
    }

    /// <summary>换位完成后被拖项的最新下标（失败兜底用线性查找）。</summary>
    private int IndexAcAfterMove(ChainActionItem it) => acTabs.Items.IndexOf(it);

    private void OnAcTabsUp(object sender, MouseButtonEventArgs e) => EndAcDrag();

    private void OnAcTabsLostCapture(object sender, MouseEventArgs e) => EndAcDrag();

    /// <summary>中断/兜底：隐藏插入条、瞬时归零位移并复位全部拖拽状态（对齐 AbortGroupDrag）。</summary>
    private void AbortAcDrag()
    {
        HideAcInsertBar();
        if (_acDragEl != null)
        {
            var tf = EnsureAcTf(_acDragEl);
            tf.BeginAnimation(System.Windows.Media.TranslateTransform.XProperty, null);
            tf.X = 0;
        }
        _acDragItem = null;
        _acDragEl = null;
        if (_acDragging && Mouse.Captured == acTabs) acTabs.ReleaseMouseCapture();
        _acDragging = false;
    }

    private void EndAcDrag()
    {
        HideAcInsertBar();
        // 被拖项平滑滑入最终槽位
        if (_acDragEl != null)
        {
            var tf = EnsureAcTf(_acDragEl);
            var anim = new System.Windows.Media.Animation.DoubleAnimation(tf.X, 0,
                TimeSpan.FromMilliseconds(160)) { EasingFunction = new System.Windows.Media.Animation.CubicEase() };
            tf.BeginAnimation(System.Windows.Media.TranslateTransform.XProperty, anim);
        }
        _acDragItem = null;
        _acDragEl = null;
        if (_acDragging && Mouse.Captured == acTabs) acTabs.ReleaseMouseCapture();
        _acDragging = false;
    }

    private MainViewModel? DataContextAsVm() => DataContext as MainViewModel;

    private FrameworkElement? AcContainerOf(ChainActionItem it)
        => acTabs.ItemContainerGenerator.ContainerFromItem(it) as FrameworkElement;

    /// <summary>容器布局左缘（不含渲染位移）。</summary>
    private double AcLayoutX(UIElement el) => System.Windows.Media.VisualTreeHelper.GetOffset(el).X;

    /// <summary>取/建容器的 X 位移动画变换。</summary>
    private static System.Windows.Media.TranslateTransform EnsureAcTf(UIElement el)
    {
        if (el.RenderTransform is System.Windows.Media.TranslateTransform t) return t;
        t = new System.Windows.Media.TranslateTransform();
        el.RenderTransform = t;
        return t;
    }

    /// <summary>记录全部容器布局 X（排除被拖项；布局坐标不受动画影响），换位后做差值滑动动画。</summary>
    private Dictionary<UIElement, double> CaptureAcXs(UIElement? exclude)
    {
        var map = new Dictionary<UIElement, double>();
        var gen = acTabs.ItemContainerGenerator;
        if (gen.Status != System.Windows.Controls.Primitives.GeneratorStatus.ContainersGenerated) return map;
        for (var i = 0; i < acTabs.Items.Count; i++)
        {
            if (gen.ContainerFromIndex(i) is not FrameworkElement el || ReferenceEquals(el, exclude)) continue;
            map[el] = AcLayoutX(el);
        }
        return map;
    }

    /// <summary>让位滑动：新布局位置与旧布局位置做差，160ms 缓动归零。</summary>
    private void AnimateAcSlide(Dictionary<UIElement, double> oldXs, UIElement? exclude)
    {
        foreach (var (el, oldX) in oldXs)
        {
            var delta = oldX - AcLayoutX(el);
            if (Math.Abs(delta) < 0.5) continue;
            var tf = EnsureAcTf(el);
            var anim = new System.Windows.Media.Animation.DoubleAnimation(delta, 0,
                TimeSpan.FromMilliseconds(160)) { EasingFunction = new System.Windows.Media.Animation.CubicEase() };
            tf.BeginAnimation(System.Windows.Media.TranslateTransform.XProperty, anim);
        }
    }

    /// <summary>插入竖条：按「布局坐标」定位到目标缝隙（容器左缘；末位取末容器右缘），
    /// 与集群 UpdateGroupInsertBar 同源思路——判定与定位都不吃动画偏移，杜绝条随滑动漂移抖动。</summary>
    private void ShowAcInsertBar(int idx)
    {
        var gen = acTabs.ItemContainerGenerator;
        if (gen.Status != System.Windows.Controls.Primitives.GeneratorStatus.ContainersGenerated) return;
        var n = acTabs.Items.Count;
        if (n == 0) { HideAcInsertBar(); return; }
        FrameworkElement? e;
        var xOff = 0.0;
        if (idx <= 0) e = gen.ContainerFromIndex(0) as FrameworkElement;
        else if (idx >= n) { e = gen.ContainerFromIndex(n - 1) as FrameworkElement; xOff = e?.ActualWidth ?? 0; }
        else e = gen.ContainerFromIndex(idx) as FrameworkElement;
        if (e == null) { HideAcInsertBar(); return; }
        // 面板系布局坐标 → 覆盖层坐标（两容器同格，原点差一次换算）
        var origin = acTabs.TranslatePoint(new Point(0, 0), acDragOverlay);
        var x = origin.X + AcLayoutX(e) + xOff;
        Canvas.SetLeft(acInsertBar, x - 1.5);
        Canvas.SetTop(acInsertBar, origin.Y + 2);
        acInsertBar.Height = Math.Max(18, e.ActualHeight - 4);
        acInsertBar.Visibility = Visibility.Visible;
    }

    private void HideAcInsertBar()
    {
        if (acInsertBar != null) acInsertBar.Visibility = Visibility.Collapsed;
    }

    // ---- 页签横向滚轮滚动：页签多到溢出时，滚轮纵向增量转横向偏移 ----

    /// <summary>滚轮 → 页签条横向滚动（每格约 40px）；无溢出时不吞事件，交给外层设置区滚动。</summary>
    private void OnAcTabsWheel(object sender, MouseWheelEventArgs e)
    {
        var sv = FindVisualChild<ScrollViewer>(acTabs);
        if (sv == null || sv.ScrollableWidth <= 0) return;
        sv.ScrollToHorizontalOffset(sv.HorizontalOffset - e.Delta / 3.0);
        e.Handled = true;
    }

    private int IndexOfAc(ChainActionItem it) => acTabs.Items.IndexOf(it);

    /// <summary>换位死区基准 px；实际取它与邻签宽 20% 的较小值（对齐 GroupSwapHysteresis 设计）。</summary>
    private const double AcSwapDeadZone = 14.0;

    /// <summary>
    /// 带死区滞后的换位下标（对齐 GetSwapIndex 设计）：
    /// 探测一律用「布局坐标」（VisualTreeHelper.GetOffset，不含让位动画偏移）——
    /// 右移需越过右邻中心+margin、左移需越过左邻中心-margin，死区内保持原位；
    /// guard 循环支持一次跨越多框推进（快速甩动也能追上）。内置页签视为固定墙不可借位。
    /// </summary>
    private int ComputeAcSwapIndex(double probeCenterX, int from)
    {
        var n = acTabs.Items.Count;
        if (n == 0 || from < 0) return Math.Max(0, from);
        var idx = Math.Clamp(from, 0, n - 1);
        for (var guard = 0; guard < n; guard++)
        {
            var next = idx;
            // 右邻：自定义才可让位
            if (idx + 1 < n && AcContainerAt(idx + 1) is { } right
                && AcIsCustom(idx + 1))
            {
                var margin = Math.Min(AcSwapDeadZone, right.ActualWidth * 0.2);
                if (probeCenterX > AcLayoutCenterX(right) + margin) next = idx + 1;
            }
            // 左邻：自定义才可让位
            if (next == idx && idx - 1 >= 0 && AcContainerAt(idx - 1) is { } left
                && AcIsCustom(idx - 1))
            {
                var margin = Math.Min(AcSwapDeadZone, left.ActualWidth * 0.2);
                if (probeCenterX < AcLayoutCenterX(left) - margin) next = idx - 1;
            }
            if (next == idx) break;
            idx = next;
        }
        return idx;
    }

    private FrameworkElement? AcContainerAt(int i)
        => acTabs.ItemContainerGenerator.ContainerFromIndex(i) as FrameworkElement;

    /// <summary>指定下标动作是否为自定义（内置锁定不参与换位）。</summary>
    private bool AcIsCustom(int i) =>
        acTabs.Items[i] is ChainActionItem a && a.Builtin.Length == 0;

    /// <summary>容器布局中心 X（不含渲染位移——动画进行中探测依旧稳定，消灭鬼畜的关键）。</summary>
    private double AcLayoutCenterX(UIElement el) => AcLayoutX(el) + el.RenderSize.Width / 2;


    /// <summary>外层设置内容区尺寸变化时，校正图标列表滚动区高度，使其恰好填满可视区。</summary>
    private void OnSettingsScrollSizeChanged(object sender, SizeChangedEventArgs e)
    {
        UpdateIconListMaxHeight();
        UpdateAcTemplateBoxHeight();
    }

    /// <summary>
    /// 让图标分组列表滚动区高度自适应外层可视区：可用高 = 外层可视区高 − 图标页滚动区上方的固定占用 − 底部留白。
    /// 图标页整体高度因此不超出可视区（外层容器本身不可滚动、无滚动条），只保留内层图标滚动条。
    /// </summary>
    private void UpdateIconListMaxHeight()
    {
        if (TabIcons is null || TabIcons.Visibility != Visibility.Visible) return;
        if (settingsHost is null || iconListScroll is null) return;
        if (settingsHost.ActualHeight <= 0) return;

        // 图标列表上方已占用的实际高度用 TranslatePoint 实测：自动涵盖标题、操作提示、行为设置框等
        // 所有元素及其边距，避免手工累加遗漏元素导致列表过高、外层出现多余滚动条。
        var tabTop = TabIcons.TranslatePoint(new Point(0, 0), settingsHost).Y;
        var listTop = iconListScroll.TranslatePoint(new Point(0, 0), settingsHost).Y;
        var below = iconListScroll.Margin.Bottom
                  + (iconErrorText?.ActualHeight ?? 0) + (iconErrorText?.Margin.Top ?? 0);
        var reserved = listTop - tabTop + below + 12; // 底部安全余量
        var max = settingsHost.ActualHeight - reserved;
        if (max < 120) return; // 过小则保持现状，不足以滚动时仍可整体翻看
        iconListScroll.MaxHeight = max;   // 允许随面板缩小而收缩（外层已有滚动兜底，无需只增不减锁存）
    }

    /// <summary>
    /// Agent 连锁模板框高度自适应：可用高 = 外层可视区高 − 模板框上方固定占用 − 下方说明留白。
    /// 面板拉高时模板框随之拉高；最扁不低于 MinHeight(140)。上方占用用 TranslatePoint 实测，
    /// 自动涵盖标题、占位符按钮排、动作页签行等全部元素及其边距。
    /// </summary>
    private void UpdateAcTemplateBoxHeight()
    {
        if (TabAgentChain is null || TabAgentChain.Visibility != Visibility.Visible) return;
        if (settingsHost is null || acTemplateBox is null) return;
        if (double.IsNaN(settingsHost.ActualHeight) || settingsHost.ActualHeight <= 0) return;

        var tabTop = TabAgentChain.TranslatePoint(new Point(0, 0), settingsHost).Y;
        var boxTop = acTemplateBox.TranslatePoint(new Point(0, 0), settingsHost).Y;
        var below = acTemplateBox.Margin.Bottom
                  + (acTemplateCaption?.ActualHeight ?? 0) + (acTemplateCaption?.Margin.Top ?? 0);
        var reserved = boxTop - tabTop + below + 12; // 底部安全余量
        var available = settingsHost.ActualHeight - reserved;
        acTemplateBox.Height = Math.Max(140, available);   // 面板缩小同样回落，最低保持 140
    }

    // 项模板 Border 的悬浮事件：驱动未置顶图钉的 hover 显示（ElementName 绑定在模板内不可靠，改用事件）。
    private void OnItemMouseEnter(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is LinkAgentItemViewModel it)
            it.IsHovered = true;
    }

    private void OnItemMouseLeave(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is LinkAgentItemViewModel it)
            it.IsHovered = false;
    }

    // 名称区域：单击延迟 0.3 秒后切换勾选（等双击判定窗口），0.3 秒内双击则取消切换并打开编辑弹窗。
    // 名称已从复选框内容中移出：复选框单击即时切换，双击名称不再触发勾选切换。
    // 用隧道事件 PreviewMouseLeftButtonDown：在子控件处理前触发，保证在名称区域任意位置双击都能命中。
    private readonly DispatcherTimer _toggleTimer;
    private LinkAgentItemViewModel? _pendingToggle;
    private bool _pendingToggleOriginal;

    private void OnItemNamePreviewMouseLeftDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not LinkAgentItemViewModel it) return;

        // 单击名称：暂不切换，等双击窗口过后再应用（新单击到来说明上一个单击已确认是单击，先应用其切换）。
        if (e.ClickCount == 1)
        {
            ApplyPendingToggle();
            _pendingToggle = it;
            _pendingToggleOriginal = it.IsEnabled;
            _toggleTimer.Stop();
            _toggleTimer.Start();
            return;
        }
        if (e.ClickCount != 2) return;

        // 双击名称：取消/还原待应用的切换，勾选保持不变，再打开编辑弹窗。
        _toggleTimer.Stop();
        if (_pendingToggle is { } p)
        {
            if (p.IsEnabled != _pendingToggleOriginal) p.IsEnabled = _pendingToggleOriginal;
            _pendingToggle = null;
        }
        e.Handled = true;

        if (DataContext is not MainViewModel vm || vm.LinkSettings is not LinkAgentViewModel ls) return;
        var result = LinkAgentEditDialog.Show("编辑链接", it.Name, it.Vendor, it.Remark, it.IsPinned,
            it.Name.StartsWith("."), (raw, prependDot) => ls.ValidateEditName(it, raw, prependDot),
            it.IsPreset ? it.OriginalName : null, it.IsPreset ? it.PresetOriginalVendor : null);
        if (result != null) ls.ApplyEdit(it, result.Name, result.Vendor, result.Remark, result.Pinned, result.PrependDot);
    }

    /// <summary>双击判定窗口过后应用待切换的勾选（确认是单击）。</summary>
    private void OnToggleTimerTick(object? sender, EventArgs e) => ApplyPendingToggle();

    private void ApplyPendingToggle()
    {
        _toggleTimer.Stop();
        if (_pendingToggle is { } it)
        {
            it.IsEnabled = !_pendingToggleOriginal;
            _pendingToggle = null;
        }
    }

    // ==================== 预设图标库 ====================

    private PresetIconViewModel? PresetIcons => (DataContext as MainViewModel)?.PresetIcons;

    /// <summary>点击「添加图标…」：系统对话框多选 .ico 加入预设库。</summary>
    private void OnPresetAddClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var vm = PresetIcons; if (vm is null) return;
            var dlg = new Microsoft.Win32.OpenFileDialog
            {
                Title = "选择预设图标（可多选）",
                Filter = "图标/图片文件|*.ico;*.png;*.jpg;*.jpeg;*.bmp;*.gif|所有文件|*.*",
                Multiselect = true,
                CheckFileExists = true,
            };
            if (Directory.Exists(vm.DirectoryPath)) dlg.InitialDirectory = vm.DirectoryPath;
            if (dlg.ShowDialog(Application.Current?.MainWindow) != true) return;
            vm.AddFiles(dlg.FileNames, out _, out _);
        }
        catch (Exception ex) { _ = ex; }
    }

    /// <summary>面板级 Ctrl+V：图标页签下粘贴剪贴板图片为预设图标（文本框内不拦截，让文本粘贴正常工作）。</summary>
    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.V || Keyboard.Modifiers != ModifierKeys.Control) return;
        if (TabIcons is null || TabIcons.Visibility != Visibility.Visible) return;
        if (Keyboard.FocusedElement is TextBox) return;
        e.Handled = true;
        OnPasteIcon();
    }

    /// <summary>点击「粘贴图标」：从剪贴板添加预设图标到当前分组。</summary>
    private void OnPresetPasteClick(object sender, RoutedEventArgs e) => OnPasteIcon();

    private void OnPasteIcon()
    {
        try
        {
            var vm = PresetIcons; if (vm is null) return;
            vm.AddFromClipboard();
        }
        catch (Exception) { /* 剪贴板异常不崩面板 */ }
    }

    /// <summary>预设项悬浮：驱动删除按钮的 hover 显示。</summary>
    private void OnPresetItemMouseEnter(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is PresetIconItemViewModel it) it.IsHovered = true;
    }

    private void OnPresetItemMouseLeave(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is PresetIconItemViewModel it) it.IsHovered = false;
    }

    /// <summary>预设项按下：单击记录图标拖拽候选（超阈值进入插入条式拖动）；双击弹出重命名对话框。</summary>
    private void OnPresetItemPreviewLeftDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        try
        {
            var orig = (DependencyObject)e.OriginalSource;
            if (FindVisualParent<Button>(orig) != null) return;   // 删除按钮不发起拖拽
            if ((sender as FrameworkElement)?.DataContext is not PresetIconItemViewModel it) return;

            // 单击：记录拖拽候选（所属分组由可视树向上定位）；组/图标拖拽互斥
            if (e.ClickCount == 1)
            {
                if (_gDragGrp == null && !_gDragging && !_iDragging
                    && GroupUnderOrigin(orig) is { } g0)
                {
                    _iDragItem = it;
                    _iDragSrcGroup = g0;
                    _iDragStartWin = e.GetPosition(this);
                }
                return;
            }

            if (e.ClickCount != 2) return;
            if (DataContext is not MainViewModel vm || vm.PresetIcons is not PresetIconViewModel pi) return;
            var newName = PromptDialog.Show("重命名预设图标", "新名称", it.Name,
                raw => pi.ValidateRename(it.Name, raw));
            if (newName != null) pi.ApplyRename(it, newName.Trim());
        }
        catch (Exception) { /* 输入对话框异常不崩面板 */ }
    }

    /// <summary>删除预设项：先确认，再删除文件与记录。</summary>
    private void OnPresetDeleteClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if ((sender as FrameworkElement)?.DataContext is not PresetIconItemViewModel it) return;
            if (DataContext is not MainViewModel vm || vm.PresetIcons is not PresetIconViewModel pi) return;
            var ans = MessageBox.Show($"确定删除预设图标「{it.Name}」？",
                "删除确认", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (ans != MessageBoxResult.Yes) return;
            pi.Remove(it);
        }
        catch (Exception) { /* 删除异常不崩面板 */ }
    }

    // ==================== 图标分组管理 ====================

    /// <summary>单击折叠延迟定时器：文字区单击延迟切换，区分双击重命名与按住拖动。</summary>
    private DispatcherTimer? _iconGroupTimer;
    private IconGroupViewModel? _iconGroupTimerTarget;

    // ---- 集群式拖拽引擎（对齐主窗口项目组集群：悬浮跟随+视口锁定+贴边自动滚动+死区让位）----
    private const double GroupSwapHysteresis = 16.0;   // 换位死区基准 px；实际取它与邻框高 20% 的较小值
    private IconGroupViewModel? _gDragGrp;             // 拖拽候选/激活中的分组
    private Point _gDragStartWin;                      // 按下起点（窗口坐标）
    private bool _gDragging;
    private UIElement? _gFollowEl;                     // 被拖分组容器（Pin 住由本逻辑控制视觉）
    private double _gStartMouseY;                      // 跟随起点鼠标 Y（窗口坐标）
    private double _gStartLayoutTop;                   // 跟随起点布局顶（面板系）
    private double _gStartWinTop;                      // 跟随起点标题的窗口 Y（屏幕系目标基准）
    private double _gTitleH;                           // 标题高度（标题底不得越出视口）
    private Point _gLastPos;                           // 最近鼠标位置（自动滚动跳帧用）
    private DispatcherTimer? _gAutoScrollTimer;        // 贴边自动滚动定时器
    private AnimatedStackPanel? _gPanel;               // 让位面板缓存

    // ---- 图标项拖拽（二维网格：插入条模式，对齐主窗口卡片交互；组/图标互斥）----
    private PresetIconItemViewModel? _iDragItem;       // 拖拽候选/激活中的图标
    private IconGroupViewModel? _iDragSrcGroup;        // 图标所属源分组
    private Point _iDragStartWin;                      // 按下起点（窗口坐标）
    private bool _iDragging;
    private UIElement? _iSrcContainer;                 // 源项容器（半透明提示，结束还原）

    /// <summary>点击「添加分组」：在设置面板中新增一个图标分组。</summary>
    private void OnIconGroupAddClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if (PresetIcons is PresetIconViewModel vm) vm.AddGroup();
        }
        catch (Exception) { /* 新增异常不崩面板 */ }
    }

    /// <summary>分组标题按下：双击文字→内联重命名；文字区单击→延迟折叠；非文字区不动作（抬起立即折叠）。
    /// 任意非按钮/输入框区域同时记录为拖拽候选，超过阈值后进入集群式悬浮重排。</summary>
    private void OnIconGroupHeaderDown(object sender, MouseButtonEventArgs e)
    {
        try
        {
            if (sender is not FrameworkElement fe) return;
            if (fe.DataContext is not IconGroupViewModel grp) return;

            var orig = (DependencyObject)e.OriginalSource;
            if (FindVisualParent<Button>(orig) != null
                || FindVisualParent<TextBox>(orig) != null) return;

            // 上一次拖拽可能因异常未收尾：先回弹清理，避免悬浮偏移残留
            AbortGroupDrag();

            bool inText = FindVisualParentTagged<FrameworkElement>(orig, "IconGroupHeaderText") != null;

            // 双击文字区 → 取消待执行折叠并进入内联重命名（空白处双击不再触发重命名，与集群一致）
            if (e.ClickCount >= 2)
            {
                CancelIconGroupTimer();
                if (inText)
                {
                    grp.IsEditing = true;
                    EnterIconGroupEdit(fe);
                    e.Handled = true;   // 阻止继续隧道到文字面板的重复处理
                }
                return;
            }

            // 记录拖拽候选（窗口坐标）；拖拽激活时再取消延迟折叠
            _gDragGrp = grp;
            _gDragStartWin = e.GetPosition(this);

            // 文字区单击 → 延迟切换折叠（等双击判定窗口）；空白区交给抬起事件零延迟折叠
            if (inText)
            {
                CancelIconGroupTimer();
                _iconGroupTimerTarget = grp;
                _iconGroupTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
                _iconGroupTimer.Tick += OnIconGroupTimerTick;
                _iconGroupTimer.Start();
            }
        }
        catch (Exception) { /* 异常不崩面板 */ }
    }

    /// <summary>分组标题文字区按下：双击分支已在头部隧道事件统一处理，这里仅拦截冒泡副作用。</summary>
    private void OnIconGroupTextDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount >= 2) e.Handled = true;
    }

    /// <summary>分组标题抬起：非文字、非按钮/输入框、未进入拖动时立即折叠/展开（零延迟，与集群一致）。</summary>
    private void OnIconGroupHeaderUp(object sender, MouseButtonEventArgs e)
    {
        if (_gDragging || e.ClickCount != 1) return;
        if ((sender as FrameworkElement)?.DataContext is not IconGroupViewModel grp) return;
        var orig = (DependencyObject)e.OriginalSource;
        if (FindVisualParent<Button>(orig) != null || FindVisualParent<TextBox>(orig) != null) return;
        if (FindVisualParentTagged<FrameworkElement>(orig, "IconGroupHeaderText") != null) return;   // 文字区走延迟路径
        grp.IsCollapsed = !grp.IsCollapsed;
    }

    /// <summary>进入图标分组内联重命名：定位标题栏内的输入框并聚焦全选（延迟到渲染后，等 TextBox 由 IsEditing 变为可见）。</summary>
    private void EnterIconGroupEdit(FrameworkElement header)
    {
        var tb = FindVisualChild<TextBox>(header);
        if (tb == null) return;
        tb.Dispatcher.BeginInvoke(new System.Action(() => { tb.Focus(); tb.SelectAll(); }),
            System.Windows.Threading.DispatcherPriority.Render);
    }

    /// <summary>图标分组重命名输入框：Enter 提交、Esc 取消。</summary>
    private void OnIconGroupNameKeyDown(object sender, KeyEventArgs e)
    {
        if (sender is not TextBox tb || tb.DataContext is not IconGroupViewModel grp) return;
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            grp.IsEditing = false;
            CommitIconGroupRename(grp, tb.Text);
        }
        else if (e.Key == Key.Escape)
        {
            e.Handled = true;
            grp.IsEditing = false;
        }
    }

    /// <summary>图标分组重命名输入框失焦：提交（与 Enter 一致）。</summary>
    private void OnIconGroupNameLostFocus(object sender, RoutedEventArgs e)
    {
        if (sender is not TextBox tb || tb.DataContext is not IconGroupViewModel grp || !grp.IsEditing) return;
        CommitIconGroupRename(grp, tb.Text);
        grp.IsEditing = false;
    }

    /// <summary>提交图标分组重命名：校验并落盘，成功则更新显示名；失败时回显并停留编辑以便修正。</summary>
    private void CommitIconGroupRename(IconGroupViewModel grp, string newName)
    {
        if (PresetIcons is not PresetIconViewModel pi) return;
        var err = pi.ValidateGroupName(newName);
        if (err != null)
        {
            pi.Error = err; // 借图标页红字提示展示失败原因
            grp.IsEditing = true; // 失败留在编辑态，用户可继续改
            return;
        }
        pi.Error = null;
        pi.RenameGroup(grp, newName.Trim());
    }

    /// <summary>单击折叠延迟定时器触发：切换折叠/展开。</summary>
    private void OnIconGroupTimerTick(object? sender, EventArgs e)
    {
        var grp = _iconGroupTimerTarget;
        CancelIconGroupTimer();
        if (grp == null) return;
        grp.IsCollapsed = !grp.IsCollapsed;
    }

    private void CancelIconGroupTimer()
    {
        if (_iconGroupTimer != null)
        {
            _iconGroupTimer.Stop();
            _iconGroupTimer.Tick -= OnIconGroupTimerTick;
            _iconGroupTimer = null;
        }
        _iconGroupTimerTarget = null;
    }

    // ---- 集群式拖拽引擎（悬浮跟随 + 视口锁定 + 贴边自动滚动 + 死区让位）----

    /// <summary>全局移动：按候选类型调度到分组拖拽或图标拖拽。左键释放兜底直接落位。</summary>
    private void OnGroupDragMove(object sender, MouseEventArgs e)
    {
        if (_gDragGrp == null && _iDragItem == null) return;
        Point pos = e.GetPosition(this);
        if (e.LeftButton == MouseButtonState.Released)
        {
            if (_iDragging) CompleteIconDrag(pos); else CompleteGroupDrag(pos);
            return;
        }

        if (_gDragGrp != null)
        {
            try
            {
                if (!_gDragging)
                {
                    double dx = pos.X - _gDragStartWin.X, dy = pos.Y - _gDragStartWin.Y;
                    if (Math.Sqrt(dx * dx + dy * dy) < SystemParameters.MinimumHorizontalDragDistance) return;
                    StartGroupFollow(pos);
                }
                TryLiveGroupSwap(pos);
                UpdateGroupFollow(pos);
                UpdateGroupInsertBar();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(ex);
                AbortGroupDrag();   // 拖拽中瞬时布局异常不弹窗打断，安全回弹结束
            }
            return;
        }

        // 图标项拖拽分支（二维网格插入条模式）
        try
        {
            if (!_iDragging)
            {
                double dx = pos.X - _iDragStartWin.X, dy = pos.Y - _iDragStartWin.Y;
                if (Math.Sqrt(dx * dx + dy * dy) < SystemParameters.MinimumHorizontalDragDistance) return;
                StartIconDrag();
            }
            UpdateIconDragFeedback(pos);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine(ex);
            AbortIconDrag();
        }
    }

    private void OnGroupDragUp(object sender, MouseButtonEventArgs e)
    {
        bool active = _gDragging || _iDragging;
        if (active) e.Handled = true;   // 仅真正发生拖拽时拦截；普通单击保留按钮 Click 等行为
        Point pos = e.GetPosition(this);
        if (_iDragging) { CompleteIconDrag(pos); return; }
        CompleteGroupDrag(pos);         // 内部对未激活情形只做候选清理
        _iDragItem = null;              // 未激活的单击：清图标候选
    }

    private void StartGroupFollow(Point pos)
    {
        if (PresetIcons is not PresetIconViewModel pi || iconGroupList == null) return;
        int i = pi.Groups.IndexOf(_gDragGrp!);
        if (i < 0 || GroupContainerAt(i) is not UIElement el) return;

        _gDragging = true;
        CaptureMouse();
        Cursor = Cursors.SizeAll;
        CancelIconGroupTimer();   // 拖动取消待执行的单击折叠
        HideGroupInsertBar();

        _gFollowEl = el;
        _gStartMouseY = pos.Y;
        _gStartLayoutTop = VisualTreeHelper.GetOffset(el).Y;
        _gStartWinTop = iconGroupList.TranslatePoint(new Point(0, _gStartLayoutTop), this).Y;   // 屏幕系目标基准
        _gTitleH = FindDescendantByTag(el, "IconGroupHeaderText")?.RenderSize.Height ?? 28;
        _gLastPos = pos;
        _gPanel ??= FindVisualChild<AnimatedStackPanel>(iconGroupList);
        _gPanel?.Pin(el);   // 布局换位时不给被拖分组播放动画/清偏移
        StartAutoScroll();
    }

    /// <summary>悬浮跟随：目标标题窗口 Y 夹在滚动视口内（标题不越出可视框），换算回面板系设置偏移；X 不动。</summary>
    private void UpdateGroupFollow(Point pos)
    {
        if (iconGroupList == null || iconListScroll == null || _gFollowEl == null) return;
        _gLastPos = pos;

        double desiredWinTop = _gStartWinTop + (pos.Y - _gStartMouseY);
        Point o = iconListScroll.TranslatePoint(new Point(0, 0), this);           // 视口顶（随滚动变化）
        double lo = o.Y, hi = o.Y + iconListScroll.ViewportHeight - _gTitleH;
        if (hi < lo) hi = lo;
        desiredWinTop = Math.Clamp(desiredWinTop, lo, hi);

        double panelVisualTop = desiredWinTop - iconGroupList.TranslatePoint(new Point(0, 0), this).Y;   // 窗口→面板（含当前滚动）
        double curTop = VisualTreeHelper.GetOffset(_gFollowEl).Y;                 // 实时换位后的最新布局顶
        AnimatedStackPanel.SetDirectOffset(_gFollowEl, panelVisualTop - curTop);
    }

    /// <summary>探测点（窗口坐标）：TitleY=标题顶（向上换位的前导边），CenterY=视觉中心（向下换位用）。</summary>
    private (double TitleY, double CenterY)? FloatingProbeWindowY()
    {
        if (iconGroupList == null || _gFollowEl == null) return null;
        double curTop = VisualTreeHelper.GetOffset(_gFollowEl).Y;
        double off = _gFollowEl.RenderTransform switch
        {
            TranslateTransform t => t.Y,
            TransformGroup g => g.Children.OfType<TranslateTransform>().FirstOrDefault()?.Y ?? 0,
            _ => 0,
        };
        double winTop = iconGroupList.TranslatePoint(new Point(0, curTop + off), this).Y;
        return (winTop, winTop + _gFollowEl.RenderSize.Height / 2);
    }

    /// <summary>分组容器相对 target 的「布局」顶边 Y（不含让位动画偏移），插入判定与蓝线定位专用。</summary>
    private double GroupLayoutTopIn(UIElement el, UIElement target)
    {
        if (iconGroupList == null) return 0;
        double inPanel = VisualTreeHelper.GetOffset(el).Y;
        return iconGroupList.TranslatePoint(new Point(0, inPanel), target).Y;
    }

    private UIElement? GroupContainerAt(int i)
    {
        if (iconGroupList == null) return null;
        var gen = iconGroupList.ItemContainerGenerator;
        if (gen.Status != System.Windows.Controls.Primitives.GeneratorStatus.ContainersGenerated) return null;
        return gen.ContainerFromIndex(i) as UIElement;
    }

    /// <summary>实时换位：混合探测+死区索引变化即 MoveGroup（服务落盘 + Groups.Move 保容器实例）。</summary>
    private void TryLiveGroupSwap(Point pos)
    {
        if (PresetIcons is not PresetIconViewModel pi || _gDragGrp == null || iconGroupList == null || _gFollowEl == null) return;
        int from = pi.Groups.IndexOf(_gDragGrp);
        var probe = FloatingProbeWindowY();
        int toIdx = GetSwapIndex(probe?.CenterY ?? pos.Y, probe?.TitleY ?? pos.Y, from);
        if (from >= 0 && toIdx != from)
        {
            pi.MoveGroup(from, toIdx);
            iconGroupList.UpdateLayout();   // 立即取得新布局顶，保证悬浮分组视觉连续不跳
        }
    }

    /// <summary>带死区的换位索引：向下=视觉中心越过下邻框中心+死区；向上=标题越过上邻框中心−死区；
    /// 死区内保持原索引（进入死区前的落点）；支持一次跨越多框推进（快速甩动也能追上）。</summary>
    private int GetSwapIndex(double centerY, double titleY, int from)
    {
        if (iconGroupList == null) return Math.Max(0, from);
        int n = iconGroupList.Items.Count;
        if (n == 0 || from < 0) return 0;
        int idx = Math.Clamp(from, 0, n - 1);
        for (int guard = 0; guard < n; guard++)
        {
            int next = idx;
            if (idx + 1 < n && GroupContainerAt(idx + 1) is UIElement below)
            {
                double margin = Math.Min(GroupSwapHysteresis, below.RenderSize.Height * 0.2);
                if (centerY > GroupLayoutTopIn(below, this) + below.RenderSize.Height / 2 + margin)
                    next = idx + 1;
            }
            if (next == idx && idx - 1 >= 0 && GroupContainerAt(idx - 1) is UIElement above)
            {
                double margin = Math.Min(GroupSwapHysteresis, above.RenderSize.Height * 0.2);
                if (titleY < GroupLayoutTopIn(above, this) + above.RenderSize.Height / 2 - margin)
                    next = idx - 1;
            }
            if (next == idx) break;
            idx = next;
        }
        return idx;
    }

    /// <summary>分组标题悬浮：显示删除按钮。</summary>
    private void OnIconGroupMouseEnter(object sender, MouseEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is IconGroupViewModel grp)
            grp.IsHovered = true;
    }

    /// <summary>分组标题离开：隐藏删除按钮。</summary>
    private void OnIconGroupMouseLeave(object sender, MouseEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is IconGroupViewModel grp)
            grp.IsHovered = false;
    }

    private void StartAutoScroll()
    {
        if (_gAutoScrollTimer != null) return;
        _gAutoScrollTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(16) };
        _gAutoScrollTimer.Tick += OnAutoScrollTick;
        _gAutoScrollTimer.Start();
    }

    private void StopAutoScroll()
    {
        if (_gAutoScrollTimer == null) return;
        _gAutoScrollTimer.Stop();
        _gAutoScrollTimer.Tick -= OnAutoScrollTick;
        _gAutoScrollTimer = null;
    }

    /// <summary>贴边自动滚动：指针进入滚动区上/下边缘 56px 按侵入深度加速；每跳依次「贴手→让位→校正」。</summary>
    private void OnAutoScrollTick(object? sender, EventArgs e)
    {
        if (_gFollowEl == null || iconListScroll == null) { StopAutoScroll(); return; }
        Point o = iconListScroll.TranslatePoint(new Point(0, 0), this);
        double vpTop = o.Y, vpBottom = o.Y + iconListScroll.ViewportHeight;
        const double zone = 56.0, minSpeed = 4.0, maxSpeed = 18.0;
        double pY = _gLastPos.Y;
        double delta;
        if (pY > vpBottom - zone)
            delta = minSpeed + (maxSpeed - minSpeed) * Math.Min(1, (pY - (vpBottom - zone)) / zone);
        else if (pY < vpTop + zone)
            delta = -(minSpeed + (maxSpeed - minSpeed) * Math.Min(1, ((vpTop + zone) - pY) / zone));
        else return;

        double target = Math.Clamp(iconListScroll.VerticalOffset + delta, 0, iconListScroll.ScrollableHeight);
        if (Math.Abs(target - iconListScroll.VerticalOffset) < 0.01) return;   // 已到滚动尽头
        iconListScroll.ScrollToVerticalOffset(target);
        UpdateGroupFollow(_gLastPos);   // 滚动后重算偏移保持贴手
        TryLiveGroupSwap(_gLastPos);    // 内容滚过悬浮中心也要触发让位换位
        UpdateGroupFollow(_gLastPos);   // 换位改变布局顶后再校正一次
    }

    /// <summary>插入位置横条：按死区索引定位到目标缝隙（布局坐标换算到覆盖层，不受让位动画影响）。</summary>
    private void UpdateGroupInsertBar()
    {
        if (PresetIcons is not PresetIconViewModel pi || _gDragGrp == null
            || iconInsertBar == null || iconDragOverlay == null || iconGroupList == null) return;
        int from = pi.Groups.IndexOf(_gDragGrp);
        var probe = FloatingProbeWindowY();
        int idx = GetSwapIndex(probe?.CenterY ?? _gLastPos.Y, probe?.TitleY ?? _gLastPos.Y, from);
        int n = iconGroupList.Items.Count;
        if (n == 0) { HideGroupInsertBar(); return; }
        UIElement? e;
        double yOffset = 0;
        if (idx <= 0) e = GroupContainerAt(0);
        else if (idx >= n) { e = GroupContainerAt(n - 1); yOffset = e?.RenderSize.Height ?? 0; }
        else e = GroupContainerAt(idx);
        if (e == null) { HideGroupInsertBar(); return; }

        double top = GroupLayoutTopIn(e, iconDragOverlay) + yOffset;
        Point x0 = e.TranslatePoint(new Point(0, 0), iconDragOverlay);
        Canvas.SetLeft(iconInsertBar, x0.X);
        Canvas.SetTop(iconInsertBar, top - 1);
        iconInsertBar.Width = e.RenderSize.Width;
        iconInsertBar.Visibility = Visibility.Visible;
    }

    private void HideGroupInsertBar()
    {
        if (iconInsertBar != null) iconInsertBar.Visibility = Visibility.Collapsed;
    }

    /// <summary>结束拖拽：解除钉住；需补换位则同步布局后由让位面板从松手位置滑入槽位，否则回弹原位。</summary>
    private void CompleteGroupDrag(Point pos)
    {
        var el = _gFollowEl;
        var probe = FloatingProbeWindowY();
        var grp = _gDragGrp;
        _gFollowEl = null;
        _gDragGrp = null;
        _gDragging = false;
        StopAutoScroll();
        HideGroupInsertBar();
        if (IsMouseCaptured) ReleaseMouseCapture();
        if (Cursor == Cursors.SizeAll) Cursor = Cursors.Arrow;
        if (el == null) return;

        _gPanel?.Unpin(el);
        try
        {
            if (PresetIcons is PresetIconViewModel pi && grp != null && iconGroupList != null)
            {
                int from = pi.Groups.IndexOf(grp);
                int toIdx = GetSwapIndex(probe?.CenterY ?? pos.Y, probe?.TitleY ?? pos.Y, from);
                if (from >= 0 && toIdx != from)
                {
                    pi.MoveGroup(from, toIdx);
                    iconGroupList.UpdateLayout();
                    return;   // 面板以松手视觉位置为起点滑入新槽位，无需手动算起跳点
                }
            }
        }
        catch (Exception) { /* 落位异常不崩面板 */ }
        AnimatedStackPanel.SpringBack(el);   // 无换位 → 回弹原位
    }

    /// <summary>中断/兜底：回弹原位并复位全部拖拽状态（异常路径与二次按下清理共用）。</summary>
    private void AbortGroupDrag()
    {
        if (_gDragGrp == null && !_gDragging) return;
        var el = _gFollowEl;
        _gFollowEl = null;
        _gDragGrp = null;
        _gDragging = false;
        StopAutoScroll();
        HideGroupInsertBar();
        if (IsMouseCaptured) ReleaseMouseCapture();
        if (Cursor == Cursors.SizeAll) Cursor = Cursors.Arrow;
        if (el != null)
        {
            _gPanel?.Unpin(el);
            AnimatedStackPanel.SpringBack(el);
        }
    }

    /// <summary>向下查找首个 Tag 等于指定值的元素（定位被拖分组容器内的标题文字区）。</summary>
    private static FrameworkElement? FindDescendantByTag(DependencyObject? root, string tag)
    {
        if (root == null) return null;
        if (root is FrameworkElement fe && fe.Tag as string == tag) return fe;
        int n = VisualTreeHelper.GetChildrenCount(root);
        for (int i = 0; i < n; i++)
            if (FindDescendantByTag(VisualTreeHelper.GetChild(root, i), tag) is { } found) return found;
        return null;
    }

    // ---- 图标项拖拽引擎（二维网格：插入条 + 跨组高亮，无悬浮幽灵，对齐主窗口卡片交互）----

    private void StartIconDrag()
    {
        _iDragging = true;
        CaptureMouse();
        Cursor = Cursors.SizeAll;
        CancelIconGroupTimer();   // 防御：取消可能待执行的分组折叠
        _iSrcContainer = FindIconItemContainer(_iDragItem!);
        if (_iSrcContainer != null) _iSrcContainer.Opacity = 0.55;   // 源项半透明提示被拖动
    }

    /// <summary>定位某图标项的容器（遍历各分组的内部 ItemsControl）。</summary>
    private UIElement? FindIconItemContainer(PresetIconItemViewModel item)
    {
        if (iconGroupList == null) return null;
        var gen = iconGroupList.ItemContainerGenerator;
        if (gen.Status != System.Windows.Controls.Primitives.GeneratorStatus.ContainersGenerated) return null;
        for (int gi = 0; gi < iconGroupList.Items.Count; gi++)
        {
            if (gen.ContainerFromIndex(gi) is not ContentPresenter gpc || gpc.DataContext is not IconGroupViewModel g
                || !g.Items.Contains(item)) continue;
            var host = IconItemHost(gpc);
            if (host == null) continue;
            var igen = host.ItemContainerGenerator;
            if (igen.Status != System.Windows.Controls.Primitives.GeneratorStatus.ContainersGenerated) continue;
            for (int ii = 0; ii < innerCount(host); ii++)
                if (igen.ContainerFromIndex(ii) is ContentPresenter ip && ReferenceEquals(ip.DataContext, item))
                    return ip;
        }
        return null;
    }

    private static int innerCount(ItemsControl host) => host.Items.Count;

    /// <summary>取分组容器的内部图标网格 ItemsControl。</summary>
    private ItemsControl? IconItemHost(UIElement groupContainer)
        => FindVisualChild<ItemsControl>(FindDescendantByTag(groupContainer, "IconGroupDropArea") ?? groupContainer);

    /// <summary>解析指针所在分组与插入位；悬停折叠分组=追加末尾。找不到返回 null。</summary>
    private (IconGroupViewModel Grp, UIElement GrpContainer, ItemsControl? Host, int Index)? ResolveIconTarget(Point pos)
    {
        if (PresetIcons is not PresetIconViewModel pi || iconGroupList == null) return null;
        var gen = iconGroupList.ItemContainerGenerator;
        if (gen.Status != System.Windows.Controls.Primitives.GeneratorStatus.ContainersGenerated) return null;
        for (int gi = 0; gi < pi.Groups.Count; gi++)
        {
            if (gen.ContainerFromIndex(gi) is not ContentPresenter gpc || gpc.DataContext is not IconGroupViewModel g) continue;
            if (!PointOverPanel(gpc, pos)) continue;
            var host = g.IsCollapsed ? null : IconItemHost(gpc);
            int idx = host == null ? g.Items.Count : GetIconInsertIndex(host, pos);
            return (g, gpc, host, idx);
        }
        return null;
    }

    private bool PointOverPanel(UIElement el, Point winPos)
    {
        if (!el.IsVisible) return false;
        Point o = el.TranslatePoint(new Point(0, 0), this);
        return new Rect(o, el.RenderSize).Contains(winPos);
    }

    /// <summary>网格内插入位索引（0..Count）：最近图标中心距离判定，指针在其中心左右决定前/后。</summary>
    private int GetIconInsertIndex(ItemsControl host, Point winPos)
    {
        int n = host.Items.Count;
        if (n == 0) return 0;
        Point org = host.TranslatePoint(new Point(0, 0), this);
        var p = new Point(winPos.X - org.X, winPos.Y - org.Y);   // 转宿主局部坐标

        int nearest = 0;
        double best = double.MaxValue;
        for (int i = 0; i < n; i++)
        {
            if (ContainerAt(host, i) is not UIElement el) continue;
            Point c = el.TranslatePoint(new Point(el.RenderSize.Width / 2, el.RenderSize.Height / 2), host);
            double dx = c.X - p.X, dy = c.Y - p.Y;
            double d = dx * dx + dy * dy;
            if (d < best) { best = d; nearest = i; }
        }
        if (ContainerAt(host, nearest) is UIElement ne)
        {
            double cx = ne.TranslatePoint(new Point(ne.RenderSize.Width / 2, 0), host).X;
            return p.X < cx ? nearest : nearest + 1;
        }
        return nearest;
    }

    private static UIElement? ContainerAt(ItemsControl host, int i)
    {
        var gen = host.ItemContainerGenerator;
        if (gen.Status != System.Windows.Controls.Primitives.GeneratorStatus.ContainersGenerated) return null;
        return gen.ContainerFromIndex(i) as UIElement;
    }

    /// <summary>拖动反馈：缝隙竖条（同组/跨组网格通用）+ 跨组目标高亮框。</summary>
    private void UpdateIconDragFeedback(Point pos)
    {
        if (iconItemBar == null || iconTargetBox == null || iconDragOverlay == null || _iDragSrcGroup == null) return;
        var t = ResolveIconTarget(pos);
        if (t == null) { HideIconFeedback(); return; }

        // 跨组目标：高亮整组容器；同组不显示框
        if (!ReferenceEquals(t.Value.Grp, _iDragSrcGroup))
        {
            Point o = t.Value.GrpContainer.TranslatePoint(new Point(0, 0), iconDragOverlay);
            Canvas.SetLeft(iconTargetBox, o.X);
            Canvas.SetTop(iconTargetBox, o.Y);
            iconTargetBox.Width = t.Value.GrpContainer.RenderSize.Width;
            iconTargetBox.Height = t.Value.GrpContainer.RenderSize.Height;
            iconTargetBox.Visibility = Visibility.Visible;
        }
        else
        {
            iconTargetBox.Visibility = Visibility.Collapsed;
        }

        var host = t.Value.Host;
        if (host == null) { iconItemBar.Visibility = Visibility.Collapsed; return; }
        int idx = Math.Clamp(t.Value.Index, 0, host.Items.Count);
        if (host.Items.Count == 0)
        {
            Point ho = host.TranslatePoint(new Point(1, 1), iconDragOverlay);
            Canvas.SetLeft(iconItemBar, ho.X);
            Canvas.SetTop(iconItemBar, ho.Y);
            iconItemBar.Height = Math.Max(20, host.RenderSize.Height - 2);
            iconItemBar.Visibility = Visibility.Visible;
            return;
        }

        UIElement? anchor;
        double xoff = 0;
        if (idx < host.Items.Count) anchor = ContainerAt(host, idx);
        else { anchor = ContainerAt(host, host.Items.Count - 1); xoff = anchor?.RenderSize.Width ?? 0; }
        if (anchor == null) { iconItemBar.Visibility = Visibility.Collapsed; return; }

        Point a0 = anchor.TranslatePoint(new Point(xoff, 0), iconDragOverlay);
        Canvas.SetLeft(iconItemBar, a0.X - 1);
        Canvas.SetTop(iconItemBar, a0.Y);
        iconItemBar.Height = anchor.RenderSize.Height;
        iconItemBar.Visibility = Visibility.Visible;
    }

    private void HideIconFeedback()
    {
        if (iconItemBar != null) iconItemBar.Visibility = Visibility.Collapsed;
        if (iconTargetBox != null) iconTargetBox.Visibility = Visibility.Collapsed;
    }

    /// <summary>图标落位：同组→组内重排；异组→移入对应位置（均轻量同步并落盘）。</summary>
    private void CompleteIconDrag(Point pos)
    {
        var item = _iDragItem;
        var srcGrp = _iDragSrcGroup;
        _iDragItem = null;
        _iDragSrcGroup = null;
        _iDragging = false;
        HideIconFeedback();
        if (_iSrcContainer != null) { _iSrcContainer.Opacity = 1; _iSrcContainer = null; }
        if (IsMouseCaptured) ReleaseMouseCapture();
        if (Cursor == Cursors.SizeAll) Cursor = Cursors.Arrow;
        if (item == null || srcGrp == null) return;

        try
        {
            if (PresetIcons is not PresetIconViewModel pi) return;
            var t = ResolveIconTarget(pos);

            if (t == null || ReferenceEquals(t.Value.Grp, srcGrp))
            {
                // 同组重排：to 直接用指针指示的落位索引（MoveIcon 服务与 Items.Move 均为"最终落位"语义，无需 -1）
                int from = srcGrp.Items.IndexOf(item);
                if (from < 0) return;
                int to = t == null ? srcGrp.Items.Count : t.Value.Index;
                to = Math.Clamp(to, 0, srcGrp.Items.Count - 1);
                if (to != from) pi.ReorderIcon(srcGrp, from, to);
                return;
            }

            pi.MoveIconToGroup(item, t.Value.Grp, t.Value.Index);   // 跨组移动
        }
        catch (Exception) { /* 落位异常不崩面板 */ }
    }

    /// <summary>图标拖拽中断兜底：还原源项外观并复位状态。</summary>
    private void AbortIconDrag()
    {
        _iDragItem = null;
        _iDragSrcGroup = null;
        if (!_iDragging) return;
        _iDragging = false;
        HideIconFeedback();
        if (_iSrcContainer != null) { _iSrcContainer.Opacity = 1; _iSrcContainer = null; }
        if (IsMouseCaptured) ReleaseMouseCapture();
        if (Cursor == Cursors.SizeAll) Cursor = Cursors.Arrow;
    }

    /// <summary>分组区拖拽悬停：仅接受图标文件拖入（分组重排已改为集群式内部拖动，不再走 OLE Drop）。</summary>
    private void OnIconGroupDragOver(object sender, DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent(System.Windows.DataFormats.FileDrop)
            ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }

    /// <summary>分组区拖放：图标文件加入鼠标命中的分组。</summary>
    private void OnIconGroupDrop(object sender, DragEventArgs e)
    {
        try
        {
            if (!e.Data.GetDataPresent(System.Windows.DataFormats.FileDrop)) return;
            var files = ((string[]?)e.Data.GetData(System.Windows.DataFormats.FileDrop)) ?? Array.Empty<string>();
            if (files.Length > 0 && GroupUnderOrigin(e.OriginalSource as DependencyObject) is { } grp
                && PresetIcons is PresetIconViewModel vm)
            {
                vm.AddFilesToGroup(grp, files, out _, out _);
                e.Handled = true;
            }
        }
        catch (Exception) { /* 拖放异常不崩面板 */ }
    }

    /// <summary>沿可视树向上找到第一个数据上下文为图标分组的元素（用于文件拖入定位目标分组）。</summary>
    private static IconGroupViewModel? GroupUnderOrigin(DependencyObject? d)
    {
        while (d is not null)
        {
            if (d is FrameworkElement fe && fe.DataContext is IconGroupViewModel g) return g;
            d = d is System.Windows.ContentElement ce ? LogicalTreeHelper.GetParent(ce) : VisualTreeHelper.GetParent(d);
        }
        return null;
    }

    /// <summary>折叠/展开分组。</summary>
    private void OnToggleIconGroupCollapse(object sender, RoutedEventArgs e)
    {
        try
        {
            if ((sender as FrameworkElement)?.DataContext is IconGroupViewModel grp)
                grp.IsCollapsed = !grp.IsCollapsed;
        }
        catch (Exception) { /* 异常不崩面板 */ }
    }

    /// <summary>删除分组：先确认（含组内图标数），再删除。至少保留一个分组。</summary>
    private void OnIconGroupDeleteClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if ((sender as FrameworkElement)?.DataContext is not IconGroupViewModel grp) return;
            if (DataContext is not MainViewModel vm || vm.PresetIcons is not PresetIconViewModel pi) return;
            if (pi.Groups.Count <= 1)
            {
                MessageBox.Show("至少保留一个分组。", "无法删除", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            var msg = grp.Count > 0
                ? $"确定删除分组「{grp.Name}」？组内 {grp.Count} 个图标将被一并删除。"
                : $"确定删除分组「{grp.Name}」？";
            var ans = MessageBox.Show(msg, "删除确认", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (ans != MessageBoxResult.Yes) return;
            pi.RemoveGroup(grp);
        }
        catch (Exception) { /* 删除异常不崩面板 */ }
    }

    // ==================== 辅助方法 ====================

    /// <summary>安全取父节点：ContentElement（如文本 Run/Span）不参与可视化树，先经逻辑树跨出，避免 VisualTreeHelper 抛异常。</summary>
    private static DependencyObject? SafeGetParent(DependencyObject d)
        => d is System.Windows.ContentElement ce ? LogicalTreeHelper.GetParent(ce) : VisualTreeHelper.GetParent(d);

    /// <summary>在可视树中向上查找指定类型的父元素。</summary>
    private static T? FindVisualParent<T>(DependencyObject? child) where T : DependencyObject
    {
        while (child != null)
        {
            if (child is T t) return t;
            child = SafeGetParent(child);
        }
        return null;
    }

    /// <summary>在可视树中向下深度优先查找指定类型的子元素。</summary>
    private static T? FindVisualChild<T>(DependencyObject? root) where T : DependencyObject
    {
        if (root is null) return null;
        for (int i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is T t) return t;
            if (FindVisualChild<T>(child) is { } found) return found;
        }
        return null;
    }

    /// <summary>在可视树中向上查找 Tag 为指定值的父元素。</summary>
    private static T? FindVisualParentTagged<T>(DependencyObject? child, string tag) where T : FrameworkElement
    {
        while (child != null)
        {
            if (child is T fe && fe.Tag as string == tag) return fe;
            child = SafeGetParent(child);
        }
        return null;
    }

    // ==================== 软件图标（拖入 / 粘贴 / 浏览 → 暂存预览 → 确认/取消/恢复默认） ====================

    private BitmapSource? _appIconPendingImage;   // 暂存的剪贴板位图（确认时才真正转换）
    private string? _appIconPendingFile;          // 暂存的图片文件路径（优先于位图）
    private ImageSource? _appIconPendingPreview;   // 暂存的预览图（供确认/取消前展示）

    /// <summary>设置面板 Loaded 后初始化软件图标预览（显示当前已应用的图标）。</summary>
    private void InitAppIconPreview()
    {
        ClearAppIconPending(silent: true);
    }

    /// <summary>刷新软件图标预览：有暂存图先显示暂存，否则回显当前已应用图标。</summary>
    private void RefreshAppIconPreview()
    {
        if (appIconPreview == null) return;
        appIconPreview.Source = _appIconPendingPreview
            ?? (DataContext as MainViewModel)?.CurrentAppIcon;
    }

    /// <summary>拖入软件图标区域：仅接受受支持的图片文件，否则禁止。</summary>
    private void OnAppIconDropZoneDragOver(object sender, DragEventArgs e)
    {
        bool ok = false;
        if (e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            var files = (string[]?)e.Data.GetData(DataFormats.FileDrop);
            ok = files is { Length: > 0 } && Services.AppIconService.IsSupportedFile(files[0]);
        }
        e.Effects = ok ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }

    /// <summary>拖入软件图标区域：取首个受支持图片文件进入暂存预览。</summary>
    private void OnAppIconDropZoneDrop(object sender, DragEventArgs e)
    {
        try
        {
            if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
            var files = (string[]?)e.Data.GetData(DataFormats.FileDrop) ?? Array.Empty<string>();
            var file = files.FirstOrDefault(Services.AppIconService.IsSupportedFile);
            if (file != null) StageAppIcon(null, file);
        }
        catch (Exception) { /* 拖放异常不崩面板 */ }
    }

    /// <summary>「浏览…」选择图片文件进入暂存预览。</summary>
    private void OnAppIconBrowseClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var dlg = new Microsoft.Win32.OpenFileDialog
            {
                Title = "选择软件图标",
                Filter = "图标/图片文件|*.ico;*.png;*.bmp;*.jpg;*.jpeg;*.gif|所有文件|*.*",
                CheckFileExists = true,
            };
            if (dlg.ShowDialog(Window.GetWindow(this)) != true) return;
            StageAppIcon(null, dlg.FileName);
        }
        catch (Exception) { /* 选择异常不崩面板 */ }
    }

    /// <summary>「粘贴」：从剪贴板取图片进入暂存预览（优先位图，其次受支持图片文件）。</summary>
    private void OnAppIconPasteClick(object sender, RoutedEventArgs e)
    {
        try
        {
            BitmapSource? img = null;
            string? file = null;
            if (Clipboard.ContainsImage())
            {
                img = Clipboard.GetImage();
            }
            else if (Clipboard.ContainsFileDropList())
            {
                file = Clipboard.GetFileDropList().Cast<string>()
                    .FirstOrDefault(x => Services.AppIconService.IsSupportedFile(x) && File.Exists(x));
                if (file != null)
                {
                    using var fs = File.OpenRead(file);
                    var bi = new BitmapImage();
                    bi.BeginInit();
                    bi.StreamSource = fs;
                    bi.CacheOption = BitmapCacheOption.OnLoad;
                    bi.EndInit();
                    img = bi;
                }
            }
            if (img == null)
            {
                ShowAppIconStatus("剪贴板中没有可用的图片。", false);
                return;
            }
            var frozen = img.Clone();
            frozen.Freeze();
            StageAppIcon(frozen, file);
        }
        catch (Exception) { /* 剪贴板异常不崩面板 */ }
    }

    /// <summary>「确认应用」：把暂存的图片生成为软件图标并保存，启用「恢复默认」，清空暂存。</summary>
    private void OnAppIconConfirmClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if (DataContext is not MainViewModel vm) return;
            var ok = vm.ApplyCustomAppIcon(_appIconPendingImage, _appIconPendingFile);
            ClearAppIconPending(silent: true);
            if (!ok)
            {
                ShowAppIconStatus("图标应用失败。", false);
                return;
            }
            // 图标同时应用到 exe 文件：退出后由后台助手改写并自动重启
            if (!ScheduleExeIconApply(vm.CustomAppIcon, out var msg))
            {
                ShowAppIconStatus(msg, false);
                return;
            }
            ShowAppIconStatus("已确认应用（exe 与任务栏固定图标），软件将自动重启生效…", true);
        }
        catch (Exception) { /* 确认异常不崩面板 */ }
    }

    /// <summary>「取消」：放弃当前暂存的预览，不做任何改动。</summary>
    private void OnAppIconCancelClick(object sender, RoutedEventArgs e)
    {
        try
        {
            ClearAppIconPending(silent: true);
            ShowAppIconStatus("已取消，未做任何改动。", true);
        }
        catch (Exception) { /* 取消异常不崩面板 */ }
    }

    /// <summary>「恢复默认」：清除自定义软件图标。</summary>
    private void OnAppIconResetClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if (DataContext is not MainViewModel vm) return;
            vm.ResetCustomAppIcon();
            ClearAppIconPending(silent: true);
            // 恢复默认同样需重写 exe 文件图标（目标用内嵌默认图标）
            if (!ScheduleExeIconApply(Services.AppIconService.ExtractDefaultIconFile(), out var msg))
            {
                ShowAppIconStatus(msg, false);
                return;
            }
            ShowAppIconStatus("已恢复默认软件图标，软件将自动重启生效…", true);
        }
        catch (Exception) { /* 恢复异常不崩面板 */ }
    }

    /// <summary>
    /// 把 <paramref name="iconPath"/>（.ico 文件）应用到 exe 文件图标：
    /// 复制主程序副本并以后台 <c>--appicon-apply</c> 启动，随后调度关闭当前程序（助手等本进程退出、目标 exe 解锁后改写再重启）。
    /// 返回是否成功启动后台流程。
    /// </summary>
    private bool ScheduleExeIconApply(string? iconPath, out string message)
    {
        message = "";
        try
        {
            if (string.IsNullOrEmpty(iconPath) || !File.Exists(iconPath))
            {
                message = "图标文件缺失，仅窗口/托盘图标已生效，exe 图标未更改。";
                return false;
            }
            var helper = Services.AppIconService.StageHelperCopy();
            if (helper == null)
            {
                message = "后台助手复制失败，仅窗口/托盘图标已生效，exe 图标未更改。";
                return false;
            }
            var target = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName ?? "";
            var pid = System.Diagnostics.Process.GetCurrentProcess().Id;
            var psi = new System.Diagnostics.ProcessStartInfo { FileName = helper, UseShellExecute = true };
            psi.ArgumentList.Add("--appicon-apply");
            psi.ArgumentList.Add(target);
            psi.ArgumentList.Add(iconPath);
            psi.ArgumentList.Add(pid.ToString());
            System.Diagnostics.Process.Start(psi);
            // 留时间让用户看到反馈并等待 config 落盘，然后自动退出；助手等本进程退出后改 exe 图标再重启
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(900) };
            timer.Tick += (_, _) => { timer.Stop(); Application.Current.Shutdown(); };
            timer.Start();
            return true;
        }
        catch (Exception)
        {
            message = "启动后台助手失败，仅窗口/托盘图标已生效，exe 图标未更改。";
            return false;
        }
    }

    /// <summary>把选择的图片纳入暂存预览（仅预览不落盘），启用「确认」「取消」。</summary>
    private void StageAppIcon(BitmapSource? image, string? imageFile)
    {
        _appIconPendingImage = image;
        _appIconPendingFile = imageFile;
        _appIconPendingPreview = image != null
            ? (FreezeClone(image))
            : (!string.IsNullOrEmpty(imageFile) ? Services.AppIconService.LoadImageSource(imageFile) : null);
        RefreshAppIconPreview();
        bool has = _appIconPendingPreview != null;
        if (appIconConfirm != null) appIconConfirm.IsEnabled = has;
        if (appIconCancel != null) appIconCancel.IsEnabled = has;
        ShowAppIconStatus(has ? "已选取图片到预览区，点击「确认应用」生效、或「取消」放弃（重启后再启用）。"
                              : "未能读取该图片，请换一张再试。", has);
    }

    /// <summary>清空软件图标暂存并复位确认/取消按钮与预览（silent=true 不写状态文案，改由调用方决定提示）。</summary>
    private void ClearAppIconPending(bool silent = false)
    {
        _appIconPendingImage = null;
        _appIconPendingFile = null;
        _appIconPendingPreview = null;
        RefreshAppIconPreview();
        if (appIconConfirm != null) appIconConfirm.IsEnabled = false;
        if (appIconCancel != null) appIconCancel.IsEnabled = false;
        if (!silent) ShowAppIconStatus("", true);
    }

    private static ImageSource FreezeClone(BitmapSource src)
    {
        var c = src.Clone();
        c.Freeze();
        return c;
    }

    /// <summary>软件图标状态反馈行（成功绿 / 失败红），设置后面板内即时可见。</summary>
    private void ShowAppIconStatus(string text, bool ok)
    {
        if (appIconStatus == null) return;
        appIconStatus.Text = text;
        appIconStatus.Foreground = new SolidColorBrush(
            Color.FromRgb(ok ? (byte)0x4C : (byte)0xE5, ok ? (byte)0xC3 : (byte)0x48, ok ? (byte)0x8A : (byte)0x4D));
    }

    // ==================== 快捷键 ====================

    /// <summary>点击「修改」：弹出按键捕获对话框，确定后应用新键位（改动即落盘并通知主窗口重新应用）。</summary>
    private void OnShortcutEditClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if ((sender as FrameworkElement)?.DataContext is not ShortcutItemViewModel it) return;
            var result = ShortcutCaptureDialog.Show($"修改快捷键 - {it.DisplayName}", it.Gesture);
            if (result == null) return; // 取消/关闭
            it.Gesture = result;
        }
        catch (Exception) { /* 捕获对话框异常不崩面板 */ }
    }

    /// <summary>点击「恢复默认」：把该项键位恢复为默认。</summary>
    private void OnShortcutResetClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if ((sender as FrameworkElement)?.DataContext is not ShortcutItemViewModel it) return;
            it.Gesture = it.DefaultGesture;
        }
        catch (Exception) { /* 恢复异常不崩面板 */ }
    }
}