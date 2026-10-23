using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.Windows.Input;
using KityMinderPlugin;
using Microsoft.Win32;
using FenPeiXiangMuZu.Services;
using FenPeiXiangMuZu.ViewModels;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 「思维导图」面板。文件层（装卸/导入导出/刷新/调试/关闭）由本面板负责，
/// 脑图的渲染与编辑交给可复用的 <see cref="KityMinderHost"/>（Library KityMinderPlugin），
/// 收敛了脑图承载的重复实现。协调者（MainWindow）注入 <see cref="Host"/>，
/// 并在浮层显示时调用 <see cref="Show"/>。
/// </summary>
public partial class MindMapPanel : UserControl
{
    private bool _busy;
    private readonly List<StyleOption> _layouts = new();
    private readonly List<StyleOption> _themes = new();
    private readonly List<FontOption> _fonts = new();
    // 字号档位（节点实际字号不在档位时动态补一项，选中后仍可正常改）
    private readonly List<int> _sizes = new() { 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48 };
    private int? _dynamicSize;        // 上次动态补进 _sizes 的非档位字号（下次回显前先移除，避免无限增长）
    private FontOption? _dynamicFont; // 同上：上次动态补进 _fonts 的非预设字体

    // 右侧边栏页签：key -> (顶栏切换按钮, 边栏页签面板)。仅由顶栏按钮驱动切换，新增页签入口在此注册。
    private readonly Dictionary<string, (ToggleButton Btn, UIElement Panel)> _sidePages = new(StringComparer.Ordinal);

    // ---- 自动保存状态 ----
    private readonly DispatcherTimer _saveTimer;
    private bool _suppressSave;            // 恢复期间抑制保存（吸收 import 触发的 contentchange）
    private bool _dirtyDuringSuppress;     // 抑制期间发生过内容变更（恢复后需补存）
    private bool _saving;                  // 保存重入保护
    private string? _lastSavedContent;     // 上次落盘的当前画布内容
    private string? _lastSavedSnapshot;    // 上次落盘的「全部画布」指纹（多画布去重）
    private string _currentTheme = "fresh-blue";
    private string _currentLayout = "default";

    // ---- 多画布（参考 XMind 底部画布标签）----
    private readonly List<MindMapSheetData> _sheets = new();
    private string? _activeSheetId;
    private bool _sheetsLoaded;            // 已从存档载入（避免 Reload 时重复载入/重复建画布）
    private bool _switchingSheet;          // 切换画布进行中（防重入 + 抑制自动保存）

    // ---- 画布标签条拖拽重排（参考项目组集群的让位交换：AnimatedStackPanel 横向 + 死区 + 贴边自动滚动）----
    /// <summary>标签条数据源（持久实例集合）：拖拽用 Move 保留容器实例让位动画生效；RefreshSheetTabs 重建仅用于非拖拽操作。</summary>
    private readonly ObservableCollection<SheetTabItem> _sheetTabItems = new();

    private sealed class SheetDragState
    {
        public SheetTabItem? Item;
        public Point Start;          // 按下点（面板坐标）
        public bool IsDragging;
    }
    private SheetDragState? _sheetDrag;
    private UIElement? _sheetFollowEl;          // 拖拽中跟随鼠标的标签容器
    private double _sheetFollowStartMouseX;     // 跟随起点鼠标 X（面板坐标）
    private double _sheetFollowStartLayoutLeft; // 跟随起点布局左（面板系，换位后配合屏幕目标重算偏移）
    private double _sheetFollowStartWinLeft;    // 跟随起点标签的面板左：目标位移在面板系计算，天然兼容自动滚动
    private double _sheetFollowTabW;            // 标签宽：标签右缘不得越出滚动视口右缘
    private double _sheetLastPosX;              // 最近一次鼠标 X：自动滚动跳帧时据此保持贴手
    private DispatcherTimer? _sheetAutoScrollTimer;
    private bool _sheetDragWired;
    private AnimatedStackPanel? _sheetPanel;
    private System.Windows.Shapes.Rectangle? _sheetInsertBar;
    private const double SheetSwapHysteresis = 16.0;
    private static double SheetDragThreshold => SystemParameters.MinimumHorizontalDragDistance;

    private bool _syncingStyle;          // 程序回显选中节点样式到面板时置位，抑制 fontBox/sizeBox 的 SelectionChanged 回发
    private bool _selectedIsRoot;        // 当前选中节点是否为中心主题（根）：根没有与父节点之间的连线，连线样式控件须禁用

    // ---- 「文件」页签：附件信息 + 视频播放 ----
    private string? _currentFilePath;            // 文件面板当前展示的附件路径（null=未附加/已清空）
    private readonly DispatcherTimer _videoTimer;// 播放中周期刷新进度条/时间文本
    private bool _videoIsPlaying;                // 播放状态（供 播放/暂停 按钮切换与离开页签时暂停）
    private bool _videoSeeking;                  // 用户正在拖动进度条：定时器暂不回写
    private bool _videoProgrammaticSeek;         // 程序回写进度条：抑制 ValueChanged 触发的用户跳转
    private bool _videoAutoplayPending;          // 媒体尚未 MediaOpened 时的待自动播放标记
    private string? _videoPath;                  // 播放器当前装入的视频路径（null=未装入）
    private VideoMeta? _videoMeta;               // Shell 读到的视频元信息（MediaOpened 后可能被补齐/覆盖）
    private readonly Dictionary<string, TextBlock> _videoInfoValues = new(); // 视频信息行：键 → 值 TextBlock（便于后补时长/分辨率）

    // ---- 每分钟滚动备份 ----
    private readonly DispatcherTimer _backupTimer;
    private bool _backupBusy;

    public MindMapPanel()
    {
        InitializeComponent();
        _videoTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        _videoTimer.Tick += OnVideoTimerTick;
        BuildSideTabPages();
        BuildTagPage();
        Loaded += OnLoaded;
        BuildSidebar();
        _saveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(600) };
        _saveTimer.Tick += OnSaveTimerTick;
        VideoSeek.ValueChanged += OnVideoSeekValueChanged;
        VideoVolume.ValueChanged += (_, _) => VideoPlayer.Volume = VideoVolume.Value;
        _backupTimer = new DispatcherTimer();
        _backupTimer.Tick += OnBackupTimerTick;
        Editor.ReadyChanged += OnEditorReady;
        Editor.ContentChanged += OnContentChanged;
        Editor.NodeStyleChanged += OnNodeStyleChanged;
        Editor.OpenFileRequested += OnOpenFileRequested;
        // 关闭浮层（面板不可见）时立即落盘防抖窗口内的编辑，并停掉每分钟备份定时器
        IsVisibleChanged += (_, e) =>
        {
            if (IsVisible) StartBackupTimer();
            else
            {
                if (_saveTimer.IsEnabled)
                {
                    _saveTimer.Stop();
                    _ = SaveStateNowAsync();
                }
                if (_backupTimer.IsEnabled) _backupTimer.Stop();
            }
        };
    }

    /// <summary>注册右侧边栏页签（仅由顶栏按钮切换）。新增页签入口时：XAML 加按钮+面板并在此注册。</summary>
    private void BuildSideTabPages()
    {
        _sidePages.Clear();
        RegisterSidePage("theme", SideBtnTheme, SidePageTheme);
        RegisterSidePage("tag", SideBtnTag, SidePageTag);
        RegisterSidePage("style", SideBtnStyle, SidePageStyle);
        RegisterSidePage("file", SideBtnFile, SidePageFile);
        ShowSidePage("theme");
    }

    private void RegisterSidePage(string key, ToggleButton btn, UIElement panel)
        => _sidePages[key] = (btn, panel);

    /// <summary>顶栏页签按钮点击：切换右侧边栏对应页签。</summary>
    private void OnSideTabClick(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: string key } && _sidePages.ContainsKey(key))
            ShowSidePage(key);
    }

    /// <summary>切换右侧边栏页签：目标面板显示、其余折叠，并同步顶栏按钮选中态。
    /// 离开「文件」页签时暂停视频；切入「文件」页签时按选中节点同步附件展示。</summary>
    private void ShowSidePage(string key)
    {
        if (!_sidePages.TryGetValue(key, out _)) return;
        foreach (var (k, p) in _sidePages)
        {
            bool active = k == key;
            p.Btn.IsChecked = active;
            p.Panel.Visibility = active ? Visibility.Visible : Visibility.Collapsed;
        }
        if (key != "file") PauseVideo();
        else _ = LoadSelectedNodeFileAsync();
        SetStatus($"已切换到「{(key switch { "theme" => "主题", "tag" => "标签", "style" => "样式", "file" => "文件", _ => key })}」页签");
    }

    /// <summary>用 webview 优先级/进度精灵图标生成右侧「标签」页签的按钮组。
    /// 精灵图 20×200，每格 20×20：优先级 cell0-8=P1-P9、cell9=清除；进度 cell0-8=1-9、cell9=清除。</summary>
    private void BuildTagPage()
    {
        var prio = LoadEmbeddedBitmap("Assets.Icons.iconpriority.png");
        var prog = LoadEmbeddedBitmap("Assets.Icons.iconprogress.png");
        if (prio == null || prog == null) { SetStatus("优先级/进度图标缺失", warn: true); return; }
        PriorityHost.Children.Clear();
        ProgressHost.Children.Clear();
        PriorityHost.Children.Add(BuildSpriteNumRow(prio, OnPriorityClick, new[] { 1, 2, 3, 4, 5 }, "优先级 {0}", "移除优先级", false));
        PriorityHost.Children.Add(BuildSpriteNumRow(prio, OnPriorityClick, new[] { 6, 7, 8, 9, 0 }, "优先级 {0}（最低）", "移除优先级", true));
        ProgressHost.Children.Add(BuildSpriteNumRow(prog, OnProgressClick, new[] { 1, 2, 3, 4, 5 }, "进度 {0}/9", "移除进度", false));
        ProgressHost.Children.Add(BuildSpriteNumRow(prog, OnProgressClick, new[] { 6, 7, 8, 9, 0 }, "进度 {0}/9", "移除进度", true));
    }

    /// <summary>生成一排带 webview 图标的数字按钮（values 中 0 表示"清除"格，取 cell9）。</summary>
    private StackPanel BuildSpriteNumRow(BitmapImage sprite, RoutedEventHandler handler, int[] values, string tipFormat, string clearTip, bool isSecondRow)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, isSecondRow ? 6 : 0, 0, 0) };
        var style = (Style)FindResource("ToolBarNumBtn");
        foreach (var v in values)
        {
            int cell = v == 0 ? 9 : v - 1;
            var btn = new Button
            {
                Style = style,
                Tag = v.ToString(),
                ToolTip = v == 0 ? clearTip : string.Format(tipFormat, v),
            };
            btn.Click += handler;
            btn.Content = new Image { Source = CropIcon(sprite, cell), Width = 20, Height = 20, Stretch = Stretch.None };
            row.Children.Add(btn);
        }
        return row;
    }

    /// <summary>裁剪精灵图的单格 20×20 图标并冻结（cell 为从上到下序号）。</summary>
    private static ImageSource CropIcon(BitmapImage sprite, int cell)
    {
        var cropped = new CroppedBitmap(sprite, new Int32Rect(0, cell * 20, 20, 20));
        cropped.Freeze();
        return cropped;
    }

    /// <summary>从内嵌资源加载位图（按资源名后缀匹配，避免硬编码完整命名空间）。</summary>
    private static BitmapImage? LoadEmbeddedBitmap(string nameSuffix)
    {
        try
        {
            var assembly = System.Reflection.Assembly.GetExecutingAssembly();
            var fullName = assembly.GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith(nameSuffix, StringComparison.Ordinal));
            if (fullName == null) return null;
            using var stream = assembly.GetManifestResourceStream(fullName);
            if (stream == null) return null;
            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.StreamSource = stream;
            bmp.CacheOption = BitmapCacheOption.OnLoad;
            bmp.EndInit();
            bmp.Freeze();
            return bmp;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>构建右侧边栏（布局/主题选项；内置 + 自定义合并），默认选中默认布局与清新蓝主题。</summary>
    private void BuildSidebar()
    {
        var brushConv = new BrushConverter();
        _layouts.Clear();
        _themes.Clear();
        foreach (var m in KityMinderContract.LayoutMeta)
            _layouts.Add(new StyleOption(m.Value, m.Label) { Thumb = LoadLayoutThumb(m.Value) });
        // 内置主题 + 自定义主题合并
        foreach (var m in KityMinderContract.ThemeMeta)
            _themes.Add(new StyleOption(m.Value, m.Label,
                (Brush)brushConv.ConvertFromString(m.BackgroundHex)!,
                (Brush)brushConv.ConvertFromString(m.RootHex)!,
                (Brush)brushConv.ConvertFromString(m.MainHex)!,
                (Brush)brushConv.ConvertFromString(m.SubHex)!));
        foreach (var t in MindMapThemeStore.Load())
        {
            var bgHex = t.Palette.Background;
            var rootHex = t.Palette.RootBackground;
            var mainHex = t.Palette.MainBackground;
            var subHex = t.Palette.SubBackground;
            var so = new StyleOption(t.Id, t.Name,
                string.IsNullOrWhiteSpace(bgHex) ? null : (Brush)brushConv.ConvertFromString(bgHex)!,
                string.IsNullOrWhiteSpace(rootHex) ? null : (Brush)brushConv.ConvertFromString(rootHex)!,
                string.IsNullOrWhiteSpace(mainHex) ? null : (Brush)brushConv.ConvertFromString(mainHex)!,
                string.IsNullOrWhiteSpace(subHex) ? null : (Brush)brushConv.ConvertFromString(subHex)!,
                isCustom: true);
            so.CustomTheme = t;
            _themes.Add(so);
        }
        layoutList.ItemsSource = _layouts;
        themeList.ItemsSource = _themes;
        SelectOnly(_layouts, "default");
        SelectOnly(_themes, "fresh-blue");
        // 外观：字体选择（目录与原编辑器【外观】页签一致）
        _fonts.AddRange(new[]
        {
            new FontOption("宋体", "宋体,SimSun"),
            new FontOption("微软雅黑", "微软雅黑,Microsoft YaHei"),
            new FontOption("楷体", "楷体,楷体_GB2312,SimKai"),
            new FontOption("黑体", "黑体, SimHei"),
            new FontOption("隶书", "隶书, SimLi"),
            new FontOption("Andale Mono", "andale mono"),
            new FontOption("Arial", "arial,helvetica,sans-serif"),
            new FontOption("Arial Black", "arial black,avant garde"),
            new FontOption("Comic Sans Ms", "comic sans ms"),
            new FontOption("Impact", "impact,chicago"),
            new FontOption("Times New Roman", "times new roman"),
            new FontOption("Sans-Serif", "sans-serif"),
        });
        fontBox.ItemsSource = _fonts;
        fontBox.DisplayMemberPath = nameof(FontOption.Name);
        fontBox.SelectedValuePath = nameof(FontOption.Val);
        sizeBox.ItemsSource = _sizes;
    }

    /// <summary>在切换自定义主题前，先注册到 JS 侧，再切换。persist=false 用于打开恢复（不触发落盘）。</summary>
    private async Task SwitchCustomThemeAsync(StyleOption o, bool persist = true)
    {
        if (o.CustomTheme is { } t)
        {
            var json = System.Text.Json.JsonSerializer.Serialize(t, new System.Text.Json.JsonSerializerOptions
            {
                PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
            });
            var ok = await Editor.RegisterCustomThemeAsync(json);
            if (!ok) { SetStatus("主题注册失败：" + o.Label, warn: true); return; }
        }
        SelectOnly(_themes, o.Value);
        _currentTheme = o.Value;
        _ = Editor.SetThemeAsync(o.Value);
        SetStatus("主题：" + o.Label);
        if (persist) _ = SaveStateNowAsync();
    }

    /// <summary>把指定值设为选中，其余取消选中。</summary>
    private static void SelectOnly(List<StyleOption> list, string value)
    {
        foreach (var it in list) it.IsSelected = it.Value == value;
    }

    /// <summary>主视图模型（触发思维导图组件启用/停用）。</summary>
    public static readonly DependencyProperty HostProperty = DependencyProperty.Register(
        nameof(Host), typeof(MainViewModel), typeof(MindMapPanel),
        new PropertyMetadata(null, OnHostChanged));
    public MainViewModel? Host
    {
        get => (MainViewModel?)GetValue(HostProperty);
        set => SetValue(HostProperty, value);
    }

    private static void OnHostChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var panel = (MindMapPanel)d;
        if (e.OldValue is MainViewModel oldVm) oldVm.PropertyChanged -= panel.OnHostPropertyChanged;
        if (e.NewValue is MainViewModel newVm) newVm.PropertyChanged += panel.OnHostPropertyChanged;
        panel.StartBackupTimer();
    }

    /// <summary>宿主设置变更：备份间隔变化时按新值重启定时器。</summary>
    private void OnHostPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainViewModel.MindMapBackupMinutes))
            StartBackupTimer();
    }

    /// <summary>组件启用/停用状态变化（安装/卸载完成后触发），宿主据此刷新浮层侧边栏（如卸载项显隐）。</summary>
    public event EventHandler? InstallStateChanged;

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        Loaded -= OnLoaded;
        WireSheetDragOnce();
        VideoPlayer.Volume = VideoVolume.Value;
        WireVideoSeekThumb();
        Show();
    }

    /// <summary>顶部栏思路命令（撤销/重做/插入/排序/编辑/删除）。</summary>
    private void OnIdeaClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not string cmd) return;
        if (cmd == "EditNode")
        {
            _ = Editor.EditSelectedAsync();
            SetStatus("编辑选中节点");
            return;
        }
        _ = Editor.ExecCommandAsync(cmd);
        SetStatus(cmd switch
        {
            "undo" => "已撤销",
            "redo" => "已重做",
            "appendchildnode" => "已插入下级主题",
            "appendsiblingnode" => "已插入同级主题",
            "appendparentnode" => "已插入上级主题",
            "arrangeup" => "节点已上移",
            "arrangedown" => "节点已下移",
            "removenode" => "已删除选中节点",
            "boundary" => "外框已切换",
            _ => "思路：" + cmd,
        });
    }

    /// <summary>为选中节点设置/移除超链接。</summary>
    private void OnLinkClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置链接", warn: true); return; }
        var url = PromptDialog.Show("设置超链接", "链接地址（留空并确定 = 移除已有链接）", "", _ => null);
        if (url is null) return;
        _ = Editor.SetHyperlinkAsync(string.IsNullOrWhiteSpace(url) ? null : url.Trim());
        SetStatus(string.IsNullOrWhiteSpace(url) ? "已移除链接" : "已设置链接：" + url.Trim());
    }

    /// <summary>为选中节点设置/移除图片。</summary>
    private void OnImageClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置图片", warn: true); return; }
        var url = PromptDialog.Show("设置图片", "图片地址（URL 或本地路径；留空并确定 = 移除已有图片）", "", _ => null);
        if (url is null) return;
        _ = Editor.SetImageAsync(string.IsNullOrWhiteSpace(url) ? null : url.Trim());
        SetStatus(string.IsNullOrWhiteSpace(url) ? "已移除图片" : "已设置图片：" + url.Trim());
    }

    /// <summary>为选中节点设置/移除备注。</summary>
    private void OnNoteClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置备注", warn: true); return; }
        var text = PromptDialog.Show("设置备注", "备注内容（留空并确定 = 移除已有备注）", "", _ => null);
        if (text is null) return;
        _ = Editor.SetNoteAsync(string.IsNullOrWhiteSpace(text) ? null : text);
        SetStatus(string.IsNullOrWhiteSpace(text) ? "已移除备注" : "已设置备注");
    }

    /// <summary>为选中节点附加/替换/移除文件附件。节点已有附件时先询问是否移除（取消则重新选择文件替换）。
    /// 附加后自动切到「文件」页签展示该文件信息。</summary>
    private async void OnFileClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置文件", warn: true); return; }
        var current = await Editor.GetSelectedFileAsync();
        if (!string.IsNullOrEmpty(current))
        {
            var remove = ConfirmDialog.Show(Window.GetWindow(this), "文件附件",
                $"该节点已附加文件：\n{current}\n\n「移除」= 删除该附件；\n「取消」= 重新选择文件替换。",
                "移除", danger: true);
            if (remove)
            {
                await Editor.SetFileAsync(null);
                ClearFilePanel();
                ShowSidePage("file");
                SetStatus("已移除文件附件");
                return;
            }
        }
        var dlg = new OpenFileDialog
        {
            Filter = "所有文件|*.*",
            Title = "选择要附加到节点的文件",
        };
        if (dlg.ShowDialog() != true) return;
        await Editor.SetFileAsync(dlg.FileName);
        LoadFileIntoPanel(dlg.FileName, autoplayVideo: false);
        ShowSidePage("file");
        SetStatus($"已附加文件：{Path.GetFileName(dlg.FileName)}");
    }

    /// <summary>插入/替换/移除选中节点的视频附件（独立 data.video 字段）。已有视频时先询问移除，取消则重新选择替换。</summary>
    private async void OnVideoClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置视频", warn: true); return; }
        var current = await Editor.GetSelectedVideoAsync();
        if (!string.IsNullOrEmpty(current))
        {
            var remove = ConfirmDialog.Show(Window.GetWindow(this), "视频附件",
                $"该节点已附加视频：\n{current}\n\n「移除」= 删除该视频；\n「取消」= 重新选择视频替换。",
                "移除", danger: true);
            if (remove)
            {
                await Editor.SetVideoAsync(null);
                ClearFilePanel();
                ShowSidePage("file");
                SetStatus("已移除视频附件");
                return;
            }
        }
        var dlg = new OpenFileDialog
        {
            Filter = MindMapFileService.VideoFilter,
            Title = "选择要附加到节点的视频",
        };
        if (dlg.ShowDialog() != true) return;
        await Editor.SetVideoAsync(dlg.FileName);
        LoadFileIntoPanel(dlg.FileName, autoplayVideo: false);
        ShowSidePage("file");
        SetStatus($"已附加视频：{Path.GetFileName(dlg.FileName)}");
    }

    /// <summary>点击节点上的文件附件图标：自动切到「文件」页签并展示该文件；视频在页签内播放，其余用默认程序打开。</summary>
    private void OnOpenFileRequested(object? sender, string path)
    {
        ShowSidePage("file");
        LoadFileIntoPanel(path, autoplayVideo: true);
        if (!MindMapFileService.IsVideoPath(path))
            OpenFileExternal(path);
        else
            SetStatus($"正在播放视频：{Path.GetFileName(path)}");
    }

    // ---------------- 「文件」页签：附件信息展示 + 视频播放（附件只存路径，展示字段按需读取） ----------------

    /// <summary>用默认程序打开文件（页签「打开」按钮 / 点击非视频附件图标共用）。</summary>
    private void OpenFileExternal(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                SetStatus($"文件不存在：{path}", warn: true);
                return;
            }
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true });
            SetStatus($"已打开文件：{Path.GetFileName(path)}");
        }
        catch (Exception ex)
        {
            SetStatus($"打开文件失败：{ex.Message}", warn: true);
        }
    }

    /// <summary>读取当前选中节点的文件/视频附件并同步文件面板（切到文件页签 / 无附件时清空展示）。
    /// 节点可同时挂两者，视频优先展示（无视频再回落文件）。</summary>
    private async Task LoadSelectedNodeFileAsync()
    {
        if (!Editor.IsReady) return;
        string? path = null;
        try
        {
            var video = await Editor.GetSelectedVideoAsync();
            var file = await Editor.GetSelectedFileAsync();
            path = !string.IsNullOrWhiteSpace(video) ? video : file;
        }
        catch { /* 未就绪等场景忽略，保持面板现状 */ }
        SyncFilePanelFromNode(path ?? "");
    }

    /// <summary>按节点上报的附件路径同步文件面板：与当前展示一致则跳过，否则装载/清空。
    /// autoplay=false：仅展示信息，视频不自动播放（点图标/播放按钮才播）。</summary>
    private void SyncFilePanelFromNode(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            if (_currentFilePath is not null) ClearFilePanel();
            return;
        }
        if (string.Equals(_currentFilePath, path.Trim(), StringComparison.OrdinalIgnoreCase)) return;
        LoadFileIntoPanel(path, autoplayVideo: false);
    }

    /// <summary>把附件路径装载进文件面板：刷新文件信息列表；视频则装入播放器（autoplay 时立即播放）。</summary>
    private void LoadFileIntoPanel(string path, bool autoplayVideo)
    {
        _currentFilePath = path.Trim();
        var info = MindMapFileService.Build(path);
        FileNameText.Text = string.IsNullOrWhiteSpace(info.Name) ? "（无效路径）" : info.Name;
        FileNameText.ToolTip = info.Path;

        FileInfoHost.Children.Clear();
        if (!info.Exists)
        {
            // 文件被移动/删除时仍展示已知字段 + 错误状态，方便定位是哪个附件失效
            FileInfoHost.Children.Add(BuildInfoRow(FileInfoHost, "状态", info.Error, warn: true));
            FileInfoHost.Children.Add(BuildInfoRow(FileInfoHost, "类型", info.TypeText));
        }
        else
        {
            FileInfoHost.Children.Add(BuildInfoRow(FileInfoHost, "类型", info.TypeText));
            FileInfoHost.Children.Add(BuildInfoRow(FileInfoHost, "大小", info.SizeText));
            FileInfoHost.Children.Add(BuildInfoRow(FileInfoHost, "修改时间", info.ModifiedText));
            FileInfoHost.Children.Add(BuildInfoRow(FileInfoHost, "创建时间", info.CreatedText));
        }
        FileInfoHost.Children.Add(BuildInfoRow(FileInfoHost, "所在目录", info.DirectoryText, wrap: true));
        FileInfoHost.Children.Add(BuildInfoRow(FileInfoHost, "完整路径", info.Path, wrap: true));

        if (info.IsVideo)
        {
            LoadVideo(info.Path, autoplayVideo);
            BuildVideoInfoRows(info.Video);
        }
        else
        {
            ClearVideoPlayer();
            VideoTipText.Text = "当前节点附件不是视频，无法播放";
            BuildVideoInfoRows(null);
        }
    }

    /// <summary>清空文件面板（未附加/移除附件时）。</summary>
    private void ClearFilePanel()
    {
        _currentFilePath = null;
        FileNameText.Text = "当前节点未附加文件";
        FileNameText.ToolTip = null;
        FileInfoHost.Children.Clear();
        ClearVideoPlayer();
        VideoTipText.Text = "选择或点击带视频附件的节点后，可在此播放";
        BuildVideoInfoRows(null);
    }

    /// <summary>生成一条「标签 值」信息行并加入宿主面板，返回值 TextBlock（视频行可后续补值）。</summary>
    private static TextBlock BuildInfoRow(StackPanel host, string label, string? value, bool wrap = false, bool warn = false)
    {
        var grid = new Grid { Margin = new Thickness(0, 0, 0, 6) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(60) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var lab = new TextBlock { Text = label, Foreground = InfoLabelBrush, FontSize = 12, VerticalAlignment = VerticalAlignment.Top };
        var val = new TextBlock
        {
            Text = string.IsNullOrWhiteSpace(value) ? "—" : value,
            Foreground = warn ? InfoWarnBrush : InfoValueBrush,
            FontSize = 12,
            TextWrapping = wrap ? TextWrapping.Wrap : TextWrapping.NoWrap,
            TextTrimming = wrap ? TextTrimming.None : TextTrimming.CharacterEllipsis,
            VerticalAlignment = VerticalAlignment.Top,
            ToolTip = string.IsNullOrWhiteSpace(value) ? null : value,
        };
        Grid.SetColumn(val, 1);
        grid.Children.Add(lab);
        grid.Children.Add(val);
        host.Children.Add(grid);
        return val;
    }

    private static readonly Brush InfoLabelBrush = FreezeBrush("#AEB6C4");
    private static readonly Brush InfoValueBrush = FreezeBrush("#D9D9D9");
    private static readonly Brush InfoWarnBrush = FreezeBrush("#E5484D");

    // ---- 视频播放 ----

    /// <summary>页签「附加文件...」：选文件写入选中节点并刷新文件面板。</summary>
    private async void OnFileAttachClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置文件", warn: true); return; }
        var dlg = new OpenFileDialog { Filter = "所有文件|*.*", Title = "选择要附加到节点的文件" };
        if (dlg.ShowDialog() != true) return;
        await Editor.SetFileAsync(dlg.FileName);
        LoadFileIntoPanel(dlg.FileName, autoplayVideo: false);
        SetStatus($"已附加文件：{Path.GetFileName(dlg.FileName)}");
    }

    /// <summary>页签「移除附件」：按节点状态移除显示的附件——优先移除视频，其次文件，然后清空文件面板。</summary>
    private async void OnFileRemoveClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再操作", warn: true); return; }
        var file = await Editor.GetSelectedFileAsync();
        var video = await Editor.GetSelectedVideoAsync();
        if (string.IsNullOrWhiteSpace(file) && string.IsNullOrWhiteSpace(video))
        {
            SetStatus("选中节点没有文件或视频附件", warn: true);
            return;
        }
        if (!string.IsNullOrWhiteSpace(video))
        {
            await Editor.SetVideoAsync(null);
            ClearFilePanel();
            SetStatus("已移除视频附件");
        }
        else
        {
            await Editor.SetFileAsync(null);
            ClearFilePanel();
            SetStatus("已移除文件附件");
        }
    }

    private void OnFileOpenClick(object sender, RoutedEventArgs e)
    {
        if (_currentFilePath is null) { SetStatus("当前节点没有文件附件", warn: true); return; }
        OpenFileExternal(_currentFilePath);
    }

    /// <summary>页签「定位」：资源管理器中打开所在目录并选中该文件。</summary>
    private void OnFileRevealClick(object sender, RoutedEventArgs e)
    {
        if (_currentFilePath is null) { SetStatus("当前节点没有文件附件", warn: true); return; }
        try
        {
            if (!File.Exists(_currentFilePath))
            {
                SetStatus($"文件不存在：{_currentFilePath}", warn: true);
                return;
            }
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", $"/select,\"{_currentFilePath}\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            SetStatus("定位失败：" + ex.Message, warn: true);
        }
    }

    /// <summary>按 Shell 元信息重建视频信息列表（读不到的项显示"—"；时长/分辨率可由 MediaOpened 后补）。</summary>
    private void BuildVideoInfoRows(VideoMeta? meta)
    {
        VideoInfoHost.Children.Clear();
        _videoInfoValues.Clear();
        _videoMeta = meta;
        _videoInfoValues["时长"] = BuildInfoRow(VideoInfoHost, "时长", meta?.DurationText);
        _videoInfoValues["分辨率"] = BuildInfoRow(VideoInfoHost, "分辨率", meta?.ResolutionText);
        _videoInfoValues["帧率"] = BuildInfoRow(VideoInfoHost, "帧率", meta?.FrameRateText);
        _videoInfoValues["码率"] = BuildInfoRow(VideoInfoHost, "码率", meta?.BitrateText);
        _videoInfoValues["视频编码"] = BuildInfoRow(VideoInfoHost, "视频编码", meta?.VideoCodecText);
        _videoInfoValues["音频编码"] = BuildInfoRow(VideoInfoHost, "音频编码", meta?.AudioCodecText);
    }

    /// <summary>更新视频信息列表中的单项（值非空才覆盖，保留 Shell 已读到的信息）。</summary>
    private void SetVideoInfoRow(string key, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value) && _videoInfoValues.TryGetValue(key, out var tb))
            tb.Text = value;
    }

    /// <summary>把视频装入播放器。同一路径已装入时不重置（避免点击图标后重复加载中断播放）。</summary>
    private void LoadVideo(string path, bool autoplay)
    {
        try
        {
            bool reload = !string.Equals(_videoPath, path, StringComparison.OrdinalIgnoreCase) || VideoPlayer.Source is null;
            if (reload)
            {
                PauseVideo();
                VideoPlayer.Stop();
                VideoPlayer.Source = new Uri(path, UriKind.Absolute);
                _videoPath = path;
                SetSeekValue(0);
                VideoTimeText.Text = "0:00";
            }
            if (autoplay)
            {
                _videoAutoplayPending = true;
                PlayVideo();   // 媒体未 MediaOpened 时 Play 会排队，MediaOpened 再兜底触发一次
            }
            else
            {
                VideoTipText.Text = "就绪，点击「播放」开始";
                VideoTipText.Visibility = Visibility.Visible;
            }
        }
        catch (Exception ex)
        {
            SetStatus("视频加载失败：" + ex.Message, warn: true);
            VideoTipText.Text = "视频加载失败";
            VideoTipText.Visibility = Visibility.Visible;
        }
    }

    private void PlayVideo()
    {
        if (_videoPath is null || VideoPlayer.Source is null) return;
        try { VideoPlayer.Play(); } catch { return; }
        _videoAutoplayPending = false;
        _videoIsPlaying = true;
        VideoPlayBtn.Content = "暂停";
        VideoTipText.Visibility = Visibility.Collapsed;
        _videoTimer.Start();
    }

    /// <summary>暂停播放（保留进度）。离开文件页签时也走这里。</summary>
    private void PauseVideo()
    {
        _videoAutoplayPending = false;
        _videoTimer.Stop();
        if (!_videoIsPlaying) return;
        try { VideoPlayer.Pause(); } catch { }
        _videoIsPlaying = false;
        VideoPlayBtn.Content = "播放";
    }

    /// <summary>页签内「停止」按钮：回到开头并保留视频源，便于再点播放从头看。</summary>
    private void StopVideoPlayback()
    {
        _videoAutoplayPending = false;
        _videoTimer.Stop();
        _videoIsPlaying = false;
        VideoPlayBtn.Content = "播放";
        try { VideoPlayer.Stop(); } catch { }
        SetSeekValue(0);
        VideoTimeText.Text = "0:00";
        if (_videoPath is not null)
        {
            VideoTipText.Text = "已停止，点击「播放」重新开始";
            VideoTipText.Visibility = Visibility.Visible;
        }
    }

    /// <summary>清空播放器（非视频附件/面板清空时）：关闭媒体并释放源。</summary>
    private void ClearVideoPlayer()
    {
        StopVideoPlayback();
        _videoPath = null;
        try
        {
            if (VideoPlayer.Source is not null)
            {
                VideoPlayer.Close();
                VideoPlayer.Source = null;
            }
        }
        catch { }
    }

    private void OnVideoPlayPauseClick(object sender, RoutedEventArgs e)
    {
        if (_videoPath is null || VideoPlayer.Source is null)
        {
            SetStatus("当前节点没有可播放的视频附件", warn: true);
            return;
        }
        if (_videoIsPlaying) PauseVideo();
        else PlayVideo();
    }

    private void OnVideoStopClick(object sender, RoutedEventArgs e) => StopVideoPlayback();

    /// <summary>媒体打开后：补齐时长/分辨率并按需开始待自动播放。</summary>
    private void OnVideoMediaOpened(object sender, RoutedEventArgs e)
    {
        VideoTipText.Visibility = Visibility.Collapsed;
        var dur = VideoPlayer.NaturalDuration;
        if (dur.HasTimeSpan)
        {
            VideoSeek.Maximum = Math.Max(1, dur.TimeSpan.TotalSeconds);
            SetVideoInfoRow("时长", MindMapFileService.FormatDuration(dur.TimeSpan));
        }
        if (VideoPlayer.NaturalVideoWidth > 0 && VideoPlayer.NaturalVideoHeight > 0)
            SetVideoInfoRow("分辨率", $"{VideoPlayer.NaturalVideoWidth} × {VideoPlayer.NaturalVideoHeight}");
        if (_videoAutoplayPending) PlayVideo();
    }

    private void OnVideoMediaEnded(object sender, RoutedEventArgs e)
    {
        _videoTimer.Stop();
        _videoIsPlaying = false;
        VideoPlayBtn.Content = "播放";
        SetSeekValue(0);
        try { VideoPlayer.Position = TimeSpan.Zero; } catch { }
        VideoTimeText.Text = "0:00";
        VideoTipText.Text = "播放结束，点击「播放」重看";
        VideoTipText.Visibility = Visibility.Visible;
    }

    private void OnVideoMediaFailed(object sender, ExceptionRoutedEventArgs e)
    {
        _videoTimer.Stop();
        _videoIsPlaying = false;
        VideoPlayBtn.Content = "播放";
        VideoTipText.Text = "该视频无法播放（可能缺少系统解码器）";
        VideoTipText.Visibility = Visibility.Visible;
        SetStatus("视频播放失败：" + e.ErrorException.Message, warn: true);
    }

    /// <summary>播放中周期刷新进度条与时间文本（用户拖动期间跳过回写）。</summary>
    private void OnVideoTimerTick(object? sender, EventArgs e)
    {
        if (_videoSeeking || !_videoIsPlaying) return;
        var dur = VideoPlayer.NaturalDuration;
        if (!dur.HasTimeSpan) return;
        SetSeekValue(VideoPlayer.Position.TotalSeconds);
        VideoTimeText.Text = MindMapFileService.FormatDuration(VideoPlayer.Position)
            + " / " + MindMapFileService.FormatDuration(dur.TimeSpan);
    }

    /// <summary>进度条值变化：非用户拖动/非程序回写时视为点击跳转（IsMoveToPointEnabled）。</summary>
    private void OnVideoSeekValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_videoSeeking || _videoProgrammaticSeek) return;
        TrySeek(TimeSpan.FromSeconds(VideoSeek.Value));
    }

    /// <summary>进度条 Thumb 拖动：拖动期间定时器不回写，松手后落点跳转。模板就绪后接线一次。</summary>
    private void WireVideoSeekThumb()
    {
        if (VideoSeek.Template?.FindName("PART_Track", VideoSeek) is not Track track || track.Thumb is null) return;
        track.Thumb.DragStarted += (_, _) => _videoSeeking = true;
        track.Thumb.DragCompleted += (_, _) =>
        {
            _videoSeeking = false;
            TrySeek(TimeSpan.FromSeconds(VideoSeek.Value));
        };
    }

    private void TrySeek(TimeSpan pos)
    {
        if (VideoPlayer.Source is null) return;
        var dur = VideoPlayer.NaturalDuration;
        if (dur.HasTimeSpan)
            pos = TimeSpan.FromTicks(Math.Clamp(pos.Ticks, 0, dur.TimeSpan.Ticks));
        try { VideoPlayer.Position = pos; } catch { }
        VideoTimeText.Text = MindMapFileService.FormatDuration(pos)
            + (dur.HasTimeSpan ? " / " + MindMapFileService.FormatDuration(dur.TimeSpan) : "");
    }

    /// <summary>程序回写进度条值（抑制 ValueChanged 触发的用户跳转）。</summary>
    private void SetSeekValue(double v)
    {
        _videoProgrammaticSeek = true;
        try { VideoSeek.Value = Math.Clamp(v, VideoSeek.Minimum, VideoSeek.Maximum); }
        finally { _videoProgrammaticSeek = false; }
    }

    /// <summary>设置选中节点优先级（Tag=0..9，0=清除）。</summary>
    private void OnPriorityClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not string s || !int.TryParse(s, out var p)) return;
        _ = Editor.ExecCommandWithValueAsync("priority", p);
        SetStatus(p == 0 ? "已移除优先级" : $"已设置优先级 P{p}");
    }

    /// <summary>设置选中节点进度（Tag=0..9，0=清除）。</summary>
    private void OnProgressClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not string s || !int.TryParse(s, out var p)) return;
        _ = Editor.ExecCommandWithValueAsync("progress", p);
        SetStatus(p == 0 ? "已移除进度" : $"已设置进度 {p}/9");
    }

    // ---------------- 「标签」页签：自定义图标（复用设置面板预设图标库） ----------------

    /// <summary>重建「标签」页签的自定义图标区：按预设图标库分组铺网格，点选把图标设为选中节点图片。
    /// 与设置面板共享同一 <see cref="MainViewModel.PresetIcons"/> 实例，图标库改动即时反映。</summary>
    private void RebuildCustomIconSection()
    {
        CustomIconHost.Children.Clear();
        var pi = Host?.PresetIcons;
        var btnStyle = (Style)FindResource("ToolBarBtn");
        var titleStyle = (Style)FindResource("SegmentTitle");
        bool any = false;
        if (pi != null)
        {
            foreach (var (groupName, icons) in pi.GroupedIcons)
            {
                any |= icons.Count > 0;
                CustomIconHost.Children.Add(new TextBlock
                {
                    Text = groupName,
                    Style = titleStyle,
                    Margin = new Thickness(2, 8, 0, 6),
                });
                var grid = new UniformGrid { Columns = 4, Margin = new Thickness(0, 0, 0, 6) };
                foreach (var (name, icon) in icons)
                {
                    var n = name;
                    var btn = new Button
                    {
                        Style = btnStyle,
                        ToolTip = name,
                        Width = 42,
                        Height = 34,
                        Padding = new Thickness(3),
                        Margin = new Thickness(0, 0, 4, 5),
                        Content = new Image { Source = icon, Width = 22, Height = 22, Stretch = Stretch.Uniform },
                    };
                    btn.Click += (_, _) => OnCustomIconClick(n);
                    grid.Children.Add(btn);
                }
                CustomIconHost.Children.Add(grid);
            }
        }
        if (!any)
        {
            CustomIconHost.Children.Add(new TextBlock
            {
                Text = "暂无预设图标（可在「设置」中导入）",
                Style = titleStyle,
                Margin = new Thickness(2, 6, 0, 4),
            });
        }
    }

    /// <summary>把选中的预设图标应用到当前节点图片（预设为 .ico，转 PNG data URI 交给内核渲染）。</summary>
    private void OnCustomIconClick(string presetName)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再应用图标", warn: true); return; }
        var path = Host?.PresetIcons?.FullPath(presetName);
        if (string.IsNullOrEmpty(path) || !File.Exists(path))
        {
            SetStatus($"未找到预设图标：{presetName}", warn: true);
            return;
        }
        ApplyImageToNode(path, "自定义图标");
    }

    /// <summary>从本机选择图片文件作为选中节点图片（支持 ico/png/jpg/jpeg/bmp/gif，统一转 data URI 传入内核）。</summary>
    private void OnBrowseImageClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置图片", warn: true); return; }
        var dlg = new OpenFileDialog
        {
            Filter = "图片文件|*.ico;*.png;*.jpg;*.jpeg;*.bmp;*.gif|所有文件|*.*",
            Title = "选择图片作为节点图片",
        };
        if (dlg.ShowDialog() != true) return;
        ApplyImageToNode(dlg.FileName, Path.GetFileName(dlg.FileName));
    }

    /// <summary>清除选中节点的图片。</summary>
    private void OnClearIconClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，尚无法清除", warn: true); return; }
        _ = Editor.SetImageAsync(null);
        SetStatus("已清除选中节点图片");
    }

    /// <summary>把本地图片转换成 data URI 并应用到选中节点。.ico 转 PNG（浏览器节点渲染最稳），其余按原格式 base64。</summary>
    private async void ApplyImageToNode(string path, string label)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置图片", warn: true); return; }
        var dataUri = await Task.Run(() => LoadImageAsDataUri(path));
        if (dataUri == null) { SetStatus("图片读取失败或不支持的格式", warn: true); return; }
        _ = Editor.SetImageAsync(dataUri);
        SetStatus($"已设置图片：{label}");
    }

    /// <summary>读取本地图片为 data URI。.ico 取最大帧转 PNG；其余按扩展名取对应 MIME 直接 base64。</summary>
    private static string? LoadImageAsDataUri(string path)
    {
        try
        {
            var ext = Path.GetExtension(path).ToLowerInvariant();
            if (ext == ".ico")
            {
                using var fs = File.OpenRead(path);
                var dec = BitmapDecoder.Create(fs, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
                if (dec.Frames.Count == 0) return null;
                BitmapFrame? best = null;
                foreach (var fr in dec.Frames)
                    if (best == null
                        || (long)fr.PixelWidth * fr.PixelHeight > (long)best.PixelWidth * best.PixelHeight)
                        best = fr;
                if (best == null) return null;
                var enc = new PngBitmapEncoder();
                enc.Frames.Add(BitmapFrame.Create(best));
                using var ms = new MemoryStream();
                enc.Save(ms);
                return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
            }
            var mime = ext switch
            {
                ".png" => "image/png",
                ".jpg" or ".jpeg" => "image/jpeg",
                ".bmp" => "image/bmp",
                ".gif" => "image/gif",
                _ => null,
            };
            if (mime == null) return null;
            var bytes = File.ReadAllBytes(path);
            return $"data:{mime};base64," + Convert.ToBase64String(bytes);
        }
        catch (Exception e)
        {
            KityMinderHost.Diag($"LoadImageAsDataUri error: {e.Message}");
            return null;
        }
    }

    /// <summary>视图-选择：按模式选中节点并重置回占位项。</summary>
    private void OnSelectChanged(object sender, SelectionChangedEventArgs e)
    {
        if (SelectBox.SelectedItem is ComboBoxItem { Tag: string mode })
        {
            _ = Editor.SelectNodesAsync(mode);
            SetStatus(mode switch
            {
                "all" => "已全选节点",
                "revert" => "已反选节点",
                "siblings" => "已选择兄弟节点",
                "level" => "已选择同级节点",
                "path" => "已选择路径",
                "tree" => "已选择子树",
                _ => "选择：" + mode,
            });
        }
        SelectBox.SelectedIndex = 0;
    }

    /// <summary>视图-搜索：按输入框关键字搜索节点（前端逐个循环定位+高亮）。</summary>
    private async void OnSearchClick(object sender, RoutedEventArgs e)
    {
        await DoSearchAsync();
    }

    /// <summary>输入框回车触发搜索。</summary>
    private async void OnSearchKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        await DoSearchAsync();
    }

    private async Task DoSearchAsync()
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再搜索", warn: true); return; }
        var keyword = SearchBox?.Text?.Trim() ?? "";
        if (keyword.Length == 0) { SetStatus("请输入要搜索的关键字", warn: true); return; }
        var result = await Editor.SearchAsync(keyword);
        if (string.IsNullOrEmpty(result))
        {
            SetStatus("搜索失败或脑图未就绪", warn: true);
            return;
        }
        var parts = result.Split('/');
        var index = int.Parse(parts[0]);
        var total = int.Parse(parts[1]);
        if (total == 0) { SetStatus($"未找到匹配「{keyword}」的节点", warn: true); }
        else { SetStatus($"搜索「{keyword}」：第 {index}/{total} 个匹配"); }
    }

    /// <summary>浮层显示时调用：按组件启用状态切换承载区并刷新文件工具栏。
    /// 编辑器已就绪且插件目录未变时不再重载，保留当前内容/主题/布局与视图状态（配合自动保存）。
    /// 加载进行中也不再重复 Reload——快速开关会打断进行中的导航产生 OperationCanceled 报错，等它自然就绪即可。</summary>
    public void Show()
    {
        RefreshInstallUi();
        RebuildCustomIconSection();
        if (Editor.Visibility != Visibility.Visible) return;
        var animate = Host?.MindMapLayoutAnimation ?? false;
        var animateChanged = Editor.AnimateLayout != animate;
        Editor.AnimateLayout = animate;
        var dir = Host?.Plugins.GetInstalledDir(PluginService.KityMinderId);
        if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
        {
            var changed = Editor.SourcePath != dir;
            Editor.SourcePath = dir;
            // 动画开关变化需重载页面让注入脚本按新值生效（保留自动保存的画布内容）
            if (changed || animateChanged || (!Editor.IsReady && !Editor.IsLoading)) Editor.Reload();
        }
        else if (!Editor.IsReady && !Editor.IsLoading)
        {
            Editor.Reload();
        }
    }

    // ---------------- 自动保存 + 打开恢复 ----------------

    /// <summary>编辑器就绪（含重载后）时恢复上次保存的全部画布，并载入其中激活的那张。</summary>
    private async void OnEditorReady(object? sender, bool ready)
    {
        if (!ready) return;
        KityMinderHost.Diag("OnEditorReady enter");
        try
        {
            MindMapState? state = null;
            if (!_sheetsLoaded)
            {
                state = MindMapStateStore.Load();
                _sheetsLoaded = true;
            }
            if (state is not null)
            {
                _sheets.Clear();
                _sheets.AddRange(state.GetSheets());
                _activeSheetId = state.GetActiveSheetId(_sheets);
                KityMinderHost.Diag($"OnEditorReady sheets={_sheets.Count} active={_activeSheetId}");
            }
            EnsureSheets();
            RefreshSheetTabs();

            var active = ActiveSheet;
            if (active is null) return;
            _suppressSave = true;
            _dirtyDuringSuppress = false;
            await LoadSheetIntoEditorAsync(active);
            _ = DelayThenClearSuppressAsync();
        }
        catch (Exception ex)
        {
            _suppressSave = false;
            SetStatus("恢复上次脑图失败：" + ex.Message, warn: true);
        }
    }

    // ---------------- 多画布：画布集合 / 切换 / 底部标签条 ----------------

    /// <summary>当前激活画布（激活 Id 无效时回退第一张）。</summary>
    private MindMapSheetData? ActiveSheet =>
        _sheets.FirstOrDefault(s => s.Id == _activeSheetId) ?? _sheets.FirstOrDefault();

    /// <summary>确保至少有一张画布，且激活 Id 有效（首次进入 / 存档为空 / 删除后）。</summary>
    private void EnsureSheets()
    {
        if (_sheets.Count == 0)
        {
            var created = MindMapWorkbookOps.NewSheet("画布 1", _currentTheme, _currentLayout);
            _sheets.Add(created);
            _activeSheetId = created.Id;
            return;
        }
        if (string.IsNullOrEmpty(_activeSheetId) || !_sheets.Any(s => s.Id == _activeSheetId))
            _activeSheetId = _sheets[0].Id;
    }

    /// <summary>重建底部画布标签条（画布数很少，整列重建即可；首次设置数据源后保持同一 ObservableCollection 实例，
    /// 拖拽重排走 MoveSheetVisual 的 Move 保留容器实例）。</summary>
    private void RefreshSheetTabs()
    {
        if (sheetTabs is null) return;
        if (sheetTabs.ItemsSource == null) sheetTabs.ItemsSource = _sheetTabItems;
        _sheetTabItems.Clear();
        foreach (var s in _sheets)
            _sheetTabItems.Add(new SheetTabItem { Id = s.Id, Title = s.Title, IsActive = s.Id == _activeSheetId });
    }

    /// <summary>画布标签拖拽落点：同步搬移数据列表与标签集合（Move 保留容器实例 → 让位动画生效），激活画布引用不变。</summary>
    private void MoveSheet(int from, int to)
    {
        MoveSheetVisual(from, to);
        _ = SaveStateNowAsync();
    }

    /// <summary>仅搬移（拖拽实时换位用）：同步 _sheets 与 _sheetTabItems 顺序，激活画布 Id 不变。</summary>
    private void MoveSheetVisual(int from, int to)
    {
        if (from == to || from < 0 || to < 0 || from >= _sheets.Count || to >= _sheets.Count) return;
        var sheet = _sheets[from];
        _sheets.RemoveAt(from);
        _sheets.Insert(to, sheet);
        _sheetTabItems.Move(from, to);
    }

    /// <summary>把指定画布载入编辑器（内容 + 主题 + 布局）；调用方负责抑制自动保存。</summary>
    private async Task LoadSheetIntoEditorAsync(MindMapSheetData sheet)
    {
        var content = string.IsNullOrWhiteSpace(sheet.Content)
            ? MindMapWorkbookOps.EmptyContent(sheet.Title)
            : sheet.Content!;
        var ok = await Editor.ImportJsonAsync(content);
        _lastSavedContent = ok ? content : null;

        _currentTheme = string.IsNullOrWhiteSpace(sheet.Theme) ? "fresh-blue" : sheet.Theme;
        var themeOpt = _themes.FirstOrDefault(t => t.Value == _currentTheme);
        if (themeOpt != null)
            await SwitchCustomThemeAsync(themeOpt, persist: false);

        _currentLayout = string.IsNullOrWhiteSpace(sheet.Layout) ? "default" : sheet.Layout;
        var layoutOpt = _layouts.FirstOrDefault(l => l.Value == _currentLayout);
        if (layoutOpt != null)
        {
            SelectOnly(_layouts, layoutOpt.Value);
            await Editor.SetTemplateAsync(layoutOpt.Value);
        }
    }

    /// <summary>
    /// 切换画布：先把当前编辑器内容存回当前画布（captureCurrent=false 时丢弃，用于删除/整体导入），
    /// 再载入目标画布。切换期间抑制自动保存，结束后补存（激活 Id 变化也要落盘）。
    /// </summary>
    private async Task SwitchSheetAsync(string id, bool captureCurrent = true)
    {
        if (_switchingSheet) return;
        if (id == _activeSheetId) return;
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再切换画布", warn: true); return; }
        var target = _sheets.FirstOrDefault(s => s.Id == id);
        if (target is null) return;

        _switchingSheet = true;
        _suppressSave = true;
        _dirtyDuringSuppress = false;
        try
        {
            if (captureCurrent && ActiveSheet is { } cur)
            {
                var json = await Editor.ExportJsonAsync();
                if (json is not null)
                {
                    cur.Content = json;
                    cur.Theme = _currentTheme;
                    cur.Layout = _currentLayout;
                }
            }
            _activeSheetId = id;
            RefreshSheetTabs();
            await LoadSheetIntoEditorAsync(target);
            SetStatus("画布：" + target.Title);
        }
        finally
        {
            _switchingSheet = false;
            _dirtyDuringSuppress = true;   // 保证延迟结束后补存一次（含 activeId 变更）
            _ = DelayThenClearSuppressAsync();
        }
    }

    /// <summary>「＋」新建画布：追加到末尾并切过去。</summary>
    private async void OnAddSheetClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再新建画布", warn: true); return; }
        var title = MindMapWorkbookOps.NextTitle(_sheets);
        var sheet = MindMapWorkbookOps.NewSheet(title, _currentTheme, _currentLayout);
        _sheets.Add(sheet);
        await SwitchSheetAsync(sheet.Id);
        SetStatus("已新建画布：" + title);
    }

    private async void OnSheetTabClick(object sender, RoutedEventArgs e)
    {
        if (_sheetDrag is { IsDragging: true }) return;   // 拖拽中不响应单击切换
        if (TabIdOf(sender) is { } id) await SwitchSheetAsync(id);
    }

    /// <summary>双击标签 = 重命名（与 XMind 一致）。</summary>
    private void OnSheetTabDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (_sheetDrag is { IsDragging: true }) return;   // 拖拽中不响应双击重命名
        if (TabIdOf(sender) is not { } id) return;
        e.Handled = true;
        RenameSheet(id);
    }

    private void OnSheetRenameClick(object sender, RoutedEventArgs e)
    {
        if (TabIdOf(sender) is { } id) RenameSheet(id);
    }

    private async void OnSheetDuplicateClick(object sender, RoutedEventArgs e)
    {
        if (TabIdOf(sender) is { } id) await DuplicateSheetAsync(id);
    }

    private async void OnSheetDeleteClick(object sender, RoutedEventArgs e)
    {
        if (TabIdOf(sender) is { } id) await DeleteSheetAsync(id);
    }

    private static string? TabIdOf(object sender)
        => (sender as FrameworkElement)?.DataContext is SheetTabItem item ? item.Id : null;

    private void RenameSheet(string id)
    {
        var sheet = _sheets.FirstOrDefault(s => s.Id == id);
        if (sheet is null) return;
        var name = PromptDialog.Show("重命名画布", "画布名称", sheet.Title,
            v => string.IsNullOrWhiteSpace(v) ? "名称不能为空" : null);
        if (string.IsNullOrWhiteSpace(name)) return;
        sheet.Title = name!.Trim();
        RefreshSheetTabs();
        _ = SaveStateNowAsync();
        SetStatus("画布已重命名：" + sheet.Title);
    }

    private async Task DuplicateSheetAsync(string id)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再复制画布", warn: true); return; }
        var src = _sheets.FirstOrDefault(s => s.Id == id);
        if (src is null) return;

        var copy = src.Clone();
        copy.Id = MindMapWorkbookOps.NewSheetId();
        var baseTitle = src.Title + " 副本";
        copy.Title = baseTitle;
        var n = 2;
        while (_sheets.Any(s => string.Equals(s.Title, copy.Title, StringComparison.Ordinal)))
            copy.Title = baseTitle + " " + n++;

        _sheets.Insert(_sheets.IndexOf(src) + 1, copy);
        await SwitchSheetAsync(copy.Id);
        SetStatus("已复制画布：" + copy.Title);
    }

    private async Task DeleteSheetAsync(string id)
    {
        var sheet = _sheets.FirstOrDefault(s => s.Id == id);
        if (sheet is null) return;
        if (_sheets.Count <= 1) { SetStatus("至少要保留一张画布", warn: true); return; }
        if (!ConfirmDialog.Show(Window.GetWindow(this), "删除画布",
                $"确定删除画布「{sheet.Title}」？该画布内容将一并删除，且无法撤销。", "删除", danger: true))
            return;

        var idx = _sheets.IndexOf(sheet);
        _sheets.RemoveAt(idx);
        if (id == _activeSheetId)
        {
            _activeSheetId = null;                                       // 强制切到相邻画布
            await SwitchSheetAsync(_sheets[Math.Min(idx, _sheets.Count - 1)].Id, captureCurrent: false);
        }
        else
        {
            RefreshSheetTabs();
            _ = SaveStateNowAsync();
        }
        SetStatus("已删除画布：" + sheet.Title);
    }

    /// <summary>用外部导入的整本脑图替换当前全部画布，并载入其激活画布。</summary>
    private async Task ApplyWorkbookAsync(MindMapWorkbook book)
    {
        var sheets = MindMapWorkbookOps.Normalize(book.Sheets, book.ActiveId);
        if (sheets.Count == 0) return;
        var activeId = !string.IsNullOrWhiteSpace(book.ActiveId) && sheets.Any(s => s.Id == book.ActiveId)
            ? book.ActiveId!
            : sheets[0].Id;

        _sheets.Clear();
        _sheets.AddRange(sheets);
        _activeSheetId = null;
        RefreshSheetTabs();
        await SwitchSheetAsync(activeId, captureCurrent: false);
    }

    // ---------------- 画布标签条拖拽重排（横向：悬浮跟随 + 死区换位 + 贴边自动滚动 + 插入竖条） ----------------

    /// <summary>一次性挂接标签拖拽事件流（Preview 隧道事件，不干扰按钮 Click/右键菜单）。</summary>
    private void WireSheetDragOnce()
    {
        if (_sheetDragWired) return;
        _sheetDragWired = true;
        PreviewMouseLeftButtonDown += OnSheetDragDown;
        PreviewMouseMove += OnSheetDragMove;
        PreviewMouseLeftButtonUp += OnSheetDragUp;

        _sheetPanel = FindVisualChild<AnimatedStackPanel>(sheetTabs);   // Loaded 时 ItemsPanel 可能未生成，BeginSheetFollow 会惰性重取

        if (sheetTabOverlay != null)
        {
            // 插入竖条配色与主界面插入指示一致（LineActiveBrush，失败回退蓝灰）
            var lineActive = TryFindResource("LineActiveBrush") as Brush
                ?? new SolidColorBrush(Color.FromRgb(0x70, 0x85, 0xa8));
            var lineColor = ((SolidColorBrush)lineActive).Color;
            _sheetInsertBar = new System.Windows.Shapes.Rectangle
            {
                Fill = new SolidColorBrush(Color.FromArgb(0xE6, lineColor.R, lineColor.G, lineColor.B)),
                Width = 2,
                RadiusX = 1,
                RadiusY = 1,
                Visibility = Visibility.Collapsed,
                IsHitTestVisible = false,
                SnapsToDevicePixels = true,
            };
            sheetTabOverlay.Children.Add(_sheetInsertBar);
        }
    }

    /// <summary>按下：仅当点在画布标签按钮上时记录候选（不设 Handled，保留单击切换/双击重命名）。</summary>
    private void OnSheetDragDown(object sender, MouseButtonEventArgs e)
    {
        // 上次拖拽可能因捕获丢失未走 Up → 先清残留状态，避免插入条/悬浮偏移残留
        if (_sheetDrag != null) CancelSheetDrag();
        var origin = e.OriginalSource as DependencyObject;
        var btn = FindVisualParent<Button>(origin);
        if (btn == null || !IsInHost(btn, sheetTabs)) return;
        if (btn.DataContext is not SheetTabItem item) return;
        _sheetDrag = new SheetDragState { Item = item, Start = e.GetPosition(this) };
    }

    private void OnSheetDragMove(object sender, MouseEventArgs e)
    {
        var st = _sheetDrag;
        if (st == null) return;
        Point pos = e.GetPosition(this);

        // 拖拽中捕获丢失（UI 重组/移出窗口）时 MouseUp 可能不触发 → 检测左键已松开按当前落点结束
        if (e.LeftButton == MouseButtonState.Released)
        {
            e.Handled = true;
            CompleteSheetDrag(pos);
            return;
        }

        try
        {
            if (!st.IsDragging)
            {
                double dx = pos.X - st.Start.X, dy = pos.Y - st.Start.Y;
                if (Math.Sqrt(dx * dx + dy * dy) < SheetDragThreshold) return;
                st.IsDragging = true;
                CaptureMouse();
                Cursor = Cursors.SizeWE;
                e.Handled = true;
                BeginSheetFollow(st, pos);
                UpdateSheetHighlight(pos);
                return;
            }
            e.Handled = true;
            UpdateSheetFollow(pos);
            TryLiveSheetSwap(pos);
            UpdateSheetHighlight(pos);
        }
        catch
        {
            // 拖拽过程中的瞬时布局异常不弹窗打断，直接安全结束
            CancelSheetDrag();
        }
    }

    private void OnSheetDragUp(object sender, MouseButtonEventArgs e)
    {
        var st = _sheetDrag;
        if (st == null) return;
        if (st.IsDragging) e.Handled = true;
        CompleteSheetDrag(e.GetPosition(this));
    }

    /// <summary>完成一次标签拖拽：按落点执行重排并落盘（OnSheetDragUp 与捕获丢失兜底共用）。</summary>
    private void CompleteSheetDrag(Point pos)
    {
        var st = _sheetDrag;
        if (st == null) return;
        _sheetDrag = null;
        try
        {
            var el = _sheetFollowEl;
            var probe = FloatingSheetProbeX();   // 清空跟随态前先取探测点（松手瞬间位置）
            _sheetFollowEl = null;
            StopSheetAutoScroll();
            if (el != null)
            {
                _sheetPanel?.Unpin(el);
                if (st.IsDragging)
                {
                    int from = _sheetTabItems.IndexOf(st.Item!);
                    int toIdx = GetSheetSwapIndex(probe ?? pos.X, from);
                    if (from >= 0 && toIdx != from)
                    {
                        // 不清偏移：同步布局后 ArrangeOverride 以「旧布局左+残留偏移」为起点滑入新槽位
                        MoveSheet(from, toIdx);
                        sheetTabs.UpdateLayout();
                    }
                    else
                    {
                        AnimatedStackPanel.SpringBack(el);
                    }
                }
            }
        }
        finally
        {
            HideSheetInsertBar();
            ReleaseMouseCapture();
            if (st.IsDragging) Cursor = Cursors.Arrow;
        }
    }

    /// <summary>放弃标签拖拽：清理状态并把被拖标签回弹原位（异常兜底/重复按下清理共用）。</summary>
    private void CancelSheetDrag()
    {
        var el = _sheetFollowEl;
        _sheetFollowEl = null;
        StopSheetAutoScroll();
        HideSheetInsertBar();
        if (el != null)
        {
            _sheetPanel?.Unpin(el);
            AnimatedStackPanel.SpringBack(el);
        }
    }

    /// <summary>激活悬浮跟随：记录屏幕系起点与标签宽，Pin 住容器，启动贴边自动滚动。</summary>
    private void BeginSheetFollow(SheetDragState st, Point pos)
    {
        if (_sheetPanel == null) _sheetPanel = FindVisualChild<AnimatedStackPanel>(sheetTabs);
        if (_sheetPanel == null || sheetTabsScroll == null) return;
        int i = _sheetTabItems.IndexOf(st.Item!);
        if (i < 0 || SafeContainer(sheetTabs, i) is not UIElement el) return;
        _sheetFollowEl = el;
        _sheetFollowStartMouseX = pos.X;
        _sheetFollowStartLayoutLeft = VisualTreeHelper.GetOffset(el).X;
        _sheetFollowStartWinLeft = sheetTabs.TranslatePoint(new Point(_sheetFollowStartLayoutLeft, 0), this).X;
        _sheetFollowTabW = el.RenderSize.Width;
        _sheetLastPosX = pos.X;
        _sheetPanel.Pin(el);
        StartSheetAutoScroll();
    }

    /// <summary>拖动中的标签视觉跟随：目标左 = 起点 + 鼠标位移，夹在滚动视口内（标签右缘不越出可见框），
    /// 再换算回面板系设置偏移；屏幕系目标使自动滚动时换算自动生效。</summary>
    private void UpdateSheetFollow(Point pos)
    {
        if (sheetTabsScroll == null || _sheetFollowEl == null) return;
        _sheetLastPosX = pos.X;

        double desiredWinLeft = _sheetFollowStartWinLeft + (pos.X - _sheetFollowStartMouseX);
        Point o = sheetTabsScroll.TranslatePoint(new Point(0, 0), this);            // 视口左（面板坐标，随滚动变化）
        double lo = o.X;
        double hi = o.X + sheetTabsScroll.ViewportWidth - _sheetFollowTabW;          // 标签右缘不越过视口右
        if (hi < lo) hi = lo;
        desiredWinLeft = Math.Clamp(desiredWinLeft, lo, hi);

        double panelVisualLeft = desiredWinLeft - sheetTabs.TranslatePoint(new Point(0, 0), this).X;   // 面板→面板
        double curLeft = VisualTreeHelper.GetOffset(_sheetFollowEl).X;               // 实时换位后的最新布局左
        AnimatedStackPanel.SetDirectOffset(_sheetFollowEl, panelVisualLeft - curLeft);
    }

    /// <summary>按悬浮中心执行一次实时换位判定（MouseMove 与自动滚动跳帧共用）。</summary>
    private void TryLiveSheetSwap(Point pos)
    {
        if (_sheetDrag is not { IsDragging: true } st || _sheetFollowEl == null || sheetTabs == null) return;
        int from = _sheetTabItems.IndexOf(st.Item!);
        var probe = FloatingSheetProbeX();
        int toIdx = GetSheetSwapIndex(probe ?? pos.X, from);
        if (toIdx != from && toIdx >= 0)
        {
            MoveSheetVisual(from, toIdx);
            sheetTabs.UpdateLayout();   // 立即取得新布局左，保证悬浮标签视觉连续不跳
        }
    }

    /// <summary>悬浮中被拖标签的探测点（面板坐标，含当前跟随偏移）：视觉中心 X，用于换位判定。</summary>
    private double? FloatingSheetProbeX()
    {
        if (sheetTabs == null || _sheetFollowEl == null) return null;
        double curLeft = VisualTreeHelper.GetOffset(_sheetFollowEl).X;
        double off = 0;
        switch (_sheetFollowEl.RenderTransform)
        {
            case TranslateTransform t:
                off = t.X;
                break;
            case TransformGroup g:
                foreach (var tr in g.Children)
                    if (tr is TranslateTransform tt) { off = tt.X; break; }
                break;
        }
        double winLeft = sheetTabs.TranslatePoint(new Point(curLeft + off, 0), this).X;
        return winLeft + _sheetFollowEl.RenderSize.Width / 2;
    }

    /// <summary>标签相对 target 视觉的「布局」左边 X（VisualTreeHelper.GetOffset，不含让位滑动动画偏移）。
    /// 插入点判定与竖条定位必须用它：滑动进行中 TranslatePoint 会返回半路视觉位置。</summary>
    private double SheetLayoutLeftIn(UIElement el, UIElement target)
    {
        if (sheetTabs == null) return 0;
        double inPanel = VisualTreeHelper.GetOffset(el).X;
        return sheetTabs.TranslatePoint(new Point(inPanel, 0), target).X;
    }

    /// <summary>
    /// 带死区的横向换位索引：基准=被拖标签视觉中心；越过邻框中心再超出死区才换一步，
    /// 支持循环多步推进（快速甩动也能追上）；死区内保持原索引。换位/竖条/落点三处共用。
    /// </summary>
    private int GetSheetSwapIndex(double effX, int from)
    {
        int n = sheetTabs.Items.Count;
        if (n == 0 || from < 0) return 0;
        int idx = Math.Clamp(from, 0, n - 1);
        for (int guard = 0; guard < n; guard++)
        {
            int next = idx;
            if (idx + 1 < n && SafeContainer(sheetTabs, idx + 1) is UIElement below)
            {
                // 死区 = min(固定16px, 邻框中心到其 70% 线距离 = 宽的20%) —— 小标签自动缩小死区
                double margin = Math.Min(SheetSwapHysteresis, below.RenderSize.Width * 0.2);
                if (effX > SheetLayoutLeftIn(below, this) + below.RenderSize.Width / 2 + margin) next = idx + 1;
            }
            if (next == idx && idx - 1 >= 0 && SafeContainer(sheetTabs, idx - 1) is UIElement above)
            {
                double margin = Math.Min(SheetSwapHysteresis, above.RenderSize.Width * 0.2);
                if (effX < SheetLayoutLeftIn(above, this) + above.RenderSize.Width / 2 - margin) next = idx - 1;
            }
            if (next == idx) break;
            idx = next;
        }
        return idx;
    }

    private void StartSheetAutoScroll()
    {
        if (_sheetAutoScrollTimer != null) return;
        _sheetAutoScrollTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(16) };
        _sheetAutoScrollTimer.Tick += OnSheetAutoScrollTick;
        _sheetAutoScrollTimer.Start();
    }

    private void StopSheetAutoScroll()
    {
        if (_sheetAutoScrollTimer == null) return;
        _sheetAutoScrollTimer.Stop();
        _sheetAutoScrollTimer.Tick -= OnSheetAutoScrollTick;
        _sheetAutoScrollTimer = null;
    }

    /// <summary>拖动贴边自动滚动：指针进入视口左/右边缘区（56px）按侵入深度加速横向滚动；
    /// 每跳后重算跟随与换位（滚动不产生 MouseMove，必须由跳帧主动触发换位）。</summary>
    private void OnSheetAutoScrollTick(object? sender, EventArgs e)
    {
        if (_sheetFollowEl == null || sheetTabsScroll == null) { StopSheetAutoScroll(); return; }
        Point o = sheetTabsScroll.TranslatePoint(new Point(0, 0), this);
        double vpLeft = o.X, vpRight = o.X + sheetTabsScroll.ViewportWidth;
        const double zone = 56.0, minSpeed = 4.0, maxSpeed = 18.0;
        double pX = _sheetLastPosX;
        double delta;
        if (pX > vpRight - zone)
            delta = minSpeed + (maxSpeed - minSpeed) * Math.Min(1, (pX - (vpRight - zone)) / zone);
        else if (pX < vpLeft + zone)
            delta = -(minSpeed + (maxSpeed - minSpeed) * Math.Min(1, ((vpLeft + zone) - pX) / zone));
        else return;

        double target = Math.Clamp(sheetTabsScroll.HorizontalOffset + delta, 0, sheetTabsScroll.ScrollableWidth);
        if (Math.Abs(target - sheetTabsScroll.HorizontalOffset) < 0.01) return;   // 已到滚动尽头
        sheetTabsScroll.ScrollToHorizontalOffset(target);
        var p = new Point(_sheetLastPosX, 0);
        UpdateSheetFollow(p);   // 滚动后重算偏移，悬浮标签保持贴手
        TryLiveSheetSwap(p);    // 内容滚过悬浮中心也要触发让位换位
        UpdateSheetFollow(p);   // 换位改变布局左后再校正一次
    }

    /// <summary>拖动中的插入位置竖条：按死区索引（与实时换位一致）在目标缝隙显示；Y 用布局坐标，不受滑动动画影响。</summary>
    private void UpdateSheetHighlight(Point pos)
    {
        var bar = _sheetInsertBar;
        if (bar == null) return;
        if (_sheetDrag is not { IsDragging: true } st || sheetTabs == null || sheetTabs.Items.Count == 0)
        {
            bar.Visibility = Visibility.Collapsed;
            return;
        }
        int from = _sheetTabItems.IndexOf(st.Item!);
        var probe = FloatingSheetProbeX();
        int idx = GetSheetSwapIndex(probe ?? pos.X, from);
        int n = sheetTabs.Items.Count;

        UIElement? e = null;
        double xOffset = 0;
        if (idx <= 0) e = SafeContainer(sheetTabs, 0);
        else if (idx >= n) { e = SafeContainer(sheetTabs, n - 1); xOffset = e?.RenderSize.Width ?? 0; }
        else e = SafeContainer(sheetTabs, idx);
        if (e == null) { bar.Visibility = Visibility.Collapsed; return; }

        double left = SheetLayoutLeftIn(e, sheetTabOverlay) + xOffset;
        double top = e.TranslatePoint(new Point(0, 0), sheetTabOverlay).Y;
        Canvas.SetLeft(bar, left - 1);
        Canvas.SetTop(bar, top);
        bar.Width = 2;
        bar.Height = e.RenderSize.Height;
        bar.Visibility = Visibility.Visible;
    }

    private void HideSheetInsertBar()
    {
        if (_sheetInsertBar != null) _sheetInsertBar.Visibility = Visibility.Collapsed;
    }

    // ---------------- 命中测试 / 索引换算辅助 ----------------

    private static DependencyObject? GetParent(DependencyObject d)
        => d is System.Windows.ContentElement ? LogicalTreeHelper.GetParent(d) : VisualTreeHelper.GetParent(d);

    private static T? FindVisualParent<T>(DependencyObject? d) where T : DependencyObject
    {
        for (var cur = d; cur != null; cur = GetParent(cur))
            if (cur is T t) return t;
        return null;
    }

    private static bool IsInHost(DependencyObject obj, ItemsControl host)
    {
        for (var d = obj; d != null; d = GetParent(d))
            if (ReferenceEquals(d, host)) return true;
        return false;
    }

    /// <summary>安全获取 ItemsControl 第 i 项容器；生成器重组中返回 null，避免查询抛出异常。</summary>
    private static UIElement? SafeContainer(ItemsControl ic, int i)
    {
        var gen = ic.ItemContainerGenerator;
        if (gen.Status != System.Windows.Controls.Primitives.GeneratorStatus.ContainersGenerated) return null;
        return gen.ContainerFromIndex(i) as UIElement;
    }

    private static T? FindVisualChild<T>(DependencyObject root) where T : DependencyObject
    {
        if (root is T t) return t;
        int n = VisualTreeHelper.GetChildrenCount(root);
        for (int i = 0; i < n; i++)
        {
            var found = FindVisualChild<T>(VisualTreeHelper.GetChild(root, i));
            if (found != null) return found;
        }
        return null;
    }

    /// <summary>把单画布内容（kityminder JSON）替换到当前画布。</summary>
    private async Task ApplySingleContentAsync(string json)
    {
        EnsureSheets();
        if (!Editor.IsReady || ActiveSheet is not { } cur) return;
        _suppressSave = true;
        _dirtyDuringSuppress = false;
        try
        {
            var ok = await Editor.ImportJsonAsync(json);
            if (!ok) { SetStatus("导入失败：格式不符或未就绪", warn: true); return; }
            cur.Content = json;
            _lastSavedContent = json;
            SetStatus("导入成功（已替换当前画布内容）");
        }
        finally
        {
            _dirtyDuringSuppress = true;
            _ = DelayThenClearSuppressAsync();
        }
    }

    /// <summary>内容变更 → 防抖自动保存；恢复抑制期间仅记脏标记。</summary>
    private void OnContentChanged(object? sender, EventArgs e)
    {
        KityMinderHost.Diag($"OnContentChanged _suppressSave={_suppressSave}");
        if (_suppressSave) { _dirtyDuringSuppress = true; return; }
        _saveTimer.Stop();
        _saveTimer.Start();
    }

    private void OnSaveTimerTick(object? sender, EventArgs e)
    {
        _saveTimer.Stop();
        _ = SaveStateNowAsync();
    }

    /// <summary>导出全部画布并连同主题/布局落盘（去重 + 重入保护）。</summary>
    private async Task SaveStateNowAsync()
    {
        KityMinderHost.Diag($"SaveStateNowAsync enter _saving={_saving} _suppressSave={_suppressSave} ready={Editor.IsReady}");
        if (_saving || _suppressSave || !Editor.IsReady || _switchingSheet) return;
        _saving = true;
        try
        {
            var json = await Editor.ExportJsonAsync();
            KityMinderHost.Diag($"SaveStateNowAsync exported={Truncate(json ?? "<null>", 300)}");
            if (json is null) return;
            if (ActiveSheet is { } cur)
            {
                cur.Content = json;
                cur.Theme = _currentTheme;
                cur.Layout = _currentLayout;
            }
            _lastSavedContent = json;
            var snapshot = BuildSheetsSnapshot();
            if (snapshot == _lastSavedSnapshot)
            {
                KityMinderHost.Diag("SaveStateNowAsync dedup skip");
                return;
            }
            _lastSavedSnapshot = snapshot;
            MindMapStateStore.Save(new MindMapState
            {
                Sheets = _sheets.Select(s => s.Clone()).ToList(),
                ActiveSheetId = _activeSheetId,
                // 旧版兼容字段同步写入：老版本/备份读取端仍能拿到当前画布内容
                Content = json,
                Theme = _currentTheme,
                Layout = _currentLayout,
            });
            KityMinderHost.Diag($"SaveStateNowAsync saved sheets={_sheets.Count} theme={_currentTheme} layout={_currentLayout}");
        }
        finally { _saving = false; }
    }

    /// <summary>全部画布的内容指纹（自动保存去重）：激活 Id + 每张的 Id/标题/主题/布局/内容。</summary>
    private string BuildSheetsSnapshot()
    {
        var sb = new StringBuilder();
        sb.Append(_activeSheetId).Append('\u0001');
        foreach (var s in _sheets)
            sb.Append(s.Id).Append('\u0002').Append(s.Title).Append('\u0002')
              .Append(s.Theme).Append('\u0002').Append(s.Layout).Append('\u0002')
              .Append(s.Content ?? "").Append('\u0001');
        return sb.ToString();
    }

    /// <summary>延迟解除恢复抑制：吸收 import 触发的 contentchange，避免误存/覆盖；期间有变更则补存。</summary>
    private async Task DelayThenClearSuppressAsync()
    {
        await Task.Delay(1200);
        _suppressSave = false;
        if (_dirtyDuringSuppress)
        {
            _dirtyDuringSuppress = false;
            _saveTimer.Stop();
            _saveTimer.Start();
        }
    }

    // ---------------- 每分钟滚动备份 ----------------

    /// <summary>按配置的间隔启动备份定时器（0=关闭）；仅面板可见时运行。</summary>
    private void StartBackupTimer()
    {
        if (!IsVisible) return;
        var minutes = Host?.MindMapBackupMinutes ?? 1;
        if (minutes <= 0)
        {
            if (_backupTimer.IsEnabled) _backupTimer.Stop();
            return;
        }
        _backupTimer.Interval = TimeSpan.FromMinutes(minutes);
        if (!_backupTimer.IsEnabled) _backupTimer.Start();
    }

    /// <summary>按配置间隔判定一次：脑图较最新备份有改动则新建备份（保留配置份数，删除最旧）。</summary>
    private async void OnBackupTimerTick(object? sender, EventArgs e) => await BackupNowAsync();

    private async Task BackupNowAsync()
    {
        if (_backupBusy || !Editor.IsReady) return;
        _backupBusy = true;
        try
        {
            await SaveStateNowAsync();   // 吸收防抖窗口内的编辑，确保内存里是最新内容
            var content = _lastSavedContent;
            if (string.IsNullOrWhiteSpace(content)) return;   // 空脑图不备份
            var dir = Host?.ResolvedMindMapBackupDir ?? MindMapBackupStore.DefaultDir;
            var max = Host?.MindMapBackupMax ?? MindMapBackupStore.DefaultMaxBackups;
            // 备份整本脑图（全部画布），旧版字段同步写入以便老版本读取
            var current = new MindMapState
            {
                Sheets = _sheets.Select(s => s.Clone()).ToList(),
                ActiveSheetId = _activeSheetId,
                Content = content,
                Theme = _currentTheme,
                Layout = _currentLayout,
            };
            var latest = MindMapBackupStore.LatestBackup(dir);
            if (latest != null && SameWorkbook(latest, current))
            {
                KityMinderHost.Diag("BackupNowAsync no change, skip");
                return;   // 与最新备份一致，无改动
            }
            MindMapBackupStore.CreateBackup(dir, current, max);
            KityMinderHost.Diag($"BackupNowAsync created backup sheets={_sheets.Count} content={Truncate(content, 200)}");
            SetStatus("已自动备份脑图（保留最近 " + max + " 份）");
        }
        finally { _backupBusy = false; }
    }

    /// <summary>两份状态是否等价：多画布逐张比对；任一侧无画布数据（旧备份）时退化为比当前画布内容。</summary>
    private static bool SameWorkbook(MindMapState a, MindMapState b)
    {
        var sa = a.Sheets ?? new List<MindMapSheetData>();
        var sb = b.Sheets ?? new List<MindMapSheetData>();
        if (sa.Count == 0 && sb.Count == 0)
            return a.Content == b.Content && a.Theme == b.Theme && a.Layout == b.Layout;
        if (sa.Count != sb.Count) return false;
        for (var i = 0; i < sa.Count; i++)
        {
            if (sa[i].Content != sb[i].Content || sa[i].Title != sb[i].Title) return false;
            if (sa[i].Theme != sb[i].Theme || sa[i].Layout != sb[i].Layout) return false;
        }
        return true;
    }

    /// <summary>宿主诊断/状态透传：落到状态栏并记日志。</summary>
    private void OnEditorStatus(object? sender, KityMinderStatusArgs e)
    {
        if (Host?.Logs is { } logs)
        {
            if (e.Warn) logs.Error("[思维导图] " + e.Message);
            else logs.Info("[思维导图] " + e.Message);
        }
        Status.Text = e.Warn ? "⚠ 异常：" + e.Message : e.Message;
    }

    /// <summary>按组件启用状态切换：启用→显示宿主控件，停用→显示占位（安装入口在占位叠层）。</summary>
    private void RefreshInstallUi()
    {
        bool on = Host?.Plugins.IsInstalled(PluginService.KityMinderId) == true;
        Editor.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        Empty.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
        Status.Text = on ? "已启用" : "未启用（点「立即启用」启用）";
        InstallStateChanged?.Invoke(this, EventArgs.Empty);
    }

    // ---------------- 装卸（启用/停用思维导图组件） ----------------

    private void OnInstallClick(object sender, RoutedEventArgs e) => Install();

    /// <summary>启用思维导图组件（浮层侧边栏与占位叠层共用）。</summary>
    public async void Install()
    {
        if (Host == null || _busy) return;
        if (Host.Plugins.IsInstalled(PluginService.KityMinderId)) { RefreshInstallUi(); return; }
        _busy = true;
        try
        {
            SetStatus("正在启用…");
            var ok = await Task.Run(Host.InstallMindMap);
            if (!ok) { SetStatus("启用失败", warn: true); return; }
            RefreshInstallUi();
        }
        finally { _busy = false; }
    }

    /// <summary>停用思维导图组件（浮层侧边栏调用）。</summary>
    public async void Uninstall()
    {
        if (Host == null || _busy) return;
        if (!Host.Plugins.IsInstalled(PluginService.KityMinderId)) { RefreshInstallUi(); return; }
        _busy = true;
        try
        {
            Editor.Visibility = Visibility.Collapsed;
            SetStatus("正在停用…");
            var ok = await Task.Run(Host.UninstallMindMap);
            if (!ok) { SetStatus("停用失败，请重试", warn: true); return; }
            RefreshInstallUi();
        }
        finally { _busy = false; }
    }

    // ---------------- 导入 / 导出 / 刷新 / 调试（委托宿主，浮层侧边栏调用） ----------------

    /// <summary>
    /// 导出（浮层侧边栏左键调用）：弹保存对话框，按用户选择的扩展名分派——
    /// .xmind 走 XMind 转换（标准 content.json + 本工具无损快照 kityminder.json，全部画布）；
    /// .json/.txt 写 kityminder JSON（多画布时写多画布包，单画布时写裸内容，兼容旧档）。
    /// </summary>
    public async void Export()
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再导出", warn: true); return; }

        // 先把编辑器现状同步进内存，避免导出的是上一次自动保存的内容
        if (ActiveSheet is { } cur && await Editor.ExportJsonAsync() is { } live)
        {
            cur.Content = live;
            cur.Theme = _currentTheme;
            cur.Layout = _currentLayout;
        }

        var dlg = new SaveFileDialog
        {
            Filter = "XMind 文件 (*.xmind)|*.xmind|思维导图 JSON (*.json)|*.json|文本文件 (*.txt)|*.txt",
            FileName = "思维导图-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".xmind",
            DefaultExt = ".xmind",
        };
        if (dlg.ShowDialog() != true) return;

        try
        {
            var ext = Path.GetExtension(dlg.FileName).ToLowerInvariant();
            if (ext == ".xmind")
            {
                XMindConverter.WriteXMind(dlg.FileName,
                    new MindMapWorkbook { Sheets = _sheets, ActiveId = _activeSheetId });
                SetStatus($"已导出 {_sheets.Count} 张画布：" + dlg.FileName);
            }
            else
            {
                var json = _sheets.Count > 1
                    ? MindMapWorkbookOps.SerializeWorkbook(new MindMapWorkbook { Sheets = _sheets, ActiveId = _activeSheetId })
                    : (ActiveSheet?.Content ?? "{}");
                await File.WriteAllTextAsync(dlg.FileName, json);
                SetStatus("已导出：" + dlg.FileName);
            }
        }
        catch (Exception ex) { SetStatus("导出失败：" + ex.Message, warn: true); }
    }

    /// <summary>按导出方式导出（浮层侧边栏「导出」右键菜单调用）。format：xmind / json / txt / png / md。</summary>
    public async void ExportAs(string format)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再导出", warn: true); return; }

        // 先把编辑器现状同步进内存，避免导出的是上一次自动保存的内容
        if (ActiveSheet is { } cur && await Editor.ExportJsonAsync() is { } live)
        {
            cur.Content = live;
            cur.Theme = _currentTheme;
            cur.Layout = _currentLayout;
        }

        try
        {
            switch (format)
            {
                case "xmind":
                {
                    var dlg = new SaveFileDialog
                    {
                        Filter = "XMind 文件 (*.xmind)|*.xmind",
                        FileName = "思维导图-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".xmind",
                        DefaultExt = ".xmind",
                    };
                    if (dlg.ShowDialog() != true) return;
                    XMindConverter.WriteXMind(dlg.FileName,
                        new MindMapWorkbook { Sheets = _sheets, ActiveId = _activeSheetId });
                    SetStatus($"已导出 {_sheets.Count} 张画布：" + dlg.FileName);
                    break;
                }
                case "json":
                {
                    var dlg = new SaveFileDialog
                    {
                        Filter = "思维导图 JSON (*.json)|*.json",
                        FileName = "思维导图-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".json",
                        DefaultExt = ".json",
                    };
                    if (dlg.ShowDialog() != true) return;
                    var json = _sheets.Count > 1
                        ? MindMapWorkbookOps.SerializeWorkbook(new MindMapWorkbook { Sheets = _sheets, ActiveId = _activeSheetId })
                        : (ActiveSheet?.Content ?? "{}");
                    await File.WriteAllTextAsync(dlg.FileName, json);
                    SetStatus("已导出：" + dlg.FileName);
                    break;
                }
                case "txt":
                {
                    var dlg = new SaveFileDialog
                    {
                        Filter = "文本文件 (*.txt)|*.txt",
                        FileName = "思维导图-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".txt",
                        DefaultExt = ".txt",
                    };
                    if (dlg.ShowDialog() != true) return;
                    var json = _sheets.Count > 1
                        ? MindMapWorkbookOps.SerializeWorkbook(new MindMapWorkbook { Sheets = _sheets, ActiveId = _activeSheetId })
                        : (ActiveSheet?.Content ?? "{}");
                    await File.WriteAllTextAsync(dlg.FileName, json);
                    SetStatus("已导出：" + dlg.FileName);
                    break;
                }
                case "png":
                {
                    var dlg = new SaveFileDialog
                    {
                        Filter = "PNG 图片 (*.png)|*.png",
                        FileName = "思维导图-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png",
                        DefaultExt = ".png",
                    };
                    if (dlg.ShowDialog() != true) return;
                    if (await Editor.CapturePngAsync(dlg.FileName))
                        SetStatus("已导出图片：" + dlg.FileName);
                    else
                        SetStatus("导出图片失败：脑图未就绪或截图出错", warn: true);
                    break;
                }
                case "md":
                {
                    var dlg = new SaveFileDialog
                    {
                        Filter = "Markdown 文件 (*.md)|*.md",
                        FileName = "思维导图-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".md",
                        DefaultExt = ".md",
                    };
                    if (dlg.ShowDialog() != true) return;
                    var md = _sheets.Count > 1
                        ? MindMapMarkdown.ToMarkdownWorkbook(_sheets)
                        : (MindMapMarkdown.ToMarkdown(ActiveSheet?.Content) ?? "# （空画布）");
                    await File.WriteAllTextAsync(dlg.FileName, md);
                    SetStatus("已导出 Markdown：" + dlg.FileName);
                    break;
                }
                default:
                    SetStatus($"未知导出方式：{format}", warn: true);
                    break;
            }
        }
        catch (Exception ex) { SetStatus("导出失败：" + ex.Message, warn: true); }
    }

    /// <summary>
    /// 导入（浮层侧边栏调用）：按扩展名分派——
    /// .xmind 走 XMind 转换（多画布原样还原，不合并）；.json 自动识别「多画布包 / 单画布内容」。
    /// </summary>
    public async void Import()
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再导入", warn: true); return; }
        var dlg = new OpenFileDialog
        {
            Filter = "思维导图文件 (*.xmind;*.json)|*.xmind;*.json|文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*",
        };
        if (dlg.ShowDialog() != true) return;

        try
        {
            var ext = Path.GetExtension(dlg.FileName).ToLowerInvariant();
            if (ext == ".xmind")
            {
                var book = XMindConverter.ReadXMind(dlg.FileName);
                if (book.Sheets.Count == 0) { SetStatus("导入失败：文件里没有可用画布", warn: true); return; }
                await ApplyWorkbookAsync(book);
                SetStatus($"已导入 {book.Sheets.Count} 张画布：" + Path.GetFileName(dlg.FileName));
                return;
            }

            var text = await File.ReadAllTextAsync(dlg.FileName);
            using var _ = JsonDocument.Parse(text); // 先校验可解析

            if (MindMapWorkbookOps.TryParseWorkbook(text) is { } wb)
            {
                await ApplyWorkbookAsync(wb);
                SetStatus($"已导入 {wb.Sheets.Count} 张画布：" + Path.GetFileName(dlg.FileName));
            }
            else
            {
                await ApplySingleContentAsync(text);
            }
        }
        catch (Exception ex) { SetStatus("导入失败：" + ex.Message, warn: true); }
    }

    /// <summary>重新加载脑图页面（浮层侧边栏调用）。</summary>
    public void Refresh() => Editor.Reload();

    /// <summary>视图-展开级别：把画布从根节点展开到指定层级（level 越大展开越深；9999=全部展开），浮层侧边栏调用。</summary>
    public void ExpandToLevel(int level)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再展开", warn: true); return; }
        _ = Editor.ExecCommandWithValueAsync("ExpandToLevel", level);
        SetStatus(level >= 9999 ? "已展开全部节点" : $"已展开到 {level} 级节点");
    }

    /// <summary>打开 WebView2 开发者控制台（浮层侧边栏调用）。</summary>
    public void OpenDevTools() => Editor.OpenDevTools();

    /// <summary>撤销上一步操作（浮层侧边栏调用；undo 走编辑器历史栈）。</summary>
    public void Undo()
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，尚无法撤销", warn: true); return; }
        _ = Editor.ExecCommandAsync("undo");
        SetStatus("已撤销");
    }

    /// <summary>重做已撤销的操作（浮层侧边栏调用；redo 走编辑器历史栈）。</summary>
    public void Redo()
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，尚无法重做", warn: true); return; }
        _ = Editor.ExecCommandAsync("redo");
        SetStatus("已重做");
    }

    /// <summary>按选中节点展开其子树到指定层数（浮层侧边栏调用）。levels=1 显示子节点；2=显示孙节点；0=全部展开；更深层收起。</summary>
    public async void ExpandSelected(int levels)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，尚无法展开", warn: true); return; }
        var ok = await Editor.ExpandSelectedToLevelAsync(levels);
        SetStatus(ok
            ? levels switch { 1 => "已展开选中节点的下一层", 2 => "已展开选中节点的下两层", _ => "已展开选中节点的全部节点" }
            : "请先选中一个节点", warn: !ok);
    }

    // ---------------- 右侧边栏：布局 / 主题切换 ----------------

    private void OnLayoutClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not StyleOption o || o.IsSelected) return;
        SelectOnly(_layouts, o.Value);
        _currentLayout = o.Value;
        _ = Editor.SetTemplateAsync(o.Value);
        SetStatus("布局：" + o.Label);
        _ = SaveStateNowAsync();
    }

    /// <summary>从内嵌资源加载布局缩略图（裁剪自编辑器 template.png 雪碧图，与 webview 外观页签模板一致）。</summary>
    private ImageSource? LoadLayoutThumb(string layoutValue)
    {
        try
        {
            var assembly = System.Reflection.Assembly.GetExecutingAssembly();
            var resourceName = $"FenPeiXiangMuZu.Assets.Layouts.layout-{layoutValue}.png";
            using var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream == null) return null;
            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.StreamSource = stream;
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.EndInit();
            bitmap.Freeze();
            return bitmap;
        }
        catch
        {
            return null;
        }
    }

    private void OnThemeClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not StyleOption o || o.IsSelected) return;
        // 自定义主题：必须先注册到内核再切换
        if (o.IsCustom && o.CustomTheme != null)
        {
            _ = SwitchCustomThemeAsync(o);
        }
        else
        {
            SelectOnly(_themes, o.Value);
            _currentTheme = o.Value;
            _ = Editor.SetThemeAsync(o.Value);
            SetStatus("主题：" + o.Label);
            _ = SaveStateNowAsync();
        }
    }

    // ---------------- 右侧边栏：外观（整理布局/清除样式/字体/字号/加粗/斜体/字体颜色） ----------------

    private void OnAppearanceClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not string cmd) return;
        if (cmd.StartsWith("valign-"))
        {
            var val = cmd.Substring("valign-".Length);
            _ = Editor.ExecCommandWithValueAsync("valign", val);
            SetStatus(val switch
            {
                "top" => "文字靠上对齐",
                "middle" => "文字垂直居中",
                "bottom" => "文字靠下对齐",
                _ => "文字对齐已设置",
            });
            return;
        }
        if (cmd.StartsWith("align-"))
        {
            var val = cmd.Substring("align-".Length);
            _ = Editor.ExecCommandWithValueAsync("textalign", val);
            SetStatus(val switch
            {
                "left" => "文字左对齐",
                "center" => "文字居中对齐",
                "right" => "文字右对齐",
                _ => "文字对齐已设置",
            });
            return;
        }
        _ = Editor.ExecCommandAsync(cmd);
        SetStatus(cmd switch
        {
            "resetlayout" => "布局已整理",
            "clearstyle" => "已清除选中节点样式",
            "bold" => "加粗已切换",
            "italic" => "斜体已切换",
            "strikethrough" => "删除线已切换",
            _ => "外观：" + cmd,
        });
    }

    // ---------------- 垂直微调（临时调试：3 层级 × 3 对齐偏移，拖动实时预览；确定位置后固化为默认并移除） ----------------
    private void OnValignOffsetChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (sender is not Slider s || s.Tag is not string tag) return;
        var parts = tag.Split('|');
        if (parts.Length != 2) return;
        var px = Math.Round(s.Value);
        s.ToolTip = $"{px} px";
        _ = Editor.ExecCommandWithValueAsync("valignoffset", new { type = parts[0], align = parts[1], px });
    }

    private async void OnValignOffsetConfirm(object sender, RoutedEventArgs e)
    {
        var ct = (int)Math.Round(VoCenterTop.Value);
        var cm = (int)Math.Round(VoCenterMid.Value);
        var cb = (int)Math.Round(VoCenterBtm.Value);
        var ht = (int)Math.Round(VoChildTop.Value);
        var hm = (int)Math.Round(VoChildMid.Value);
        var hb = (int)Math.Round(VoChildBtm.Value);
        var dt = (int)Math.Round(VoDeepTop.Value);
        var dm = (int)Math.Round(VoDeepMid.Value);
        var db = (int)Math.Round(VoDeepBtm.Value);

        var newBlock = "window.__valignOffset = {\n" +
            "                center: { top: " + ct + ", middle: " + cm + ", bottom: " + cb + " },\n" +
            "                child: { top: " + ht + ", middle: " + hm + ", bottom: " + hb + " },\n" +
            "                deep: { top: " + dt + ", middle: " + dm + ", bottom: " + db + " }\n" +
            "            };";
        var regex = new Regex(@"window\.__valignOffset\s*=\s*\{[\s\S]*?\};");

        // 运行时路径：Editor.SourcePath/dist/index.html（SourcePath 不可用时回退到数据目录）
        var runtimePath = !string.IsNullOrEmpty(Editor.SourcePath)
            ? Path.Combine(Editor.SourcePath, "dist", "index.html")
            : Path.Combine(App.DataDir, "plugins", "kityminder", "dist", "index.html");
        // 源码路径：项目根/src/KityMinderPlugin/Assets/kityminder/index.html（项目根=数据目录的上级）
        var projectRoot = Path.GetDirectoryName(App.DataDir);
        var sourcePath = projectRoot is not null
            ? Path.Combine(projectRoot, "src", "KityMinderPlugin", "Assets", "kityminder", "index.html")
            : "";

        var written = 0;
        var errors = "";
        foreach (var path in new[] { runtimePath, sourcePath })
        {
            if (string.IsNullOrEmpty(path)) continue;
            try
            {
                if (!File.Exists(path)) { errors += Path.GetFileName(path) + " 不存在；"; continue; }
                var content = File.ReadAllText(path);
                var newContent = regex.Replace(content, newBlock, 1);
                if (newContent == content) { errors += Path.GetFileName(path) + " 未找到偏移块；"; continue; }
                File.WriteAllText(path, newContent, new UTF8Encoding(false));
                written++;
            }
            catch (Exception ex) { errors += Path.GetFileName(path) + ": " + ex.Message + "；"; }
        }

        // 清除运行时 localStorage 缓存并应用新值、重渲染
        var offsetsJson = JsonSerializer.Serialize(new
        {
            center = new { top = ct, middle = cm, bottom = cb },
            child = new { top = ht, middle = hm, bottom = hb },
            deep = new { top = dt, middle = dm, bottom = db },
        });
        var js = "(function(){try{" +
            "localStorage.removeItem('km_valign_offset_v1');" +
            "window.__valignOffset=" + offsetsJson + ";" +
            "if(window.__km&&window.__km.getRoot)window.__km.getRoot().traverse(function(nd){if(nd.render)nd.render();});" +
            "}catch(e){}})();";
        await Editor.EvalAsync(js);

        var vals = $"center({ct},{cm},{cb}) child({ht},{hm},{hb}) deep({dt},{dm},{db})";
        if (written > 0)
            SetStatus($"已固化 {written} 份 index.html：{vals}" + (errors.Length > 0 ? "（部分：" + errors + "）" : ""));
        else
            SetStatus("固化失败：" + errors, warn: true);
    }

    private void OnFontChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_syncingStyle) return;   // 程序回显选中节点样式时抑制回发
        if (fontBox.SelectedValue is not string val) return;
        var name = (fontBox.SelectedItem as FontOption)?.Name ?? val;
        _ = Editor.ExecCommandWithValueAsync("fontfamily", val);
        SetStatus("字体：" + name);
    }

    private void OnSizeChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_syncingStyle) return;   // 程序回显选中节点样式时抑制回发
        if (sizeBox.SelectedItem is not int size) return;
        _ = Editor.ExecCommandWithValueAsync("fontsize", size);
        SetStatus("字号：" + size);
    }

    private void OnForeColorClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置文字颜色", warn: true); return; }
        var init = (ForeSwatch.Background as SolidColorBrush)?.Color.ToString();
        var hex = ColorPicker.Pick(Window.GetWindow(this), "设置选中节点文字颜色", init);
        if (string.IsNullOrEmpty(hex)) return;
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
        brush.Freeze();
        ForeSwatch.Background = brush;
        _ = Editor.ExecCommandWithValueAsync("forecolor", hex);
        SetStatus("文字颜色：" + hex);
    }

    // ---------------- 选中节点样式回显（NodeStyleChanged：webview 上报 → host → 这里刷新样式面板） ----------------

    /// <summary>选中节点变化/样式变化时回显样式面板：色块、数值、字体/字号选择、文字格式按钮高亮。
    /// 各键缺失表示该节点未设置对应节点级样式，保持面板现值不变（不误覆盖未设置项）。</summary>
    private void OnNodeStyleChanged(object? sender, KityMinderNodeStyleArgs e)
    {
        try
        {
            KityMinderHost.Diag("MNP.OnNodeStyleChanged enter keys=" + string.Join(",", e.Style.Keys));
            ApplyNodeStyleToPanel(e.Style);
            KityMinderHost.Diag("MNP.OnNodeStyleChanged done radius=" + RadiusBox.Text
                + " sw=" + StrokeWidthBox.Text + " lw=" + LineWidthBox.Text
                + " sizeIdx=" + sizeBox.SelectedIndex + " sizeItem=" + (sizeBox.SelectedItem?.ToString() ?? "<null>")
                + " fontIdx=" + fontBox.SelectedIndex);
        }
        catch (Exception ex)
        {
            KityMinderHost.Diag("MNP.OnNodeStyleChanged EXCEPTION " + ex.GetType().Name + ": " + ex.Message + "\n" + ex.StackTrace);
        }
    }

    private void ApplyNodeStyleToPanel(IReadOnlyDictionary<string, object?> s)
    {
        _syncingStyle = true;
        try
        {
            // 中心主题（根）没有与父节点之间的连线：禁用连线色/连线粗细/清除连线，防止误设无效样式
            _selectedIsRoot = GetBool(s, "isRoot");
            SetLineStyleEnabled(!_selectedIsRoot);

            // 附件同步：JS 始终上报 file/video 两键（无附件为空串），随选中节点同步「文件」页签展示；
            // 节点可同时挂两者，视频优先展示（无视频再回落文件）
            string? shown = null;
            if (s.TryGetValue("video", out var vv) && !string.IsNullOrWhiteSpace(vv as string)) shown = vv as string;
            if (shown is null && s.TryGetValue("file", out var fv) && !string.IsNullOrWhiteSpace(fv as string)) shown = fv as string;
            SyncFilePanelFromNode(shown ?? "");

            ApplySwatch(FillSwatch, GetStr(s, "fill"));
            ApplySwatch(StrokeSwatch, GetStr(s, "stroke"));
            ApplySwatch(LineSwatch, GetStr(s, "lineColor"));
            ApplySwatch(ForeSwatch, GetStr(s, "color"));

            if (GetNum(s, "radius") is { } radius) RadiusBox.Text = radius.ToString("0");
            if (GetNum(s, "strokeWidth") is { } sw) StrokeWidthBox.Text = sw.ToString("0");
            if (GetNum(s, "lineWidth") is { } lw) LineWidthBox.Text = lw.ToString("0");

            if (GetNum(s, "fontSize") is { } fs) SelectFontSize((int)Math.Round(fs));
            if (GetStr(s, "fontFamily") is { } fam) SelectFontFamily(fam);

            SetAppearanceHighlighter(BtnBold, GetBool(s, "bold"));
            SetAppearanceHighlighter(BtnItalic, GetBool(s, "italic"));
            SetAppearanceHighlighter(BtnStrike, GetBool(s, "strikethrough"));
            var align = GetStr(s, "textAlign");
            SetAppearanceHighlighter(BtnAlignL, align == "left");
            SetAppearanceHighlighter(BtnAlignC, align == "center");
            SetAppearanceHighlighter(BtnAlignR, align == "right");
            var valign = GetStr(s, "verticalAlign");
            SetAppearanceHighlighter(BtnValignT, valign == "top");
            SetAppearanceHighlighter(BtnValignC, valign == "middle");
            SetAppearanceHighlighter(BtnValignB, valign == "bottom");
        }
        finally { _syncingStyle = false; }
    }

    /// <summary>连线样式控件（连线色/连线粗细/清除连线）的可用性：中心主题不可设置连线样式。</summary>
    private void SetLineStyleEnabled(bool enabled)
    {
        NodeLineBtn.IsEnabled = enabled;
        LineWidthBox.IsEnabled = enabled;
        ClearLineBtn.IsEnabled = enabled;
        var tip = enabled ? "选择选中节点连线的颜色" : "中心主题没有与父节点之间的连线，不可设置连线样式";
        NodeLineBtn.ToolTip = tip;
        LineWidthBox.ToolTip = enabled ? "连线粗细（0-20，滚轮±1）" : tip;
        ClearLineBtn.ToolTip = enabled ? "清除选中节点的连线样式" : tip;
    }

    /// <summary>选中字号；不在档位时临时补进下拉并选中（同时移除上一次补的项，防止下拉无限增长）。</summary>
    private void SelectFontSize(int size)
    {
        var changed = false;
        if (_dynamicSize is { } prev && prev != size)
        {
            _sizes.Remove(prev);
            _dynamicSize = null;
            changed = true;
        }
        if (!_sizes.Contains(size))
        {
            _sizes.Add(size);
            _sizes.Sort();
            _dynamicSize = size;
            changed = true;
        }
        if (changed) sizeBox.Items.Refresh();
        sizeBox.SelectedItem = size;
    }

    /// <summary>选中字体；不在预设列表时临时补一项（节点用了列表外的字体也能正确回显/继续改）。</summary>
    private void SelectFontFamily(string family)
    {
        var match = _fonts.FirstOrDefault(f =>
            string.Equals(f.Val, family, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(f.Name, family, StringComparison.OrdinalIgnoreCase));

        var changed = false;
        if (_dynamicFont is { } dyn && !ReferenceEquals(dyn, match))
        {
            _fonts.Remove(dyn);
            _dynamicFont = null;
            changed = true;
        }
        if (match is null)
        {
            match = new FontOption(family, family);
            _fonts.Add(match);
            _dynamicFont = match;
            changed = true;
        }
        if (changed) fontBox.Items.Refresh();
        fontBox.SelectedValue = match.Val;
    }

    /// <summary>把颜色字符串应用到色块；空/无法解析则不改（保留当前值）。
    /// 兼容 #RGB / #RRGGBB / rgb() / rgba() / 颜色名（webview 上报的 CSS 颜色不保证是 hex）。</summary>
    private static void ApplySwatch(Border swatch, string? value)
    {
        if (ParseColor(value) is not { } c) return;
        var brush = new SolidColorBrush(c);
        brush.Freeze();
        swatch.Background = brush;
    }

    /// <summary>解析颜色；失败返回 null（全透明也视为无效，避免把色块刷成"看不见"）。</summary>
    private static Color? ParseColor(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var s = value.Trim();
        try
        {
            var c = (Color)ColorConverter.ConvertFromString(s);
            if (c.A != 0) return c;   // 全透明视为无有效色
        }
        catch { /* 落到下面的 rgb() 手工解析 */ }

        // rgb(r,g,b) / rgba(r,g,b,a)：WPF 的 ColorConverter 不支持，手工拆
        var open = s.IndexOf('(');
        var close = s.IndexOf(')');
        if (open > 0 && close > open && s.Substring(0, open).Trim().ToLowerInvariant() is "rgb" or "rgba")
        {
            var parts = s.Substring(open + 1, close - open - 1).Split(',');
            if (parts.Length >= 3 &&
                byte.TryParse(parts[0].Trim(), out var r) &&
                byte.TryParse(parts[1].Trim(), out var g) &&
                byte.TryParse(parts[2].Trim(), out var b))
                return Color.FromRgb(r, g, b);
        }
        return null;
    }

    private static string? GetStr(IReadOnlyDictionary<string, object?> s, string key)
    {
        if (!s.TryGetValue(key, out var v)) return null;
        return v switch
        {
            string str when str.Length > 0 => str,
            double d => d.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture),
            int i => i.ToString(),
            long l => l.ToString(),
            bool b2 => b2 ? "true" : "false",
            _ => null
        };
    }

    private static double? GetNum(IReadOnlyDictionary<string, object?> s, string key)
    {
        if (!s.TryGetValue(key, out var v)) return null;
        return v switch
        {
            double d => d,
            int i => i,
            long l => l,
            string str when double.TryParse(str, System.Globalization.NumberStyles.Float,
                                            System.Globalization.CultureInfo.InvariantCulture, out var d) => d,
            _ => null
        };
    }

    private static void SetAppearanceHighlighter(Button btn, bool active)
    {
        btn.Background = active ? _attrActiveBrush : _attrIdleBrush;
    }

    private static readonly SolidColorBrush _attrActiveBrush = FreezeBrush("#244B79");
    private static readonly SolidColorBrush _attrIdleBrush = FreezeBrush("#26262B");
    private static SolidColorBrush FreezeBrush(string hex)
    {
        var b = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
        b.Freeze();
        return b;
    }

    private static bool GetBool(IReadOnlyDictionary<string, object?> s, string key)
    {
        if (!s.TryGetValue(key, out var v)) return false;
        return v switch
        {
            bool b => b,
            string str => str is "true" or "1" or "bold" or "italic",
            double d => d != 0,
            int i => i != 0,
            _ => false
        };
    }

    // ---------------- 右侧边栏：节点样式（单独给选中节点设置填充/圆角/连线/边框，与自定义主题完全脱钩） ----------------

    /// <summary>数字输入：仅允许数字。</summary>
    private void OnIntPreviewInput(object sender, TextCompositionEventArgs e)
    {
        foreach (char c in e.Text) if (c < '0' || c > '9') { e.Handled = true; break; }
    }

    /// <summary>数字输入：Enter 提交（失焦统一应用）。</summary>
    private void OnIntKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            Keyboard.ClearFocus();
            e.Handled = true;
        }
    }

    /// <summary>节点样式整数输入（圆角/边框粗细/连线粗细）：滚轮向上 +1、向下 -1，钳制后即时应用下发。</summary>
    private void OnIntMouseWheel(object sender, MouseWheelEventArgs e)
    {
        e.Handled = true;
        if (!Editor.IsReady) return;
        var dir = e.Delta > 0 ? 1 : -1;
        if (sender == RadiusBox && ScrollInt(RadiusBox, dir, 0, 50, out var r))
            ApplyNodeStyleInt("radius", r, "节点圆角半径");
        else if (sender == StrokeWidthBox && ScrollInt(StrokeWidthBox, dir, 0, 20, out var w))
            ApplyNodeStyleInt("strokeWidth", w, "节点边框粗细");
        else if (sender == LineWidthBox && ScrollInt(LineWidthBox, dir, 0, 20, out var lw))
        {
            if (_selectedIsRoot) { SetStatus("中心主题没有与父节点之间的连线，不可设置连线样式", warn: true); return; }
            ApplyNodeStyleInt("lineWidth", lw, "节点连线粗细");
        }
    }

    /// <summary>读 TextBox 当前整数并按方向 ±1、钳制到 [min,max]，写回显示。</summary>
    private static bool ScrollInt(TextBox box, int dir, int min, int max, out int next)
    {
        next = int.TryParse(box.Text, out var v) ? v : min;
        next = Math.Clamp(next + dir, min, max);
        box.Text = next.ToString();
        return true;
    }

    /// <summary>下发并提示节点样式整数值。</summary>
    private void ApplyNodeStyleInt(string key, int val, string label)
    {
        _ = Editor.SetNodeStyleAsync(new Dictionary<string, object?> { { key, val } });
        SetStatus($"{label}：{val}");
    }

    /// <summary>字号：滚轮在可选字号档位间切换（10/12/16/18/24/32/48）。</summary>
    private void OnSizeMouseWheel(object sender, MouseWheelEventArgs e)
    {
        e.Handled = true;
        if (sizeBox.Items is not IList items || items.Count == 0) return;
        var idx = sizeBox.SelectedIndex < 0 ? 0 : sizeBox.SelectedIndex;
        idx = Math.Clamp(idx + (e.Delta > 0 ? 1 : -1), 0, items.Count - 1);
        if (idx != sizeBox.SelectedIndex) sizeBox.SelectedIndex = idx;
    }

    /// <summary>选择并应用选中节点的填充色。</summary>
    private void OnNodeFillClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置填充色", warn: true); return; }
        var init = (FillSwatch.Background as SolidColorBrush)?.Color.ToString();
        var hex = ColorPicker.Pick(Window.GetWindow(this), "设置选中节点填充色", init);
        if (string.IsNullOrEmpty(hex)) return;
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
        brush.Freeze();
        FillSwatch.Background = brush;
        _ = Editor.SetNodeStyleAsync(new Dictionary<string, object?> { { "fill", hex } });
        SetStatus("节点填充色：" + hex);
    }

    /// <summary>选择并应用选中节点的连线颜色。</summary>
    private void OnNodeLineClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置连线颜色", warn: true); return; }
        if (_selectedIsRoot) { SetStatus("中心主题没有与父节点之间的连线，不可设置连线样式", warn: true); return; }
        var init = (LineSwatch.Background as SolidColorBrush)?.Color.ToString();
        var hex = ColorPicker.Pick(Window.GetWindow(this), "设置选中节点连线颜色", init);
        if (string.IsNullOrEmpty(hex)) return;
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
        brush.Freeze();
        LineSwatch.Background = brush;
        _ = Editor.SetNodeStyleAsync(new Dictionary<string, object?> { { "lineColor", hex } });
        SetStatus("节点连线颜色：" + hex);
    }

    /// <summary>选择并应用选中节点的边框颜色。</summary>
    private void OnNodeStrokeClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，稍后再设置边框颜色", warn: true); return; }
        var init = (StrokeSwatch.Background as SolidColorBrush)?.Color.ToString();
        var hex = ColorPicker.Pick(Window.GetWindow(this), "设置选中节点边框颜色", init);
        if (string.IsNullOrEmpty(hex)) return;
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
        brush.Freeze();
        StrokeSwatch.Background = brush;
        _ = Editor.SetNodeStyleAsync(new Dictionary<string, object?> { { "stroke", hex } });
        SetStatus("节点边框颜色：" + hex);
    }

    /// <summary>圆角失焦：应用选中节点圆角半径。</summary>
    private void OnRadiusLostFocus(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) return;
        var radius = int.TryParse(RadiusBox.Text, out var r) ? Math.Clamp(r, 0, 50) : 0;
        RadiusBox.Text = radius.ToString();
        _ = Editor.SetNodeStyleAsync(new Dictionary<string, object?> { { "radius", radius } });
        SetStatus("节点圆角半径：" + radius);
    }

    /// <summary>连线粗细失焦：应用选中节点连线粗细。</summary>
    private void OnLineWidthLostFocus(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) return;
        if (_selectedIsRoot) return;
        var width = int.TryParse(LineWidthBox.Text, out var w) ? Math.Clamp(w, 0, 20) : 1;
        LineWidthBox.Text = width.ToString();
        _ = Editor.SetNodeStyleAsync(new Dictionary<string, object?> { { "lineWidth", width } });
        SetStatus("节点连线粗细：" + width);
    }

    /// <summary>边框粗细失焦：应用选中节点边框粗细。</summary>
    private void OnStrokeWidthLostFocus(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) return;
        var width = int.TryParse(StrokeWidthBox.Text, out var w) ? Math.Clamp(w, 0, 20) : 1;
        StrokeWidthBox.Text = width.ToString();
        _ = Editor.SetNodeStyleAsync(new Dictionary<string, object?> { { "strokeWidth", width } });
        SetStatus("节点边框粗细：" + width);
    }

    /// <summary>按主题清除选中节点样式（按钮 Tag：text/node/border/line）。</summary>
    private void OnClearScopeClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not string scope) return;
        if (!Editor.IsReady) { SetStatus("脑图未就绪，尚无法清除", warn: true); return; }
        if (scope == "line" && _selectedIsRoot) { SetStatus("中心主题没有与父节点之间的连线，无需清除连线样式", warn: true); return; }
        _ = Editor.ClearNodeStyleScopeAsync(scope);
        SetStatus(scope switch
        {
            "text" => "已清除选中节点文字样式",
            "node" => "已清除选中节点填充/圆角",
            "border" => "已清除选中节点边框样式",
            "line" => "已清除选中节点连线样式",
            _ => "已清除选中节点样式",
        });
    }

    /// <summary>清除选中节点的全部节点级样式（填充/边框/圆角/连线）。</summary>
    private void OnClearAllStyleClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，尚无法清除", warn: true); return; }
        _ = Editor.SetNodeStyleAsync(new Dictionary<string, object?>
        {
            { "fill", null }, { "stroke", null }, { "strokeWidth", 0 },
            { "radius", null }, { "lineColor", null }, { "lineWidth", 0 }
        });
        FillSwatch.Background = Brushes.Black;
        StrokeSwatch.Background = Brushes.Black;
        LineSwatch.Background = Brushes.Black;
        RadiusBox.Text = "0";
        StrokeWidthBox.Text = "1";
        LineWidthBox.Text = "1";
        SetStatus("已清除选中节点全部样式");
    }

    /// <summary>复制选中节点（首个）的全部节点级样式到内存剪贴板。</summary>
    private void OnCopyStyleClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，尚无法复制", warn: true); return; }
        _ = Editor.CopyNodeStyleAsync();
        SetStatus("已复制选中节点样式");
    }

    /// <summary>把内存剪贴板中的节点样式粘贴到当前选中节点。</summary>
    private void OnPasteStyleClick(object sender, RoutedEventArgs e)
    {
        if (!Editor.IsReady) { SetStatus("脑图未就绪，尚无法粘贴", warn: true); return; }
        _ = Editor.PasteNodeStyleAsync();
        SetStatus("已粘贴样式到选中节点");
    }

    /// <summary>「删除」按钮：删除当前选中的自定义主题（内置不可删），先弹窗确认。</summary>
    private void OnDeleteThemeClick(object sender, RoutedEventArgs e)
    {
        var cur = _themes.FirstOrDefault(t => t.IsSelected);
        if (cur == null || !cur.IsCustom)
        {
            SetStatus("请先选中一个自定义主题再删除", warn: true);
            return;
        }
        var ok = ConfirmDialog.Show(Window.GetWindow(this), "删除主题",
            $"确定删除自定义主题「{cur.Label}」？删除后不可恢复。", "删除", danger: true);
        if (!ok) return;
        // 删除的是当前正在使用的主题：先切回默认主题并落盘，避免重载后指向已删除主题
        SelectOnly(_themes, "fresh-blue");
        _currentTheme = "fresh-blue";
        _ = Editor.SetThemeAsync("fresh-blue");
        PersistTheme("fresh-blue");
        MindMapThemeStore.Remove(cur.Value);
        BuildSidebar();
        SetStatus($"已删除自定义主题：{cur.Label}");
        // 刷新画布：reload 不改变内容，只是让它重新注册所有自定义主题
        if (Editor.IsReady) Editor.Reload();
    }

    /// <summary>把当前主题写入状态库（保留内容与布局，仅改主题），供删除正在使用的主题后重载恢复。</summary>
    private static void PersistTheme(string theme)
    {
        var state = MindMapStateStore.Load() ?? new MindMapState();
        state.Theme = theme;
        MindMapStateStore.Save(state);
    }

    private string GetCurrentSelectedTheme()
    {
        foreach (var it in _themes) if (it.IsSelected) return it.Value;
        return "fresh-blue";
    }

    /// <summary>「＋ 新建」按钮：打开新建主题面板，起点复制当前选中主题。</summary>
    private void OnNewThemeClick(object sender, RoutedEventArgs e)
    {
        // 复制当前选中主题配色为起点
        MindMapThemePalette? seed = null;
        foreach (var it in _themes)
        {
            if (!it.IsSelected) continue;
            if (it.IsCustom && it.CustomTheme != null)
                seed = it.CustomTheme.Palette;
            else
            {
                // 内置主题：找对应原始数据，按结构映射到 palette
                var n = it.Value;
                // 按新鲜主题映射（只取核心键）
                // fresh-blue: h=204, HSL → hex (#8AB3E9 取 R)
                seed = new MindMapThemePalette
                {
                    Background = "#FBFBFB",
                    ConnectColor = GetFreshHex(n),
                    ConnectWidth = 2,
                    RootBackground = GetFreshHex(n),
                    RootFontSize = 16,
                    MainBackground = GetFreshHexLighter(n),
                    MainFontSize = 14,
                    SubBackground = "#FFFFFF",
                    SubFontSize = 12,
                    TextColor = "#000000",
                    SelectedColor = GetFreshHex(n),
                };
            }
            break;
        }
        var dlg = new NewMindMapThemeDialog(seed);
        dlg.Owner = Window.GetWindow(this);
        if (dlg.ShowDialog() == true && dlg.Result is { } newTheme)
        {
            MindMapThemeStore.Upsert(newTheme);
            BuildSidebar();
            SetStatus($"已新建自定义主题：{newTheme.Name}");
            // 立即切到新主题（已注册）
            var so = _themes.FirstOrDefault(t => t.Value == newTheme.Id);
            if (so != null)
                _ = SwitchCustomThemeAsync(so);
            // 不需要 reload，切新主题时自动注册
        }
    }

    /// <summary>「编辑」按钮：编辑当前选中的自定义主题（复用新建面板，保留 Id 覆盖更新）。</summary>
    private void OnEditThemeClick(object sender, RoutedEventArgs e)
    {
        var cur = _themes.FirstOrDefault(t => t.IsSelected);
        if (cur == null || !cur.IsCustom || cur.CustomTheme == null)
        {
            SetStatus("请先选中一个自定义主题再编辑", warn: true);
            return;
        }
        var dlg = new NewMindMapThemeDialog(ClonePalette(cur.CustomTheme.Palette), cur.CustomTheme);
        dlg.Owner = Window.GetWindow(this);
        if (dlg.ShowDialog() == true && dlg.Result is { } updated)
        {
            MindMapThemeStore.Upsert(updated);
            BuildSidebar();
            SetStatus($"已编辑自定义主题：{updated.Name}");
            var so = _themes.FirstOrDefault(t => t.Value == updated.Id);
            if (so != null)
                _ = SwitchCustomThemeAsync(so);
        }
    }

    /// <summary>「导出」按钮：导出当前选中的自定义主题为 JSON 文件。</summary>
    private void OnExportThemeClick(object sender, RoutedEventArgs e)
    {
        var cur = _themes.FirstOrDefault(t => t.IsSelected);
        if (cur == null || !cur.IsCustom || cur.CustomTheme == null)
        {
            SetStatus("请先选中一个自定义主题再导出", warn: true);
            return;
        }
        var dlg = new SaveFileDialog
        {
            Filter = "思维导图主题|*.json|所有文件|*.*",
            FileName = "主题-" + SanitizeFileName(cur.Label) + ".json",
        };
        if (dlg.ShowDialog() != true) return;
        try
        {
            var json = JsonSerializer.Serialize(cur.CustomTheme, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(dlg.FileName, json);
            SetStatus($"已导出主题：{cur.Label}");
        }
        catch (Exception ex) { SetStatus("导出主题失败：" + ex.Message, warn: true); }
    }

    /// <summary>「导入」按钮：从 JSON 文件导入自定义主题（重新生成 Id，避免覆盖现有主题）。</summary>
    private void OnImportThemeClick(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog { Filter = "思维导图主题|*.json|所有文件|*.*" };
        if (dlg.ShowDialog() != true) return;
        try
        {
            var jsonText = File.ReadAllText(dlg.FileName);
            var imported = JsonSerializer.Deserialize<MindMapTheme>(jsonText,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (imported == null || string.IsNullOrWhiteSpace(imported.Name) || imported.Palette == null)
            {
                SetStatus("导入主题失败：文件格式不符", warn: true);
                return;
            }
            imported.Id = "custom-" + Guid.NewGuid().ToString("N")[..8];
            MindMapThemeStore.Upsert(imported);
            BuildSidebar();
            SetStatus($"已导入自定义主题：{imported.Name}");
        }
        catch (Exception ex) { SetStatus("导入主题失败：" + ex.Message, warn: true); }
    }

    /// <summary>文件名安全化：剔除路径非法字符（用于导出默认文件名）。</summary>
    private static string SanitizeFileName(string name)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        return string.IsNullOrWhiteSpace(name) ? "未命名" : name;
    }

    private static MindMapThemePalette ClonePalette(MindMapThemePalette s) => new()
    {
        Background = s.Background,
        ConnectColor = s.ConnectColor,
        ConnectWidth = s.ConnectWidth,
        RootBackground = s.RootBackground,
        RootFontSize = s.RootFontSize,
        MainBackground = s.MainBackground,
        MainFontSize = s.MainFontSize,
        SubBackground = s.SubBackground,
        SubFontSize = s.SubFontSize,
        TextColor = s.TextColor,
        SelectedColor = s.SelectedColor,
        RootStroke = s.RootStroke,
        RootStrokeWidth = s.RootStrokeWidth,
        RootRadius = s.RootRadius,
        MainStroke = s.MainStroke,
        MainStrokeWidth = s.MainStrokeWidth,
        MainRadius = s.MainRadius,
        SubStroke = s.SubStroke,
        SubStrokeWidth = s.SubStrokeWidth,
        SubRadius = s.SubRadius,
    };

    /// <summary>新鲜主题按色调名取色值（hex）。</summary>
    private static string GetFreshHex(string name) => name switch
    {
        "red" => "#D65A5A", "green" => "#6EB36A", "blue" => "#4A86D1", "soil" => "#B08040",
        "purple" => "#9A6FC8", "pink" => "#E08AA8", _ => "#4A86D1"
    };

    private static string GetFreshHexLighter(string name) => name switch
    {
        "red" => "#F9E5E5", "green" => "#EDF7ED", "blue" => "#DCE9F7", "soil" => "#F5EEDC",
        "purple" => "#F1E9F8", "pink" => "#F9E5EE", _ => "#DCE9F7"
    };

    /// <summary>右侧边栏选项项（布局或主题），支持选中态高亮；自定义主题需附加元数据。</summary>
    private sealed class StyleOption : INotifyPropertyChanged
    {
        public StyleOption(string value, string label, Brush? brush = null, Brush? rootBrush = null,
            Brush? mainBrush = null, Brush? subBrush = null, bool isCustom = false)
        { Value = value; Label = label; Brush = brush; RootBrush = rootBrush; MainBrush = mainBrush; SubBrush = subBrush; IsCustom = isCustom; }

        public string Value { get; }
        public string Label { get; }
        /// <summary>主题整图背景色（色块左半圆）。</summary>
        public Brush? Brush { get; }
        /// <summary>主题中央节点色（色块右上 1/4 圆）。</summary>
        public Brush? RootBrush { get; }
        /// <summary>主题二级节点色（色块右下 1/8 圆）。</summary>
        public Brush? MainBrush { get; }
        /// <summary>主题子节点色（色块右下 1/8 圆）。</summary>
        public Brush? SubBrush { get; }
        public bool IsCustom { get; }
        public MindMapTheme? CustomTheme { get; set; }
        /// <summary>布局缩略图（裁剪自编辑器 template.png 雪碧图，与 webview 外观页签模板一致）。</summary>
        public ImageSource? Thumb { get; init; }

        private bool _isSelected;
        public bool IsSelected
        {
            get => _isSelected;
            set
            {
                if (_isSelected == value) return;
                _isSelected = value;
                PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsSelected)));
            }
        }

        public event PropertyChangedEventHandler? PropertyChanged;
    }

    /// <summary>字体选项（下拉显示名 + 传给 kityminder fontfamily 命令的 CSS 字体族值）。</summary>
    private sealed record FontOption(string Name, string Val);

    private void SetStatus(string text, bool warn = false)
    {
        Status.Text = warn ? "⚠ " + text : text;
        if (warn && Host?.Logs is { } logs) logs.Error("[思维导图] " + text);
    }

    private static string Truncate(string? s, int n) => s is null ? "<null>" : (s.Length <= n ? s : s[..n] + "…");
}