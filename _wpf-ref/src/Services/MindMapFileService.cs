using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

namespace FenPeiXiangMuZu.Services;

/// <summary>节点文件附件的展示信息：路径 + 由文件系统读到的名称/类型/大小/时间。
/// 文件不存在时 Exists=false 且带 Error；视频文件额外携带 <see cref="Video"/>（读不到为 null）。</summary>
public sealed record NodeFileInfo
{
    public string Path { get; init; } = "";
    public string Name { get; init; } = "";
    public string DirectoryText { get; init; } = "";
    public string TypeText { get; init; } = "";
    public string SizeText { get; init; } = "";
    public string ModifiedText { get; init; } = "";
    public string CreatedText { get; init; } = "";
    public bool Exists { get; init; }
    public bool IsVideo { get; init; }
    public VideoMeta? Video { get; init; }
    public string? Error { get; init; }
}

/// <summary>视频元信息（时长/分辨率/帧率/码率/编码）。读不到的项为 null（面板显示"—"）。</summary>
public sealed record VideoMeta
{
    public string? DurationText { get; init; }
    public string? ResolutionText { get; init; }
    public string? FrameRateText { get; init; }
    public string? BitrateText { get; init; }
    public string? VideoCodecText { get; init; }
    public string? AudioCodecText { get; init; }
}

/// <summary>
/// 脑图「文件」页签的附件信息服务：构建文件展示信息、视频判定、视频元信息读取。
/// 附件只在节点 data 里存路径（index.html 的 file 命令），本服务按需读文件系统取展示字段。
/// 视频元信息经 Shell.Application 属性系统 best-effort 读取（失败各字段为 null，不影响其它展示）。
/// </summary>
public static class MindMapFileService
{
    /// <summary>视为视频的扩展名（决定点击附件图标时页签内播放而非外部打开）。</summary>
    private static readonly HashSet<string> VideoExt = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".mpg", ".mpeg",
        ".3gp", ".ts", ".m2ts", ".mts", ".rmvb", ".rm", ".vob",
    };

    /// <summary>扩展名 → 类型大类；未收录的回落「&lt;EXT&gt; 文件」。</summary>
    private static readonly Dictionary<string, string> TypeNames = new(StringComparer.OrdinalIgnoreCase)
    {
        [".mp4"] = "视频", [".avi"] = "视频", [".mkv"] = "视频", [".mov"] = "视频", [".wmv"] = "视频",
        [".flv"] = "视频", [".webm"] = "视频", [".m4v"] = "视频", [".mpg"] = "视频", [".mpeg"] = "视频",
        [".3gp"] = "视频", [".ts"] = "视频", [".m2ts"] = "视频", [".mts"] = "视频", [".rmvb"] = "视频",
        [".rm"] = "视频", [".vob"] = "视频",
        [".png"] = "图片", [".jpg"] = "图片", [".jpeg"] = "图片", [".bmp"] = "图片", [".gif"] = "图片",
        [".ico"] = "图片", [".webp"] = "图片", [".tif"] = "图片", [".tiff"] = "图片", [".svg"] = "图片",
        [".mp3"] = "音频", [".wav"] = "音频", [".flac"] = "音频", [".aac"] = "音频", [".m4a"] = "音频",
        [".wma"] = "音频", [".ogg"] = "音频",
        [".doc"] = "文档", [".docx"] = "文档", [".pdf"] = "文档", [".rtf"] = "文档",
        [".txt"] = "文本", [".md"] = "文本", [".log"] = "文本",
        [".xls"] = "表格", [".xlsx"] = "表格", [".csv"] = "表格",
        [".ppt"] = "演示", [".pptx"] = "演示",
        [".zip"] = "压缩包", [".rar"] = "压缩包", [".7z"] = "压缩包", [".tar"] = "压缩包", [".gz"] = "压缩包",
        [".exe"] = "程序", [".msi"] = "程序", [".dll"] = "程序", [".bat"] = "脚本", [".ps1"] = "脚本",
        [".cs"] = "代码", [".js"] = "代码", [".ts"] = "代码", [".py"] = "代码", [".xaml"] = "代码",
        [".json"] = "数据", [".xml"] = "数据", [".yml"] = "数据", [".yaml"] = "数据",
        [".html"] = "网页", [".htm"] = "网页", [".css"] = "样式", [".xmind"] = "导图文件",
    };

    public static bool IsVideoPath(string? path)
    {
        var ext = Path.GetExtension(path ?? "");
        return ext.Length > 0 && VideoExt.Contains(ext);
    }

    /// <summary>「选择视频」打开对话框的过滤器（视频扩展名 + 兜底所有文件）。</summary>
    public static string VideoFilter
    {
        get
        {
            var sb = new System.Text.StringBuilder();
            foreach (var e in VideoExt) { if (sb.Length > 0) sb.Append(';'); sb.Append('*').Append(e); }
            return "视频文件|" + sb + "|所有文件|*.*";
        }
    }

    /// <summary>构建附件展示信息。路径为空返回 Error；文件不存在保留已知字段并标注，不抛异常。</summary>
    public static NodeFileInfo Build(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return new NodeFileInfo { Error = "路径为空" };
        var full = path.Trim();
        var info = new NodeFileInfo
        {
            Path = full,
            Name = Path.GetFileName(full),
            DirectoryText = Path.GetDirectoryName(full) ?? "",
            TypeText = DescribeType(full),
            IsVideo = IsVideoPath(full),
        };
        try
        {
            if (!File.Exists(full))
                return info with { Error = "文件不存在或已被移动" };
            var fi = new FileInfo(full);
            info = info with
            {
                Exists = true,
                SizeText = FormatSize(fi.Length),
                ModifiedText = fi.LastWriteTime.ToString("yyyy-MM-dd HH:mm"),
                CreatedText = fi.CreationTime.ToString("yyyy-MM-dd HH:mm"),
            };
            if (info.IsVideo)
                info = info with { Video = ReadVideoMeta(full) };
            return info;
        }
        catch (Exception ex)
        {
            return info with { Error = ex.Message };
        }
    }

    public static string FormatSize(long bytes)
    {
        if (bytes < 0) return "—";
        const double K = 1024, M = K * 1024, G = M * 1024;
        return bytes switch
        {
            < 1024 => $"{bytes} B",
            < (long)M => Math.Round(bytes / K, 2).ToString("0.##") + " KB",
            < (long)G => Math.Round(bytes / M, 2).ToString("0.##") + " MB",
            _ => Math.Round(bytes / G, 2).ToString("0.##") + " GB",
        };
    }

    public static string FormatDuration(TimeSpan t)
    {
        if (t < TimeSpan.Zero) return "—";
        if (t.TotalHours >= 1) return $"{(int)t.TotalHours}:{t.Minutes:D2}:{t.Seconds:D2}";
        return $"{t.Minutes}:{t.Seconds:D2}";
    }

    private static string DescribeType(string path)
    {
        var ext = Path.GetExtension(path);
        if (ext.Length == 0) return "未知类型";
        var up = ext[1..].ToUpperInvariant();
        return TypeNames.TryGetValue(ext, out var cat) ? $"{cat}（{up}）" : $"{up} 文件";
    }

    /// <summary>Shell 属性系统读视频元信息（best-effort）。任一步失败返回 null 或对应字段为 null。</summary>
    private static VideoMeta? ReadVideoMeta(string path)
    {
        try
        {
            var shellType = Type.GetTypeFromProgID("Shell.Application");
            if (shellType is null) return null;
            dynamic? shell = Activator.CreateInstance(shellType);
            if (shell is null) return null;
            try
            {
                dynamic? folder = shell.NameSpace(Path.GetDirectoryName(path));
                if (folder is null) return null;
                dynamic? item = folder.ParseName(Path.GetFileName(path));
                if (item is null) return null;

                string? Prop(string p)
                {
                    try
                    {
                        var raw = item.ExtendedProperty(p);
                        var s = raw is null ? null : Convert.ToString(raw, CultureInfo.InvariantCulture)?.Trim();
                        return string.IsNullOrEmpty(s) ? null : s;
                    }
                    catch { return null; }
                }

                // 时长：System.Media.Duration 原始单位 100ns；部分系统直接回 "hh:mm:ss" 文本
                string? duration = null;
                var durRaw = Prop("System.Media.Duration");
                if (durRaw is not null)
                {
                    if (TimeSpan.TryParse(durRaw, CultureInfo.InvariantCulture, out var ts))
                        duration = FormatDuration(ts);
                    else if (long.TryParse(durRaw, NumberStyles.Any, CultureInfo.InvariantCulture, out var n100) && n100 > 0)
                        duration = FormatDuration(TimeSpan.FromTicks(n100 * 10));
                }

                // 帧率：System.Video.FrameRate 单位 = 帧/1000 秒
                string? Fps(string? raw)
                {
                    if (raw is null || !double.TryParse(raw, NumberStyles.Any, CultureInfo.InvariantCulture, out var v) || v <= 0)
                        return null;
                    return Math.Round(v / 1000.0, 2).ToString("0.##") + " fps";
                }

                // 码率：System.Video.EncodingBitrate 单位 bps
                string? Bitrate(string? raw)
                {
                    if (raw is null || !double.TryParse(raw, NumberStyles.Any, CultureInfo.InvariantCulture, out var bps) || bps <= 0)
                        return null;
                    return bps >= 1_000_000
                        ? Math.Round(bps / 1_000_000, 2).ToString("0.##") + " Mbps"
                        : Math.Round(bps / 1000, 0).ToString("0") + " kbps";
                }

                return new VideoMeta
                {
                    DurationText = duration,
                    ResolutionText = Join(Prop("System.Video.FrameWidth"), Prop("System.Video.FrameHeight")),
                    FrameRateText = Fps(Prop("System.Video.FrameRate")),
                    BitrateText = Bitrate(Prop("System.Video.EncodingBitrate")),
                    VideoCodecText = Prop("System.Video.Compression"),
                    AudioCodecText = Prop("System.Audio.Compression") ?? Prop("System.Audio.Format"),
                };
            }
            finally
            {
                Marshal.FinalReleaseComObject(shell);
            }
        }
        catch { return null; }
    }

    private static string? Join(string? width, string? height)
        => string.IsNullOrEmpty(width) || string.IsNullOrEmpty(height) ? null : $"{width} × {height}";
}
