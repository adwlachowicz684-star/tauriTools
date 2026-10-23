using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 「新建主题」面板：填写名称 + 配色 + 连线粗细 + 三种节点字号 + 三种节点边框（颜色/粗细/圆角），
/// 配色点色块弹取色器（<see cref="ColorPicker.Pick"/>），确定后返回 <see cref="Result"/>。
/// 纯 code-behind 无 XAML（与 ColorPickDialog 同构），复用全局样式。
/// </summary>
public sealed class NewMindMapThemeDialog : Window
{
    private readonly MindMapThemePalette _p;
    private readonly string? _editId;
    private readonly TextBox _nameBox = new();
    private readonly TextBox _connectWidth = MakeIntBox();
    private readonly TextBox _rootFont = MakeIntBox();
    private readonly TextBox _mainFont = MakeIntBox();
    private readonly TextBox _subFont = MakeIntBox();
    private readonly TextBox _rootStrokeWidth = MakeIntBox();
    private readonly TextBox _rootRadius = MakeIntBox();
    private readonly TextBox _mainStrokeWidth = MakeIntBox();
    private readonly TextBox _mainRadius = MakeIntBox();
    private readonly TextBox _subStrokeWidth = MakeIntBox();
    private readonly TextBox _subRadius = MakeIntBox();
    private readonly TextBox _rootSpace = MakeIntBox();
    private readonly TextBox _mainSpace = MakeIntBox();
    private readonly TextBox _subSpace = MakeIntBox();
    private readonly TextBox _mainMargin = MakeIntBox();
    private readonly TextBox _subMargin = MakeIntBox();

    /// <summary>确定后返回的新主题；取消则为 null。</summary>
    public MindMapTheme? Result { get; private set; }

    /// <param name="seed">初始配色（复制当前选中主题为起点）；null 用默认。</param>
    /// <param name="edit">编辑模式：传入现有主题则预填名称并在保存时保留其 Id（覆盖更新）；null 为新建。</param>
    public NewMindMapThemeDialog(MindMapThemePalette? seed, MindMapTheme? edit = null)
    {
        _p = seed == null ? new MindMapThemePalette() : ClonePalette(seed);
        _editId = edit?.Id;

        Title = edit == null ? "新建主题" : "修改主题";
        Width = 560;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Content = BuildUi();

        PreviewKeyDown += (_, e) => { if (e.Key == Key.Escape) { Close(); e.Handled = true; } };
        Loaded += (_, _) =>
        {
            if (edit != null) _nameBox.Text = edit.Name;
            _nameBox.Focus(); _nameBox.SelectAll();
        };
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
        RootSpace = s.RootSpace,
        MainSpace = s.MainSpace,
        SubSpace = s.SubSpace,
        MainMargin = s.MainMargin,
        SubMargin = s.SubMargin,
    };

    // ---------------- UI ----------------

    private FrameworkElement BuildUi()
    {
        var muted = (Brush)Application.Current.FindResource("MutedBrush");
        var main = (Brush)Application.Current.FindResource("MainBrush");

        // 标题栏
        var title = new TextBlock
        {
            Text = Title,
            Foreground = main,
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 0, 0),
        };
        var closeBtn = new Button { Content = "\uE8BB", ToolTip = "关闭" };
        closeBtn.Style = (Style)Application.Current.FindResource("IconBtn");
        closeBtn.Width = 32; closeBtn.Height = 32;
        closeBtn.Click += (_, _) => Close();
        var titleGrid = new Grid { Background = Brushes.Transparent, Height = 34 };
        titleGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        titleGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(title, 0); Grid.SetColumn(closeBtn, 1);
        titleGrid.Children.Add(title); titleGrid.Children.Add(closeBtn);
        titleGrid.MouseLeftButtonDown += (_, _) => { try { DragMove(); } catch { } };
        var titleHost = new Border
        {
            Background = (Brush)Application.Current.FindResource("BarBrush"),
            CornerRadius = new CornerRadius(8, 8, 0, 0),
            Child = titleGrid,
        };

        // 名称
        _nameBox.Margin = new Thickness(8, 0, 0, 0);
        _nameBox.HorizontalAlignment = HorizontalAlignment.Stretch;
        _nameBox.Height = 26;
        _nameBox.FontSize = 13;
        _nameBox.Padding = new Thickness(6, 0, 0, 0);
        _nameBox.VerticalContentAlignment = VerticalAlignment.Center;
        _nameBox.Background = (Brush)Application.Current.FindResource("NeuInset");
        _nameBox.Foreground = (Brush)Application.Current.FindResource("MainBrush");
        _nameBox.BorderBrush = (Brush)Application.Current.FindResource("NeuBezelPress");
        _nameBox.CaretBrush = (Brush)Application.Current.FindResource("AccentBrush");
        var nameRow = MakeLabeledRow("主题名称", _nameBox);

        // 调色字段
        var content = new StackPanel();
        content.Children.Add(nameRow);
        content.Children.Add(MakeColorField("整图背景", () => _p.Background, v => _p.Background = v, topMargin: 14));
        content.Children.Add(MakeColorField2("连线", () => _p.ConnectColor, v => _p.ConnectColor = v,
            "粗细", _connectWidth, () => _p.ConnectWidth, v => _p.ConnectWidth = v));
        content.Children.Add(MakeColorField2("中央节点", () => _p.RootBackground, v => _p.RootBackground = v,
            "字号", _rootFont, () => _p.RootFontSize, v => _p.RootFontSize = v));
        content.Children.Add(MakeColorField2("二级节点", () => _p.MainBackground, v => _p.MainBackground = v,
            "字号", _mainFont, () => _p.MainFontSize, v => _p.MainFontSize = v));
        content.Children.Add(MakeColorField2("子级节点", () => _p.SubBackground, v => _p.SubBackground = v,
            "字号", _subFont, () => _p.SubFontSize, v => _p.SubFontSize = v));
        content.Children.Add(MakeColorField("节点文字", () => _p.TextColor, v => _p.TextColor = v));
        content.Children.Add(MakeColorField("选中高亮", () => _p.SelectedColor, v => _p.SelectedColor = v));
        content.Children.Add(MakeSectionHeader("边框"));
        content.Children.Add(MakeColorField3("中央节点边框", () => _p.RootStroke, v => _p.RootStroke = v,
            "粗细", _rootStrokeWidth, () => _p.RootStrokeWidth, v => _p.RootStrokeWidth = v,
            "圆角", _rootRadius, () => _p.RootRadius, v => _p.RootRadius = v, topMargin: 2));
        content.Children.Add(MakeColorField3("二级节点边框", () => _p.MainStroke, v => _p.MainStroke = v,
            "粗细", _mainStrokeWidth, () => _p.MainStrokeWidth, v => _p.MainStrokeWidth = v,
            "圆角", _mainRadius, () => _p.MainRadius, v => _p.MainRadius = v));
        content.Children.Add(MakeColorField3("子级节点边框", () => _p.SubStroke, v => _p.SubStroke = v,
            "粗细", _subStrokeWidth, () => _p.SubStrokeWidth, v => _p.SubStrokeWidth = v,
            "圆角", _subRadius, () => _p.SubRadius, v => _p.SubRadius = v));
        content.Children.Add(MakeSectionHeader("布局间距"));
        content.Children.Add(MakeNumRow("一级分支间距", _rootSpace, topMargin: 2));
        content.Children.Add(MakeNumRow("二级分支间距", _mainSpace));
        content.Children.Add(MakeNumRow("子级节点间距", _subSpace));
        content.Children.Add(MakeNumRow("父子左右间距", _mainMargin));
        content.Children.Add(MakeNumRow("子级相对间距", _subMargin));

        // 底部按钮
        var saveBtn = new Button
        {
            Content = "保存主题",
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Center,
            Height = 32,
        };
        saveBtn.Style = (Style)Application.Current.FindResource("MiniGhost");
        saveBtn.Click += (_, _) => Save();
        var cancelBtn = new Button
        {
            Content = "取消",
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Center,
            Height = 32,
        };
        cancelBtn.Style = (Style)Application.Current.FindResource("MiniGhost");
        cancelBtn.Click += (_, _) => Close();
        var btnRow = new Grid { Margin = new Thickness(0, 16, 0, 0) };
        btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(12) });
        btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Grid.SetColumn(saveBtn, 0); Grid.SetColumn(cancelBtn, 2);
        btnRow.Children.Add(saveBtn); btnRow.Children.Add(cancelBtn);
        content.Children.Add(btnRow);

        var body = new StackPanel { Margin = new Thickness(14, 8, 14, 14) };
        body.Children.Add(content);

        var innerGrid = new Grid();
        innerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        innerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetRow(titleHost, 0); Grid.SetRow(body, 1);
        innerGrid.Children.Add(titleHost); innerGrid.Children.Add(body);

        // 底板：与 ColorPickDialog 同构——NeuSurface 不透明底 + NeuBezel 边框 + 圆角 + 阴影，
        // 避免分层透明窗口中间透出后面内容
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

    /// <summary>标签 + 色块 的行。</summary>
    private static FrameworkElement MakeColorField(string label, Func<string> get, Action<string> set, double topMargin = 0)
        => MakeColorRow(label, MakeSwatch(get, set), null, topMargin);

    /// <summary>标签 + 色块 + 附加数值（线宽/字号）行。</summary>
    private static FrameworkElement MakeColorField2(
        string label, Func<string> get, Action<string> set,
        string intLabel, TextBox box, Func<int> getInt, Action<int> setInt, double topMargin = 0)
    {
        var group = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        group.Children.Add(MakeSmallLabel(intLabel));
        box.Width = 46; box.HorizontalAlignment = HorizontalAlignment.Right;
        box.Margin = new Thickness(0, 0, 10, 0);
        group.Children.Add(box);
        return MakeColorRow(label, MakeSwatch(get, set), group, topMargin);
    }

    /// <summary>标签 + 色块 + 两个附加数值（边框粗细/圆角）行。</summary>
    private static FrameworkElement MakeColorField3(
        string label, Func<string> get, Action<string> set,
        string intLabel1, TextBox box1, Func<int> getInt1, Action<int> setInt1,
        string intLabel2, TextBox box2, Func<int> getInt2, Action<int> setInt2, double topMargin = 0)
    {
        var group = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        group.Children.Add(MakeSmallLabel(intLabel1));
        box1.Width = 46; box1.HorizontalAlignment = HorizontalAlignment.Right;
        group.Children.Add(box1);
        group.Children.Add(MakeSmallLabel(intLabel2));
        box2.Width = 46; box2.HorizontalAlignment = HorizontalAlignment.Right;
        box2.Margin = new Thickness(0, 0, 10, 0);
        group.Children.Add(box2);
        return MakeColorRow(label, MakeSwatch(get, set), group, topMargin);
    }

    /// <summary>分区小标题（灰字，与侧栏 SegmentTitle 同风格）。</summary>
    private static TextBlock MakeSectionHeader(string text) => new()
    {
        Text = text,
        Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
        FontSize = 11,
        Margin = new Thickness(0, 16, 0, 4),
    };

    /// <summary>小号灰色前置标签。</summary>
    private static TextBlock MakeSmallLabel(string text) => new()
    {
        Text = text,
        Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
        FontSize = 11,
        VerticalAlignment = VerticalAlignment.Center,
        Margin = new Thickness(8, 0, 4, 0),
    };

    /// <summary>一行：左侧标签 + 右侧内容（色块或输入框）。返回 Grid（列 0 标签 / 列1＊ / 列2 附属）。</summary>
    private static Grid MakeLabeledRow(string label, FrameworkElement right, double topMargin = 0)
    {
        var lb = new TextBlock
        {
            Text = label,
            FontSize = 13,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        var row = new Grid { Margin = new Thickness(0, topMargin, 0, 0) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(lb, 0); Grid.SetColumn(right, 1);
        row.Children.Add(lb); row.Children.Add(right);
        return row;
    }

    /// <summary>三栏行：左标签（固定宽）+ 中色块（固定宽）+ 右辅助（右对齐）。所有行色块落在同一垂直列，上下对齐。</summary>
    private static Grid MakeColorRow(string label, FrameworkElement swatch, FrameworkElement? aux, double topMargin = 0)
    {
        var lb = new TextBlock
        {
            Text = label,
            FontSize = 13,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            VerticalAlignment = VerticalAlignment.Center,
            Width = 92,
        };
        var row = new Grid { Margin = new Thickness(0, topMargin, 0, 0) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(92) });                    // 列0 标签（容纳「二级节点边框」等6字）
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(187) });                   // 列1 色块（+75 容纳右移）
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });  // 列2 辅助
        Grid.SetColumn(lb, 0); Grid.SetColumn(swatch, 1);
        row.Children.Add(lb); row.Children.Add(swatch);
        if (aux != null)
        {
            aux.HorizontalAlignment = HorizontalAlignment.Right;
            Grid.SetColumn(aux, 2);
            row.Children.Add(aux);
        }
        return row;
    }

    /// <summary>布局间距行：左标签（92px 对齐）+ 右侧数值框。与调色行同列宽，视觉统一。</summary>
    private static Grid MakeNumRow(string label, TextBox box, double topMargin = 0)
    {
        var lb = new TextBlock
        {
            Text = label,
            FontSize = 13,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            VerticalAlignment = VerticalAlignment.Center,
            Width = 92,
        };
        var row = new Grid { Margin = new Thickness(0, topMargin, 0, 0) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(92) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(60) });
        Grid.SetColumn(lb, 0); Grid.SetColumn(box, 2);
        box.Width = 46;   // 固定宽度，与其他数值框一致，不随文字变化
        box.HorizontalAlignment = HorizontalAlignment.Right;
        box.Margin = new Thickness(0, 0, 10, 0);
        row.Children.Add(lb); row.Children.Add(box);
        return row;
    }

    /// <summary>色块：显示当前色，点击弹取色器并回填（与 ColorPickDialog 同构的 Border 结构）。</summary>
    private static Border MakeSwatch(Func<string> get, Action<string> set)
    {
        var border = new Border
        {
            Width = 108,
            Height = 24,
            // 右移 75px：色块列内边距 + 保持色块左对齐，所有行统一右移对齐
            Margin = new Thickness(75, 0, 0, 0),
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Center,
            CornerRadius = new CornerRadius(4),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezel"),
            BorderThickness = new Thickness(1),
            Cursor = Cursors.Hand,
            ToolTip = "点击弹出色盘选色",
        };
        UpdateSwatch(border, get());
        // 取色采用非模态弹窗 + 回调回填；无需保存动作，选色即生效到本字段
        border.MouseLeftButtonUp += (_, _) =>
        {
            var hex = ColorPicker.Pick(Window.GetWindow(border), "选取颜色", get());
            if (!string.IsNullOrWhiteSpace(hex)) { set(hex); UpdateSwatch(border, hex); }
        };
        return border;
    }

    private static void UpdateSwatch(Border b, string hex)
    {
        try { b.Background = (Brush)new BrushConverter().ConvertFromString(hex)!; }
        catch { b.Background = Brushes.Transparent; }
    }

    private static TextBox MakeIntBox()
    {
        var tb = new TextBox
        {
            VerticalAlignment = VerticalAlignment.Center,
            TextAlignment = TextAlignment.Center,
            Height = 24,
            FontSize = 12,
            Padding = new Thickness(3, 0, 0, 0),
            VerticalContentAlignment = VerticalAlignment.Center,
            Background = (Brush)Application.Current.FindResource("NeuInset"),
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezelPress"),
            CaretBrush = (Brush)Application.Current.FindResource("AccentBrush"),
        };
        tb.PreviewTextInput += (_, e) =>
        {
            foreach (char c in e.Text) if (c < '0' || c > '9') { e.Handled = true; break; }
        };
        return tb;
    }

    // ---------------- 确认 ----------------

    private void Save()
    {
        var name = _nameBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            _nameBox.Focus();
            return;
        }
        // 附加数值：容错解析并 clamp，非法用当前内置值
        _p.ConnectWidth = ClampNum(_connectWidth.Text, _p.ConnectWidth, 1, 8);
        _p.RootFontSize = ClampNum(_rootFont.Text, _p.RootFontSize, 9, 40);
        _p.MainFontSize = ClampNum(_mainFont.Text, _p.MainFontSize, 9, 40);
        _p.SubFontSize = ClampNum(_subFont.Text, _p.SubFontSize, 9, 40);
        _p.RootStrokeWidth = ClampNum(_rootStrokeWidth.Text, _p.RootStrokeWidth, 0, 8);
        _p.RootRadius = ClampNum(_rootRadius.Text, _p.RootRadius, 0, 20);
        _p.MainStrokeWidth = ClampNum(_mainStrokeWidth.Text, _p.MainStrokeWidth, 0, 8);
        _p.MainRadius = ClampNum(_mainRadius.Text, _p.MainRadius, 0, 20);
        _p.SubStrokeWidth = ClampNum(_subStrokeWidth.Text, _p.SubStrokeWidth, 0, 8);
        _p.SubRadius = ClampNum(_subRadius.Text, _p.SubRadius, 0, 20);
        _p.RootSpace = ClampNum(_rootSpace.Text, _p.RootSpace, 0, 60);
        _p.MainSpace = ClampNum(_mainSpace.Text, _p.MainSpace, 0, 60);
        _p.SubSpace = ClampNum(_subSpace.Text, _p.SubSpace, 0, 60);
        _p.MainMargin = ClampNum(_mainMargin.Text, _p.MainMargin, 0, 120);
        _p.SubMargin = ClampNum(_subMargin.Text, _p.SubMargin, 0, 120);

        Result = new MindMapTheme
        {
            Id = _editId ?? "custom-" + Guid.NewGuid().ToString("N")[..8],
            Name = name.Length > 24 ? name[..24] : name,
            Palette = _p,
        };
        DialogResult = true;
    }

    private static int ClampNum(string text, int fallback, int min, int max)
        => int.TryParse(text, out var v) ? Math.Clamp(v, min, max) : fallback;
}