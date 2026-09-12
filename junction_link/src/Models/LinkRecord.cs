using System.Text.Json.Serialization;

namespace FenPeiXiangMuZu.Models;

/// <summary>一条链接记录：对应 link-record.json 的 links 元素。</summary>
public class LinkRecord
{
    /// <summary>默认链接名（兼容旧数据：早期只建 .opencode 一个链接）。</summary>
    public const string DefaultLinkName = ".opencode";

    [JsonPropertyName("project")]
    public string? Project { get; set; }

    [JsonPropertyName("lib")]
    public string? Lib { get; set; }

    [JsonPropertyName("group")]
    public string? Group { get; set; }

    [JsonPropertyName("created")]
    public string? Created { get; set; }

    [JsonPropertyName("cluster")]
    public string? Cluster { get; set; }

    /// <summary>建链时实际创建的链接名集合（全部指向同项目组根）。旧记录缺失时视为仅 [.opencode]。</summary>
    [JsonPropertyName("names")]
    public List<string>? Names { get; set; }

    /// <summary>获取本项目实际创建的链接名集合；旧数据（names 缺失/为空）回退为单个默认名。</summary>
    public List<string> GetLinkNames()
        => Names is { Count: > 0 } ? Names : new List<string> { DefaultLinkName };
}

/// <summary>链接记录文件的根对象。</summary>
public sealed class LinkRecordFile
{
    [JsonPropertyName("clusters")]
    public List<object> Clusters { get; set; } = new();

    [JsonPropertyName("links")]
    public List<LinkRecord> Links { get; set; } = new();
}