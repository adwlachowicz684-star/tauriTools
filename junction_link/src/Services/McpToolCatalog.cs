namespace FenPeiXiangMuZu.Services;

/// <summary>
/// MCP 工具元数据单一来源：名称 / 说明 / 分组。
/// GUI 的 MCP 开关面板与 McpServer 的 tools/list 共用此清单，保证两边一致。
/// </summary>
public static class McpToolCatalog
{
    public sealed record ToolInfo(string Name, string Description, string Group);

    public static readonly IReadOnlyList<ToolInfo> All = new[]
    {
        new ToolInfo("get_manual", "阅读本 MCP 的使用手册：了解所有工具的能力、参数与用法", "基础信息"),
        new ToolInfo("get_status", "获取工具状态：目录、配置（项目组/项目/aiAgentCmd）、链接记录数、当前选中", "基础信息"),
        new ToolInfo("list_groups", "读取项目组列表（config.groupTabs 全页签去重）", "目录与选择"),
        new ToolInfo("list_projects", "读取项目列表（config.projectTabs 全页签去重）", "目录与选择"),
        new ToolInfo("select_folder", "选择项目组或项目文件夹；成功后自动同步读取该目录的 agent/skill 列表", "目录与选择"),
        new ToolInfo("get_selection", "读取当前选中的文件夹及其 agent/skill 列表", "目录与选择"),
        new ToolInfo("create_project", "新建项目：在 parent_dir 下创建文件夹（可选页签层级片段）并加入收藏（config 落盘，默认第 0 个页签，可 tab_index 指定）", "目录与创建"),
        new ToolInfo("create_group", "新建项目组：在 parent_dir 下创建文件夹（可选拷贝模板内容）并加入收藏（config 落盘，默认第 0 个页签，可 tab_index 指定）", "目录与创建"),
        new ToolInfo("list_agents", "列出指定/当前选中文件夹的 agent 列表（agent/*.md，递归）", "内容读取"),
        new ToolInfo("list_skills", "列出指定/当前选中文件夹的 skill 列表（skill/**/SKILL.md 等）", "内容读取"),
        new ToolInfo("refresh_content", "刷新当前选中文件夹的 agent/skill 列表（等价界面「刷新内容」按钮）", "内容读取"),
        new ToolInfo("create_link", "为项目创建启用的 agent 链接（.opencode/.codex/.claude 等，按「设置」勾选）指向分组（等价界面「分配项目」按钮）；自动更新链接记录", "链接管理"),
        new ToolInfo("remove_link", "删除项目的 agent 链接（.opencode/.codex/.claude 等，等价界面「取消分配」按钮），仅删链接不动内容", "链接管理"),
        new ToolInfo("list_links", "读取链接记录（link-record.json）及每条记录的有效/冲突状态", "链接管理"),
        new ToolInfo("deploy_skill", "部署 skill：无 aiAgentCmd 时本地生成 SKILL.md 骨架，有则写入请求 JSON 并启动外部 AI/MCP 代理", "部署"),
        new ToolInfo("folder_icon_set", "设置文件夹自定义图标（项目/项目组等）：从图片文件（.ico/.png/.jpg 等）写入 desktop.ini（iconAffectExplorer=true）或仅记录 GUI 映射（false）", "文件夹图标"),
        new ToolInfo("folder_icon_set_dll", "设置文件夹自定义图标：从 DLL/EXE 系统图标（如 SHELL32.dll）按索引引用，不复制文件，遵循 iconAffectExplorer 开关", "文件夹图标"),
        new ToolInfo("folder_icon_restore", "恢复文件夹默认图标：清除自定义图标，并按「本工具所加」标记精确还原 System 属性（不误清原有属性）", "文件夹图标"),
        new ToolInfo("folder_icon_get", "查询文件夹自定义图标状态：是否设置、来源（desktop.ini 引用 / GUI 映射）、System 属性标记", "文件夹图标"),
        new ToolInfo("capture_screen", "截取整个桌面（虚拟屏幕）或指定区域，保存为 PNG 并返回文件路径", "截图"),
        new ToolInfo("capture_window", "按窗口标题关键词截取指定窗口，保存为 PNG 并返回文件路径（必要时还原最小化窗口；绝不移动/缩放用户窗口）", "截图"),
        new ToolInfo("list_windows", "列出当前所有可见顶层窗口标题（可按关键词过滤），用于确定 capture_window 的目标标题", "截图"),
        new ToolInfo("pick_screen_color", "读取屏幕指定坐标或光标位置的颜色（物理像素），返回 #RRGGBB 与 RGB 分量", "截图"),
        new ToolInfo("backup_now", "立即执行一键备份：把 config 中全部项目/项目组文件夹增量同步到配置的备份目录（默认 exe 旁 backkup_项目备份 / backkup_项目组备份）；按文件大小+修改时间比对差异，是否删除多余文件由设置「只增模式」决定", "备份"),
        new ToolInfo("lock_status", "读取 ACL 保护清单：每条受保护路径的强度（防删除/防写入）、ACL 实际生效状态与配置是否一致；受保护目录中删除/改名会被系统拒绝", "保护"),
        new ToolInfo("lock_set", "设置/解除某文件夹的 ACL 保护：deny_delete 拦删除改名、deny_write 整体只读；remove=true 解除全部保护。修改后若 GUI 正在运行，GUI 需重启或刷新后可见", "保护"),
    };

    /// <summary>分组顺序（按此展示）。</summary>
    public static readonly IReadOnlyList<string> Groups =
        All.Select(t => t.Group).Distinct().ToList();
}
