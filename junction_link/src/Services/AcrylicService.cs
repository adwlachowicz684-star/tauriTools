using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 客户区 Acrylic 毛玻璃。对应 PS 版 SetWindowCompositionAttribute 方案
/// （Win11 22H2+ 用 SWCA Acrylic + 分层窗口；这里是干净的原生 P/Invoke 版，
/// 告别 PS 那套 SizeOf 重载陷阱）。
/// </summary>
public static class AcrylicService
{
    [StructLayout(LayoutKind.Sequential)]
    private struct AccentPolicy
    {
        public int AccentState;   // 4 = ACCENT_ENABLE_ACRYLICBLURBEHIND
        public int AccentFlags;   // 2 = draw all borders
        public int GradientColor; // ABGR
        public int AnimationId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowCompositionAttributeData
    {
        public int Attribute;     // 19 = WCA_ACCENT_POLICY
        public IntPtr Data;
        public IntPtr SizeOfData; // SIZE_T：64 位下 8 字节（对应 PS 版那个 SizeOf 陷阱）
    }

    [DllImport("user32.dll")]
    private static extern int SetWindowCompositionAttribute(
        IntPtr hwnd, ref WindowCompositionAttributeData data);

    /// <summary>给窗口应用 Acrylic tint。alpha 传 0–255，颜色传 (r,g,b)。</summary>
    public static bool ApplyAcrylic(Window win, byte alpha, byte r, byte g, byte b)
    {
        var hwnd = new WindowInteropHelper(win).Handle;
        if (hwnd == IntPtr.Zero) return false;

        // ABGR：alpha 在高 8 位（与 PS Win11 版本一致）
        var abgr = ((int)alpha << 24) | ((int)b << 16) | ((int)g << 8) | r;

        var policy = new AccentPolicy
        {
            AccentState = 4,
            AccentFlags = 2,
            GradientColor = abgr,
            AnimationId = 0,
        };

        // SizeOfData 必须为整个 AccentPolicy 的字节大小（4×int=16），
        // 传 IntPtr.Size 只拷贝前 8 字节 → GradientColor 读不到 → 毛玻璃颜色失效。
        var data = new WindowCompositionAttributeData
        {
            Attribute = 19,
            SizeOfData = Marshal.SizeOf<AccentPolicy>(),
        };

        IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf<AccentPolicy>());
        try
        {
            Marshal.StructureToPtr(policy, ptr, false);
            data.Data = ptr;
            return SetWindowCompositionAttribute(hwnd, ref data) != 0;
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
    }
}