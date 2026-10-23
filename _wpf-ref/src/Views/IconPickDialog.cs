using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.Views;

/// <summary>「修改图标」选择弹窗的返回：选中某预设、请求浏览文件、选中系统 DLL 图标、剪贴板图片（可附带目标分组）、或恢复默认图标。</summary>
public sealed record IconPickResult(
    string? PresetName, bool Browse,
    string? DllPath = null, int DllIconIndex = -1,
    BitmapSource? ClipboardImage = null, string? TargetGroup = null,
    bool RestoreDefault = false);

/// <summary>预设图标分组（供弹窗按分组展示）。</summary>
public sealed class IconPickGroup
{
    public string GroupName { get; }
    public IReadOnlyList<(string Name, ImageSource? Icon)> Icons { get; }

    public IconPickGroup(string groupName, IReadOnlyList<(string Name, ImageSource? Icon)> icons)
    {
        GroupName = groupName;
        Icons = icons;
    }
}

/// <summary>
/// 修改图标选择面板（非模态常驻，深色新拟物风格）：左侧页签切换「预设图标」「系统图标」「剪贴板」。
/// 预设页签列出设置里导入的预设图标（缩略图 + 名称）+ 浏览按钮；
/// 系统页签从 SHELL32.dll / imageres.dll 等 DLL 中提取系统图标，点击选中。
/// 每次选择经 onPick 回调实时应用到「回调时刻」主面板选中的卡片，面板保持打开；
/// 面板外点击=用户去主面板点选其他卡片切换应用目标，绝不能关面板。
/// </summary>
public sealed class IconPickDialog : Window
{
    private readonly Action<IconPickResult> _onPick;
    private readonly IReadOnlyList<IconPickGroup> _groups;

    /// <summary>标题栏文本（面板常驻期间经 UpdateTarget 随主面板选中卡片同步更新）。</summary>
    private readonly TextBlock _titleTb;
    private readonly IReadOnlyList<string> _groupNames;
    private readonly IconService _iconSvc = new();
    private readonly List<(string Display, string Path)> _dllPresets = new();
    private string _currentDllPath;
    private bool _systemTabLoaded;

    private readonly Button _tabPreset;
    private readonly Button _tabSystem;
    private readonly Button _tabClipboard;
    private readonly Panel _presetPanel;
    private readonly Panel _systemPanel;
    private readonly Panel _clipboardPanel;
    private readonly StackPanel _dllBtnHost = new StackPanel
    {
        Orientation = Orientation.Horizontal,
        Margin = new Thickness(0, 0, 0, 8),
    };
    private readonly StackPanel _systemGridHost = new StackPanel();
    private TextBlock _systemHint = null!;

    // ---- 剪贴板页签状态 ----
    private BitmapSource? _clipboardImage;
    private readonly Image _clipboardPreview = new Image
    {
        Stretch = Stretch.Uniform,
        MaxWidth = 240,
        MaxHeight = 190,
        Visibility = Visibility.Collapsed,
    };
    private TextBlock _clipboardHint = null!;
    private TextBlock _clipboardStatus = null!;
    private readonly StackPanel _groupRadioHost = new StackPanel();
    private readonly StackPanel _systemGroupRadioHost = new StackPanel();

    // ---- 底部操作反馈栏（非模态常驻面板的关键反馈通道：点选后不关面板，靠它确认生效） ----
    private Border _feedbackBar = null!;
    private TextBlock _feedbackTb = null!;

    public IconPickDialog(string title, IReadOnlyList<IconPickGroup> groups, Action<IconPickResult> onPick)
    {
        _onPick = onPick;
        _groups = groups;
        _groupNames = groups.Select(g => g.GroupName).ToList();

        var sysDir = Environment.GetFolderPath(Environment.SpecialFolder.System);
        _dllPresets.Add(("SHELL32.dll", Path.Combine(sysDir, "shell32.dll")));
        _dllPresets.Add(("imageres.dll", Path.Combine(sysDir, "imageres.dll")));
        _currentDllPath = _dllPresets[0].Path;

        Title = title;
        Width = 640;
        Height = 520;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;

        // ---- 标题栏（_titleTb 提升为字段，供 UpdateTarget 同步）----
        _titleTb = new TextBlock
        {
            Text = title,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 0, 0),
        };
        var closeBtn = new Button { Content = "\uE8BB", ToolTip = "关闭" };
        closeBtn.Style = (Style)Application.Current.FindResource("IconBtn");
        closeBtn.Width = 32; closeBtn.Height = 32; closeBtn.Margin = new Thickness(0);
        closeBtn.Click += (_, _) => Close();
        var titleBar = new Grid { Background = Brushes.Transparent, Height = 34 };
        titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _titleTb.SetValue(Grid.ColumnProperty, 0);
        closeBtn.SetValue(Grid.ColumnProperty, 1);
        titleBar.Children.Add(_titleTb);
        titleBar.Children.Add(closeBtn);
        titleBar.MouseLeftButtonDown += (_, _) => { try { DragMove(); } catch { } };

        var titleBarHost = new Border
        {
            Background = (Brush)Application.Current.FindResource("BarBrush"),
            CornerRadius = new CornerRadius(8, 8, 0, 0),
            Child = titleBar,
        };

        // ---- 左侧页签 ----
        _tabPreset = MakeTabButton("预设图标", 0);
        _tabSystem = MakeTabButton("系统图标", 1);
        _tabClipboard = MakeTabButton("剪贴板", 2);
        var leftStrip = new StackPanel
        {
            Background = (Brush)Application.Current.FindResource("NeuSurface"),
        };
        leftStrip.Children.Add(_tabPreset);
        leftStrip.Children.Add(_tabSystem);
        leftStrip.Children.Add(_tabClipboard);

        // ---- 右侧内容 ----
        _systemHint = new TextBlock
        {
            Text = "点击选择系统图标",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 12,
            Margin = new Thickness(0, 0, 0, 4),
        };
        _presetPanel = BuildPresetPanel();
        _systemPanel = BuildSystemPanel();
        _clipboardPanel = BuildClipboardPanel();
        BuildDllButtons();

        var rightHost = new Grid();
        rightHost.Children.Add(_presetPanel);
        rightHost.Children.Add(_systemPanel);
        rightHost.Children.Add(_clipboardPanel);

        // ---- 内容行：左侧页签 | 右侧内容 ----
        var contentRow = new Grid();
        contentRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(92) });
        contentRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Grid.SetColumn(leftStrip, 0);
        Grid.SetColumn(rightHost, 1);
        contentRow.Children.Add(leftStrip);
        contentRow.Children.Add(rightHost);

        // 左右分隔线
        var sep = new Border
        {
            Width = 1,
            Background = (Brush)Application.Current.FindResource("NeuBezel"),
            HorizontalAlignment = HorizontalAlignment.Left,
        };
        Grid.SetColumn(sep, 1);
        contentRow.Children.Add(sep);

        // ---- 底部反馈栏：默认隐藏，首次操作后常显（成功绿 / 失败红，带时间戳） ----
        _feedbackTb = new TextBlock
        {
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(14, 7, 14, 9),
        };
        _feedbackBar = new Border
        {
            Background = (Brush)Application.Current.FindResource("NeuInset"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezel"),
            BorderThickness = new Thickness(0, 1, 0, 0),
            Child = _feedbackTb,
            Visibility = Visibility.Collapsed,
        };

        // ---- 外框 ----
        var innerGrid = new Grid();
        innerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        innerGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        innerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetRow(titleBarHost, 0);
        Grid.SetRow(contentRow, 1);
        Grid.SetRow(_feedbackBar, 2);
        innerGrid.Children.Add(titleBarHost);
        innerGrid.Children.Add(contentRow);
        innerGrid.Children.Add(_feedbackBar);

        var frame = new Border
        {
            Background = (Brush)Application.Current.FindResource("NeuSurface"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezel"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Effect = (Effect)Application.Current.FindResource("NeuShadow"),
            Child = innerGrid,
        };

        Content = new Grid { Margin = new Thickness(12), Children = { frame } };

        // 默认页签：有预设选预设页，无预设直接选系统页
        ActivateTab(_groups.Any(g => g.Icons.Count > 0) ? 0 : 1);

        // ESC 快捷关闭；剪贴板页签下 Ctrl+V 粘贴
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) { Close(); e.Handled = true; }
            else if (e.Key == Key.V && Keyboard.Modifiers == ModifierKeys.Control
                     && _clipboardPanel.Visibility == Visibility.Visible)
            {
                PasteFromClipboard();
                e.Handled = true;
            }
        };
    }

    /// <summary>主面板选中的卡片变化时同步标题（只更新显示，绝不触发 onPick 回调）。</summary>
    public void UpdateTarget(string title)
    {
        _titleTb.Text = title;
        Title = title;
    }

    /// <summary>面板内操作反馈：带时间戳显示本次应用结果，成功绿 / 失败红；保留至下一次操作覆盖。</summary>
    public void ShowFeedback(string message, bool ok)
    {
        _feedbackTb.Text = $"[{DateTime.Now:HH:mm:ss}] {message}";
        _feedbackTb.Foreground = ok
            ? new SolidColorBrush(Color.FromRgb(0x4C, 0xC3, 0x8A))
            : new SolidColorBrush(Color.FromRgb(0xE5, 0x48, 0x4D));
        _feedbackBar.Visibility = Visibility.Visible;
    }

    /// <summary>把 ScrollViewer 套上 MCP 面板同款滚动框（NeuInset 内凹底 + 内阴影 + 圆角），统一各页签滚动框样式。</summary>
    private Border MakeScrollFrame(ScrollViewer sv)
    {
        return new Border
        {
            Background = (Brush)Application.Current.FindResource("NeuInset"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezelPress"),
            BorderThickness = new Thickness(1),
            Effect = (Effect)Application.Current.FindResource("NeuShadowInner"),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(8),
            Child = sv,
        };
    }

    // ---- 页签按钮 ----
    private Button MakeTabButton(string label, int tabIndex)
    {
        var btn = new Button
        {
            Content = label,
            Height = 38,
            Margin = new Thickness(6, 6, 4, 0),
            FontSize = 12,
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        btn.Style = (Style)Application.Current.FindResource("MiniGhost");
        btn.Click += (_, _) => ActivateTab(tabIndex);
        return btn;
    }

    private void ActivateTab(int tabIndex)
    {
        _tabPreset.Background = Brushes.Transparent;
        _tabSystem.Background = Brushes.Transparent;
        _tabClipboard.Background = Brushes.Transparent;
        _tabPreset.FontWeight = FontWeights.Normal;
        _tabSystem.FontWeight = FontWeights.Normal;
        _tabClipboard.FontWeight = FontWeights.Normal;

        var active = tabIndex switch { 0 => _tabPreset, 1 => _tabSystem, _ => _tabClipboard };
        active.Background = new SolidColorBrush(Color.FromRgb(0x23, 0x26, 0x31));
        active.FontWeight = FontWeights.SemiBold;

        _presetPanel.Visibility = tabIndex == 0 ? Visibility.Visible : Visibility.Collapsed;
        _systemPanel.Visibility = tabIndex == 1 ? Visibility.Visible : Visibility.Collapsed;
        _clipboardPanel.Visibility = tabIndex == 2 ? Visibility.Visible : Visibility.Collapsed;

        if (tabIndex == 1 && !_systemTabLoaded)
        {
            _systemTabLoaded = true;
            LoadSystemIcons();
        }
    }

    // ---- 预设图标页签 ----
    private Panel BuildPresetPanel()
    {
        var grid = new Grid { Margin = new Thickness(10, 8, 10, 10) };
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var hasAny = _groups.Any(g => g.Icons.Count > 0);
        if (!hasAny)
        {
            var hint = new TextBlock
            {
                Text = "暂无预设图标。请在设置中导入，或切换到「系统图标」页签。",
                Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
                FontSize = 12,
                Margin = new Thickness(0, 4, 0, 8),
                TextWrapping = TextWrapping.Wrap,
            };
            Grid.SetRow(hint, 0);
            grid.Children.Add(hint);
        }
        else
        {
            var hint = new TextBlock
            {
                Text = "选择预设图标，或浏览其它图标文件",
                Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
                FontSize = 12,
                Margin = new Thickness(0, 2, 0, 8),
            };
            Grid.SetRow(hint, 0);
            grid.Children.Add(hint);

            // 按设置中的分组分区展示：每组一个标题 + 图标网格
            var host = new StackPanel();
            foreach (var group in _groups)
            {
                if (group.Icons.Count == 0) continue;
                host.Children.Add(MakeGroupHeader(group.GroupName, group.Icons.Count));
                var iconGrid = new UniformGrid { Columns = 4 };
                foreach (var (name, icon) in group.Icons)
                    iconGrid.Children.Add(MakePresetItem(name, icon));
                host.Children.Add(iconGrid);
            }

            var scroll = MakeScrollFrame(new ScrollViewer
            {
                Content = host,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            });
            Grid.SetRow(scroll, 1);
            grid.Children.Add(scroll);
        }

        var appIconBtn = new Button
        {
            Content = "选择应用图标…",
            Height = 30,
            FontSize = 12,
            Padding = new Thickness(16, 4, 16, 4),
            Margin = new Thickness(0, 8, 0, 0),
        };
        appIconBtn.Style = (Style)Application.Current.FindResource("MiniGhost");
        appIconBtn.Click += (_, _) => OnPickAppIcon();

        var browse = new Button
        {
            Content = "浏览其它图标…",
            Height = 30,
            FontSize = 12,
            Padding = new Thickness(16, 4, 16, 4),
            Margin = new Thickness(6, 8, 0, 0),
        };
        browse.Style = (Style)Application.Current.FindResource("MiniGhost");
        browse.Click += (_, _) => _onPick(new IconPickResult(null, true));

        var appAndBrowse = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        appAndBrowse.Children.Add(appIconBtn);
        appAndBrowse.Children.Add(browse);

        var restoreBtn = new Button
        {
            Content = "恢复默认图标",
            Height = 30,
            FontSize = 12,
            Padding = new Thickness(16, 4, 16, 4),
            Margin = new Thickness(0, 8, 0, 0),
            HorizontalAlignment = HorizontalAlignment.Left,
            ToolTip = "清除该文件夹的自定义图标，还原系统默认图标",
        };
        restoreBtn.Style = (Style)Application.Current.FindResource("MiniGhost");
        restoreBtn.Click += (_, _) => _onPick(new IconPickResult(null, false, RestoreDefault: true));

        var bottomRow = new Grid { Margin = new Thickness(0) };
        bottomRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bottomRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(restoreBtn, 0);
        Grid.SetColumn(appAndBrowse, 1);
        bottomRow.Children.Add(restoreBtn);
        bottomRow.Children.Add(appAndBrowse);
        Grid.SetRow(bottomRow, 2);
        grid.Children.Add(bottomRow);

        return grid;
    }

    /// <summary>「选择应用图标」：浏览选择 EXE，切到「系统图标」页签展示其内嵌图标供选择。</summary>
    private void OnPickAppIcon()
    {
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择应用程序 (EXE)",
            Filter = "应用程序 (*.exe)|*.exe|可执行文件/库 (*.exe;*.dll)|*.exe;*.dll|所有文件 (*.*)|*.*",
        };
        if (dlg.ShowDialog(this) != true) return;

        _currentDllPath = dlg.FileName;
        var name = Path.GetFileName(dlg.FileName);
        if (!_dllPresets.Exists(x => x.Path == dlg.FileName))
            _dllPresets.Add((name, dlg.FileName));
        BuildDllButtons();
        _systemTabLoaded = true;   // 已显式加载，避免 ActivateTab 内重复触发
        ActivateTab(1);
        LoadSystemIcons();
    }

    /// <summary>分组标题：分组名（SectionTitle）+ 数量（低调灰，数字亮灰）。</summary>
    private FrameworkElement MakeGroupHeader(string name, int count)
    {
        var nameTb = new TextBlock
        {
            Text = name,
            Style = (Style)Application.Current.FindResource("SectionTitle"),
        };
        var countTb = new TextBlock
        {
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(6, 0, 0, 0),
        };
        countTb.Inlines.Add(new Run("（") { Foreground = (Brush)Application.Current.FindResource("MutedBrush") });
        countTb.Inlines.Add(new Run(count.ToString()) { Foreground = new SolidColorBrush(Color.FromRgb(0xB4, 0xB9, 0xC2)) });
        countTb.Inlines.Add(new Run("）") { Foreground = (Brush)Application.Current.FindResource("MutedBrush") });
        var row = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(0, 10, 0, 4),
        };
        row.Children.Add(nameTb);
        row.Children.Add(countTb);
        return row;
    }

    private Button MakePresetItem(string name, ImageSource? icon)
    {
        var thumbImg = new Image
        {
            Width = 20,
            Height = 20,
            Stretch = Stretch.Uniform,
        };
        RenderOptions.SetBitmapScalingMode(thumbImg, BitmapScalingMode.HighQuality);
        var thumb = new Border
        {
            Width = 28,
            Height = 28,
            Background = (Brush)Application.Current.FindResource("NeuSurfaceHi"),
            CornerRadius = new CornerRadius(4),
            VerticalAlignment = VerticalAlignment.Center,
            Child = thumbImg,
        };
        if (icon != null) thumbImg.Source = icon;
        var nameTb = new TextBlock
        {
            Text = name,
            FontSize = 11,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(6, 0, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        var row = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(0, 3, 4, 3),
        };
        row.Children.Add(thumb);
        row.Children.Add(nameTb);

        var btn = new Button
        {
            Content = row,
            Height = 38,
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Padding = new Thickness(6, 2, 6, 2),
            Margin = new Thickness(1),
            FontFamily = new FontFamily("Consolas"),
            ToolTip = name,
        };
        btn.Style = (Style)Application.Current.FindResource("MiniGhost");
        var nm = name;
        btn.Click += (_, _) => _onPick(new IconPickResult(nm, false));
        return btn;
    }

    // ---- 系统图标页签 ----
    private Panel BuildSystemPanel()
    {
        var grid = new Grid { Margin = new Thickness(10, 8, 10, 10) };
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // DLL 按钮
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 提示
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); // 图标区+右侧分组

        Grid.SetRow(_dllBtnHost, 0);
        grid.Children.Add(_dllBtnHost);

        Grid.SetRow(_systemHint, 1);
        grid.Children.Add(_systemHint);

        // 内容行：左=图标网格滚动区，右=加入分组单选（参考剪贴板页签样式，保留滚动框）
        var content = new Grid();
        content.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        content.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(180) });

        var scroll = MakeScrollFrame(new ScrollViewer
        {
            Content = _systemGridHost,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        });
        Grid.SetColumn(scroll, 0);
        content.Children.Add(scroll);

        FillGroupRadios(_systemGroupRadioHost, "systemTargetGroup", "加入图标分组", "不加入");
        var groupScroll = MakeScrollFrame(new ScrollViewer
        {
            Content = _systemGroupRadioHost,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        });
        groupScroll.Margin = new Thickness(10, 0, 0, 0);
        Grid.SetColumn(groupScroll, 1);
        content.Children.Add(groupScroll);

        Grid.SetRow(content, 2);
        grid.Children.Add(content);

        return grid;
    }

    private void BuildDllButtons()
    {
        _dllBtnHost.Children.Clear();
        foreach (var (display, path) in _dllPresets)
        {
            var btn = new Button
            {
                Content = display,
                Height = 28,
                FontSize = 11,
                Padding = new Thickness(10, 2, 10, 2),
                Margin = new Thickness(0, 0, 6, 0),
            };
            btn.Style = (Style)Application.Current.FindResource("MiniGhost");
            if (path == _currentDllPath)
            {
                btn.Background = new SolidColorBrush(Color.FromRgb(0x23, 0x26, 0x31));
                btn.FontWeight = FontWeights.SemiBold;
            }
            var p = path;
            btn.Click += (_, _) => { _currentDllPath = p; BuildDllButtons(); LoadSystemIcons(); };
            _dllBtnHost.Children.Add(btn);
        }

        var browseDll = new Button
        {
            Content = "浏览DLL…",
            Height = 28,
            FontSize = 11,
            Padding = new Thickness(10, 2, 10, 2),
        };
        browseDll.Style = (Style)Application.Current.FindResource("MiniGhost");
        browseDll.Click += (_, _) =>
        {
            var dlg = new Microsoft.Win32.OpenFileDialog
            {
                Title = "选择 DLL 或 EXE",
                Filter = "DLL/EXE 文件|*.dll;*.exe|所有文件|*.*",
            };
            if (dlg.ShowDialog(this) != true) return;
            _currentDllPath = dlg.FileName;
            var name = Path.GetFileName(dlg.FileName);
            if (!_dllPresets.Exists(x => x.Path == dlg.FileName))
                _dllPresets.Add((name, dlg.FileName));
            BuildDllButtons();
            LoadSystemIcons();
        };
        _dllBtnHost.Children.Add(browseDll);
    }

    private void LoadSystemIcons()
    {
        _systemGridHost.Children.Clear();

        var count = _iconSvc.GetDllIconCount(_currentDllPath);
        if (count <= 0)
        {
            _systemHint.Text = "此文件中未找到图标。";
            _systemGridHost.Children.Add(new TextBlock
            {
                Text = $"未能从 {Path.GetFileName(_currentDllPath)} 提取图标。",
                Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
                FontSize = 12,
                Margin = new Thickness(0, 8, 0, 0),
            });
            return;
        }

        _systemHint.Text = $"点击选择系统图标（共 {count} 个）";

        var grid = new WrapPanel();
        const int batchSize = 64;
        for (var start = 0; start < count; start += batchSize)
        {
            var batch = Math.Min(batchSize, count - start);
            var icons = _iconSvc.ExtractDllIcons(_currentDllPath, start, batch);
            foreach (var (index, icon) in icons)
                grid.Children.Add(MakeSystemIconItem(index, icon));
        }
        _systemGridHost.Children.Add(grid);
    }

    private Button MakeSystemIconItem(int index, ImageSource? icon)
    {
        var img = new Image
        {
            Width = 28,
            Height = 28,
            Stretch = Stretch.Uniform,
        };
        RenderOptions.SetBitmapScalingMode(img, BitmapScalingMode.HighQuality);
        if (icon != null) img.Source = icon;

        var btn = new Button
        {
            Content = img,
            Width = 38,
            Height = 38,
            Padding = new Thickness(2),
            Margin = new Thickness(3),
            ToolTip = $"图标 #{index}",
        };
        btn.Style = (Style)Application.Current.FindResource("MiniGhost");

        var dllPath = _currentDllPath;
        var idx = index;
        btn.Click += (_, _) =>
        {
            var group = GetSelectedGroup(_systemGroupRadioHost);
            _onPick(new IconPickResult(null, false, dllPath, idx, TargetGroup: group));
        };
        return btn;
    }

    // ---- 剪贴板页签 ----
    private Panel BuildClipboardPanel()
    {
        var grid = new Grid { Margin = new Thickness(10, 8, 10, 10) };
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var hint = new TextBlock
        {
            Text = "从剪贴板粘贴图片，确认后应用到文件夹图标",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 12,
            Margin = new Thickness(0, 2, 0, 8),
        };
        Grid.SetRow(hint, 0);
        grid.Children.Add(hint);

        // 内容行：左=预览区，右=分组单选列表
        var content = new Grid();
        content.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        content.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(180) });

        _clipboardHint = new TextBlock
        {
            Text = "点击此处或按 Ctrl+V 粘贴图片",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 12,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        RenderOptions.SetBitmapScalingMode(_clipboardPreview, BitmapScalingMode.HighQuality);
        var previewHost = new Grid();
        previewHost.Children.Add(_clipboardHint);
        previewHost.Children.Add(_clipboardPreview);
        var previewBorder = new Border
        {
            Background = (Brush)Application.Current.FindResource("NeuInset"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezelPress"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Margin = new Thickness(0, 0, 10, 0),
            Child = previewHost,
            Cursor = Cursors.Hand,
        };
        previewBorder.MouseLeftButtonDown += (_, _) => PasteFromClipboard();
        Grid.SetColumn(previewBorder, 0);
        content.Children.Add(previewBorder);

        var right = BuildGroupRadioPanel();
        Grid.SetColumn(right, 1);
        content.Children.Add(right);

        Grid.SetRow(content, 1);
        grid.Children.Add(content);

        // 底部：状态提示 + 粘贴/确认按钮
        _clipboardStatus = new TextBlock
        {
            Foreground = new SolidColorBrush(Color.FromRgb(0xE5, 0x48, 0x4D)),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var pasteBtn = new Button
        {
            Content = "粘贴",
            Height = 30,
            FontSize = 12,
            Padding = new Thickness(14, 4, 14, 4),
            Margin = new Thickness(0, 0, 6, 0),
        };
        pasteBtn.Style = (Style)Application.Current.FindResource("MiniGhost");
        pasteBtn.Click += (_, _) => PasteFromClipboard();
        var confirmBtn = new Button
        {
            Content = "确认应用",
            Height = 30,
            FontSize = 12,
            Padding = new Thickness(14, 4, 14, 4),
        };
        confirmBtn.Style = (Style)Application.Current.FindResource("MiniAccent");
        confirmBtn.Click += (_, _) => ConfirmClipboard();
        var btnStack = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        btnStack.Children.Add(pasteBtn);
        btnStack.Children.Add(confirmBtn);
        var bottom = new Grid { Margin = new Thickness(0, 8, 0, 0) };
        bottom.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bottom.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(_clipboardStatus, 0);
        Grid.SetColumn(btnStack, 1);
        bottom.Children.Add(_clipboardStatus);
        bottom.Children.Add(btnStack);
        Grid.SetRow(bottom, 2);
        grid.Children.Add(bottom);

        return grid;
    }

    private FrameworkElement BuildGroupRadioPanel()
    {
        FillGroupRadios(_groupRadioHost, "clipboardTargetGroup", "添加到预设分组", "不添加到预设库");
        return MakeScrollFrame(new ScrollViewer
        {
            Content = _groupRadioHost,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        });
    }

    /// <summary>填充「加入分组」单选列表：标签 + 不加入 + 每个分组一项。</summary>
    private void FillGroupRadios(StackPanel host, string groupName, string labelText, string noAddText)
    {
        host.Children.Clear();
        var label = new TextBlock
        {
            Text = labelText,
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 11,
            Margin = new Thickness(0, 0, 0, 4),
        };
        host.Children.Add(label);
        host.Children.Add(MakeGroupRadio(noAddText, true, null, groupName));
        foreach (var g in _groupNames)
            host.Children.Add(MakeGroupRadio(g, false, g, groupName));
    }

    /// <summary>读取单选列表选中的分组名（未选「不加入」时返回 null）。</summary>
    private string? GetSelectedGroup(StackPanel host)
    {
        foreach (var child in host.Children)
            if (child is RadioButton rb && rb.IsChecked == true && rb.Tag is string g && g.Length > 0)
                return g;
        return null;
    }

    private RadioButton MakeGroupRadio(string text, bool isChecked, string? tag, string groupName)
    {
        var dot = new System.Windows.Shapes.Ellipse
        {
            Width = 8,
            Height = 8,
            Fill = (Brush)Application.Current.FindResource("AccentBrush"),
            Opacity = 0,
        };
        var circle = new Border
        {
            Width = 16,
            Height = 16,
            CornerRadius = new CornerRadius(8),
            Background = (Brush)Application.Current.FindResource("NeuSurface"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezel"),
            BorderThickness = new Thickness(1),
            Effect = (Effect)Application.Current.FindResource("NeuShadowSmall"),
            VerticalAlignment = VerticalAlignment.Center,
            Child = dot,
        };
        var content = new TextBlock
        {
            Text = text,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        var row = new Grid { Background = Brushes.Transparent, Margin = new Thickness(0, 3, 0, 3) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Grid.SetColumn(circle, 0);
        Grid.SetColumn(content, 1);
        row.Children.Add(circle);
        row.Children.Add(content);

        var rb = new RadioButton
        {
            Content = row,
            IsChecked = isChecked,
            Tag = tag,
            Cursor = Cursors.Hand,
            Margin = new Thickness(0, 1, 0, 1),
            GroupName = groupName,
        };
        // 覆盖默认模板：只渲染 Content（自绘圆点），避免默认单选圆与自绘圆重复
        var template = new ControlTemplate(typeof(RadioButton));
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
        presenter.SetValue(ContentPresenter.ContentProperty, new TemplateBindingExtension(ContentControl.ContentProperty));
        presenter.SetValue(ContentPresenter.ContentTemplateProperty, new TemplateBindingExtension(ContentControl.ContentTemplateProperty));
        template.VisualTree = presenter;
        rb.Template = template;

        void Apply(bool on)
        {
            circle.Background = on
                ? (Brush)Application.Current.FindResource("NeuInset")
                : (Brush)Application.Current.FindResource("NeuSurface");
            circle.BorderBrush = on
                ? (Brush)Application.Current.FindResource("NeuBezelPress")
                : (Brush)Application.Current.FindResource("NeuBezel");
            circle.Effect = on ? null : (Effect)Application.Current.FindResource("NeuShadowSmall");
            dot.Opacity = on ? 1 : 0;
        }
        rb.Checked += (_, _) => Apply(true);
        rb.Unchecked += (_, _) => Apply(false);
        if (isChecked) Apply(true);
        return rb;
    }

    private void PasteFromClipboard()
    {
        try
        {
            BitmapSource? img = null;
            if (Clipboard.ContainsImage())
                img = Clipboard.GetImage();
            else if (Clipboard.ContainsFileDropList())
            {
                var f = Clipboard.GetFileDropList().Cast<string>()
                    .FirstOrDefault(x => PresetIconService.IsSupportedFile(x) && File.Exists(x));
                if (f != null)
                {
                    try
                    {
                        // 字节流解码，避免文件名含 #/%/? 时 new Uri 解析错位（同 IconConversion.DecodeImage）
                        using var fs = File.OpenRead(f);
                        var bi = new BitmapImage();
                        bi.BeginInit();
                        bi.StreamSource = fs;
                        bi.CacheOption = BitmapCacheOption.OnLoad;
                        bi.EndInit();
                        img = bi;
                    }
                    catch { }
                }
            }
            if (img == null)
            {
                _clipboardStatus.Text = "剪贴板中没有可用的图片。";
                return;
            }
            var frozen = img.Clone();
            frozen.Freeze();
            _clipboardImage = frozen;
            _clipboardPreview.Source = frozen;
            _clipboardPreview.Visibility = Visibility.Visible;
            _clipboardHint.Visibility = Visibility.Collapsed;
            _clipboardStatus.Text = "";
        }
        catch (Exception ex)
        {
            _clipboardStatus.Text = $"读取剪贴板失败：{ex.Message}";
        }
    }

    private void ConfirmClipboard()
    {
        if (_clipboardImage == null)
        {
            _clipboardStatus.Text = "请先粘贴图片。";
            return;
        }
        var target = GetSelectedGroup(_groupRadioHost);
        _onPick(new IconPickResult(null, false, ClipboardImage: _clipboardImage, TargetGroup: target));
        // 不清空 _clipboardImage：非模态下可对连续选中的多张卡重复应用同一张图
        _clipboardStatus.Text = "已应用到当前选中的卡片。";
    }

}
