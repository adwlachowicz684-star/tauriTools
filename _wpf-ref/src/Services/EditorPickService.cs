using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Media;
using Microsoft.Win32;

namespace FenPeiXiangMuZu.Services;

/// <summary>枚举结果条目（纯数据；Icon 已 Freeze，可跨线程传递。IconPath/IconIndex 供搜索缓存持久化）。</summary>
public sealed record EditorCandidate(string Name, string ExePath, ImageSource? Icon,
    string IconPath = "", int IconIndex = 0);

/// <summary>
/// 枚举系统右键「打开方式」中可打开 .md 的程序清单。
/// 主路径：Shell 官方 SHAssocEnumHandlers（与资源管理器菜单同源，含打包应用）——
///   IAssocHandler.GetName=主程序完整路径、GetUIName=软件显示名、GetIconLocation=图标位置；
///   先取 RECOMMENDED（即右键「打开方式」子菜单所列），为空再退 NONE。
/// 兜底：注册表自行枚举（HKCR\.md / FileExts / OpenWithList，见 EnumerateViaRegistry），
/// 覆盖 Shell 枚举异常或返回空的场景。按 exe 路径去重；仅读取操作，可在后台线程调用。
/// </summary>
public static class EditorPickService
{
    private const string MdExt = ".md";

    /// <summary>枚举全部候选：Shell 为主、注册表兜底。</summary>
    public static List<EditorCandidate> Enumerate()
    {
        try
        {
            var viaShell = EnumerateViaShell(ASSOC_FILTER.RECOMMENDED);
            if (viaShell.Count > 0) return viaShell;
            viaShell = EnumerateViaShell(ASSOC_FILTER.NONE);
            if (viaShell.Count > 0) return viaShell;
        }
        catch { /* Shell 枚举失败转注册表兜底 */ }
        return EnumerateViaRegistry();
    }

    // ---------------- 主路径：SHAssocEnumHandlers（COM） ----------------

    [Flags]
    private enum ASSOC_FILTER
    {
        NONE = 0x0,
        RECOMMENDED = 0x1,
    }

    [ComImport, Guid("973810AE-9599-4B88-9E4D-6EE98C9552DA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IEnumAssocHandlers
    {
        [PreserveSig]
        int Next(int celt, out IAssocHandler rgelt, out int pceltFetched);
    }

    [ComImport, Guid("F04061AC-1659-4A3F-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAssocHandler
    {
        /// <summary>关联的可执行文件完整路径。</summary>
        void GetName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);

        /// <summary>应用显示名（本地化软件名称）。</summary>
        void GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);

        /// <summary>图标位置（路径 + 索引）。</summary>
        void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string ppszPath, out int pIndex);

        [PreserveSig]
        int IsRecommended();
        // 其后 MakeDefault/Invoke/CreateInvoker 本工具不用，省略不影响前缀 vtable 匹配。
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHAssocEnumHandlers(string pszExtra, ASSOC_FILTER afFilter,
        out IEnumAssocHandlers ppEnumHandler);

    private static List<EditorCandidate> EnumerateViaShell(ASSOC_FILTER filter)
    {
        var result = new List<EditorCandidate>();
        var seenExe = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var hr = SHAssocEnumHandlers(MdExt, filter, out var eah);
        if (hr != 0 || eah == null) return result;
        try
        {
            while (eah.Next(1, out var handler, out var fetched) == 0 && fetched == 1)
            {
                try
                {
                    handler.GetName(out var rawExe);
                    handler.GetUIName(out var uiName);
                    handler.GetIconLocation(out var rawIconPath, out var iconIndex);

                    var exe = CanonicalizeExe(ParseQuoted(rawExe));
                    if (exe == null || !seenExe.Add(exe)) continue;
                    var name = string.IsNullOrWhiteSpace(uiName) ? Path.GetFileNameWithoutExtension(exe) : uiName.Trim();
                    var icon = LoadIconAt(rawIconPath, iconIndex);
                    result.Add(new EditorCandidate(name, exe, icon, rawIconPath ?? "", iconIndex));
                }
                catch { /* 单条目损坏跳过 */ }
                finally
                {
                    _ = Marshal.ReleaseComObject(handler);
                }
            }
        }
        finally
        {
            _ = Marshal.ReleaseComObject(eah);
        }
        return result;
    }

    /// <summary>图标位置字符串 → 冻结 ImageSource；支持环境变量展开与 exe/dll/ico/png 等引用。</summary>
    private static ImageSource? LoadIconAt(string? rawPath, int index)
    {
        if (string.IsNullOrWhiteSpace(rawPath)) return null;
        var path = ParseQuoted(rawPath);
        if (string.IsNullOrEmpty(path)) return null;
        try { path = Environment.ExpandEnvironmentVariables(path); } catch { /* 含未知变量保持原样 */ }
        if (index < 0) index = 0;
        return IconService.LoadCustomIcon(path, index);
    }

    /// <summary>去掉首尾引号与空白；空串返回 null。</summary>
    private static string? ParseQuoted(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var t = raw.Trim().Trim('"').Trim();
        return t.Length > 0 ? t : null;
    }

    // ---------------- 兜底：注册表枚举（Shell 路径不可用时） ----------------

    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    private static extern int SHLoadIndirectString(string pszSource, StringBuilder pszOutBuf, uint cchOutBuf, IntPtr ppvReserved);

    /// <summary>注册表兜底：ProgID/Applications 解析出候选清单。</summary>
    private static List<EditorCandidate> EnumerateViaRegistry()
    {
        var ordered = new List<EditorCandidate>();
        var seenExe = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var progIds = new List<string>();

        TryCollectUserChoice(progIds);
        TryCollectAssocKey($@"Software\Classes{MdExt}", progIds);
        TryCollectOpenWithProgids(progIds);
        var appExes = new List<string>();
        TryCollectOpenWithList(appExes);

        foreach (var id in progIds)
        {
            using var k = Registry.ClassesRoot.OpenSubKey(id);
            if (k != null) ResolveAndAdd(k, ordered, seenExe);
        }
        foreach (var exeName in appExes)
        {
            using var k = Registry.ClassesRoot.OpenSubKey(@"Applications\" + exeName);
            if (k != null) ResolveAndAdd(k, ordered, seenExe);
        }
        return ordered;
    }

    private static void TryCollectUserChoice(List<string> progIds)
    {
        try
        {
            using var uc = Registry.CurrentUser.OpenSubKey(
                $@"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{MdExt}\UserChoice");
            var p = uc?.GetValue("ProgId") as string;
            if (!string.IsNullOrEmpty(p)) progIds.Add(p);
        }
        catch { /* 无 UserChoice 视为正常 */ }
    }

    private static void TryCollectAssocKey(string path, List<string> progIds)
    {
        try
        {
            using var ext = Registry.ClassesRoot.OpenSubKey(path) ?? Registry.CurrentUser.OpenSubKey(path);
            if (ext == null) return;
            AddUnique(ext.GetValue(null) as string, progIds);
            using var owp = ext.OpenSubKey("OpenWithProgids");
            if (owp != null)
                foreach (var n in owp.GetValueNames())
                    AddUnique(n, progIds);
        }
        catch { /* 键不存在/损坏跳过 */ }
    }

    private static void TryCollectOpenWithProgids(List<string> progIds)
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(
                $@"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{MdExt}\OpenWithProgids");
            if (k == null) return;
            foreach (var n in k.GetValueNames())
                AddUnique(n, progIds);
        }
        catch { }
    }

    private static void TryCollectOpenWithList(List<string> appExes)
    {
        try
        {
            using var owl = Registry.ClassesRoot.OpenSubKey($@"Software\Classes{MdExt}\OpenWithList")
                ?? Registry.ClassesRoot.OpenSubKey(MdExt + @"\OpenWithList");
            if (owl == null) return;
            foreach (var sub in owl.GetSubKeyNames())
            {
                try
                {
                    var exe = owl.OpenSubKey(sub)?.GetValue(null) as string;
                    if (!string.IsNullOrWhiteSpace(exe)) appExes.Add(exe);
                }
                catch { }
            }
        }
        catch { }
    }

    /// <summary>解析一个 ProgID / Applications 键为候选条目；无法定位可执行文件则丢弃。</summary>
    private static void ResolveAndAdd(RegistryKey key, List<EditorCandidate> ordered, HashSet<string> seenExe)
    {
        try
        {
            var cmd = key.OpenSubKey(@"shell\open\command")?.GetValue(null) as string;
            var exe = CanonicalizeExe(ParseCommand(cmd));
            if (exe == null || !seenExe.Add(exe)) return;

            var name = LoadIndirectString(key.GetValue("FriendlyTypeName") as string)
                       ?? Path.GetFileNameWithoutExtension(exe);
            var iconRaw = key.OpenSubKey("DefaultIcon")?.GetValue(null) as string;
            var icon = LoadIconFromDefaultIcon(iconRaw);
            var (iconPath, iconIndex) = SplitDefaultIcon(iconRaw);
            ordered.Add(new EditorCandidate(name, exe, icon, iconPath, iconIndex));
        }
        catch { /* 单条目损坏跳过 */ }
    }

    /// <summary>从 shell\open\command 提取主程序路径（带引号取引号内；裸路径按 .exe 边界截断，兼容空格目录与 /dde 类参数）。</summary>
    private static string? ParseCommand(string? command)
    {
        if (string.IsNullOrWhiteSpace(command)) return null;
        command = command.Trim();
        string raw;
        if (command[0] == '"')
        {
            var end = command.IndexOf('"', 1);
            if (end < 0) return null;
            raw = command[1..end];
        }
        else
        {
            var lower = command.ToLowerInvariant();
            var i = lower.IndexOf(".exe", StringComparison.Ordinal);
            if (i < 0) i = lower.IndexOf(".bat", StringComparison.Ordinal);
            if (i >= 0) raw = command[..(i + 4)];
            else
            {
                var sp = command.IndexOf(' ');
                raw = sp > 0 ? command[..sp] : command;
            }
        }
        raw = raw.Trim().Trim('"');
        try { raw = Environment.ExpandEnvironmentVariables(raw); } catch { /* 含未知变量保持原样 */ }
        return raw.Length > 0 ? raw : null;
    }

    /// <summary>相对名（如 notepad.exe）沿系统目录与 PATH 解析为全路径；找不到返回 null。</summary>
    private static string? CanonicalizeExe(string? exe)
    {
        if (string.IsNullOrWhiteSpace(exe)) return null;
        if (Path.IsPathRooted(exe)) return File.Exists(exe) ? exe : null;
        try
        {
            var sys = Path.Combine(Environment.SystemDirectory, exe);
            if (File.Exists(sys)) return sys;
            var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in pathEnv.Split(';', StringSplitOptions.RemoveEmptyEntries))
            {
                var p = Path.Combine(dir.Trim(), exe);
                if (File.Exists(p)) return p;
            }
        }
        catch { }
        return null;
    }

    /// <summary>DefaultIcon（"path,index"）→ 图标；缺省/失败返回 null（列表显示无图标占位）。</summary>
    private static ImageSource? LoadIconFromDefaultIcon(string? raw)
    {
        var (path, idx) = SplitDefaultIcon(raw);
        if (path.Length == 0) return null;
        return IconService.LoadCustomIcon(path, idx);
    }

    /// <summary>拆 DefaultIcon 为路径与索引（供缓存持久化；路径已做环境变量展开与去引号）。</summary>
    private static (string Path, int Index) SplitDefaultIcon(string? raw)
    {
        var path = ParseQuoted(raw);
        if (path == null) return ("", 0);
        try { path = Environment.ExpandEnvironmentVariables(path); } catch { /* 含未知变量保持原样 */ }
        var idx = 0;
        var comma = path.LastIndexOf(',');
        if (comma >= 0 && int.TryParse(path[(comma + 1)..].Trim(), out var i))
        {
            path = path[..comma].Trim();
            idx = i < 0 ? 0 : i;
        }
        return (path, idx);
    }

    /// <summary>间接字符串（"@C:\path\app.exe,-123"）→ 本地化文本；非间接原样返回，解析失败返回 null。</summary>
    private static string? LoadIndirectString(string? raw)
    {
        if (string.IsNullOrEmpty(raw) || !raw.StartsWith('@')) return raw;
        try
        {
            var sb = new StringBuilder(1024);
            return SHLoadIndirectString(raw, sb, (uint)sb.Capacity, IntPtr.Zero) == 0 && sb.Length > 0
                ? sb.ToString()
                : null;
        }
        catch
        {
            return null;
        }
    }

    private static void AddUnique(string? item, List<string> list)
    {
        if (!string.IsNullOrWhiteSpace(item) && !list.Contains(item)) list.Add(item);
    }
}
