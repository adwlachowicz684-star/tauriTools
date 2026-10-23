using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using MdTable = Markdig.Extensions.Tables.Table;
using MdTableRow = Markdig.Extensions.Tables.TableRow;
using MdTableCell = Markdig.Extensions.Tables.TableCell;
using WpfBlock = System.Windows.Documents.Block;
using WpfInline = System.Windows.Documents.Inline;
using MdBlock = Markdig.Syntax.Block;
using MdInline = Markdig.Syntax.Inlines.Inline;

namespace FenPeiXiangMuZu.Portable.MarkdownEditor;

/// <summary>
/// 用 Markdig 解析 Markdown，自写 AST→WPF FlowDocument 渲染器（不引第三方 UI 控件）。
/// 支持：标题/段落/加粗/斜体/删除线/行内代码/代码块(带语言标注)/引用/有序无序列表(含嵌套)/链接/图片/分隔线/管道表格。
/// 【半独立契约】本类不依赖任何项目内类型；颜色优先取宿主 App 资源中同名 DynamicResource 键
/// （BgBrush/MainBrush/MutedBrush/AccentBrush/BorderBrush/…），缺失时回退内置暗色板——可整体移植到美术风格相近的项目。
/// 将本目录整体复制到其它 WPF 项目即可复用（含 xaml.cs + ops + README 契约）。
/// </summary>
public static partial class MarkdownRenderer
{
    private static readonly MarkdownPipeline Pipeline;
    private static readonly Lazy<FontFamily> MonoFont = new(() => new FontFamily("Consolas"));
    private static readonly Lazy<FontFamily> UiFont = new(() => new FontFamily("Microsoft YaHei UI"));

    static MarkdownRenderer()
    {
        var builder = new MarkdownPipelineBuilder();
        builder.UseAdvancedExtensions();
        Pipeline = builder.Build();
    }

    /// <summary>解析并渲染为 FlowDocument。baseDirectory 用于把相对图片/链接路径解析为绝对路径。</summary>
    public static FlowDocument Render(string markdown, string? baseDirectory = null)
    {
        var doc = Markdown.Parse(markdown ?? string.Empty, Pipeline);
        var flow = new FlowDocument
        {
            PagePadding = new Thickness(18, 14, 18, 18),
            LineHeight = 1.5,
            Background = C("BgBrush", Rgb(0x0D, 0x11, 0x17)),
        };
        flow.SetValue(TextElement.ForegroundProperty, C("MainBrush", Rgb(0xC9, 0xD1, 0xD9)));
        flow.SetValue(TextElement.FontFamilyProperty, UiFont.Value);
        flow.SetValue(TextElement.FontSizeProperty, 15.0);

        foreach (var block in doc)
        {
            var rendered = BuildBlock(block, 0, baseDirectory);
            if (rendered != null)
            {
                // 每个渲染块前插 0 高定位标记，Tag=该块源码起始行(0-based)，供编辑器做行号锚定滚动。
                flow.Blocks.Add(MakeLineMarker(block.Line));
                flow.Blocks.Add(rendered);
            }
        }
        return flow;
    }

    /// <summary>0 高 0 宽透明标记（BlockUIContainer+Border），借 TransformToAncestor 取渲染块的内容区像素 Y。</summary>
    internal static WpfBlock MakeLineMarker(int sourceLine)
        => new BlockUIContainer
        {
            Margin = new Thickness(0),
            Padding = new Thickness(0),
            Child = new Border { Height = 0, Width = 0, Background = Brushes.Transparent, Tag = sourceLine },
        };

    /// <summary>取宿主主题资源；缺失回退内置暗色。每次渲染实时解析（支持宿主在运行期换肤）。</summary>
    private static Brush C(string key, Brush fallback)
    {
        try
        {
            if (Application.Current?.TryFindResource(key) is Brush b) return b;
        }
        catch { /* 资源未就绪忽略 */ }
        return fallback;
    }

    // ---------------- 块级 ----------------

    private static WpfBlock? BuildBlock(MdBlock block, int indent, string? baseDir) => block switch
    {
        HeadingBlock h => BuildHeading(h),
        ParagraphBlock p => BuildParagraph(p),
        FencedCodeBlock f => BuildCode(f.Lines.ToString() ?? "", f.Info),
        CodeBlock c => BuildCode(c.Lines.ToString() ?? "", null),
        QuoteBlock q => BuildQuote(q, baseDir),
        ListBlock l => BuildList(l, indent, baseDir),
        ThematicBreakBlock => BuildRule(),
        MdTable t => BuildTable(t, baseDir),
        HtmlBlock hb => BuildHtmlBlock(hb),
        ContainerBlock cb when cb.Count == 1 => BuildBlock(cb[0], indent, baseDir),
        ContainerBlock cb => BuildFlattenSection(cb, indent, baseDir),
        _ => BuildParagraphFallback(block),
    };

    private static WpfBlock BuildHeading(HeadingBlock h)
    {
        double size = h.Level switch
        {
            1 => 24, 2 => 20, 3 => 17, 4 => 15.5, _ => 14.5,
        };
        var para = new Paragraph
        {
            Margin = new Thickness(0, h.Level == 1 ? 10 : 14, 0, 8),
            FontSize = size,
            FontWeight = FontWeights.Bold,
        };
        para.SetValue(TextElement.ForegroundProperty, C("MainBrush", Rgb(0xE6, 0xED, 0xF3)));
        if (h.Inline != null) AddInlines(para.Inlines, h.Inline, baseDir: null);
        return para;
    }

    private static WpfBlock BuildParagraph(ParagraphBlock p)
    {
        var para = new Paragraph { Margin = new Thickness(0, 0, 0, 12) };
        if (p.Inline != null) AddInlines(para.Inlines, p.Inline, baseDir: null);
        return para;
    }

    private static WpfBlock BuildFlattenSection(ContainerBlock cb, int indent, string? baseDir)
    {
        var sec = new Section { Margin = new Thickness(0) };
        foreach (var child in cb)
        {
            var b = BuildBlock(child, indent, baseDir);
            if (b != null) sec.Blocks.Add(b);
        }
        return sec;
    }

    private static WpfBlock BuildParagraphFallback(MdBlock block)
    {
        var para = new Paragraph { Margin = new Thickness(0, 3, 0, 7) };
        if (block is LeafBlock leaf && leaf.Inline != null) AddInlines(para.Inlines, leaf.Inline, baseDir: null);
        return para;
    }

    private static WpfBlock BuildCode(string? text, string? lang)
    {
        var para = new Paragraph
        {
            Margin = new Thickness(0, 6, 0, 10),
            Padding = new Thickness(12, 9, 12, 9),
            Background = C("GuideBgBrush", Rgb(0x16, 0x1B, 0x22)),
            BorderBrush = C("BorderBrush", Rgb(0x30, 0x36, 0x3D)),
            BorderThickness = new Thickness(1),
            FontFamily = MonoFont.Value,
            FontSize = 13,
        };
        para.SetValue(TextElement.ForegroundProperty, C("MainBrush", Rgb(0xD5, 0xD8, 0xDD)));
        if (!string.IsNullOrWhiteSpace(lang))
        {
            para.Inlines.Add(new Run(lang.Trim())
            {
                Foreground = C("MutedBrush", Rgb(0x9A, 0xA0, 0xAA)),
                FontFamily = UiFont.Value,
                FontSize = 11.5,
            });
            para.Inlines.Add(new LineBreak());
        }
        para.Inlines.Add(new Run(text ?? ""));
        return para;
    }

    private static WpfBlock BuildHtmlBlock(HtmlBlock hb)
    {
        var para = new Paragraph
        {
            Margin = new Thickness(0, 3, 0, 7),
            FontFamily = MonoFont.Value,
            FontSize = 12.5,
        };
        para.SetValue(TextElement.ForegroundProperty, C("MutedBrush", Rgb(0x9A, 0xA0, 0xAA)));
        para.Inlines.Add(new Run(TrimLines(hb.Lines.ToString())));
        return para;
    }

    private static WpfBlock BuildQuote(QuoteBlock q, string? baseDir)
    {
        var para = new Paragraph
        {
            Margin = new Thickness(0, 3, 0, 12),
            Padding = new Thickness(16, 0, 16, 0),
            BorderBrush = C("BorderBrush", Rgb(0x30, 0x36, 0x3D)),
            BorderThickness = new Thickness(4, 0, 0, 0),
        };
        para.SetValue(TextElement.ForegroundProperty, C("MutedBrush", Rgb(0x8B, 0x94, 0x9E)));
        bool first = true;
        foreach (var child in q)
        {
            if (!first) para.Inlines.Add(new LineBreak());
            first = false;
            if (child is ParagraphBlock pp && pp.Inline != null) AddInlines(para.Inlines, pp.Inline, baseDir);
            else if (child is LeafBlock leaf && leaf.Inline != null) AddInlines(para.Inlines, leaf.Inline, baseDir);
        }
        return para;
    }

    private static WpfBlock BuildList(ListBlock list, int indent, string? baseDir)
    {
        var sec = new Section { Margin = new Thickness(0) };
        int number = ParseStart(list.OrderedStart);
        bool ordered = list.IsOrdered;
        var marker = Rgb(0xC9, 0xD1, 0xD9);   // 列表标记用正文同色，去色更贴近 GitHub

        foreach (var child in list)
        {
            if (child is not ListItemBlock item) continue;
            var para = new Paragraph { Margin = indent > 0 ? new Thickness(18 * indent, 1, 0, 2) : new Thickness(0, 1, 0, 2) };
            var prefix = ordered ? number++.ToString() + ". " : "•  ";
            para.Inlines.Add(new Run(prefix) { Foreground = marker });

            foreach (var ib in item)
            {
                if (ib is ParagraphBlock pp && pp.Inline != null)
                {
                    AddInlines(para.Inlines, pp.Inline, baseDir);
                    para.Inlines.Add(new LineBreak());
                }
                else if (ib is LeafBlock lf && lf.Inline != null)
                {
                    AddInlines(para.Inlines, lf.Inline, baseDir);
                    para.Inlines.Add(new LineBreak());
                }
                else if (ib is ListBlock sub)
                {
                    var runs = CollectFlatListText(sub, baseDir, indent + 1, marker);
                    foreach (var r in runs) { para.Inlines.Add(r); para.Inlines.Add(new LineBreak()); }
                }
            }
            sec.Blocks.Add(para);
        }
        return sec;
    }

    private static List<Run> CollectFlatListText(ListBlock list, string? baseDir, int indent, Brush marker)
    {
        var runs = new List<Run>();
        int number = ParseStart(list.OrderedStart);
        foreach (var child in list)
        {
            if (child is not ListItemBlock item) continue;
            var pre = list.IsOrdered ? number++.ToString() + ". " : "•  ";
            runs.Add(new Run(new string(' ', indent * 2) + pre) { Foreground = marker });
            foreach (var ib in item)
            {
                if (ib is ParagraphBlock pp && pp.Inline != null) runs.AddRange(InlineAsRuns(pp.Inline, baseDir));
                else if (ib is LeafBlock lf && lf.Inline != null) runs.AddRange(InlineAsRuns(lf.Inline, baseDir));
            }
            runs.Add(new Run("\n"));
        }
        return runs;
    }

    private static WpfBlock BuildRule()
        => new BlockUIContainer
        {
            Margin = new Thickness(0, 10, 0, 12),
            Child = new Border { Height = 1, Background = C("BorderBrush", Rgb(0x30, 0x36, 0x3D)), Margin = new Thickness(0, 4, 0, 4) },
        };

    private static WpfBlock BuildTable(MdTable t, string? baseDir)
    {
        var rows = new List<MdTableRow>();
        foreach (var b in t) if (b is MdTableRow r) rows.Add(r);

        // Markdig 管道表每个 cell 的 ColumnIndex 恒为 -1（列信息不提供），
        // ColumnDefinitions 还常含 1 列幻影——不能依赖二者定位，否则首列丢失。
        // 改为按行内出现顺序位置式填列：每 cell 占用一列，行内顺序即列序。
        int cols = 0;
        foreach (var row in rows)
        {
            int cur = 0;
            foreach (var c in row) if (c is MdTableCell) cur++;
            if (cur > cols) cols = cur;
        }
        if (cols <= 0) cols = 1;

        var wpf = new System.Windows.Documents.Table
        {
            CellSpacing = 1,
            Background = C("BorderBrush", Rgb(0x38, 0x40, 0x4B)),
            Margin = new Thickness(0, 5, 0, 9),
        };
        for (int i = 0; i < cols; i++) wpf.Columns.Add(new TableColumn { Width = new GridLength(1, GridUnitType.Star) });
        var grp = new TableRowGroup();
        wpf.RowGroups.Add(grp);

        var cellBg = C("CardBrush", Rgb(0x16, 0x1B, 0x22));
        var rowAlt = C("ChipRowBrush", Rgb(0x1C, 0x21, 0x28));
        var headBg = C("BarBrush", Rgb(0x16, 0x1B, 0x22));
        int rowIndex = 0;
        foreach (var row in rows)
        {
            var tr = new System.Windows.Documents.TableRow();
            foreach (var c in row)
            {
                if (c is not MdTableCell mcell) continue;
                var cell = new System.Windows.Documents.TableCell
                {
                    Padding = new Thickness(8, 4, 8, 4),
                    Background = row.IsHeader ? headBg : headlessbg(rowIndex, rowAlt, cellBg),
                };
                var para = new Paragraph { Margin = new Thickness(0), FontSize = 13.5 };
                if (row.IsHeader)
                {
                    para.FontWeight = FontWeights.Bold;
                    para.SetValue(TextElement.ForegroundProperty, C("MainBrush", Rgb(0xF2, 0xF5, 0xFA)));
                }
                foreach (var cc in mcell)
                {
                    if (cc is ParagraphBlock cp && cp.Inline != null) AddInlines(para.Inlines, cp.Inline, baseDir);
                    else if (cc is LeafBlock cl && cl.Inline != null) AddInlines(para.Inlines, cl.Inline, baseDir);
                }
                cell.Blocks.Add(para);
                tr.Cells.Add(cell);
            }
            while (tr.Cells.Count < cols) tr.Cells.Add(new System.Windows.Documents.TableCell());
            grp.Rows.Add(tr);
            rowIndex++;
        }
        return wpf;

        static Brush headlessbg(int i, Brush alt, Brush @base) => i % 2 == 1 ? alt : @base;
    }

    // ---------------- 行内级 ----------------

    private static void AddInlines(InlineCollection dest, ContainerInline root, string? baseDir)
    {
        if (root == null) return;
        foreach (var child in root) AddInline(dest, child, baseDir);
    }

    private static void AddInline(InlineCollection dest, MdInline inl, string? baseDir)
    {
        switch (inl)
        {
            case LiteralInline lit:
                dest.Add(new Run(lit.Content.ToString()));
                break;
            case CodeInline code:
                dest.Add(new Run(code.Content)
                {
                    FontFamily = MonoFont.Value,
                    FontSize = 13,
                    Foreground = C("MainBrush", Rgb(0xC9, 0xD1, 0xD9)),
                    Background = Rgb(0x30, 0x36, 0x3D),
                });
                break;
            case EmphasisInline em:
                dest.Add(BuildEmphasis(em, baseDir));
                break;
            case LinkInline link:
                dest.Add(BuildLink(link, baseDir));
                break;
            case AutolinkInline auto:
                dest.Add(BuildAutolink(auto));
                break;
            case HtmlInline h:
                dest.Add(new Run(h.Tag));
                break;
            case HtmlEntityInline he:
                dest.Add(new Run(he.Original.ToString()));
                break;
            case LineBreakInline:
                dest.Add(new LineBreak());
                break;
            default:
                if (inl is ContainerInline c)
                {
                    foreach (var cc in c) AddInline(dest, cc, baseDir);
                }
                else
                {
                    dest.Add(new Run(inl.ToString() ?? ""));
                }
                break;
        }
    }

    private static List<Run> InlineAsRuns(ContainerInline root, string? baseDir)
    {
        var runs = new List<Run>();
        foreach (var child in root)
        {
            switch (child)
            {
                case LiteralInline lit:
                    runs.Add(new Run(lit.Content.ToString()));
                    break;
                case CodeInline code:
                    runs.Add(new Run(code.Content) { FontFamily = MonoFont.Value });
                    break;
                case EmphasisInline em:
                    runs.Add(new Run(InlineAsRuns(em, baseDir).TextOfRuns())
                    {
                        FontWeight = em.DelimiterChar == '~' ? FontWeights.Normal : (em.DelimiterCount >= 2 ? FontWeights.Bold : FontWeights.Normal),
                    });
                    break;
                case LinkInline link:
                    runs.Add(new Run(InlineAsRuns(link, baseDir).TextOfRuns()));
                    break;
                case AutolinkInline auto:
                    runs.Add(new Run(auto.Url));
                    break;
                case HtmlEntityInline he:
                    runs.Add(new Run(he.Original.ToString()));
                    break;
                case HtmlInline h:
                    runs.Add(new Run(h.Tag));
                    break;
                case LineBreakInline:
                    runs.Add(new Run(" "));
                    break;
                default:
                    runs.Add(new Run(child.ToString() ?? ""));
                    break;
            }
        }
        return runs;
    }

    private static string TextOfRuns(this List<Run> runs)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var r in runs) sb.Append(r.Text);
        return sb.ToString();
    }

    private static WpfInline BuildEmphasis(EmphasisInline em, string? baseDir)
    {
        var span = new Span();
        if (em.DelimiterChar == '~')
            span.TextDecorations = TextDecorations.Strikethrough;
        else if (em.DelimiterCount >= 2)
            span.FontWeight = FontWeights.Bold;
        else
            span.FontStyle = FontStyles.Italic;
        foreach (var child in em) AddInline(span.Inlines, child, baseDir);
        return span;
    }

    private static WpfInline BuildAutolink(AutolinkInline auto)
    {
        var h = new Hyperlink { NavigateUri = MakeUri(auto.Url), Foreground = C("AccentBrush", Rgb(0x5D, 0x9B, 0xFF)), IsEnabled = true };
        h.RequestNavigate += static (_, e) => OpenLink(e.Uri?.AbsoluteUri ?? e.Uri?.OriginalString);
        h.Inlines.Add(new Run(auto.Url));
        return h;
    }

    private static WpfInline BuildLink(LinkInline link, string? baseDir)
    {
        if (link.IsImage) return BuildImage(link, baseDir);

        var url = link.Url ?? "";
        var h = new Hyperlink { Foreground = C("AccentBrush", Rgb(0x5D, 0x9B, 0xFF)), IsEnabled = true };
        bool any = false;
        foreach (var child in link) { AddInline(h.Inlines, child, baseDir); any = true; }
        if (!any) h.Inlines.Add(new Run(url));

        if (!string.IsNullOrWhiteSpace(url))
        {
            var abs = ResolveUrl(url, baseDir);
            if (abs != null)
            {
                h.NavigateUri = abs;
                h.RequestNavigate += static (_, e) => OpenLink(e.Uri?.AbsoluteUri ?? e.Uri?.OriginalString);
            }
        }
        return h;
    }

    private static WpfInline BuildImage(LinkInline link, string? baseDir)
    {
        var src = LoadImage(link.Url, baseDir);
        if (src == null) return new Run("📷 " + (link.Url ?? ""));
        return new InlineUIContainer(new Image { Source = src, Stretch = Stretch.Uniform, MaxWidth = 620, MaxHeight = 420 });
    }

    // ---------------- 链接/图片 工具 ----------------

    private static Uri? MakeUri(string url)
        => Uri.TryCreate(url, UriKind.RelativeOrAbsolute, out var u) ? u : null;

    private static Uri? ResolveUrl(string url, string? baseDir)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        if (Uri.TryCreate(url, UriKind.Absolute, out var abs)) return abs;
        if (url.IndexOf("://", StringComparison.Ordinal) > 0)
        {
            if (Uri.TryCreate(url, UriKind.Absolute, out var spec)) return spec;
        }
        if (!string.IsNullOrEmpty(baseDir) && Directory.Exists(baseDir))
        {
            var full = Path.GetFullPath(Path.Combine(baseDir, url.Replace('/', '\\')));
            if (File.Exists(full) || Directory.Exists(full)) return new Uri(full);
        }
        return null;
    }

    private static ImageSource? LoadImage(string? url, string? baseDir)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        try
        {
            var resolved = ResolveUrl(url, baseDir);
            if (resolved == null) return null;
            if (resolved.Scheme is "http" or "https")
            {
                var bi = new BitmapImage(new Uri(resolved.AbsoluteUri)) { CacheOption = BitmapCacheOption.OnLoad };
                bi.Freeze();
                return bi;
            }
            if (resolved.IsFile && File.Exists(resolved.LocalPath))
            {
                var bi = new BitmapImage();
                bi.BeginInit();
                bi.CacheOption = BitmapCacheOption.OnLoad;
                bi.UriSource = resolved;
                bi.EndInit();
                bi.Freeze();
                return bi;
            }
        }
        catch (IOException) { }
        catch (NotSupportedException) { }
        catch (UriFormatException) { }
        return null;
    }

    private static void OpenLink(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (System.ComponentModel.Win32Exception) { }
        catch (InvalidOperationException) { }
    }

    private static int ParseStart(string? s)
        => int.TryParse(s, out var v) ? v : 1;

    private static string TrimLines(string? s)
        => string.IsNullOrEmpty(s) ? "" : s.TrimEnd();

    private static Brush Rgb(byte r, byte g, byte b)
    {
        var br = new SolidColorBrush(Color.FromRgb(r, g, b));
        br.Freeze();
        return br;
    }
}