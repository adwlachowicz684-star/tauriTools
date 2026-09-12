namespace FenPeiXiangMuZu.Services;

/// <summary>一条可自定义快捷键的动作定义：动作键（配置键名）+ 显示名 + 默认键位 + 面板分组。</summary>
public sealed record ShortcutDef(string ActionKey, string DisplayName, string DefaultGesture, int Group);

/// <summary>
/// 可自定义快捷键的动作目录。新增可自定义快捷键时在此追加一条，
/// 并在 MainWindow.GetShortcutCommand 中把动作键映射到对应命令。
/// Group：1=常规 / 2=项目操作 / 3=页签切换，决定设置面板内的分组展示顺序。
/// </summary>
public static class ShortcutCatalog
{
    public static readonly IReadOnlyList<ShortcutDef> All = new[]
    {
        // —— 组1：常规（展开/刷新/备份/清除/浮层切换） ——
        new ShortcutDef("ToggleSettings", "打开/关闭设置", "Escape", 1),
        new ShortcutDef("ToggleMcp", "打开/关闭 MCP", "Ctrl+M", 1),
        new ShortcutDef("ToggleTips", "打开/关闭使用说明", "F1", 1),
        new ShortcutDef("OpenMarkdown", "Markdown 编辑器", "Ctrl+D", 1),
        new ShortcutDef("HideToTray", "隐藏到托盘", "Ctrl+~", 1),
        new ShortcutDef("ToggleSidebar", "展开/收起侧边栏", "~", 1),
        new ShortcutDef("RefreshValidity", "刷新有效性", "F5", 1),
        new ShortcutDef("BackupNow", "一键备份", "F7", 1),
        new ShortcutDef("ClearInvalid", "清除无效项", "F8", 1),

        // —— 组2：项目/项目组操作 ——
        new ShortcutDef("OpenSelected", "打开选中文件夹", "Ctrl+O", 2),
        new ShortcutDef("LockToggle", "ACL 锁定", "Ctrl+L", 2),
        new ShortcutDef("RenameFolder", "项目/项目组改名", "F2", 2),
        new ShortcutDef("MoveFolder", "项目/项目组搬家", "F3", 2),
        new ShortcutDef("ChangeColor", "修改颜色", "F4", 2),
        new ShortcutDef("ChangeIcon", "修改图标", "F6", 2),
        new ShortcutDef("RemoveSelected", "删除选中项", "Delete", 2),

        // —— 组3：页签切换 ——
        new ShortcutDef("GroupTabNext", "下一个项目组页签", "Ctrl+Tab", 3),
        new ShortcutDef("GroupTabPrev", "上一个项目组页签", "Ctrl+Shift+Tab", 3),
        new ShortcutDef("ProjectTabNext", "下一个项目页签", "Ctrl+PageDown", 3),
        new ShortcutDef("ProjectTabPrev", "上一个项目页签", "Ctrl+PageUp", 3),
        new ShortcutDef("SwitchToProjectPane", "切到项目面板", "Ctrl+Left", 3),
        new ShortcutDef("SwitchToGroupPane", "切到项目组面板", "Ctrl+Right", 3),
    };

    /// <summary>取动作的默认键位；未知动作返回空串。</summary>
    public static string DefaultGesture(string actionKey)
        => All.FirstOrDefault(d => d.ActionKey == actionKey)?.DefaultGesture ?? "";
}