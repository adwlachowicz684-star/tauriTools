using System.Collections.Concurrent;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

namespace FenPeiXiangMuZu.Services;

/// <summary>一条路径当前的 ACL 保护状态快照。</summary>
public sealed record FolderLockState(bool DenyDelete, bool DenyWrite)
{
    public bool Any => DenyDelete || DenyWrite;
}

/// <summary>
/// ACL 文件夹保护服务（纯 Win32 安全描述符操作，无 UI 依赖）：
/// 对受保护目录写入 Everyone(S-1-1-0) 的 Deny ACE，内核级拦截删除/重命名（防删除档）
/// 或全部写入（只读档）。读写与 READ/WRITE_DAC/所有权永不动 —— 所有者永远能自救。
///
/// 设计要点：
/// - ACE 加在目录根靠继承传播（O(1)，不递归遍历）；junction 不继承目标侧 ACE，无循环风险。
/// - 「本工具的 Deny」识别口径 = 身份为 Everyone 且权限落在 Delete/Write 管理范围内的 Deny 规则；
///   清扫/重建均只动这个范围，不触碰任何第三方 ACE。
/// - WithUnlock 可重入：嵌套调用只在最外层摘/戴一次；中途崩溃 fail-open（变回未锁，绝不反锁死）。
/// </summary>
public static class FolderLockService
{
    private static readonly SecurityIdentifier WorldSid = new(WellKnownSidType.WorldSid, null);

    /// <summary>防删除档管理的权限位。</summary>
    private const FileSystemRights DeleteRights =
        FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles;

    /// <summary>防写入档管理的权限位。</summary>
    private const FileSystemRights WriteRights =
        FileSystemRights.WriteData | FileSystemRights.AppendData
        | FileSystemRights.WriteAttributes | FileSystemRights.WriteExtendedAttributes;

    /// <summary>WithUnlock 重入计数（路径 → 深度）。>0 表示锁已临时摘除，内层直接透传。</summary>
    private static readonly ConcurrentDictionary<string, int> _unlockDepth =
        new(StringComparer.OrdinalIgnoreCase);

    // ---------------- 对外主 API ----------------

    /// <summary>
    /// 应用保护（幂等）：先清扫本工具既有 Everyone-Deny，再按 denyDelete/denyWrite 重建。
    /// 两个开关全 false 等价 Unprotect。目录不存在时抛 DirectoryNotFoundException。
    /// </summary>
    public static void Protect(string dir, bool denyDelete, bool denyWrite)
        => Apply(Normalize(dir), denyDelete, denyWrite);

    /// <summary>解除某路径的全部 ACL 保护（仅清本工具管理范围内的 Everyone-Deny）。</summary>
    public static void Unprotect(string dir) => Apply(Normalize(dir), false, false);

    /// <summary>读取当前实际生效的保护状态（读 DACL 查询，不修改）。</summary>
    public static FolderLockState GetState(string dir)
    {
        var full = Normalize(dir);
        var sec = new DirectoryInfo(full).GetAccessControl();
        return ReadState(sec);
    }

    /// <summary>
    /// 工具自身写点专用解锁窗口：若路径受保护则临时摘除 → 执行 → finally 恢复原强度。
    /// 可重入（嵌套调用仅最外层摘/戴）；恢复失败静默（下轮启动自愈兜底），不让业务异常被掩盖。
    /// 并发边界：同路径多线程并发进入时深度计数会串行共享（B 可能透传执行而 A 尚未摘完锁），
    /// 非严格互斥——本工具为 GUI 单线程 + MCP 单请求串行的消费模型，此场景安全；勿在多线程热点路径使用。
    /// </summary>
    public static T WithUnlock<T>(string dir, Func<T> action)
    {
        var key = Normalize(dir);
        var depth = _unlockDepth.AddOrUpdate(key, 1, (_, d) => d + 1);
        if (depth > 1)
        {
            // 内层：最外层已摘锁，直接透传；计数必须对称回落，否则异常路径泄漏后窗口永久失效
            try { return action(); }
            finally { ReleaseDepth(key); }
        }

        FolderLockState prev;
        try { prev = GetState(key); }
        catch
        {
            ReleaseDepth(key);
            return action(); // 路径不存在/读 ACL 失败：无从谈起保护，直接执行
        }
        if (!prev.Any)
        {
            ReleaseDepth(key);
            return action();
        }

        // 摘锁失败（如 SetAccessControl 异常）不得泄漏深度计数：
        // 释放后继续执行业务（fail-open），业务将直接面对可能的拒绝访问，由调用方报错呈现
        try { Apply(key, false, false); }
        catch { ReleaseDepth(key); return action(); }

        try { return action(); }
        finally
        {
            try { Apply(key, prev.DenyDelete, prev.DenyWrite); }
            catch { /* 恢复失败：fail-open，留待启动自愈 */ }
            ReleaseDepth(key);
        }
    }

    /// <summary>解锁深度 -1（下限 0）：任何路径退出 WithUnlock 都必须经此对称归还。</summary>
    private static void ReleaseDepth(string key)
        => _unlockDepth.AddOrUpdate(key, 0, (_, d) => Math.Max(0, d - 1));

    /// <summary>WithUnlock 的 void 便捷重载。</summary>
    public static void WithUnlock(string dir, Action action)
        => WithUnlock<object?>(dir, () => { action(); return null; });

    /// <summary>
    /// 面向「任意子孙路径」的解锁窗口：从 path 自身向上逐级探测第一个仍带本工具 Deny 的祖先并对其包一层
    /// WithUnlock；整条链都未受锁则直接执行。Deny ACE 加在锁根、靠继承传播到子树——对子级目录摘锁无法
    /// 清除继承实例（实测 RemoveAccessRuleSpecific 只删显式规则），故深层写点必须定位到锁根本身再摘。
    /// </summary>
    public static T WithUnlockForPath<T>(string path, Func<T> action)
    {
        var probe = Normalize(path);
        while (probe.Length > 0)
        {
            bool locked;
            try { locked = GetState(probe).Any; }
            catch { locked = false; }   // 路径不存在/读 ACL 失败：视为未受锁，继续向上
            if (locked) return WithUnlock(probe, action);
            var parent = Path.GetDirectoryName(probe);
            if (string.IsNullOrEmpty(parent) || string.Equals(parent, probe, StringComparison.OrdinalIgnoreCase)) break;
            probe = parent;
        }
        return action();
    }

    /// <summary>WithUnlockForPath 的 void 便捷重载。</summary>
    public static void WithUnlockForPath(string path, Action action)
        => WithUnlockForPath<object?>(path, () => { action(); return null; });

    /// <summary>
    /// 启动自愈：对 desired 中每条路径幂等重建期望强度的 ACE；
    /// knownPaths 里不在 desired 中的（已从配置移除的旧条目）执行清扫。
    /// 单条失败不影响其余；返回逐条错误（空列表 = 全部成功）。
    /// </summary>
    public static List<string> SweepRepair(
        IEnumerable<(string Path, bool DenyDelete, bool DenyWrite)> desired,
        IEnumerable<string>? knownPaths = null)
    {
        var errors = new List<string>();
        var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (raw, dd, dw) in desired)
        {
            try
            {
                var p = Normalize(raw);
                if (p.Length == 0 || !Directory.Exists(p)) continue;
                wanted.Add(p);
                var cur = GetState(p);
                if (cur.DenyDelete == dd && cur.DenyWrite == dw) continue; // 已符合期望，免写
                Apply(p, dd, dw);
            }
            catch (Exception ex) { errors.Add($"{raw}: {ex.Message}"); }
        }
        if (knownPaths != null)
        {
            foreach (var raw in knownPaths)
            {
                try
                {
                    var p = Normalize(raw);
                    if (p.Length == 0 || wanted.Contains(p) || !Directory.Exists(p)) continue;
                    if (GetState(p).Any) Apply(p, false, false);   // 只清残留的本工具 Deny
                }
                catch (Exception ex) { errors.Add($"{raw}: {ex.Message}"); }
            }
        }
        return errors;
    }

    // ---------------- 核心实现 ----------------

    private static void Apply(string full, bool denyDelete, bool denyWrite)
    {
        var di = new DirectoryInfo(full);
        var sec = di.GetAccessControl();

        RemoveManagedRules(sec);
        if (denyDelete)
        {
            // 子树继承规则：拒绝删除/改名所有子文件与子目录
            sec.AddAccessRule(new FileSystemAccessRule(
                WorldSid, FileSystemRights.Delete,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Deny));
            // 目录自身：拒绝删除该目录本身 + 作为父目录删除子项（DELETE_CHILD 双保险）
            sec.AddAccessRule(new FileSystemAccessRule(
                WorldSid, DeleteRights,
                InheritanceFlags.None, PropagationFlags.NoPropagateInherit,
                AccessControlType.Deny));
        }
        if (denyWrite)
        {
            sec.AddAccessRule(new FileSystemAccessRule(
                WorldSid, WriteRights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Deny));
            // 目录自身：拒绝在其中新建/追加（CreateFiles 走父目录的 WriteData 检查）
            sec.AddAccessRule(new FileSystemAccessRule(
                WorldSid, WriteRights,
                InheritanceFlags.None, PropagationFlags.NoPropagateInherit,
                AccessControlType.Deny));
        }
        di.SetAccessControl(sec);
    }

    /// <summary>移除「身份=Everyone 且类型=Deny 且权限落在管理范围内」的规则（含继承传播来的实例）。</summary>
    private static void RemoveManagedRules(DirectorySecurity sec)
    {
        foreach (var rule in sec.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToList())
        {
            if (rule.AccessControlType != AccessControlType.Deny) continue;
            if (!IsWorldSid(rule.IdentityReference)) continue;
            // 只动管理范围内的权限位，绝不误删第三方 Deny
            if ((rule.FileSystemRights & (DeleteRights | WriteRights)) == 0) continue;
            sec.RemoveAccessRuleSpecific(rule);
        }
    }

    private static FolderLockState ReadState(DirectorySecurity sec)
    {
        var del = false;
        var wr = false;
        foreach (var rule in sec.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>())
        {
            if (rule.AccessControlType != AccessControlType.Deny) continue;
            if (!IsWorldSid(rule.IdentityReference)) continue;
            if ((rule.FileSystemRights & FileSystemRights.Delete) != 0) del = true;
            if ((rule.FileSystemRights & FileSystemRights.WriteData) != 0) wr = true;
        }
        return new FolderLockState(del, wr);
    }

    private static bool IsWorldSid(IdentityReference id)
    {
        try { return id.Equals(WorldSid); }
        catch (IdentityNotMappedException) { return false; }
    }

    private static string Normalize(string? p)
        => Path.TrimEndingDirectorySeparator((p ?? "").Trim());
}
