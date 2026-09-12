using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// kityminder JSON ⇄ XMind（.xmind）互转。
///
/// 导出（zip 内双写，互不干扰）：
///   1) <c>content.json</c> —— XMind Zen / 2020+ 标准结构：文本、层级、备注、超链接、优先级/进度标记、
///      标签、图片、节点样式、外框（boundary）；文件/视频附件映射到 href（打包者写包内 resources/ 相对路径，
///      否则写 file:/// 本地路径）；
///   2) <c>kityminder.json</c> —— 本工具原始内容快照；
///   3) <c>resources/*</c> —— 本机仍存在的文件/视频一并拷入包内，引用改写为 resources/…，实现跨机自用无损。
/// 导入（按优先级）：kityminder.json（无损）→ content.json（Zen/2020+）→ content.xml（XMind 8 老版）。
/// 包内 resources/ 附件会被解包到《数据目录\mindmap-attachments》并还原为绝对本地路径。
/// 一本 .xmind 里的多张画布会原样变成多张画布，不合并、不丢弃。
/// </summary>
public static class XMindConverter
{
    internal const string ContentEntry = "content.json";
    internal const string NativeEntry = "kityminder.json";
    internal const string MetadataEntry = "metadata.json";
    internal const string ManifestEntry = "manifest.json";
    internal const string LegacyContentEntry = "content.xml";

    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>XMind 进度标记（按完成百分比升序）与 kityminder progress(0..10) 的对应：</summary>
    private static readonly string[] ProgressMarkers =
        { "task-start", "task-oct", "task-quarter", "task-3oct", "task-half", "task-5oct", "task-3quar", "task-7oct", "task-done" };

    private static readonly int[] MarkerToProgress = { 0, 1, 3, 4, 5, 6, 8, 9, 10 };

    /// <summary>节点样式字段映射（kityminder data 键 → XMind style.properties 键）。</summary>
    private static readonly (string Km, string Xm)[] StyleMap =
    {
        ("fill", "svg:fill"),
        ("stroke", "svg:stroke"),
        ("radius", "svg:corner-radius"),
        ("forecolor", "fo:color"),
        ("font-size", "fo:font-size"),
        ("font-family", "fo:font-family"),
        ("text-align", "fo:text-align"),
    };

    // ---------------- 对外 API ----------------

    /// <summary>把整本脑图（多画布）写成 .xmind 文件（原子写 tmp→move）。文件/视频附件会一并拷入包内 resources/，跨机可无损还原。</summary>
    public static void WriteXMind(string path, MindMapWorkbook book)
    {
        var sheets = MindMapWorkbookOps.Normalize(book.Sheets, book.ActiveId);
        var wb = new MindMapWorkbook { Sheets = sheets, ActiveId = book.ActiveId };

        // 打包：收集节点上本机仍存在的文件/视频，拷入包内 resources/；
        // 快照与 content.json 的引用随之改写为包内相对路径，再由导入端解包还原为本地路径
        var (resourceEntries, packs) = CollectAttachmentPacks(sheets);

        var full = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var tmp = full + ".tmp";
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
        using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
        {
            foreach (var (entry, local) in resourceEntries)
                WriteResource(zip, entry, local);
            WriteEntry(zip, ContentEntry, BuildContentJson(wb, packs));
            WriteEntry(zip, NativeEntry, MindMapWorkbookOps.SerializeWorkbook(RewriteSnapshot(wb, packs)));
            WriteEntry(zip, MetadataEntry, "{\"layoutEngineVersion\":\"3\",\"creator\":{\"name\":\"分配项目组\"}}");
            WriteEntry(zip, ManifestEntry,
                "{\"file-entries\":{\"content.json\":{},\"metadata.json\":{},\"manifest.json\":{}}}");
        }
        File.Move(tmp, full, overwrite: true);
    }

    /// <summary>读取 .xmind 文件为多画布脑图；包内 resources/ 附件会解包到数据目录附件夹并还原为本地路径。
    /// 文件不是 XMind / 无任何画布时抛 <see cref="InvalidDataException"/>。</summary>
    public static MindMapWorkbook ReadXMind(string path, string? attachmentRoot = null)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var zip = new ZipArchive(fs, ZipArchiveMode.Read);

        MindMapWorkbook wb;
        // 1) 本工具无损快照优先（可 100% 还原外框/样式/附件等全部私有字段）
        var native = FindEntry(zip, NativeEntry);
        if (native != null && MindMapWorkbookOps.TryParseWorkbook(ReadEntry(native)) is { Sheets.Count: > 0 } wbNative)
        {
            wb = wbNative;
        }
        // 2) XMind Zen / 2020+：content.json
        else if (FindEntry(zip, ContentEntry) is var ce && ce != null &&
                 ParseZen(ReadEntry(ce)) is { Sheets.Count: > 0 } wbZen)
        {
            wb = wbZen;
        }
        // 3) XMind 8 及更早：content.xml
        else if (FindEntry(zip, LegacyContentEntry) is var xe && xe != null &&
                 ParseLegacy(ReadEntry(xe)) is { Sheets.Count: > 0 } wbLegacy)
        {
            wb = wbLegacy;
        }
        else
        {
            throw new InvalidDataException("不是有效的 XMind 文件（未找到 content.json / content.xml）");
        }

        UnpackResources(zip, wb, attachmentRoot ?? DefaultAttachmentRoot);
        return wb;
    }

    // ---------------- 导出：kityminder → XMind ----------------

    private static string BuildContentJson(MindMapWorkbook wb, Dictionary<string, string>? packs = null)
    {
        var arr = new JsonArray();
        foreach (var s in wb.Sheets)
        {
            var km = ParseKm(s.Content);
            if (km is null) continue;
            arr.Add(new JsonObject
            {
                ["id"] = s.Id,
                ["class"] = "sheet",
                ["title"] = s.Title,
                ["rootTopic"] = BuildTopic(km["root"] as JsonObject, packs),
            });
        }
        if (arr.Count == 0)
            arr.Add(new JsonObject
            {
                ["id"] = MindMapWorkbookOps.NewSheetId(),
                ["class"] = "sheet",
                ["title"] = "画布 1",
                ["rootTopic"] = BuildTopic(null, packs),
            });
        return PrettyText(arr);
    }

    private static JsonObject BuildTopic(JsonObject? kmNode, Dictionary<string, string>? packs = null)
    {
        var data = kmNode?["data"] as JsonObject;
        var topic = new JsonObject
        {
            ["id"] = SafeId(Str(data?["id"])),
            ["class"] = "topic",
            ["title"] = Str(data?["text"]) ?? "",
        };

        var note = Str(data?["note"]);
        if (!string.IsNullOrEmpty(note))
            topic["notes"] = new JsonObject { ["plain"] = new JsonObject { ["content"] = note } };

        // 超链接优先；无超链接时把文件/视频附件写入 href（视频优先）：已打包的写包内相对路径，
        // 未打包（文件已不存在等）写 file:/// 本地路径；原始字段仍随私有快照 kityminder.json 无损保留
        var href = Str(data?["hyperlink"]);
        if (string.IsNullOrWhiteSpace(href))
        {
            var att = Str(data?["video"]);
            if (string.IsNullOrWhiteSpace(att)) att = Str(data?["file"]);
            if (!string.IsNullOrWhiteSpace(att))
                href = packs is { Count: > 0 } && packs.TryGetValue(att!, out var pack) ? pack : ToFileUri(att!);
        }
        if (!string.IsNullOrWhiteSpace(href)) topic["href"] = href;

        var markers = new JsonArray();
        var priority = Num(data?["priority"]);
        if (priority >= 1 && priority <= 9)
            markers.Add(new JsonObject { ["markerId"] = "priority-" + (int)priority });
        var progress = Num(data?["progress"]);
        if (progress > 0 && progress <= 10)
            markers.Add(new JsonObject { ["markerId"] = ProgressToMarker((int)Math.Round(progress.Value)) });
        if (markers.Count > 0) topic["markers"] = markers;

        var labels = BuildLabels(data?["labels"]);
        if (labels != null) topic["labels"] = labels;

        var img = BuildImage(data);
        if (img != null) topic["image"] = img;

        var props = BuildStyle(data);
        if (props != null && props.Count > 0)
            topic["style"] = new JsonObject { ["id"] = "st" + Guid.NewGuid().ToString("N")[..8], ["properties"] = props };

        if (kmNode?["children"] is JsonArray children && children.Count > 0)
        {
            var attached = new JsonArray();
            var pairs = new List<(string XId, JsonObject Km)>();
            foreach (var c in children)
            {
                if (c is not JsonObject co) continue;
                var child = BuildTopic(co, packs);
                attached.Add(child);
                pairs.Add((child["id"]!.GetValue<string>(), co));
            }
            if (attached.Count > 0)
            {
                topic["children"] = new JsonObject { ["attached"] = attached };
                var bounds = BuildBoundaries(pairs);
                if (bounds != null) topic["boundaries"] = bounds;
            }
        }
        return topic;
    }

    private static JsonArray? BuildLabels(JsonNode? node)
    {
        switch (node)
        {
            case JsonArray arr when arr.Count > 0:
            {
                var outArr = new JsonArray();
                foreach (var it in arr)
                {
                    var s = Str(it);
                    if (!string.IsNullOrWhiteSpace(s)) outArr.Add(s!);
                }
                return outArr.Count > 0 ? outArr : null;
            }
            case JsonValue:
            {
                var s = Str(node);
                return string.IsNullOrWhiteSpace(s) ? null : new JsonArray(s!);
            }
            default:
                return null;
        }
    }

    private static JsonObject? BuildImage(JsonObject? data)
    {
        var src = Str(data?["image"]);
        if (string.IsNullOrWhiteSpace(src)) return null;
        var img = new JsonObject { ["src"] = src };
        var (w, h) = ParseSize(Str(data?["imageSize"]));
        if (w > 0) img["width"] = w;
        if (h > 0) img["height"] = h;
        var title = Str(data?["imageTitle"]);
        if (!string.IsNullOrWhiteSpace(title)) img["title"] = title;
        return img;
    }

    /// <summary>把同组的外框信息（boundaryGroup/boundaryLabel）汇总成父节点上的 XMind boundary 区间。</summary>
    private static JsonArray? BuildBoundaries(List<(string XId, JsonObject Km)> ordered)
    {
        var groups = new Dictionary<string, (int First, int Last, string Label)>(StringComparer.Ordinal);
        for (var i = 0; i < ordered.Count; i++)
        {
            var d = ordered[i].Km["data"] as JsonObject;
            var gid = Str(d?["boundaryGroup"]);
            if (string.IsNullOrEmpty(gid)) continue;
            var label = Str(d?["boundaryLabel"]) ?? "";
            if (groups.TryGetValue(gid!, out var g))
                groups[gid!] = (g.First, i, string.IsNullOrEmpty(g.Label) ? label : g.Label);
            else
                groups[gid!] = (i, i, label);
        }
        if (groups.Count == 0) return null;

        var arr = new JsonArray();
        foreach (var kv in groups)
        {
            var (first, last, label) = kv.Value;
            var range = first == last
                ? "(" + ordered[first].XId + ")"
                : "(" + ordered[first].XId + "," + ordered[last].XId + ")";
            arr.Add(new JsonObject
            {
                ["id"] = "bd" + Guid.NewGuid().ToString("N")[..8],
                ["class"] = "boundary",
                ["title"] = label,
                ["range"] = range,
            });
        }
        return arr;
    }

    private static JsonObject BuildStyle(JsonObject? data)
    {
        var props = new JsonObject();
        foreach (var (kmKey, xmKey) in StyleMap)
        {
            var v = Str(data?[kmKey]);
            if (string.IsNullOrWhiteSpace(v)) continue;
            props[xmKey] = kmKey switch
            {
                "radius" => ToPx(v!),
                "font-size" => ToPt(v!),
                _ => v!,
            };
        }
        if (Bool(data?["bold"])) props["fo:font-weight"] = "bold";
        if (Bool(data?["italic"])) props["fo:font-style"] = "italic";
        if (Bool(data?["strikethrough"])) props["fo:text-decoration"] = "line-through";
        else if (Bool(data?["underline"])) props["fo:text-decoration"] = "underline";
        return props;
    }

    // ---------------- 导入：XMind Zen content.json → kityminder ----------------

    private static MindMapWorkbook ParseZen(string json)
    {
        JsonNode? root;
        try { root = JsonNode.Parse(json); }
        catch (JsonException ex) { throw new InvalidDataException("XMind content.json 解析失败：" + ex.Message, ex); }

        var sheetNodes = new List<JsonObject>();
        switch (root)
        {
            case JsonArray arr:
                sheetNodes.AddRange(arr.OfType<JsonObject>());
                break;
            case JsonObject obj:
                // 少数工具把单个画布对象直接放根（含 rootTopic）
                sheetNodes.Add(obj);
                break;
        }

        var sheets = new List<MindMapSheetData>();
        var index = 0;
        foreach (var sn in sheetNodes)
        {
            if (sn["rootTopic"] is not JsonObject rootTopic) continue;
            index++;
            var kmRoot = BuildKmNode(rootTopic);
            var doc = new JsonObject
            {
                ["root"] = kmRoot,
                ["template"] = MindMapWorkbook.DefaultLayout,
                ["theme"] = MindMapWorkbook.DefaultTheme,
                ["version"] = "1.4.43",
            };
            sheets.Add(new MindMapSheetData
            {
                Id = SafeId(Str(sn["id"])) ?? MindMapWorkbookOps.NewSheetId(),
                Title = Str(sn["title"]) ?? ("画布 " + index),
                Content = PrettyText(doc),
                Theme = MindMapWorkbook.DefaultTheme,
                Layout = MindMapWorkbook.DefaultLayout,
            });
        }
        return new MindMapWorkbook { Sheets = sheets };
    }

    private static JsonObject BuildKmNode(JsonObject topic)
    {
        var data = new JsonObject
        {
            ["id"] = SafeId(Str(topic["id"])) ?? NewNodeId(),
            ["created"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["text"] = Str(topic["title"]) ?? "",
        };

        var note = Str(topic["notes"]?["plain"]?["content"]) ?? Str(topic["notes"]?["plain"]);
        if (!string.IsNullOrEmpty(note)) data["note"] = note;

        // href 还原：file:/// 本地路径 → 文件/视频附件（视频按扩展名识别）；包内相对路径（resources/…）
        // → 先暂存为文件，稍后由 ReadXMind 统一解包成绝对本地路径；其他协议保留为超链接
        var href = Str(topic["href"]);
        var localFile = FromFileUri(href);
        if (localFile != null)
        {
            if (MindMapFileService.IsVideoPath(localFile)) data["video"] = localFile;
            else data["file"] = localFile;
        }
        else if (IsPackRef(href)) data["file"] = href;
        else if (!string.IsNullOrWhiteSpace(href)) data["hyperlink"] = href;

        if (topic["markers"] is JsonArray markers)
        {
            foreach (var m in markers)
            {
                var mid = Str(m?["markerId"]) ?? Str(m);
                if (string.IsNullOrEmpty(mid)) continue;
                if (mid!.StartsWith("priority-", StringComparison.Ordinal) &&
                    int.TryParse(mid.AsSpan("priority-".Length), out var p) && p >= 1 && p <= 9)
                {
                    data["priority"] = p;
                }
                else
                {
                    var idx = Array.IndexOf(ProgressMarkers, mid);
                    if (idx >= 0) data["progress"] = MarkerToProgress[idx];
                }
            }
        }

        if (topic["labels"] is JsonArray labels && labels.Count > 0)
        {
            var arr = labels.Select(Str).Where(s => !string.IsNullOrWhiteSpace(s))
                .Select(s => (JsonNode?)JsonValue.Create(s!)).ToArray();
            if (arr.Length > 0) data["labels"] = new JsonArray(arr);
        }

        if (topic["image"] is JsonObject img)
        {
            var src = Str(img["src"]);
            if (!string.IsNullOrWhiteSpace(src))
            {
                data["image"] = src;
                var w = Num(img["width"]);
                var h = Num(img["height"]);
                if (w > 0 && h > 0) data["imageSize"] = $"{w:0}*{h:0}";
                var t = Str(img["title"]);
                if (!string.IsNullOrWhiteSpace(t)) data["imageTitle"] = t;
            }
        }

        ApplyStyle(data, topic["style"] as JsonObject);

        var children = new JsonArray();
        var pairs = new List<(string XId, JsonObject Km)>();
        if (topic["children"] is JsonObject chObj)
        {
            foreach (var key in new[] { "attached", "detached", "summary" })
            {
                if (chObj[key] is not JsonArray list) continue;
                foreach (var c in list)
                {
                    if (c is not JsonObject co) continue;
                    var kmChild = BuildKmNode(co);
                    children.Add(kmChild);
                    pairs.Add((SafeId(Str(co["id"])) ?? "", kmChild));
                }
            }
        }

        ApplyBoundaries(pairs, topic["boundaries"] as JsonArray);
        return new JsonObject { ["data"] = data, ["children"] = children };
    }

    /// <summary>把父节点上的 XMind boundary 区间还原成子节点的 boundaryGroup/boundaryLabel。</summary>
    private static void ApplyBoundaries(List<(string XId, JsonObject Km)> pairs, JsonArray? boundaries)
    {
        if (boundaries is null || boundaries.Count == 0 || pairs.Count == 0) return;
        var seq = 0;
        foreach (var b in boundaries)
        {
            if (b is not JsonObject bo) continue;
            var range = Str(bo["range"]);
            if (string.IsNullOrWhiteSpace(range)) continue;
            var ids = range!.Trim('(', ')').Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (ids.Length == 0) continue;

            var indices = ids
                .Select(id => pairs.FindIndex(p => string.Equals(p.XId, id, StringComparison.Ordinal)))
                .Where(i => i >= 0)
                .ToList();
            if (indices.Count == 0) continue;

            var from = indices.Min();
            var to = indices.Max();
            var gid = "bg" + (++seq);
            var label = Str(bo["title"]) ?? "";
            for (var i = from; i <= to && i < pairs.Count; i++)
            {
                var d = pairs[i].Km["data"] as JsonObject;
                if (d is null || !string.IsNullOrEmpty(Str(d["boundaryGroup"]))) continue;
                d["boundaryGroup"] = gid;
                d["boundaryLabel"] = label;
            }
        }
    }

    private static void ApplyStyle(JsonObject data, JsonObject? style)
    {
        var props = style?["properties"] as JsonObject;
        if (props is null) return;
        foreach (var (kmKey, xmKey) in StyleMap)
        {
            var v = Str(props[xmKey]);
            if (string.IsNullOrWhiteSpace(v)) continue;
            data[kmKey] = kmKey switch
            {
                "radius" => FromPx(v!),
                "font-size" => FromPt(v!),
                _ => v!,
            };
        }
        var weight = Str(props["fo:font-weight"]);
        if (string.Equals(weight, "bold", StringComparison.OrdinalIgnoreCase) ||
            (Num(props["fo:font-weight"]) ?? 0) >= 600)
            data["bold"] = true;
        var fs = Str(props["fo:font-style"]);
        if (string.Equals(fs, "italic", StringComparison.OrdinalIgnoreCase)) data["italic"] = true;
        var deco = Str(props["fo:text-decoration"]);
        if (!string.IsNullOrWhiteSpace(deco))
        {
            if (deco!.Contains("line-through", StringComparison.OrdinalIgnoreCase)) data["strikethrough"] = true;
            if (deco.Contains("underline", StringComparison.OrdinalIgnoreCase)) data["underline"] = true;
        }
    }

    // ---------------- 导入：XMind 8 老版 content.xml → kityminder ----------------

    private static readonly XNamespace XLink = "http://www.w3.org/1999/xlink";

    private static MindMapWorkbook ParseLegacy(string xml)
    {
        XDocument doc;
        try { doc = XDocument.Parse(xml); }
        catch (System.Xml.XmlException ex)
        {
            throw new InvalidDataException("XMind content.xml 解析失败：" + ex.Message, ex);
        }

        var sheets = new List<MindMapSheetData>();
        var index = 0;
        foreach (var sheetEl in doc.Descendants().Where(e => e.Name.LocalName == "sheet"))
        {
            var topicEl = sheetEl.Elements().FirstOrDefault(e => e.Name.LocalName == "topic");
            if (topicEl is null) continue;
            index++;
            var kmRoot = BuildKmFromXmlTopic(topicEl);
            var title = sheetEl.Elements().FirstOrDefault(e => e.Name.LocalName == "title")?.Value;
            var wrapper = new JsonObject
            {
                ["root"] = kmRoot,
                ["template"] = MindMapWorkbook.DefaultLayout,
                ["theme"] = MindMapWorkbook.DefaultTheme,
                ["version"] = "1.4.43",
            };
            sheets.Add(new MindMapSheetData
            {
                Id = sheetEl.Attribute("id")?.Value ?? MindMapWorkbookOps.NewSheetId(),
                Title = string.IsNullOrWhiteSpace(title) ? "画布 " + index : title,
                Content = PrettyText(wrapper),
                Theme = MindMapWorkbook.DefaultTheme,
                Layout = MindMapWorkbook.DefaultLayout,
            });
        }
        return new MindMapWorkbook { Sheets = sheets };
    }

    private static JsonObject BuildKmFromXmlTopic(XElement t)
    {
        var data = new JsonObject
        {
            ["id"] = t.Attribute("id")?.Value ?? NewNodeId(),
            ["created"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["text"] = t.Elements().FirstOrDefault(e => e.Name.LocalName == "title")?.Value ?? "",
        };

        var notesEl = t.Elements().FirstOrDefault(e => e.Name.LocalName == "notes");
        if (notesEl != null)
        {
            var text = notesEl.Value; // html 子节点取 .Value 自动剥标签
            if (!string.IsNullOrWhiteSpace(text)) data["note"] = text;
        }

        var href = (t.Attribute(XLink + "href") ?? t.Attribute("href"))?.Value;
        if (!string.IsNullOrWhiteSpace(href)) data["hyperlink"] = href;

        foreach (var mr in t.Descendants().Where(e => e.Name.LocalName == "marker-ref" || e.Name.LocalName == "marker"))
        {
            var mid = mr.Attribute("marker-id")?.Value ?? mr.Attribute("markerId")?.Value;
            if (string.IsNullOrEmpty(mid)) continue;
            if (mid!.StartsWith("priority-", StringComparison.Ordinal) &&
                int.TryParse(mid.AsSpan("priority-".Length), out var p) && p >= 1 && p <= 9)
            {
                data["priority"] = p;
            }
            else
            {
                var idx = Array.IndexOf(ProgressMarkers, mid);
                if (idx >= 0) data["progress"] = MarkerToProgress[idx];
            }
        }

        var labels = t.Elements().FirstOrDefault(e => e.Name.LocalName == "labels")
            ?.Elements().Where(e => e.Name.LocalName == "label")
            .Select(e => e.Value).Where(v => !string.IsNullOrWhiteSpace(v)).ToArray();
        if (labels is { Length: > 0 })
        {
            var arr = labels.Select(v => (JsonNode?)JsonValue.Create(v)).ToArray();
            data["labels"] = new JsonArray(arr);
        }

        var imgEl = t.Descendants().FirstOrDefault(e => e.Name.LocalName == "img");
        var imgSrc = imgEl?.Attribute("src")?.Value ?? imgEl?.Attribute(XLink + "href")?.Value;
        if (!string.IsNullOrWhiteSpace(imgSrc)) data["image"] = imgSrc;

        var children = new JsonArray();
        var pairs = new List<(string XId, JsonObject Km)>();
        var topicsEl = t.Elements().FirstOrDefault(e => e.Name.LocalName == "children");
        if (topicsEl != null)
        {
            foreach (var child in topicsEl.Elements()
                         .Where(e => e.Name.LocalName == "topics")
                         .SelectMany(e => e.Elements())
                         .Where(e => e.Name.LocalName == "topic"))
            {
                var kmChild = BuildKmFromXmlTopic(child);
                children.Add(kmChild);
                pairs.Add((child.Attribute("id")?.Value ?? "", kmChild));
            }
        }

        ApplyXmlBoundaries(pairs, t.Elements().FirstOrDefault(e => e.Name.LocalName == "boundaries"));
        return new JsonObject { ["data"] = data, ["children"] = children };
    }

    /// <summary>老版 boundary 结构各家写法不一，做宽容解析：任意后代的 idref/ref 属性或文本里的 id 都收。</summary>
    private static void ApplyXmlBoundaries(List<(string XId, JsonObject Km)> pairs, XElement? boundariesEl)
    {
        if (boundariesEl is null || pairs.Count == 0) return;
        var seq = 0;
        foreach (var b in boundariesEl.Elements().Where(e => e.Name.LocalName == "boundary"))
        {
            var ids = new List<string>();
            foreach (var d in b.Descendants())
            {
                foreach (var attrName in new[] { "idref", "ref", "id" })
                {
                    var v = d.Attribute(attrName)?.Value;
                    if (!string.IsNullOrWhiteSpace(v)) ids.Add(v!);
                }
                var rangeText = d.Name.LocalName is "topic-range" or "range" ? d.Value : "";
                if (!string.IsNullOrWhiteSpace(rangeText))
                    ids.AddRange(rangeText.Split(new[] { ' ', ',', ';', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries));
            }
            if (ids.Count == 0) continue;

            var indices = ids.Distinct(StringComparer.Ordinal)
                .Select(id => pairs.FindIndex(p => string.Equals(p.XId, id, StringComparison.Ordinal)))
                .Where(i => i >= 0)
                .ToList();
            if (indices.Count == 0) continue;

            var gid = "bg" + (++seq);
            var label = b.Elements().FirstOrDefault(e => e.Name.LocalName == "title")?.Value ?? "";
            for (var i = indices.Min(); i <= indices.Max() && i < pairs.Count; i++)
            {
                var d = pairs[i].Km["data"] as JsonObject;
                if (d is null || !string.IsNullOrEmpty(Str(d["boundaryGroup"]))) continue;
                d["boundaryGroup"] = gid;
                d["boundaryLabel"] = label;
            }
        }
    }

    // ---------------- 小工具 ----------------

    private static JsonObject? ParseKm(string? content)
    {
        if (string.IsNullOrWhiteSpace(content)) return null;
        try { return JsonNode.Parse(content!) as JsonObject; }
        catch { return null; }
    }

    private static ZipArchiveEntry? FindEntry(ZipArchive zip, string name)
        => zip.GetEntry(name)
           ?? zip.Entries.FirstOrDefault(e => string.Equals(Path.GetFileName(e.FullName), name, StringComparison.OrdinalIgnoreCase));

    private static void WriteEntry(ZipArchive zip, string name, string text)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        using var ws = new StreamWriter(entry.Open(), new UTF8Encoding(false));
        ws.Write(text);
    }

    private static string ReadEntry(ZipArchiveEntry entry)
    {
        using var rs = new StreamReader(entry.Open(), Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return rs.ReadToEnd();
    }

    /// <summary>
    /// 缩进序列化 JsonNode。不用 ToJsonString(options)：
    /// .NET 8 下传入自定义 JsonSerializerOptions 时，JsonValueCustomized 节点（如图片宽高 double）
    /// 会因 options 无 TypeInfoResolver 抛 InvalidOperationException，直接走 Utf8JsonWriter 无此问题。
    /// </summary>
    private static string PrettyText(JsonNode node)
    {
        using var ms = new MemoryStream();
        using (var writer = new Utf8JsonWriter(ms, new JsonWriterOptions { Indented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
            node.WriteTo(writer);
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    private static string NewNodeId() => "km" + Guid.NewGuid().ToString("N")[..10];

    /// <summary>本地路径 → file URI（用于 content.json 的 href 承载文件/视频附件）。非法/非本地路径返回 null。</summary>
    private static string? ToFileUri(string path)
    {
        try { return new Uri(path).IsFile ? new Uri(path).ToString() : null; }
        catch { return null; }
    }

    /// <summary>file:/// URI → 本地路径；非 file 协议或非法返回 null。</summary>
    private static string? FromFileUri(string? href)
    {
        if (string.IsNullOrWhiteSpace(href) ||
            !href!.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) return null;
        try { return new Uri(href).IsFile ? new Uri(href).LocalPath : null; }
        catch { return null; }
    }

    /// <summary>导入解包的附件落盘根目录（数据目录\mindmap-attachments）。</summary>
    private static string DefaultAttachmentRoot => Path.Combine(App.DataDir, "mindmap-attachments");

    /// <summary>包内相对路径引用（resources/…）；不是 file:// 等其它协议的超链接。</summary>
    private static bool IsPackRef(string? href)
        => !string.IsNullOrWhiteSpace(href)
           && href!.StartsWith("resources/", StringComparison.OrdinalIgnoreCase)
           && !href!.Contains("://", StringComparison.Ordinal);

    /// <summary>把文件名里的非法字符替换为下划线并去首尾空白/点；不会返回空串的"安全名"。</summary>
    private static string SanitizeFileName(string name)
    {
        if (string.IsNullOrEmpty(name)) return "attach";
        var invalid = Path.GetInvalidFileNameChars();
        var chars = name.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
            if (invalid.Contains(chars[i])) chars[i] = '_';
        var r = new string(chars).Trim().Trim('.');
        return r.Length > 0 ? r : "attach";
    }

    /// <summary>对 kityminder 整本（root + template…）逐节点执行 action。节点结构：{ data, children:[…] }。</summary>
    private static void WalkKmNodes(JsonObject km, Action<JsonObject> action)
        => WalkKmTopic(km["root"] as JsonObject, action);

    private static void WalkKmTopic(JsonObject? node, Action<JsonObject> action)
    {
        if (node is null) return;
        action(node);
        if (node["children"] is JsonArray ch)
            foreach (var c in ch.OfType<JsonObject>())
                WalkKmTopic(c, action);
    }

    /// <summary>收集节点上本机仍存在的文件/视频附件，返回「包内 entry ↔ 本地路径」列表与「本地路径→包内相对路径」映射。</summary>
    private static (List<(string Entry, string LocalPath)> entries, Dictionary<string, string> map)
        CollectAttachmentPacks(IReadOnlyList<MindMapSheetData> sheets)
    {
        var entries = new List<(string, string)>();
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        if (sheets is not { Count: > 0 }) return (entries, map);

        var seq = 0;
        foreach (var sheet in sheets)
        {
            var km = ParseKm(sheet?.Content);
            if (km is null) continue;
            WalkKmNodes(km, node =>
            {
                var d = node["data"] as JsonObject;
                if (d is null) return;
                foreach (var key in new[] { "file", "video" })
                {
                    var p = Str(d[key]);
                    if (string.IsNullOrWhiteSpace(p) || !Path.IsPathRooted(p!) || !File.Exists(p) || map.ContainsKey(p!))
                        continue;
                    var ext = Path.GetExtension(p).ToLowerInvariant();
                    var baseSafe = SanitizeFileName(Path.GetFileNameWithoutExtension(p));
                    var packName = $"resources/kma_{seq}_{baseSafe}{ext}";
                    seq++;
                    map[p!] = packName;
                    entries.Add((packName, p!));
                }
            });
        }
        return (entries, map);
    }

    /// <summary>导出前，把 wb 各画布节点 data.file/video 改写为包内相对路径，供快照逐字携带包引用。</summary>
    private static MindMapWorkbook RewriteSnapshot(MindMapWorkbook wb, Dictionary<string, string>? packs)
    {
        if (wb is null || packs is not { Count: > 0 }) return wb!;
        var nw = new MindMapWorkbook { Sheets = new List<MindMapSheetData>(), ActiveId = wb.ActiveId };
        foreach (var s in wb.Sheets)
        {
            var km = ParseKm(s.Content);
            if (km is null) { nw.Sheets.Add(s.Clone()); continue; }
            WalkKmNodes(km, node =>
            {
                var d = node["data"] as JsonObject;
                if (d is null) return;
                foreach (var key in new[] { "file", "video" })
                {
                    var p = Str(d[key]);
                    if (!string.IsNullOrWhiteSpace(p) && packs.TryGetValue(p!, out var pack)) d[key] = pack;
                }
            });
            nw.Sheets.Add(new MindMapSheetData
            {
                Id = s.Id, Title = s.Title, Theme = s.Theme, Layout = s.Layout, Content = PrettyText(km),
            });
        }
        return nw;
    }

    /// <summary>把磁盘文件原样写入 zip entry（按字节复制，无编码转换）。</summary>
    private static void WriteResource(ZipArchive zip, string entryName, string localPath)
    {
        var entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
        using var src = new FileStream(localPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var dst = entry.Open();
        src.CopyTo(dst);
    }

    /// <summary>把 zip 内 resources/ 附件解包到目标目录，并将节点上的包内引用改写为解包后的绝对路径（同内容复用，避免重复堆积）。</summary>
    private static void UnpackResources(ZipArchive zip, MindMapWorkbook wb, string root)
    {
        if (wb is null || wb.Sheets is not { Count: > 0 }) return;
        var wanted = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in zip.Entries)
            if (!string.IsNullOrEmpty(e.FullName) &&
                e.FullName.StartsWith("resources/", StringComparison.OrdinalIgnoreCase))
                wanted[e.FullName] = e.FullName;
        if (wanted.Count == 0) return;
        try { Directory.CreateDirectory(root); } catch { return; }

        foreach (var sheet in wb.Sheets)
        {
            var km = ParseKm(sheet.Content);
            if (km is null) continue;
            var changed = false;
            WalkKmNodes(km, node =>
            {
                var d = node["data"] as JsonObject;
                if (d is null) return;
                foreach (var key in new[] { "file", "video" })
                {
                    var v = Str(d[key]);
                    if (string.IsNullOrWhiteSpace(v) || !wanted.TryGetValue(v!, out var entryName)) continue;
                    var local = UnpackOne(zip, entryName, root);
                    if (local is not null) { d[key] = local; changed = true; }
                }
            });
            if (changed) sheet.Content = PrettyText(km);
        }
    }

    private static string? UnpackOne(ZipArchive zip, string entryName, string root)
    {
        var entry = zip.GetEntry(entryName);
        if (entry is null) return null;
        var fileName = SanitizeFileName(Path.GetFileName(entryName.Replace('\\', '/')));
        var target = Path.Combine(root, fileName);
        try
        {
            target = DedupeTarget(entry, target);
            using var src = entry.Open();
            using var dst = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None);
            src.CopyTo(dst);
            return target;
        }
        catch { return null; }
    }

    /// <summary>目标文件已存在同内容则复用；内容不同则加 _N 后缀错开，避免覆盖。</summary>
    private static string DedupeTarget(ZipArchiveEntry entry, string target)
    {
        if (!File.Exists(target)) return target;
        if (!HashesDiffer(entry, target)) return target;
        var dir = Path.GetDirectoryName(target)!;
        var name = Path.GetFileNameWithoutExtension(target);
        var ext = Path.GetExtension(target);
        var i = 1;
        while (File.Exists(Path.Combine(dir, $"{name}_{i}{ext}"))) i++;
        return Path.Combine(dir, $"{name}_{i}{ext}");
    }

    private static bool HashesDiffer(ZipArchiveEntry entry, string local)
    {
        try
        {
            using var localStream = new FileStream(local, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var entryStream = entry.Open();
            using var h1 = System.Security.Cryptography.SHA256.Create();
            using var h2 = System.Security.Cryptography.SHA256.Create();
            return !Convert.ToHexString(h1.ComputeHash(localStream))
                .Equals(Convert.ToHexString(h2.ComputeHash(entryStream)), StringComparison.Ordinal);
        }
        catch { return true; } // 读失败按"内容不同"另存后缀，绝不覆盖风险方
    }

    /// <summary>XMind 的 id 不允许为空；保留原 id（便于外框区间回指），非法则换发。</summary>
    private static string? SafeId(string? id)
        => string.IsNullOrWhiteSpace(id) ? null : id!.Trim();

    private static string? Str(JsonNode? n)
    {
        if (n is null) return null;
        if (n is JsonValue v)
        {
            if (v.TryGetValue<string>(out var s)) return s;
            if (v.TryGetValue<double>(out var d)) return d.ToString(CultureInfo.InvariantCulture);
            if (v.TryGetValue<bool>(out var b)) return b ? "true" : "false";
        }
        return n.ToJsonString();
    }

    private static double? Num(JsonNode? n)
    {
        if (n is JsonValue v && v.TryGetValue<double>(out var d)) return d;
        if (n is JsonValue vs && vs.TryGetValue<string>(out var s) &&
            double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
            return parsed;
        return null;
    }

    private static bool Bool(JsonNode? n)
        => n is JsonValue v && v.TryGetValue<bool>(out var b) && b
           || (Str(n) is { } s && (s == "1" || s.Equals("true", StringComparison.OrdinalIgnoreCase)));

    private static string ProgressToMarker(int progress)
        => ProgressMarkers[Math.Clamp((int)Math.Round(progress / 10.0 * (ProgressMarkers.Length - 1)), 0, ProgressMarkers.Length - 1)];

    /// <summary>kityminder 尺寸串（"120*80" / "120,80" / 纯数字）→ 宽高。</summary>
    private static (double W, double H) ParseSize(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return (0, 0);
        var parts = s!.Split(new[] { '*', 'x', 'X', ',', ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 2 &&
            double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var w) &&
            double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var h))
            return (w, h);
        return (0, 0);
    }

    private static string ToPx(string v)
        => v.Trim().EndsWith("px", StringComparison.OrdinalIgnoreCase) ? v.Trim() : v.Trim() + "px";

    private static string ToPt(string v)
        => v.Trim().EndsWith("pt", StringComparison.OrdinalIgnoreCase) ? v.Trim() : v.Trim() + "pt";

    private static string FromPx(string v)
        => v.Trim().EndsWith("px", StringComparison.OrdinalIgnoreCase) ? v.Trim()[..^2].Trim() : v.Trim();

    private static string FromPt(string v)
        => v.Trim().EndsWith("pt", StringComparison.OrdinalIgnoreCase) ? v.Trim()[..^2].Trim() : v.Trim();
}
