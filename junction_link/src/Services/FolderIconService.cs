using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 文件夹"自定义图标"服务。对应 PS 版的 Set-FolderCustomIcon / Restore-FolderDefaultIcon。
/// 实现机制：在目标文件夹写入 desktop.ini（含 [.ShellClassInfo] + IconResource=...），
/// 并为该文件夹及 desktop.ini 设置隐藏 + 系统属性，令资源管理器据此渲染自定义图标。
/// 所有方法均捕获异常、返回安全值，绝不抛异常导致界面崩溃。
/// </summary>
public static class FolderIconService
{
    // 副本目录固定名，保证 desktop.ini 里写入的路径稳定可复现（ASCII，规避中文/空格编码坑）。
    private const string CacheSubDir = "FenPeiXiangMuZu\\foldericons";
    private const string DesktopIniName = "desktop.ini";

    // ---- Shell 图标缓存刷新 ----
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern void SHChangeNotify(int wEventId, uint uFlags,
        [MarshalAs(UnmanagedType.LPWStr)] string? dwItem1, IntPtr dwItem2);

    private const int SHCNE_ASSOCCHANGED = 0x08000000;
    private const int SHCNE_UPDATEDIR = 0x00001000;
    private const int SHCNE_UPDATEITEM = 0x00002000;
    private const uint SHCNF_IDLIST = 0x0000;
    private const uint SHCNF_PATHW = 0x0005;   // 路径字符串（Unicode）
    private const uint SHCNF_FLUSH = 0x1000;
    private const uint SHCNF_FLUSHNOWAIT = 0x2000;

    // ---- 官方自定义文件夹图标 API（SHGetSetFolderCustomSettings，Vista+） ----
    // 结构布局来自 WinSDK shlobj_core.h（pshpack8，x64 下 8 字节对齐），字段顺序勿动。
    [StructLayout(LayoutKind.Sequential, Pack = 8, CharSet = CharSet.Unicode)]
    private struct SHFolderCustomSettings
    {
        public uint dwSize;
        public uint dwMask;
        public IntPtr pvid;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszWebViewTemplate;
        public uint cchWebViewTemplate;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszWebViewTemplateVersion;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszInfoTip;
        public uint cchInfoTip;
        public IntPtr pclsid;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pszIconFile;
        public uint cchIconFile;
        public int iIconIndex;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszLogo;
        public uint cchLogo;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetSetFolderCustomSettings(ref SHFolderCustomSettings pfcs,
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath, uint dwReadWrite);

    private const uint FCSM_ICONFILE = 0x00000010;
    private const uint FCS_FORCEWRITE = 0x00000002;

    /// <summary>通知 Shell 某文件夹图标已变更，令 SHGetFileInfo 与资源管理器重新提取图标。</summary>
    private static void NotifyShellIconChanged(string folderPath)
    {
        try
        {
            // 1) 丢弃外壳对该目录的解析缓存并重读 desktop.ini（"文件夹→图标位置"缓存失效的关键）
            SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW | SHCNF_FLUSH, folderPath, IntPtr.Zero);
            // 2) 精准刷新文件夹自身显示项（对新增/修改/删除 desktop.ini 均即时生效）
            SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSH, folderPath, IntPtr.Zero);
            // 3) 全局关联刷新兜底（清理图像级缓存）
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, null, IntPtr.Zero);
        }
        catch { /* 刷新失败静默，图标延迟更新但不会崩溃 */ }
    }

    /// <summary>
    /// 全局统一副本目录：%LOCALAPPDATA%\FenPeiXiangMuZu\foldericons。
    /// 拷贝到此处可避免把图标副本散落在目标文件夹旁，也不必改动工程根。
    /// </summary>
    private static string IconCacheDir()
    {
        var baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var dir = Path.Combine(baseDir, CacheSubDir);
        return dir;
    }

    /// <summary>
    /// 为目标文件夹设置自定义图标。
    /// 经 ACL 解锁窗口执行：目标被「ACL 锁定·只读保护」时临时摘锁写 desktop.ini 再恢复，
    /// 避免工具被自己的防写入档拦截。
    /// </summary>
    /// <param name="folderPath">目标文件夹绝对路径（文件夹须存在）。</param>
    /// <param name="iconFile">图标文件绝对路径（.ico/.png/.bmp/.jpg 等）。为空返回 null。</param>
    /// <returns>成功返回写入的 desktop.ini 绝对路径；失败返回 null（不抛异常）。</returns>
    public static string? SetCustomIcon(string folderPath, string? iconFile)
        => FolderLockService.WithUnlock(folderPath, () => SetCustomIconCore(folderPath, iconFile));

    private static string? SetCustomIconCore(string folderPath, string? iconFile)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(folderPath) || string.IsNullOrWhiteSpace(iconFile))
                return null;
            if (!Directory.Exists(folderPath))
                return null;
            if (!File.Exists(iconFile))
                return null;

            var iconPath = CopyIconToCache(iconFile);
            if (iconPath == null)
                return null;

            // 首选官方 API：内部自行维护 desktop.ini 与外壳解析缓存，二次换图标可即时生效；
            // 失败时回退直写 desktop.ini（老系统/受限环境兜底）。
            if (!SetIconViaShell(folderPath, iconPath, 0))
            {
                var fallback = WriteDesktopIni(folderPath, iconPath);
                if (fallback == null)
                    return null;
            }

            var iniPath = Path.Combine(folderPath, DesktopIniName);

            // desktop.ini 需隐藏 + 系统属性；所在目录也要 +s（系统文件夹），否则外壳不读取。
            // 注意：文件夹只加 +s 不加 +h，加 h 会让文件夹本身在资源管理器中被隐藏。
            ApplyAttrib(iniPath, "+h +s +a");
            ApplyAttrib(folderPath, "+s");

            NotifyShellIconChanged(folderPath);

            return iniPath;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 为目标文件夹设置来自 DLL 的系统图标（如 SHELL32.dll 中的图标）。
    /// 不复制文件，直接在 desktop.ini 中引用 DLL 路径 + 图标索引。
    /// 经 ACL 解锁窗口执行（同 SetCustomIcon）。
    /// </summary>
    /// <param name="folderPath">目标文件夹绝对路径。</param>
    /// <param name="dllPath">DLL/EXE 绝对路径（如 C:\Windows\System32\SHELL32.dll）。</param>
    /// <param name="iconIndex">DLL 内的图标索引。</param>
    /// <returns>成功返回 desktop.ini 绝对路径；失败返回 null。</returns>
    public static string? SetCustomIconFromDll(string folderPath, string? dllPath, int iconIndex)
        => FolderLockService.WithUnlock(folderPath, () => SetCustomIconFromDllCore(folderPath, dllPath, iconIndex));

    private static string? SetCustomIconFromDllCore(string folderPath, string? dllPath, int iconIndex)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(folderPath) || string.IsNullOrWhiteSpace(dllPath))
                return null;
            if (!Directory.Exists(folderPath))
                return null;
            if (!File.Exists(dllPath))
                return null;

            // 首选官方 API（同 SetCustomIcon）；失败回退直写。
            if (!SetIconViaShell(folderPath, dllPath, iconIndex))
            {
                var fallback = WriteDesktopIni(folderPath, dllPath, iconIndex);
                if (fallback == null) return null;
            }

            var iniPath = Path.Combine(folderPath, DesktopIniName);
            ApplyAttrib(iniPath, "+h +s +a");
            ApplyAttrib(folderPath, "+s");

            NotifyShellIconChanged(folderPath);

            return iniPath;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 移除目标文件夹的自定义图标（恢复系统默认）。经 ACL 解锁窗口执行（同 SetCustomIcon）。
    /// </summary>
    /// <param name="folderPath">目标文件夹绝对路径。</param>
    /// <param name="removeSystemAttrib">是否去除文件夹的 System 属性：仅当标记显示 +s 是本工具所加时传 true，
    /// 避免误清文件夹原有的 System 属性（调用方据 config.systemAttribByTool 决定）。</param>
    /// <returns>是否发生了变更（原本有自定义图标被清除）。</returns>
    public static bool RestoreDefaultIcon(string folderPath, bool removeSystemAttrib = true)
        => FolderLockService.WithUnlock(folderPath, () => RestoreDefaultIconCore(folderPath, removeSystemAttrib));

    private static bool RestoreDefaultIconCore(string folderPath, bool removeSystemAttrib)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(folderPath))
                return false;

            var iniPath = Path.Combine(folderPath, DesktopIniName);
            if (!File.Exists(iniPath))
                return false;

            var text = ReadDesktopIniText(iniPath);
            if (text == null) return false;   // 读取失败：保守不动文件，避免基于空文本误删
            var kept = RemoveIconResourceLines(text);

            // 若桌面配置已空（只剩空行），直接删除 desktop.ini；System 属性仅在"确系本工具所加"时还原。
            if (string.IsNullOrWhiteSpace(kept))
            {
                File.Delete(iniPath);
                if (removeSystemAttrib)
                    ApplyAttrib(folderPath, "-s");   // 本工具设置图标时给文件夹加了 +s，恢复默认时一并还原
                NotifyShellIconChanged(folderPath);
                return true;
            }

            // 还有其它配置（如 [LocalizedFileNames]），写回但去掉图标行。
            if (string.Equals(kept, text, StringComparison.Ordinal))
                return false;

            // Hidden 属性会令 WriteAllText 抛"拒绝访问"，先清属性；写完恢复隐藏/系统属性。
            try { File.SetAttributes(iniPath, FileAttributes.Normal); }
            catch { /* 清属性失败仍尝试写入 */ }
            File.WriteAllText(iniPath, kept, Encoding.Unicode);
            // 文件仍应保持隐藏/系统属性，不扰乱已存在的其它配置。
            ApplyAttrib(iniPath, "+h +s +a");

            NotifyShellIconChanged(folderPath);

            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 判断目标文件夹当前是否带有自定义图标（存在含 IconResource 的 desktop.ini）。
    /// </summary>
    public static bool HasCustomIcon(string folderPath)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(folderPath))
                return false;
            var iniPath = Path.Combine(folderPath, DesktopIniName);
            if (!File.Exists(iniPath))
                return false;
            var text = ReadDesktopIniText(iniPath);
            return text != null && ContainsIconResource(text);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 统一读取 desktop.ini 文本：按 BOM 精确判定编码（FF FE → UTF-16 LE，否则按 UTF-8）。
    /// 不能"先试 Unicode 再回退 UTF-8"——Unicode 解码任意字节流几乎不抛异常，
    /// 会把旧版无 BOM 的 UTF-8 文件读成乱码且回退永不触发（乱码随后被写回造成脏数据）。
    /// 读取失败返回 null（调用方必须保守跳过，不得当作空文本误删/误覆盖）。
    /// </summary>
    private static string? ReadDesktopIniText(string iniPath)
    {
        try
        {
            var bytes = File.ReadAllBytes(iniPath);
            if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
                return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
            var offset = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0;
            return Encoding.UTF8.GetString(bytes, offset, bytes.Length - offset);
        }
        catch
        {
            try { return File.ReadAllText(iniPath, Encoding.UTF8); }
            catch { return null; }
        }
    }

    /// <summary>
    /// 解析目标文件夹 desktop.ini 中当前的自定义图标引用。
    /// 返回 <c>(图标路径, 索引)</c>；无自定义图标返回 null。GUI 层用它直接加载图标（不依赖 Shell 缓存）。
    /// </summary>
    public static (string Path, int Index)? GetCustomIconReference(string folderPath)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(folderPath)) return null;
            var iniPath = Path.Combine(folderPath, DesktopIniName);
            if (!File.Exists(iniPath)) return null;

            var text = ReadDesktopIniText(iniPath);
            if (text == null) return null;
            foreach (var raw in text.Split('\n'))
            {
                var line = raw.Trim();
                // 兼容两种格式：IconResource=path,idx（Vista+ 常用）与 IconFile=path,idx（旧格式）
                string? val = null;
                if (line.StartsWith("IconResource=", StringComparison.OrdinalIgnoreCase))
                    val = line.Substring("IconResource=".Length).Trim();
                else if (line.StartsWith("IconFile=", StringComparison.OrdinalIgnoreCase))
                    val = line.Substring("IconFile=".Length).Trim();
                if (val == null) continue;
                // 解析 (path, index)：用最后一个逗号切分（路径本身不含逗号）；
                // 无索引（如 IconResource=C:\x\i.ico）按 index=0 继续解析路径，而非整体放弃。
                int comma = val.LastIndexOf(',');
                var source = (comma >= 0 ? val[..comma] : val).Trim().Trim('"');
                if (source.Length == 0) continue;
                if (!int.TryParse(comma >= 0 ? val[(comma + 1)..].Trim() : "", out int index)) index = 0;
                return (source, index);
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    // ---- 内部实现 ----

    /// <summary>
    /// 经官方 SHGetSetFolderCustomSettings(FCSM_ICONFILE, FCS_FORCEWRITE) 写入文件夹图标引用。
    /// 由系统自行维护 desktop.ini 内容与外壳解析缓存（二次换图标即时生效的关键）；成功返回 true。
    /// </summary>
    private static bool SetIconViaShell(string folderPath, string iconLocation, int iconIndex)
    {
        try
        {
            var fcs = new SHFolderCustomSettings
            {
                dwSize = (uint)Marshal.SizeOf<SHFolderCustomSettings>(),
                dwMask = FCSM_ICONFILE,
                pszIconFile = iconLocation,
                cchIconFile = 0,
                iIconIndex = iconIndex,
            };
            return SHGetSetFolderCustomSettings(ref fcs, folderPath, FCS_FORCEWRITE) == 0; // S_OK
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 把图标文件复制进统一副本目录并返回副本绝对路径；失败返回 null。
    /// 供"仅 GUI 生效"模式复用副本机制（外部源文件被移动/删除后 GUI 仍能加载）。
    /// </summary>
    public static string? CopyToCache(string iconFile) => CopyIconToCache(iconFile);

    /// <summary>把源图标复制进统一副本目录。非 .ico 源（png/jpg/bmp/gif 等）真正转码为多尺寸 .ico
    /// （desktop.ini 引用假 .ico 会导致 Shell 加载失败）；转码失败回退保留原扩展名复制（至少 GUI 可显示）。</summary>
    private static string? CopyIconToCache(string iconFile)
    {
        try
        {
            var cacheDir = IconCacheDir();
            Directory.CreateDirectory(cacheDir);

            var ext = Path.GetExtension(iconFile);
            var isIco = ext.Equals(".ico", StringComparison.OrdinalIgnoreCase);
            // 统一落成 .ico 名称，desktop.ini 引用实际文件即可
            var fileBase = GetStableName(iconFile);
            var dest = Path.Combine(cacheDir, fileBase + ".ico");

            if (isIco)
            {
                File.Copy(iconFile, dest, overwrite: true);
                return dest;
            }

            // 非 .ico：真正转换为合法 ICO；失败回退按原扩展名复制副本
            if (IconConversion.TryConvertToIco(iconFile, dest))
                return dest;
            try { File.Delete(dest); } catch { }
            var fallback = Path.Combine(cacheDir, fileBase + (string.IsNullOrEmpty(ext) ? ".png" : ext.ToLowerInvariant()));
            File.Copy(iconFile, fallback, overwrite: true);
            return fallback;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>由源路径生成稳定的短文件名（SHA-1 前 8 位 + 原名，避免路径含中文/空格导致的坑）。</summary>
    private static string GetStableName(string iconFile)
    {
        try
        {
            using var sha = SHA1.Create();
            var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(iconFile));
            var hex = BitConverter.ToString(hash).Replace("-", "").Substring(0, 8);
            var name = Path.GetFileNameWithoutExtension(iconFile);
            if (string.IsNullOrWhiteSpace(name)) name = "icon";
            return hex + "_" + SanitizeFileName(name);
        }
        catch
        {
            return Guid.NewGuid().ToString("N").Substring(0, 8) + "_icon";
        }
    }

    /// <summary>
    /// 净化文件名：只保留 ASCII 字母/数字/-/_，其余（含中文、空格、特殊符号）统一替换为 _。
    /// 目的：desktop.ini 中的 IconResource 路径若含非 ASCII 字符，不同编码下极易乱码导致图标加载失败。
    /// 前面已有 SHA1 前缀保证唯一性，此处只管安全。
    /// </summary>
    private static string SanitizeFileName(string name)
    {
        var sb = new StringBuilder(name.Length);
        foreach (var c in name)
        {
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')
                sb.Append(c);
            else
                sb.Append('_');
        }
        var result = sb.ToString().Trim('_');
        return result.Length == 0 ? "icon" : result;
    }

    /// <summary>
    /// 在目标文件夹写 desktop.ini：<c>[.ShellClassInfo]</c> + <c>IconResource=&lt;图标路径&gt;,0</c>。
    /// 若路径含空格，用双引号包裹路径部分（Windows 支持 <c>IconResource="path with spaces",0</c>）。
    /// 编码：统一使用 UTF-16 LE（Unicode）。Windows Shell 读取 desktop.ini 时对 ANSI/UTF-8 处理不一致，
    /// 尤其含中文路径时会乱码；UTF-16 LE 是最可靠的选择。
    /// </summary>
    private static string? WriteDesktopIni(string folderPath, string iconPath, int iconIndex = 0)
    {
        try
        {
            var iniPath = Path.Combine(folderPath, DesktopIniName);
            var existing = File.Exists(iniPath) ? ReadDesktopIniText(iniPath) : string.Empty;
            // 已有文件但读取失败：放弃写入，避免覆盖丢失未知内容
            if (existing == null) return null;

            var resourceLine = BuildIconResourceLine(iconPath, iconIndex);

            var sb = new StringBuilder();
            // 保留已有配置中的非图标行（剔除旧 IconResource 行，避免累积多行：
            // Shell 读最后一行、GetCustomIconReference 读第一行 → GUI 与资源管理器不一致）。
            if (!string.IsNullOrWhiteSpace(existing))
            {
                var kept = RemoveIconResourceLines(existing);
                if (!string.IsNullOrWhiteSpace(kept))
                {
                    sb.Append(kept);
                    if (!kept.EndsWith("\r\n", StringComparison.Ordinal))
                        sb.Append("\r\n");
                }
            }
            // 已有 [.ShellClassInfo] 段则复用，不再追加重复段头。
            if (sb.ToString().IndexOf("[.ShellClassInfo]", StringComparison.OrdinalIgnoreCase) < 0)
                sb.Append("[.ShellClassInfo]\r\n");
            sb.Append(resourceLine).Append("\r\n");

            // 关键：desktop.ini 上次写入后被加了 +h +s 属性，.NET 无法覆盖 Hidden 文件
            // （WriteAllText 直接抛"拒绝访问"），必须先清属性再写；写完由调用方 ApplyAttrib 恢复。
            try { if (File.Exists(iniPath)) File.SetAttributes(iniPath, FileAttributes.Normal); }
            catch { /* 清属性失败仍尝试写入 */ }
            File.WriteAllText(iniPath, sb.ToString(), Encoding.Unicode);
            return iniPath;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 生成 <c>IconResource=...</c>。含空格路径按 Windows 文档用双引号转义，避免被空格截断。
    /// 注意：IconResource 中逗号是图标索引分隔符，路径本身不能含逗号。
    /// </summary>
    private static string BuildIconResourceLine(string iconPath, int iconIndex = 0)
    {
        // 已打到副本目录的路径不应含逗号（文件名已被净化）；仅需处理空格。
        var index = iconIndex.ToString();
        if (iconPath.IndexOf(' ') >= 0 || iconPath.IndexOf('\t') >= 0)
            return "IconResource=\"" + iconPath + "\"," + index;
        return "IconResource=" + iconPath + "," + index;
    }

    /// <summary>
    /// 设置文件/目录的隐藏/系统/存档属性。使用 .NET 原生 API，避免启动 attrib.exe 在中文路径下可能出现的编码问题。
    /// 失败静默（不假报成功）。
    /// </summary>
    private static void ApplyAttrib(string path, string flags)
    {
        try
        {
            // 目录与文件同样用 File.GetAttributes（.NET 统一入口）
            var attrs = File.GetAttributes(path);

            // 解析 flags："+h" 加隐藏，"-h" 去隐藏，以此类推
            bool add = true;
            foreach (var ch in flags)
            {
                switch (ch)
                {
                    case '+': add = true; break;
                    case '-': add = false; break;
                    case 'h':
                    case 'H':
                        if (add) attrs |= FileAttributes.Hidden;
                        else attrs &= ~FileAttributes.Hidden;
                        break;
                    case 's':
                    case 'S':
                        if (add) attrs |= FileAttributes.System;
                        else attrs &= ~FileAttributes.System;
                        break;
                    case 'a':
                    case 'A':
                        if (add) attrs |= FileAttributes.Archive;
                        else attrs &= ~FileAttributes.Archive;
                        break;
                }
            }

            File.SetAttributes(path, attrs);
        }
        catch
        {
            // 设置属性失败静默，图标可能不生效但不会崩溃
        }
    }

    /// <summary>从文本中移除所有图标引用行（IconResource= / IconFile=），返回剩余内容。</summary>
    private static string RemoveIconResourceLines(string text)
    {
        // 先去掉尾部换行再 Split，避免产生尾随空串——否则每次重写都会累积一个空行。
        var lines = text.Replace("\r\n", "\n").TrimEnd('\n').Split('\n');
        var sb = new StringBuilder();
        foreach (var line in lines)
        {
            var trimmed = line.TrimStart(' ', '\t');
            if (trimmed.StartsWith("IconResource=", StringComparison.OrdinalIgnoreCase)
                || trimmed.StartsWith("IconFile=", StringComparison.OrdinalIgnoreCase))
                continue;
            sb.Append(line).Append("\n");
        }
        var result = sb.ToString().Replace("\n", "\r\n");
        return result;
    }

    /// <summary>判断文本是否含图标引用配置（IconResource= / IconFile=）。</summary>
    private static bool ContainsIconResource(string text)
    {
        foreach (var line in text.Replace("\r\n", "\n").Split('\n'))
        {
            var trimmed = line.TrimStart(' ', '\t');
            if (trimmed.StartsWith("IconResource=", StringComparison.OrdinalIgnoreCase)
                || trimmed.StartsWith("IconFile=", StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }
}