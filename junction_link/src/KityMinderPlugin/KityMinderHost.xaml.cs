using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace KityMinderPlugin;

/// <summary>
/// 可复用的 kityminder 思维导图宿主控件（自包含）：
///   - Web 资产内嵌于程序集，运行期自动释放到临时目录，经原生虚拟主机同源加载，调用方零文件；
///   - 自带编辑操作条（子节点/同级/删除/撤销/展开/收起/主题/布局）与快捷键提示；
///   - 对外暴露稳定桥接：就绪/内容变更事件 + ImportJson/ExportJson/ExecCommand/SetTheme/SetLayout。
/// 调用方仅需：引用本 dll，在 XAML 放 &lt;plugin:KityMinderHost/&gt;。
/// </summary>
public partial class KityMinderHost : UserControl
{
    private bool _webReady;
    private bool _navScheduled;
    private bool _mapped;
    private bool _ready;
    private bool _loading;
    private bool _diagnosed;
    private bool _usingExternal;
    private bool _everNavigated;
    private int _loadGen;
    private readonly DispatcherTimer _sizeTimer;

    /// <summary>
    /// 页面根目录（含 dist/index.html 的绝对路径，来自插件数据目录）。
    /// 由调用方在导航前设置；为 null 或目录不存在时回退到 dll 内嵌的自写页面。
    /// </summary>
    public string? SourcePath { get; set; }

    /// <summary>是否启用布局过渡动画（打开画布/展开收起分支时的 300ms 扩散动画）；默认 false=直接显示。
    /// 在每次导航（BeginLoad）前注入页面，运行中修改后下一次导航生效。</summary>
    public bool AnimateLayout { get; set; }

    private bool? _injectedAnimateLayout;

    public KityMinderHost()
    {
        InitializeComponent();
        _sizeTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(60) };
        _sizeTimer.Tick += OnSizeTick;
        Loaded += (_, _) => EnsureReady();
    }

    // ---------------- 公开事件 ----------------

    /// <summary>就绪状态变化（false→true 表示 kityminder 内核挂载完成、可编辑）。</summary>
    public event EventHandler<bool>? ReadyChanged;

    /// <summary>画布内容发生变更（kityminder 的 contentchange），可用于脏标记/自动保存。On UI 线程。</summary>
    public event EventHandler? ContentChanged;

    /// <summary>选中节点的节点级样式变化/切换（kityminder 的 selectionchange/noderender），携带该节点的样式字典。
    /// 用于 GUI 样式面板回显颜色与数值。已在 UI 线程派发。</summary>
    public event EventHandler<KityMinderNodeStyleArgs>? NodeStyleChanged;

    /// <summary>用户点击节点上的文件附件图标，请求打开该文件。参数为文件路径。已在 UI 线程派发。</summary>
    public event EventHandler<string>? OpenFileRequested;

    /// <summary>宿主诊断/状态消息（错误、就绪等），异常消息 warn=true。</summary>
    public event EventHandler<KityMinderStatusArgs>? StatusChanged;

    /// <summary>内核已就绪且可编辑。</summary>
    public bool IsReady => _ready;

    /// <summary>页面加载/初始化进行中（导航开始到就绪或失败）。调用方据此避免重复触发 Reload。</summary>
    public bool IsLoading => _loading;

    // ---------------- 生命周期 ----------------

    private void EnsureReady()
    {
        if (_webReady) return;
        _webReady = true;
        Web.CoreWebView2InitializationCompleted += (_, args) =>
        {
            if (!args.IsSuccess)
            {
                Report($"WebView2 初始化失败：{args.InitializationException?.Message}", true);
                return;
            }
            try { MapAssets(); } catch (Exception ex) { Report("资产释放/映射失败：" + ex.Message, true); return; }

            Web.CoreWebView2.ProcessFailed += (_, pf) =>
                Report($"WebView2 进程失败 kind={pf.ProcessFailedKind} exit={pf.ExitCode}", true);
            InstallDiagCapture();
            Web.CoreWebView2.WebMessageReceived += OnWebMessage;
            Web.NavigationCompleted += async (_, nav) =>
            {
                try
                {
                    Loading.Visibility = Visibility.Collapsed;
                    if (!nav.IsSuccess)
                    {
                        // 快速开关/重载会取消上一导航（OperationCanceled），由新导航接管，不视为错误
                        if (nav.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
                        _loading = false;
                        Report($"页面加载异常：{nav.WebErrorStatus}", true);
                        return;
                    }
                    await PollReadyAsync();
                }
                catch (Exception ex) { Report("导航处理异常：" + ex.Message, true); }
            };
            NavigateWhenSized();
        };
        _ = Web.EnsureCoreWebView2Async();
    }

    /// <summary>把页面目录（插件数据目录或内嵌资源释放目录）映射到虚拟主机（同源运行，避免 file:// 的 CORS 拦动态资源）。</summary>
    private void MapAssets()
    {
        if (_mapped || Web.CoreWebView2 is not { } cwv) return;
        string folder;
        if (!string.IsNullOrWhiteSpace(SourcePath) && Directory.Exists(SourcePath))
        {
            folder = SourcePath;
            _usingExternal = true;
        }
        else
        {
            folder = PluginAssets.EnsureExtractedFolder();
            _usingExternal = false;
        }
        cwv.SetVirtualHostNameToFolderMapping(
            PluginAssets.VirtualHost, folder, CoreWebView2HostResourceAccessKind.Allow);
        _mapped = true;
    }

    /// <summary>等待容器拿到真实尺寸后再导航：kityminder 初始容器高度为 0 启动会把相机中心算在顶部，内容被挤出可视区。</summary>
    private void NavigateWhenSized()
    {
        _navScheduled = true;
        _sizeTimer.Stop();
        _sizeTimer.Start();
    }

    /// <summary>标记一次新加载开始：使旧轮询失效、置加载态、显示遮罩。每次导航/重载调用一次。</summary>
    private void BeginLoad()
    {
        _loadGen++;
        _loading = true;
        Loading.Visibility = Visibility.Visible;
        InjectAnimateLayout();
    }

    /// <summary>导航前把当前动画开关写入 window.__kmAnimateLayout（文档创建脚本，对后续每次导航生效）。值未变则跳过。</summary>
    private void InjectAnimateLayout()
    {
        if (Web.CoreWebView2 is not { } cwv || _injectedAnimateLayout == AnimateLayout) return;
        _injectedAnimateLayout = AnimateLayout;
        try
        {
            cwv.AddScriptToExecuteOnDocumentCreatedAsync("window.__kmAnimateLayout=" + (AnimateLayout ? "true" : "false") + ";");
        }
        catch { /* 忽略注入失败，页面按默认无动画运行 */ }
    }

    private void OnSizeTick(object? sender, EventArgs e)
    {
        if (!_navScheduled) { _sizeTimer.Stop(); return; }
        if (Web.ActualWidth > 2 && Web.ActualHeight > 2)
        {
            _navScheduled = false;
            _sizeTimer.Stop();
            BeginLoad();
            _everNavigated = true;
            // 插件整包以 dist/index.html 为入口；内嵌回退页面以 index.html 为入口
            var page = _usingExternal ? "/dist/index.html" : "/index.html";
            Web.Source = new Uri("https://" + PluginAssets.VirtualHost + page);
        }
    }

    // ---------------- 诊断捕获 + 就绪探针 ----------------

    private void InstallDiagCapture()
    {
        // 拦截 window.onerror / 未处理 promise / console.error·warn，写入 window.__diag.err 供探针读取
        try
        {
            _ = Web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.__diag={err:''};(function(){" +
                "var cap=function(t){return function(){try{window.__diag.err+=t+Array.prototype.slice.call(arguments).map(" +
                "function(a){return a&&a.message?a.message:String(a)}).join(' ')+' | ';}catch(e){}}};" +
                "console.error=cap('E:');console.warn=cap('W:');" +
                "window.addEventListener('error',function(e){if(e&&e.message)window.__diag.err+=String(e.message)+' | ';});" +
                "window.addEventListener('unhandledrejection',function(e){if(e&&e.reason)window.__diag.err+='unhandled:'+String(e.reason&&e.reason.message||e.reason)+' | ';});" +
                "})();");
        }
        catch { /* 忽略注入失败 */ }
    }

    private async Task PollReadyAsync()
    {
        if (_diagnosed) return;
        _diagnosed = true;
        int gen = _loadGen;
        const string prober =
            "(function(){" +
            "var e=window.__diag?window.__diag.err:'';" +
            "return 'ok='+(!!window.__minder)+'|km='+(!!window.__km)+'|err='+e;" +
            "})()";
        string lastErr = "";
        // 完整编辑器启动较重（加载 Angular 全栈依赖），放宽轮询窗口
        for (int i = 0; i < 40; i++)
        {
            await Task.Delay(300);
            if (gen != _loadGen) return;   // 已被新的重载/导航取代，放弃旧轮询
            if (Web.CoreWebView2 is not { } cwv) return;
            string raw;
            try { raw = await cwv.ExecuteScriptAsync(prober); }
            catch (Exception ex) { _loading = false; Report($"内核探针异常 {ex.GetType().Name}: {ex.Message}", true); return; }

            // ExecuteScriptAsync 返回 JSON 编码字符串（带包裹引号），先反序列化还原，否则结尾编码引号会被误当错误内容
            string value = raw;
            try { value = JsonSerializer.Deserialize<string>(raw) ?? ""; } catch { /* 否则原样 */ }

            string err = value.Contains("|err=") ? value[(value.IndexOf("|err=") + 5)..].Trim() : "";
            // 错误只记录不中断：完整编辑器启动期常有良性警告（未绑定 handler 等），等 km 挂载成功才算就绪
            if (!string.IsNullOrEmpty(err)) lastErr = err;
            if (value.Contains("|km=true"))
            {
                _ready = true;
                _loading = false;
                Loading.Visibility = Visibility.Collapsed;
                Status.Visibility = Visibility.Collapsed;
                _ = DumpBridgeDiagnosticsAsync();
                OnReadyChanged();
                Report("已就绪，可编辑");
                return;
            }
            if (i == 39)
            {
                _loading = false;
                var detail = string.IsNullOrEmpty(lastErr) ? "（进程无报错）" : Truncate(lastErr, 300);
                Report("编辑器未就绪，页面报错：" + detail, true);
            }
        }
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            if (!doc.RootElement.TryGetProperty("type", out var t)) return;
            var type = t.GetString();
            if (type == "contentchange")
            {
                Diag("OnWebMessage: contentchange");
                ContentChanged?.Invoke(this, EventArgs.Empty);
            }
            else if (type == "nodestyle" &&
                     doc.RootElement.TryGetProperty("style", out var style) &&
                     style.ValueKind == JsonValueKind.Object)
            {
                Diag("OnWebMessage: nodestyle");
                var map = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var p in style.EnumerateObject())
                {
                    map[p.Name] = p.Value.ValueKind switch
                    {
                        JsonValueKind.String => p.Value.GetString(),
                        JsonValueKind.True => true,
                        JsonValueKind.False => false,
                        JsonValueKind.Number => p.Value.GetDouble(),
                        _ => null
                    };
                }
                OnNodeStyle(map);
            }
            else if (type == "openfile" &&
                     doc.RootElement.TryGetProperty("path", out var fp) &&
                     fp.ValueKind == JsonValueKind.String)
            {
                Diag("OnWebMessage: openfile");
                var path = fp.GetString();
                if (!string.IsNullOrEmpty(path))
                {
                    if (Dispatcher.CheckAccess())
                        OpenFileRequested?.Invoke(this, path);
                    else
                        Dispatcher.BeginInvoke(() => OpenFileRequested?.Invoke(this, path));
                }
            }
        }
        catch { /* 忽略非法消息 */ }
    }

    /// <summary>OnWebMessage 在 WebView2 线程触发；封送到 UI 线程再派发 NodeStyleChanged（接收方要刷新界面控件）。</summary>
    private void OnNodeStyle(IReadOnlyDictionary<string, object?> style)
    {
        var parts = new List<string>();
        foreach (var kv in style) parts.Add(kv.Key + "=" + (kv.Value is null ? "null" : kv.Value));
        Diag("OnNodeStyle: [" + string.Join(",", parts) + "]");
        if (Dispatcher.CheckAccess())
            NodeStyleChanged?.Invoke(this, new KityMinderNodeStyleArgs(style));
        else
            Dispatcher.BeginInvoke(() => OnNodeStyle(style));
    }

    /// <summary>就绪后诊断桥接实例指向：记录 window.__minder/.__km/.minder 的类型、根节点文本、导出是否含 root。</summary>
    private async Task DumpBridgeDiagnosticsAsync()
    {
        try
        {
            if (Web.CoreWebView2 is not { } cwv) return;
            const string probe =
                "(()=>{function info(m){if(!m)return 'undefined';var c=(m.constructor&&m.constructor.name)||'?';" +
                "var root=null;try{root=(m.getRoot&&m.getRoot())?m.getRoot().getText():'<noRoot>';}catch(e){root='<err>';}" +
                "return c+'|root='+root;}var s=null;try{s=window.__minder?window.__minder.exportJson():null;}catch(e){s='ERR:'+e;}" +
                "return JSON.stringify({bridge:info(window.__minder),km:info(window.__km),wb_minder:info(window.minder),exportLen:(s==null?-1:(s+'|').length>0?String(s).substring(0,80):'null')});})()";
            var raw = await cwv.ExecuteScriptAsync(probe);
            string val = raw;
            try { val = JsonSerializer.Deserialize<string>(raw) ?? raw; } catch { }
            Diag("BridgeDiagnostics: " + Truncate(val, 500));
        }
        catch (Exception ex) { Diag("BridgeDiagnostics exception: " + ex.Message); }
    }

    // ---------------- 桥接 API ----------------

    /// <summary>导入脑图 JSON。返回是否成功。</summary>
    public async Task<bool> ImportJsonAsync(string json)
    {
        Diag($"ImportJsonAsync enter _ready={_ready} json={Truncate(json, 200)}");
        if (!_ready) return false;
        try
        {
            using var _ = JsonDocument.Parse(json); // 先校验可解析，避免坏文本注入
            // 注意：用同步 IIFE，不要 async IIFE——WebView2 ExecuteScriptAsync 对 async 函数返回值序列化有坑（返回 {}）
            // 传参方式：把 json 再序列化成一个 JS 字符串字面量，页面侧 JSON.parse 还原。
            // 直接把 json 原文拼进表达式的话，遇到 U+2028/2029、超长文本或边界字符会破坏 JS 语法，
            // 表现为 ExecuteScriptAsync 返回 {} → 这里误判成导入失败（自动保存内容恢复不出来）。
            var literal = JsonSerializer.Serialize(json);
            var raw = await Web.CoreWebView2.ExecuteScriptAsync(
                "(function(){try{window.__minder.importJson(JSON.parse(" + literal + "));return true;}" +
                "catch(e){return 'ERR:'+String(e);}})()");
            Diag($"ImportJsonAsync result={raw}");
            return raw == "true";
        }
        catch (Exception ex) { Diag($"ImportJsonAsync exception: {ex.Message}"); return false; }
    }

    /// <summary>导出当前脑图为 JSON 文本；失败或未就绪返回 null。</summary>
    public async Task<string?> ExportJsonAsync()
    {
        Diag($"ExportJsonAsync enter _ready={_ready}");
        if (!_ready) return null;
        try
        {
            // 桥接 window.__minder.exportJson() 必须保持同步：WebView2 的 ExecuteScriptAsync 不会等待
            // Promise（实测返回 {}，解析后为 null，自动保存会存空内容）。它返回 JSON 文本字符串，
            // raw 是 JSON 编码后的字符串（含一层引号转义），Deserialize 一层即得正文。
            var raw = await Web.CoreWebView2.ExecuteScriptAsync(
                "(function(){try{return window.__minder.exportJson();}catch(e){return 'ERR:'+String(e);}})()");
            Diag($"ExportJsonAsync raw={Truncate(raw ?? "<null>", 400)}");
            if (raw is null || raw == "null") return null;
            string? text = null;
            try { text = JsonSerializer.Deserialize<string>(raw); } catch { }
            if (text is null) return null;
            if (text.StartsWith("ERR:", StringComparison.Ordinal)) { Diag("ExportJsonAsync JS error: " + text); return null; }
            return text;
        }
        catch (Exception ex) { Diag($"ExportJsonAsync exception: {ex.Message}"); return null; }
    }

    /// <summary>
    /// 把当前画布导出为整幅完整 PNG（含滚动区域外）。调用 Web 端 km.exportData('png') ——
    /// 它创建 canvas 绘制全部节点后输出 base64 dataUrl；因 ExecuteScriptAsync 不等 Promise，
    /// 触发后循环轮询 pollExportPng() 取回。未就绪或失败返回 false。
    /// </summary>
    public async Task<bool> CapturePngAsync(string path)
    {
        Diag($"CapturePngAsync enter _ready={_ready}");
        if (!_ready || Web.CoreWebView2 is not { } cwv) return false;
        try
        {
            await cwv.ExecuteScriptAsync(
                "(function(){try{window.__mindmapPng=null;window.__minder.exportPng();return true;}catch(e){window.__mindmapPng={state:'done',data:'',err:String(e)};return false;}})()");

            string? dataUrl = null;
            for (int i = 0; i < 60; i++)
            {
                await Task.Delay(300);
                if (Web.CoreWebView2 is not { } alive) return false;
                string raw;
                try { raw = await alive.ExecuteScriptAsync("window.__minder.pollExportPng()"); }
                catch { continue; }
                string val = raw;
                try { val = JsonSerializer.Deserialize<string>(raw) ?? ""; } catch { /* 原样 */ }
                if (val == "PENDING") continue;
                if (val.StartsWith("ERR:", StringComparison.Ordinal))
                {
                    Diag("CapturePngAsync JS error: " + val[4..]);
                    return false;
                }
                if (val.StartsWith("OK:", StringComparison.Ordinal))
                {
                    dataUrl = val[3..];
                    break;
                }
            }
            if (string.IsNullOrWhiteSpace(dataUrl)) { Diag("CapturePngAsync timeout"); return false; }

            // dataUrl 形如 data:image/png;base64,\<...\>，剥掉逗号前缀取 base64
            var comma = dataUrl.IndexOf(',');
            var b64 = comma >= 0 ? dataUrl[(comma + 1)..] : dataUrl;
            var bytes = Convert.FromBase64String(b64);

            var full = Path.GetFullPath(path);
            var dir = Path.GetDirectoryName(full);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            using var fs = new FileStream(full, FileMode.Create, FileAccess.Write, FileShare.None);
            await fs.WriteAsync(bytes, 0, bytes.Length);
            Diag($"CapturePngAsync ok {bytes.Length}B");
            return true;
        }
        catch (Exception ex) { Diag($"CapturePngAsync exception: {ex.Message}"); return false; }
    }

    /// <summary>执行 kityminder 内核命令（如 appendchildnode / removenode / expand…）。undo/redo 不在内核命令表，走编辑器历史栈。</summary>
    public Task ExecCommandAsync(string name)
    {
        if (name is "undo" or "redo")
            return RunJs($"(function(){{try{{if(window.editor&&window.editor.history)window.editor.history.{name}();}}catch(e){{}}}})()");
        return RunJs($"(function(){{try{{window.__minder.execCommand('{name}');}}catch(e){{}}}})()");
    }

    /// <summary>执行带参命令（如 fontfamily / fontsize / forecolor）。value 可为字符串（字体名/颜色）或数值（字号），经 JSON 序列化为合法 JS 字面量。</summary>
    public Task ExecCommandWithValueAsync(string name, object? value)
    {
        var vj = value is null ? "null" : JsonSerializer.Serialize(value);
        return RunJs($"(function(){{try{{window.__minder.execCommand('{name}', {vj});}}catch(e){{}}}})()");
    }

    /// <summary>进入选中节点的文字编辑状态。</summary>
    public Task EditSelectedAsync()
        => RunJs("(function(){try{if(window.__minder&&window.__minder.editSelected)window.__minder.editSelected();}catch(e){}})()");

    /// <summary>为选中节点设置/移除超链接。url 为 null 时移除已有链接。</summary>
    public Task SetHyperlinkAsync(string? url)
        => RunJs($"(function(){{try{{window.__minder.execCommand('hyperlink', {(url is null ? "null" : JsonSerializer.Serialize(url))});}}catch(e){{}}}})()");

    /// <summary>为选中节点设置/移除图片。url 为 null 或空串时移除已有图片。</summary>
    public Task SetImageAsync(string? url)
        => RunJs($"(function(){{try{{window.__minder.execCommand('image', {(url is null ? "null" : JsonSerializer.Serialize(url))});}}catch(e){{}}}})()");

    /// <summary>为选中节点设置/移除备注。text 为 null 时移除已有备注。</summary>
    public Task SetNoteAsync(string? text)
        => RunJs($"(function(){{try{{window.__minder.execCommand('note', {(text is null ? "null" : JsonSerializer.Serialize(text))});}}catch(e){{}}}})()");

    /// <summary>为选中节点设置/移除文件附件。path 为 null 时移除已有附件。</summary>
    public Task SetFileAsync(string? path)
        => RunJs($"(function(){{try{{window.__minder.execCommand('file', {(path is null ? "null" : JsonSerializer.Serialize(path))});}}catch(e){{}}}})()");

    /// <summary>为选中节点设置/移除视频附件（独立 data.video 字段，与文件可并存）。path 为 null 时移除已有视频。</summary>
    public Task SetVideoAsync(string? path)
        => RunJs($"(function(){{try{{window.__minder.execCommand('video', {(path is null ? "null" : JsonSerializer.Serialize(path))});}}catch(e){{}}}})()");

    /// <summary>查询选中节点（首个）的文件附件路径；无附件或未就绪返回 null。</summary>
    public async Task<string?> GetSelectedFileAsync()
    {
        if (!_ready) return null;
        try
        {
            var raw = await Web.CoreWebView2.ExecuteScriptAsync(
                "(function(){try{var n=window.__km&&window.__km.getSelectedNode&&window.__km.getSelectedNode();" +
                "return n&&n.getData&&n.getData('file')?JSON.stringify(n.getData('file')):'null';}catch(e){return 'null';}})()");
            if (raw is null || raw == "null") return null;
            try { return JsonSerializer.Deserialize<string>(raw); } catch { return null; }
        }
        catch (Exception ex) { Diag($"GetSelectedFileAsync exception: {ex.Message}"); return null; }
    }

    /// <summary>查询选中节点（首个）的视频附件路径；无视频或未就绪返回 null。</summary>
    public async Task<string?> GetSelectedVideoAsync()
    {
        if (!_ready) return null;
        try
        {
            var raw = await Web.CoreWebView2.ExecuteScriptAsync(
                "(function(){try{var n=window.__km&&window.__km.getSelectedNode&&window.__km.getSelectedNode();" +
                "return n&&n.getData&&n.getData('video')?JSON.stringify(n.getData('video')):'null';}catch(e){return 'null';}})()");
            if (raw is null || raw == "null") return null;
            try { return JsonSerializer.Deserialize<string>(raw); } catch { return null; }
        }
        catch (Exception ex) { Diag($"GetSelectedVideoAsync exception: {ex.Message}"); return null; }
    }

    /// <summary>为选中节点设置节点级样式（填充/边框/圆角/连线，不改变主题其他节点）。
    /// 字典键：fill/stroke/strokeWidth/radius/lineColor/lineWidth；值为 null 表示清除对应项，缺省键不动。</summary>
    public Task SetNodeStyleAsync(Dictionary<string, object?> style)
        => ExecCommandWithValueAsync("setnodestyle", style);

    /// <summary>按主题清除选中节点的样式。scope：text=文字样式 / node=填充+圆角 / border=边框 / line=连线。</summary>
    public Task ClearNodeStyleScopeAsync(string scope)
        => ExecCommandWithValueAsync("clearnodestyle", scope);

    /// <summary>复制选中节点（首个）的全部节点级样式到内存剪贴板（仅本次会话有效）。</summary>
    public Task CopyNodeStyleAsync()
        => ExecCommandAsync("copynodestyle");

    /// <summary>把内存剪贴板中的节点样式粘贴到当前选中节点。</summary>
    public Task PasteNodeStyleAsync()
        => ExecCommandAsync("pastenodestyle");

    /// <summary>视图-选择：按模式选中节点（all/revert/siblings/level/path/tree，对齐编辑器 selectAll 指令）。</summary>
    public Task SelectNodesAsync(string mode)
        => RunJs($"(function(){{try{{window.__minder.select('{mode}');}}catch(e){{}}}})()");

    /// <summary>按选中节点展开其子树到指定层数（供侧边栏「展开一级/二级/全部」按钮调用）。
    /// levels=1 展开选中节点本身（显示子节点）；2=再展开子节点（显示孙节点）；0 或负数=全部展开；更深层收起。
    /// 返回是否成功（未就绪或无选中节点返回 false）。</summary>
    public async Task<bool> ExpandSelectedToLevelAsync(int levels)
    {
        if (!_ready) return false;
        try
        {
            var raw = await Web.CoreWebView2.ExecuteScriptAsync(
                $"(function(){{try{{return !!window.__minder.expandSelectedToLevel({levels});}}catch(e){{return false}}}})()");
            return raw == "true";
        }
        catch (Exception ex) { Report("展开失败：" + ex.Message, true); return false; }
    }

    /// <summary>视图-搜索：按关键字匹配节点并逐个循环定位（经前端 __minder.search 高亮+居中）。
    /// 返回 "总x当前y"（如 "3/2"），无匹配返回 "0/0"。</summary>
    public async Task<string?> SearchAsync(string keyword)
    {
        if (!_ready) return null;
        var k = JsonSerializer.Serialize(keyword ?? "");
        try
        {
            var raw = await Web.CoreWebView2.ExecuteScriptAsync(
                "(function(){try{var r=window.__minder.search(" + k + ");return JSON.stringify({total:r.total,index:r.index});}catch(e){return '';}})()");
            Diag($"SearchAsync({keyword}) raw={raw}");
            if (string.IsNullOrEmpty(raw) || raw == "null") return null;
            using var doc = JsonDocument.Parse(raw);
            var total = doc.RootElement.GetProperty("total").GetInt32();
            var index = doc.RootElement.GetProperty("index").GetInt32();
            return $"{index}/{total}";
        }
        catch (Exception ex) { Diag($"SearchAsync exception: {ex.Message}"); return null; }
    }

    /// <summary>切换配色主题。theme 取 core 支持的名称（见 <see cref="KityMinderContract.Themes"/>）。</summary>
    public Task SetThemeAsync(string theme)
        => RunJs($"(function(){{try{{window.__minder.setTheme('{theme}');}}catch(e){{}}}})()");

    /// <summary>把自定义主题注册进内核主题表（后续 <see cref="SetThemeAsync"/> 可切换）。themeJson 为 <c>MindMapTheme</c> 的 camelCase 序列化。</summary>
    public Task<bool> RegisterCustomThemeAsync(string themeJson)
    {
        if (!_ready) return Task.FromResult(false);
        var js = "(function(){try{return !!window.__minder.registerCustomTheme(" + themeJson + ");}catch(e){return false}})()";
        return RunJsBoolAsync(js);
    }

    private async Task<bool> RunJsBoolAsync(string js)
    {
        if (!_ready) return false;
        try { return (await Web.CoreWebView2.ExecuteScriptAsync(js)) == "true"; }
        catch (Exception ex) { Report("注册主题失败：" + ex.Message, true); return false; }
    }

    /// <summary>切换布局结构。layout 取 core 支持模板（default / right / structure / fish-bone / tianpan）。</summary>
    public Task SetLayoutAsync(string layout)
        => RunJs($"(function(){{try{{window.__minder.setLayout('{layout}');}}catch(e){{}}}})()");

    /// <summary>切换布局模板（与编辑器【外观】页签模板下拉一致：default / right / filetree / structure / fish-bone / tianpan）。</summary>
    public Task SetTemplateAsync(string template)
        => RunJs($"(function(){{try{{window.__minder.setTemplate('{template}');}}catch(e){{}}}})()");

    /// <summary>执行任意 JS 片段（不返回值）。供临时调试场景使用，如清除 localStorage 并重载偏移值。</summary>
    public async Task EvalAsync(string js)
    {
        if (!_ready) return;
        try { await Web.CoreWebView2.ExecuteScriptAsync(js); }
        catch (Exception ex) { Report("执行失败：" + ex.Message, true); }
    }

    /// <summary>重载当前页面。重置就绪/诊断标记，使重载完成后再次触发 <see cref="ReadyChanged"/>（供调用方恢复上次状态）。
    /// 页面尚未首次导航（about:blank）时仅重置标记，真实导航由 OnSizeTick 触发，避免空重载占用就绪轮询。</summary>
    public void Reload()
    {
        _ready = false;
        _diagnosed = false;
        if (Web.CoreWebView2 is { } cwv && _everNavigated)
        {
            BeginLoad();
            try { cwv.Reload(); }
            catch (Exception ex) { _loading = false; Report("重载失败：" + ex.Message, true); }
        }
    }

    /// <summary>打开 WebView2 开发者控制台（排查 JS 错误）。</summary>
    public void OpenDevTools() => Web.CoreWebView2?.OpenDevToolsWindow();

    private async Task RunJs(string js)
    {
        if (!_ready) return;
        try { await Web.CoreWebView2.ExecuteScriptAsync(js); }
        catch (Exception ex) { Report("操作失败：" + ex.Message, true); }
    }

    // ---------------- 工具方法 ----------------

    private void OnReadyChanged()
    {
        Diag("OnReadyChanged: ready=true");
        ReadyChanged?.Invoke(this, true);
    }

    private void Report(string text, bool warn = false)
    {
        // UI 线程封送；事件接收者据此刷新状态栏/日志
        if (Dispatcher.CheckAccess())
        {
            Status.Text = warn ? "⚠ " + text : text;
            Status.Visibility = Visibility.Visible;
            StatusChanged?.Invoke(this, new KityMinderStatusArgs(text, warn));
        }
        else Dispatcher.Invoke(() => Report(text, warn));
    }

    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n] + "…";

    /// <summary>诊断日志（临时排查用，写入 %TEMP%\fpx_mindmap_diag.log）。</summary>
    public static void Diag(string msg)
    {
        try
        {
            lock (_diagLock)
                File.AppendAllText(DiagFile, $"[{DateTime.Now:HH:mm:ss.fff}] {msg}\r\n");
        }
        catch { }
    }

    private static readonly object _diagLock = new();
    private static string DiagFile => Path.Combine(Path.GetTempPath(), "fpx_mindmap_diag.log");
}

/// <summary>宿主状态通知参数。</summary>
public sealed class KityMinderStatusArgs : EventArgs
{
    public KityMinderStatusArgs(string message, bool warn)
    {
        Message = message;
        Warn = warn;
    }

    public string Message { get; }
    public bool Warn { get; }
}

/// <summary>选中节点样式参数：样式字典（键见 MindMapPanel 应用逻辑），UI 线程派发。</summary>
public sealed class KityMinderNodeStyleArgs : EventArgs
{
    public KityMinderNodeStyleArgs(IReadOnlyDictionary<string, object?> style) => Style = style;

    public IReadOnlyDictionary<string, object?> Style { get; }
}