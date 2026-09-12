using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace FenPeiXiangMuZu.Services;

/// <summary>一张画布：kityminder 原始内容（exportJson 文本）+ 该画布自己的主题 / 布局。</summary>
public sealed class MindMapSheetData
{
    /// <summary>画布稳定 Id（跨保存/导入保持不变，用于激活态与标签定位）。</summary>
    public string Id { get; set; } = "";

    /// <summary>画布显示名（XMind 里叫「画布名 / sheet title」）。</summary>
    public string Title { get; set; } = "画布 1";

    /// <summary>kityminder exportJson 的 JSON 文本；null/空表示空画布。</summary>
    public string? Content { get; set; }

    /// <summary>该画布当前配色主题（内置主题名或自定义主题 Id）。</summary>
    public string Theme { get; set; } = MindMapWorkbook.DefaultTheme;

    /// <summary>该画布当前布局模板（default/right/filetree/structure/fish-bone/tianpan）。</summary>
    public string Layout { get; set; } = MindMapWorkbook.DefaultLayout;

    public MindMapSheetData Clone() => new()
    {
        Id = Id,
        Title = Title,
        Content = Content,
        Theme = Theme,
        Layout = Layout,
    };
}

/// <summary>一本脑图（对应一个 .xmind 文件 / 本机当前工作集）：多张画布 + 当前激活画布 Id。</summary>
public sealed class MindMapWorkbook
{
    public const string DefaultTheme = "fresh-blue";
    public const string DefaultLayout = "default";

    public List<MindMapSheetData> Sheets { get; set; } = new();

    /// <summary>当前激活画布 Id；空/无效时按第一张处理。</summary>
    public string? ActiveId { get; set; }

    /// <summary>激活画布（找不到时回退第一张）。</summary>
    public MindMapSheetData? Active => Sheets.FirstOrDefault(s => s.Id == ActiveId) ?? Sheets.FirstOrDefault();
}

/// <summary>画布集合的常用操作：建 Id、空画布内容、规范化（补齐/去重/迁移）。</summary>
public static class MindMapWorkbookOps
{
    /// <summary>
    /// 缩进序列化 JsonNode。不用 ToJsonString(options)：.NET 8 下传入自定义 JsonSerializerOptions 时，
    /// JsonValueCustomized 节点（如 long/double）会因 options 无 TypeInfoResolver 抛 InvalidOperationException。
    /// </summary>
    internal static string PrettyText(JsonNode node)
    {
        using var ms = new System.IO.MemoryStream();
        using (var writer = new System.Text.Json.Utf8JsonWriter(ms, new System.Text.Json.JsonWriterOptions { Indented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
            node.WriteTo(writer);
        return System.Text.Encoding.UTF8.GetString(ms.ToArray());
    }

    /// <summary>新画布 Id（短、稳定、无特殊字符）。</summary>
    public static string NewSheetId() => "sh" + Guid.NewGuid().ToString("N")[..10];

    private static string NewNodeId() => "km" + Guid.NewGuid().ToString("N")[..10];

    /// <summary>空画布内容：只有一个根节点（kityminder importJson 可直接吃）。</summary>
    public static string EmptyContent(string? rootText = null)
    {
        var node = new JsonObject
        {
            ["root"] = new JsonObject
            {
                ["data"] = new JsonObject
                {
                    ["id"] = NewNodeId(),
                    ["created"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ["text"] = string.IsNullOrWhiteSpace(rootText) ? "中心主题" : rootText,
                },
                ["children"] = new JsonArray(),
            },
            ["template"] = MindMapWorkbook.DefaultLayout,
            ["theme"] = MindMapWorkbook.DefaultTheme,
            ["version"] = "1.4.43",
        };
        return PrettyText(node);
    }

    /// <summary>把任意来源的画布列表规范化：空→建一张；Id 空/重复→补发；Title 空→按序号命名。</summary>
    public static List<MindMapSheetData> Normalize(IEnumerable<MindMapSheetData>? sheets, string? activeId = null)
    {
        var list = (sheets ?? Enumerable.Empty<MindMapSheetData>())
            .Where(s => s is not null)
            .Select(s => s.Clone())
            .ToList();

        if (list.Count == 0) list.Add(NewSheet("画布 1"));

        var used = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < list.Count; i++)
        {
            var s = list[i];
            if (string.IsNullOrWhiteSpace(s.Id) || !used.Add(s.Id)) s.Id = NewSheetId();
            if (string.IsNullOrWhiteSpace(s.Title)) s.Title = "画布 " + (i + 1);
            if (string.IsNullOrWhiteSpace(s.Theme)) s.Theme = MindMapWorkbook.DefaultTheme;
            if (string.IsNullOrWhiteSpace(s.Layout)) s.Layout = MindMapWorkbook.DefaultLayout;
        }

        // 激活 Id 无效时回退第一张
        if (string.IsNullOrWhiteSpace(activeId) || !list.Any(s => s.Id == activeId))
            activeId = list[0].Id;
        return list;
    }

    /// <summary>新建一张空画布（标题可按现有数量顺延）。</summary>
    public static MindMapSheetData NewSheet(string title, string? theme = null, string? layout = null)
        => new()
        {
            Id = NewSheetId(),
            Title = string.IsNullOrWhiteSpace(title) ? "画布" : title,
            Content = null,
            Theme = string.IsNullOrWhiteSpace(theme) ? MindMapWorkbook.DefaultTheme : theme,
            Layout = string.IsNullOrWhiteSpace(layout) ? MindMapWorkbook.DefaultLayout : layout,
        };

    /// <summary>下一个不重复的画布名：画布 N（N 取现有最大序号 +1，且避开同名）。</summary>
    public static string NextTitle(IEnumerable<MindMapSheetData> sheets, string prefix = "画布")
    {
        var names = sheets.Select(s => s.Title).ToHashSet(StringComparer.Ordinal);
        var max = 0;
        foreach (var t in names)
        {
            if (t.StartsWith(prefix, StringComparison.Ordinal) &&
                int.TryParse(t.AsSpan(prefix.Length).Trim(), out var n) && n > max)
                max = n;
        }
        for (var i = max + 1; i < 100000; i++)
        {
            var cand = prefix + " " + i;
            if (!names.Contains(cand)) return cand;
        }
        return prefix + " " + DateTime.Now.ToString("HHmmss");
    }

    /// <summary>序列化为多画布 JSON 包（导出 .json 且画布数 &gt; 1 时使用；导入端按 sheets 字段识别）。</summary>
    public static string SerializeWorkbook(MindMapWorkbook book)
    {
        var obj = new JsonObject
        {
            ["kind"] = "kityminder-workbook",
            ["version"] = 1,
            ["activeId"] = book.ActiveId,
            ["sheets"] = new JsonArray(book.Sheets.Select(s => new JsonObject
            {
                ["id"] = s.Id,
                ["title"] = s.Title,
                ["theme"] = s.Theme,
                ["layout"] = s.Layout,
                ["content"] = s.Content,
            }).Cast<JsonNode?>().ToArray()),
        };
        return PrettyText(obj);
    }

    /// <summary>尝试按多画布 JSON 包解析；不是包格式返回 null（调用方按单画布内容处理）。</summary>
    public static MindMapWorkbook? TryParseWorkbook(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        JsonNode? root;
        try { root = JsonNode.Parse(text); }
        catch { return null; }
        if (root is not JsonObject obj) return null;
        if (obj["sheets"] is not JsonArray arr || arr.Count == 0) return null;

        var sheets = new List<MindMapSheetData>();
        foreach (var item in arr)
        {
            if (item is not JsonObject so) continue;
            sheets.Add(new MindMapSheetData
            {
                Id = so["id"]?.GetValue<string>() ?? "",
                Title = so["title"]?.GetValue<string>() ?? "",
                Theme = so["theme"]?.GetValue<string>() ?? MindMapWorkbook.DefaultTheme,
                Layout = so["layout"]?.GetValue<string>() ?? MindMapWorkbook.DefaultLayout,
                // content 是 JSON 字符串字面量：GetValue 直接取原文，避免 ToJsonString 重转义破坏逐字快照
                Content = so["content"] is JsonValue v && v.TryGetValue<string>(out var s) ? s
                        : so["content"] is JsonNode c ? c.ToJsonString() : null,
            });
        }
        if (sheets.Count == 0) return null;
        return new MindMapWorkbook { Sheets = sheets, ActiveId = obj["activeId"]?.GetValue<string>() };
    }
}
