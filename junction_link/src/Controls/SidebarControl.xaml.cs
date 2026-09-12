using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;

namespace FenPeiXiangMuZu.Controls;

/// <summary>
/// 可复用侧边栏组件：图标列 + 右侧名称浮层（Popup 自包含），数据驱动、不依赖任何 ViewModel。
/// 宿主仅需提供 <see cref="SidebarItems"/>（图标/名称两列共用同一数据源，逐行对齐），
/// 并可选设置 <see cref="SidebarPersistent"/>（常驻/临时浮出模式）与 <see cref="SidebarExpanded"/>（常驻展开态）。
/// </summary>
public partial class SidebarControl : UserControl
{
    /// <summary>侧边栏数据源：图标列与名称列共用同一集合，保证两列逐行严格对齐、永不漂移。</summary>
    public static readonly DependencyProperty SidebarItemsProperty = DependencyProperty.Register(
        nameof(SidebarItems), typeof(IEnumerable<SidebarItemModel>), typeof(SidebarControl),
        new PropertyMetadata(null, OnSidebarItemsChanged));

    public IEnumerable<SidebarItemModel>? SidebarItems
    {
        get => (IEnumerable<SidebarItemModel>?)GetValue(SidebarItemsProperty);
        set => SetValue(SidebarItemsProperty, value);
    }

    /// <summary>名称浮层是否常驻：true=切换按钮控制显隐；false（默认）=鼠标悬停图标条时临时浮出。</summary>
    public static readonly DependencyProperty SidebarPersistentProperty = DependencyProperty.Register(
        nameof(SidebarPersistent), typeof(bool), typeof(SidebarControl),
        new PropertyMetadata(false, OnSidebarPersistentChanged));

    public bool SidebarPersistent
    {
        get => (bool)GetValue(SidebarPersistentProperty);
        set => SetValue(SidebarPersistentProperty, value);
    }

    /// <summary>名称浮层是否展开（常驻模式下由切换按钮控制）。</summary>
    public static readonly DependencyProperty SidebarExpandedProperty = DependencyProperty.Register(
        nameof(SidebarExpanded), typeof(bool), typeof(SidebarControl),
        new PropertyMetadata(false, OnSidebarExpandedChanged));

    public bool SidebarExpanded
    {
        get => (bool)GetValue(SidebarExpandedProperty);
        set => SetValue(SidebarExpandedProperty, value);
    }

    private bool _sidebarHover;

    // --- 点击穿透 P/Invoke ---
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x20;
    private const int WS_EX_LAYERED = 0x80000;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint GetWindowLongPtrW(nint hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SetWindowLongPtrW(nint hWnd, int nIndex, nint dwNewLong);

    private static void ApplyClickThrough(nint hWnd)
    {
        var exStyle = GetWindowLongPtrW(hWnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hWnd, GWL_EXSTYLE, exStyle | WS_EX_TRANSPARENT | WS_EX_LAYERED);
    }

    public SidebarControl()
    {
        InitializeComponent();
        NamePopup.Opened += NamePopup_Opened;
    }

    private static void OnSidebarItemsChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var c = (SidebarControl)d;
        var top = new List<SidebarItemModel>();
        var bottom = new List<SidebarItemModel>();
        bool anchor = false;
        if (c.SidebarItems != null)
        {
            foreach (var it in c.SidebarItems)
            {
                if (it.Kind == SidebarItemKind.BottomAnchor) { anchor = true; continue; }
                (anchor ? bottom : top).Add(it);
            }
        }
        // 底部锚定组由下向上排：反转后以 DockPanel.Dock=Bottom 容器按序堆叠，使首项排在最下
        var bottomUp = new List<SidebarItemModel>(bottom);
        bottomUp.Reverse();

        c.sidebarIconListTop.ItemsSource = null;
        c.sidebarIconListTop.ItemsSource = top;
        c.sidebarIconListBottom.ItemsSource = null;
        c.sidebarIconListBottom.ItemsSource = bottomUp;
        c.sidebarNameListTop.ItemsSource = null;
        c.sidebarNameListTop.ItemsSource = top;
        c.sidebarNameListBottom.ItemsSource = null;
        c.sidebarNameListBottom.ItemsSource = bottomUp;
    }

    private static void OnSidebarPersistentChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var c = (SidebarControl)d;
        if (!c.SidebarPersistent && c.SidebarExpanded) c.SidebarExpanded = false;   // 切回临时模式时收起常驻浮层
        c.UpdateSidebarPopupVisibility();
    }

    private static void OnSidebarExpandedChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        => ((SidebarControl)d).UpdateSidebarPopupVisibility();

    /// <summary>刷新名称浮层显隐：常驻模式看 SidebarExpanded；临时模式看鼠标是否在图标条内。</summary>
    private void UpdateSidebarPopupVisibility()
    {
        if (NamePopup == null) return;
        bool show = SidebarPersistent ? SidebarExpanded : _sidebarHover;
        NamePopup.IsOpen = show;
        if (!show && SidebarItems != null) foreach (var it in SidebarItems) it.IsHovered = false;
    }

    private void OnSidebarMouseEnter(object? sender, MouseEventArgs e)
    { _sidebarHover = true; UpdateSidebarPopupVisibility(); }

    private void OnSidebarMouseLeave(object? sender, MouseEventArgs e)
    { _sidebarHover = false; UpdateSidebarPopupVisibility(); }

    private void OnSidebarIconEnter(object sender, RoutedEventArgs e)
    { if ((sender as FrameworkElement)?.DataContext is SidebarItemModel m) m.IsHovered = true; }

    private void OnSidebarIconLeave(object sender, RoutedEventArgs e)
    { if ((sender as FrameworkElement)?.DataContext is SidebarItemModel m) m.IsHovered = false; }

    /// <summary>
    /// 浮层打开时设为 OS 级点击穿透：否则浮层的 30px 阴影光晕会抢占图标条右缘的鼠标输入，
    /// 使主窗口在"进入→离开"间正反馈跳变（固定位置鬼畜）。WS_EX_TRANSPARENT 让命中测试穿透浮层，
    /// 主窗口的图标条悬停始终稳定；浮层本身 IsHitTestVisible=false，纯展示无需输入。
    /// </summary>
    private void NamePopup_Opened(object? sender, EventArgs e)
    {
        if (NamePopup.Child is not { } child) return;
        var source = PresentationSource.FromVisual(child) as HwndSource;
        if (source == null)
        {
            // 极少数首开时 Child 尚未连到 HWND，延迟到下一次布局轮次再应用
            Dispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.Loaded,
                new Action(() => NamePopup_Opened(sender, e)));
            return;
        }
        ApplyClickThrough(source.Handle);
    }

    /// <summary>数据驱动侧边栏图标按钮点击：路由到该项的 Clicked 回调。</summary>
    private void OnSidebarItemClick(object sender, RoutedEventArgs e)
    { if ((sender as FrameworkElement)?.DataContext is SidebarItemModel m) m.Clicked?.Invoke(); }

    /// <summary>非持久模式（默认）下切换按钮仅作提示：浮层由鼠标悬停控制，点它不生效。</summary>
    private void OnToggleSidebar(object sender, RoutedEventArgs e)
    {
        if (!SidebarPersistent) return;
        SidebarExpanded = !SidebarExpanded;
    }
}
