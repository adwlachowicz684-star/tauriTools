using System.IO;
using FenPeiXiangMuZu.Models;

namespace FenPeiXiangMuZu.Services;

/// <summary>一个预设 agent 链接定义：项目内使用的目录名（用于创建 junction）+ 所属厂商标注。</summary>
public sealed record LinkAgentDef(string Name, string Vendor);

/// <summary>
/// 各家 AI agent 在项目根目录下默认存放「项目 agent / skill」的目录名预设名单。
/// 建链时按「设置面板中开启」的项，在当前项目下为每一项各创建一个指向项目组根目录的 junction。
/// 名单/标注集中在代码（改名单需重编译）；开关状态存 config.linkAgents（缺失视为开启），两者解耦。
/// </summary>
public static class LinkAgentCatalog
{
    public static readonly IReadOnlyList<LinkAgentDef> All = new LinkAgentDef[]
    {
        new(".opencode", "OpenCode"),
        new(".codex", "OpenAI Codex"),
        new(".agents", "Agents"),
        new(".claude", "Claude Code"),
        new(".gemini", "Gemini"),
        new(".cursor", "Cursor"),
        new(".windsurf", "Windsurf"),
        new(".github", "GitHub Copilot"),
        new(".kiro", "Kiro"),
        new(".aider", "Aider"),
        new(".cline", "Cline"),
        new(".roo", "Roo Code"),
        new(".kilocode", "Kilo Code"),
        new(".trae", "TRAE"),
        new(".qwen", "Qwen Code"),
        new(".agent", "Agent"),
    };

    /// <summary>返回 config 中开启的链接名列表（预设 + 自定义；缺失视为开启，兼容旧配置）。</summary>
    public static List<string> EnabledNames(AppConfig cfg)
    {
        var names = All.Select(a => CurrentName(cfg, a.Name))
                       .Where(n => !cfg.LinkAgents.TryGetValue(n, out var on) || on)
                       .ToList();
        foreach (var n in CustomNames(cfg))
            if (!cfg.LinkAgents.TryGetValue(n, out var on) || on) names.Add(n);
        return names;
    }

    /// <summary>返回 config 中用户自定义的链接名列表（去重、剔除与预设当前名重复项）。</summary>
    public static List<string> CustomNames(AppConfig cfg)
    {
        var preset = All.Select(a => CurrentName(cfg, a.Name)).ToHashSet();
        return cfg.CustomLinkAgents
            .Where(n => !string.IsNullOrWhiteSpace(n) && !preset.Contains(n))
            .Distinct()
            .ToList();
    }

    /// <summary>预设项当前名：应用重命名覆盖（linkAgentRenames）；未改名返回原名。</summary>
    public static string CurrentName(AppConfig cfg, string originalName)
        => cfg.LinkAgentRenames.TryGetValue(originalName, out var n) && !string.IsNullOrWhiteSpace(n) ? n : originalName;

    /// <summary>某链接名的厂商标注：优先取覆盖（linkAgentVendors），其次预设默认，自定义缺省"自定义"。</summary>
    public static string Vendor(AppConfig cfg, string name)
    {
        if (cfg.LinkAgentVendors.TryGetValue(name, out var v) && !string.IsNullOrWhiteSpace(v)) return v;
        var def = All.FirstOrDefault(a => CurrentName(cfg, a.Name) == name);
        return def?.Vendor ?? "自定义";
    }

    /// <summary>规范化用户输入的自定义链接名：去空白、可选首字符补点、校验非法路径字符与 "."/".."。非法返回 null。</summary>
    public static string? NormalizeName(string? raw, bool prependDot = true)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var name = raw.Trim();
        if (prependDot && name[0] != '.') name = "." + name;
        // "."/".." 及任意纯点串作为 junction 目录名会破坏路径解析，必须拒绝
        if (name.TrimStart('.').Length == 0) return null;
        if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return null;
        return name;
    }

    /// <summary>编辑弹窗用规范化：prependDot=true 确保首字符为 '.'；false 去除首字符 '.'（直接切换点前缀）。非法返回 null。</summary>
    public static string? NormalizeEdit(string? raw, bool prependDot)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var name = raw.Trim();
        if (prependDot && name[0] != '.') name = "." + name;
        else if (!prependDot && name[0] == '.') name = name.TrimStart('.');
        if (name.Length == 0 || name.TrimStart('.').Length == 0) return null;
        if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return null;
        return name;
    }
}