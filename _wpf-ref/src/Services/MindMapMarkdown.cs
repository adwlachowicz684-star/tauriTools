using System.Text;
using System.Text.Json.Nodes;

namespace FenPeiXiangMuZu.Services;

/// <summary>kityminder JSON → Markdown 大纲转换。
/// 用 # 标题层级表达各层级节点（一级标题=中心主题，# 级数随深度增加），
/// 节点附带备注时在其标题后追加引用块。用于「导出 markdown」。</summary>
public static class MindMapMarkdown
{
    /// <summary>把一张画布的 kityminder exportJson 文本转为 Markdown；空/非法返回 null。</summary>
    public static string? ToMarkdown(string? content)
    {
        if (string.IsNullOrWhiteSpace(content)) return null;
        JsonNode? root;
        try { root = JsonNode.Parse(content); }
        catch { return null; }
        var kmRoot = (root as JsonObject)?["root"] as JsonObject;
        if (kmRoot is null) return null;

        var sb = new StringBuilder();
        AppendNode(sb, kmRoot, 1);
        return sb.ToString();
    }

    /// <summary>单画布导出：把全部画布依次转 Markdown，画布间用分隔线隔开并附画布名。</summary>
    public static string ToMarkdownWorkbook(IReadOnlyList<MindMapSheetData> sheets)
    {
        var sb = new StringBuilder();
        if (sheets.Count <= 1)
        {
            var s = ToMarkdown(sheets.FirstOrDefault()?.Content);
            return s ?? "# （空画布）\n";
        }

        var index = 0;
        foreach (var sheet in sheets)
        {
            index++;
            if (index > 1) sb.AppendLine();
            sb.AppendLine($"---");
            sb.AppendLine();
            sb.AppendLine($"## 画布：{sheet.Title}");
            sb.AppendLine();
            var s = ToMarkdown(sheet.Content);
            sb.Append(s ?? "# （空画布）\n");
        }
        return sb.ToString();
    }

    private static void AppendNode(StringBuilder sb, JsonObject node, int depth)
    {
        var data = node["data"] as JsonObject;
        var text = data?["text"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrWhiteSpace(text)) text = "（空节点）";

        // 一级标题为中心主题；层级按深度映射 # 数，最深 6 级后按相同缩进继续
        var heading = new string('#', Math.Min(depth, 6));
        sb.Append(heading).Append(' ').Append(text);

        var note = data?["note"] is JsonValue nv && nv.TryGetValue<string>(out var n) ? n : null;
        if (!string.IsNullOrWhiteSpace(note))
        {
            sb.AppendLine();
            foreach (var line in note.Replace("\r\n", "\n").Split('\n'))
                sb.Append("  > ").Append(line.TrimEnd()).AppendLine();
        }
        else
        {
            sb.AppendLine();
        }

        if (node["children"] is JsonArray children)
        {
            foreach (var c in children)
            {
                if (c is JsonObject co) AppendNode(sb, co, depth + 1);
            }
        }
    }
}