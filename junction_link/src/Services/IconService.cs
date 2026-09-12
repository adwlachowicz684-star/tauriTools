using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;            // Int32Rect
using System.Windows.Interop;   // Imaging.CreateBitmapSourceFromHIcon
using System.Windows.Media;
using System.Windows.Media.Imaging; // BitmapSizeOptions

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 系统文件夹/文件图标服务。封装 SHGetFileInfo（含 ShellFileInfo 结构），
/// 并带按扩展名/路径的缓存——对应 PS 版 Get-CachedFileIcon/Get-CachedFolderIcon。
/// 缓存用 ConcurrentDictionary（允许后台线程访问），加载结果一律 Freeze（跨线程可用）。
/// </summary>
public sealed class IconService
{
    private readonly ConcurrentDictionary<string, ImageSource> _fileCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, ImageSource> _folderCache = new(StringComparer.OrdinalIgnoreCase);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ShellFileInfo
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes,
        ref ShellFileInfo psfi, uint cbFileInfo, uint uFlags);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern uint ExtractIconEx(string lpszFile, int nIconIndex,
        IntPtr[]? phiconLarge, IntPtr[]? phiconSmall, uint nIcons);

    private const uint SHGFI_ICON = 0x100;
    private const uint SHGFI_LARGEICON = 0x0;
    private const uint SHGFI_USEFILEATTRIBUTES = 0x10;

    /// <summary>取某扩展名文件的图标（按扩展名缓存，性能友好，对应 PS 缓存策略）。</summary>
    public ImageSource? GetFileIcon(string path)
    {
        var ext = Path.GetExtension(path);
        if (string.IsNullOrEmpty(ext)) ext = ".md";
        if (_fileCache.TryGetValue(ext, out var hit)) return hit;
        var icon = Load(path, isFolder: false);
        if (icon != null) _fileCache[ext] = icon;
        return icon;
    }

    /// <summary>取某目录的图标（按路径缓存，性能友好）。</summary>
    public ImageSource? GetFolderIcon(string path)
    {
        if (_folderCache.TryGetValue(path, out var hit)) return hit;
        var icon = Load(path, isFolder: true);
        if (icon != null) _folderCache[path] = icon;
        return icon;
    }

    /// <summary>清除某目录的图标缓存，令下次 GetFolderIcon 重新向 Shell 提取（图标变更后调用）。</summary>
    public void InvalidateFolder(string path)
    {
        _folderCache.TryRemove(path, out _);
    }

    /// <summary>
    /// 从自定义图标引用（.ico 文件，或 DLL/EXE 指定索引）直接加载 ImageSource。
    /// 不受 Shell 图标缓存影响——用于展示 desktop.ini 刚写入的自定义图标。
    /// </summary>
    public static ImageSource? LoadCustomIcon(string sourcePath, int iconIndex)
    {
        if (string.IsNullOrWhiteSpace(sourcePath)) return null;
        try
        {
            var ext = Path.GetExtension(sourcePath);
            if (string.Equals(ext, ".ico", StringComparison.OrdinalIgnoreCase)
                || string.Equals(ext, ".png", StringComparison.OrdinalIgnoreCase)
                || string.Equals(ext, ".bmp", StringComparison.OrdinalIgnoreCase)
                || string.Equals(ext, ".jpg", StringComparison.OrdinalIgnoreCase)
                || string.Equals(ext, ".jpeg", StringComparison.OrdinalIgnoreCase)
                || string.Equals(ext, ".gif", StringComparison.OrdinalIgnoreCase))
            {
                if (!File.Exists(sourcePath)) return null;
                using var fs = File.OpenRead(sourcePath);
                var dec = BitmapDecoder.Create(fs, BitmapCreateOptions.DelayCreation
                    | BitmapCreateOptions.IgnoreColorProfile, BitmapCacheOption.OnLoad);
                BitmapFrame? best = null;
                foreach (var fr in dec.Frames)
                    if (best == null
                        || (long)fr.PixelWidth * fr.PixelHeight > (long)best.PixelWidth * best.PixelHeight)
                        best = fr;
                var img = (best ?? dec.Frames[0]);
                img.Freeze();
                return img;
            }

            // DLL/EXE：取指定索引的大图标
            var hicon = IntPtr.Zero;
            if (iconIndex < 0) iconIndex = 0;
            try { hicon = GetIconHandle(sourcePath, iconIndex); } catch { }
            if (hicon == IntPtr.Zero) return null;
            try
            {
                var i = System.Windows.Interop.Imaging.CreateBitmapSourceFromHIcon(hicon,
                    Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
                i.Freeze();
                return i;
            }
            finally
            {
                DestroyIcon(hicon);
            }
        }
        catch
        {
            return null;
        }
    }

    private static IntPtr GetIconHandle(string dllPath, int index)
    {
        var ptrs = new IntPtr[1];
        uint n = ExtractIconEx(dllPath, index, ptrs, null, 1);
        return n > 0 ? ptrs[0] : IntPtr.Zero;
    }

    private static ImageSource? Load(string path, bool isFolder)
    {
        var psfi = default(ShellFileInfo);
        var flags = SHGFI_ICON | SHGFI_LARGEICON;
        if (!isFolder) flags |= SHGFI_USEFILEATTRIBUTES; // 文件可不存在，仅按扩展名取
        var ret = SHGetFileInfo(path, 0, ref psfi, (uint)Marshal.SizeOf<ShellFileInfo>(), flags);
        if (ret == IntPtr.Zero || psfi.hIcon == IntPtr.Zero) return null;
        try
        {
            var img = Imaging.CreateBitmapSourceFromHIcon(psfi.hIcon, Int32Rect.Empty,
                BitmapSizeOptions.FromEmptyOptions());
            img.Freeze();   // 冻结：缓存可能被后台线程读取，未冻结的 Freezable 有线程亲和性
            return img;
        }
        finally
        {
            DestroyIcon(psfi.hIcon);
        }
    }

    /// <summary>获取 DLL/EXE 中包含的图标总数（nIconIndex=-1 调用）。失败返回 0。</summary>
    public int GetDllIconCount(string dllPath)
    {
        try
        {
            return (int)ExtractIconEx(dllPath, -1, null, null, 0);
        }
        catch
        {
            return 0;
        }
    }

    /// <summary>
    /// 从 DLL/EXE 中提取一批大图标，返回 (图标索引, ImageSource) 列表。
    /// 每个 HICON 在转换为 ImageSource 后立即 DestroyIcon，调用方无需释放。
    /// </summary>
    public List<(int Index, ImageSource? Icon)> ExtractDllIcons(string dllPath, int startIndex, int count)
    {
        var result = new List<(int Index, ImageSource? Icon)>();
        if (count <= 0) return result;

        var largeIcons = new IntPtr[count];
        for (var i = 0; i < count; i++) largeIcons[i] = IntPtr.Zero;

        uint extracted;
        try
        {
            extracted = ExtractIconEx(dllPath, startIndex, largeIcons, null, (uint)count);
        }
        catch
        {
            return result;
        }

        for (var i = 0; i < (int)extracted; i++)
        {
            if (largeIcons[i] == IntPtr.Zero) continue;
            try
            {
                var img = Imaging.CreateBitmapSourceFromHIcon(largeIcons[i],
                    Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
                img.Freeze();
                result.Add((startIndex + i, img));
            }
            catch
            {
                result.Add((startIndex + i, null));
            }
            finally
            {
                DestroyIcon(largeIcons[i]);
            }
        }
        return result;
    }
}