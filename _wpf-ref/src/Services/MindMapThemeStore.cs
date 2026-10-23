using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 自定义思维导图主题的配色数据。字段与 kityminder 扁平主题 key 一一对应
/// （如 连线→connect-color、中央节点→root-background 等），由 JS 侧扁平化注册。
/// </summary>
public sealed class MindMapThemePalette
{
    public string Background { get; set; } = "#FBFBFB";     // 整图背景  -> background
    public string ConnectColor { get; set; } = "#4A90D9";   // 连线       -> connect-color
    public int ConnectWidth { get; set; } = 2;              // 连线粗细   -> connect-width
    public string RootBackground { get; set; } = "#4A90D9"; // 中央节点   -> root-background
    public int RootFontSize { get; set; } = 16;             //            -> root-font-size
    public string MainBackground { get; set; } = "#DCE9F7"; // 二级节点   -> main-background
    public int MainFontSize { get; set; } = 14;             //            -> main-font-size
    public string SubBackground { get; set; } = "#FFFFFF";  // 子级节点   -> sub-background
    public int SubFontSize { get; set; } = 12;              //            -> sub-font-size
    public string TextColor { get; set; } = "#333333";      // 节点文字   -> &lt;t&gt;-color
    public string SelectedColor { get; set; } = "#2B6CB0";  // 选中高亮   -> selected-stroke
    public string RootStroke { get; set; } = "#4A90D9";     // 中央节点边框 -> root-stroke
    public int RootStrokeWidth { get; set; } = 0;           // 中央节点边框粗细 -> root-stroke-width
    public int RootRadius { get; set; } = 5;                // 中央节点圆角 -> root-radius
    public string MainStroke { get; set; } = "#DCE9F7";     // 二级节点边框 -> main-stroke
    public int MainStrokeWidth { get; set; } = 0;           // 二级节点边框粗细 -> main-stroke-width
    public int MainRadius { get; set; } = 3;                // 二级节点圆角 -> main-radius
    public string SubStroke { get; set; } = "#FFFFFF";      // 子级节点边框 -> sub-stroke
    public int SubStrokeWidth { get; set; } = 0;            // 子级节点边框粗细 -> sub-stroke-width
    public int SubRadius { get; set; } = 5;                 // 子级节点圆角 -> sub-radius

    // ---- 布局间距（兄弟节点纵向间隔 *-space 与 父子节点横向间距 *-margin）。
    //      旧版自主题缺这几个键，内核读到 undefined 按 0 处理，导致所有节点上下/左右贴死。----
    public int RootSpace { get; set; } = 10;                // 一级分支之间的纵向间隔  -> root-space
    public int MainSpace { get; set; } = 5;                 // 二级分支之间的纵向间隔  -> main-space
    public int SubSpace { get; set; } = 5;                  // 子级节点之间的纵向间隔  -> sub-space
    public int MainMargin { get; set; } = 20;               // 父节点到二级分支的左右间距 -> main-margin
    public int SubMargin { get; set; } = 20;                // 二级分支到子级节点的左右间距 -> sub-margin
}

/// <summary>一个自定义主题：Id 唯一（custom- 前缀），Name 为显示名。</summary>
public sealed class MindMapTheme
{
    public string Id { get; set; } = "custom-" + Guid.NewGuid().ToString("N")[..8];
    public string Name { get; set; } = "新建主题";
    public MindMapThemePalette Palette { get; set; } = new();
}

/// <summary>
/// 自定义思维导图主题库：持久化到《数据目录》mindmap-themes.json（原子写 tmp→move，进程内锁串行化）。
/// 写路径一律走严格读取 <see cref="LoadStrict"/>：文件存在但读取失败必须抛错中止，绝不基于空集合覆盖清空旧数据。
/// </summary>
public static class MindMapThemeStore
{
    private static readonly object _lock = new();
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    private static string BaseFile => Path.Combine(App.DataDir, "mindmap-themes.json");

    /// <summary>宽松读取（供纯展示）：文件不存在 → 空；存在但损坏 → 备份现场后返回空。</summary>
    public static List<MindMapTheme> Load()
    {
        try { return LoadStrict() ?? new List<MindMapTheme>(); }
        catch { return new List<MindMapTheme>(); }
    }

    /// <summary>严格读取：文件不存在 → 空；存在但读取/解析失败 → 保留现场(.corrupt-*)并抛出，写路径据此中止。</summary>
    internal static List<MindMapTheme>? LoadStrict()
    {
        var file = BaseFile;
        if (!File.Exists(file)) return new List<MindMapTheme>();
        try
        {
            using var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
            var list = JsonSerializer.Deserialize<List<MindMapTheme>>(fs, Json);
            return list ?? new List<MindMapTheme>();
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

    /// <summary>新增或更新主题（同 Id 覆盖，否则插到最前）。</summary>
    public static void Upsert(MindMapTheme theme)
    {
        lock (_lock)
        {
            var list = LoadStrict() ?? throw new InvalidOperationException("读取主题库失败，已中止写入以免清空已有数据。");
            var idx = list.FindIndex(t => t.Id == theme.Id);
            if (idx >= 0) list[idx] = theme;
            else list.Insert(0, theme);
            SaveCore(list);
        }
    }

    /// <summary>按 Id 删除主题。</summary>
    public static void Remove(string id)
    {
        lock (_lock)
        {
            var list = LoadStrict() ?? throw new InvalidOperationException("读取主题库失败，已中止删除。");
            list.RemoveAll(t => t.Id == id);
            SaveCore(list);
        }
    }

    private static void SaveCore(List<MindMapTheme> list)
    {
        var file = BaseFile;
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var tmp = file + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(list, Json));
        File.Move(tmp, file, overwrite: true);
    }
}