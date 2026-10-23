using System;
using System.IO;
using System.Text.Json;

namespace FenPeiXiangMuZu.Services;

/// <summary>脑图自动保存的状态：多张画布（各自的内容/主题/布局）+ 当前激活画布；
/// 旧版单画布字段（Content/Theme/Layout）保留用于向后兼容读旧档。</summary>
public sealed class MindMapState
{
    /// <summary>全部画布（多画布模式下为主数据）。null/空 = 由旧版 Content 迁移出一张。</summary>
    public List<MindMapSheetData>? Sheets { get; set; }

    /// <summary>当前激活画布 Id。</summary>
    public string? ActiveSheetId { get; set; }

    /// <summary>【旧版兼容】单画布内容（kityminder exportJson 的 JSON 文本）；多画布模式下同步写入当前画布内容。</summary>
    public string? Content { get; set; }

    /// <summary>【旧版兼容】当前配色主题（内置主题名或自定义主题 Id）。</summary>
    public string Theme { get; set; } = "fresh-blue";

    /// <summary>【旧版兼容】当前布局模板（default/right/filetree/structure/fish-bone/tianpan）。</summary>
    public string Layout { get; set; } = "default";

    /// <summary>规范化后的画布列表：无 Sheets 时由旧版 Content 迁移出一张；Id/Title/主题/布局缺失时补齐。</summary>
    public List<MindMapSheetData> GetSheets()
    {
        if (Sheets is { Count: > 0 })
            return MindMapWorkbookOps.Normalize(Sheets, ActiveSheetId);

        var legacy = new MindMapSheetData
        {
            Id = MindMapWorkbookOps.NewSheetId(),
            Title = "画布 1",
            Content = Content,
            Theme = string.IsNullOrWhiteSpace(Theme) ? MindMapWorkbook.DefaultTheme : Theme,
            Layout = string.IsNullOrWhiteSpace(Layout) ? MindMapWorkbook.DefaultLayout : Layout,
        };
        return MindMapWorkbookOps.Normalize(new[] { legacy }, legacy.Id);
    }

    /// <summary>规范化后的激活画布 Id（GetSheets 之后调用才可靠）。</summary>
    public string GetActiveSheetId(List<MindMapSheetData>? normalized = null)
    {
        var list = normalized ?? GetSheets();
        if (!string.IsNullOrWhiteSpace(ActiveSheetId) && list.Any(s => s.Id == ActiveSheetId))
            return ActiveSheetId!;
        return list.Count > 0 ? list[0].Id : "";
    }
}

/// <summary>
/// 脑图自动保存持久化：<数据目录>/mindmap-state.json（原子写 tmp→move，进程内锁串行化）。
/// 写路径走严格读取：文件存在但读取失败必须抛错中止，绝不基于空数据覆盖清空旧内容。
/// </summary>
public static class MindMapStateStore
{
    private static readonly object _lock = new();
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    private static string BaseFile => Path.Combine(App.DataDir, "mindmap-state.json");

    /// <summary>宽松读取（供恢复展示）：文件不存在 → null；存在但损坏 → 备份现场后返回 null。</summary>
    public static MindMapState? Load()
    {
        try { return LoadStrict(); }
        catch { return null; }
    }

    /// <summary>严格读取：文件不存在 → null；存在但读取/解析失败 → 保留现场(.corrupt-*)并抛出。</summary>
    internal static MindMapState? LoadStrict()
    {
        var file = BaseFile;
        if (!File.Exists(file)) return null;
        try
        {
            using var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
            return JsonSerializer.Deserialize<MindMapState>(fs, Json);
        }
        catch
        {
            try
            {
                var bak = file + ".corrupt-" + DateTime.Now.ToString("yyyyMMddHHmmss") + ".bak";
                File.Copy(file, bak, overwrite: true);
            }
            catch { }
            throw;
        }
    }

    /// <summary>保存脑图状态（原子写 tmp→move）。</summary>
    public static void Save(MindMapState state)
    {
        lock (_lock)
        {
            var file = BaseFile;
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var tmp = file + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(state, Json));
            File.Move(tmp, file, overwrite: true);
        }
    }
}
