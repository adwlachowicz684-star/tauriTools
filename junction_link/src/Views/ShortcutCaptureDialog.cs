using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 快捷键捕获对话框（纯代码构建，深色新拟物风格，与 PromptDialog 同款外壳）。
/// 按下新组合键即捕获显示；Backspace 清除（禁用该快捷键）；Enter 确认、Esc 取消。
/// </summary>
public sealed class ShortcutCaptureDialog : Window
{
    private readonly TextBlock _display;
    private readonly TextBlock _errorTb;
    private Key _capturedKey = Key.None;
    private ModifierKeys _capturedModifiers = ModifierKeys.None;
    private bool _captured;
    private string _result = "";

    public ShortcutCaptureDialog(string title, string currentGesture)
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

        // ---- 键位显示区 ----
        _display = new TextBlock
        {
            Text = ShortcutGesture.Display(currentGesture),
            FontSize = 18,
            FontWeight = FontWeights.SemiBold,
            Foreground = (Brush)Application.Current.FindResource("AccentBrush"),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var displayBox = new Border
        {
            Background = (Brush)Application.Current.FindResource("NeuInset"),
            BorderBrush = (Brush)Application.Current.FindResource("NeuBezelPress"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(12, 12, 12, 12),
            MinHeight = 52,
            Child = _display,
        };

        var hint = new TextBlock
        {
            Text = "按下新的组合键（如 Ctrl+Shift+K）；Backspace 清除以禁用该快捷键；Enter 确认，Esc 取消。",
            Foreground = (Brush)Application.Current.FindResource("MutedBrush"),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 10, 0, 0),
        };

        _errorTb = new TextBlock
        {
            Foreground = new SolidColorBrush(Color.FromRgb(0xE5, 0x48, 0x4D)),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 6, 0, 0),
            Visibility = Visibility.Collapsed,
        };

        var body = new StackPanel { Margin = new Thickness(16, 8, 16, 0) };
        body.Children.Add(displayBox);
        body.Children.Add(hint);
        body.Children.Add(_errorTb);

        // ---- 按钮 ----
        var ok = new Button
        {
            Content = "确定", Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4), IsDefault = true,
        };
        ok.Style = (Style)Application.Current.FindResource("MiniAccent");
        ok.Click += (_, _) => OnOk();
        var clear = new Button
        {
            Content = "清除", Width = 92, Height = 30, FontSize = 12,
            Padding = new Thickness(20, 4, 20, 4), Margin = new Thickness(0, 0, 0, 0),
        };
        clear.Style = (Style)Application.Current.FindResource("MiniGhost");
        clear.ToolTip = "清除该快捷键（禁用）";
        clear.Click += (_, _) => { _captured = false; _capturedKey = Key.None; _capturedModifiers = ModifierKeys.None; UpdateDisplay(); };
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
            Margin = new Thickness(16, 12, 16, 16),
        };
        btns.Children.Add(ok);
        btns.Children.Add(clear);
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

        PreviewKeyDown += OnCaptureKeyDown;
        Loaded += (_, _) => { Focus(); };
    }

    private void OnOk()
    {
        var gesture = _captured ? ShortcutGesture.Format(_capturedKey, _capturedModifiers) : "";
        if (!IsSupported(gesture))
        {
            _errorTb.Text = "该组合键不受支持（Shift+字母/数字需配合 Ctrl/Alt 使用），请重新按键。";
            _errorTb.Visibility = Visibility.Visible;
            return;
        }
        _errorTb.Visibility = Visibility.Collapsed;
        _result = gesture;
        DialogResult = true;
    }

    /// <summary>键位串是否可被 KeyGesture 接受（空串=禁用，恒为真）。</summary>
    private static bool IsSupported(string gesture)
    {
        if (string.IsNullOrWhiteSpace(gesture)) return true;
        try { return new KeyGestureConverter().ConvertFromString(gesture) != null; }
        catch { return false; }
    }

    /// <summary>捕获按键：忽略纯修饰键；Enter 确认、Esc 取消、Backspace 清除。</summary>
    private void OnCaptureKeyDown(object sender, KeyEventArgs e)
    {
        e.Handled = true;
        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        if (IsModifierKey(key)) return;
        if (key == Key.Escape) { DialogResult = false; return; }
        if (key == Key.Enter) { if (_captured) OnOk(); return; }
        if (key == Key.Back)
        {
            _captured = false; _capturedKey = Key.None; _capturedModifiers = ModifierKeys.None;
            _errorTb.Visibility = Visibility.Collapsed;
            UpdateDisplay();
            return;
        }
        _capturedKey = key;
        _capturedModifiers = Keyboard.Modifiers;
        _captured = true;
        _errorTb.Visibility = Visibility.Collapsed;
        UpdateDisplay();
    }

    private static bool IsModifierKey(Key key) => key is Key.LeftCtrl or Key.RightCtrl or Key.LeftAlt
        or Key.RightAlt or Key.LeftShift or Key.RightShift or Key.LWin or Key.RWin;

    private void UpdateDisplay()
        => _display.Text = _captured
            ? ShortcutGesture.Display(ShortcutGesture.Format(_capturedKey, _capturedModifiers))
            : "未设置";

    /// <summary>确定时返回新键位（规范串，可能为空串=禁用）；取消/关闭返回 null。</summary>
    public string? Result => DialogResult == true ? _result : null;

    public static string? Show(string title, string currentGesture)
    {
        var dlg = new ShortcutCaptureDialog(title, currentGesture);
        dlg.Owner = Application.Current?.MainWindow;
        dlg.ShowDialog();
        return dlg.Result;
    }
}
