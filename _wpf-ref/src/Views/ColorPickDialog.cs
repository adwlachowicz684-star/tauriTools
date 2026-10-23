using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.Views;

/// <summary>「修改颜色」弹窗返回：最终选定颜色（#RRGGBB；null=恢复默认外观）。</summary>
public sealed record ColorPickResult(string? Hex);

/// <summary>
/// 标签改色色盘面板（非模态常驻）：SV 饱和度/明度面板 + Hue 色相条，拖动中实时预览、松开即落盘；
/// RGB 三通道输入；常用色（预设 16 色 + 用户自定义可增删）；「恢复默认」清除自定义标签色。
/// 离散动作（点选色块/输入/吸管/恢复默认）与拖动结束即时落盘到当前选中卡片；
/// 主面板点选其他卡片时经 SyncToTarget 切换应用目标。
/// 纯 code-behind 无 XAML（与 IconPickDialog 同构）。
/// </summary>
public sealed class ColorPickDialog : Window
{
    /// <summary>预设常用色：24 色铺满两行（每行 12 格 @ 当前窗宽），覆盖常用色相环 + 明暗层次（不可删）。</summary>
    private static readonly string[] PresetColors =
    {
        "#E5484D", "#D9A441", "#F5A623", "#B7C94A",
        "#46A758", "#2FAE9B", "#12A594", "#0091FF",
        "#3E63DD", "#6E56CF", "#8E4EC6", "#BF4AC8",
        "#D6409F", "#E93D82", "#FF6B35", "#FFD23F",
        "#8FD14F", "#00C2A8", "#4098D7", "#5B5BD6",
        "#9D34DA", "#F472B6", "#B4B9C2", "#7C8698",
    };

    private const int MaxCustomColors = 24;

    private readonly List<string> _customColors;
    private readonly Action<string?> _onLiveChange;
    private readonly Action<string?> _onApply;
    private readonly Action<List<string>> _onSaveCustomColors;
    private readonly Action? _onCancel;

    /// <summary>标题栏文本（面板常驻期间经 SyncToTarget 随主面板选中卡片同步更新）。</summary>
    private readonly TextBlock _titleTb;

    // HSV 当前状态（h:0-360，s/v:0-1）
    private double _h = 212, _s = 0.55, _v = 0.72;
    private bool _updating;          // 防止 RGB 输入 ↔ 色盘刷新互相触发递归
    private string? _currentColor;   // 当前生效色（null=已选「恢复默认」）
    private Window? _pickerOverlay;  // 吸管取色覆盖层（取色中非 null，防重入）

    private readonly Rectangle _svBase = new() { RadiusX = 5, RadiusY = 5 };
    private readonly Rectangle _svShade = new()
    {
        RadiusX = 5,
        RadiusY = 5,
        Fill = new LinearGradientBrush(Colors.Transparent, Color.FromRgb(0, 0, 0), 90),
    };
    private readonly Ellipse _svCursor = new()
    {
        Width = 12,
        Height = 12,
        StrokeThickness = 2,
        Stroke = Brushes.White,
        Fill = Brushes.Transparent,
        IsHitTestVisible = false,
        Effect = new DropShadowEffect { Color = Colors.Black, BlurRadius = 3, ShadowDepth = 0, Opacity = 0.6 },
    };
    private readonly Rectangle _hueBar = new() { RadiusX = 3, RadiusY = 3 };
    private readonly Border _hueCursor = new()
    {
        Height = 4,
        BorderBrush = Brushes.White,
        BorderThickness = new Thickness(0, 1, 0, 1),
        CornerRadius = new CornerRadius(1),
        IsHitTestVisible = false,
        Effect = new DropShadowEffect { Color = Colors.Black, BlurRadius = 2, ShadowDepth = 0, Opacity = 0.6 },
    };
    // SV 面板宽度自适应（星位列），与弹窗主要内容等宽；色相条固定宽贴右
    private readonly Grid _svGrid = new() { Height = 176, HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly Grid _hueGrid = new() { Width = 16 };
    private readonly Border _previewBlock = new()
    {
        Width = 38,
        Height = 26,
        CornerRadius = new CornerRadius(4),
        BorderBrush = (Brush)Application.Current.FindResource("NeuBezel"),
        BorderThickness = new Thickness(1),
    };
    private readonly TextBox _tbR = MakeChannelBox();
    private readonly TextBox _tbG = MakeChannelBox();
    private readonly TextBox _tbB = MakeChannelBox();
    private readonly TextBlock _hexText = new()
    {
        Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
        FontSize = 12,
        VerticalAlignment = VerticalAlignment.Center,
        Margin = new Thickness(8, 0, 0, 0),
    };
    private readonly WrapPanel _presetHost = new() { Margin = new Thickness(0, 4, 0, 0) };
    private readonly ContentControl _customSlot = new();
    private readonly TextBlock _hint = new()
    {
        Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
        FontSize = 11,
        Margin = new Thickness(0, 8, 0, 0),
        Visibility = Visibility.Hidden,
    };

    /// <param name="initialHex">初始颜色（#RRGGBB）；null=该标签当前为默认外观。</param>
    /// <param name="onLiveChange">拖动/输入过程中的实时回调（hex 或 null），用于主窗口即时预览（不落盘）。</param>
    /// <param name="onApply">离散动作与拖动结束时的落盘回调（hex 或 null=恢复默认外观）。</param>
    /// <param name="onSaveCustomColors">用户增删自定义常用色时的整表落盘回调。</param>
    public ColorPickDialog(string title, string? initialHex,
        IReadOnlyList<string> customColors,
        Action<string?> onLiveChange,
        Action<string?> onApply,
        Action<List<string>> onSaveCustomColors,
        string? hint = null,
        Action? onCancel = null)
    {
        _customColors = customColors
            .Where(c => !string.IsNullOrWhiteSpace(c))
            .Select(c => c.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        _onLiveChange = onLiveChange;
        _onApply = onApply;
        _onSaveCustomColors = onSaveCustomColors;
        _onCancel = onCancel;

        Title = title;
        Width = 430;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;

        // 标题栏文本提前构建：面板常驻期间 SyncToTarget 需要同步更新它
        _titleTb = new TextBlock
        {
            Text = Title,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 0, 0),
        };

        // 初始状态：有初始色则解析，否则保持默认蓝灰；_currentColor 即当前选中卡片的现状
        if (ParseBrush(initialHex) is SolidColorBrush b)
            RgbToHsv(b.Color.R, b.Color.G, b.Color.B, out _h, out _s, out _v);
        _currentColor = ValidHex(initialHex);
        _hexText.Text = _currentColor ?? "默认外观";

        Content = BuildUi();

        foreach (var hex in PresetColors)
            _presetHost.Children.Add(MakePresetSwatch(hex));
        RebuildCustomSwatches();
        HookChannelEvents();
        RefreshAll();

        // 布局完成后光标才有可用尺寸，需再定位一次
        _svGrid.SizeChanged += (_, _) => PositionSvCursor();
        _hueGrid.SizeChanged += (_, _) => PositionHueCursor();

        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) { _onCancel?.Invoke(); Close(); e.Handled = true; }
        };

        ShowHint(hint ?? "修改即时生效并保存到当前选中项；在主面板点选其他卡片可切换目标。");
    }

    // ---------------- UI 构建 ----------------

    private FrameworkElement BuildUi()
    {
        var muted = (Brush)Application.Current.FindResource("MutedBrush");

        // ---- 标题栏（_titleTb 已在构造函数创建，便于 SyncToTarget 同步更新）----
        var closeBtn = new Button { Content = "\uE8BB", ToolTip = "关闭" };
        closeBtn.Style = (Style)Application.Current.FindResource("IconBtn");
        closeBtn.Width = 32;
        closeBtn.Height = 32;
        closeBtn.Click += (_, _) => { _onCancel?.Invoke(); Close(); };
        var titleBar = new Grid { Background = Brushes.Transparent, Height = 34 };
        titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(_titleTb, 0);
        Grid.SetColumn(closeBtn, 1);
        titleBar.Children.Add(_titleTb);
        titleBar.Children.Add(closeBtn);
        titleBar.MouseLeftButtonDown += (_, _) => { try { DragMove(); } catch { } };

        var titleBarHost = new Border
        {
            Background = (Brush)Application.Current.FindResource("BarBrush"),
            CornerRadius = new CornerRadius(8, 8, 0, 0),
            Child = titleBar,
        };

        // ---- SV 面板 + Hue 条（背景不透明参与命中测试，空白区也可按下取色）----
        var hueRainbow = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(0, 1) };
        foreach (var (offset, hex) in new[]
        {
            (0.0, "#FF0000"), (1.0 / 6, "#FFFF00"), (2.0 / 6, "#00FF00"), (0.5, "#00FFFF"),
            (4.0 / 6, "#0000FF"), (5.0 / 6, "#FF00FF"), (1.0, "#FF0000"),
        })
            hueRainbow.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString(hex), offset));
        _hueBar.Fill = hueRainbow;

        _svGrid.Background = Brushes.Transparent;
        _svGrid.Cursor = Cursors.Cross;
        _svGrid.Children.Add(_svBase);
        _svGrid.Children.Add(_svShade);
        var svCanvas = new Canvas { IsHitTestVisible = false };
        svCanvas.Children.Add(_svCursor);
        _svGrid.Children.Add(svCanvas);
        AttachDragHandlers(_svGrid, isHue: false);

        _hueGrid.Background = Brushes.Transparent;
        _hueGrid.Cursor = Cursors.Cross;
        _hueGrid.Margin = new Thickness(10, 0, 0, 0);
        _hueGrid.Children.Add(_hueBar);
        var hueCanvas = new Canvas { IsHitTestVisible = false };
        hueCanvas.Children.Add(_hueCursor);
        _hueGrid.Children.Add(hueCanvas);
        AttachDragHandlers(_hueGrid, isHue: true);

        // SV 面板占满剩余宽度（星位列），色相条固定宽贴右——两者总宽与主要内容一致；
        // 左右各留 4px 呼吸边距，避免取色面板贴死弹窗内缘
        var pickerRow = new Grid { Margin = new Thickness(4, 0, 4, 0) };
        pickerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        pickerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(_svGrid, 0);
        Grid.SetColumn(_hueGrid, 1);
        pickerRow.Children.Add(_svGrid);
        pickerRow.Children.Add(_hueGrid);

        // ---- 预览块 + RGB 输入 + HEX（整行宽度全部让给数据显示）----
        var rgbRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0) };
        _previewBlock.VerticalAlignment = VerticalAlignment.Center;
        rgbRow.Children.Add(_previewBlock);
        rgbRow.Children.Add(ChannelLabel("R", 14));
        rgbRow.Children.Add(_tbR);
        rgbRow.Children.Add(ChannelLabel("G", 10));
        rgbRow.Children.Add(_tbG);
        rgbRow.Children.Add(ChannelLabel("B", 10));
        rgbRow.Children.Add(_tbB);
        rgbRow.Children.Add(_hexText);

        var restoreDefaultBtn = new Button
        {
            Content = "恢复默认",
            ToolTip = "清除该标签的自定义颜色，还原默认外观",
            VerticalAlignment = VerticalAlignment.Center,
        };
        restoreDefaultBtn.Style = (Style)Application.Current.FindResource("MiniGhost");
        restoreDefaultBtn.Click += (_, _) => RestoreDefault();

        // 左侧动作组：吸管 + 恢复默认（相邻小按钮 6px，美术标准七）
        var eyedropperBtn = new Button
        {
            Content = "吸管",
            ToolTip = "吸取屏幕任意位置的颜色（含其他窗口与桌面）\n取色中：单击确认，右键 / Esc 取消",
            VerticalAlignment = VerticalAlignment.Center,
        };
        eyedropperBtn.Style = (Style)Application.Current.FindResource("MiniGhost");
        eyedropperBtn.Click += (_, _) => StartEyedropper();

        // ---- 常用色 ----
        var swatchesPanel = new StackPanel();
        swatchesPanel.Children.Add(Caption("常用色（单击应用）", topMargin: 14));
        swatchesPanel.Children.Add(_presetHost);
        swatchesPanel.Children.Add(Caption("我的常用色（悬浮显示删除）", topMargin: 10));
        swatchesPanel.Children.Add(_customSlot);

        // ---- 底部按钮行：左=动作（吸管/存为常用/恢复默认），右=确认（改动即时生效并保存）----
        var leftActions = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        leftActions.Children.Add(eyedropperBtn);

        var saveCustomBtn = new Button
        {
            Content = "存为常用",
            ToolTip = $"把当前颜色保存到我的常用色（最多 {MaxCustomColors} 个）",
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(6, 0, 0, 0),
        };
        saveCustomBtn.Style = (Style)Application.Current.FindResource("MiniGhost");
        saveCustomBtn.Click += (_, _) => SaveCurrentAsCustom();
        leftActions.Children.Add(saveCustomBtn);

        restoreDefaultBtn.Margin = new Thickness(6, 0, 0, 0);
        leftActions.Children.Add(restoreDefaultBtn);

        var closeAllBtn = new Button { Content = "确认", MinWidth = 76 };
        closeAllBtn.Style = (Style)Application.Current.FindResource("MiniGhost");
        closeAllBtn.Click += (_, _) => Close();

        var btnRow = new Grid { Margin = new Thickness(0, 14, 0, 0) };
        btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(leftActions, 0);
        Grid.SetColumn(closeAllBtn, 2);
        btnRow.Children.Add(leftActions);
        btnRow.Children.Add(closeAllBtn);

        var body = new StackPanel { Margin = new Thickness(12, 10, 12, 12) };
        body.Children.Add(pickerRow);
        body.Children.Add(rgbRow);
        body.Children.Add(swatchesPanel);
        body.Children.Add(_hint);
        body.Children.Add(btnRow);

        var innerGrid = new Grid();
        innerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        innerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetRow(titleBarHost, 0);
        Grid.SetRow(body, 1);
        innerGrid.Children.Add(titleBarHost);
        innerGrid.Children.Add(body);

        var frame = new Border
        {
            Background = (Brush)Application.Current.FindResource("NeuSurface"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezel"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Effect = (Effect)Application.Current.FindResource("NeuShadow"),
            Child = innerGrid,
        };

        return new Grid { Margin = new Thickness(12), Children = { frame } };
    }

    private static TextBlock ChannelLabel(string text, double leftMargin) => new()
    {
        Text = text,
        Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
        FontSize = 12,
        VerticalAlignment = VerticalAlignment.Center,
        Margin = new Thickness(leftMargin, 0, 4, 0),
    };

    private static TextBox MakeChannelBox() => new()
    {
        Width = 42,
        Height = 24,
        FontSize = 12,
        Padding = new Thickness(3, 0, 0, 0),
        VerticalAlignment = VerticalAlignment.Center,   // 与预览块/标签/按钮同一视觉中轴
        VerticalContentAlignment = VerticalAlignment.Center,
        Background = (Brush)Application.Current.FindResource("NeuInset"),
        Foreground = (Brush)Application.Current.FindResource("MainBrush"),
        BorderBrush = (Brush)Application.Current.FindResource("NeuBezelPress"),
        CaretBrush = (Brush)Application.Current.FindResource("AccentBrush"),
    };

    private static TextBlock Caption(string text, double topMargin = 0) => new()
    {
        Text = text,
        Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
        FontSize = 11,
        Margin = new Thickness(0, topMargin, 0, 0),
    };

    // ---------------- 拖动取色 ----------------

    private void AttachDragHandlers(FrameworkElement fe, bool isHue)
    {
        fe.Tag = isHue;
        fe.PreviewMouseLeftButtonDown += OnPaletteDown;
        fe.PreviewMouseMove += OnPaletteMove;
        fe.PreviewMouseLeftButtonUp += OnPaletteUp;
    }

    private void OnPaletteDown(object sender, MouseButtonEventArgs e)
    {
        if (sender is not FrameworkElement fe) return;
        fe.CaptureMouse();
        UpdateFromPointer(fe);
        e.Handled = true;
    }

    private void OnPaletteMove(object sender, MouseEventArgs e)
    {
        if (sender is not FrameworkElement fe) return;
        if (e.LeftButton != MouseButtonState.Pressed || !fe.IsMouseCaptured) return;
        UpdateFromPointer(fe);
        e.Handled = true;
    }

    private void OnPaletteUp(object sender, MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement fe && fe.IsMouseCaptured)
        {
            fe.ReleaseMouseCapture();
            CommitCurrent();   // 拖动中仅预览，松开才把最终颜色落盘
            e.Handled = true;
        }
    }

    /// <summary>按指针位置换算 HSV 并应用（Tag=true 为色相条，false 为 SV 面板）。</summary>
    private void UpdateFromPointer(FrameworkElement fe)
    {
        var p = Mouse.GetPosition(fe);
        double w = Math.Max(1, fe.ActualWidth), hgt = Math.Max(1, fe.ActualHeight);
        var fx = Math.Clamp(p.X / w, 0, 1);
        var fy = Math.Clamp(p.Y / hgt, 0, 1);
        if (fe.Tag is true)
        {
            _h = fy * 360;
        }
        else
        {
            _s = fx;
            _v = 1 - fy;
        }
        HsvToRgb(_h, _s, _v, out var r, out var g, out var b);
        ApplyColor(r, g, b);
    }

    // ---------------- 吸管（屏幕任意位置取色） ----------------

    /// <summary>
    /// 进入全屏取色：本弹窗以 Opacity=0 隐藏（保持模态身份，见 E006），置顶覆盖层铺满虚拟屏；
    /// 光标旁跟随「色块 + R/G/B/HEX」读数条——DispatcherTimer 33ms 单点采样驱动，
    /// 无放大镜图像管线（WriteableBitmap 方案在部分环境渲染异常且事件路由不稳）。
    /// 单击确认吸取（GDI GetPixel 直读桌面像素，其他窗口/桌面均可）、右键或 Esc 取消。
    /// </summary>
    private void StartEyedropper()
    {
        if (_pickerOverlay != null) return;

        var swatch = new Border
        {
            Width = 20,
            Height = 20,
            CornerRadius = new CornerRadius(3),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezel"),
            BorderThickness = new Thickness(1),
        };
        var readout = new TextBlock
        {
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(6, 0, 0, 0),
            Text = "--",
        };
        var chipRow = new StackPanel { Orientation = Orientation.Horizontal };
        chipRow.Children.Add(swatch);
        chipRow.Children.Add(readout);

        var chip = new Border
        {
            Background = (Brush)Application.Current.FindResource("NeuSurface"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezelHi"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(5),
            Padding = new Thickness(7, 4, 9, 4),
            Child = chipRow,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Top,
        };
        var translate = new TranslateTransform();
        chip.RenderTransform = translate;

        var hint = new TextBlock
        {
            Text = "单击吸取颜色 · 右键或 Esc 取消",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 12,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 12, 0, 0),
        };

        // 覆盖层底必须真透明才能透出屏幕。两个关键约束：
        // ① 必须分层真透明（AllowsTransparency=true）——普通窗口的逐像素 α 在部分环境被当不透明渲染成整屏黑；
        // ② 分层窗口的 OS 级命中测试按像素 alpha 判定，纯 Transparent（α=0）区域会整体点击穿透，
        //    故底刷用 α=1 近不可见黑：视觉不可见、整面可接收单击（WPF 内部 Transparent 命中规则管不到系统层）。
        var root = new Grid { Background = new SolidColorBrush(Color.FromArgb(1, 0x00, 0x00, 0x00)) };
        root.Children.Add(hint);
        root.Children.Add(chip);

        var overlay = new Window
        {
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ResizeMode = ResizeMode.NoResize,
            ShowInTaskbar = false,
            Topmost = true,
            Cursor = Cursors.Cross,
            WindowStartupLocation = WindowStartupLocation.Manual,
            Content = root,
        };
        // 绑定宿主生命周期：色盘弹窗关闭时覆盖层随之关闭，避免孤儿置顶层常驻
        overlay.Owner = this;
        overlay.Left = SystemParameters.VirtualScreenLeft;
        overlay.Top = SystemParameters.VirtualScreenTop;
        overlay.Width = SystemParameters.VirtualScreenWidth;
        overlay.Height = SystemParameters.VirtualScreenHeight;
        _pickerOverlay = overlay;

        double dpiX = 96, dpiY = 96;
        var ticks = 0;

        /// <summary>单点采样并刷新读数条；定位=光标物理像素经 DPI 换算回覆盖层坐标，贴边翻转。</summary>
        void UpdateChip()
        {
            var cur = ScreenColorService.CursorPosition();
            if (cur == null) return;
            var (cx, cy) = cur.Value;
            var c = ScreenColorService.PixelAtPhysical(cx, cy);
            if (c.HasValue)
            {
                swatch.Background = new SolidColorBrush(c.Value);
                readout.Text = $"R{c.Value.R} G{c.Value.G} B{c.Value.B}   #{c.Value.R:X2}{c.Value.G:X2}{c.Value.B:X2}";
            }
            ticks++;

            var lx = cx / (dpiX / 96.0) - SystemParameters.VirtualScreenLeft;
            var ly = cy / (dpiY / 96.0) - SystemParameters.VirtualScreenTop;
            var cw = chip.ActualWidth <= 0 ? 160 : chip.ActualWidth;
            var ch = chip.ActualHeight <= 0 ? 30 : chip.ActualHeight;
            var x = lx + 18;
            if (x + cw > overlay.ActualWidth - 8) x = lx - cw - 18;
            var y = ly + 18;
            if (y + ch > overlay.ActualHeight - 8) y = ly - ch - 18;
            translate.X = Math.Max(4, x);
            translate.Y = Math.Max(28, y);   // 顶部避开提示条
        }

        void Finish(Color? picked)
        {
            if (_pickerOverlay == null) return;
            _pickerOverlay = null;
            overlay.Close();
            this.Opacity = 1;
            this.IsHitTestVisible = true;
            this.Activate();
            try
            {
                System.IO.File.AppendAllText(
                    System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fpx_pick_diag.txt"),
                    $"{DateTime.Now:HH:mm:ss.fff} CLOSE ticks={ticks} picked={(picked?.ToString() ?? "cancel")}\n");
            }
            catch { }
            if (picked.HasValue)
            {
                // 先同步 HSV 再应用：否则预览块/RGB 框仍按旧 HSV 推算出旧色，
                // 与实际存储的新色不一致，也无法直接「存为常用」
                RgbToHsv(picked.Value.R, picked.Value.G, picked.Value.B, out _h, out _s, out _v);
                ApplyColor(picked.Value.R, picked.Value.G, picked.Value.B);
                CommitCurrent();   // 吸管确认属离散动作，即改即存
            }
        }

        overlay.Loaded += (_, _) =>
        {
            var dpi = VisualTreeHelper.GetDpi(overlay);
            dpiX = dpi.PixelsPerInchX;
            dpiY = dpi.PixelsPerInchY;
            UpdateChip();

            // 定时器驱动刷新（33ms）：与鼠标事件路由解耦，保证读数条始终跟手
            var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(33) };
            timer.Tick += (_, _) =>
            {
                if (_pickerOverlay == null) { timer.Stop(); return; }
                UpdateChip();
            };
            timer.Start();
        };
        overlay.PreviewMouseLeftButtonDown += (_, e) =>
        {
            var cur = ScreenColorService.CursorPosition();
            Finish(cur != null ? ScreenColorService.PixelAtPhysical(cur.Value.X, cur.Value.Y) : null);
            e.Handled = true;
        };
        overlay.PreviewMouseRightButtonDown += (_, e) => { Finish(null); e.Handled = true; };
        overlay.PreviewKeyDown += (_, e) => { if (e.Key == Key.Escape) { Finish(null); e.Handled = true; } };

        // 隐藏自身避免吸到弹窗底色。不能用 Hide()/Show()——模态对话框经 Show 后会被降级为
        // 普通窗口，之后设置 DialogResult 抛 InvalidOperationException（E006）。
        this.Opacity = 0;
        this.IsHitTestVisible = false;
        overlay.Show();
    }

    // ---------------- 状态应用与刷新 ----------------

    private void ApplyColor(byte r, byte g, byte b)
    {
        _currentColor = $"#{r:X2}{g:X2}{b:X2}";
        RefreshAll();
        SafeLiveChange(_currentColor);
    }

    private void RestoreDefault()
    {
        _currentColor = null;
        RefreshAll();
        CommitCurrent();   // 提交 null=恢复默认外观（离散动作即改即存）
        ShowHint("已恢复默认外观。");
    }

    private void SaveCurrentAsCustom()
    {
        if (_currentColor == null)
        {
            ShowHint("当前是默认外观，没有可保存的颜色。");
            return;
        }
        HideHint();
        if (_customColors.All(c => !string.Equals(c, _currentColor, StringComparison.OrdinalIgnoreCase)))
        {
            _customColors.Add(_currentColor);
            while (_customColors.Count > MaxCustomColors) _customColors.RemoveAt(0);
            RebuildCustomSwatches();
        }
        try { _onSaveCustomColors(_customColors); }
        catch (Exception ex) { ShowHint($"保存常用色失败：{ex.Message}"); }
    }

    /// <summary>离散动作/拖动结束：把当前颜色落盘到当前选中卡片（null=恢复默认外观）。</summary>
    private void CommitCurrent() => SafeApply(_onApply, _currentColor);

    /// <summary>SafeLiveChange 的落盘版：回调异常不阻塞取色操作，仅提示失败信息。</summary>
    private void SafeApply(Action<string?> callback, string? hex)
    {
        try { callback(hex); }
        catch (Exception ex) { ShowHint($"应用颜色失败：{ex.Message}"); }
    }

    /// <summary>主面板选中的卡片变化时同步目标：更新标题并把界面状态重置为新卡片颜色。
    /// 仅重置本地状态与提示，绝不触发 onLiveChange/onApply 回调（新卡片的颜色不受影响）。</summary>
    public void SyncToTarget(string title, string? hex)
    {
        _titleTb.Text = title;
        Title = title;
        if (ParseBrush(hex) is SolidColorBrush b)
            RgbToHsv(b.Color.R, b.Color.G, b.Color.B, out _h, out _s, out _v);
        else
        {
            _h = 212; _s = 0.55; _v = 0.72;   // 与构造初值一致的默认蓝灰
        }
        _currentColor = ValidHex(hex);
        _hexText.Text = _currentColor ?? "默认外观";
        RefreshAll();
        ShowHint("已切换到当前选中的卡片，后续修改将应用到它。");
    }

    private void SafeLiveChange(string? hex)
    {
        try { _onLiveChange(hex); } catch { /* 主窗口预览失败不阻塞取色 */ }
    }

    private void ShowHint(string text)
    {
        _hint.Text = text;
        _hint.Visibility = Visibility.Visible;
    }

    private void HideHint() => _hint.Visibility = Visibility.Hidden;

    private static string? ValidHex(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex)) return null;
        var s = hex.Trim();
        return ParseBrush(s) != null ? s.ToUpperInvariant() : null;
    }

    /// <summary>标签默认外观的实际底色（取全局 NeuSurface 画刷；资源缺失时回退当前主题值）。</summary>
    private static Color DefaultTagColor()
    {
        if (Application.Current?.TryFindResource("NeuSurface") is SolidColorBrush sb) return sb.Color;
        return Color.FromRgb(0x2B, 0x2F, 0x38);
    }

    private static SolidColorBrush? ParseBrush(string? hex)
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

    /// <summary>全量刷新：SV 底色渐变、光标位置、预览块、RGB 输入、十六进制文本。</summary>
    private void RefreshAll()
    {
        _updating = true;
        try
        {
            HsvToRgb(_h, 1, 1, out var hr, out var hg, out var hb);
            _svBase.Fill = new LinearGradientBrush(
                new GradientStopCollection { new(Colors.White, 0), new(Color.FromRgb(hr, hg, hb), 1) }, 0);

            if (_currentColor == null)
            {
                // 恢复默认：预览与 RGB 显示当前默认外观的实际颜色（标签默认底色 NeuSurface），
                // 并同步 HSV 光标位置——用户可直接在默认色基础上拖动/输入微调。
                var dc = DefaultTagColor();
                RgbToHsv(dc.R, dc.G, dc.B, out _h, out _s, out _v);
                _previewBlock.Background = new SolidColorBrush(dc);
                _tbR.Text = dc.R.ToString();
                _tbG.Text = dc.G.ToString();
                _tbB.Text = dc.B.ToString();
                _hexText.Text = $"#{dc.R:X2}{dc.G:X2}{dc.B:X2}（默认）";
            }
            else
            {
                HsvToRgb(_h, _s, _v, out var r, out var g, out var b);
                _previewBlock.Background = new SolidColorBrush(Color.FromRgb(r, g, b));
                _tbR.Text = r.ToString();
                _tbG.Text = g.ToString();
                _tbB.Text = b.ToString();
                _hexText.Text = _currentColor;
                HideHint();
            }
        }
        finally
        {
            _updating = false;
        }
        PositionSvCursor();
        PositionHueCursor();
    }

    private void PositionSvCursor()
    {
        var w = Math.Max(0, _svGrid.ActualWidth);
        var hgt = Math.Max(0, _svGrid.ActualHeight);
        if (_svCursor.Parent is Canvas c)
        {
            Canvas.SetLeft(_svCursor, w * _s - _svCursor.Width / 2);
            Canvas.SetTop(_svCursor, hgt * (1 - _v) - _svCursor.Height / 2);
        }
    }

    private void PositionHueCursor()
    {
        var hgt = Math.Max(0, _hueGrid.ActualHeight);
        _hueCursor.Width = Math.Max(0, _hueGrid.ActualWidth);
        if (_hueCursor.Parent is Canvas c)
            Canvas.SetTop(_hueCursor, hgt * Math.Clamp(_h / 360, 0, 1) - _hueCursor.Height / 2);
    }

    private void HookChannelEvents()
    {
        TextChangedHandler(_tbR);
        TextChangedHandler(_tbG);
        TextChangedHandler(_tbB);

        void TextChangedHandler(TextBox tb) =>
            tb.TextChanged += (_, _) =>
            {
                if (_updating) return;
                if (!TryParseByte(_tbR.Text, out var r) ||
                    !TryParseByte(_tbG.Text, out var g) ||
                    !TryParseByte(_tbB.Text, out var b)) return;
                RgbToHsv(r, g, b, out _h, out _s, out _v);
                ApplyColor(r, g, b);
                CommitCurrent();   // 有效输入属离散动作，即改即存
            };
    }

    private static bool TryParseByte(string? s, out byte v)
    {
        v = 0;
        if (!int.TryParse(s?.Trim(), out var n) || n < 0 || n > 255) return false;
        v = (byte)n;
        return true;
    }

    // ---------------- 常用色格子 ----------------

    /// <summary>预设色块：单击应用该颜色。</summary>
    private FrameworkElement MakePresetSwatch(string hex) => MakeSwatchCore(hex);

    /// <summary>通用色块：3:2 矩形（30×20）、描边、ToolTip、单击取色；右/下 1px 边距提供色块间隙。</summary>
    private Border MakeSwatchCore(string hex)
    {
        var brush = ParseBrush(hex)!;
        var border = new Border
        {
            Width = 30,
            Height = 20,
            Margin = new Thickness(0, 0, 1, 1),
            CornerRadius = new CornerRadius(4),
            Background = brush,
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezel"),
            BorderThickness = new Thickness(1),
            Cursor = Cursors.Hand,
            ToolTip = hex.ToUpperInvariant(),
        };
        border.MouseLeftButtonUp += (_, _) =>
        {
            RgbToHsv(brush.Color.R, brush.Color.G, brush.Color.B, out _h, out _s, out _v);
            ApplyColor(brush.Color.R, brush.Color.G, brush.Color.B);
            CommitCurrent();   // 点选色块属离散动作，即改即存
        };
        return border;
    }

    private void RebuildCustomSwatches()
    {
        var wrap = new WrapPanel();
        if (_customColors.Count == 0)
        {
            wrap.Children.Add(new TextBlock
            {
                Text = "（暂无，点「存为常用」保存当前颜色）",
                Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
                FontSize = 11,
                Margin = new Thickness(0, 4, 0, 0),
            });
        }
        else
        {
            foreach (var hex in _customColors)
            {
                if (ParseBrush(hex) == null) continue;   // 跳过配置中可能被手工写入的非法色值，避免 NRE
                wrap.Children.Add(MakeCustomSwatchCell(hex));
            }
        }
        _customSlot.Content = wrap;
    }

    /// <summary>自定义色格：悬浮显示右上角删除小按钮。规范九——显隐用 Hidden 占位，禁 Collapsed，防布局抖动。</summary>
    private FrameworkElement MakeCustomSwatchCell(string hex)
    {
        var cell = new Grid
        {
            Width = 34,
            Height = 24,
            Background = Brushes.Transparent,   // rules.md 一：透明也要参与命中测试，否则移向按钮途中触发 MouseLeave
        };
        var swatch = MakeSwatchCore(hex);
        swatch.Margin = new Thickness(2);
        cell.Children.Add(swatch);

        var del = new Button
        {
            Content = "\uE711",
            FontSize = 10,
            FontFamily = new FontFamily("Segoe MDL2 Assets"),
            Width = 16,
            Height = 16,
            Padding = new Thickness(0),
            Visibility = Visibility.Hidden,
            ToolTip = "删除该常用色",
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Cursor = Cursors.Hand,
        };
        del.Style = (Style)Application.Current.FindResource("IconBtn");
        del.Click += (_, _) =>
        {
            _customColors.RemoveAll(c => string.Equals(c, hex, StringComparison.OrdinalIgnoreCase));
            RebuildCustomSwatches();
            try { _onSaveCustomColors(_customColors); }
            catch (Exception ex) { ShowHint($"删除常用色失败：{ex.Message}"); }
        };
        cell.Children.Add(del);
        cell.MouseEnter += (_, _) => del.Visibility = Visibility.Visible;
        cell.MouseLeave += (_, _) => del.Visibility = Visibility.Hidden;
        return cell;
    }

    // ---------------- HSV / RGB 转换 ----------------

    private static void RgbToHsv(byte r, byte g, byte b, out double h, out double s, out double v)
    {
        var rr = r / 255.0;
        var gg = g / 255.0;
        var bb = b / 255.0;
        var max = Math.Max(rr, Math.Max(gg, bb));
        var min = Math.Min(rr, Math.Min(gg, bb));
        var d = max - min;
        v = max;
        s = max <= 0 ? 0 : d / max;
        if (d <= 0) { h = 0; return; }
        h = (rr, gg, bb) switch
        {
            var (a, _, _) when a == max => ((gg - bb) / d + (gg < bb ? 6 : 0)),
            var (_, a, _) when a == max => ((bb - rr) / d + 2),
            _ => ((rr - gg) / d + 4),
        } * 60;
    }

    private static void HsvToRgb(double h, double s, double v, out byte r, out byte g, out byte b)
    {
        h = ((h % 360) + 360) % 360;
        var c = v * s;
        var x = c * (1 - Math.Abs(h / 60 % 2 - 1));
        var m = v - c;
        (double rr, double gg, double bb) = (h / 60) switch
        {
            < 1 => (c, x, 0.0),
            < 2 => (x, c, 0.0),
            < 3 => (0.0, c, x),
            < 4 => (0.0, x, c),
            < 5 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        r = (byte)Math.Round((rr + m) * 255);
        g = (byte)Math.Round((gg + m) * 255);
        b = (byte)Math.Round((bb + m) * 255);
    }

}
