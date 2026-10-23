using System.Runtime.InteropServices;
using System.Windows.Media;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 屏幕取色服务：GDI 直读桌面像素，可吸取本工具 GUI 之外的任意窗口/桌面颜色。
/// 坐标一律为物理像素，与 GetCursorPos / 屏幕 DC 同一坐标系（随进程 DPI 感知一致虚拟化，
/// 二者混用不会错位）。设计为无状态静态类：色盘「吸管」与后续 MCP 截图取色工具共用。
///
/// 性能关键：区域抓取必须单次块传输（本实现用 BitBlt→DIBSection）——逐点 GetPixel 每点都经
/// DWM 同步往返，225 点即数百毫秒，是吸管卡顿的根源。
/// 通道选择关键：不用 GDI+ CopyFromScreen——实测部分 DPI/驱动组合下它整块返黑，
/// 而 GetPixel/BitBlt 直连 GetDC(桌面) 的路径取色正确；两者坐标语义一致。
/// </summary>
public static class ScreenColorService
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    private static extern uint GetPixel(IntPtr hdc, int x, int y);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT p);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO bmi, uint usage,
        out IntPtr bits, IntPtr hSection, uint offset);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hObject);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(IntPtr hdcDest, int xDest, int yDest, int width, int height,
        IntPtr hdcSrc, int xSrc, int ySrc, uint rop);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;   // 负值 = 自上而下
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; }

    private const uint SRCCOPY = 0x00CC0020;
    private const uint CAPTUREBLT = 0x40000000;   // 含分层窗口；DWM 组合下缺它可能整块读空（黑图根因）
    private const uint DIB_RGB_COLORS = 0;

    /// <summary>最近一次区域抓取的诊断摘要（供排障落盘；每帧覆盖）。</summary>
    public static string DiagLast { get; private set; } = "";

    /// <summary>读取单个物理像素的颜色（仅适合低频调用，如确认点击）；失败返回 null。</summary>
    public static Color? PixelAtPhysical(int x, int y)
    {
        var dc = GetDC(IntPtr.Zero);
        try { return SampleDc(dc, x, y); }
        finally { _ = ReleaseDC(IntPtr.Zero, dc); }
    }

    /// <summary>当前光标位置（物理像素，与区域抓取同坐标系）；失败返回 null。</summary>
    public static (int X, int Y)? CursorPosition()
    {
        if (!GetCursorPos(out var p)) return null;
        return (p.X, p.Y);
    }

    /// <summary>
    /// 以 (cx, cy) 为中心抓取 (2*half+1)² 方块区域（放大镜实时跟色用）。
    /// 单次 BitBlt 写入 DIBSection，开销亚毫秒级。数组下标 [row, col]，row=0 为最上；
    /// 抓取失败返回 null。
    /// </summary>
    public static Color?[,]? RegionAtPhysical(int cx, int cy, int half)
    {
        if (half < 0) return null;
        var size = half * 2 + 1;

        var screen = GetDC(IntPtr.Zero);
        var mem = CreateCompatibleDC(screen);
        if (mem == IntPtr.Zero) { _ = ReleaseDC(IntPtr.Zero, screen); return null; }

        var bmi = new BITMAPINFO();
        bmi.bmiHeader = new BITMAPINFOHEADER
        {
            biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
            biWidth = size,
            biHeight = -size,          // top-down：第 0 行在最上，与调用方行序约定一致
            biPlanes = 1,
            biBitCount = 32,
            biCompression = 0,         // BI_RGB
        };
        var dib = CreateDIBSection(mem, ref bmi, DIB_RGB_COLORS, out var bits, IntPtr.Zero, 0);
        if (dib == IntPtr.Zero || bits == IntPtr.Zero)
        {
            _ = DeleteDC(mem);
            _ = ReleaseDC(IntPtr.Zero, screen);
            return null;
        }
        var oldObj = SelectObject(mem, dib);

        try
        {
            var ok = BitBlt(mem, 0, 0, size, size, screen, cx - half, cy - half, SRCCOPY | CAPTUREBLT);
            if (!ok)
            {
                DiagLast = $"{DateTime.Now:HH:mm:ss.fff} BitBlt=false c=({cx},{cy})";
                return null;
            }

            var stride = size * 4;
            var bytes = new byte[stride * size];
            Marshal.Copy(bits, bytes, 0, bytes.Length);

            var result = new Color?[size, size];
            byte maxCh = 0;
            for (var r = 0; r < size; r++)
                for (var c = 0; c < size; c++)
                {
                    var i = (r * size + c) * 4;   // 内存序 BGRA
                    result[r, c] = Color.FromRgb(bytes[i + 2], bytes[i + 1], bytes[i]);
                    if (maxCh < bytes[i] || maxCh < bytes[i + 1] || maxCh < bytes[i + 2])
                        maxCh = Math.Max(bytes[i], Math.Max(bytes[i + 1], bytes[i + 2]));
                }
            // 全零/近全零 = 典型"黑图"，记录中心 GetPixel 对照便于定位通道差异
            var gp = SampleDc(screen, cx, cy);
            DiagLast = $"{DateTime.Now:HH:mm:ss.fff} blit=ok c=({cx},{cy}) max={maxCh} " +
                       $"center={(result[half, half]?.ToString() ?? "null")} getPixelCenter={(gp?.ToString() ?? "null")}";
            return result;
        }
        finally
        {
            _ = SelectObject(mem, oldObj);
            _ = DeleteObject(dib);
            _ = DeleteDC(mem);
            _ = ReleaseDC(IntPtr.Zero, screen);
        }
    }

    private static Color? SampleDc(IntPtr dc, int x, int y)
    {
        // COLORREF = 0x00BBGGRR；0xFFFFFFFF 表示坐标不在显示区域
        var c = GetPixel(dc, x, y);
        return c == 0xFFFFFFFF
            ? null
            : Color.FromRgb((byte)(c & 0xFF), (byte)((c >> 8) & 0xFF), (byte)((c >> 16) & 0xFF));
    }
}
