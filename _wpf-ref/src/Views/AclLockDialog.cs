using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.Views;

/// <summary>ACL 保护弹窗的一次交互结果。</summary>
public sealed class AclLockResult
{
    /// <summary>是否点了「应用」（true 时以下字段有效）。</summary>
    public bool Applied;

    /// <summary>是否点了「取消锁定」（优先于 Applied）。</summary>
    public bool RemoveAll;

    /// <summary>防删除档勾选状态。</summary>
    public bool DenyDelete;

    /// <summary>防写入档勾选状态。</summary>
    public bool DenyWrite;

    /// <summary>监控告警开关（全局配置，随应用一并保存）。</summary>
    public bool WatchAlerts;
}

/// <summary>
/// ACL 文件夹保护设置弹窗（纯代码构建，深色新拟物外壳与 PromptDialog 同款）。
/// 账面固定为强制勾选项（走此弹窗即至少加入 config.Locked）；ACL 权限逐项勾选，
/// 预设档位按钮一键设置组合并清掉档外选项。
/// </summary>
public sealed class AclLockDialog : Window
{
    private readonly CheckBox _ckAccount;
    private readonly CheckBox _ckDelete;
    private readonly CheckBox _ckWrite;
    private readonly CheckBox _ckWatch;
    private readonly TextBlock _errorTb;

    public AclLockDialog(string path, string kind, FolderLockState aclState,
                         bool isAccountLocked, bool watchAlerts)
    {
        Title = "ACL 保护设置";
        Width = 460;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;

        // ---- 标题栏 ----
        var titleTb = new TextBlock
        {
            Text = "ACL 保护设置",
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

        // ---- 目标路径 + 类型徽章 ----
        var badge = new Border
        {
            Background = (Brush)Application.Current.FindResource("ChipRowActiveBrush"),
            CornerRadius = new CornerRadius(4),
            Padding = new Thickness(7, 2, 7, 2),
            VerticalAlignment = VerticalAlignment.Center,
            Child = new TextBlock
            {
                Text = kind == "group" ? "项目组" : kind == "project" ? "项目" : "文件夹",
                FontSize = 11,
                Foreground = (Brush)Application.Current.FindResource("AccentBrush"),
            },
        };
        var pathTb = new TextBlock
        {
            Text = path,
            FontFamily = new FontFamily("Consolas"),
            FontSize = 12,
            Foreground = (Brush)Application.Current.FindResource("MainBrush"),
            TextWrapping = TextWrapping.Wrap,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var targetGrid = new Grid();
        targetGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        targetGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        pathTb.SetValue(Grid.ColumnProperty, 0);
        pathTb.Margin = new Thickness(0, 0, 8, 0);
        badge.SetValue(Grid.ColumnProperty, 1);
        targetGrid.Children.Add(pathTb);
        targetGrid.Children.Add(badge);

        // ---- 勾选项 ----
        _ckAccount = MakeCheck(
            isAccountLocked ? "账面固定（当前已固定）" : "账面固定（清除无效时跳过、收藏不可删除）",
            true);
        _ckAccount.IsEnabled = false;   // 强制勾选：走此弹窗即至少账面锁定
        _ckAccount.ToolTip = isAccountLocked
            ? "该路径已在 config.locked 中。基础项，不可取消。"
            : "基础项，不可取消。应用后将加入 config.locked；仅记录，无系统级拦截。";
        _ckDelete = MakeCheck("防删除 —— 拦截删除 / 改名（读写不受影响）", aclState.DenyDelete);
        _ckWrite = MakeCheck("防写入 —— 目录整体只读", aclState.DenyWrite);
        _ckWatch = MakeCheck("监控告警 —— 受保护路径的外部改动写入日志", watchAlerts);

        var presetLabel = new TextBlock
        {
            Text = "档位",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 11,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 8, 0),
        };
        var btnFixed = PresetBtn("仅固定");
        var btnDel = PresetBtn("防删除 · 推荐");
        var btnRo = PresetBtn("只读保护");
        btnFixed.Click += (_, _) => SetPreset(false, false);
        btnDel.Click += (_, _) => SetPreset(true, false);
        btnRo.Click += (_, _) => SetPreset(true, true);
        var presetRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(20, 4, 0, 0),
        };
        presetRow.Children.Add(presetLabel);
        presetRow.Children.Add(btnFixed);
        presetRow.Children.Add(btnDel);
        presetRow.Children.Add(btnRo);

        _errorTb = new TextBlock
        {
            Foreground = new SolidColorBrush(Color.FromRgb(0xE5, 0x48, 0x4D)),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 6, 0, 0),
            Visibility = Visibility.Collapsed,
        };

        var body = new StackPanel { Margin = new Thickness(16, 6, 16, 0) };
        body.Children.Add(targetGrid);
        body.Children.Add(Separator());
        body.Children.Add(_ckAccount);
        body.Children.Add(_ckDelete);
        body.Children.Add(_ckWrite);
        body.Children.Add(presetRow);
        body.Children.Add(Separator());
        body.Children.Add(_ckWatch);
        body.Children.Add(MakeNote("提示：删除被拦时对方会收到「拒绝访问」。自救命令见 TIPS：icacls \"<目录>\" /remove:d *S-1-1-0"));
        body.Children.Add(_errorTb);

        // ---- 底部按钮 ----
        var apply = new Button
        {
            Content = "应用", Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4), IsDefault = true,
        };
        apply.Style = (Style)Application.Current.FindResource("MiniAccent");
        apply.Click += (_, _) => OnApply(path);
        var cancelLock = new Button
        {
            Content = "取消锁定", Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(10, 4, 10, 4),
            ToolTip = "解除本目录的锁定：移除全部 ACL 保护并退出账面固定",
        };
        cancelLock.Style = (Style)Application.Current.FindResource("MiniDanger");
        cancelLock.Click += (_, _) => OnRemoveAll();
        var cancel = new Button
        {
            Content = "取消", Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4), Margin = new Thickness(10, 0, 0, 0), IsCancel = true,
        };
        cancel.Style = (Style)Application.Current.FindResource("MiniGhost");
        cancel.Click += (_, _) => DialogResult = false;

        // 底部按钮区：取消锁定靠左下角，应用/取消靠右下角
        var rightBtns = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        rightBtns.Children.Add(apply);
        rightBtns.Children.Add(cancel);

        var bottomBar = new Grid { Margin = new Thickness(16, 10, 16, 16) };
        bottomBar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bottomBar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        cancelLock.HorizontalAlignment = HorizontalAlignment.Left;
        cancelLock.SetValue(Grid.ColumnProperty, 0);
        rightBtns.SetValue(Grid.ColumnProperty, 1);
        bottomBar.Children.Add(cancelLock);
        bottomBar.Children.Add(rightBtns);

        var content = new StackPanel();
        content.Children.Add(body);
        content.Children.Add(bottomBar);

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

        void SetPreset(bool del, bool wr)
        {
            _ckDelete.IsChecked = del;
            _ckWrite.IsChecked = wr;
        }
    }

    /// <summary>当前弹窗勾选的 ACL 强度预览（供外部在 Show 后读取）。</summary>
    private void OnApply(string path)
    {
        if (!Directory.Exists(path))
        {
            ShowError($"文件夹不存在: {path}");
            return;
        }
        DialogResult = true;
    }

    private void OnRemoveAll()
    {
        if (!Dialog.Service.Confirm(
                "将解除该目录的锁定：移除全部 ACL 保护并退出账面固定，确定继续？",
                "取消锁定")) return;
        _result = new AclLockResult { RemoveAll = true };
        DialogResult = true;
    }

    private void ShowError(string msg)
    {
        _errorTb.Text = msg;
        _errorTb.Visibility = Visibility.Visible;
    }

    private AclLockResult BuildResult() => new()
    {
        Applied = true,
        DenyDelete = _ckDelete.IsChecked == true,
        DenyWrite = _ckWrite.IsChecked == true,
        WatchAlerts = _ckWatch.IsChecked == true,
    };

    private AclLockResult? _result;

    /// <summary>确定时返回结果对象；「取消锁定」返回 RemoveAll=true；取消/关闭返回 null。</summary>
    public AclLockResult? Result
    {
        get
        {
            if (DialogResult != true) return null;
            if (_result != null) return _result;
            return BuildResult();
        }
    }

    public static AclLockResult? Show(string path, string kind, FolderLockState aclState,
                                      bool isAccountLocked, bool watchAlerts)
    {
        var dlg = new AclLockDialog(path, kind, aclState, isAccountLocked, watchAlerts);
        dlg.Owner = Application.Current?.MainWindow;
        dlg.ShowDialog();
        return dlg.Result;
    }

    // ---------------- 小部件工厂 ----------------

    private static CheckBox MakeCheck(string text, bool isChecked) => new()
    {
        Content = text,
        IsChecked = isChecked,
        FontSize = 12,
        Margin = new Thickness(0, 8, 0, 0),
        Style = (Style)Application.Current.FindResource("CheckLabel"),
    };

    private static Button PresetBtn(string text)
    {
        var b = new Button
        {
            Content = text,
            FontSize = 11,
            Padding = new Thickness(10, 3, 10, 3),
            Margin = new Thickness(0, 0, 8, 0),
        };
        b.Style = (Style)Application.Current.FindResource("MiniGhost");
        return b;
    }

    private static TextBlock MakeNote(string text) => new()
    {
        Text = text,
        Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
        FontSize = 10.5,
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 8, 0, 0),
    };

    private static Border Separator() => new()
    {
        Height = 1,
        Background = (Brush)Application.Current.FindResource("BorderBrush"),
        Opacity = 0.5,
        Margin = new Thickness(0, 10, 0, 2),
    };
}
