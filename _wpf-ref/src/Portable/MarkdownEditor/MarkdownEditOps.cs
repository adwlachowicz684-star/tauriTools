namespace FenPeiXiangMuZu.Portable.MarkdownEditor;

/// <summary>
/// Markdown 编辑器工具栏的纯文本操作（不依赖 UI，便于单测与移植）。
/// 所有方法返回 (新文本, 新光标位置)；对选区为空的行为 = 在光标处插入并在标记内部放置光标便于输入。
/// </summary>
public static class MarkdownEditOps
{
    public readonly record struct Result(string Text, int Caret);

    /// <summary>用左右包络包裹选中文本；选区为空则在光标处插入标记对并把光标放到中间。</summary>
    public static Result Wrap(string text, int selStart, int selLength, string pre, string post)
    {
        selStart = Math.Clamp(selStart, 0, text.Length);
        selLength = Math.Clamp(selLength, 0, text.Length - selStart);
        var sel = text.Substring(selStart, selLength);
        var newText = text.Remove(selStart, selLength).Insert(selStart, pre + sel + post);
        var inner = selStart + pre.Length;
        var caret = selLength == 0 ? inner : inner + sel.Length + post.Length;
        return new Result(newText, caret);
    }

    /// <summary>把选区覆盖到的每行加/去行首前缀（标题层级的 #、无序 -、引用 &gt; 等）。空选区=操作当前行。</summary>
    public static Result ToggleLinePrefix(string text, int selStart, int selLength, string prefix)
    {
        selStart = Math.Clamp(selStart, 0, text.Length);
        selLength = Math.Clamp(selLength, 0, text.Length - selStart);
        int start = 0, end = text.Length;
        if (text.Length > 0)
        {
            int lineStart = text.LastIndexOf('\n', Math.Max(0, selStart - 1));
            start = lineStart < 0 ? 0 : lineStart + 1;
            int areaEnd = selLength == 0 ? selStart : selStart + selLength;
            int lineEnd = text.IndexOf('\n', areaEnd);
            end = lineEnd < 0 ? text.Length : lineEnd; // 不含结尾换行，避免整段错位
            // 若选区正好结束在一行末尾，把末尾一起纳入再切割
            if (selLength > 0)
            {
                int probe = text.IndexOf('\n', Math.Max(0, areaEnd - 1));
                if (probe == areaEnd - 1) end = areaEnd;
            }
        }

        var sb = new System.Text.StringBuilder();
        bool toggledAny = false;
        int lineStartPos = start;
        var span = text.AsSpan();
        while (lineStartPos <= end)
        {
            int nl = span[lineStartPos..end].IndexOf('\n');
            int lsEnd = nl < 0 ? end : lineStartPos + nl;
            var line = span[lineStartPos..lsEnd];
            bool has = line.StartsWith(prefix, StringComparison.Ordinal);
            sb.Append(has ? line[prefix.Length..].ToString() : prefix + line.ToString());
            toggledAny |= has;
            if (lsEnd < end) sb.Append('\n');
            lineStartPos = lsEnd + 1;
        }
        _ = toggledAny;

        return new Result(text.Remove(start, end - start).Insert(start, sb.ToString()), selStart);
    }

    /// <summary>在光标处插入一段纯文本。</summary>
    public static Result InsertAt(string text, int caret, string snippet)
    {
        caret = Math.Clamp(caret, 0, text.Length);
        return new Result(text.Insert(caret, snippet), caret + snippet.Length);
    }

    /// <summary>生成 rows×cols 的管道表格骨架（含表头 + 分隔行 + 数据行）。</summary>
    public static string BuildTable(int rows = 3, int cols = 3)
    {
        var c = Math.Max(2, cols);
        var r = Math.Max(2, rows);
        var sb = new System.Text.StringBuilder();
        sb.Append("| ");
        sb.Append(string.Join(" | ", Enumerable.Range(1, c).Select(i => "列" + i)));
        sb.Append(" |\n| ");
        sb.Append(string.Join(" | ", Enumerable.Repeat("---", c)));
        sb.Append(" |\n");
        for (int i = 0; i < r - 1; i++)
        {
            sb.Append("| ");
            sb.Append(string.Join(" | ", Enumerable.Repeat(" ", c)));
            sb.Append(" |\n");
        }
        return sb.ToString();
    }

    /// <summary>求光标所在行号（0 基）与列号（0 基）。</summary>
    public static (int Line, int Col) LineCol(string text, int caret)
    {
        caret = Math.Clamp(caret, 0, text.Length);
        int line = 0, lastNl = -1;
        for (int i = 0; i < caret; i++)
            if (text[i] == '\n')
            {
                line++;
                lastNl = i;
            }
        return (line, caret - lastNl - 1);
    }
}