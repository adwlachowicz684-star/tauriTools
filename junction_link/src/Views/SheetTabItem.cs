namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 底部「画布切换条」单个标签的绑定项。
/// 切换 / 重命名 / 增删后整列重建（画布数很少，重建开销可忽略），故不实现属性变更通知。
/// </summary>
public sealed class SheetTabItem
{
    /// <summary>画布 Id（与 <see cref="FenPeiXiangMuZu.Services.MindMapSheetData.Id"/> 一致）。</summary>
    public string Id { get; set; } = "";

    /// <summary>标签显示名。</summary>
    public string Title { get; set; } = "";

    /// <summary>是否为当前激活画布（高亮）。</summary>
    public bool IsActive { get; set; }
}
