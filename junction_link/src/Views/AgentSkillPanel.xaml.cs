using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.ViewModels;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 「Agent/Skill 内容浏览区」面板（UserControl）。
/// 不写死 DataContext：协调者通过公共属性 <see cref="Panel"/> 注入 AgentSkillViewModel。
/// </summary>
public partial class AgentSkillPanel : UserControl
{
    public AgentSkillPanel()
    {
        InitializeComponent();
    }

    /// <summary>协调者注入的浏览区 ViewModel。设值即设为 DataContext，XAML 直接绑定其属性。</summary>
    public static readonly DependencyProperty PanelProperty = DependencyProperty.Register(
        nameof(Panel), typeof(AgentSkillViewModel), typeof(AgentSkillPanel),
        new PropertyMetadata(null, (d, e) =>
        {
            if (e.NewValue is AgentSkillViewModel vm)
                ((AgentSkillPanel)d).DataContext = vm;
        }));

    public AgentSkillViewModel? Panel
    {
        get => (AgentSkillViewModel?)GetValue(PanelProperty);
        set => SetValue(PanelProperty, value);
    }

    /// <summary>
    /// 树整行点击选中（隧道事件，先于一切子元素）：叶子=选中并预览，目录=切换展开。
    /// 挂在 TreeView 上而非样式 EventSetter——后者运行时会创建 code-behind 新实例作接收者，
    /// 其 Panel/DataContext 为空导致命令永不执行且 Handled 吞掉点击（全树不可选中的根因）。
    /// </summary>
    private void OnTreePreviewMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (WithinExpander(e.OriginalSource as DependencyObject)) return;
        var item = FindItemContainer(e.OriginalSource as DependencyObject);
        if (item == null || item.DataContext is not AgentSkillNode node) return;
        if (DataContext is AgentSkillViewModel vm)
            vm.SelectCommand.Execute(node);
        e.Handled = true;
    }

    /// <summary>命中点向上找所属行容器 TreeViewItem；空白/滚动条等非行区域返回 null 不拦截。</summary>
    private static TreeViewItem? FindItemContainer(DependencyObject? source)
    {
        for (var c = source; c != null; c = VisualTreeHelper.GetParent(c))
            if (c is TreeViewItem tvi) return tvi;
        return null;
    }

    /// <summary>命中点是否落在展开箭头(ToggleButton)上：是则放行让其自行切换展开，避免双重切换。</summary>
    private static bool WithinExpander(DependencyObject? source)
    {
        for (var c = source; c != null; c = VisualTreeHelper.GetParent(c))
            if (c is ToggleButton) return true;
        return false;
    }
}