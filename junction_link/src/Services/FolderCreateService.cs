using System.IO;
using FenPeiXiangMuZu.Models;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 新建项目/项目组的共享纯函数管线（E009 单一实现源）：
/// GUI（MainViewModel.Create）与 MCP（McpServer）共用同一套校验/解析/落库逻辑。
/// 仅操作 config 与文件系统，不触碰任何 UI 对象；config 落盘由调用方在成功后执行。
/// </summary>
public static class FolderCreateService
{
    /// <summary>校验目录新名（改名/新建共用）：非空、非 ./..、不以空格或句点结尾、无非法字符。返回错误文案或 null。</summary>
    public static string? ValidateName(string? raw)
    {
        var name = (raw ?? "").Trim();
        if (name.Length == 0) return "名称不能为空。";
        if (name is "." or "..") return "名称非法。";
        if (name.EndsWith(" ") || name.EndsWith(".")) return "名称不能以空格或句点结尾。";
        foreach (var c in name)
        {
            if (c == '\\' || c == '/' || c == ':' || Path.GetInvalidFileNameChars().Contains(c))
                return $"新名称含非法字符「{c}」。";
        }
        return null;
    }

    /// <summary>把名称收敛为合法的单级目录片段；含非法路径字符、控制符、空白、"."、“..”时返回 null。</summary>
    public static string? SafeSegment(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var s = name!.Trim();
        if (s == "." || s == "..") return null;
        if (s.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return null;
        return s;
    }

    /// <summary>解析新建目标完整路径（父目录 + 可选层级片段 + 名称）；父目录为空或不存在返回 null。</summary>
    public static string? ResolveTarget(string name, string? parentDir, string? hierarchySegment = null)
    {
        if (string.IsNullOrWhiteSpace(parentDir)) return null;
        if (!Directory.Exists(parentDir)) return null;
        var parent = Path.TrimEndingDirectorySeparator(Path.GetFullPath(parentDir));
        if (!string.IsNullOrEmpty(hierarchySegment))
            parent = Path.Combine(parent, hierarchySegment);
        return Path.Combine(parent, name);
    }

    /// <summary>跨页签去重：任一已收藏路径与 full 规范化路径相等即视为重复。</summary>
    public static bool FindDuplicate(IEnumerable<List<string>> tabs, string full)
    {
        foreach (var list in tabs)
        {
            if (list.Any(p => string.Equals(
                    Path.TrimEndingDirectorySeparator(p),
                    Path.TrimEndingDirectorySeparator(full),
                    StringComparison.OrdinalIgnoreCase)))
                return true;
        }
        return false;
    }

    /// <summary>新建项目：校验 → 解析目标 → 查重/查存在 → 建文件夹 → 加入指定页签（不落盘）。
    /// 成功 return (null, 实际完整路径)，失败 return (错误文案, null)。</summary>
    public static (string? Error, string? FullPath) CreateProject(
        AppConfig cfg, string? name, string? parentDir, string? hierarchySegment, int tabIndex)
    {
        var vErr = ValidateName(name);
        if (vErr != null) return (vErr, null);
        var full = ResolveTarget(name!.Trim(), parentDir, hierarchySegment);
        if (full == null) return ("父目录不能为空。", null);
        if (tabIndex < 0 || tabIndex >= cfg.ProjectTabs.Count) return ("无效的项目页签。", null);
        if (FindDuplicate(cfg.ProjectTabs.Select(t => t.Projects), full)) return ($"已在收藏中存在: {full}", null);
        if (Directory.Exists(full) || File.Exists(full)) return ($"已存在同名文件夹: {full}", null);

        try
        {
            FolderLockService.WithUnlockForPath(full, () => Directory.CreateDirectory(full));
        }
        catch (Exception ex) { return ($"创建文件夹失败: {ex.Message}", null); }

        cfg.ProjectTabs[tabIndex].Projects.Add(full);
        return (null, full);
    }

    /// <summary>新建项目组：语义同 CreateProject，另支持可选模板目录（存在则递归拷贝；为空建空文件夹）。</summary>
    public static (string? Error, string? FullPath) CreateGroup(
        AppConfig cfg, string? name, string? parentDir, string? hierarchySegment, int tabIndex, string? templateDir)
    {
        var vErr = ValidateName(name);
        if (vErr != null) return (vErr, null);
        var full = ResolveTarget(name!.Trim(), parentDir, hierarchySegment);
        if (full == null) return ("父目录不能为空。", null);
        if (tabIndex < 0 || tabIndex >= cfg.GroupTabs.Count) return ("无效的项目组页签。", null);
        if (FindDuplicate(cfg.GroupTabs.Select(t => t.Groups), full)) return ($"已在收藏中存在: {full}", null);
        if (Directory.Exists(full) || File.Exists(full)) return ($"已存在同名文件夹: {full}", null);

        try
        {
            FolderLockService.WithUnlockForPath(full, () =>
            {
                if (!string.IsNullOrEmpty(templateDir) && Directory.Exists(templateDir))
                    CopyDirectoryRecursive(templateDir, full);
                else
                    Directory.CreateDirectory(full);
            });
        }
        catch (Exception ex) { return ($"创建项目组失败: {ex.Message}", null); }

        cfg.GroupTabs[tabIndex].Groups.Add(full);
        return (null, full);
    }

    /// <summary>递归复制目录内容到目标（目标目录由调用方保证不存在）。</summary>
    private static void CopyDirectoryRecursive(string src, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var dir in Directory.GetDirectories(src, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(dest, Path.GetRelativePath(src, dir)));
        foreach (var file in Directory.GetFiles(src, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(src, file);
            File.Copy(file, Path.Combine(dest, rel), overwrite: true);
        }
    }
}
