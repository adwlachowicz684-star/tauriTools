using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 任务栏固定图标刷新。Windows 会把「固定到任务栏」的条目按固定那一刻缓存图标，
/// exe 图标改写后固定的那条不会自动更新。刷新方式 = 对固定的 .lnk 先删除再原样重建
/// 并广播 SHChangeNotify，让任务栏重新从 exe 提取图标（等价于 unpin→repin）。
/// 仅当目标 exe 原本已固定时才执行解→再固定；失败一律静默降级（不影响主流程）。
/// </summary>
public static class TaskbarPinner
{
    /// <summary>任务栏固定快捷方式目录（每项一个 .lnk）。</summary>
    private static string TaskbarPinsDir()
        => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");

    /// <summary>
    /// 刷新固定图标：定位指向目标 exe 的固定 .lnk，若存在则先删除再原样重建并通知 Shell，
    /// 强制任务栏重新提取新图标；未固定则不动作；任何异常吞掉返回 false（保持原状）。
    /// </summary>
    public static bool RefreshPinned(string exePath)
    {
        if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath)) return false;
        try
        {
            string? lnk = FindMatchingLnk(exePath);
            if (lnk == null) return true;
            byte[] backup = File.ReadAllBytes(lnk);

            File.Delete(lnk);
            Notify(TaskbarPinsDir());
            Thread.Sleep(1000);

            File.WriteAllBytes(lnk, backup);
            Notify(TaskbarPinsDir());
            Thread.Sleep(800);

            // 重建失败则还原，保证固定项不被弄丢
            if (!File.Exists(lnk))
            {
                File.WriteAllBytes(lnk, backup);
                Notify(TaskbarPinsDir());
                return false;
            }
            return true;
        }
        catch { return false; }
    }

    /// <summary>在固定目录中定位目标指向 exe 的 .lnk；找不到返回 null。</summary>
    private static string? FindMatchingLnk(string exePath)
    {
        try
        {
            var dir = TaskbarPinsDir();
            if (!Directory.Exists(dir)) return null;
            foreach (var lnk in Directory.GetFiles(dir, "*.lnk"))
                if (ShortcutTargetMatches(lnk, exePath)) return lnk;
            return null;
        }
        catch { return null; }
    }

    /// <summary>
    /// 读取 .lnk 的目标路径并比对 exe。必须先 IPersistFile.Load 把 lnk 加载进 ShellLink 实例，
    /// 否则 GetPath 返回空；fFlags 取 0（长路径），0x1 是 SLGP_SHORTPATH 会返回 8.3 短名导致比对失败。
    /// </summary>
    private static bool ShortcutTargetMatches(string lnkPath, string exePath)
    {
        try
        {
            var link = (IShellLinkW)(object)new ShellLink();
            try
            {
                ((IPersistFile)link).Load(lnkPath, 0 /*STGM_READ*/);
                var buf = new StringBuilder(1024);
                link.GetPath(buf, buf.Capacity, IntPtr.Zero, 0);
                return string.Equals(Path.TrimEndingDirectorySeparator(buf.ToString()),
                    Path.TrimEndingDirectorySeparator(exePath), StringComparison.OrdinalIgnoreCase);
            }
            finally { Marshal.FinalReleaseComObject(link); }
        }
        catch { return false; }
    }

    /// <summary>向 Shell 广播目录变更（含图标缓存失效），促使任务栏重读固定项。</summary>
    private static void Notify(string dir)
    {
        IntPtr pidl = ILCreateFromPath(dir);
        try
        {
            if (pidl != IntPtr.Zero)
            {
                SHChangeNotify(0x00008010 /*SHCNE_UPDATEDIR*/, 0x0000 /*SHCNF_IDLIST*/, pidl, IntPtr.Zero);
            }
            SHChangeNotify(0x00000002 /*SHCNE_ASSOCCHANGED*/, 0x1000 /*SHCNF_FLUSH*/, IntPtr.Zero, IntPtr.Zero);
        }
        finally { if (pidl != IntPtr.Zero) ILFree(pidl); }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink
    {
    }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPersistFile
    {
        [PreserveSig] int GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        [PreserveSig] int GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr ILCreateFromPath(string pszPath);

    [DllImport("shell32.dll")]
    private static extern void ILFree(IntPtr pidl);
}