using System.Diagnostics;
using System.IO;
using FenPeiXiangMuZu.Models;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 一键备份服务（纯 IO，无 UI 依赖）：把 config 中登记的项目/项目组文件夹增量同步到备份目录。
/// GUI 与 MCP 共用本服务；差异比对 = 文件大小 + UTC 修改时间（2 秒容差），
/// junction/symlink 一律不深入也不复制（本项目大量使用链接，防止循环与重复内容）。
/// </summary>
public static class BackupService
{
    /// <summary>默认备份根目录名（用户指定拼写 backkup_）：位于 exe 所在目录下。</summary>
    public const string DefaultProjectFolderName = "backkup_项目备份";
    public const string DefaultGroupFolderName = "backkup_项目组备份";

    public static string DefaultProjectDir => Path.Combine(AppContext.BaseDirectory, DefaultProjectFolderName);
    public static string DefaultGroupDir => Path.Combine(AppContext.BaseDirectory, DefaultGroupFolderName);

    /// <summary>修改时间比对容差（秒）：FAT/exFAT 时间戳精度低，过严会导致每次全量误更新。</summary>
    private const double MtimeToleranceSeconds = 2.0;

    /// <summary>解析实际使用的备份目录：配置为空白时回退 exe 旁默认目录。</summary>
    public static string ResolveDir(string? configured, string fallback)
        => string.IsNullOrWhiteSpace(configured) ? fallback : configured.Trim();

    /// <summary>收集 config 全部页签中的项目路径（去重、保持首次出现顺序、去除尾部分隔符）。</summary>
    public static List<string> CollectProjectPaths(AppConfig cfg) => Collect(cfg.ProjectTabs.Select(t => t.Projects));

    /// <summary>收集 config 全部页签中的项目组路径（规则同上）。</summary>
    public static List<string> CollectGroupPaths(AppConfig cfg) => Collect(cfg.GroupTabs.Select(t => t.Groups));

    private static List<string> Collect(IEnumerable<List<string>> lists)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<string>();
        foreach (var raw in lists.SelectMany(x => x))
        {
            var p = NormalizePath(raw);
            if (p.Length > 0 && seen.Add(p)) list.Add(p);
        }
        return list;
    }

    private static string NormalizePath(string? p)
    {
        if (string.IsNullOrWhiteSpace(p)) return "";
        try { return Path.TrimEndingDirectorySeparator(p.Trim()); }
        catch { return ""; }
    }

    /// <summary>把「源路径列表」装配成 (备份子目录名, 源完整路径) 对；同名不同源的冲突在此剔除并记录。</summary>
    public static List<(string Name, string Source)> BuildSources(IReadOnlyList<string> paths, BackupResult result)
    {
        var byName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var sources = new List<(string Name, string Source)>();
        foreach (var src in paths)
        {
            var name = SafeFolderName(src);
            if (name.Length == 0)
            {
                result.Errors.Add($"[跳过] 无法从路径解析文件夹名: {src}");
                continue;
            }
            if (byName.TryGetValue(name, out var owner))
            {
                result.Errors.Add($"[跳过] 备份名冲突「{name}」：{src} 与 {owner} 同名，请手动处理或改名其一");
                continue;
            }
            byName[name] = src;
            sources.Add((name, src));
        }
        return sources;
    }

    /// <summary>源文件夹的备份子目录名 = 路径末级名（非法字符替换为 _）。</summary>
    private static string SafeFolderName(string fullPath)
    {
        try
        {
            var name = Path.GetFileName(Path.TrimEndingDirectorySeparator(fullPath));
            foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name.Trim();
        }
        catch { return ""; }
    }

    /// <summary>
    /// 执行一次备份：sources 中每个源同步到 targetRoot\&lt;名称&gt; 子目录。
    /// appendOnly=true 只新增/更新（源中已删除的保留在备份中）；false=镜像同步（多余文件/空目录一并清除）。
    /// 结果写入 result（含逐条错误）；单个源失败不影响其余源。
    /// </summary>
    public static void BackupAll(IReadOnlyList<string> sourcePaths, string targetRoot, bool appendOnly, BackupResult result)
    {
        var sources = BuildSources(sourcePaths, result);
        if (sources.Count == 0) return;
        try { Directory.CreateDirectory(targetRoot); }
        catch (Exception ex) { result.Errors.Add($"[失败] 创建备份目录 {targetRoot}: {ex.Message}"); return; }

        foreach (var (name, src) in sources)
        {
            if (!Directory.Exists(src)) { result.MissingSources++; continue; }
            if (IsNested(src, targetRoot))
            {
                result.Errors.Add($"[跳过] 源目录与备份目录互相嵌套，为防自我复制已忽略: {src}");
                continue;
            }
            result.Sources++;
            try { SyncTree(src, Path.Combine(targetRoot, name), appendOnly, result); }
            catch (Exception ex) { result.Errors.Add($"[失败] 备份 {src}: {ex.Message}"); }
        }
    }

    /// <summary>两个目录是否存在包含关系（任一方是另一方的前代），防备份目录自我嵌套复制。</summary>
    private static bool IsNested(string a, string b)
    {
        var x = AppendSeparator(Path.GetFullPath(a));
        var y = AppendSeparator(Path.GetFullPath(b));
        return x.Equals(y, StringComparison.OrdinalIgnoreCase)
            || x.StartsWith(y, StringComparison.OrdinalIgnoreCase)
            || y.StartsWith(x, StringComparison.OrdinalIgnoreCase);
    }

    private static string AppendSeparator(string p)
        => Path.TrimEndingDirectorySeparator(p) + Path.DirectorySeparatorChar;

    /// <summary>路径中的目录分隔符个数（= 目录深度），用于空目录自深至浅清理排序。</summary>
    private static int PathDepth(string p)
    {
        int n = 0;
        foreach (var c in p) if (c == '\\' || c == '/') n++;
        return n;
    }

    // ---------------- 树同步核心 ----------------

    private static void SyncTree(string srcRoot, string dstRoot, bool appendOnly, BackupResult r)
    {
        Directory.CreateDirectory(dstRoot);

        // 1) 源清单：相对路径 → (长度, UTC 修改时间)。reparse 目录/文件不入清单（跳过计数）。
        var srcFiles = new Dictionary<string, (long Len, DateTime Mt)>(StringComparer.OrdinalIgnoreCase);
        var srcDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        CollectSource(srcRoot, "", srcFiles, srcDirs, r);

        // 2) 复制新增 / 覆盖更新
        foreach (var (rel, meta) in srcFiles)
        {
            var dst = Path.Combine(dstRoot, rel);
            try
            {
                if (!File.Exists(dst)) { CopyAtomic(Path.Combine(srcRoot, rel), dst); r.NewFiles++; continue; }
                var fi = new FileInfo(dst);
                var sameLen = fi.Length == meta.Len;
                var sameTime = Math.Abs((fi.LastWriteTimeUtc - meta.Mt).TotalSeconds) <= MtimeToleranceSeconds;
                if (!sameLen || !sameTime) { CopyAtomic(Path.Combine(srcRoot, rel), dst); r.UpdatedFiles++; }
            }
            catch (Exception ex) { r.Errors.Add($"[失败] {Path.Combine(srcRoot, rel)}: {ex.Message}"); }
        }

        if (appendOnly) return;

        // 3) 镜像删除：备份侧存在而源清单中没有的文件 → 删除；随后自深至浅清理多余空目录。
        foreach (var df in SafeEnumerate(dstRoot, filesOnly: true))
        {
            if (df.Length == dstRoot.Length) continue;
            var rel = df.Substring(dstRoot.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (HasReparse(df)) { r.SkippedLinks++; continue; }
            if (!srcFiles.ContainsKey(rel))
            {
                try { File.Delete(df); r.DeletedFiles++; }
                catch (Exception ex) { r.Errors.Add($"[失败] 删除 {df}: {ex.Message}"); }
            }
        }
        // 按真实目录深度倒序（分隔符计数）自深至浅清理；路径长度≠深度，长度排序会让长名浅目录先于短名深目录被跳过
        foreach (var dd in SafeEnumerate(dstRoot, filesOnly: false).OrderByDescending(PathDepth))
        {
            if (dd.Length == dstRoot.Length) continue;
            var rel = dd.Substring(dstRoot.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (HasReparse(dd)) continue;                       // 不动用户备份里的链接点
            if (!srcDirs.Contains(rel) && !Directory.EnumerateFileSystemEntries(dd).Any())
            {
                try { Directory.Delete(dd); }
                catch (Exception ex) { r.Errors.Add($"[失败] 删除目录 {dd}: {ex.Message}"); }
            }
        }
    }

    /// <summary>递归收集源树（files 相对路径→元数据；dirs 相对路径集合）；reparse 点整枝跳过。</summary>
    private static void CollectSource(string root, string rel,
        Dictionary<string, (long Len, DateTime Mt)> files, HashSet<string> dirs, BackupResult r)
    {
        IEnumerable<string>? entries = null;
        try { entries = Directory.EnumerateFileSystemEntries(string.IsNullOrEmpty(rel) ? root : Path.Combine(root, rel)); }
        catch (Exception ex) { r.Errors.Add($"[失败] 枚举 {root}\\{rel}: {ex.Message}"); return; }

        foreach (var e in entries)
        {
            var childRel = string.IsNullOrEmpty(rel) ? Path.GetFileName(e) : Path.Combine(rel, Path.GetFileName(e));
            try
            {
                var attr = File.GetAttributes(e);
                if ((attr & FileAttributes.ReparsePoint) != 0) { r.SkippedLinks++; continue; }
                if (attr.HasFlag(FileAttributes.Directory))
                {
                    dirs.Add(childRel);
                    CollectSource(root, childRel, files, dirs, r);
                }
                else
                {
                    var fi = new FileInfo(e);
                    files[childRel] = (fi.Length, fi.LastWriteTimeUtc);
                }
            }
            catch (Exception ex) { r.Errors.Add($"[失败] {e}: {ex.Message}"); }
        }
    }

    /// <summary>原子复制：先拷到临时名再 Move 覆盖，进程中途被杀不会留下半截正式文件；自动补齐目标父目录。</summary>
    private static void CopyAtomic(string src, string dst)
    {
        var parent = Path.GetDirectoryName(dst);
        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
        var tmp = dst + ".bktmp~";
        File.Copy(src, tmp, overwrite: true);
        File.Move(tmp, dst, overwrite: true);
    }

    /// <summary>遍历目录树内全部文件/目录（filesOnly 选择类别）；枚举异常降级为尽力而为。</summary>
    private static IEnumerable<string> SafeEnumerate(string root, bool filesOnly)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            IEnumerable<string> sub = Enumerable.Empty<string>();
            IEnumerable<string> fls = Enumerable.Empty<string>();
            try { sub = Directory.EnumerateDirectories(dir); } catch { }
            try { fls = Directory.EnumerateFiles(dir); } catch { }
            foreach (var f in fls) if (filesOnly) yield return f;
            foreach (var d in sub) { if (!filesOnly) yield return d; stack.Push(d); }
        }
    }

    private static bool HasReparse(string path)
    {
        try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
        catch { return false; }
    }
}

/// <summary>一次备份执行的统计结果（纯数据；GUI 写日志、MCP 序列化返回共用）。</summary>
public sealed class BackupResult
{
    /// <summary>有效参与同步的源数量。</summary>
    public int Sources { get; set; }
    /// <summary>源不存在被跳过的数量。</summary>
    public int MissingSources { get; set; }
    /// <summary>本次新增复制的文件数。</summary>
    public int NewFiles { get; set; }
    /// <summary>内容变化被覆盖更新的文件数。</summary>
    public int UpdatedFiles { get; set; }
    /// <summary>镜像模式删除的多余文件数（appendOnly 模式恒为 0）。</summary>
    public int DeletedFiles { get; set; }
    /// <summary>跳过的 junction/symlink 数量。</summary>
    public int SkippedLinks { get; set; }
    /// <summary>逐条错误/警告（单条失败不中断整体）。</summary>
    public List<string> Errors { get; } = new();

    public bool HasError => Errors.Count > 0;

    /// <summary>一行式摘要（日志用）。</summary>
    public string Summary
    {
        get
        {
            var s = $"源 {Sources} 个：新增 {NewFiles}、更新 {UpdatedFiles}、删除 {DeletedFiles}"
                  + $"、跳过链接 {SkippedLinks}、缺失源 {MissingSources}";
            return HasError ? s + $"，异常 {Errors.Count} 条" : s;
        }
    }
}
