using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;

namespace FenPeiXiangMuZu.Views;

/// <summary>确认弹窗返回值：编辑后的指令文本 + 会话级不再提示标记。</summary>
public sealed class AgentChainResult
{
    public string Prompt { get; init; } = "";
    public bool SkipForSession { get; init; }
}

/// <summary>
/// Agent 连锁确认弹窗（纯代码构建，与 PromptDialog 同款深色新拟物外壳）。
/// 展示目标对象（项目/项目组 + 关联关系）、可编辑的指令全文预览、
/// 「本次客户端期间不再提示」勾选；确定返回 <see cref="AgentChainResult"/>，取消返回 null。
/// </summary>
public sealed class AgentChainConfirmDialog : Window
{
    private readonly TextBox _promptBox;
    private readonly CheckBox _skipCheck;

    private AgentChainConfirmDialog(string title, string kindLabel, string name, string fullPath,
        string linkedName, string promptText, bool skip)
    {
        Title = title;
        Width = 620;
        Height = 560;
        MinWidth = 480;
        MinHeight = 380;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ResizeMode = ResizeMode.CanResize;

        // ---- 标题栏 ----
        var titleTb = new TextBlock
        {
            Text = $"{title} · 确认发送",
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

        // ---- 目标信息（自动带出；项目卡附所属项目组） ----
        var info = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
        info.Children.Add(InfoRow(kindLabel, name));
        info.Children.Add(InfoRow("路径", fullPath));
        if (!string.IsNullOrEmpty(linkedName))
            info.Children.Add(InfoRow("所属项目组", linkedName));

        // ---- 指令预览（可编辑） ----
        var promptLabel = new TextBlock
        {
            Text = "发送内容（可修改后发送）：",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 11,
            Margin = new Thickness(0, 12, 0, 3),
        };
        _promptBox = new TextBox
        {
            Text = promptText,
            Padding = new Thickness(8, 6, 8, 6),
            FontSize = 12,
            FontFamily = new FontFamily("Consolas"),
            TextWrapping = TextWrapping.Wrap,
            AcceptsReturn = true,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Background = (Brush)Application.Current.FindResource("NeuInset"),
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezelPress"),
            BorderThickness = new Thickness(1),
            CaretBrush = (Brush)Application.Current.FindResource("AccentBrush"),
        };
        _promptBox.SetValue(Grid.RowProperty, 1);

        // ---- 本次不再提示 ----
        _skipCheck = new CheckBox
        {
            Content = "本次客户端期间不再提示",
            FontSize = 11.5,
            IsChecked = skip,
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            Margin = new Thickness(0, 10, 0, 0),
        };

        // ---- 按钮 ----
        var send = new Button
        {
            Content = "发送到 opencode", Width = 120, Height = 30, FontSize = 12,
            Padding = new Thickness(16, 4, 16, 4), IsDefault = true,
        };
        send.Style = (Style)Application.Current.FindResource("MiniAccent");
        send.Click += (_, _) => DialogResult = true;
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
            Margin = new Thickness(0, 12, 0, 0),
        };
        btns.Children.Add(send);
        btns.Children.Add(cancel);

        var body = new Grid { Margin = new Thickness(16, 6, 16, 4) };
        body.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });   // 信息区
        body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });   // 提示标签+文本框
        body.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });   // 勾选+按钮
        var midPanel = new StackPanel();
        midPanel.Children.Add(promptLabel);
        midPanel.Children.Add(_promptBox);
        var footer = new StackPanel();
        footer.Children.Add(_skipCheck);
        footer.Children.Add(btns);
        info.SetValue(Grid.RowProperty, 0);
        midPanel.SetValue(Grid.RowProperty, 1);
        footer.SetValue(Grid.RowProperty, 2);
        body.Children.Add(info);
        body.Children.Add(midPanel);
        body.Children.Add(footer);

        var content = new Grid();
        content.Children.Add(body);

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
        };
        frame.Child = new Grid { Children = { titleBarHost, content } };
        ((Grid)frame.Child).RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        ((Grid)frame.Child).RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow(titleBarHost, 0);
        Grid.SetRow(content, 1);

        Content = new Grid { Margin = new Thickness(12), Children = { frame } };
        Loaded += (_, _) => _promptBox.Focus();
    }

    /// <summary>目标信息行：标签 + 值。</summary>
    private static StackPanel InfoRow(string label, string value)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 2) };
        row.Children.Add(new TextBlock
        {
            Text = $"{label}：",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 11.5,
            VerticalAlignment = VerticalAlignment.Top,
        });
        row.Children.Add(new TextBlock
        {
            Text = value,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            FontSize = 11.5,
            TextWrapping = TextWrapping.Wrap,
            MaxWidth = 520,
            VerticalAlignment = VerticalAlignment.Top,
        });
        return row;
    }

    /// <summary>确定时返回结果；取消/关闭返回 null。</summary>
    public AgentChainResult? Result => DialogResult == true
        ? new AgentChainResult { Prompt = _promptBox.Text, SkipForSession = _skipCheck.IsChecked == true }
        : null;

    /// <summary>静态入口：显示弹窗并返回结果。</summary>
    public static AgentChainResult? Show(string title, string kindLabel, string name, string fullPath,
        string linkedName, string promptText, bool skip)
    {
        var dlg = new AgentChainConfirmDialog(title, kindLabel, name, fullPath, linkedName, promptText, skip);
        dlg.Owner = Application.Current?.MainWindow;
        dlg.ShowDialog();
        return dlg.Result;
    }
}
