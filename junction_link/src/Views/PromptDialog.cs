using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 单字段重命名/输入对话框（纯代码构建，深色新拟物风格，与链接编辑弹窗同款外壳）。
/// 确定前调用 validate(raw) 校验，返回错误文案则留在弹窗内提示、不关闭。
/// </summary>
public sealed class PromptDialog : Window
{
    private readonly TextBox _box;
    private readonly TextBlock _errorTb;
    private readonly Func<string, string?> _validate;

    public PromptDialog(string title, string label, string initial, Func<string, string?> validate)
    {
        Title = title;
        Width = 380;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        _validate = validate;

        // ---- 标题栏（可拖动 + 关闭）----
        var titleTb = new TextBlock
        {
            Text = title,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 0, 0),
        };
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

        _box = MakeBox(initial);
        _errorTb = new TextBlock
        {
            Foreground = new SolidColorBrush(Color.FromRgb(0xE5, 0x48, 0x4D)),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 6, 0, 0),
            Visibility = Visibility.Collapsed,
        };

        var labelTb = new TextBlock
        {
            Text = label,
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 11,
            Margin = new Thickness(0, 12, 0, 3),
        };

        var body = new StackPanel { Margin = new Thickness(16, 6, 16, 0) };
        body.Children.Add(labelTb);
        body.Children.Add(_box);
        body.Children.Add(_errorTb);

        var ok = new Button
        {
            Content = "确定", Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4), IsDefault = true,
        };
        ok.Style = (Style)Application.Current.FindResource("MiniAccent");
        ok.Click += (_, _) => OnOk();
        var cancel = new Button
        {
            Content = "取消", Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4), Margin = new Thickness(10, 0, 0, 0), IsCancel = true,
        };
        cancel.Style = (Style)Application.Current.FindResource("MiniGhost");
        cancel.Click += (_, _) => DialogResult = false;
        var btns = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(16, 10, 16, 16),
        };
        btns.Children.Add(ok);
        btns.Children.Add(cancel);

        var content = new StackPanel();
        content.Children.Add(body);
        content.Children.Add(btns);

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

        Content = new Grid { Margin = new Thickness(12), Children = { frame } };
        Loaded += (_, _) => { _box.Focus(); _box.SelectAll(); };
    }

    private void OnOk()
    {
        var err = _validate(_box.Text);
        if (err != null)
        {
            _errorTb.Text = err;
            _errorTb.Visibility = Visibility.Visible;
            return;
        }
        DialogResult = true;
    }

    /// <summary>确定时返回输入文本；取消/关闭返回 null。</summary>
    public string? Result => DialogResult == true ? _box.Text : null;

    public static string? Show(string title, string label, string initial, Func<string, string?> validate)
    {
        var dlg = new PromptDialog(title, label, initial, validate);
        dlg.Owner = Application.Current?.MainWindow;
        dlg.ShowDialog();
        return dlg.Result;
    }

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