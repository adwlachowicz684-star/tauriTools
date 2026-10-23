using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shapes;
using FenPeiXiangMuZu.ViewModels;
using FenPeiXiangMuZu.Views;

namespace FenPeiXiangMuZu;

/// <summary>
/// 拖拽交互（页签重排 / 卡片排序与跨页签移动 / 双击标题栏最大化）。
/// 附加事件用 Preview 隧道事件，不干扰现有 Button 的 Click / Command。
/// 逻辑经路由到本 Window 的统一处理：Down→阈值判定→Move 高亮→Up 落点调用 VM 方法。
/// 项目组列现为「纵向分框」布局：每个页签是独立的分框，内部有各自卡片流（Tag="GroupCardHost"），
/// 命中测试按运行时分框动态解析，不再依赖单一 groupTabsHost / groupCardsHost。
/// </summary>
public partial class MainWindow
{
    private static readonly double DragStartThreshold =
        SystemParameters.MinimumHorizontalDragDistance; // 系统拖拽阈值(约4px)，减少误触

    private sealed class DragState
    {
        public string Kind = "";              // "group" / "project"
        public bool IsTab;                     // true=页签(含分框头)，false=卡片
        public TabViewModel? Tab;
        public FolderCardViewModel? Card;
        public Point Start;
        public bool IsDragging;
        public int FromTabIdx = -1;            // 卡片拖拽开始时的项目页签索引：悬停切页签会改 ActiveProjectTabIndex，需保留源页签
    }

    /// <summary>落点宿主解析：Kind=类别，TabIdx=分框/页签索引(-1=无关)，Host=卡片流(空分框可能为 null)，IsTabHost=是否页签条。</summary>
    private sealed record DropTarget(string Kind, int TabIdx, ItemsControl? Host, bool IsTabHost);

    private DragState? _drag;
    private Border? _titleBar;
    private Canvas? _overlay;
    private Rectangle? _highlight;
    private Rectangle? _insertionBar;
    private bool _dragWired;
    private string? _lastHlLog;   // 高频路径日志去重
    private UIElement? _followEl;         // 分框拖动中跟随鼠标的容器（Y 视觉偏移由拖拽逻辑控制）
    private double _followStartMouseY;    // 跟随起点鼠标 Y（窗口坐标）
    private double _followStartLayoutTop; // 跟随起点布局顶（面板系，换位后配合屏幕目标重算偏移）
    private double _followStartWinTop;    // 跟随起点标题的窗口 Y：目标位移在屏幕系计算，天然兼容自动滚动
    private double _followTitleH;         // 分框标题高度：标题底不得越出滚动视口底缘
    private Point _lastFollowPos;         // 最近一次鼠标位置：自动滚动跳帧时据此保持贴手
    private System.Windows.Threading.DispatcherTimer? _autoScrollTimer;   // 拖动贴边自动滚动定时器
    private AnimatedStackPanel? _groupPanel;

    /// <summary>项目组集群的让位面板（懒查找并缓存）。</summary>
    private AnimatedStackPanel? GroupPanel
    {
        get
        {
            if (_groupPanel == null && groupBoxes != null)
                _groupPanel = FindDescendantByTag<AnimatedStackPanel>(groupBoxes, null);
            return _groupPanel;
        }
    }

    /// <summary>同一内容只记一条，避免 MouseMove 高频路径刷爆调试日志。</summary>
    private void DbgOnce(string key, string msg)
    {
        if (_lastHlLog == key) return;
        _lastHlLog = key;
        Dbg(msg);
    }

    // ---------------- 无边框窗口：标题栏拖拽 + Win11 圆角 ----------------
    private const int WM_NCLBUTTONDOWN = 0xA1;
    private const int HTCAPTION = 0x2;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hWnd);

    private const int WM_GETMINMAXINFO = 0x0024;
    private const int WM_WINDOWPOSCHANGING = 0x0046;
    private const uint MONITOR_DEFAULTTONEAREST = 2;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const int SM_CXSIZEFRAME = 32;
    private const int SM_CYSIZEFRAME = 33;

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    private struct WINDOWPOS
    {
        public IntPtr hwnd;
        public IntPtr hwndInsertAfter;
        public int x, y, cx, cy;
        public uint flags;
    }

    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWCP_ROUND = 2;
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        try
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            int pref = DWMWCP_ROUND;
            DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int));
            // 深色模式：让系统绘制的窗口边框/标题栏跟随深色主题，消除顶部白色边框带
            int dark = 1;
            DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
            DwmSetWindowAttribute(hwnd, 19, ref dark, sizeof(int)); // Win10 1809-1903 旧属性名

            // 无边框窗口最大化默认铺满整屏（盖住任务栏）；取消「隐藏任务栏」时经 WM_GETMINMAXINFO 钳制到工作区，让任务栏保持可见
            if (PresentationSource.FromVisual(this) is HwndSource src)
                src.AddHook(WndProc);
        }
        catch { /* 非 Win11 / DWM 不支持时忽略，保持直角 */ }
    }

    /// <summary>WM_GETMINMAXINFO：进入最大化前，把最大尺寸/位置钳制到当前监视器工作区（任务栏上方）。
    /// 勾选「全屏时隐藏 Windows 任务栏」时不钳制（保持铺满整屏、任务栏被盖住）。</summary>
    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        // 勾选「全屏时隐藏 Windows 任务栏」→ 不干预（默认铺满整屏、任务栏被盖住）
        if (DataContext is ViewModels.MainViewModel vm && !vm.HideTaskbarInFullscreen)
        {
            var hi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            var hMon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            var ok = GetMonitorInfo(hMon, ref hi);
            if (!ok) return IntPtr.Zero;

            if (msg == WM_GETMINMAXINFO)
            {
                // 尺寸上限放宽到整屏+余量，放开系统对最大化窗口的钳制：
                // WPF 无边框最大化时内容四周内缩约一个边框宽（露桌面），真实矩形需靠
                // WM_WINDOWPOSCHANGING 四边外扩覆盖——若这里把 ptMaxSize 钳到工作区，
                // 系统会把尺寸修正(右/下)弹回原位，只剩位置修正(左/上)生效（实测）。
                var maxW = hi.rcMonitor.Right - hi.rcMonitor.Left + 2000;
                var maxH = hi.rcMonitor.Bottom - hi.rcMonitor.Top + 2000;
                var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
                mmi.ptMaxSize.X = maxW;
                mmi.ptMaxSize.Y = maxH;
                mmi.ptMaxTrackSize.X = maxW;
                mmi.ptMaxTrackSize.Y = maxH;
                Marshal.StructureToPtr(mmi, lParam, false);
                handled = true;
            }
            else if (msg == WM_WINDOWPOSCHANGING && IsZoomed(hwnd))
            {
                // 无边框窗口最大化时，WPF 会把内容按系统可调整边框向内缩进约一个边框宽度，
                // 若窗口恰好铺满工作区，左/顶就露出一条桌面。这里把窗口矩形按边框宽度四边外扩
                //（位置负偏移 + 尺寸加大），让内缩后的内容恰好铺满工作区——
                // 越界到屏幕边缘/任务栏的部分被裁剪或被不透明任务栏盖住，不产生可见残边。
                var (x, y, w, h) = ComputeMaximizeRect(vm, hi);
                var wp = Marshal.PtrToStructure<WINDOWPOS>(lParam);
                wp.x = x;
                wp.y = y;
                wp.cx = w;
                wp.cy = h;
                wp.flags &= ~SWP_NOMOVE;
                wp.flags &= ~SWP_NOSIZE;
                Marshal.StructureToPtr(wp, lParam, false);
            }
        }
        return IntPtr.Zero;
    }

    /// <summary>按工作区 + 系统边框宽 + 固定 3px 贴边补偿（左/右/下，实测本机补偿内容内缩与边框估算误差）计算最大化窗口矩形。</summary>
    private (int x, int y, int cx, int cy) ComputeMaximizeRect(ViewModels.MainViewModel vm, MONITORINFO hi)
    {
        var wa = hi.rcWork;
        var cx = GetSystemMetrics(SM_CXSIZEFRAME);
        var cy = GetSystemMetrics(SM_CYSIZEFRAME);
        const int lf = 3;
        const int rf = 3;
        const int bf = 3;
        return (wa.Left - cx - lf,
                wa.Top - cy,
                (wa.Right - wa.Left) + cx * 2 + lf + rf,
                (wa.Bottom - wa.Top) + cy * 2 + bf);
    }

    /// <summary>标题栏空白处按下 → 交给系统标题栏拖拽（自动处理最大化还原 / 边缘吸附）。</summary>
    private void DragWindowFromTitleBar()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        SendMessage(hwnd, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
    }

    /// <summary>在 XAML 加载完成后一次性挂接拖拽/双击事件（此时命名元素与 DataContext 均已就绪）。</summary>
    protected override void OnContentRendered(EventArgs e)
    {
        base.OnContentRendered(e);
        WireDragOnce();
    }

    private void WireDragOnce()
    {
        if (_dragWired) return;
        _dragWired = true;

        PreviewMouseLeftButtonDown += OnDragDown;
        PreviewMouseMove += OnDragMove;
        PreviewMouseLeftButtonUp += OnDragUp;

        // 标题栏 Border 已命名（titleBarHost）→ 直接引用，不再依赖根 Grid 第 0 行的子元素顺序
        _titleBar = titleBarHost;

        if (Content is Grid root)
        {
            // 高亮图层：覆盖内容区(Row=1)，命中测试关闭，仅用来画放置提示框
            _overlay = new Canvas { IsHitTestVisible = false, IsEnabled = false };
            Grid.SetRow(_overlay, 1);
            Grid.SetColumnSpan(_overlay, 3);
            root.Children.Add(_overlay);

            // 拖动反馈统一用蓝灰线色（与滚动条/分隔条一致），避免蓝色刺眼
            var lineActive = TryFindResource("LineActiveBrush") as Brush ?? new SolidColorBrush(Color.FromRgb(0x70, 0x85, 0xa8));
            var lineColor = ((SolidColorBrush)lineActive).Color;
            _highlight = new Rectangle
            {
                Stroke = lineActive,
                StrokeThickness = 2,
                RadiusX = 5,
                RadiusY = 5,
                Fill = new SolidColorBrush(Color.FromArgb(0x30, lineColor.R, lineColor.G, lineColor.B)),
                Visibility = Visibility.Collapsed,
                IsHitTestVisible = false,
                SnapsToDevicePixels = true,
            };
            _overlay.Children.Add(_highlight);

            // 插入位置竖条：拖动卡片时在两卡缝隙处显示，指明插入点
            _insertionBar = new Rectangle
            {
                Fill = new SolidColorBrush(Color.FromArgb(0xE6, lineColor.R, lineColor.G, lineColor.B)),
                Width = 3,
                RadiusX = 1,
                RadiusY = 1,
                Visibility = Visibility.Collapsed,
                IsHitTestVisible = false,
                SnapsToDevicePixels = true,
            };
            _overlay.Children.Add(_insertionBar);
        }
    }

    // ---------------- 按下：记录候选拖拽对象 + 双击标题栏最大化 ----------------

    private void OnDragDown(object sender, MouseButtonEventArgs e)
    {
        // 上次拖拽可能因捕获丢失未走 OnDragUp → 先清残留高亮/插入条，避免蓝线/矩形残留
        if (_drag != null)
        {
            CancelGroupBoxFollow();
            HideHighlight();
            ReleaseMouseCapture();
            if (_drag.IsDragging) Cursor = Cursors.Arrow;
            _drag = null;
        }

        // 标题栏（空白区）按下 → 交给系统拖拽移动窗口
        if (_titleBar != null && PointOver(_titleBar, e.GetPosition(this)))
        {
            var hitBtn = FindVisualParent<Button>(e.OriginalSource as DependencyObject);
            if (hitBtn == null)
            {
                if (e.ClickCount == 2)
                {
                    WindowState = WindowState == WindowState.Normal ? WindowState.Maximized : WindowState.Normal;
                    e.Handled = true;
                }
                else
                {
                    DragWindowFromTitleBar();
                    e.Handled = true;
                }
                return;
            }
            // 命中按钮：跳过，交给下方正常处理（或按钮自身点击）
        }

        var origin = e.OriginalSource as DependencyObject;
        var btn = FindVisualParent<Button>(origin);
        if (btn == null)
        {
            // 非按钮：可能是项目组集群标题栏或分框主体 → 按下并拖动以重排分框
            var box = FindVisualParentTagged(origin, "GroupTabHeader") ?? FindVisualParentTagged(origin, "GroupBoxBody");
            if (DragDbgEnabled)
            {
                var chain = new System.Text.StringBuilder();
                for (var c = origin; c != null && chain.Length < 300; c = GetParent(c))
                    chain.Append(c.GetType().Name).Append("[").Append((c as FrameworkElement)?.Tag).Append("]").Append(">");
                Dbg($"Down: origin={origin?.GetType().Name} tag={(origin as FrameworkElement)?.Tag} btn=null box={(box == null ? "NULL" : box.GetType().Name)} boxTag={box?.Tag} dc={box?.DataContext?.GetType().Name} chain={chain}");
            }
            if (box != null && box.DataContext is TabViewModel gtab2)
            {
                _drag = new DragState { IsTab = true, Tab = gtab2, Kind = "group", Start = e.GetPosition(this) };
                Dbg($"Down: SET group tab={gtab2.Name}");
                return;
            }
            _drag = null;
            return;
        }

        DragState? st = null;
        if (btn.DataContext is TabViewModel ptab && IsInHost(btn, projectTabsHost))
        {
            st = new DragState { IsTab = true, Tab = ptab, Kind = "project", Start = e.GetPosition(this) };
        }
        else if (btn.DataContext is FolderCardViewModel card)
        {
            st = new DragState { IsTab = false, Card = card, Kind = card.Kind, Start = e.GetPosition(this) };
            // 记录卡片实际所在项目页签：悬停页签条实时切换后 ActiveProjectTabIndex 已变，落点需用源页签定位
            if (DataContext is MainViewModel dvm && card.Kind == "project")
                st.FromTabIdx = dvm.ActiveProjectTabIndex;
        }
        _drag = st;
        Dbg($"Down-btn: dc={btn.DataContext?.GetType().Name} kind={(st == null ? "NONE" : st.Kind + "/" + (st.IsTab ? "tab" : "card"))}");
        // 不设 Handled：普通单击仍走 Button Click / Command
    }

    // ---------------- 移动：阈值判定 + 实时高亮 ----------------

    private void OnDragMove(object sender, MouseEventArgs e)
    {
        var st = _drag;
        if (st == null) return;
        Point pos = e.GetPosition(this);

        // 拖拽中鼠标捕获丢失（UI 重组/移出窗口）时 MouseUp 可能不触发，
        // 检测左键已松开则按落点结束本次拖拽，避免高亮/插入条残留
        if (e.LeftButton == MouseButtonState.Released)
        {
            e.Handled = true;
            CompleteDrag(pos);
            return;
        }
        if (st.IsDragging && !IsMouseCaptured) CaptureMouse();

        try
        {
            if (!st.IsDragging)
            {
                double dx = pos.X - st.Start.X, dy = pos.Y - st.Start.Y;
                if (Math.Sqrt(dx * dx + dy * dy) < DragStartThreshold) return;

                st.IsDragging = true;
                CancelGroupHeaderTimer();   // 按住拖动开始：取消标题文字待执行的单击折叠
                CaptureMouse();
                Cursor = Cursors.SizeAll;
                e.Handled = true;
                LiveDrag(st, pos);
                UpdateHighlight(st, pos);
                return;
            }

            e.Handled = true;
            LiveDrag(st, pos);
            UpdateHighlight(st, pos);
        }
        catch (Exception ex)
        {
            // 拖拽过程中的瞬时 UI 布局异常（如容器正在重组）不弹窗打断用户，直接安全结束本次拖拽
            System.Diagnostics.Debug.WriteLine(ex);
            AbortDrag();
        }
    }

    /// <summary>放弃当前拖拽：释放鼠标捕获并清理高亮/光标/分框跟随回弹，避免残留状态。</summary>
    private void AbortDrag()
    {
        CancelGroupBoxFollow();
        HideHighlight();
        ReleaseMouseCapture();
        if (_drag is { IsDragging: true }) Cursor = Cursors.Arrow;
        _drag = null;
    }

    /// <summary>拖动中的分框视觉跟随：目标标题窗口 Y = 起点 + 鼠标位移，夹在滚动视口内（标题不越出可见框），
    /// 再换算回面板系设置偏移；X 不动。屏幕系目标使自动滚动时换算自动生效。</summary>
    private void UpdateGroupBoxFollow(Point pos)
    {
        if (groupBoxes == null || groupBoxScroll == null || _followEl == null) return;
        _lastFollowPos = pos;

        double desiredWinTop = _followStartWinTop + (pos.Y - _followStartMouseY);
        Point o = groupBoxScroll.TranslatePoint(new Point(0, 0), this);           // 视口顶（窗口坐标，随滚动变化）
        double lo = o.Y;
        double hi = o.Y + groupBoxScroll.ViewportHeight - _followTitleH;          // 标题底不越过视口底
        if (hi < lo) hi = lo;
        desiredWinTop = Math.Clamp(desiredWinTop, lo, hi);

        double panelVisualTop = desiredWinTop - groupBoxes.TranslatePoint(new Point(0, 0), this).Y;   // 窗口→面板（含当前滚动）
        double curTop = VisualTreeHelper.GetOffset(_followEl).Y;                  // 实时换位后的最新布局顶
        AnimatedStackPanel.SetDirectOffset(_followEl, panelVisualTop - curTop);
    }

    /// <summary>按悬浮中心执行一次分框实时换位判定（MouseMove 与自动滚动跳帧共用）。</summary>
    private void TryLiveGroupSwap(Point pos)
    {
        if (DataContext is not MainViewModel vm) return;
        if (_drag is not { IsTab: true, Kind: "group" } st2 || _followEl == null || groupBoxes == null) return;
        int from = vm.GroupTabs.IndexOf(st2.Tab!);
        var probe = FloatingProbeWindowY();
        int toIdx = GetGroupBoxSwapIndex(probe?.CenterY ?? pos.Y, probe?.TitleY ?? pos.Y, from);
        if (toIdx != from)
        {
            vm.MoveTab("group", from, toIdx);
            groupBoxes.UpdateLayout();   // 立即取得新布局顶，保证悬浮分框视觉连续不跳
        }
    }

    private void StartDragAutoScroll()
    {
        if (_autoScrollTimer != null) return;
        _autoScrollTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(16) };
        _autoScrollTimer.Tick += OnDragAutoScrollTick;
        _autoScrollTimer.Start();
    }

    private void StopDragAutoScroll()
    {
        if (_autoScrollTimer == null) return;
        _autoScrollTimer.Stop();
        _autoScrollTimer.Tick -= OnDragAutoScrollTick;
        _autoScrollTimer = null;
    }

    /// <summary>拖动贴边自动滚动：指针进入视口上/下边缘区（56px）按侵入深度加速滚动；每跳后重算跟随与换位，保持贴手。</summary>
    private void OnDragAutoScrollTick(object? sender, EventArgs e)
    {
        if (_followEl == null || groupBoxScroll == null) { StopDragAutoScroll(); return; }
        Point o = groupBoxScroll.TranslatePoint(new Point(0, 0), this);
        double vpTop = o.Y, vpBottom = o.Y + groupBoxScroll.ViewportHeight;
        const double zone = 56.0, minSpeed = 4.0, maxSpeed = 18.0;
        double pY = _lastFollowPos.Y;
        double delta;
        if (pY > vpBottom - zone)
            delta = minSpeed + (maxSpeed - minSpeed) * Math.Min(1, (pY - (vpBottom - zone)) / zone);
        else if (pY < vpTop + zone)
            delta = -(minSpeed + (maxSpeed - minSpeed) * Math.Min(1, ((vpTop + zone) - pY) / zone));
        else return;

        double target = Math.Clamp(groupBoxScroll.VerticalOffset + delta, 0, groupBoxScroll.ScrollableHeight);
        if (Math.Abs(target - groupBoxScroll.VerticalOffset) < 0.01) return;   // 已到滚动尽头
        groupBoxScroll.ScrollToVerticalOffset(target);
        UpdateGroupBoxFollow(_lastFollowPos);   // 滚动后重算偏移保持贴手
        TryLiveGroupSwap(_lastFollowPos);       // 内容滚过悬浮中心也要触发让位换位
        UpdateGroupBoxFollow(_lastFollowPos);   // 换位改变布局顶后再校正一次
    }

    /// <summary>结束分框跟随：解除钉住；需补换位则同步布局后由让位动画从残留位置滑入槽位，否则回弹原位。</summary>
    private void EndGroupBoxFollow(DragState st, Point pos)
    {
        var el = _followEl;
        var probeAtDrop = FloatingProbeWindowY();   // 清空跟随态前先取探测点（松手瞬间的位置）
        _followEl = null;
        StopDragAutoScroll();
        if (el == null) return;
        GroupPanel?.Unpin(el);
        if (DataContext is MainViewModel vm && st.Tab != null && groupBoxes != null)
        {
            int from = vm.GroupTabs.IndexOf(st.Tab);
            int toIdx = GetGroupBoxSwapIndex(probeAtDrop?.CenterY ?? pos.Y, probeAtDrop?.TitleY ?? pos.Y, from);
            if (from >= 0 && toIdx != from)
            {
                // 不清偏移：同步布局后 ArrangeOverride 以「旧布局顶+残留偏移」为起点滑入新槽位
                vm.MoveTab("group", from, toIdx);
                groupBoxes.UpdateLayout();
                return;
            }
        }
        AnimatedStackPanel.SpringBack(el);
    }

    /// <summary>放弃分框跟随：清除状态并把被拖分框回弹原位（异常兜底/重复按下清理共用）。</summary>
    private void CancelGroupBoxFollow()
    {
        var el = _followEl;
        _followEl = null;
        StopDragAutoScroll();
        if (el != null)
        {
            GroupPanel?.Unpin(el);
            AnimatedStackPanel.SpringBack(el);
        }
    }

    /// <summary>拖动过程中的实时反馈：项目页签拖动→水平实时让位；分框拖动→Y 轴跟随鼠标（松开落位）；卡片拖动→悬停切换活动项目页签。</summary>
    private void LiveDrag(DragState st, Point pos)
    {
        if (DataContext is not MainViewModel vm) return;

        if (st.IsTab)
        {
            if (st.Kind == "group")
            {
                // 分框：被拖分框沿 Y 轴悬浮跟随鼠标（X 锁定）；越过邻框即实时换位，
                // 其余分框由 AnimatedStackPanel 播放让位滑动；松开时残留小位移滑入槽位。
                var boxes = groupBoxes;
                if (_followEl == null && boxes != null)
                {
                    int i = vm.GroupTabs.IndexOf(st.Tab!);
                    if (i >= 0 && SafeContainer(boxes, i) is UIElement el)
                    {
                        _followEl = el;
                        _followStartMouseY = pos.Y;
                        _followStartLayoutTop = VisualTreeHelper.GetOffset(el).Y;
                        // 屏幕系起点与标题高度：跟随目标在屏幕系计算并夹进视口；随后启动贴边自动滚动
                        _followStartWinTop = boxes.TranslatePoint(new Point(0, _followStartLayoutTop), this).Y;
                        _followTitleH = FindDescendantByTag<FrameworkElement>(el, "GroupTabHeader")?.RenderSize.Height ?? 30;
                        _lastFollowPos = pos;
                        GroupPanel?.Pin(el);   // 布局换位时不给被拖分框播放动画/清偏移
                        StartDragAutoScroll();
                    }
                }
                TryLiveGroupSwap(pos);
                UpdateGroupBoxFollow(pos);
                return;
            }
            // 项目页签水平让位
            if (!PointOver(projectTabsHost, pos)) return;
            Point origin = projectTabsHost.TranslatePoint(new Point(0, 0), this);
            var hp = new Point(pos.X - origin.X, pos.Y - origin.Y);
            int pid = GetTabInsertIndex(projectTabsHost, hp);
            int pf = vm.ProjectTabs.IndexOf(st.Tab!);
            if (pid != pf) vm.MoveTab("project", pf, pid);
            return;
        }

        // 卡片拖动：悬停项目页签 → 实时切换活动项目页签（项目组集群已全部可见，无需切换）
        if (PointOver(projectTabsHost, pos))
        {
            Point org = projectTabsHost.TranslatePoint(new Point(0, 0), this);
            var hp2 = new Point(pos.X - org.X, pos.Y - org.Y);
            int idx = GetTabIndexAt(projectTabsHost, hp2);
            if (idx >= 0 && idx != vm.ActiveProjectTabIndex) vm.SwitchProjectTab(idx);
        }
    }

    // ---------------- 松开：落点判定并调用 VM ----------------

    private void OnDragUp(object sender, MouseButtonEventArgs e)
    {
        var st = _drag;
        if (st == null) return;
        // 仅真正发生拖拽时拦截事件；普通单击不设 Handled，保留 Button.Click → 选中卡片
        if (st.IsDragging) e.Handled = true;
        CompleteDrag(e.GetPosition(this));
    }

    /// <summary>完成一次拖拽：按落点执行移动/排序，并清理高亮、捕获与光标（OnDragUp 与捕获丢失兜底共用）。</summary>
    private void CompleteDrag(Point pos)
    {
        var st = _drag;
        if (st == null) return;
        // 先置空再处理：落点处理中（MoveCardToTab 等）会触发 UI 重排，可能重入本方法；
        // 若不先置空，重入调用会看到 _drag 仍非空而重复执行落点（跨集群移动后又重排一次）
        _drag = null;
        try
        {
            if (st.IsDragging && DataContext is MainViewModel vm)
            {
                if (st.IsTab)
                {
                    if (st.Kind == "group")
                    {
                        // 落点前的最终让位恢复滑动动画，松手后平滑归位
                        if (GroupPanel is { } gp) gp.AnimateReorder = true;
                        EndGroupBoxFollow(st, pos);   // 有换位→从当前视觉位置滑入新槽位；无换位→回弹原位
                    }
                    else if (PointOver(projectTabsHost, pos))
                    {
                        Point origin = projectTabsHost.TranslatePoint(new Point(0, 0), this);
                        int toIdx = GetTabInsertIndex(projectTabsHost, new Point(pos.X - origin.X, pos.Y - origin.Y));
                        int from = vm.ProjectTabs.IndexOf(st.Tab!);
                        if (toIdx != from) vm.MoveTab("project", from, toIdx);
                    }
                }
                else
                {
                    var dst = ResolveAnyHost(pos);
                    Dbg($"Up-card: dst={(dst == null ? "NULL" : $"{dst.Kind}/{dst.TabIdx}/tabhost={dst.IsTabHost}/host={(dst.Host != null)}")}");
                    if (dst != null) HandleCardDrop(vm, st.Card!, dst, pos, st.FromTabIdx);
                }
            }
        }
        finally
        {
            HideHighlight();
            ReleaseMouseCapture();
            if (st.IsDragging) Cursor = Cursors.Arrow;
            if (GroupPanel is { } gp) gp.AnimateReorder = true;
        }
    }

    /// <summary>拖拽落到项目卡片后：弹出链接多选确认弹窗（默认勾选开启的提议项），确认后建链。</summary>
    private void ConfirmAndCreateLink(MainViewModel vm, string proj, string grp)
    {
        var projKey = System.IO.Path.TrimEndingDirectorySeparator(proj);
        var projectName = System.IO.Path.GetFileName(projKey);
        var groupName = System.IO.Path.GetFileName(System.IO.Path.TrimEndingDirectorySeparator(grp));
        if (string.IsNullOrEmpty(projectName)) projectName = projKey;

        var options = vm.BuildLinkPickOptions(proj, true, grp);
        var chosen = LinkPickDialog.Show("创建链接",
            $"为「{projectName}」确认要创建的到「{groupName}」的链接（可多选）", options);
        if (chosen == null) { vm.Message = "已取消建链。"; return; }
        try
        {
            var err = vm.AssignPicked(proj, grp, chosen);
            if (err != null) vm.Message = "创建链接失败：" + err;
        }
        catch (Exception ex) { CaptureActionError("拖拽建链", ex); }
    }

    /// <summary>卡片落点处理：跨类别落到具体卡片→建链接；落卡片区→排序/跨类别移动；落页签条→移入目标页签。
    /// fromTabIdx=卡片拖拽开始时的源项目页签（悬停切页签后 ActiveProjectTabIndex 已指向目标，不能用作源）。</summary>
    private bool HandleCardDrop(MainViewModel vm, FolderCardViewModel card, DropTarget dst, Point pos, int fromTabIdx)
    {
        // 跨类别拖到一张具体卡片 → 建项目→项目组链接（先用多选弹窗确认要建的链接名）
        if (dst.Host != null
            && ResolveLinkDrop(card, dst.Host, pos, out var proj, out var grp, out _)
            && !string.IsNullOrEmpty(proj) && !string.IsNullOrEmpty(grp))
        {
            // 延到当前鼠标事件完成、拖拽清理（释放捕获）之后，再弹确认弹窗，避免阻塞鼠标释放流程
            Dispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.Background,
                new Action(() => ConfirmAndCreateLink(vm, proj, grp)));
            return true;
        }

        // 落到项目页签条 → 移入目标项目页签
        if (dst.IsTabHost)
        {
            Point org = projectTabsHost.TranslatePoint(new Point(0, 0), this);
            int idx = GetTabIndexAt(projectTabsHost, new Point(pos.X - org.X, pos.Y - org.Y));
            if (card.Kind == "project")
            {
                int fromTab = fromTabIdx >= 0 ? fromTabIdx : vm.ActiveProjectTabIndex;
                if (fromTab == idx) return true;   // 拖回源页签自身：无操作，避免被移到自身末尾
                int toIndex = vm.ProjectTabs[idx].Items.Count;
                vm.MoveCardToTab("project", fromTab, idx, card.FullPath, toIndex);
            }
            else
            {
                int toIndex = vm.ProjectTabs[idx].Items.Count;
                vm.MoveCardAcross("group", card.FullPath, "project", idx, toIndex);
            }
            return true;
        }

        // 落到卡片区：同类别页签内排序；反之跨类别移动到该分框/活动项目页签
        int tabIdx = dst.TabIdx;
        string dstKind = dst.Kind;
        int index = dst.Host == null ? 0 : GetCardInsertIndex(dst.Host, ToLocal(dst.Host, pos));
        Dbg($"HandleCardDrop: card={card.DisplayName} kind={card.Kind} dstKind={dstKind} tabIdx={tabIdx} index={index} fromTab={FindGroupTabIndex(vm, card)}");
        if (card.Kind == dstKind)
        {
            if (card.Kind == "group")
            {
                // 项目组集群全部可见，卡片可能来自其他分框：源≠目标 → 跨分框移动，否则页签内重排
                int fromTab = FindGroupTabIndex(vm, card);
                if (fromTab == tabIdx) vm.ReorderCards("group", tabIdx, card.FullPath, index);
                else vm.MoveCardToTab("group", fromTab, tabIdx, card.FullPath, index);
            }
            else
            {
                // 悬停切页签后落到的卡片流已是目标页签内容：源页签≠活动页签 → 跨页签移动，否则页签内重排
                if (fromTabIdx >= 0 && fromTabIdx != vm.ActiveProjectTabIndex)
                    vm.MoveCardToTab("project", fromTabIdx, vm.ActiveProjectTabIndex, card.FullPath, index);
                else
                    vm.ReorderCards("project", vm.ActiveProjectTabIndex, card.FullPath, index);
            }
        }
        else
        {
            vm.MoveCardAcross(card.Kind, card.FullPath, dstKind, tabIdx, index);
        }
        return true;
    }

    // ---------------- 落点解析（动态解析项目组集群） ----------------

    /// <summary>解析指针所处卡片流宿主：项目卡片流 / 任一分框卡片流（空分框 Host 为 null）。</summary>
    private DropTarget? ResolveCardHost(Point p)
    {
        if (DataContext is not MainViewModel vm) return null;

        if (PointOver(projectCardsHost, p))
            return new DropTarget("project", vm.ActiveProjectTabIndex, projectCardsHost, false);
        if (PointOver(projectCardsScroll, p))
            return new DropTarget("project", vm.ActiveProjectTabIndex, projectCardsHost, false);

        if (groupBoxes != null)
        {
            for (int i = 0; i < groupBoxes.Items.Count; i++)
            {
                if (SafeContainer(groupBoxes, i) is not FrameworkElement el) continue;
                if (!el.IsVisible || !PointOver(el, p)) continue;
                var host = FindDescendantByTag<ItemsControl>(el, "GroupCardHost");
                if (host != null && host.IsVisible && host.ActualWidth > 0 && host.ActualHeight > 0)
                    return new DropTarget("group", i, host, false);
                // 空分框：可落，Host 为 null（无卡片可高亮），插入位一律 0
                return new DropTarget("group", i, null, false);
            }
        }
        return null;
    }

    /// <summary>解析指针所处任意可落宿主：先卡片流，再项目页签条。</summary>
    private DropTarget? ResolveAnyHost(Point p)
    {
        if (DataContext is MainViewModel vm && PointOver(projectTabsHost, p))
            return new DropTarget("project", vm.ActiveProjectTabIndex, projectTabsHost, true);
        return ResolveCardHost(p);
    }

    /// <summary>返回指针所在分框容器的索引（纵向）；不在任何分框内返回 -1。</summary>
    private int GroupBoxIndexAt(Point p)
    {
        if (groupBoxes == null) return -1;
        for (int i = 0; i < groupBoxes.Items.Count; i++)
        {
            if (SafeContainer(groupBoxes, i) is FrameworkElement el
                && el.IsVisible && PointOver(el, p)) return i;
        }
        return -1;
    }

    /// <summary>定位 group 卡片当前所在分框索引（按卡片实例引用）；找不到返回 -1。</summary>
    private static int FindGroupTabIndex(MainViewModel vm, FolderCardViewModel card)
    {
        for (int i = 0; i < vm.GroupTabs.Count; i++)
            if (vm.GroupTabs[i].Items.Contains(card)) return i;
        return -1;
    }

    /// <summary>
    /// 分框容器相对 target 视觉的「布局」顶边 Y（VisualTreeHelper.GetOffset，不含让位滑动动画偏移）。
    /// 插入点判定与蓝线定位必须用它：滑动进行中 TranslatePoint 会返回半路视觉位置，导致蓝线压在分框上。
    /// （groupBoxes 自身无 RenderTransform，故 panel→target 的换算稳定。）
    /// </summary>
    private double GroupBoxLayoutTopIn(UIElement el, UIElement target)
    {
        if (groupBoxes == null) return 0;
        double inPanel = VisualTreeHelper.GetOffset(el).Y;
        return groupBoxes.TranslatePoint(new Point(0, inPanel), target).Y;
    }

    /// <summary>分框纵向插入点索引（0..Count）：按指针相对各分框「布局」顶部/中心判断（不受滑动动画影响）。</summary>
    private int GetGroupBoxInsertIndex(Point p)
    {
        if (groupBoxes == null) return 0;
        int best = 0;
        for (int i = 0; i < groupBoxes.Items.Count; i++)
        {
            if (SafeContainer(groupBoxes, i) is not UIElement el) continue;
            double cy = GroupBoxLayoutTopIn(el, this) + el.RenderSize.Height / 2;   // 窗口坐标，与 p 同系
            if (p.Y < cy) { best = i; break; }
            best = i + 1;
        }
        return best;
    }

    /// <summary>让位换位死区基准（px）：越界超过此距离才换位；实际死区取它与「邻框高的 20%（中心到 30%/70% 线）」的较小值。</summary>
    private const double GroupBoxSwapHysteresis = 16.0;

    /// <summary>悬浮中被拖分框的探测点（窗口坐标，含当前跟随偏移）：
    /// TitleY=标题顶（向上换位的前导边），CenterY=视觉中心（向下换位用）；未处于跟随态返回 null。</summary>
    private (double TitleY, double CenterY)? FloatingProbeWindowY()
    {
        if (groupBoxes == null || _followEl == null) return null;
        double curTop = VisualTreeHelper.GetOffset(_followEl).Y;
        double off = 0;
        switch (_followEl.RenderTransform)
        {
            case TranslateTransform t:
                off = t.Y;
                break;
            case TransformGroup g:
                foreach (var tr in g.Children)
                    if (tr is TranslateTransform tt) { off = tt.Y; break; }
                break;
        }
        double winTop = groupBoxes.TranslatePoint(new Point(0, curTop + off), this).Y;
        return (winTop, winTop + _followEl.RenderSize.Height / 2);
    }

    /// <summary>
    /// 带死区的分框换位索引（混合探测）：越过邻框中心并超出死区才换位；
    /// 死区内保持原索引（进入死区前的落点），支持一次跨越多框的连续推进（快速甩动也能追上）。
    /// 向下以被拖项视觉中心为基准（配合贴边自动滚动可达贴底邻框）；
    /// 向上以标题为基准——高个集群的视觉中心受视口顶夹紧永远够不到贴顶矮邻框的中心线，而标题可抵达视口顶。
    /// </summary>
    private int GetGroupBoxSwapIndex(double centerY, double titleY, int from)
    {
        if (groupBoxes == null) return Math.Max(0, from);
        int n = groupBoxes.Items.Count;
        if (n == 0 || from < 0) return 0;
        int idx = Math.Clamp(from, 0, n - 1);
        for (int guard = 0; guard < n; guard++)
        {
            int next = idx;
            if (idx + 1 < n && SafeContainer(groupBoxes, idx + 1) is UIElement below)
            {
                double margin = Math.Min(GroupBoxSwapHysteresis, below.RenderSize.Height * 0.2);
                if (centerY > GroupBoxLayoutTopIn(below, this) + below.RenderSize.Height / 2 + margin)
                    next = idx + 1;
            }
            if (next == idx && idx - 1 >= 0 && SafeContainer(groupBoxes, idx - 1) is UIElement above)
            {
                double margin = Math.Min(GroupBoxSwapHysteresis, above.RenderSize.Height * 0.2);
                if (titleY < GroupBoxLayoutTopIn(above, this) + above.RenderSize.Height / 2 - margin)
                    next = idx - 1;
            }
            if (next == idx) break;
            idx = next;
        }
        return idx;
    }

    // ---------------- 高亮：落点容器矩形 / 链接目标卡片 / 插入竖条 ----------------

    private void UpdateHighlight(DragState st, Point pos)
    {
        _highlight!.Visibility = Visibility.Collapsed;
        if (_insertionBar != null) _insertionBar.Visibility = Visibility.Collapsed;
        var ov = _overlay;
        if (ov == null) return;
        if (st.IsTab)
        {
            if (st.Kind == "group") ShowGroupInsertBar(st, pos);   // 分框重排：显示横向插入条
            return;
        }

        var dst = ResolveCardHost(pos);
        DbgOnce("hl", $"HL-card: dst={(dst == null ? "NULL" : $"{dst.Kind}/{dst.TabIdx}/host={(dst.Host != null)}")}");
        if (dst == null) return;

        // 跨类别拖到某张具体卡片 → 高亮该卡片（建链接提示）
        if (dst.Host != null
            && ResolveLinkDrop(st.Card!, dst.Host, pos, out _, out _, out var linkTarget)
            && linkTarget != null)
        {
            HighlightCard(dst.Host, linkTarget);
            return;
        }

        // 落卡片区 → 在缝隙显示插入竖条
        if (dst.Host != null)
        {
            ShowInsertionBar(dst.Host, GetCardInsertIndex(dst.Host, ToLocal(dst.Host, pos)));
            return;
        }

        // 空分框：高亮该分框容器矩形
        if (SafeContainer(groupBoxes, dst.TabIdx) is UIElement boxEl)
        {
            Point o = boxEl.TranslatePoint(new Point(0, 0), ov);
            Canvas.SetLeft(_highlight, o.X);
            Canvas.SetTop(_highlight, o.Y);
            _highlight.Width = boxEl.RenderSize.Width;
            _highlight.Height = boxEl.RenderSize.Height;
            _highlight.Visibility = Visibility.Visible;
        }
    }

    /// <summary>分框纵向重排：在目标插入位置显示一条横向插入条（带死区索引与实际换位一致；Y 用布局坐标，不受滑动动画影响）。</summary>
    private void ShowGroupInsertBar(DragState st, Point pos)
    {
        if (groupBoxes == null || _insertionBar == null) return;
        int from = DataContext is MainViewModel vm2 ? vm2.GroupTabs.IndexOf(st.Tab!) : -1;
        var probe2 = FloatingProbeWindowY();
        int idx = from < 0
            ? GetGroupBoxInsertIndex(pos)
            : GetGroupBoxSwapIndex(probe2?.CenterY ?? pos.Y, probe2?.TitleY ?? pos.Y, from);
        int n = groupBoxes.Items.Count;
        if (n == 0) { _insertionBar.Visibility = Visibility.Collapsed; return; }

        UIElement? e = null;
        double yOffset = 0;
        if (idx <= 0) e = SafeContainer(groupBoxes, 0);
        else if (idx >= n) { e = SafeContainer(groupBoxes, n - 1); yOffset = e?.RenderSize.Height ?? 0; }
        else e = SafeContainer(groupBoxes, idx);
        if (e == null) { _insertionBar.Visibility = Visibility.Collapsed; return; }

        double top = GroupBoxLayoutTopIn(e, _overlay!) + yOffset;   // 布局位置（overlay 坐标，无动画偏移）
        double x = e.TranslatePoint(new Point(0, 0), _overlay).X;   // X 方向无动画，直接用视觉位置
        var bar = _insertionBar;
        Canvas.SetLeft(bar, x);
        Canvas.SetTop(bar, top - 1);
        bar.Width = e.RenderSize.Width;
        bar.Height = 2;
        bar.Visibility = Visibility.Visible;
    }

    /// <summary>在两组卡片之间的插入位置显示一条竖向小竖条（坐标换算到 overlay）。</summary>
    private void ShowInsertionBar(ItemsControl host, int index)
    {
        int n = host.Items.Count;
        UIElement? e = null;
        double x = 0;
        if (n == 0) return;
        if (index <= 0)
        {
            e = SafeContainer(host, 0);
        }
        else if (index >= n)
        {
            e = SafeContainer(host, n - 1);
            x = e?.RenderSize.Width ?? 0;
        }
        else
        {
            e = SafeContainer(host, index);
        }
        if (e == null) { _insertionBar!.Visibility = Visibility.Collapsed; return; }

        Point o = e.TranslatePoint(new Point(x, 0), _overlay);
        var bar = _insertionBar!;
        bar.Width = 2;   // 重置为竖条宽度，避免残留分框重排时的横条宽度变成矩形
        Canvas.SetLeft(bar, o.X - 1);
        Canvas.SetTop(bar, o.Y);
        bar.Height = e.RenderSize.Height;
        bar.Visibility = Visibility.Visible;
    }

    private void HideHighlight()
    {
        if (_highlight != null) _highlight.Visibility = Visibility.Collapsed;
        if (_insertionBar != null) _insertionBar.Visibility = Visibility.Collapsed;
    }

    /// <summary>判定“跨类别拖到一张具体卡片 → 建链接”：命中返回 (项目路径,项目组路径)；命中间隙或同类别返回 false。</summary>
    private bool ResolveLinkDrop(FolderCardViewModel dragCard, ItemsControl host, Point windowPos,
        out string? projPath, out string? grpPath, out FolderCardViewModel? targetCard)
    {
        projPath = null; grpPath = null; targetCard = null;
        bool dstGroup = host.Tag as string == "GroupCardHost";     // 项目组集群卡片流
        bool dstProject = ReferenceEquals(host, projectCardsHost); // 项目卡片流
        if (!dstGroup && !dstProject) return false;
        // 同类别落到卡片区 → 仍是页签内排序，不建链接
        if ((dstGroup && dragCard.Kind == "group") || (dstProject && dragCard.Kind == "project")) return false;

        var target = HitCardAt(host, windowPos);
        if (target == null) return false;   // 落在卡片间隙/空白 → 跨列移动
        targetCard = target;
        // 链接方向固定为 项目 → 项目组
        if (dragCard.Kind == "project") { projPath = dragCard.FullPath; grpPath = target.FullPath; }
        else { grpPath = dragCard.FullPath; projPath = target.FullPath; }
        return true;
    }

    /// <summary>命中 host 内指针所在的那张具体卡片（窗口坐标），未命中返回 null。</summary>
    private FolderCardViewModel? HitCardAt(ItemsControl host, Point windowPos)
    {
        for (int i = 0; i < host.Items.Count; i++)
        {
            if (host.Items[i] is not FolderCardViewModel card) continue;
            if (SafeContainer(host, i) is not UIElement el) continue;
            Point o = el.TranslatePoint(new Point(0, 0), this);
            if (new Rect(o, new Size(el.RenderSize.Width, el.RenderSize.Height)).Contains(windowPos))
                return card;
        }
        return null;
    }

    /// <summary>高亮指定卡片（建链接目标提示框）。</summary>
    private void HighlightCard(ItemsControl host, FolderCardViewModel target)
    {
        var hl = _highlight;
        var ov = _overlay;
        if (hl is null || ov is null) return;   // 高亮元素未就绪则跳过
        for (int i = 0; i < host.Items.Count; i++)
        {
            if (!ReferenceEquals(host.Items[i], target)) continue;
            if (SafeContainer(host, i) is not UIElement el) continue;
            Point o = el.TranslatePoint(new Point(0, 0), ov);
            Canvas.SetLeft(hl, o.X);
            Canvas.SetTop(hl, o.Y);
            hl.Width = el.RenderSize.Width;
            hl.Height = el.RenderSize.Height;
            hl.Visibility = Visibility.Visible;
            return;
        }
    }

    // ---------------- 命中测试 / 索引换算 ----------------

    private bool PointOver(UIElement el, Point p)
    {
        if (!el.IsVisible) return false;
        Point o = el.TranslatePoint(new Point(0, 0), this);
        return new Rect(o, new Size(el.RenderSize.Width, el.RenderSize.Height)).Contains(p);
    }

    private System.Windows.Point ToLocal(UIElement el, Point windowP)
    {
        Point o = el.TranslatePoint(new Point(0, 0), this);
        return new Point(windowP.X - o.X, windowP.Y - o.Y);
    }

    /// <summary>横向页签宿主（书签式）：返回插入点索引（0..Count），用于移动后重排。</summary>
    private static int GetTabInsertIndex(ItemsControl host, Point p)
    {
        int best = 0;
        for (int i = 0; i < host.Items.Count; i++)
        {
            if (SafeContainer(host, i) is not UIElement el) continue;
            Point p0 = el.TranslatePoint(new Point(0, 0), host);
            if (p.X < p0.X + el.RenderSize.Width / 2) { best = i; break; }
            best = i + 1;
        }
        return best;
    }

    /// <summary>横向页签宿主（书签式）：返回指针最近的目标页签索引（0..Count-1），用于卡片悬停切换/移入目标页签。</summary>
    private static int GetTabIndexAt(ItemsControl host, Point p)
    {
        int best = 0;
        double bestD = double.MaxValue;
        for (int i = 0; i < host.Items.Count; i++)
        {
            if (SafeContainer(host, i) is not UIElement el) continue;
            Point c = el.TranslatePoint(new Point(el.RenderSize.Width / 2, 0), host);
            double d = Math.Abs(p.X - c.X);
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }

    /// <summary>卡片宿主(WrapPanel)：返回插入位索引（0..Count，位于最近卡片之前/之后），供竖条指示与落点插入。</summary>
    private static int GetCardInsertIndex(ItemsControl host, Point p)
    {
        int n = host.Items.Count;
        if (n == 0) return 0;

        int nearest = 0;
        double best = double.MaxValue;
        for (int i = 0; i < n; i++)
        {
            if (SafeContainer(host, i) is not UIElement el) continue;
            Point c = el.TranslatePoint(new Point(el.RenderSize.Width / 2, el.RenderSize.Height / 2), host);
            double dx = c.X - p.X, dy = c.Y - p.Y;
            double d = dx * dx + dy * dy;
            if (d < best) { best = d; nearest = i; }
        }
        // 取最近卡片的水平中心，决定插在它之前还是之后
        double cx = 0;
        if (SafeContainer(host, nearest) is UIElement ne)
            cx = ne.TranslatePoint(new Point(ne.RenderSize.Width / 2, 0), host).X;
        return p.X < cx ? nearest : nearest + 1;
    }

    /// <summary>安全向上取父节点：ContentElement（如文本里的 Run/Span）不参与可视化树，
    /// 需先经逻辑树跨出到宿主（TextBlock 等 Visual），否则 VisualTreeHelper.GetParent 会抛异常。</summary>
    private static DependencyObject? GetParent(DependencyObject d)
        => d is System.Windows.ContentElement ? LogicalTreeHelper.GetParent(d) : VisualTreeHelper.GetParent(d);

    private static bool IsInHost(DependencyObject obj, ItemsControl host)
    {
        for (var d = obj; d != null; d = GetParent(d))
            if (ReferenceEquals(d, host)) return true;
        return false;
    }

    private static T? FindVisualParent<T>(DependencyObject? d) where T : DependencyObject
    {
        for (var cur = d; cur != null; cur = GetParent(cur))
            if (cur is T t) return t;
        return null;
    }

    /// <summary>向上查找首个带指定 Tag 的 FrameworkElement（用于定位非按钮的分框标题栏）。</summary>
    private static FrameworkElement? FindVisualParentTagged(DependencyObject? d, object tag)
    {
        for (var cur = d; cur != null; cur = GetParent(cur))
            if (cur is FrameworkElement fe && Equals(fe.Tag, tag)) return fe;
        return null;
    }

    private static T? FindDescendantByTag<T>(DependencyObject root, object? tag) where T : FrameworkElement
    {
        if (root is T t && Equals(t.Tag, tag)) return t;
        int n = VisualTreeHelper.GetChildrenCount(root);
        for (int i = 0; i < n; i++)
        {
            var found = FindDescendantByTag<T>(VisualTreeHelper.GetChild(root, i), tag);
            if (found != null) return found;
        }
        return null;
    }

    /// <summary>安全获取 ItemsControl 第 i 项容器；生成器重组中返回 null，避免查询抛出异常。</summary>
    private static UIElement? SafeContainer(ItemsControl ic, int i)
    {
        var gen = ic.ItemContainerGenerator;
        if (gen.Status != System.Windows.Controls.Primitives.GeneratorStatus.ContainersGenerated) return null;
        return gen.ContainerFromIndex(i) as UIElement;
    }

    private static readonly object _dbgLock = new();
    /// <summary>拖拽路径调试日志开关：默认关闭（生产环境避免高频写文件与日志无限膨胀）；排查拖拽问题时临时置 true。</summary>
    private static readonly bool DragDbgEnabled = false;

    private static void Dbg(string msg)
    {
        if (!DragDbgEnabled) return;
        try
        {
            lock (_dbgLock)
            {
                System.IO.File.AppendAllText(
                    System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fenpei_drag_debug.log"),
                    $"{DateTime.Now:HH:mm:ss.fff} {msg}\r\n");
            }
        }
        catch { }
    }
}