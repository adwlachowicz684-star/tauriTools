using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 屏幕 / 窗口截图服务（供 MCP 工具调用）。纯 P/Invoke + WPF 原生编码，无额外 NuGet 依赖。
/// - 桌面截图：BitBlt 拷贝虚拟屏幕（或指定区域）→ GetDIBits 取 BGRA 像素 → PngBitmapEncoder 保存。
/// - 窗口截图：按标题关键词 EnumWindows 查找 → 还原最小化 → 移到屏内确保完整渲染 → PrintWindow 抓窗口自身表面（不受遮挡影响）。
/// </summary>
public static class ScreenCaptureService
{
    // ---------------- Win32 常量 ----------------
    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;
    private const int SRCCOPY = 0x00CC0020;
    private const int PW_RENDERFULLCONTENT = 2;
    private const int SW_RESTORE = 9;
    private const int DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

    // ---------------- P/Invoke ----------------
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hObj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr hObj);
    [DllImport("gdi32.dll")] private static extern bool BitBlt(IntPtr hdcDest, int x, int y, int w, int h, IntPtr hdcSrc, int sx, int sy, int rop);
    [DllImport("gdi32.dll")] private static extern int GetDIBits(IntPtr hdc, IntPtr hbmp, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER bi, uint usage);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    // 注意：参数是 DPI_AWARENESS_CONTEXT 句柄（指针大小），不是 int——x64 下按 int 传会损坏句柄值导致 API 失败
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    /// <summary>截取整个虚拟桌面（或指定区域 "x,y,w,h"）。返回保存的文件绝对路径。</summary>
    public static string CaptureDesktop(string? outputPath, string? region)
    {
        EnsureDpiAware();
        int x, y, w, h;
        if (region != null && TryParseRegion(region, out x, out y, out w, out h))
        {
            if (w <= 0 || h <= 0) throw new InvalidOperationException("区域宽高必须为正数: " + region);
        }
        else
        {
            x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        }

        var pixels = CaptureRect(x, y, w, h);
        return SavePng(pixels, w, h, outputPath);
    }

    /// <summary>按标题关键词查找窗口并截图。返回 (file, title, hwnd, width, height)。
    /// 最小化窗口一律先还原再截（PrintWindow 对最小化窗口只能取到旧表面）。</summary>
    public static (string File, string Title, long Hwnd, int Width, int Height) CaptureWindow(string titleKeyword, string? outputPath)
    {
        EnsureDpiAware();
        if (string.IsNullOrWhiteSpace(titleKeyword)) throw new InvalidOperationException("缺少参数 title（窗口标题关键词）");

        var hwnd = FindWindowByTitle(titleKeyword);
        if (hwnd == IntPtr.Zero) throw new InvalidOperationException("未找到标题包含「" + titleKeyword + "」的窗口");

        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);   // 仅还原最小化，绝不移动/缩放用户窗口

        GetWindowRect(hwnd, out var r);
        var w = r.Right - r.Left;
        var h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) throw new InvalidOperationException("窗口尺寸无效: " + w + "x" + h);

        var hdcScreen = GetDC(IntPtr.Zero);
        var hdcMem = CreateCompatibleDC(hdcScreen);
        var hbmp = CreateCompatibleBitmap(hdcScreen, w, h);
        try
        {
            SelectObject(hdcMem, hbmp);
            if (!PrintWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT))
                throw new InvalidOperationException($"PrintWindow 截取窗口表面失败（hwnd=0x{hwnd.ToInt64():X}），已放弃输出以免交付黑图。");
            var pixels = GetDibPixels(hdcMem, hbmp, w, h);
            var file = SavePng(pixels, w, h, outputPath);
            return (file, GetWindowTitle(hwnd), hwnd.ToInt64(), w, h);
        }
        finally
        {
            DeleteObject(hbmp);
            DeleteDC(hdcMem);
            ReleaseDC(IntPtr.Zero, hdcScreen);
        }
    }

    /// <summary>列出标题包含关键词的所有可见顶层窗口（供 AI 确认目标）。</summary>
    public static List<string> FindWindowTitles(string keyword)
    {
        var result = new List<string>();
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            var t = GetWindowTitle(hwnd);
            if (t.Length > 0 && (keyword.Length == 0 || t.Contains(keyword, StringComparison.OrdinalIgnoreCase)))
                result.Add(t);
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // ---------------- 内部实现 ----------------

    private static void EnsureDpiAware()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)); }
        catch { /* 已设置或系统不支持时忽略 */ }
    }

    private static byte[] CaptureRect(int x, int y, int w, int h)
    {
        var hdcScreen = GetDC(IntPtr.Zero);
        var hdcMem = CreateCompatibleDC(hdcScreen);
        var hbmp = CreateCompatibleBitmap(hdcScreen, w, h);
        try
        {
            SelectObject(hdcMem, hbmp);
            if (!BitBlt(hdcMem, 0, 0, w, h, hdcScreen, x, y, SRCCOPY))
                throw new InvalidOperationException($"BitBlt 拷屏失败（{x},{y} {w}x{h}），已放弃输出以免交付黑图。");
            return GetDibPixels(hdcMem, hbmp, w, h);
        }
        finally
        {
            DeleteObject(hbmp);
            DeleteDC(hdcMem);
            ReleaseDC(IntPtr.Zero, hdcScreen);
        }
    }

    private static byte[] GetDibPixels(IntPtr hdc, IntPtr hbmp, int w, int h)
    {
        var bmi = new BITMAPINFOHEADER
        {
            biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
            biWidth = w,
            biHeight = -h, // top-down：像素自顶向下，匹配 BitmapSource
            biPlanes = 1,
            biBitCount = 32,
            biCompression = 0,
        };
        var pixels = new byte[w * h * 4];
        var lines = GetDIBits(hdc, hbmp, 0, (uint)h, pixels, ref bmi, 0);
        if (lines == 0)
            throw new InvalidOperationException($"GetDIBits 读取像素失败（{w}x{h}），已放弃输出以免交付黑图。");
        return pixels;
    }

    private static string SavePng(byte[] pixels, int w, int h, string? outputPath)
    {
        var dir = string.IsNullOrEmpty(outputPath)
            ? Path.Combine(Path.GetTempPath(), "fenpei-shot")
            : Path.GetDirectoryName(Path.GetFullPath(outputPath));
        if (string.IsNullOrEmpty(dir)) dir = Path.Combine(Path.GetTempPath(), "fenpei-shot");
        Directory.CreateDirectory(dir);

        var file = string.IsNullOrEmpty(outputPath)
            ? Path.Combine(dir, "capture_" + DateTime.Now.ToString("yyyyMMdd_HHmmss") + ".png")
            : Path.GetFullPath(outputPath);

        var bmp = BitmapSource.Create(w, h, 96, 96, PixelFormats.Bgra32, null, pixels, w * 4);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bmp));
        using (var fs = new FileStream(file, FileMode.Create, FileAccess.Write))
            encoder.Save(fs);
        return file;
    }

    private static IntPtr FindWindowByTitle(string keyword)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, _) =>
        {
            if (found != IntPtr.Zero) return false;
            if (!IsWindowVisible(hwnd)) return true;
            var t = GetWindowTitle(hwnd);
            if (t.Length > 0 && t.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private static string GetWindowTitle(IntPtr hwnd)
    {
        var sb = new StringBuilder(512);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    /// <summary>窗口标题关键词查找 → PrintWindow 抓窗口自身表面（不受遮挡影响）。
    /// 已移除 MoveWindow 逻辑：绝不移动/缩放用户窗口（避免破坏用户布局）；越屏窗口由 PrintWindow 直接抓取。</summary>
    private static bool TryParseRegion(string s, out int x, out int y, out int w, out int h)
    {
        x = y = w = h = 0;
        var parts = s.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return parts.Length == 4
            && int.TryParse(parts[0], out x) && int.TryParse(parts[1], out y)
            && int.TryParse(parts[2], out w) && int.TryParse(parts[3], out h);
    }
}
