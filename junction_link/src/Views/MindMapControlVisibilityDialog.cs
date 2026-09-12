using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 脑图控件可见性调试对话框（纯代码构建，深色新拟物风格，与 ConfirmDialog 同款外壳）。
/// 列出根元素下所有 FrameworkElement，每个带 CheckBox：取消勾选即隐藏（Collapsed），勾选即显示（Visible），
/// 用于逐个定位多余的"底"层。仅作调试辅助，不落盘。
/// </summary>
public sealed class MindMapControlVisibilityDialog : Window
{
    private readonly List<(FrameworkElement Elem, CheckBox Box)> _rows = new();

    public MindMapControlVisibilityDialog(string title, FrameworkElement root)
    {
        Title = title;
        Width = 480;
        Height = 600;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.CanResize;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;

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
        close.Click += (_, _) => Close();
        var titleBar = new Grid { Background = Brushes.Transparent, Height = 34 };
        titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        titleTb.SetValue(Grid.ColumnProperty, 0);
        close.SetValue(Grid.ColumnProperty, 1);
        titleBar.Children.Add(titleTb);
        titleBar.Children.Add(close);
        titleBar.MouseLeftButtonDown += (_, _) => { try { DragMove(); } catch { } };

        var hint = new TextBlock
        {
            Text = "取消勾选 = 隐藏该控件；勾选 = 显示。逐个取消勾选，定位多余的“底”层。",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(16, 8, 16, 4),
        };

        var list = new StackPanel { Margin = new Thickness(16, 0, 16, 0) };
        var scroll = new ScrollViewer
        {
            Content = list,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Margin = new Thickness(0, 4, 0, 0),
        };

        Collect(root, list, 0);

        var reset = new Button
        {
            Content = "全部显示", Height = 30, FontSize = 12, Padding = new Thickness(16, 4, 16, 4),
        };
        reset.Style = (Style)Application.Current.FindResource("MiniGhost");
        reset.Click += (_, _) =>
        {
            foreach (var (e, b) in _rows) { e.Visibility = Visibility.Visible; b.IsChecked = true; }
        };
        var done = new Button
        {
            Content = "关闭", Height = 30, FontSize = 12, Padding = new Thickness(20, 4, 20, 4),
            Margin = new Thickness(10, 0, 0, 0), IsCancel = true,
        };
        done.Style = (Style)Application.Current.FindResource("MiniAccent");
        done.Click += (_, _) => Close();
        var btns = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(16, 10, 16, 16),
        };
        btns.Children.Add(reset);
        btns.Children.Add(done);

        var content = new Grid();
        content.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        content.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        content.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        content.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetRow(hint, 0);
        Grid.SetRow(scroll, 2);
        Grid.SetRow(btns, 3);
        content.Children.Add(hint);
        content.Children.Add(scroll);
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
        ((Grid)frame.Child).RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow(titleBarHost, 0);
        Grid.SetRow(content, 1);

        Content = new Grid { Margin = new Thickness(12), Children = { frame } };
    }

    private void Collect(FrameworkElement el, StackPanel list, int depth)
    {
        var name = el.Name;
        var label = string.IsNullOrEmpty(name) ? el.GetType().Name : $"{name}  ({el.GetType().Name})";
        var box = new CheckBox
        {
            Content = label,
            IsChecked = el.Visibility == Visibility.Visible,
            FontSize = 12,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            Margin = new Thickness(depth * 14, 2, 0, 2),
        };
        var captured = el;
        box.Checked += (_, _) => captured.Visibility = Visibility.Visible;
        box.Unchecked += (_, _) => captured.Visibility = Visibility.Collapsed;
        _rows.Add((captured, box));
        list.Children.Add(box);

        for (int i = 0; i < VisualTreeHelper.GetChildrenCount(el); i++)
            if (VisualTreeHelper.GetChild(el, i) is FrameworkElement child)
                Collect(child, list, depth + 1);
    }

    /// <summary>模态展示控件可见性调试对话框。</summary>
    public static void Show(Window? owner, string title, FrameworkElement root)
    {
        var dlg = new MindMapControlVisibilityDialog(title, root) { Owner = owner ?? Application.Current?.MainWindow };
        dlg.ShowDialog();
    }
}
