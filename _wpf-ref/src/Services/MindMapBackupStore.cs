using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 脑图滚动备份：默认 <数据目录>/mindmap-backups/mindmap-&lt;yyyyMMdd-HHmmss&gt;.json，
/// 目录与保留份数可由设置页配置（MindMapPanel 每分钟判定「脑图较最新备份有改动」后调用 <see cref="CreateBackup"/>）。
/// 原子写 tmp→move，进程内锁串行化。
/// </summary>
public static class MindMapBackupStore
{
    /// <summary>同一份脑图默认最多保留的备份份数。</summary>
    public const int DefaultMaxBackups = 3;

    private static readonly object _lock = new();
    private static readonly Regex FilePattern = new(@"^mindmap-\d{8}-\d{6}\.json$", RegexOptions.Compiled);
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    /// <summary>默认备份目录（数据目录\mindmap-backups）。</summary>
    public static string DefaultDir => Path.Combine(App.DataDir, "mindmap-backups");

    /// <summary>全部备份文件路径（按文件名时间戳升序，最旧在前）。仅匹配严格命名模式，异质文件一律不碰。</summary>
    public static List<string> ListBackups(string dir)
    {
        if (!Directory.Exists(dir)) return new List<string>();
        return Directory.GetFiles(dir, "mindmap-*.json")
            .Where(f => FilePattern.IsMatch(Path.GetFileName(f)))
            .OrderBy(f => f, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>最新一份备份的状态；无备份或读取失败 → null。</summary>
    public static MindMapState? LatestBackup(string dir)
    {
        var files = ListBackups(dir);
        if (files.Count == 0) return null;
        try
        {
            using var fs = new FileStream(files[^1], FileMode.Open, FileAccess.Read, FileShare.Read);
            return JsonSerializer.Deserialize<MindMapState>(fs, Json);
        }
        catch { return null; }
    }

    /// <summary>创建一份当前状态备份，随后裁剪到最多 maxBackups 份（删除最旧）。</summary>
    public static void CreateBackup(string dir, MindMapState state, int maxBackups = DefaultMaxBackups)
    {
        lock (_lock)
        {
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, "mindmap-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".json");
            var tmp = file + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(state, Json));
            File.Move(tmp, file, overwrite: true);
            PruneCore(dir, maxBackups);
        }
    }

    /// <summary>把 fromDir 下的全部备份文件整体迁移到 toDir（目标已存在的同名文件跳过不覆盖）。</summary>
    public static void MoveBackups(string fromDir, string toDir)
    {
        lock (_lock)
        {
            if (string.Equals(fromDir, toDir, StringComparison.OrdinalIgnoreCase)) return;
            if (!Directory.Exists(fromDir)) return;
            Directory.CreateDirectory(toDir);
            foreach (var f in ListBackups(fromDir))
            {
                var dest = Path.Combine(toDir, Path.GetFileName(f));
                if (File.Exists(dest)) continue;
                File.Move(f, dest);
            }
        }
    }

    /// <summary>裁剪：仅保留最新 maxBackups 份（严格命名模式过滤后的子集），删除更旧的。</summary>
    private static void PruneCore(string dir, int maxBackups)
    {
        var files = ListBackups(dir);
        while (files.Count > maxBackups)
        {
            try { File.Delete(files[0]); }
            catch { }
            files.RemoveAt(0);
        }
    }
}
