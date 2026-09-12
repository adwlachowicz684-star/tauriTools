using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Win32;
using static FenPeiXiangMuZu.Portable.MarkdownEditor.MarkdownEditOps;

namespace FenPeiXiangMuZu.Portable.MarkdownEditor;

/// <summary>
/// 半独立 Markdown 编辑器窗（编辑 + 富样式实时预览 + 原生工具栏）。
/// 与宿主零耦合：仅依赖主题资源键 + Markdig；整目录(本窗口+Renderer+Ops+README)复制到其它 WPF 工程即可复用。
/// </summary>
public partial class MarkdownEditorWindow : Window
{
    private enum Mode { Split, Edit, Preview }

    /// <summary>同步滚动粒度：Line=行号锚定（块内按行细分）；Block=块级语义（只对齐块起点）。</summary>
    private enum SyncKind { Line, Block }

    private const double AnchorRatio = 0.4;   // 左右锚线取视口中间偏上，作为行对齐基准

    private string _filePath = "";
    private bool _dirty;
    private bool _suppressPreview;
    private readonly DispatcherTimer _previewTimer;
    private readonly DispatcherTimer _syncTimer;   // 同步防抖：两端滚动停稳后执行一次对齐
    private char _pendingSource;                   // 待对齐来源端：'E'=编辑，'P'=预览
    private SyncKind _syncKind = SyncKind.Line;
    private ScrollViewer? _previewSv;         // 预览区内部滚动容器（FlowDocumentScrollViewer 模板内）
    private ScrollViewer? _editSv;            // 编辑 TextBox 内部滚动容器（TextBox 自身滚动）
    private ScrollContentPresenter? _contentRoot; // 预览文档内容宿主，用于坐标系换算
    private readonly List<PreviewAnchor> _anchors = new();
    private bool _anchorsValid;
    private string? _resizeDir;            // 当前边缘拖拽方向：L/R/T/B/LT/RT/LB/RB；空=未在拖拽
    private Point _resizeStart;            // 拖拽起点（窗口坐标）
    private Rect _resizeStartBounds;       // 拖拽起点窗口矩形（Left/Top/Width/Height）

    /// <summary>预览端一个渲染块的定位：块所对应源码起始行(0-based) + 块起点在内容区的像素 Y。</summary>
    private readonly record struct PreviewAnchor(int Line, double Y);

    public MarkdownEditorWindow()
    {
        InitializeComponent();
        _previewTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(280) };
        _previewTimer.Tick += (_, _) => { _previewTimer.Stop(); RenderPreview(); };
        _syncTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(30) };
        _syncTimer.Tick += (_, _) => { _syncTimer.Stop(); Align(_pendingSource); };
        SetMode(Mode.Split);
        UpdateStatus();
        Loaded += OnLoaded;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        // 编辑器滚动发生在 TextBox 内部（VerticalScrollBarVisibility=Auto，自身响应滚轮/滚动条）；
        // 预览区取内部 ScrollViewer 与之同步。
        _editSv = FindVisualChild<ScrollViewer>(Editor);
        _previewSv = FindVisualChild<ScrollViewer>(Preview);
        if (_editSv != null)
            _editSv.AddHandler(ScrollViewer.ScrollChangedEvent, new ScrollChangedEventHandler(OnEditorScrollUpdate));
        if (_previewSv != null)
        {
            _contentRoot = FindVisualChild<ScrollContentPresenter>(_previewSv);
            _previewSv.AddHandler(ScrollViewer.ScrollChangedEvent, new ScrollChangedEventHandler(OnPreviewScroll));
        }
        Dispatcher.BeginInvoke(new Action(() => RebuildAnchors()), DispatcherPriority.Loaded);
    }

    private void OnEditorScrollUpdate(object sender, ScrollChangedEventArgs e)
    {
        if (!_syncingGuard && e.VerticalChange != 0) DeferAlign('E');
    }
    private void OnPreviewScroll(object sender, ScrollChangedEventArgs e)
    {
        if (!_syncingGuard && e.VerticalChange != 0) DeferAlign('P');
    }

    /// <summary>防抖登记：一端滚动时重置计时器，停稳后执行一次对齐，避免实时互锁把对端/本端拽回。</summary>
    private void DeferAlign(char source)
    {
        _pendingSource = source;
        _syncTimer.Stop();
        _syncTimer.Start();
    }

    /// <summary>Aligner：把对端滚到"本端锚线所在 Markdown 行"对应的位置。</summary>
    private void Align(char source)
    {
        if (_editSv == null || _previewSv == null) return;
        if (!_anchorsValid) RebuildAnchors();
        if (_anchors.Count == 0) return;
        if (source == 'E')
        {
            int line = SourceLogicalLineAtY(_editSv.VerticalOffset + AnchorRatio * _editSv.ViewportHeight);
            double py = PreviewYForLine(line);
            double target = py - AnchorRatio * _previewSv.ViewportHeight;
            if (Math.Abs(_previewSv.VerticalOffset - target) < AlignEps(_previewSv)) return;
            ProgrammaticScroll(_previewSv, target);
        }
        else
        {
            int line = PreviewLineAtY(_previewSv.VerticalOffset + AnchorRatio * _previewSv.ViewportHeight);
            double sy = SourceYForLine(line);
            double target = sy - AnchorRatio * _editSv.ViewportHeight;
            if (Math.Abs(_editSv.VerticalOffset - target) < AlignEps(_editSv)) return;
            ProgrammaticScroll(_editSv, target);
        }
    }

    /// <summary>程序滚动期间标记，让对端 ScrollChanged 不再反过来登记对齐。
    /// 延迟到渲染帧再释放：滚动会引发滚动条可视性/布局的第二次 ScrollChanged，
    /// 若同步放行会逃逸触发反向对齐，两端来回微调即成"一闪一闪"的振荡。</summary>
    private bool _syncingGuard;
    private void ProgrammaticScroll(ScrollViewer sv, double offset)
    {
        _syncingGuard = true;
        try { sv.ScrollToVerticalOffset(offset); }
        finally
        {
            Dispatcher.BeginInvoke(new Action(() => _syncingGuard = false), DispatcherPriority.Loaded);
        }
    }

    /// <summary>对齐容忍度：对端距离目标小于该值就跳过滚动，压制亚像素/滚动条抖动。</summary>
    private static double AlignEps(ScrollViewer sv) => Math.Max(2.0, 0.01 * sv.ViewportHeight);

    /// <summary>重渲染后从文档收集块标记，重建"源码起始行 → 块像素 Y"锚点表。</summary>
    private void RebuildAnchors()
    {
        _anchors.Clear();
        _anchorsValid = Preview.Document != null;
        if (Preview.Document == null || _contentRoot == null) return;
        foreach (var b in Preview.Document.Blocks)
        {
            if (b is not BlockUIContainer bc || bc.Child is not Border bd || bd.Tag is not int line) continue;
            double y;
            try { y = bd.TransformToAncestor(_contentRoot).Transform(new Point(0, 0)).Y; }
            catch { y = 0; }
            _anchors.Add(new PreviewAnchor(line, y));
        }
        _anchors.Sort((a, b) => a.Line.CompareTo(b.Line));
    }

    /// <summary>源码锚线像素 y → 所在源码逻辑行（0-based）。基于 TextBox 逻辑行布局二分。</summary>
    private int SourceLogicalLineAtY(double y)
    {
        int lo = 0, hi = Math.Max(0, Editor.LineCount - 1), ans = 0;
        while (lo <= hi)
        {
            int mid = (lo + hi) / 2;
            double ty = SourceYForLine(mid);
            if (ty <= y) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return Math.Clamp(ans, 0, Math.Max(0, Editor.LineCount - 1));
    }

    /// <summary>源码逻辑行 → 该行首字符在编辑内容区的像素 Y。</summary>
    private double SourceYForLine(int line)
    {
        try
        {
            int ci = Editor.GetCharacterIndexFromLineIndex(line);
            if (ci < 0) return 0;
            return Editor.GetRectFromCharacterIndex(ci).Top;
        }
        catch { return 0; }
    }

    /// <summary>源码逻辑行 → 预览纵向位置（块起点精确；块级模式下只对齐块起点，行号模式下块内按跨度均分高度近似）。</summary>
    private double PreviewYForLine(int line)
    {
        if (_anchors.Count == 0) return 0;
        int idx = _anchors.Count - 1;
        for (int i = 0; i < _anchors.Count; i++)
            if (_anchors[i].Line > line) { idx = i - 1; break; }
        if (idx < 0) idx = 0;
        var a = _anchors[idx];
        if (_syncKind == SyncKind.Block) return a.Y;   // 块级：只对齐块起点
        int span = (idx + 1 < _anchors.Count ? _anchors[idx + 1].Line : line + 1) - a.Line;
        if (span < 1) span = 1;
        double hBlk = idx + 1 < _anchors.Count ? _anchors[idx + 1].Y - a.Y : 60;
        if (hBlk <= 0) hBlk = 60;
        int k = Math.Max(0, line - a.Line);
        double ratio = (double)k / span;
        if (ratio > 1) ratio = 1;
        return a.Y + ratio * hBlk;
    }

    /// <summary>预览锚线像素 y → 所在源码逻辑行（块级模式下返回块起始行；行号模式下块内按跨度均分反推）。</summary>
    private int PreviewLineAtY(double y)
    {
        if (_anchors.Count == 0) return 0;
        int idx = _anchors.Count - 1;
        for (int i = 0; i < _anchors.Count; i++)
            if (_anchors[i].Y > y) { idx = i - 1; break; }
        if (idx < 0) return _anchors[0].Line;
        var a = _anchors[idx];
        if (_syncKind == SyncKind.Block) return a.Line;  // 块级：只返回块起始行
        int span = (idx + 1 < _anchors.Count ? _anchors[idx + 1].Line : a.Line + 1) - a.Line;
        if (span < 1) span = 1;
        double hBlk = idx + 1 < _anchors.Count ? _anchors[idx + 1].Y - a.Y : 60;
        if (hBlk <= 0) return a.Line;
        double ratio = Math.Clamp((y - a.Y) / hBlk, 0, 1);
        return a.Line + (int)Math.Floor(ratio * span);
    }

    // ---------------- 同步粒度切换 ----------------

    private void OnSyncLine(object sender, RoutedEventArgs e) { _syncKind = SyncKind.Line; SyncLineBtn.IsChecked = true; SyncBlockBtn.IsChecked = false; }
    private void OnSyncBlock(object sender, RoutedEventArgs e) { _syncKind = SyncKind.Block; SyncBlockBtn.IsChecked = true; SyncLineBtn.IsChecked = false; }

    private static T? FindVisualChild<T>(DependencyObject parent) where T : DependencyObject
    {
        int n = VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < n; i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is T t) return t;
            var r = FindVisualChild<T>(child);
            if (r != null) return r;
        }
        return null;
    }

    /// <summary>便携入口：打开/复用编辑器窗，可带初始文件或初始文本。</summary>
    public static MarkdownEditorWindow ShowWindow(Window? owner, string? filePath = null, string? initialText = null)
    {
        var win = new MarkdownEditorWindow { Owner = owner != null && owner != Application.Current?.MainWindow ? owner : null };
        if (!string.IsNullOrEmpty(filePath) && File.Exists(filePath))
            win.LoadFile(filePath);
        else if (initialText != null)
            win.SetText(initialText);
        win.Show();
        win.Activate();
        return win;
    }

    public void LoadFile(string path)
    {
        try
        {
            var text = File.ReadAllText(path);
            _filePath = path;
            _suppressPreview = true;
            Editor.Text = text;
            _suppressPreview = false;
            _dirty = false;
            Title = "Markdown — " + Path.GetFileName(path);
            RenderPreview();
            UpdateStatus();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "打开文件失败：" + ex.Message, "Markdown", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void SetText(string text)
    {
        _suppressPreview = true;
        Editor.Text = text;
        _suppressPreview = false;
        _dirty = true;
        RenderPreview();
        UpdateStatus();
    }

    // ---------------- 打开 / 保存 ----------------

    private void OnOpen(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog { Filter = "Markdown (*.md)|*.md|文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*" };
        if (!string.IsNullOrEmpty(_filePath)) dlg.InitialDirectory = Path.GetDirectoryName(_filePath);
        if (dlg.ShowDialog(this) == true) LoadFile(dlg.FileName);
    }

    private void OnSave(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_filePath)) { OnSaveAs(sender, e); return; }
        SaveTo(_filePath);
    }

    private void OnSaveAs(object sender, RoutedEventArgs e)
    {
        var dlg = new SaveFileDialog
        {
            Filter = "Markdown (*.md)|*.md|文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*",
            FileName = string.IsNullOrEmpty(_filePath) ? "未命名.md" : Path.GetFileName(_filePath),
        };
        if (!string.IsNullOrEmpty(_filePath)) dlg.InitialDirectory = Path.GetDirectoryName(_filePath);
        if (dlg.ShowDialog(this) == true) SaveTo(dlg.FileName);
    }

    private void SaveTo(string path)
    {
        try
        {
            File.WriteAllText(path, Editor.Text, new System.Text.UTF8Encoding(false));
            _filePath = path;
            _dirty = false;
            Title = "Markdown — " + Path.GetFileName(path);
            UpdateStatus();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "保存文件失败：" + ex.Message, "Markdown", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    // ---------------- 撤销 / 重做 ----------------

    private void OnUndo(object sender, RoutedEventArgs e) { Editor.Focus(); Editor.Undo(); }
    private void OnRedo(object sender, RoutedEventArgs e) { Editor.Focus(); Editor.Redo(); }

    // ---------------- 工具栏插入 ----------------

    private void OnH1(object sender, RoutedEventArgs e) => ToggleLinePrefix("# ");
    private void OnH2(object sender, RoutedEventArgs e) => ToggleLinePrefix("## ");
    private void OnH3(object sender, RoutedEventArgs e) => ToggleLinePrefix("### ");
    private void OnQuote(object sender, RoutedEventArgs e) => ToggleLinePrefix("> ");
    private void OnUl(object sender, RoutedEventArgs e) => ToggleLinePrefix("- ");
    private void OnOl(object sender, RoutedEventArgs e) => ToggleLinePrefix("1. ");
    private void OnBold(object sender, RoutedEventArgs e) => ApplyOp((t, s, l) => Wrap(t, s, l, "**", "**"));
    private void OnItalic(object sender, RoutedEventArgs e) => ApplyOp((t, s, l) => Wrap(t, s, l, "*", "*"));
    private void OnStrike(object sender, RoutedEventArgs e) => ApplyOp((t, s, l) => Wrap(t, s, l, "~~", "~~"));
    private void OnCode(object sender, RoutedEventArgs e) => ApplyOp((t, s, l) => Wrap(t, s, l, "`", "`"));
    private void OnFence(object sender, RoutedEventArgs e) => ApplyOp((t, s, l) => Wrap(t, s, l, "\n```\n", "\n```\n"));
    private void OnLink(object sender, RoutedEventArgs e) => ApplyOp((t, s, l) => Wrap(t, s, l, "[", "](url)"));
    private void OnTable(object sender, RoutedEventArgs e) => ApplyOp((t, s, l) => InsertAt(t, s, BuildTable(3, 3)));

    private void ToggleLinePrefix(string prefix)
        => ApplyOp((t, s, l) => MarkdownEditOps.ToggleLinePrefix(t, s, l, prefix));

    private void ApplyOp(Func<string, int, int, Result> op)
    {
        Editor.Focus();
        var (start, len) = (Editor.SelectionStart, Editor.SelectionLength);
        var r = op(Editor.Text, start, len);
        _suppressPreview = true;
        Editor.Text = r.Text;
        Editor.SelectionStart = Math.Clamp(r.Caret, 0, r.Text.Length);
        Editor.SelectionLength = 0;
        _suppressPreview = false;
        MarkDirty();
        SchedulePreview();
        UpdateStatus();
    }

    private void OnImage(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog
        {
            Filter = "图片文件 (*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.svg)|*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.svg|所有文件 (*.*)|*.*",
            Title = "选择要插入的图片",
        };
        if (!string.IsNullOrEmpty(_filePath)) dlg.InitialDirectory = Path.GetDirectoryName(_filePath);
        if (dlg.ShowDialog(this) != true) return;

        var rel = PrepareImageRef(dlg.FileName, out var error);
        if (rel == null)
        {
            MessageBox.Show(this, error, "插入图片", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        Editor.Focus();
        var start = Editor.SelectionStart;
        var len = Editor.SelectionLength;
        var alt = len > 0 ? Editor.Text.Substring(start, len) : Path.GetFileNameWithoutExtension(dlg.FileName);
        var snippet = "![" + alt + "](" + rel + ")";
        _suppressPreview = true;
        Editor.Text = Editor.Text.Substring(0, start) + snippet + Editor.Text.Substring(start + len);
        Editor.SelectionStart = start;
        Editor.SelectionLength = 0;
        _suppressPreview = false;
        MarkDirty();
        SchedulePreview();
        UpdateStatus();
    }

    /// <summary>把源图片复制到当前 md 所在目录，返回可插入的相对路径；文档未保存或复制失败返回 null。</summary>
    private string? PrepareImageRef(string source, out string? error)
    {
        error = null;
        if (string.IsNullOrEmpty(_filePath))
        {
            error = "请先保存 Markdown 文档，再插入图片（相对路径依赖文档所在目录）。";
            return null;
        }

        var targetDir = Path.GetDirectoryName(_filePath)!;
        var ext = Path.GetExtension(source);
        var baseName = Path.GetFileNameWithoutExtension(source);
        var target = Path.Combine(targetDir, Path.GetFileName(source));

        if (!string.Equals(Path.GetFullPath(source), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
        {
            // 源不在 md 目录：复制过去，重名时自动加序号
            var seq = 1;
            while (File.Exists(target))
                target = Path.Combine(targetDir, baseName + "_" + (seq++) + ext);
            try { File.Copy(source, target); }
            catch (Exception ex) { error = "复制图片失败：" + ex.Message; return null; }
        }
        return Path.GetFileName(target);
    }

    // ---------------- 预览 / 模式 ----------------

    private void OnEditorTextChanged(object sender, TextChangedEventArgs e)
    {
        UpdateStatus();
        if (!_suppressPreview) SchedulePreview();
    }

    private void SchedulePreview()
    {
        _previewTimer.Stop();
        _previewTimer.Start();
    }

    private void RenderPreview()
    {
        // 记录当前预览锚线所在的源码逻辑行，重渲染后恢复到该行，避免输入时新文档把两侧拽回顶部
        int keepLine = -1;
        if (_anchorsValid && _anchors.Count > 0 && _previewSv is { ScrollableHeight: > 0 })
            keepLine = PreviewLineAtY(_previewSv.VerticalOffset + AnchorRatio * _previewSv.ViewportHeight);

        try
        {
            string? baseDir = string.IsNullOrEmpty(_filePath) ? null : Path.GetDirectoryName(_filePath);
            Preview.Document = MarkdownRenderer.Render(Editor.Text, baseDir);
        }
        catch (Exception ex)
        {
            Preview.Document = null;
            Preview.Background = Brushes.Crimson;
            Preview.Document = MarkdownRenderer.Render("**渲染出错**（仍可继续编辑，保存后内容不丢失）：\n\n```\n" + ex + "\n```");
        }

        Dispatcher.BeginInvoke(new Action(() =>
        {
            RebuildAnchors();
            if (_previewSv != null && keepLine >= 0 && _anchors.Count > 0 && _previewSv.ScrollableHeight > 0)
                ProgrammaticScroll(_previewSv,
                    PreviewYForLine(keepLine) - AnchorRatio * _previewSv.ViewportHeight);
        }), DispatcherPriority.Loaded);
    }

    private void OnModeSplit(object sender, RoutedEventArgs e) => SetMode(Mode.Split);
    private void OnModeEdit(object sender, RoutedEventArgs e) => SetMode(Mode.Edit);
    private void OnModePreview(object sender, RoutedEventArgs e) => SetMode(Mode.Preview);

    private void SetMode(Mode m)
    {
        ModeSplit.IsChecked = m == Mode.Split;
        ModeEdit.IsChecked = m == Mode.Edit;
        ModePreview.IsChecked = m == Mode.Preview;
        var star = new GridLength(1, GridUnitType.Star);
        switch (m)
        {
            case Mode.Split:
                ColEditor.Width = star; ColEditor.MinWidth = 260;
                ColPreview.Width = star; ColPreview.MinWidth = 260;
                ColSplit.Width = new GridLength(6); Splitter.Visibility = Visibility.Visible;
                EditorHost.Visibility = Visibility.Visible; PreviewHost.Visibility = Visibility.Visible;
                break;
            case Mode.Edit:
                ColEditor.Width = star; ColEditor.MinWidth = 260;
                ColPreview.Width = new GridLength(0); ColPreview.MinWidth = 0;
                ColSplit.Width = new GridLength(0); Splitter.Visibility = Visibility.Collapsed;
                EditorHost.Visibility = Visibility.Visible; PreviewHost.Visibility = Visibility.Collapsed;
                break;
            case Mode.Preview:
                ColEditor.Width = new GridLength(0); ColEditor.MinWidth = 0;
                ColPreview.Width = star; ColPreview.MinWidth = 260;
                ColSplit.Width = new GridLength(0); Splitter.Visibility = Visibility.Collapsed;
                EditorHost.Visibility = Visibility.Collapsed; PreviewHost.Visibility = Visibility.Visible;
                break;
        }
    }

    private void OnSelectionChanged(object sender, RoutedEventArgs e) => UpdateStatus();

    // ---------------- 状态栏 ----------------

    private void MarkDirty()
    {
        if (_dirty) return;
        _dirty = true;
        UpdateStatus();
    }

    private void UpdateStatus()
    {
        int chars = Editor.Text.Length;
        var (line, col) = MarkdownEditOps.LineCol(Editor.Text, Editor.CaretIndex);
        LblCount.Text = chars.ToString("N0") + " 字符";
        LblPos.Text = $"行 {line + 1}, 列 {col + 1}";
        string name = string.IsNullOrEmpty(_filePath) ? "未命名.md" : Path.GetFileName(_filePath);
        Title = (_dirty ? "● " : "") + "Markdown — " + name;
        LblFile.Text = string.IsNullOrEmpty(_filePath) ? "未命名.md" : _filePath;
        LblDirty.Text = _dirty ? "未保存" : "";
        LblDirty.Visibility = _dirty ? Visibility.Visible : Visibility.Collapsed;
    }

    // ---------------- 拖放 / 快捷键 ----------------

    private void OnTitleBarDrag(object sender, MouseButtonEventArgs e)
    {
        if (e.LeftButton != MouseButtonState.Pressed) return;
        try { DragMove(); } catch { }
    }

    private void OnTitleBarClose(object sender, RoutedEventArgs e) => Close();

    // ---------------- 无边框窗边缘拖拽调整大小 ----------------

    private void ResizeMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton != MouseButton.Left) return;
        if (sender is not FrameworkElement fe || fe.Tag is not string dir) return;
        _resizeDir = dir;
        _resizeStart = e.GetPosition(this);
        _resizeStartBounds = new Rect(Left, Top, ActualWidth, ActualHeight);
        fe.MouseMove += ResizeMouseMove;
        fe.MouseLeftButtonUp += ResizeMouseUp;
        fe.CaptureMouse();
        e.Handled = true;
    }

    private void ResizeMouseMove(object sender, MouseEventArgs e)
    {
        if (_resizeDir == null) return;
        var cur = e.GetPosition(this);
        double dx = cur.X - _resizeStart.X;
        double dy = cur.Y - _resizeStart.Y;
        var b = _resizeStartBounds;
        double nw = b.Width, nh = b.Height, nx = b.X, ny = b.Y;

        if (_resizeDir.Contains('R')) nw = Math.Max(MinWidth, b.Width + dx);
        if (_resizeDir.Contains('L')) { var w = Math.Max(MinWidth, b.Width - dx); nx = b.X + (b.Width - w); nw = w; }
        if (_resizeDir.Contains('B')) nh = Math.Max(MinHeight, b.Height + dy);
        if (_resizeDir.Contains('T')) { var h = Math.Max(MinHeight, b.Height - dy); ny = b.Y + (b.Height - h); nh = h; }

        Width = nw; Left = nx;
        Height = nh; Top = ny;
        e.Handled = true;
    }

    private void ResizeMouseUp(object sender, MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement fe)
        {
            fe.MouseMove -= ResizeMouseMove;
            fe.MouseLeftButtonUp -= ResizeMouseUp;
            fe.ReleaseMouseCapture();
        }
        _resizeDir = null;
        e.Handled = true;
    }

    private void OnDragOver(object sender, DragEventArgs e)
        => e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;

    private void OnDrop(object sender, DragEventArgs e)
    {
        if (e.Data.GetData(DataFormats.FileDrop) is string[] files && files.Length > 0)
            LoadFile(files[0]);
    }

    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        bool ctrl = (Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control;
        if (ctrl && e.Key == Key.O) { OnOpen(this, new RoutedEventArgs()); e.Handled = true; }
        else if (ctrl && e.Key == Key.S) { OnSave(this, new RoutedEventArgs()); e.Handled = true; }
        else if (ctrl && e.Key == Key.B) { OnBold(this, new RoutedEventArgs()); e.Handled = true; }
        else if (ctrl && e.Key == Key.Z) { if (!Editor.IsFocused) { OnUndo(this, new RoutedEventArgs()); e.Handled = true; } }
        else if (ctrl && e.Key == Key.Y) { OnRedo(this, new RoutedEventArgs()); e.Handled = true; }
    }
}