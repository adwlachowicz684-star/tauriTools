using System;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Controls;

namespace FenPeiXiangMuZu;

/// <summary>侧边栏项类型。Operation=操作按钮；Chain=Agent 连锁动作；Separator=分隔线占位；BottomAnchor=侧边栏底部锚定分组标记（不渲染）。</summary>
public enum SidebarItemKind
{
    Operation,
    Chain,
    Separator,
    BottomAnchor,
}

/// <summary>侧边栏单一数据源条目：图标列（图标按钮）与名称列（右侧名称浮层）共用同一实例，
/// 保证两列逐行严格对齐、增删/顺序/滚动只改一处，永不漂移。</summary>
public sealed class SidebarItemModel : INotifyPropertyChanged
{
    /// <summary>显示名称（Separator 项为 null）。</summary>
    public string? Name { get; set; }

    /// <summary>图标字形（Segoe Fluent Icons 码点；Separator 项为空）。</summary>
    public string Glyph { get; set; } = "";

    /// <summary>类别，决定图标列与名称列的渲染形态。</summary>
    public SidebarItemKind Kind { get; set; }

    /// <summary>是否危险项（删除收藏红色图标）。</summary>
    public bool IsDanger { get; set; }

    /// <summary>名称列右侧的快捷键提示文字；null 不显示。</summary>
    public string? Shortcut { get; set; }

    /// <summary>图标按钮悬停提示全文（未设置时回退显示 Name）。</summary>
    public string? ToolTip { get; set; }

    /// <summary>点击图标按钮时执行的操作。</summary>
    public Action? Clicked { get; set; }

    /// <summary>图标按钮右键菜单；null 表示无右键菜单（其余侧边栏项不受影响）。</summary>
    public ContextMenu? Menu { get; set; }

    private bool _isHovered;

    /// <summary>悬停态：图标列鼠标悬停时置真，名称列对应行据此高亮（两列同实例，天然联动）。</summary>
    public bool IsHovered
    {
        get => _isHovered;
        set
        {
            if (_isHovered == value) return;
            _isHovered = value;
            RaisePropertyChanged();
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void RaisePropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

/// <summary>标题栏「TIPS 左侧插件展示区」的单一入口项：一个已注册插件对应一个入口按钮（图标 + 激活高亮）。</summary>
public sealed class PluginLauncherItem : INotifyPropertyChanged
{
    /// <summary>插件 id（对应 PluginService 受管 id，如 kityminder）。</summary>
    public string Id { get; set; } = "";

    /// <summary>显示名称。</summary>
    public string Name { get; set; } = "";

    /// <summary>图标字形（Segoe Fluent Icons 码点）。</summary>
    public string Glyph { get; set; } = "";

    /// <summary>图标按钮悬停提示全文（未设置时回退显示 Name）。</summary>
    public string? ToolTip { get; set; }

    /// <summary>点击入口按钮时执行的打开动作（如切换对应插件浮层）。</summary>
    public Action? Clicked { get; set; }

    private bool _isActive;

    /// <summary>激活态（对应插件浮层打开时按钮保持高亮，与 TitleBtnActive 联动）。</summary>
    public bool IsActive
    {
        get => _isActive;
        set
        {
            if (_isActive == value) return;
            _isActive = value;
            RaisePropertyChanged();
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void RaisePropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}