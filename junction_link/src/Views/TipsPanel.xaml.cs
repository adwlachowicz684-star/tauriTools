using System;
using System.Windows;
using System.Windows.Controls;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 「使用说明」内嵌浮层（UserControl，深色风格，内容同原 TipsWindow）。
/// 仅用于阅读，由标题栏 TIPS 按钮切换显示；不再以独立窗口弹出。
/// </summary>
public sealed partial class TipsPanel : UserControl
{
    public TipsPanel() => InitializeComponent();

    /// <summary>右上角关闭按钮点击 → 触发 RequestClose，交由 MainWindow 收起浮层。</summary>
    public event EventHandler? RequestClose;

    private void OnCloseClick(object sender, RoutedEventArgs e) => RequestClose?.Invoke(this, EventArgs.Empty);
}
