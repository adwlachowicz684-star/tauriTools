using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;

namespace FenPeiXiangMuZu.Views;

/// <summary>编辑弹窗返回的结果：各字段原始输入 + 点前缀/置顶开关。</summary>
public sealed record LinkAgentEditResult(string Name, string Vendor, string Remark, bool Pinned, bool PrependDot);

/// <summary>
/// 链接名编辑对话框（纯代码构建，深色新拟物风格）：文件夹名 + 前置点 + 置顶 + 文件名（厂商）+ 备注。
/// 确定前调用 validate(rawName, prependDot) 校验，返回错误文案则留在弹窗内提示、不关闭。
/// </summary>
public sealed class LinkAgentEditDialog : Window
{
    private readonly TextBox _nameBox;
    private readonly TextBox _vendorBox;
    private readonly TextBox _remarkBox;
    private readonly CheckBox _prependDotCb;
    private readonly CheckBox _pinnedCb;
    private readonly TextBlock _errorTb;
    private readonly Func<string, bool, string?> _validate;
    private readonly string? _presetName;
    private readonly string? _presetVendor;

    public LinkAgentEditDialog(string title, string name, string vendor, string remark, bool pinned, bool prependDot,
                               Func<string, bool, string?> validate,
                               string? presetName = null, string? presetVendor = null)
    {
        Title = title;
        Width = 460;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        WindowStyle = WindowStyle.None;
        // 透明底 + 内边距：让外框的 NeuShadow 投影在窗口边界内渲染，形成新拟物凸起悬浮感。
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        _validate = validate;
        _presetName = presetName;
        _presetVendor = presetVendor;

        // ---- 自定义标题栏（可拖动 + 关闭按钮）----
        var titleTb = new TextBlock
        {
            Text = title,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 0, 0),
        };
        // 关闭图标用 Segoe MDL2 Assets 的 ChromeClose（\uE8BB）：IconBtn 样式强制该字体，
        // 普通字符 ✕(U+2715) 不在该字体内会渲染成方框。
        var close = new Button { Content = "\uE8BB", ToolTip = "关闭" };
        close.Style = (Style)Application.Current.FindResource("IconBtn");
        close.Width = 32; close.Height = 32; close.Margin = new Thickness(0);
        close.Click += (_, _) => DialogResult = false;

        var titleBar = new Grid { Background = Brushes.Transparent, Height = 34 };
        titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        titleTb.SetValue(Grid.ColumnProperty, 0);
        close.SetValue(Grid.ColumnProperty, 1);
        titleBar.Children.Add(titleTb);
        titleBar.Children.Add(close);
        titleBar.MouseLeftButtonDown += (_, _) => { try { DragMove(); } catch { } };

        // ---- 正文：文件夹名 / 前置点+置顶 / 文件名（厂商）/ 备注 ----
        _nameBox = MakeBox(name);
        _vendorBox = MakeBox(vendor);
        _remarkBox = MakeBox(remark);

        _prependDotCb = new CheckBox
        {
            Content = "前置点",
            IsChecked = prependDot,
            Style = (Style)Application.Current.FindResource("CheckLabel"),
            VerticalAlignment = VerticalAlignment.Center,
            // 显式指定 Margin：CheckLabel 样式自带底部 10px，若只给置顶设左侧间距会覆盖样式、
            // 丢掉底部间距，导致两复选框高度/对齐不一致。
            Margin = new Thickness(0, 0, 0, 10),
            ToolTip = "名称前自动加 '.'（勾选则确保首字符为 '.'，取消则去掉首字符 '.'）",
        };
        _pinnedCb = new CheckBox
        {
            Content = "置顶",
            IsChecked = pinned,
            Style = (Style)Application.Current.FindResource("CheckLabel"),
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(18, 0, 0, 10),
            ToolTip = "置顶到列表顶部",
        };
        var checkRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(0, 8, 0, 0),
        };
        checkRow.Children.Add(_prependDotCb);
        checkRow.Children.Add(_pinnedCb);

        _errorTb = new TextBlock
        {
            Foreground = new SolidColorBrush(Color.FromRgb(0xE5, 0x48, 0x4D)),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 6, 0, 0),
            Visibility = Visibility.Collapsed,
        };

        var body = new StackPanel { Margin = new Thickness(16, 14, 16, 0) };
        body.Children.Add(MakeLabel("文件夹名"));
        body.Children.Add(_nameBox);
        body.Children.Add(checkRow);
        body.Children.Add(MakeLabel("文件名（厂商）"));
        body.Children.Add(_vendorBox);
        body.Children.Add(MakeLabel("备注"));
        body.Children.Add(_remarkBox);
        body.Children.Add(_errorTb);

        // ---- 按钮 ----
        var ok = new Button
        {
            Content = "确定",
            Width = 92,
            Height = 30,
            FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4),
            IsDefault = true,
        };
        ok.Style = (Style)Application.Current.FindResource("MiniAccent");
        ok.Click += (_, _) => OnOk();
        var cancel = new Button
        {
            Content = "取消",
            Width = 92,
            Height = 30,
            FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4),
            Margin = new Thickness(10, 0, 0, 0),
            IsCancel = true,
        };
        cancel.Style = (Style)Application.Current.FindResource("MiniGhost");
        cancel.Click += (_, _) => DialogResult = false;

        var btns = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        btns.Children.Add(ok);
        btns.Children.Add(cancel);

        // 按钮行：预设项左侧显示「恢复预设」；自定义项同样显示但置灰，悬停提示无预设可恢复；右侧确定/取消。
        var btnRow = new Grid { Margin = new Thickness(16, 10, 16, 16) };
        btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var restore = new Button
        {
            Content = "恢复预设",
            Height = 30,
            FontSize = 12,
            Padding = new Thickness(14, 4, 14, 4),
            HorizontalAlignment = HorizontalAlignment.Left,
        };
        restore.Style = (Style)Application.Current.FindResource("MiniGhost");
        restore.SetValue(Grid.ColumnProperty, 0);
        if (_presetName != null)
        {
            restore.ToolTip = "将名称与厂商恢复为预设默认值（不影响置顶和备注）";
            restore.Click += (_, _) => OnRestorePreset();
        }
        else
        {
            restore.IsEnabled = false;
            restore.ToolTip = "用户自定义链接，无预设可恢复";
        }
        btnRow.Children.Add(restore);
        btns.SetValue(Grid.ColumnProperty, 1);
        btnRow.Children.Add(btns);

        var content = new StackPanel();
        content.Children.Add(body);
        content.Children.Add(btnRow);

        // ---- 整体：圆角外框（NeuShadow 投影）+ 标题栏 + 正文 ----
        // 标题栏顶部圆角与外框一致，避免方角顶出圆角外框。
        var titleBarHost = new Border
        {
            Background = (Brush)Application.Current.FindResource("BarBrush"),
            CornerRadius = new CornerRadius(8, 8, 0, 0),
            Child = titleBar,
        };

        var frame = new Border
        {
            Background = (Brush)Application.Current.FindResource("NeuSurface"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezel"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Effect = (Effect)Application.Current.FindResource("NeuShadow"),
            Child = new Grid { Children = { titleBarHost, content } },
        };
        ((Grid)frame.Child).RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        ((Grid)frame.Child).RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetRow(titleBarHost, 0);
        Grid.SetRow(content, 1);

        // 外留 12px 边距给投影留渲染空间（窗口透明底）。
        Content = new Grid { Margin = new Thickness(12), Children = { frame } };

        Loaded += (_, _) => { _nameBox.Focus(); _nameBox.SelectAll(); };
    }

    private void OnOk()
    {
        var err = _validate(_nameBox.Text, _prependDotCb.IsChecked == true);
        if (err != null)
        {
            _errorTb.Text = err;
            _errorTb.Visibility = Visibility.Visible;
            return;
        }
        DialogResult = true;
    }

    /// <summary>恢复预设：仅把名称与厂商（及前置点状态）重置为预设默认，置顶/备注保持不变。</summary>
    private void OnRestorePreset()
    {
        if (_presetName == null) return;
        _nameBox.Text = _presetName;
        _vendorBox.Text = _presetVendor ?? "";
        _prependDotCb.IsChecked = _presetName.StartsWith(".");
        _errorTb.Visibility = Visibility.Collapsed;
    }

    /// <summary>确定时返回编辑结果；取消/关闭返回 null。</summary>
    public LinkAgentEditResult? Result => DialogResult == true
        ? new LinkAgentEditResult(_nameBox.Text, _vendorBox.Text, _remarkBox.Text,
                                  _pinnedCb.IsChecked == true, _prependDotCb.IsChecked == true)
        : null;

    public static LinkAgentEditResult? Show(string title, string name, string vendor, string remark,
                                            bool pinned, bool prependDot, Func<string, bool, string?> validate,
                                            string? presetName = null, string? presetVendor = null)
    {
        var dlg = new LinkAgentEditDialog(title, name, vendor, remark, pinned, prependDot, validate, presetName, presetVendor);
        dlg.Owner = Application.Current?.MainWindow;
        dlg.ShowDialog();
        return dlg.Result;
    }

    private static TextBlock MakeLabel(string text) => new()
    {
        Text = text,
        Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
        FontSize = 11,
        Margin = new Thickness(0, 10, 0, 3),
    };

    /// <summary>深色圆角输入框（内凹承载面 + 斜向描边，聚焦时强调蓝描边）。</summary>
    private static TextBox MakeBox(string initial) => new()
    {
        Text = initial,
        Padding = new Thickness(8, 5, 8, 5),
        FontSize = 13,
        FontFamily = new FontFamily("Consolas"),
        VerticalContentAlignment = VerticalAlignment.Center,
        Background = (Brush)Application.Current.FindResource("NeuInset"),
        Foreground = (Brush)Application.Current.FindResource("MainBrush"),
        BorderBrush = (Brush)Application.Current.FindResource("NeuBezelPress"),
        BorderThickness = new Thickness(1),
        CaretBrush = (Brush)Application.Current.FindResource("AccentBrush"),
        Template = BuildTextBoxTemplate(),
    };

    private static ControlTemplate BuildTextBoxTemplate()
    {
        var border = new FrameworkElementFactory(typeof(Border), "bd");
        border.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(TextBox.BackgroundProperty));
        border.SetValue(Border.BorderBrushProperty, new TemplateBindingExtension(TextBox.BorderBrushProperty));
        border.SetValue(Border.BorderThicknessProperty, new TemplateBindingExtension(TextBox.BorderThicknessProperty));
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(5));

        var scroll = new FrameworkElementFactory(typeof(ScrollViewer), "PART_ContentHost");
        scroll.SetValue(ScrollViewer.MarginProperty, new TemplateBindingExtension(TextBox.PaddingProperty));
        scroll.SetValue(ScrollViewer.VerticalAlignmentProperty, VerticalAlignment.Center);
        border.AppendChild(scroll);

        var template = new ControlTemplate(typeof(TextBox)) { VisualTree = border };

        var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
        hover.Setters.Add(new Setter(Border.BorderBrushProperty, Application.Current.FindResource("NeuBezelHi"), "bd"));
        template.Triggers.Add(hover);

        var focus = new Trigger { Property = UIElement.IsKeyboardFocusedProperty, Value = true };
        focus.Setters.Add(new Setter(Border.BorderBrushProperty, Application.Current.FindResource("AccentBrush"), "bd"));
        template.Triggers.Add(focus);

        return template;
    }
}
