using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 连锁动作图标选择弹窗（纯代码构建，与 PromptDialog 同款深色新拟物外壳）。
/// 网格展示 ChainIconCatalog 内置字形（风格与侧边栏一致）；点选即返回该字形；
/// 「恢复默认图标」返回空串（=用默认 E99A）；取消/关闭返回 null。
/// </summary>
public sealed class ChainIconPickDialog : Window
{
    private string? _picked;

    private ChainIconPickDialog(string title, string current)
    {
        Title = title;
        Width = 372;
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

        // ---- 图标网格 ----
        var grid = new WrapPanel { Margin = new Thickness(2) };
        foreach (var g in ChainIconCatalog.Glyphs)
        {
            var b = new Button
            {
                Content = g,
                Width = 40,
                Height = 40,
                Margin = new Thickness(3),
                FontFamily = new FontFamily("Segoe Fluent Icons"),
                FontSize = 17,
                Foreground = (Brush)Application.Current.FindResource("MainBrush"),
                Cursor = System.Windows.Input.Cursors.Hand,
                Tag = string.Equals(g, current, StringComparison.Ordinal),
            };
            var bdFactory = new FrameworkElementFactory(typeof(Border), "bd");
            bdFactory.SetValue(Border.BackgroundProperty, Application.Current.FindResource("NeuInset"));
            bdFactory.SetValue(Border.CornerRadiusProperty, new CornerRadius(6));
            bdFactory.SetValue(Border.BorderBrushProperty, Application.Current.FindResource("NeuBezel"));
            bdFactory.SetValue(Border.BorderThicknessProperty, new Thickness(1));
            var cp = new FrameworkElementFactory(typeof(ContentPresenter));
            cp.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            bdFactory.AppendChild(cp);
            var tpl = new ControlTemplate(typeof(Button)) { VisualTree = bdFactory };
            var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(Border.BackgroundProperty, Application.Current.FindResource("NeuSurfaceHi"), "bd"));
            hover.Setters.Add(new Setter(Border.BorderBrushProperty, Application.Current.FindResource("NeuBezelHi"), "bd"));
            tpl.Triggers.Add(hover);
            b.Template = tpl;
            b.Click += (_, _) => { _picked = g; DialogResult = true; };
            grid.Children.Add(b);
        }

        var label = new TextBlock
        {
            Text = "选择图标（风格与侧边栏一致）",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 11,
            Margin = new Thickness(0, 12, 0, 4),
        };
        var body = new StackPanel { Margin = new Thickness(16, 6, 16, 0) };
        body.Children.Add(label);
        body.Children.Add(new ScrollViewer
        {
            MaxHeight = 238,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Content = grid,
        });

        var reset = new Button
        {
            Content = "恢复默认图标", Width = 104, Height = 30, FontSize = 12,
            Padding = new Thickness(10, 4, 10, 4),
        };
        reset.Style = (Style)Application.Current.FindResource("MiniGhost");
        reset.Click += (_, _) => { _picked = "\uE99A"; DialogResult = true; };
        var cancel = new Button
        {
            Content = "取消", Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(16, 4, 16, 4), Margin = new Thickness(10, 0, 0, 0), IsCancel = true,
        };
        cancel.Style = (Style)Application.Current.FindResource("MiniGhost");
        cancel.Click += (_, _) => DialogResult = false;
        var btns = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(16, 10, 16, 16),
        };
        btns.Children.Add(reset);
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
    }

    /// <summary>点选返回字形串；「恢复默认」返回空串；取消/关闭返回 null。</summary>
    public string? Result => DialogResult == true ? _picked : null;

    public static string? Show(string title, string current)
    {
        var dlg = new ChainIconPickDialog(title, current);
        dlg.Owner = Application.Current?.MainWindow;
        dlg.ShowDialog();
        return dlg.Result;
    }
}
