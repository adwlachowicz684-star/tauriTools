using System.IO;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>
/// MainViewModel 的新建项目/项目组 partial：设置面板「创建预设」三个目录绑定（改动即时保存）、
/// 主窗口「新建项目/新建项目组」按钮的落地实现（创建文件夹 → 加入当前活动页签 → 存盘）。
/// </summary>
public sealed partial class MainViewModel
{
    /// <summary>新建项目组的内置默认模板文件夹（未配置 createGroupTemplateDir 时使用）。</summary>
    public const string DefaultGroupTemplateDir = @"E:\_project\AIProject_opencode\_项目模板";

    // ---------------- 设置面板绑定（改动即时保存，风格对齐 BackupProjectDirText） ----------------

    /// <summary>新建项目时的预设父目录；空串 = 每次弹文件夹选择框。</summary>
    public string CreateProjectDirText
    {
        get => _config.CreateProjectDir ?? "";
        set
        {
            var v = (value ?? "").Trim();
            if (_config.CreateProjectDir == v) return;
            _config.CreateProjectDir = v;
            Raise(nameof(CreateProjectDirText));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>新建项目组时的预设父目录；空串 = 每次弹文件夹选择框。</summary>
    public string CreateGroupDirText
    {
        get => _config.CreateGroupDir ?? "";
        set
        {
            var v = (value ?? "").Trim();
            if (_config.CreateGroupDir == v) return;
            _config.CreateGroupDir = v;
            Raise(nameof(CreateGroupDirText));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>新建项目组时拷贝的模板文件夹；空串 = 使用内置默认模板（DefaultGroupTemplateDir）。</summary>
    public string CreateGroupTemplateDirText
    {
        get => _config.CreateGroupTemplateDir ?? "";
        set
        {
            var v = (value ?? "").Trim();
            if (_config.CreateGroupTemplateDir == v) return;
            _config.CreateGroupTemplateDir = v;
            Raise(nameof(CreateGroupTemplateDirText));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>新建项目/项目组时路径是否携带当前活动页签/集群层级（设置面板「创建预设」勾选；改动即落盘）。</summary>
    public bool CreatePathCarriesHierarchy
    {
        get => _config.CreatePathCarriesHierarchy;
        set
        {
            if (_config.CreatePathCarriesHierarchy == value) return;
            _config.CreatePathCarriesHierarchy = value;
            Raise(nameof(CreatePathCarriesHierarchy));
            _configSvc.SaveConfig(_config);
        }
    }

    // ---------------- 新建项目 / 项目组 ----------------

    /// <summary>新建项目：在 parentDir 下创建空文件夹并加入当前活动页签。成功 return (null, 实际完整路径)，失败 return (错误文案, null)。
    /// 落地逻辑与 MCP create_project 共用 FolderCreateService（E009 单一实现源），此处仅补 UI 卡片。</summary>
    public (string? Error, string? FullPath) CreateProjectFolder(string? name, string? parentDir)
    {
        var segment = CreatePathCarriesHierarchy ? ActiveTabSegment("project") : null;
        var (err, full) = FolderCreateService.CreateProject(_config, name, parentDir, segment, ActiveProjectTabIndex);
        if (err != null) return (err, null);
        AddCardToUI("project", full!, ActiveProjectTabIndex);
        _configSvc.SaveConfig(_config);
        Raise(nameof(GroupCount));
        Raise(nameof(ProjectCount));
        Raise(nameof(CurrentProjectCount));
        return (null, full);
    }

    /// <summary>新建项目组：在 parentDir 下创建文件夹（有模板则拷贝模板内容）并加入当前集群页签。成功 return (null, 实际完整路径)，失败 return (错误文案, null)。
    /// 落地逻辑与 MCP create_group 共用 FolderCreateService（E009 单一实现源），此处仅补 UI 卡片。</summary>
    public (string? Error, string? FullPath) CreateGroupFolder(string? name, string? parentDir)
    {
        var segment = CreatePathCarriesHierarchy ? ActiveTabSegment("group") : null;
        var template = ResolveGroupTemplateDir();
        var (err, full) = FolderCreateService.CreateGroup(_config, name, parentDir, segment, ActiveGroupTabIndex, template);
        if (err != null) return (err, null);
        AddCardToUI("group", full!, ActiveGroupTabIndex);
        _configSvc.SaveConfig(_config);
        Raise(nameof(GroupCount));
        Raise(nameof(ProjectCount));
        Raise(nameof(CurrentProjectCount));
        return (null, full);
    }

    /// <summary>解析新建目标完整路径（父目录 + 可选层级片段 + 名称）；父目录为空或不存在返回 null。</summary>
    private static string? ResolveCreateTarget(string name, string? parentDir, string? hierarchySegment = null)
        => FolderCreateService.ResolveTarget(name, parentDir, hierarchySegment);

    /// <summary>当前活动页签/集群名在 CreatePathCarriesHierarchy 开启时作为路径层级片段的取值；片段非法/页签不可用返回 null（退回不携带层级）。</summary>
    private string? ActiveTabSegment(string kind)
    {
        if (kind == "group")
        {
            if (ActiveGroupTabIndex < 0 || ActiveGroupTabIndex >= _config.GroupTabs.Count) return null;
            return SafeSegment(_config.GroupTabs[ActiveGroupTabIndex].Name);
        }
        if (ActiveProjectTabIndex < 0 || ActiveProjectTabIndex >= _config.ProjectTabs.Count) return null;
        return SafeSegment(_config.ProjectTabs[ActiveProjectTabIndex].Name);
    }

    /// <summary>把名称收敛为合法的单级目录片段；含非法路径字符、控制符、空白、"."、“..”时返回 null。</summary>
    private static string? SafeSegment(string? name) => FolderCreateService.SafeSegment(name);

    /// <summary>新建项目组使用的模板目录：配置优先，其次内置默认；模板不存在返回 null（创建空文件夹）。</summary>
    private string? ResolveGroupTemplateDir()
    {
        var t = CreateGroupTemplateDirText;
        if (string.IsNullOrWhiteSpace(t)) t = DefaultGroupTemplateDir;
        return Directory.Exists(t) ? t : null;
    }
}
