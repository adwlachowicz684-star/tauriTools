using FenPeiXiangMuZu.Models;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 链接记录服务，管理 link-record.json。忠实复刻 PS 版数据逻辑：
/// project/lib 以相对路径存储（基准 = baseRoot），支持绝对/相对转换；
/// Upsert 按绝对路径匹配更新或新增；读取兼容 {clusters,links} 对象与裸数组两种历史格式。
/// </summary>
public sealed class LinkRecordService
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    private readonly string _recordPath;
    private readonly string _baseRoot;
    // 保存锁：串行化写盘（Upsert/Remove 并发时防交错/撕裂）
    private readonly object _saveLock = new();
    // 跨进程保存锁：GUI 与 MCP 两进程并发"读-改-写"同一 JSON 时的互斥（进程内 _saveLock 之外的第二道闸）
    private static Mutex? _globalSaveMutex;
    private static Mutex GlobalSaveMutex => _globalSaveMutex ??= new Mutex(false, @"Global\FenPeiXiangMuZu_RecordSave");

    /// <summary>相对路径基准（baseRoot，通常 = config.lastLib）。</summary>
    public string BaseRoot => _baseRoot;

    /// <param name="baseRoot">相对路径基准（PS 版 = 启动 scriptRoot，通常取 config.lastLib）。</param>
    /// <param name="recordPath">link-record.json 全路径。</param>
    public LinkRecordService(string baseRoot, string recordPath)
    {
        _baseRoot = baseRoot.TrimEnd('\\');
        _recordPath = recordPath;
    }

    /// <summary>相对路径 → 绝对（Path.GetFullPath，含 null/空容错）。</summary>
    public string ToAbsPath(string? rel)
    {
        if (string.IsNullOrWhiteSpace(rel)) return _baseRoot;
        return Path.GetFullPath(Path.Combine(_baseRoot, rel));
    }

    /// <summary>绝对路径 → 相对（基准 _baseRoot）。</summary>
    public string ToRelPath(string abs)
    {
        var full = Path.GetFullPath(abs);
        // 与 baseRoot 同盘才做相对化；跨盘或信息不足则原样返回绝对路径
        if (Path.GetPathRoot(full)?.Equals(Path.GetPathRoot(_baseRoot), StringComparison.OrdinalIgnoreCase) == true)
            return Path.GetRelativePath(_baseRoot, full);
        return full;
    }

    /// <summary>读取全部记录。兼容 {clusters,links} 对象 或 裸数组 两种历史格式。
    /// 文件不存在返回空列表；文件存在但读取失败（被占用/权限/彻底损坏）返回 null —— 调用方必须中止，
    /// 绝不能以空列表为基础写盘，否则旧账本会被整体覆盖。</summary>
    public List<LinkRecord>? LoadStrict()
    {
        if (!File.Exists(_recordPath)) return new List<LinkRecord>();
        try
        {
            var json = WithGlobalLock(() => File.ReadAllText(_recordPath));
            try
            {
                var root = JsonSerializer.Deserialize<LinkRecordFile>(json, Options);
                return root?.Links ?? new List<LinkRecord>();
            }
            catch (JsonException)
            {
                // 裸数组旧格式
                return JsonSerializer.Deserialize<List<LinkRecord>>(json, Options);
            }
        }
        catch (Exception)
        {
            return null;   // 与"文件不存在"严格区分，防止上层误当空账本覆盖
        }
    }

    /// <summary>读取全部记录（宽松版）：读取失败按空列表兜底，仅供纯展示类调用；写路径一律用 LoadStrict。</summary>
    public List<LinkRecord> Load() => LoadStrict() ?? new List<LinkRecord>();

    /// <summary>跨进程互斥执行（GUI/MCP 并发读-改-写串行化）。锁被遗弃时视为已获得并继续。</summary>
    private T WithGlobalLock<T>(Func<T> action)
    {
        var m = GlobalSaveMutex;
        try { m.WaitOne(); }
        catch (AbandonedMutexException) { /* 前一进程异常退出：锁已归属本线程 */ }
        try { return action(); }
        finally { try { m.ReleaseMutex(); } catch (ApplicationException) { } }
    }

    /// <summary>以 {clusters, links} 结构写回（links 存相对路径）。原子写：临时文件 + Move 替换，外包跨进程锁。</summary>
    public void Save(IEnumerable<LinkRecord> records)
    {
        var file = new LinkRecordFile { Links = new List<LinkRecord>(records) };
        var dir = Path.GetDirectoryName(_recordPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var json = JsonSerializer.Serialize(file, Options);
        var tmpPath = _recordPath + ".tmp";
        lock (_saveLock)
        {
            WithGlobalLock(() =>
            {
                File.WriteAllText(tmpPath, json, new System.Text.UTF8Encoding(false));
                File.Move(tmpPath, _recordPath, overwrite: true);
                return true;
            });
        }
    }

    /// <summary>写路径专用：严格读取，失败即中止（返回 null 由调用方转为报错），防止空账本覆盖旧数据。</summary>
    private List<LinkRecord> LoadForWrite()
        => LoadStrict() ?? throw new InvalidOperationException(
            "link-record.json 读取失败（被占用/权限不足或内容损坏），已中止写入以防覆盖现有账本。");

    /// <summary>按绝对项目路径匹配；存在则更新 lib/group/created/names，否则新增（对应 PS Update-Record）。</summary>
    public LinkRecord Upsert(string projectAbs, string libAbs, string groupName, string created, List<string>? linkNames = null)
    {
        var recs = LoadForWrite();
        var key = NormAbs(projectAbs); // 输入先展开为完整路径，与 ToAbsPath 归一一致（防 8.3 短名不匹配）
        var existing = recs.FirstOrDefault(r => Norm(ToAbsPath(r.Project)) == key);
        var absLib = NormAbs(libAbs);

        if (existing == null)
        {
            existing = new LinkRecord
            {
                Project = ToRelPath(key),
                Lib = ToRelPath(absLib),
                Group = groupName,
                Created = created,
                Cluster = "",
                Names = linkNames,
            };
            recs.Add(existing);
        }
        else
        {
            existing.Lib = ToRelPath(absLib);
            existing.Group = groupName;
            existing.Created = created;
            existing.Names = linkNames;
        }
        Save(recs);
        return existing;
    }

    /// <summary>删除某项目的记录（对应 PS Remove-Record，仅删记录不删 junction）。</summary>
    public void Remove(string projectAbs)
    {
        var key = NormAbs(projectAbs);
        var recs = LoadForWrite().Where(r => Norm(ToAbsPath(r.Project)) != key).ToList();
        Save(recs);
    }

    /// <summary>按绝对项目路径查找记录，命不到返回 null。读取失败抛出（调用方以错误呈现，不静默当无记录）。</summary>
    public LinkRecord? FindByProject(string projectAbs)
    {
        var key = NormAbs(projectAbs);
        return LoadForWrite().FirstOrDefault(r => Norm(ToAbsPath(r.Project)) == key);
    }

    /// <summary>某项目当前链接到的项目组绝对路径（无记录返回 null）。</summary>
    public string? GetTargetLib(string projectAbs)
    {
        var key = NormAbs(projectAbs);
        var rec = LoadForWrite().FirstOrDefault(r => Norm(ToAbsPath(r.Project)) == key);
        return rec == null ? null : ToAbsPath(rec.Lib);
    }

    /// <summary>是否已有该项目的记录。</summary>
    public bool Exists(string projectAbs)
        => FindByProject(projectAbs) != null;

    private static string Norm(string p) => p.TrimEnd('\\');

    /// <summary>把绝对路径输入展开为完整路径并去尾斜杠（与 ToAbsPath 的 GetFullPath 归一一致）。</summary>
    private static string NormAbs(string abs) => Path.GetFullPath(abs).TrimEnd('\\');
}