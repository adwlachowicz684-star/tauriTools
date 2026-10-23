using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Media.Effects;
using FenPeiXiangMuZu.ViewModels;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 链接多选对话框（深色新拟物风格）：列出可为项目创建的链接名（预设/自定义），
/// 固定（原置顶）项置顶并带「固定」标记，可多选；确定后返回勾选名，取消/关闭返回 null。
/// 仅复用设置里链接编辑弹窗的视觉外壳，功能不同（建链/删链选择）。
/// </summary>
public sealed class LinkPickDialog : Window
{
    private readonly List<CheckBox> _items = new();

    public LinkPickDialog(string title, string header, IReadOnlyList<LinkPickOption> options)
    {
        Title = title;
        Width = 480;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;

        // ---- 自定义标题栏（可拖动 + 关闭）----
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

        // ---- 正文：提示 + 多选清单 ----
        var hint = new TextBlock
        {
            Text = string.IsNullOrWhiteSpace(header) ? "选择要创建的链接（固定项在前，可多选；标记「已连」的项勾选即为同名改连）" : header,
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 2, 0, 4),
        };

        var list = new StackPanel { Margin = new Thickness(0, 0, 0, 10) };

        // 参照设置面板：固定(原置顶)区 / 分隔线 / 普通区，每区 2 列等宽均分
        var fixedOpts = new List<LinkPickOption>();
        var normalOpts = new List<LinkPickOption>();
        foreach (var o in options)
            (o.IsFixed ? fixedOpts : normalOpts).Add(o);

        if (fixedOpts.Count > 0)
            list.Children.Add(MakeCheckGrid(fixedOpts));
        if (fixedOpts.Count > 0 && normalOpts.Count > 0)
            list.Children.Add(MakeSeparator());
        if (normalOpts.Count > 0)
            list.Children.Add(MakeCheckGrid(normalOpts));

        var scroll = new ScrollViewer
        {
            Content = list,
            MaxHeight = 320,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        };

        var body = new StackPanel { Margin = new Thickness(16, 12, 16, 0) };
        body.Children.Add(hint);
        body.Children.Add(scroll);

        // ---- 按钮 ----
        var ok = new Button { Content = "确定", Width = 92, Height = 30, FontSize = 12, Padding = new Thickness(20, 4, 20, 4), IsDefault = true };
        ok.Style = (Style)Application.Current.FindResource("MiniAccent");
        ok.Click += (_, _) => OnOk();
        var cancel = new Button
        {
            Content = "取消", Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4), Margin = new Thickness(10, 0, 0, 0), IsCancel = true,
        };
        cancel.Style = (Style)Application.Current.FindResource("MiniGhost");
        cancel.Click += (_, _) => DialogResult = false;
        var btns = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        btns.Children.Add(ok);
        btns.Children.Add(cancel);
        var btnRow = new Border { Margin = new Thickness(16, 8, 16, 14), Child = btns };

        var content = new StackPanel();
        content.Children.Add(body);
        content.Children.Add(btnRow);

        // ---- 整体外壳（与设置链接编辑弹窗同款）----
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

    private void OnOk()
    {
        var chosen = new List<string>();
        foreach (var cb in _items)
            if (cb.IsChecked == true && cb.Tag is string name)
                chosen.Add(name);
        Result = chosen;
        DialogResult = true;
    }

    /// <summary>单项勾选行（名称 + 厂商标注 + 可选「固定」标记 / 他组占用提示）。被其它项目组占用的名称仍可选择：
    /// 勾选 = 把该名称的链接改连到本次目标项目组（同名换绑）；不勾选则保持原链接。该项默认不勾选。</summary>
    private CheckBox MakeCheck(LinkPickOption o)
    {
        var mutedBrush = (Brush)Application.Current.FindResource("MutedBrush");
        var warnBrush = (Brush)Application.Current.FindResource("LockBrush");
        var nameTb = new TextBlock
        {
            Text = o.Name,
            FontFamily = new FontFamily("Consolas"),
            FontSize = 13,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        var vendorTb = new TextBlock
        {
            Text = o.Vendor,
            FontSize = 11,
            Foreground = mutedBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
        };
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(nameTb);
        row.Children.Add(vendorTb);
        if (o.IsOwnedElsewhere)
        {
            // 他组占用：醒目小标签提示"已连X组，勾选将改连"，区别于固定图钉标记。
            row.Children.Add(new Border
            {
                Background = (Brush)Application.Current.FindResource("NeuSurfaceHi"),
                CornerRadius = new CornerRadius(3),
                Padding = new Thickness(5, 1, 5, 1),
                Margin = new Thickness(8, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center,
                Child = new TextBlock
                {
                    Text = $"已连「{o.OwnedBy}」，勾选将改连",
                    FontSize = 10,
                    Foreground = warnBrush,
                },
            });
        }
        else if (o.IsFixed)
        {
            // 固定项用图钉图标（与设置面板置顶图标同款），替代原「固定」文字标签。
            row.Children.Add(new TextBlock
            {
                Text = "\uE718",
                FontFamily = new FontFamily("Segoe MDL2 Assets"),
                FontSize = 12,
                Foreground = (Brush)Application.Current.FindResource("AccentBrush"),
                Margin = new Thickness(8, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center,
                ToolTip = "固定项",
            });
        }
        var cb = new CheckBox
        {
            Content = row,
            Tag = o.Name,   // 勾选名直接绑 Tag，取值不依赖内部布局结构
            IsChecked = o.IsActive,
            IsEnabled = true,
            ToolTip = o.IsOwnedElsewhere
                ? $"{o.Name} 当前指向项目组「{o.OwnedBy}」；勾选后该名称的链接将改连到本次选择的目标项目组，取消勾选则保持原链接不变。"
                : o.Name + (o.IsFixed ? "（固定）" : ""),
            Cursor = System.Windows.Input.Cursors.Hand,
            Style = (Style)Application.Current.FindResource("CheckLabel"),
            Margin = new Thickness(0, 2, 10, 10),
            VerticalContentAlignment = VerticalAlignment.Center,
        };
        _items.Add(cb);
        return cb;
    }

    /// <summary>一组勾选项，2 列等宽均分（同设置面板）。</summary>
    private UniformGrid MakeCheckGrid(IEnumerable<LinkPickOption> group)
    {
        var grid = new UniformGrid { Columns = 2 };
        foreach (var o in group) grid.Children.Add(MakeCheck(o));
        return grid;
    }

    /// <summary>固定区 / 普通区之间的横向分隔线。</summary>
    private static Border MakeSeparator()
        => new Border
        {
            Height = 1,
            Background = (Brush)Application.Current.FindResource("NeuBezelHi"),
            Margin = new Thickness(4, 6, 4, 6),
        };

    /// <summary>确定时返回勾选的链接名列表；取消/关闭返回 null。</summary>
    public List<string>? Result { get; private set; }

    public static List<string>? Show(string title, string header, IReadOnlyList<LinkPickOption> options)
    {
        var dlg = new LinkPickDialog(title, header, options);
        dlg.Owner = Application.Current?.MainWindow;
        dlg.ShowDialog();
        return dlg.Result;
    }
}