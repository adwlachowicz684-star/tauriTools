using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 通用确认对话框（纯代码构建，深色新拟物风格，与 PromptDialog 同款外壳）。
/// 「确定」返回 true；取消/关闭返回 false。danger=true 时确定按钮用危险红样式。
/// </summary>
public sealed class ConfirmDialog : Window
{
    public ConfirmDialog(string title, string message, string confirmText = "确定", bool danger = false)
    {
        Title = title;
        Width = 380;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;

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

        var msgTb = new TextBlock
        {
            Text = message,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
        };
        var body = new StackPanel { Margin = new Thickness(16, 6, 16, 0) };
        body.Children.Add(msgTb);

        var ok = new Button
        {
            Content = confirmText, Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4), IsDefault = true,
        };
        ok.Style = (Style)Application.Current.FindResource(danger ? "MiniDanger" : "MiniAccent");
        ok.Click += (_, _) => DialogResult = true;
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
        Loaded += (_, _) => ok.Focus();
    }

    /// <summary>「确定」返回 true；取消/关闭返回 false。</summary>
    public bool Confirmed => DialogResult == true;

    /// <summary>模态展示。「确定」返回 true；取消/关闭返回 false。</summary>
    public static bool Show(Window? owner, string title, string message, string confirmText = "确定", bool danger = false)
    {
        var dlg = new ConfirmDialog(title, message, confirmText, danger);
        dlg.Owner = owner ?? Application.Current?.MainWindow;
        dlg.ShowDialog();
        return dlg.Confirmed;
    }
}
