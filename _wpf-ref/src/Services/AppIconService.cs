using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 软件自身图标（窗口标题栏 / 任务栏 / 托盘 / exe 文件图标）自定义服务。
/// 图片文件统一转成多尺寸 .ico 存入「数据\appicon\」并由 config.customAppIcon 记录；
/// 默认/用户图标的运行时加载由 MainWindow 统一走 <see cref="LoadAppIcon"/>。
/// </summary>
public static class AppIconService
{
    /// <summary>自定义图标文件名（位于数据目录下 AppIconDir()）。</summary>
    public const string CustomIcoName = "custom-app.ico";

    /// <summary>自定义图标存储目录：数据目录\appicon。</summary>
    public static string AppIconDir(string dataDir)
        => Path.Combine(dataDir, "appicon");

    /// <summary>自定义图标完整路径（无论是否存在都返回该路径）。</summary>
    public static string CustomIcoPath(string dataDir)
        => Path.Combine(AppIconDir(dataDir), CustomIcoName);

    /// <summary>
    /// 生成当前软件图标（默认或用户自定义，取决于 config.CustomAppIcon 是否非空且文件存在）。
    /// 返回已 Freeze、可跨线程使用的 BitmapFrame（取 .ico 内面积最大帧），失败回退 null。
    /// </summary>
    public static ImageSource? LoadAppIcon(string dataDir, string? customAppIcon)
    {
        var custom = !string.IsNullOrEmpty(customAppIcon) ? customAppIcon : null;
        if (custom != null && File.Exists(custom))
        {
            var f = LoadIconFrame(custom);
            if (f != null) return f;
        }
        return LoadIconFrame("tray.ico");
    }

    /// <summary>加载 .ico 内面积最大的一帧；失败返回 null（含嵌入资源同名回退）。</summary>
    private static ImageSource? LoadIconFrame(string icoPathOrResource)
    {
        try
        {
            // 优先按文件路径读；相对名（如 "tray.ico"）走程序集嵌入资源
            if (File.Exists(icoPathOrResource))
            {
                using var fs = File.OpenRead(icoPathOrResource);
                return DecodeFrame(fs);
            }

            var asm = System.Reflection.Assembly.GetExecutingAssembly();
            var name = asm.GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith(icoPathOrResource, StringComparison.OrdinalIgnoreCase));
            if (name == null) return null;
            using var rs = asm.GetManifestResourceStream(name);
            if (rs == null) return null;
            return DecodeFrame(rs);
        }
        catch
        {
            return null;
        }
    }

    private static ImageSource? DecodeFrame(Stream s)
    {
        var dec = BitmapDecoder.Create(s, BitmapCreateOptions.DelayCreation
            | BitmapCreateOptions.IgnoreColorProfile, BitmapCacheOption.OnLoad);
        BitmapFrame? best = null;
        foreach (var fr in dec.Frames)
        {
            if (best == null
                || (long)fr.PixelWidth * fr.PixelHeight > (long)best.PixelWidth * best.PixelHeight)
                best = fr;
        }
        best?.Freeze();
        return best;
    }

    /// <summary>加载任意图片文件的预览图像（.ico 取面积最大帧，png/jpg 等取首帧）；不存在或失败返回 null。返回帧已 Freeze。</summary>
    public static ImageSource? LoadImageSource(string path)
    {
        try { return File.Exists(path) ? LoadIconFrame(path) : null; }
        catch { return null; }
    }

    /// <summary>把用户选择的图片（文件或剪贴板位图）转成多尺寸 .ico 存入数据目录并返回路径；失败返回 null。</summary>
    public static string? SaveCustomIcon(string dataDir, BitmapSource? image, string? imageFile)
    {
        try
        {
            var dir = AppIconDir(dataDir);
            Directory.CreateDirectory(dir);
            var target = CustomIcoPath(dataDir);
            bool ok;
            if (image != null)
                ok = IconConversion.TryConvertToIco(image, target);
            else if (!string.IsNullOrEmpty(imageFile))
                ok = IconConversion.TryConvertToIco(imageFile, target);
            else
                return null;
            return ok && File.Exists(target) ? target : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>是否受支持的输入图片文件扩展名（.ico / png / jpg / jpeg / bmp / gif）。</summary>
    public static bool IsSupportedFile(string path)
    {
        var ext = Path.GetExtension(path);
        return ext.Equals(".ico", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".png", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".jpg", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".jpeg", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".bmp", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".gif", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>删除自定义图标文件（恢复默认时清理磁盘残留）。</summary>
    public static void DeleteCustomIcon(string dataDir)
    {
        try { if (File.Exists(CustomIcoPath(dataDir))) File.Delete(CustomIcoPath(dataDir)); } catch { }
    }

    /// <summary>
    /// 把 .ico 作为「主图标组」写入目标 exe 的 PE 资源（即资源管理器中显示的 exe 图标）。
    /// 要求目标 exe 当前未被任何进程锁定。成功返回 true。基于 UpdateResource 内核 API。
    /// </summary>
    public static bool UpdateExeIcon(string exePath, string icoPath)
    {
        try
        {
            if (!File.Exists(exePath) || !File.Exists(icoPath)) return false;
            var ico = File.ReadAllBytes(icoPath);
            int count = ico[4] | (ico[5] << 8);
            if (count == 0 || ico.Length < 6 + count * 16) return false;

            // 解析每帧（ICONDIRENTRY，little-endian）
            var frames = new (int Size, byte[] Data)[count];
            for (int i = 0; i < count; i++)
            {
                int b = 6 + i * 16;
                int size = ico[b + 8] | (ico[b + 9] << 8) | (ico[b + 10] << 16) | (ico[b + 11] << 24);
                int off = ico[b + 12] | (ico[b + 13] << 8) | (ico[b + 14] << 16) | (ico[b + 15] << 24);
                if (off < 0 || size <= 0 || off + size > ico.Length) return false;
                frames[i] = (size, ico[off..(off + size)]);
            }

            // 构造 GRPICONDIR（RT_GROUP_ICON 数据）
            using var gm = new MemoryStream();
            WriteU16(gm, 0);          // reserved
            WriteU16(gm, 1);          // type = icon
            WriteU16(gm, (ushort)count);
            for (int i = 0; i < count; i++)
            {
                int b = 6 + i * 16;
                for (int k = 0; k < 8; k++) gm.WriteByte(ico[b + k]); // width..bitcount
                WriteI32(gm, frames[i].Size);                          // bytesInRes
                WriteU16(gm, (ushort)(i + 1));                         // nID
            }
            var groupBytes = gm.ToArray();

            var h = Native.BeginUpdateResource(exePath, false);
            if (h == IntPtr.Zero) return false;
            for (int i = 0; i < count; i++)
            {
                if (!Native.UpdateResource(h, Native.RT_ICON, new IntPtr(i + 1), 0, frames[i].Data, (uint)frames[i].Data.Length))
                {
                    Native.EndUpdateResource(h, true);
                    return false;
                }
            }
            if (!Native.UpdateResource(h, Native.RT_GROUP_ICON, new IntPtr(1), 0, groupBytes, (uint)groupBytes.Length))
            {
                Native.EndUpdateResource(h, true);
                return false;
            }
            if (!Native.EndUpdateResource(h, false)) return false;

            // PE 校验和：仅当原 exe 已设非零校验和时重算写回，避免加载器因校验不符异常
            try
            {
                if (PeCheckSum(exePath) != 0
                    && Native.MapFileAndCheckSum(exePath, out _, out uint sum) == 0 && sum != 0)
                {
                    WritePeCheckSum(exePath, sum);
                }
            }
            catch { /* 校验和更新失败不阻断图标写入 */ }

            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>读 PE optional header 的 CheckSum 字段；失败返回 0。</summary>
    private static uint PeCheckSum(string file)
    {
        using var fs = File.OpenRead(file);
        using var r = new BinaryReader(fs);
        if (fs.Length < 0x40) return 0;
        fs.Seek(0x3C, SeekOrigin.Begin);
        int pe = r.ReadInt32();                       // e_lfanew
        long cs = (long)pe + 24 + 0x40;               // NT headers + optional + CheckSum(offset 0x40)
        if (cs < 0 || cs + 4 > fs.Length) return 0;
        fs.Seek(cs, SeekOrigin.Begin);
        return r.ReadUInt32();
    }

    /// <summary>回写 PE optional header 的 CheckSum 字段。</summary>
    private static void WritePeCheckSum(string file, uint sum)
    {
        using var fs = File.Open(file, FileMode.Open, FileAccess.ReadWrite);
        using var r = new BinaryReader(fs);
        if (fs.Length < 0x40) return;
        fs.Seek(0x3C, SeekOrigin.Begin);
        int pe = r.ReadInt32();
        long cs = (long)pe + 24 + 0x40;
        if (cs < 0 || cs + 4 > fs.Length) return;
        fs.Seek(cs, SeekOrigin.Begin);
        var w = new BinaryWriter(fs);
        w.Write(sum);
        w.Flush();
    }

    /// <summary>修改 exe 图标后刷新系统图标缓存与关联图标（尽力而为，任务栏固定项可能仍需要手动刷新）。</summary>
    public static void RefreshShellIcons()
    {
        try
        {
            Native.SHChangeNotify(0x08000000 /*SHCNE_ASSOCCHANGED*/, 0x0000 /*SHCNF_IDLIST*/, IntPtr.Zero, IntPtr.Zero);
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Microsoft", "Windows", "Explorer");
            if (Directory.Exists(dir))
            {
                foreach (var f in Directory.GetFiles(dir, "iconcache_*"))
                {
                    try { File.Delete(f); } catch { }
                }
            }
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ie4uinit.exe", "-show") { UseShellExecute = false }); } catch { }
        }
        catch { }
    }

    private static void WriteU16(Stream s, ushort v) { s.WriteByte((byte)v); s.WriteByte((byte)(v >> 8)); }
    private static void WriteI32(Stream s, int v) { s.WriteByte((byte)v); s.WriteByte((byte)(v >> 8)); s.WriteByte((byte)(v >> 16)); s.WriteByte((byte)(v >> 24)); }

    // ---------- exe 文件图标：复用主程序副本作后台助手 ----------
    // 运行中的 exe 被系统锁定无法改写自身。应用 exe 图标 = 把含当前 exe 的启动目录复制一份到临时目录，
    // 从副本以 --appicon-apply 后台模式启动（同文件不同物理路径，不受主程序锁定影响），
    // 等主程序退出、目标 exe 解锁后改写 RT_GROUP_ICON/RT_ICON、刷新缓存、再重启主程序。

    /// <summary>
    /// 把当前启动目录（exe + 运行所需 dll/config）复制到固定临时目录，返回临时副本 exe 路径；失败返回 null。
    /// 固定目录每次复制前清空，避免上次残留；不删除自身（Windows 临时目录，下次复制自动清理）。
    /// </summary>
    public static string? StageHelperCopy()
    {
        try
        {
            var srcDir = AppContext.BaseDirectory;
            var exeName = Path.GetFileName(Process.GetCurrentProcess().MainModule?.FileName ?? "");
            if (string.IsNullOrEmpty(exeName) || !Directory.Exists(srcDir)) return null;
            var tmpRoot = Path.Combine(Path.GetTempPath(), "fpx_appicon_helper");
            Directory.CreateDirectory(tmpRoot);
            foreach (var f in Directory.GetFiles(tmpRoot)) { try { File.Delete(f); } catch { } }
            foreach (var f in Directory.GetFiles(srcDir, "*", SearchOption.TopDirectoryOnly))
            {
                var ext = Path.GetExtension(f).ToLowerInvariant();
                if (ext is ".exe" or ".dll" or ".json" or ".config" or ".pdb")
                {
                    try { File.Copy(f, Path.Combine(tmpRoot, Path.GetFileName(f)), true); } catch { }
                }
            }
            var helper = Path.Combine(tmpRoot, exeName);
            return File.Exists(helper) ? helper : null;
        }
        catch { return null; }
    }

    /// <summary>把程序集内嵌默认图标（tray.ico）写入临时文件并返回路径，供「恢复默认」时作为 exe 目标图标；失败返回 null。</summary>
    public static string? ExtractDefaultIconFile()
    {
        try
        {
            var asm = System.Reflection.Assembly.GetExecutingAssembly();
            var name = asm.GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith("tray.ico", StringComparison.OrdinalIgnoreCase));
            if (name == null) return null;
            using var rs = asm.GetManifestResourceStream(name);
            if (rs == null) return null;
            var path = Path.Combine(Path.GetTempPath(), "fpx_default-app.ico");
            using var fs = File.Create(path);
            rs.CopyTo(fs);
            fs.Flush();
            return File.Exists(path) ? path : null;
        }
        catch { return null; }
    }

    /// <summary>
    /// 后台助手主逻辑（--appicon-apply）：等待发起主进程退出（释放目标 exe 文件锁）→ 改写图标 → 刷新缓存 → 重启主程序。
    /// 返回进程退出码（0=成功，1=失败，2=异常）。
    /// </summary>
    public static int ApplyExeIconAwait(string targetExe, string iconPath, int waitPid)
    {
        int rc = 1;
        try
        {
            if (waitPid > 0)
            {
                try { using var p = Process.GetProcessById(waitPid); p.WaitForExit(); }
                catch { /* 发起进程已退出：无需等待 */ }
            }
            Thread.Sleep(500);   // 等文件句柄彻底释放
            bool ok = !string.IsNullOrEmpty(targetExe) && File.Exists(targetExe)
                && !string.IsNullOrEmpty(iconPath) && File.Exists(iconPath)
                && UpdateExeIcon(targetExe, iconPath);
            if (ok)
            {
                RefreshShellIcons();
                try { TaskbarPinner.RefreshPinned(targetExe); } catch { /* 固定图标刷新失败不阻断流程 */ }
            }
            rc = ok ? 0 : 1;
            if (!string.IsNullOrEmpty(targetExe) && File.Exists(targetExe))
            {
                try { Process.Start(new ProcessStartInfo(targetExe) { UseShellExecute = true }); } catch { }
            }
            return rc;
        }
        catch
        {
            return 2;
        }
    }

    private static class Native
    {
        public static readonly IntPtr RT_ICON = new IntPtr(3);
        public static readonly IntPtr RT_GROUP_ICON = new IntPtr(14);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName,
            ushort wLanguage, [In] byte[] lpData, uint cbData);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
        [DllImport("imagehlp.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern uint MapFileAndCheckSum(string Filename, out uint HeaderSum, out uint CheckSum);
        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);
    }
}
