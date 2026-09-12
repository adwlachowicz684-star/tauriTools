using System.Windows;
using System.Windows.Controls;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 「MCP 工具开关」面板（UserControl，命名空间 FenPeiXiangMuZu.Views）。
/// 协调者通过公共属性 <see cref="Panel"/> 注入 McpViewModel，设值即设为 DataContext。
/// 面板自身只是状态展示；显示/隐藏与保存时机由协调者控制。
/// </summary>
public partial class McpPanel : UserControl
{
    public McpPanel()
    {
        InitializeComponent();
    }

    /// <summary>协调者注入 MCP 视图模型（object，通常为 McpViewModel）。设值即设为 DataContext。</summary>
    public static readonly DependencyProperty PanelProperty = DependencyProperty.Register(
        nameof(Panel), typeof(object), typeof(McpPanel),
        new PropertyMetadata(null, (d, e) =>
        {
            if (e.NewValue != null)
                ((McpPanel)d).DataContext = e.NewValue;
        }));

    public object? Panel
    {
        get => GetValue(PanelProperty);
        set => SetValue(PanelProperty, value);
    }

    /// <summary>MCP 面板请求关闭（右上角 × 按钮触发），由宿主（MainWindow）隐藏浮层。</summary>
    public event EventHandler? RequestClose;

    /// <summary>右上角关闭按钮点击 → 触发 RequestClose，交由 MainWindow 收起浮层。</summary>
    private void OnCloseClick(object sender, RoutedEventArgs e) => RequestClose?.Invoke(this, EventArgs.Empty);
}
