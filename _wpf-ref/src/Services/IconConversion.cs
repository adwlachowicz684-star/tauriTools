using System;
using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 通用「任意受支持图片 → 多尺寸 .ico」转换器（PNG 压缩帧，16–256）。
/// 由 PresetIconService（预设库导入）与 FolderIconService（文件夹图标副本）共用，
/// 保证 PNG/JPG 等源文件真正转成合法 ICO，而不是改名了事。
/// 注意：RenderPng 依赖 DrawingVisual/RenderTargetBitmap，必须在 STA 线程调用。
/// </summary>
public static class IconConversion
{
    /// <summary>将任意受支持图片文件转成多尺寸 .ico 写到 target。成功返回 true。</summary>
    public static bool TryConvertToIco(string source, string target)
    {
        BitmapSource? src = DecodeImage(source);
        return src != null && TryConvertToIco(src, target);
    }

    /// <summary>将位图转成多尺寸 PNG 压缩的 .ico 写到 target。成功返回 true。</summary>
    public static bool TryConvertToIco(BitmapSource src, string target)
    {
        if (src == null || src.PixelWidth <= 0 || src.PixelHeight <= 0) return false;
        int[] sizes = { 16, 24, 32, 48, 64, 128, 256 };
        var frames = new List<(byte[] Png, int Size)>(sizes.Length);
        foreach (var s in sizes) frames.Add((RenderPng(src, s), s));
        var bytes = BuildIco(frames);
        try { File.WriteAllBytes(target, bytes); return true; }
        catch { return false; }
    }

    private static BitmapSource? DecodeImage(string path)
    {
        try
        {
            // 用字节流解码而非 new Uri(path)：文件名含 #/%/? 等 URI 元字符时 Uri 会错位解析导致加载失败
            using var fs = File.OpenRead(path);
            var bi = new BitmapImage();
            bi.BeginInit();
            bi.StreamSource = fs;
            bi.CacheOption = BitmapCacheOption.OnLoad;   // EndInit 即完成读入，随后可安全关闭流
            bi.CreateOptions = BitmapCreateOptions.IgnoreColorProfile | BitmapCreateOptions.PreservePixelFormat;
            bi.EndInit();
            bi.Freeze();
            return bi.PixelWidth > 0 && bi.PixelHeight > 0 ? bi : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>在 size×size 透明画布上按源图宽高等比缩放居中绘制，输出 PNG 字节。</summary>
    private static byte[] RenderPng(BitmapSource src, int size)
    {
        var dv = new DrawingVisual();
        using (var dc = dv.RenderOpen())
        {
            dc.DrawRectangle(Brushes.Transparent, null, new Rect(0, 0, size, size));
            var scale = Math.Min((double)size / src.PixelWidth, (double)size / src.PixelHeight);
            var dw = src.PixelWidth * scale;
            var dh = src.PixelHeight * scale;
            dc.DrawImage(src, new Rect((size - dw) / 2.0, (size - dh) / 2.0, dw, dh));
        }
        var rtb = new RenderTargetBitmap(size, size, 96, 96, PixelFormats.Pbgra32);
        rtb.Render(dv);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(rtb));
        using var ms = new MemoryStream();
        enc.Save(ms);
        return ms.ToArray();
    }

    /// <summary>将各尺寸 PNG 帧按 ICO 规范打包（PNG 压缩，size≥256 记 0 表示实际 256）。</summary>
    private static byte[] BuildIco(IReadOnlyList<(byte[] Png, int Size)> frames)
    {
        const int headerLen = 6;
        int entryLen = 16 * frames.Count;
        int offset = headerLen + entryLen;
        using var ms = new MemoryStream();
        using var bw = new BinaryWriter(ms);
        bw.Write((ushort)0);                       // reserved
        bw.Write((ushort)1);                       // type: icon
        bw.Write((ushort)frames.Count);            // count
        foreach (var (png, size) in frames)
        {
            byte encoded = (byte)(size >= 256 ? 0 : size);
            bw.Write(encoded);                     // width（0=256）
            bw.Write(encoded);                     // height（0=256）
            bw.Write((byte)0);                     // palette
            bw.Write((byte)0);                     // reserved
            bw.Write((ushort)1);                   // planes
            bw.Write((ushort)32);                  // bpp
            bw.Write((uint)png.Length);            // bytes in res
            bw.Write((uint)offset);                // image offset
            offset += png.Length;
        }
        foreach (var (png, _) in frames) bw.Write(png);
        return ms.ToArray();
    }
}
