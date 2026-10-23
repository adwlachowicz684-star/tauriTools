using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 删除收藏确认对话框（纯代码构建，深色新拟物风格，与 PromptDialog 同款外壳）。
/// 「删除」返回勾选结果；取消/关闭返回 null。三个勾选默认不勾（默认执行清理），
/// 无对应可清理项时该勾选置灰不可勾。
/// </summary>
public sealed class DeleteFavoriteDialog : Window
{
    private readonly CheckBox _keepLinks;
    private readonly CheckBox _keepIcon;
    private readonly CheckBox _keepColor;

    public DeleteFavoriteDialog(string title, string message,
        bool linkEnabled, bool iconEnabled, bool colorEnabled)
    {
        Title = title;
        Width = 440;
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
        var hintTb = new TextBlock
        {
            Text = "取消勾选将在删除时执行对应清理（默认全清理）；置灰项表示当前没有可清理的内容。",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 10, 0, 8),
        };

        _keepLinks = MakeCheck("保留链接仅删收藏", linkEnabled);
        _keepIcon = MakeCheck("保留图标更改", iconEnabled);
        _keepColor = MakeCheck("保留卡片颜色设置", colorEnabled);

        var body = new StackPanel { Margin = new Thickness(16, 6, 16, 0) };
        body.Children.Add(msgTb);
        body.Children.Add(hintTb);
        body.Children.Add(_keepLinks);
        body.Children.Add(_keepIcon);
        body.Children.Add(_keepColor);

        var del = new Button
        {
            Content = "删除", Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4), IsDefault = true,
        };
        del.Style = (Style)Application.Current.FindResource("MiniDanger");
        del.Click += (_, _) => DialogResult = true;
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
            Margin = new Thickness(16, 6, 16, 16),
        };
        btns.Children.Add(del);
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
        Loaded += (_, _) => del.Focus();
    }

    /// <summary>「删除」时返回勾选结果；取消/关闭返回 null。</summary>
    public DeleteFavoriteChoice? Result => DialogResult == true
        ? new DeleteFavoriteChoice(_keepLinks.IsChecked == true, _keepIcon.IsChecked == true, _keepColor.IsChecked == true)
        : null;

    private static CheckBox MakeCheck(string text, bool enabled) => new()
    {
        Content = text,
        Style = (Style)Application.Current.FindResource("CheckLabel"),
        IsEnabled = enabled,
        Margin = new Thickness(0, 0, 0, 8),
    };

    /// <summary>模态展示。「删除」返回勾选结果；取消/关闭返回 null。</summary>
    public static DeleteFavoriteChoice? Show(string title, string message,
        bool linkEnabled, bool iconEnabled, bool colorEnabled)
    {
        var dlg = new DeleteFavoriteDialog(title, message, linkEnabled, iconEnabled, colorEnabled);
        dlg.Owner = Application.Current?.MainWindow;
        dlg.ShowDialog();
        return dlg.Result;
    }
}
