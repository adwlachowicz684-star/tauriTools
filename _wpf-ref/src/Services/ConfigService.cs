using FenPeiXiangMuZu.Models;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 配置读写服务，兼容 分配项目组-config.json 原生格式。
/// 忠实复刻 PS 版数据逻辑：读取时合并默认值并兜底"默认"页签，
/// 写回时 projectTabs 用 projects 字段、groupTabs 用 groups 字段，
/// 并额外保留顶层 projects/groups 冗余快照。UTF-8 json（读带 BOM/无 BOM均兼容）。
/// </summary>
public sealed class ConfigService
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    private readonly string _configPath;
    // 保存锁：串行化写盘（多入口 SaveConfig 并发时防交错/撕裂）
    private readonly object _saveLock = new();
    // 跨进程保存锁：GUI 与 MCP 两进程并发"读-改-写"同一 config 时的互斥
    private static Mutex? _globalSaveMutex;
    private static Mutex GlobalSaveMutex => _globalSaveMutex ??= new Mutex(false, @"Global\FenPeiXiangMuZu_ConfigSave");

    /// <summary>最近一次 LoadConfig 的损坏告警（null=正常）；供 GUI 启动后写入日志区提示用户。</summary>
    public string? LastLoadWarning { get; private set; }

    public ConfigService(string configPath) => _configPath = configPath;

    /// <summary>存在磁盘上的证明（加载入口）。</summary>
    public string ConfigPath => _configPath;

    /// <summary>跨进程互斥执行；锁被遗弃时视为已获得并继续。</summary>
    private T WithGlobalLock<T>(Func<T> action)
    {
        var m = GlobalSaveMutex;
        try { m.WaitOne(); }
        catch (AbandonedMutexException) { }
        try { return action(); }
        finally { try { m.ReleaseMutex(); } catch (ApplicationException) { } }
    }

    /// <summary>
    /// 加载 config：文件缺失→返回全默认；读取/解析异常→先备份现场为 &lt;名&gt;.corrupt-*.bak，再兜底默认配置，
    /// 并记入 LastLoadWarning 供上层提示（绝不静默丢弃旧配置而不留痕）。
    /// </summary>
    public AppConfig LoadConfig()
    {
        LastLoadWarning = null;
        var cfg = new AppConfig();
        try
        {
            if (File.Exists(_configPath))
            {
                var json = WithGlobalLock(() => File.ReadAllText(_configPath));
                cfg = JsonSerializer.Deserialize<AppConfig>(json, Options) ?? new AppConfig();
            }
        }
        catch (Exception ex)
        {
            // 损坏/被占用/权限不足：备份现场 → 按默认值继续（避免打不开应用），但必须让用户知道配置曾出事
            TryBackupCorrupt(ex);
            cfg = new AppConfig();
        }
        Normalize(cfg);
        return cfg;
    }

    /// <summary>把无法解析的 config 原样复制为 .corrupt-yyyyMMddHHmmss.bak（保留人工恢复现场）。</summary>
    private void TryBackupCorrupt(Exception cause)
    {
        try
        {
            if (!File.Exists(_configPath)) return;
            var bak = _configPath + ".corrupt-" + DateTime.Now.ToString("yyyyMMddHHmmss") + ".bak";
            File.Copy(_configPath, bak, overwrite: false);
            LastLoadWarning = $"配置文件解析失败（{cause.GetType().Name}: {cause.Message}），已按默认配置启动；原文件已备份为：{Path.GetFileName(bak)}";
        }
        catch (Exception bakEx)
        {
            LastLoadWarning = $"配置文件解析失败且备份失败（{bakEx.Message}），已按默认配置启动。";
        }
    }

    /// <summary>页签兜底 + 顶层冗余迁移为"默认"页签（对应 PS 行 127-163）。</summary>
    private static void Normalize(AppConfig cfg)
    {
        // 项目页签：优先 tab；否则用顶层 projects 迁移；再否则空"默认"
        if (cfg.ProjectTabs.Count == 0)
        {
            cfg.ProjectTabs.Add(new ProjectTab { Name = "默认", Projects = Clean(cfg.LegacyProjects) });
        }
        foreach (var t in cfg.ProjectTabs)
        {
            if (string.IsNullOrWhiteSpace(t.Name)) t.Name = "页签";
            t.Projects = Clean(t.Projects);
        }

        // 项目组页签：同理
        if (cfg.GroupTabs.Count == 0)
        {
            cfg.GroupTabs.Add(new GroupTab { Name = "默认", Groups = Clean(cfg.LegacyGroups) });
        }
        foreach (var t in cfg.GroupTabs)
        {
            if (string.IsNullOrWhiteSpace(t.Name)) t.Name = "页签";
            t.Groups = Clean(t.Groups);
        }

        // 图标分组：优先 iconGroups；否则用顶层 presetIcons 迁移为"默认"分组
        if (cfg.IconGroups.Count == 0)
        {
            cfg.IconGroups.Add(new IconGroup { Name = "默认", Icons = Clean(cfg.PresetIcons) });
        }
        foreach (var g in cfg.IconGroups)
        {
            if (string.IsNullOrWhiteSpace(g.Name)) g.Name = "分组";
            g.Icons = Clean(g.Icons);
        }

        // 只去除空项，保持路径原文不动（勿补尾斜杠，否则破坏与旧格式的往返一致性）
        static List<string> Clean(List<string>? list)
        {
            list ??= new List<string>();
            return list.Where(s => !string.IsNullOrWhiteSpace(s)).ToList();
        }
    }

    /// <summary>写回 config，包含页签数组 + 顶层 projects/groups 冗余快照（活动页签选中归一化）。</summary>
    public void SaveConfig(AppConfig cfg)
    {
        Normalize(cfg);

        // 冗余快照取活动页签内容（活动索引无效则取第一个）
        var pi = (cfg.ActiveProjectTabIndex >= 0 && cfg.ActiveProjectTabIndex < cfg.ProjectTabs.Count)
            ? cfg.ActiveProjectTabIndex : 0;
        var gi = (cfg.ActiveGroupTabIndex >= 0 && cfg.ActiveGroupTabIndex < cfg.GroupTabs.Count)
            ? cfg.ActiveGroupTabIndex : 0;
        cfg.LegacyProjects = new List<string>(cfg.ProjectTabs[pi].Projects);
        cfg.LegacyGroups = new List<string>(cfg.GroupTabs[gi].Groups);
        cfg.PresetIcons = cfg.IconGroups.SelectMany(g => g.Icons).ToList();

        var json = JsonSerializer.Serialize(cfg, Options);
        // 原子写：先写临时文件再 File.Move 替换，进程中途被杀也不会留下半截 JSON。
        var dir = Path.GetDirectoryName(_configPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var tmpPath = _configPath + ".tmp";
        lock (_saveLock)
        {
            WithGlobalLock(() =>
            {
                File.WriteAllText(tmpPath, json, new System.Text.UTF8Encoding(false));
                // Move 覆盖已存在目标在 .NET Core 3.0+ / .NET 5+ 上为原子替换
                File.Move(tmpPath, _configPath, overwrite: true);
                return true;
            });
        }
    }
}