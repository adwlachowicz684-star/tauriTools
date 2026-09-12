using System.Collections.Concurrent;
using System.IO;
using System.Timers;

namespace FenPeiXiangMuZu.Services;

/// <summary>一条已去抖聚合的外部改动告警。Kind: Created/Changed/Deleted/Renamed。</summary>
public sealed record FolderWatchAlert(string RootPath, string Kind, string Detail, DateTime At)
{
    /// <summary>是否为破坏性事件（删除/改名 → 红色告警；创建/修改 → 信息级）。</summary>
    public bool IsDestructive => Kind is "Deleted" or "Renamed";
}

/// <summary>
/// 受保护文件夹监控服务（B 层兜底，纯逻辑无 UI 依赖）：
/// 对每条受保护路径挂 FileSystemWatcher，事件去抖聚合后回调 Alert。
/// 设计要点：
/// - 64KB InternalBufferSize + 单条队列上限（防事件风暴内存膨胀）；
/// - 去抖定时器把高频 Changed 合并为一次回调，避免构建工具刷盘时刷屏；
/// - Suppress 可重入抑制窗口：工具自身操作期间不误报；
/// - 回调发生在线程池线程，订阅方自行封送 UI。
/// </summary>
public sealed class FolderWatchService : IDisposable
{
    private sealed class Entry : IDisposable
    {
        public required string Root;
        public required FileSystemWatcher Fsw;
        public int SuppressDepth;
        public readonly ConcurrentQueue<(string Kind, string Name, string OldName)> Pending = new();
        public System.Timers.Timer? Debounce;
        public bool Truncated;   // 队列溢出后置位，聚合时补一条截断提示

        public void Dispose()
        {
            Debounce?.Dispose();
            Debounce = null;
            Fsw.EnableRaisingEvents = false;
            Fsw.Dispose();
        }
    }

    private readonly object _gate = new();
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.OrdinalIgnoreCase);
    private readonly TimeSpan _debounce = TimeSpan.FromMilliseconds(800);

    /// <summary>单路径待聚合队列上限；超出丢弃并记截断提示（防风暴）。</summary>
    private const int MaxPending = 500;

    /// <summary>聚合后的告警回调（线程池线程）。</summary>
    public event Action<FolderWatchAlert>? Alert;

    /// <summary>按当前受保护清单同步监控器：新增开启、移除关闭、已有者不动（增量，O(变化数)）。</summary>
    public void Sync(IEnumerable<string> protectedPaths)
    {
        lock (_gate)
        {
            var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var raw in protectedPaths)
            {
                var p = Normalize(raw);
                if (p.Length == 0) continue;
                wanted.Add(p);
                if (_entries.ContainsKey(p)) continue;
                if (!Directory.Exists(p)) continue;   // 不存在的路径跳过，自愈后下次 Sync 再挂
                try
                {
                    var entry = new Entry { Root = p, Fsw = BuildWatcher(p) };
                    _entries[p] = entry;
                    entry.Fsw.EnableRaisingEvents = true;
                }
                catch (Exception ex)
                {
                    Alert?.Invoke(new FolderWatchAlert(p, "Error", $"监控启动失败: {ex.Message}", DateTime.Now));
                }
            }
            foreach (var stale in _entries.Keys.Where(k => !wanted.Contains(k)).ToList())
            {
                _entries[stale].Dispose();
                _entries.Remove(stale);
            }
        }
    }

    /// <summary>工具自身操作窗口：期间该路径的监控事件不入队（可重入）。</summary>
    public void Suppress(string path, Action action)
    {
        var key = Normalize(path);
        lock (_gate)
        {
            if (_entries.TryGetValue(key, out var e)) e.SuppressDepth++;
        }
        try { action(); }
        finally
        {
            lock (_gate)
            {
                if (_entries.TryGetValue(key, out var e) && e.SuppressDepth > 0) e.SuppressDepth--;
            }
        }
    }

    private FileSystemWatcher BuildWatcher(string root)
    {
        var fsw = new FileSystemWatcher(root)
        {
            IncludeSubdirectories = true,
            InternalBufferSize = 64 * 1024,
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.DirectoryName,
        };
        fsw.Created += (_, e) => Enqueue(root, "Created", e.Name ?? "", "");
        fsw.Changed += (_, e) => Enqueue(root, "Changed", e.Name ?? "", "");
        fsw.Deleted += (_, e) => Enqueue(root, "Deleted", e.Name ?? "", "");
        fsw.Renamed += (_, e) => Enqueue(root, "Renamed", e.Name ?? "", e.OldName ?? "");
        // 缓冲区溢出 = 可能丢事件，必须显式暴露而非静默
        fsw.Error += (_, e) => Alert?.Invoke(new FolderWatchAlert(
            root, "Error", "监控缓冲区溢出，部分改动事件可能丢失" + (e.GetException()?.Message is { Length: > 0 } m ? $"（{m}）" : ""), DateTime.Now));
        return fsw;
    }

    private void Enqueue(string root, string kind, string name, string oldName)
    {
        Entry? entry;
        lock (_gate)
        {
            if (!_entries.TryGetValue(root, out entry)) return;
            if (entry.SuppressDepth > 0) return;
        }
        if (entry.Pending.Count < MaxPending) entry.Pending.Enqueue((kind, name, oldName));
        else entry.Truncated = true;

        lock (entry)
        {
            if (entry.Debounce != null) return;   // 定时器已在跑，等待统一冲刷
            var t = new System.Timers.Timer(_debounce.TotalMilliseconds) { AutoReset = false };
            t.Elapsed += (_, _) => Flush(entry);
            entry.Debounce = t;
            t.Start();
        }
    }

    private void Flush(Entry entry)
    {
        lock (entry)
        {
            entry.Debounce?.Dispose();
            entry.Debounce = null;
        }
        while (entry.Pending.TryDequeue(out var ev))
        {
            var detail = ev.Kind switch
            {
                "Created" => $"外部新建: {ev.Name}",
                "Changed" => $"外部修改: {ev.Name}",
                "Deleted" => $"外部删除（已被 ACL 拦截或已发生，请核实）: {ev.Name}",
                "Renamed" => $"外部改名: {ev.OldName} → {ev.Name}",
                _ => $"{ev.Kind}: {ev.Name}",
            };
            Alert?.Invoke(new FolderWatchAlert(entry.Root, ev.Kind, detail, DateTime.Now));
        }
        if (entry.Truncated)
        {
            entry.Truncated = false;
            Alert?.Invoke(new FolderWatchAlert(entry.Root, "Overflow", "短时间事件过多，部分记录已截断", DateTime.Now));
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var e in _entries.Values) e.Dispose();
            _entries.Clear();
        }
    }

    private static string Normalize(string? p)
        => Path.TrimEndingDirectorySeparator((p ?? "").Trim());
}
