using FenPeiXiangMuZu.Models;
using System.IO;
using System.Linq;
using System.Text;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 无 UI 批量迁移：把项目区收藏的全部项目搬到「新建项目父目录\所属页签名\名称」层级结构
/// （与设置「新建项目/项目组时路径携带页签及集群层级」的落点规则一致）。
/// 复用 ConfigService / LinkRecordService / FolderLockService，数据一致性语义与 MainViewModel.RelocateCard 项目分支相同，
/// 但不做 UI 刷新（RebuildAllCards / SyncWatchers / 日志区）——供 --migrate-hierarchy 命令行模式调用。
/// </summary>
public static class HierarchyMigrator
{
    public static string RelocKey(string p) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));

    /// <summary>单条迁移结果：Note 为空 = 成功；否则为原因（以「跳过」或「失败」前缀区分）。</summary>
    public sealed record Item(string Src, string Dst, string Note);

    public sealed record Result(int Moved, int Skipped, int Failed, List<Item> Items);

    /// <param name="excludeRoots">排除的根路径集合（工具自身、exe 目录等，一律不搬）。</param>
    public static Result MigrateProjects(AppConfig cfg, ConfigService configSvc, LinkRecordService recSvc, IReadOnlyCollection<string> excludeRoots)
    {
        if (string.IsNullOrWhiteSpace(cfg.CreateProjectDir))
            throw new InvalidOperationException("未设置「新建项目父目录」（config.createProjectDir），无法确定迁移目标根。");

        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(cfg.CreateProjectDir!));
        var excludes = new HashSet<string>(excludeRoots.Select(RelocKey), StringComparer.OrdinalIgnoreCase);
        var items = new List<Item>();
        int moved = 0, skipped = 0, failed = 0;

        // 先构建不可变快照计划：搬迁过程中 SaveConfig→Normalize 会替换 tab.Projects 引用，
        // 不能边枚举 config 实时集合边修改（否则"Collection was modified"）。
        // 同路径可被收藏到多个页签：只搬一次，层级片段取首次出现的页签名。
        var plan = new List<(string Segment, string Src)>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var tab in cfg.ProjectTabs)
        {
            var segment = SafeSegment(tab.Name);
            if (segment == null) continue; // 页签名含非法路径字符：该页签整体不搬
            foreach (var p in tab.Projects)
            {
                if (string.IsNullOrWhiteSpace(p)) continue;
                var src = RelocKey(p);
                if (!seen.Add(src)) continue;
                plan.Add((segment, src));
            }
        }

        foreach (var (segment, src) in plan)
        {
            if (excludes.Contains(src))
            {
                items.Add(new Item(src, "", "跳过（排除根）"));
                skipped++;
                continue;
            }
            var dst = Path.Combine(root, segment, Path.GetFileName(src));
            var note = RelocateProject(src, dst, cfg, configSvc, recSvc);
            if (note == null) moved++;
            else if (note.StartsWith("跳过", StringComparison.Ordinal)) skipped++;
            else failed++;
            items.Add(new Item(src, dst, note ?? ""));
        }

        return new Result(moved, skipped, failed, items);
    }

    /// <summary>
    /// 无 UI 批量迁移：把项目组区收藏的全部项目组搬到「新建项目组父目录\所属页签名\名称」层级结构
    /// （与项目区 --migrate-hierarchy 对称，复用 MainViewModel.RelocateCard 项目组分支的数据一致性语义：
    /// 物理移动 + 账本 lib remap + junction 重建 + config 全引用 remap + ACL 重建 + 落盘）。
    /// </summary>
    /// <param name="excludeRoots">排除的路径集合（保持原位，一律不搬）。</param>
    public static Result MigrateGroups(AppConfig cfg, ConfigService configSvc, LinkRecordService recSvc, IReadOnlyCollection<string> excludeRoots)
    {
        if (string.IsNullOrWhiteSpace(cfg.CreateGroupDir))
            throw new InvalidOperationException("未设置「新建项目组父目录」（config.createGroupDir），无法确定迁移目标根。");

        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(cfg.CreateGroupDir!));
        var excludes = new HashSet<string>(excludeRoots.Select(RelocKey), StringComparer.OrdinalIgnoreCase);
        var items = new List<Item>();
        int moved = 0, skipped = 0, failed = 0;

        var plan = new List<(string Segment, string Src)>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var tab in cfg.GroupTabs)
        {
            var segment = SafeSegment(tab.Name);
            if (segment == null) continue;
            foreach (var g in tab.Groups)
            {
                if (string.IsNullOrWhiteSpace(g)) continue;
                var src = RelocKey(g);
                if (!seen.Add(src)) continue;
                plan.Add((segment, src));
            }
        }

        foreach (var (segment, src) in plan)
        {
            if (excludes.Contains(src))
            {
                items.Add(new Item(src, "", "跳过（排除根）"));
                skipped++;
                continue;
            }
            var dst = Path.Combine(root, segment, Path.GetFileName(src));
            // 同页签其余组的目标路径（同名组容器剥离用：组名==页签名时容器内可能已混入已搬入的兄弟组）
            var siblingDsts = plan
                .Where(p => string.Equals(p.Segment, segment, StringComparison.Ordinal)
                            && !string.Equals(p.Src, src, StringComparison.OrdinalIgnoreCase))
                .Select(p => Path.Combine(root, segment, Path.GetFileName(p.Src)))
                .ToList();
            var note = RelocateGroup(src, dst, cfg, configSvc, recSvc, siblingDsts);
            if (note == null) moved++;
            else if (note.StartsWith("跳过", StringComparison.Ordinal)) skipped++;
            else failed++;
            items.Add(new Item(src, dst, note ?? ""));
        }

        return new Result(moved, skipped, failed, items);
    }

    /// <summary>搬迁单个项目：物理移动 + 账本 project remap + config 全引用 remap + ACL 重建 + 落盘。成功返回 null。</summary>
    private static string? RelocateProject(string src, string dst, AppConfig cfg, ConfigService configSvc, LinkRecordService recSvc)
    {
        var oldNorm = RelocKey(src);
        var newNorm = RelocKey(dst);
        if (string.Equals(oldNorm, newNorm, StringComparison.OrdinalIgnoreCase)) return "跳过（已在目标位置）";
        var srcExists = Directory.Exists(src);
        var dstExists = Directory.Exists(newNorm) || File.Exists(newNorm);

        // 源已消失 + 层级目标已存在 = 上次搬迁成功但 config/link-record 未同步（如被旧内存配置回滚）：
        // 不移动，只补记引用并落盘（幂等，重复执行安全）。空文件系统差异 → 计入 moved 由上层显示为成功。
        if (!srcExists && dstExists)
        {
            var repairErr = RemapLinkRecord(recSvc, oldNorm, newNorm);
            if (repairErr != null) return $"失败（{repairErr}）";
            RemapConfigPaths(cfg, oldNorm, newNorm, groups: false);
            try { configSvc.SaveConfig(cfg); }
            catch (Exception ex) { return $"失败（补记 config: {ex.Message}）"; }
            return null;
        }

        if (!srcExists) return "跳过（源不存在）";
        if (dstExists) return "跳过（目标已存在同名）";
        if (!string.Equals(Path.GetPathRoot(src), Path.GetPathRoot(newNorm), StringComparison.OrdinalIgnoreCase))
            return "失败（跨盘不支持）";

        // 1. 记录原路径 ACL 保护状态（必须在摘锁窗口外读）
        bool aclDel = false, aclWr = false;
        try { var s = FolderLockService.GetState(src); aclDel = s.DenyDelete; aclWr = s.DenyWrite; }
        catch { }

        // 2. 建目标父目录 + 物理移动（受锁祖先自动摘锁）
        string? moveErr = null;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(newNorm)!);
            bool ok = FolderLockService.WithUnlockForPath(src, () =>
            {
                try { Directory.Move(src, newNorm); return true; }
                catch (Exception ex) { moveErr = ex.Message; return false; }
            });
            if (!ok) return $"失败（移动: {moveErr}）";
        }
        catch (Exception ex)
        {
            return $"失败（移动: {ex.Message}）";
        }

        // 3. 链接账本 project remap（项目搬家只改账本项目字段；junction 是其子项，随目录一并移动）
        var recErr = RemapLinkRecord(recSvc, oldNorm, newNorm);
        if (recErr != null)
            return $"失败（{recErr}，已移动但未更新账本: {newNorm}）";

        // 4. config 内全部路径引用 remap
        RemapConfigPaths(cfg, oldNorm, newNorm, groups: false);

        // 5. 原路径受 ACL 保护 → 对新路径重建保护（旧路径已消失，WithUnlock 只在旧路径恢复）
        if (aclDel || aclWr)
        {
            try { FolderLockService.Protect(newNorm, aclDel, aclWr); }
            catch { /* 启动自愈兜底 */ }
        }

        // 6. 落盘（原子写 + 跨进程锁）
        configSvc.SaveConfig(cfg);
        return null;
    }

    /// <summary>
    /// 搬迁单个项目组：物理移动 + 账本 lib remap + 指向旧路径的 junction 重建 + config 全引用 remap + ACL 重建 + 落盘。
    /// 与 MainViewModel.RelocateCard 项目组分支语义一致（项目组搬走后，别处项目下指向它的 junction 不会跟随，必须逐个重建）。
    /// 成功返回 null。
    /// </summary>
    private static string? RelocateGroup(string src, string dst, AppConfig cfg, ConfigService configSvc, LinkRecordService recSvc, List<string> siblingDsts)
    {
        var oldNorm = RelocKey(src);
        var newNorm = RelocKey(dst);
        if (string.Equals(oldNorm, newNorm, StringComparison.OrdinalIgnoreCase)) return "跳过（已在目标位置）";
        var srcExists = Directory.Exists(src);
        var dstExists = Directory.Exists(newNorm) || File.Exists(newNorm);

        if (!srcExists && dstExists)
        {
            var repairErr = RemapLinkRecordLib(recSvc, oldNorm, newNorm);
            if (repairErr != null) return $"失败（{repairErr}）";
            RemapConfigPaths(cfg, oldNorm, newNorm, groups: true);
            try { configSvc.SaveConfig(cfg); }
            catch (Exception ex) { return $"失败（补记 config: {ex.Message}）"; }
            return null;
        }

        if (!srcExists) return "跳过（源不存在）";
        if (dstExists) return "跳过（目标已存在同名）";
        if (!string.Equals(Path.GetPathRoot(src), Path.GetPathRoot(newNorm), StringComparison.OrdinalIgnoreCase))
            return "失败（跨盘不支持）";

        bool aclDel = false, aclWr = false;
        try { var s = FolderLockService.GetState(src); aclDel = s.DenyDelete; aclWr = s.DenyWrite; }
        catch { }

        string? moveErr = null;
        try
        {
            // 组名 == 页签名（如 游戏开发\游戏开发）时目标在源自身内部，"移入自身子目录"是非法操作：
            // 先把组平移到同盘临时名，在原组位置重建页签容器，再移入目标。
            var dstInsideSrc = newNorm.StartsWith(oldNorm + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            bool ok;
            if (dstInsideSrc)
            {
                var tmp = Path.Combine(Path.GetDirectoryName(oldNorm)!, $"__pending_{Path.GetFileName(newNorm)}_{Guid.NewGuid():N}");
                ok = FolderLockService.WithUnlockForPath(src, () =>
                {
                    try { Directory.Move(src, tmp); return true; }
                    catch (Exception ex) { moveErr = ex.Message; return false; }
                });
                if (ok)
                {
                    Directory.CreateDirectory(oldNorm); // 原组位置重建为页签容器
                    // 组名==页签名时，原组目录内往往"包裹"着同页签的兄弟组（如 游戏开发 内含 游戏开发_Cocos）：
                    // 必须先把它们剥离回重建的页签容器，否则会随组一并嵌套进「组\组\兄弟组」两层深，
                    // 而 config/link-record 中兄弟组引用仍是「容器\兄弟组」，落点与账本错位。
                    foreach (var sd in siblingDsts)
                    {
                        var siblingInTmp = Path.Combine(tmp, Path.GetFileName(sd));
                        if (!Directory.Exists(siblingInTmp)) continue;
                        try
                        {
                            FolderLockService.WithUnlockForPath(siblingInTmp, () =>
                            {
                                try { Directory.Move(siblingInTmp, sd); return true; }
                                catch { return false; }
                            });
                            // 兄弟组若在 config folderLock 登记了保护：随父目录整体移动时继承的 Deny ACE 已丢失，
                            // 剥离后对新落点重建（与主组第 5 步 Protect 语义一致）。
                            if (cfg.FolderLock is { } fl)
                            {
                                var it = fl.Items.FirstOrDefault(i =>
                                    string.Equals(RelocKey(i.TargetPath), RelocKey(sd), StringComparison.OrdinalIgnoreCase));
                                if (it != null)
                                {
                                    try { FolderLockService.Protect(sd, it.DenyDelete, it.DenyWrite); }
                                    catch { /* 启动自愈兜底 */ }
                                }
                            }
                        }
                        catch { /* 单项剥离失败不阻断主迁移；兄弟组后续按「已在目标位置」跳过，重启自愈可对齐 */ }
                    }
                    ok = FolderLockService.WithUnlockForPath(tmp, () =>
                    {
                        try { Directory.Move(tmp, newNorm); return true; }
                        catch (Exception ex) { moveErr = ex.Message; return false; }
                    });
                }
            }
            else
            {
                Directory.CreateDirectory(Path.GetDirectoryName(newNorm)!);
                ok = FolderLockService.WithUnlockForPath(src, () =>
                {
                    try { Directory.Move(src, newNorm); return true; }
                    catch (Exception ex) { moveErr = ex.Message; return false; }
                });
            }
            if (!ok) return $"失败（移动: {moveErr}）";
        }
        catch (Exception ex)
        {
            return $"失败（移动: {ex.Message}）";
        }

        var recErr = RemapLinkRecordLib(recSvc, oldNorm, newNorm);
        if (recErr != null)
            return $"失败（{recErr}，已移动但未更新账本: {newNorm}）";

        RemapConfigPaths(cfg, oldNorm, newNorm, groups: true);

        if (aclDel || aclWr)
        {
            try { FolderLockService.Protect(newNorm, aclDel, aclWr); }
            catch { }
        }

        configSvc.SaveConfig(cfg);
        return null;
    }

    private static void RemapListPath(List<string>? list, string oldNorm, string newNorm)
    {
        if (list == null) return;
        for (int i = 0; i < list.Count; i++)
            if (string.Equals(RelocKey(list[i]), oldNorm, StringComparison.OrdinalIgnoreCase))
                list[i] = newNorm;
    }

    /// <summary>把 link-record 中 project 指向旧路径的记录改指新路径。失败返回原因，成功返回 null。</summary>
    private static string? RemapLinkRecord(LinkRecordService recSvc, string oldNorm, string newNorm)
    {
        var recs = recSvc.LoadStrict();
        if (recs == null) return "链接账本读取失败";
        foreach (var r in recs)
            if (string.Equals(RelocKey(recSvc.ToAbsPath(r.Project)), oldNorm, StringComparison.OrdinalIgnoreCase))
                r.Project = recSvc.ToRelPath(newNorm);
        try { recSvc.Save(recs); }
        catch (Exception ex) { return "账本写盘: " + ex.Message; }
        return null;
    }

    /// <summary>
    /// 把 link-record 中 lib 指向旧路径的记录改指新路径，并把该记录名下仍指向旧路径的 junction 逐个重建到新路径。
    /// （项目组搬家后 junction 不会跟随，必须重建；与 MainViewModel.RelocateCard 项目组分支一致。）失败返回原因，成功返回 null。
    /// </summary>
    private static string? RemapLinkRecordLib(LinkRecordService recSvc, string oldNorm, string newNorm)
    {
        var recs = recSvc.LoadStrict();
        if (recs == null) return "链接账本读取失败";
        foreach (var r in recs)
        {
            if (!string.Equals(RelocKey(recSvc.ToAbsPath(r.Lib)), oldNorm, StringComparison.OrdinalIgnoreCase))
                continue;
            var proj = recSvc.ToAbsPath(r.Project);
            foreach (var n in r.GetLinkNames())
            {
                var lp = JunctionService.LinkPath(proj, n);
                string? tgt = null;
                try { tgt = JunctionService.ResolveTarget(lp); } catch { }
                if (tgt != null && string.Equals(RelocKey(tgt), oldNorm, StringComparison.OrdinalIgnoreCase))
                {
                    try { JunctionService.RemoveLink(proj, n); JunctionService.Create(lp, newNorm); }
                    catch { /* 单项链接重建失败不阻断整组；账本仍按新路径更新 */ }
                }
            }
            r.Lib = recSvc.ToRelPath(newNorm);
        }
        try { recSvc.Save(recs); }
        catch (Exception ex) { return "账本写盘: " + ex.Message; }
        return null;
    }

    /// <summary>config 内全部旧路径引用（页签/顶层快照/locked/SystemAttrib/文件夹锁/图标/标签色）重指向新路径。</summary>
    private static void RemapConfigPaths(AppConfig cfg, string oldNorm, string newNorm, bool groups)
    {
        if (groups)
            foreach (var t in cfg.GroupTabs) RemapListPath(t.Groups, oldNorm, newNorm);
        else
            foreach (var t in cfg.ProjectTabs) RemapListPath(t.Projects, oldNorm, newNorm);
        RemapListPath(cfg.Locked, oldNorm, newNorm);
        RemapListPath(cfg.SystemAttribByTool, oldNorm, newNorm);
        if (cfg.FolderLock is { } fl)
            foreach (var it in fl.Items)
                if (string.Equals(RelocKey(it.TargetPath), oldNorm, StringComparison.OrdinalIgnoreCase))
                    it.TargetPath = newNorm;
        foreach (var k in cfg.GuiFolderIcons.Keys.Where(k => string.Equals(RelocKey(k), oldNorm, StringComparison.OrdinalIgnoreCase)).ToList())
        {
            cfg.GuiFolderIcons[newNorm] = cfg.GuiFolderIcons[k];
            cfg.GuiFolderIcons.Remove(k);
        }
        foreach (var k in cfg.TagColors.Keys.Where(k => string.Equals(RelocKey(k), oldNorm, StringComparison.OrdinalIgnoreCase)).ToList())
        {
            cfg.TagColors[newNorm] = cfg.TagColors[k];
            cfg.TagColors.Remove(k);
        }
    }

    /// <summary>把页签名收敛为合法的单级目录片段；含非法路径字符、控制符、空白、"."、“..”时返回 null。</summary>
    private static string? SafeSegment(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var s = name!.Trim();
        if (s == "." || s == "..") return null;
        if (s.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return null;
        return s;
    }
}
