using System.IO;
using System.Linq;
using System.Reflection;

namespace KityMinderPlugin;

/// <summary>
/// kityminder 离线 Web 资产。资源以内嵌资源（嵌入本程序集）携带，
/// 运行时整份释放到「版本号命名的临时子目录」后返回路径，供虚拟主机映射同源加载。
/// 版本号参与子目录名：升级库后自动换新目录，避免旧缓存复用。
/// </summary>
internal static class PluginAssets
{
    /// <summary>kityminder 页面虚拟主机名。用永不解析的 .example 后缀，
    /// 避免真实 DNS 对每个请求附加延迟（同源运行，file:// 会被 CORS 拦动态资源）。</summary>
    public const string VirtualHost = "kityminder.example";

    /// <summary>内嵌资源逻辑名前缀（与 csproj 的 LogicalName 一致）。</summary>
    private const string Prefix = "kityminder.";

    /// <summary>资源版本：参与释放目录名；配合下方“内容比对、不一致即重写”逻辑，资源改动后下次运行自动生效。</summary>
    public const string Version = "1.0.1";

    private static string? _dir;

    /// <summary>释放内嵌资产到临时目录并返回目录路径（线程安全，幂等）。</summary>
    public static string EnsureExtractedFolder()
    {
        if (_dir is not null && Directory.Exists(_dir)) return _dir;

        var asm = Assembly.GetExecutingAssembly();
        var names = asm.GetManifestResourceNames()
                       .Where(n => n.StartsWith(Prefix, StringComparison.Ordinal))
                       .OrderBy(n => n, StringComparer.Ordinal)
                       .ToArray();
        if (names.Length == 0)
            throw new InvalidOperationException("KityMinderPlugin 程序集未找到内嵌的 kityminder Web 资源。");

        var folder = Path.Combine(Path.GetTempPath(), "KityMinderPlugin", Version);
        Directory.CreateDirectory(folder);
        foreach (var full in names)
        {
            var file = Path.Combine(folder, full.Substring(Prefix.Length));
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            // 逐字节比对内嵌资源与磁盘文件：不一致（源码资源被改动重新编译）即重写，
            // 避免沿用旧版本号目录里首次释放的过期文件导致宿主仍跑旧页面。
            var fresh = ReadResourceBytes(asm, full);
            if (!File.Exists(file) || !fresh.SequenceEqual(File.ReadAllBytes(file)))
                File.WriteAllBytes(file, fresh);
        }

        _dir = folder;
        return folder;
    }

    private static byte[] ReadResourceBytes(Assembly asm, string name)
    {
        using var s = asm.GetManifestResourceStream(name)
                     ?? throw new InvalidOperationException("无法读取内嵌资源：" + name);
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }
}