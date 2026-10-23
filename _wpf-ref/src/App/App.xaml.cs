using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using FenPeiXiangMuZu.Services;
using FenPeiXiangMuZu.ViewModels;

namespace FenPeiXiangMuZu;

public partial class App : Application
{
    private static Mutex? _singleInstanceMutex;
    private static EventWaitHandle? _activateEvent;
    // UI 异常熔断计数：连续超过上限后放行崩溃，避免坏循环反复弹窗/持续写坏数据
    private int _uiFaultCount;

    /// <summary>已解析的数据根目录（含 分配项目组-config.json 的目录）。供新增数据文件统一复用同一探测结果，禁止各自拼路径。</summary>
    public static string DataDir { get; private set; } = "";

    /// <summary>全局未捕获异常兜底：任何异常只弹窗提示，进程不静默消失。</summary>
    protected override void OnStartup(StartupEventArgs e)
    {
        // ToolTip 全局即时弹出（0s）：重写默认元数据对全应用生效。
        // 注意不能设在隐式 Style TargetType="ToolTip" 上——ToolTipService 读的是宿主控件的附加属性值。
        System.Windows.Controls.ToolTipService.InitialShowDelayProperty.OverrideMetadata(
            typeof(FrameworkElement), new FrameworkPropertyMetadata(0));
        // 切换（鼠标在相邻带提示控件间移动）也即时切换：不设这行则用 WPF 默认 100ms。
        System.Windows.Controls.ToolTipService.BetweenShowDelayProperty.OverrideMetadata(
            typeof(FrameworkElement), new FrameworkPropertyMetadata(0));
        System.Windows.Controls.ToolTipService.ShowDurationProperty.OverrideMetadata(
            typeof(FrameworkElement), new FrameworkPropertyMetadata(5000));

        DispatcherUnhandledException += (s, args) =>
        {
            try { System.IO.File.AppendAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fpx_unhandled.txt"), "[UI]" + DateTime.Now.ToString("HH:mm:ss.fff") + "\n" + args.Exception + "\n--------------------------------\n"); } catch { }
            if (++_uiFaultCount > 5)
            {
                // 连续异常超限：不再吞（放行崩溃）。坏状态下无限 Handled 会让数据被反复写坏。
                return;
            }
            MessageBox.Show("发生未处理异常" + (_uiFaultCount > 1 ? $"（第 {_uiFaultCount} 次）" : "") + "：\n" + args.Exception.ToString(),
                "分配项目组", MessageBoxButton.OK, MessageBoxImage.Warning);
            args.Handled = true;
        };
        // 后台线程致命异常：只记日志（进程即将终止，弹窗常来不及显示）
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            try { System.IO.File.AppendAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fpx_unhandled.txt"), "[FATAL terminating=" + e.IsTerminating + "]" + DateTime.Now.ToString("HH:mm:ss.fff") + "\n" + e.ExceptionObject + "\n--------------------------------\n"); } catch { }
        };
        // 未观察的任务异常：记日志并标记已观察，防止延迟崩溃；便于排查后台 Task 故障
        System.Threading.Tasks.TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            try { System.IO.File.AppendAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fpx_unhandled.txt"), "[TASK]" + DateTime.Now.ToString("HH:mm:ss.fff") + "\n" + e.Exception + "\n--------------------------------\n"); } catch { }
            e.SetObserved();
        };

        // 数据层/UI 数据流自检入口（控制台化）：--roundtrip <config> <record> <outDir>
        var a = e.Args;
        if (a.Length >= 4 && a[0] == "--roundtrip")
        {
            var pass = false;
            var msg = "";
            try
            {
                pass = DataSelfCheck.Run(a[1], a[2], a[3]);
            }
            catch (Exception ex)
            {
                msg = "\n[EXCEPTION] " + ex;
            }
            var resultFile = Path.Combine(a[3], "_data-selfcheck-result.txt");
            if (!string.IsNullOrEmpty(msg) && File.Exists(resultFile))
                File.AppendAllText(resultFile, msg);
            Environment.Exit(pass ? 0 : 1);
            return;
        }

        // ---- 常规启动：装配 services → 构造 VM → 主窗口 ----
        var (cfgPath, recPath) = ResolveDataPaths();
        DataDir = Path.GetDirectoryName(cfgPath) ?? AppContext.BaseDirectory;

        // MCP server 模式：<exe> --mcp，不开界面，仅服务 stdin/stdout（供 AI 客户端调用工具）。
        if (a.Length > 0 && a[0] == "--mcp")
        {
            // stdio 有效性预检：MCP 协议要求 stdin/stdout 均为重定向管道。
            // 从资源管理器/终端直接双击带参启动时 stdin 是键盘缓冲，ReadLine 会永久挂起，明确报错退出。
            if (!Console.IsInputRedirected || !Console.IsOutputRedirected)
            {
                try { Console.Error.WriteLine("--mcp 模式必须由 MCP 客户端启动（stdin/stdout 需为重定向管道）。"); }
                catch { }
                Environment.Exit(2);
                return;
            }
            // MCP 协议固定 UTF-8。绕过 Console.In（其编码在 GBK 系统不可靠），
            // 直接以显式 UTF-8 流读写原始句柄，保证中文 prompt/路径无误。
            var stdin = new System.IO.StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false));
            var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true };
            var server = new Services.McpServer(cfgPath, recPath);
            // 退出信号监听：GUI 勾选「退出时关闭 MCP」后，GUI 退出时 Set 此事件，本进程随之优雅退出
            using (var closeEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Services.McpServer.CloseEventName))
            {
                var closeTask = Task.Run(() =>
                {
                    try { closeEvent.WaitOne(); } catch { return; }
                    Environment.Exit(0);
                });
                server.RunAsync(stdin, stdout).GetAwaiter().GetResult();
            }
            Environment.Exit(0);
            return;
        }

        // 项目批量搬迁到页签层级：<exe> --migrate-hierarchy [configPath] [recordPath]
        // 无 UI 无单实例限制：把项目区全部收藏搬到「新建项目父目录\所属页签名\名称」（工具自身/exe 目录排除）。
        if (a.Length > 0 && a[0] == "--migrate-hierarchy")
        {
            var (mCfgPath, mRecPath) = a.Length >= 3 ? (a[1], a[2]) : ResolveDataPaths();
            var mCfgSvc = new ConfigService(mCfgPath);
            var mCfg = mCfgSvc.LoadConfig();
            var mBaseRoot = mCfg.LastLib is not null && Directory.Exists(mCfg.LastLib)
                ? mCfg.LastLib : AppContext.BaseDirectory;
            var mRecSvc = new LinkRecordService(mBaseRoot, mRecPath);
            // 工具自身 = 数据目录的上级（项目根：源码/数据/junction 所在），与 exe 目录一起排除
            var mSelfRoot = Path.GetDirectoryName(Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(mCfgPath)));
            var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true };
            try
            {
                var r = Services.HierarchyMigrator.MigrateProjects(mCfg, mCfgSvc, mRecSvc, new[] { mSelfRoot!, AppContext.BaseDirectory });
                stdout.WriteLine($"迁移完成：成功 {r.Moved} 项，跳过 {r.Skipped} 项，失败 {r.Failed} 项。");
                foreach (var it in r.Items)
                    stdout.WriteLine(string.IsNullOrEmpty(it.Note)
                        ? $"  ✓ {it.Src} → {it.Dst}"
                        : $"  - {it.Note}: {it.Src}" + (string.IsNullOrEmpty(it.Dst) ? "" : $" → {it.Dst}"));
                Environment.Exit(r.Failed == 0 ? 0 : 1);
            }
            catch (Exception ex)
            {
                try { stdout.WriteLine("迁移中止：" + ex.Message); } catch { }
                Environment.Exit(2);
            }
            return;
        }

        // 项目组批量搬迁到页签层级：<exe> --migrate-groups-hierarchy [configPath] [recordPath]
        // 无 UI 无单实例限制：把项目组区全部收藏搬到「新建项目组父目录\所属页签名\名称」层级结构
        // （对称于项目区 --migrate-hierarchy；项目组搬走后 junction 不跟随，MigrateGroups 会逐个重建）。
        if (a.Length > 0 && a[0] == "--migrate-groups-hierarchy")
        {
            var (gCfgPath, gRecPath) = a.Length >= 3 ? (a[1], a[2]) : ResolveDataPaths();
            var gCfgSvc = new ConfigService(gCfgPath);
            var gCfg = gCfgSvc.LoadConfig();
            var gBaseRoot = gCfg.LastLib is not null && Directory.Exists(gCfg.LastLib)
                ? gCfg.LastLib : AppContext.BaseDirectory;
            var gRecSvc = new LinkRecordService(gBaseRoot, gRecPath);
            var gSelfRoot = Path.GetDirectoryName(Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(gCfgPath)));
            var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true };
            try
            {
                // 工具自身根目录与 exe 目录保持排除；DIY工具创建 已纳入全量迁移（不再单独排除）
                var excludes = new List<string> { gSelfRoot!, AppContext.BaseDirectory };
                var r = Services.HierarchyMigrator.MigrateGroups(gCfg, gCfgSvc, gRecSvc, excludes);
                stdout.WriteLine($"迁移完成：成功 {r.Moved} 项，跳过 {r.Skipped} 项，失败 {r.Failed} 项。");
                foreach (var it in r.Items)
                    stdout.WriteLine(string.IsNullOrEmpty(it.Note)
                        ? $"  ✓ {it.Src} → {it.Dst}"
                        : $"  - {it.Note}: {it.Src}" + (string.IsNullOrEmpty(it.Dst) ? "" : $" → {it.Dst}"));
                Environment.Exit(r.Failed == 0 ? 0 : 1);
            }
            catch (Exception ex)
            {
                try { stdout.WriteLine("迁移中止：" + ex.Message); } catch { }
                Environment.Exit(2);
            }
            return;
        }

        // exe 文件图标后台应用：<exe> --appicon-apply <目标exe> <ico> <发起进程PID>
        // 由主程序把自身复制到临时目录后以本模式启动；等发起进程退出（目标 exe 解锁）→ 改写图标 → 刷缓存 → 重启主程序。
        // 无 UI 无单实例限制（必须在单实例保护之前）。
        if (a.Length >= 4 && a[0] == "--appicon-apply")
        {
            int.TryParse(a[3], out var waitPid);
            var rc = Services.AppIconService.ApplyExeIconAwait(a[1], a[2], waitPid);
            Environment.Exit(rc);
            return;
        }

        // 布局超框审计（调试开关）：<exe> --layout-check
        // 打开「新建主题」弹窗，遍历视觉树检查有无元素右缘超出窗口 / 左缘越界 / 文本被列宽截断。
        // 报告写入 %TEMP%\fpx_layout_check.txt，退出码 0=无超框，1=有。不受单实例限制。
        if (a.Length > 0 && a[0] == "--layout-check")
        {
            Environment.Exit(RunLayoutCheck());
            return;
        }

        // ---- 单实例保护：常规 GUI 启动，重复启动时激活已有窗口并退出 ----
        // 注意放在 --mcp / --roundtrip / --appicon-apply 之后：命令行工具模式不受单实例限制。
        _singleInstanceMutex = new Mutex(true, @"Local\FenPeiXiangMuZu_SingleInstance", out bool createdNew);
        _activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\FenPeiXiangMuZu_Activate", out bool eventCreatedNew);
        if (!createdNew)
        {
            ActivateExistingInstance();
            // 兜底唤醒：首实例 Hide 到托盘后 MainWindowHandle==0，上面按句柄激活会落空，
            // 命名事件通知首实例自行 RestoreFromTray。
            try { _activateEvent.Set(); } catch { }
            Environment.Exit(0);
            return;
        }
        // 首实例：后台线程监听二次启动信号 → 恢复主窗口（含托盘隐藏态）
        var activateEvent = _activateEvent;
        new Thread(() =>
        {
            while (activateEvent.WaitOne())
            {
                try { Dispatcher.Invoke(RestoreMainWindowFromTray); }
                catch { /* 窗口尚未创建/正在关闭：忽略，继续等下一次信号 */ }
            }
        }) { IsBackground = true }.Start();

        var cfgSvc = new ConfigService(cfgPath);
        var config = cfgSvc.LoadConfig();
        var baseRoot = config.LastLib is not null && Directory.Exists(config.LastLib)
            ? config.LastLib : AppContext.BaseDirectory;
        var recSvc = new LinkRecordService(baseRoot, recPath);
        // 预设图标库统一放「数据\preseticons」（cfgPath 父目录即数据目录，与页签数据同源）
        var dataDir = System.IO.Path.GetDirectoryName(System.IO.Path.TrimEndingDirectorySeparator(cfgPath))
            ?? AppContext.BaseDirectory;
        var vm = new MainViewModel(config, cfgSvc, recSvc, new IconService(), dataDir);
        vm.InitBrokerPanels();
        new MainWindow(vm).Show();
        // 配置损坏告警（A4）：窗口就绪后写入日志区，让用户知道配置曾损坏且已备份
        if (cfgSvc.LastLoadWarning is { } loadWarn) vm.Logs.Error(loadWarn);
        // MCP 自动注册（后台执行，不阻塞启动）：设置 FPX_ROOT 环境变量 + 动态维护 .mcp.json / TRAE 全局配置
        Task.Run(() =>
        {
            var summary = McpRegistrationService.RegisterAll(cfgPath);
            if (!string.IsNullOrEmpty(summary)) vm.Logs.Info("MCP 自动注册：" + summary);
        });

        base.OnStartup(e);
    }

    /// <summary>
    /// 布局超框审计：打开「新建主题」弹窗，遍历视觉树统计每个元素相对窗口的实际包围盒，
    /// 检查右缘是否超出窗口宽度、左缘是否越界、TextBlock 文本是否被固定列宽截断。
    /// 报告写到 %TEMP%\fpx_layout_check.txt 并回显控制台；返回 0=无违规，1=存在违规。
    /// 纯 code-behind 弹窗（含配色/边框/间距布局）的回归自检入口。
    /// </summary>
    private static int RunLayoutCheck()
    {
        var dlg = new FenPeiXiangMuZu.Views.NewMindMapThemeDialog(null);
        dlg.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        dlg.ShowInTaskbar = false;
        var viol = new System.Collections.Generic.List<string>();
        double maxRight = -1;
        dlg.ContentRendered += (_, _) =>
        {
            double winW = dlg.ActualWidth;
            double ppd = System.Windows.Media.VisualTreeHelper.GetDpi(dlg).PixelsPerDip;
            void Walk(System.Windows.Media.Visual v, string path)
            {
                if (v is System.Windows.FrameworkElement fe)
                {
                    try
                    {
                        var box = System.Windows.Media.VisualTreeHelper.GetContentBounds(v);
                        if (box.Width > 0 || box.Height > 0)
                        {
                            var t = fe.TransformToAncestor(dlg);
                            var tl = t.Transform(new System.Windows.Point(box.Left, box.Top));
                            var br = t.Transform(new System.Windows.Point(box.Right, box.Bottom));
                            double r = System.Math.Max(tl.X, br.X), l = System.Math.Min(tl.X, br.X);
                            if (r > maxRight) maxRight = r;
                            if (r > winW + 0.5) viol.Add($"[RIGHT+{(r - winW):F1}] {path}/{fe.GetType().Name} right={r:F1} winW={winW:F1}");
                            if (l < -0.5) viol.Add($"[LEFT-{-l:F1}] {path}/{fe.GetType().Name} left={l:F1}");
                        }
                        if (fe is System.Windows.Controls.TextBlock tb && !string.IsNullOrEmpty(tb.Text))
                        {
                            var ft = new System.Windows.Media.FormattedText(tb.Text, System.Globalization.CultureInfo.CurrentCulture,
                                System.Windows.FlowDirection.LeftToRight,
                                new System.Windows.Media.Typeface(tb.FontFamily, tb.FontStyle, tb.FontWeight, tb.FontStretch),
                                tb.FontSize, System.Windows.Media.Brushes.Black, ppd);
                            double tw = ft.WidthIncludingTrailingWhitespace;
                            if (tw > tb.ActualWidth + 0.5)
                                viol.Add($"[TEXT+{tw - tb.ActualWidth:F1}] \"{tb.Text}\" textW={tw:F1} > actualW={tb.ActualWidth:F1} [{path}]");
                        }
                    }
                    catch { }
                }
                for (int i = 0; i < System.Windows.Media.VisualTreeHelper.GetChildrenCount(v); i++)
                    if (System.Windows.Media.VisualTreeHelper.GetChild(v, i) is System.Windows.Media.Visual ch)
                        Walk(ch, path + "/" + v.GetType().Name);
            }
            Walk(dlg, "root");
            var lines = new System.Collections.Generic.List<string>
            {
                $"winW={winW:F1} maxRight={maxRight:F1} frameRight≈{winW - 12:F1} ppd={ppd:F2}",
                viol.Count == 0 ? "NO-VIOLATIONS: 无超框" : "VIOLATIONS:" + viol.Count,
            };
            lines.AddRange(viol);
            try { System.IO.File.WriteAllLines(ReportPath, lines, new System.Text.UTF8Encoding(false)); } catch { }
        };
        var done = new System.Threading.ManualResetEventSlim();
        dlg.Closed += (_, _) => done.Set();
        System.Windows.Threading.DispatcherTimer? timer = null;
        timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
        var t0 = DateTime.Now;
        timer.Tick += (_, _) => { if ((DateTime.Now - t0).TotalSeconds >= 3) { timer.Stop(); dlg.Close(); } };
        timer.Start();
        dlg.ShowDialog();
        done.Wait(8000);
        string summary = "";
        try { summary = string.Join("\n", System.IO.File.ReadAllLines(ReportPath)); } catch { }
        var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true };
        try
        {
            stdout.WriteLine("布局校验报告：");
            stdout.WriteLine(summary);
            stdout.WriteLine("退出码: " + (viol.Count == 0 ? 0 : 1));
        }
        catch { }
        return viol.Count == 0 ? 0 : 1;
    }

    private static string ReportPath => System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fpx_layout_check.txt");

    protected override void OnExit(ExitEventArgs e)
    {
        if (_singleInstanceMutex is { } m)
        {
            try { m.ReleaseMutex(); } catch { }
            m.Dispose();
        }
        base.OnExit(e);
    }

    /// <summary>把焦点切到已运行实例的主窗口（含最小化恢复）。</summary>
    private static void ActivateExistingInstance()
    {
        try
        {
            var current = Process.GetCurrentProcess();
            foreach (var p in Process.GetProcessesByName(current.ProcessName))
            {
                if (p.Id == current.Id) continue;
                var h = p.MainWindowHandle;
                if (h != IntPtr.Zero)
                {
                    ShowWindow(h, 9); // SW_RESTORE
                    SetForegroundWindow(h);
                    break;
                }
            }
        }
        catch { }
    }

    /// <summary>收到二次启动信号时从托盘恢复主窗口（EventWaitHandle 后台线程回调）。</summary>
    private static void RestoreMainWindowFromTray()
    {
        if (Current?.MainWindow is MainWindow w) w.RestoreFromTray();
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    /// <summary>
    /// 定位 config/link-record。探测顺序（首个存在 config 的候选生效，全缺失时默认 exe 旁 数据\）：
    /// 1) exe 目录\数据\        —— 单文件发布权威位置（数据随 exe 走）
    /// 2) exe 父目录\数据\      —— 开发布局（dist\ 分配项目组.exe → 项目根\数据\），兼容旧安装
    /// 3) exe 目录本身          —— 兼容直接与 exe 同目录散放的历史布局
    /// </summary>
    private static (string cfg, string rec) ResolveDataPaths()
    {
        var baseDir = AppContext.BaseDirectory;
        var parentDir = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(baseDir)) ?? baseDir;
        var candidates = new List<string[]>
        {
            new[] { Path.Combine(baseDir, "数据", "分配项目组-config.json"), Path.Combine(baseDir, "数据", "link-record.json") },
            new[] { Path.Combine(parentDir, "数据", "分配项目组-config.json"), Path.Combine(parentDir, "数据", "link-record.json") },
            new[] { Path.Combine(baseDir, "分配项目组-config.json"), Path.Combine(baseDir, "link-record.json") },
        };
        foreach (var c in candidates)
            if (File.Exists(c[0]))
                return (c[0], c[1]);
        // 全缺失：默认落在 exe 旁 数据\（SaveConfig 会自动建目录），不再写到上级目录
        return (candidates[0][0], candidates[0][1]);
    }
}