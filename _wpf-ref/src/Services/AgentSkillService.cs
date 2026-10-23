using System.Diagnostics;
using System.IO;
using FenPeiXiangMuZu.Models;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 「Agent/Skill 内容浏览区」服务：枚举项目组下的 agent / skill 资源、打开目录、读取文件预览。
/// 语义与 opencode 加载规则对齐。
/// </summary>
public static class AgentSkillService
{
    public const string AgentDirName = "agent";
    public const string AgentDirsDirName = "agents";
    public const string SkillDirName = "skill";
    public const string SkillDirsDirName = "skills";
    public const string RuleDirName = "rule";
    public const string RuleDirsDirName = "rules";
    public const string SkillMarkdownName = "SKILL.md";
    private const int PreviewMaxLength = 20000;

    /// <summary>groupRoot 下 agent 目录绝对路径（优先复数 agents，其次单数 agent）；不存在返回 null。</summary>
    public static string? AgentDir(string groupRoot)
    {
        var plural = Path.Combine(groupRoot, AgentDirsDirName);
        if (Directory.Exists(plural)) return plural;
        var singular = Path.Combine(groupRoot, AgentDirName);
        return Directory.Exists(singular) ? singular : null;
    }

    /// <summary>groupRoot 下 skill 目录绝对路径（优先复数 skills，其次单数 skill）；不存在返回 null。</summary>
    public static string? SkillDir(string groupRoot)
    {
        var plural = Path.Combine(groupRoot, SkillDirsDirName);
        if (Directory.Exists(plural)) return plural;
        var singular = Path.Combine(groupRoot, SkillDirName);
        return Directory.Exists(singular) ? singular : null;
    }

    /// <summary>groupRoot 下实际存在的规则目录（rules 与 rule 可并存，按 复数→单数 顺序）；均不存在返回空表。</summary>
    public static IReadOnlyList<string> RuleDirs(string groupRoot)
    {
        var dirs = new List<string>();
        var plural = Path.Combine(groupRoot, RuleDirsDirName);
        if (Directory.Exists(plural)) dirs.Add(plural);
        var singular = Path.Combine(groupRoot, RuleDirName);
        if (Directory.Exists(singular)) dirs.Add(singular);
        return dirs;
    }

    /// <summary>
    /// 枚举项目组某类资源。kind 为 "agent"、"skill" 或 "rule"。
    ///   - agent：&lt;group&gt;/agent/**/*.md，递归多级；
    ///   - skill：&lt;group&gt;/skill/*.md（根部单文件 skill）+ &lt;group&gt;/skill/**/SKILL.md（SKILL.md 所在目录即一个 skill）；
    ///   - rule：&lt;group&gt;/rules|rule/**/*.md，递归多级；两目录并存时 RelPath 加目录名前缀形成两个顶层分支。
    /// 相对路径统一为反斜杠分隔。目录类 skill（SourcePath 为目录）按目录树节点展示。
    /// </summary>
    public static IReadOnlyList<AgentSkillItem> Enumerate(string groupRoot, string kind)
    {
        if (string.IsNullOrWhiteSpace(groupRoot)) return System.Array.Empty<AgentSkillItem>();
        return string.Equals(kind, "agent", StringComparison.OrdinalIgnoreCase) ? EnumerateAgents(groupRoot)
             : string.Equals(kind, "rule", StringComparison.OrdinalIgnoreCase) ? EnumerateRules(groupRoot)
             : EnumerateSkills(groupRoot);
    }

    private static IReadOnlyList<AgentSkillItem> EnumerateAgents(string groupRoot)
    {
        var list = new List<AgentSkillItem>();
        var dir = AgentDir(groupRoot);
        if (dir == null) return list;
        // IgnoreInaccessible：跳过无权限子目录，避免个别目录拒绝访问导致整树枚举失败
        var opts = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            RecurseSubdirectories = true,
        };
        foreach (var f in Directory.EnumerateFiles(dir, "*.md", opts))
        {
            var rel = Backslash(Path.GetRelativePath(dir, f));
            list.Add(new AgentSkillItem("agent", rel, f));
        }
        list.Sort((a, b) => string.Compare(a.RelPath, b.RelPath, StringComparison.OrdinalIgnoreCase));
        return list;
    }

    private static IReadOnlyList<AgentSkillItem> EnumerateRules(string groupRoot)
    {
        var list = new List<AgentSkillItem>();
        var dirs = RuleDirs(groupRoot);
        if (dirs.Count == 0) return list;
        // IgnoreInaccessible：跳过无权限子目录，避免个别目录拒绝访问导致整树枚举失败
        var opts = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            RecurseSubdirectories = true,
        };
        foreach (var dir in dirs)
        {
            // rules 与 rule 并存时加目录名前缀，建树后自然形成两个顶层分支；单目录时与 agent 一致直接作根
            var prefix = dirs.Count > 1 ? Backslash(Path.GetFileName(dir)) + "\\" : "";
            foreach (var f in Directory.EnumerateFiles(dir, "*.md", opts))
            {
                var rel = prefix + Backslash(Path.GetRelativePath(dir, f));
                list.Add(new AgentSkillItem("rule", rel, f));
            }
        }
        list.Sort((a, b) => string.Compare(a.RelPath, b.RelPath, StringComparison.OrdinalIgnoreCase));
        return list;
    }

    private static IReadOnlyList<AgentSkillItem> EnumerateSkills(string groupRoot)
    {
        var list = new List<AgentSkillItem>();
        var dir = SkillDir(groupRoot);
        if (dir == null) return list;

        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); // rel -> source
        // 1) 根部直接 *.md（单文件 skill，name = 基名）
        foreach (var f in Directory.EnumerateFiles(dir, "*.md", SearchOption.TopDirectoryOnly))
            map.TryAdd(Backslash(Path.GetFileName(f)), f);
        // 2) 任意深度 SKILL.md → 其所在目录为一个 skill（name = 目录相对路径）
        var opts = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            RecurseSubdirectories = true,
        };
        foreach (var f in Directory.EnumerateFiles(dir, SkillMarkdownName, opts))
        {
            var relDir = Backslash(Path.GetRelativePath(dir, Path.GetDirectoryName(f)!));
            if (string.IsNullOrEmpty(relDir)) continue; // 根 SKILL.md（被上面 1 覆盖）
            map.TryAdd(relDir, Path.GetDirectoryName(f)!);
        }

        foreach (var kv in map)
            list.Add(new AgentSkillItem("skill", kv.Key, kv.Value));
        list.Sort((a, b) => string.Compare(a.RelPath, b.RelPath, StringComparison.OrdinalIgnoreCase));
        return list;
    }

    private static string Backslash(string path) => path.Replace('/', '\\');

    /// <summary>用资源管理器打开目录；dir 为空或不存在则静默返回。</summary>
    public static void OpenDir(string dir)
    {
        if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir)) return;
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", dir) { UseShellExecute = true });
        }
        catch
        {
            // 静默：打开目录失败不打扰用户，浏览区仍可用预览/列表
        }
    }

    /// <summary>用系统默认程序打开文件；路径为空/不存在/失败均静默返回。</summary>
    public static void OpenFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return;
        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch
        {
            // 静默：无关联程序等场景不打扰用户
        }
    }

    /// <summary>预览区「打开编辑」：用配置的编辑器程序打开文件。ArgumentList 传参规避 CRT 引用规则陷阱
    /// （AI_ERRATA E011）；编辑器未配置/不存在或启动失败均回退系统默认关联程序。</summary>
    public static void OpenWithEditor(string editorPath, string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return;
        if (string.IsNullOrWhiteSpace(editorPath) || !File.Exists(editorPath)) { OpenFile(path); return; }
        try
        {
            var psi = new ProcessStartInfo { FileName = editorPath, UseShellExecute = false };
            psi.ArgumentList.Add(path);
            Process.Start(psi);
        }
        catch
        {
            OpenFile(path);
        }
    }

    /// <summary>资源管理器打开所在文件夹：目录直接打开，文件定位并高亮（/select）；失败静默。</summary>
    public static void OpenFolderOf(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            if (Directory.Exists(path))
                Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true });
            else if (File.Exists(path))
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
        }
        catch
        {
            // 静默
        }
    }

    /// <summary>读取文件文本预览；超长截断。文件不存在/读取失败返回空串。</summary>
    public static string ReadPreview(string filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath)) return string.Empty;
        try
        {
            var text = File.ReadAllText(filePath);
            if (text.Length > PreviewMaxLength)
                text = text[..PreviewMaxLength] + "\n\n…（内容过长，已截断）";
            return text;
        }
        catch
        {
            return string.Empty;
        }
    }
}