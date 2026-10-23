using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.ViewModels;
using System.IO;
using System.Text;
using System.Text.Json;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 数据层自检（不接触原目录，只用临时副本）：
/// 1) 读真实 config → 规范化 → 写临时副本 → 回读，校验字段结构（projectTabs[].projects / groupTabs[].groups / 顶层冗余快照）。
/// 2) 用真实 link-record 做 Load/Upsert/Remove/相对转换，全部在临时副本上进行。
/// 结果写入 outDir/_data-selfcheck-result.txt，返回是否全部通过。
/// </summary>
public static class DataSelfCheck
{
    public static bool Run(string configPath, string recordPath, string outDir)
    {
        var sb = new StringBuilder();
        void Line(string s) => sb.AppendLine(s);
        static bool EqP(string a, string b) => string.Equals(
            Path.TrimEndingDirectorySeparator(a), Path.TrimEndingDirectorySeparator(b), StringComparison.OrdinalIgnoreCase);
        var pass = true;
        void Check(bool ok, string msg) { pass &= ok; Line((ok ? "[PASS] " : "[FAIL] ") + msg); }

        Line($"== 数据层自检 ({DateTime.Now:yyyy-MM-dd HH:mm:ss}) ==");
        Line($"config: {configPath}");
        Line($"record: {recordPath}\n");

        Directory.CreateDirectory(outDir);

        // ---- 1. config 往返 ----
        var cfgSvc = new ConfigService(configPath);
        var cfg = cfgSvc.LoadConfig();
        Check(cfg.ProjectTabs.Count > 0, $"projectTabs 非空 (count={cfg.ProjectTabs.Count})");
        Check(cfg.GroupTabs.Count > 0, $"groupTabs 非空 (count={cfg.GroupTabs.Count})");

        // 强制活动页签访问，再写临时副本
        var tmpCfg = Path.Combine(outDir, "_roundtrip-config.json");
        var tmpCfgSvc = new ConfigService(tmpCfg);
        tmpCfgSvc.SaveConfig(cfg);
        var json = File.ReadAllText(tmpCfg);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var projTab = root.GetProperty("projectTabs")[0];
        Check(projTab.TryGetProperty("projects", out _), "projectTabs 项含关键字 projects");
        var grpTab = root.GetProperty("groupTabs")[0];
        Check(grpTab.TryGetProperty("groups", out _), "groupTabs 项含关键字 groups");
        Check(root.TryGetProperty("projects", out _) && root.TryGetProperty("groups", out _), "顶层含 projects/groups 冗余快照");
        var tabNames = string.Join(", ", cfg.ProjectTabs.Select(t => t.Name));
        Line($"   项目页签名: {tabNames}");
        var grpTabNames = string.Join(", ", cfg.GroupTabs.Select(t => t.Name));
        Line($"   项目组集群名: {grpTabNames}");

        // 回读一致性：字段值一致
        var cfg2 = tmpCfgSvc.LoadConfig();
        Check(cfg2.GroupTabs.Count == cfg.GroupTabs.Count && cfg2.ProjectTabs.Count == cfg.ProjectTabs.Count,
            "副本回读后页签数量一致");

        // ---- 2. link-record 往返（只动临时副本）----
        if (File.Exists(recordPath))
        {
            var baseRoot = cfg.LastLib is not null && Directory.Exists(cfg.LastLib)
                ? cfg.LastLib : new FileInfo(recordPath).Directory!.FullName;
            Line($"   相对路径基准 baseRoot: {baseRoot}");

            var tmpRec = Path.Combine(outDir, "_roundtrip-link-record.json");
            var svc = new LinkRecordService(baseRoot, tmpRec);

            // 用真实记录文件的内容建立临时副本（避免直接写原文件）
            List<LinkRecord> realRecs;
            try
            {
                realRecs = JsonSerializer.Deserialize<LinkRecordFile>(
                    File.ReadAllText(recordPath),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true })?.Links
                    ?? new List<LinkRecord>();
            }
            catch (Exception ex)
            {
                Line($"[WARN] link-record 解析失败，跳过记录往返测试: {ex.Message}");
                realRecs = new List<LinkRecord>();
            }
            svc.Save(realRecs);
            Check(realRecs.Count > 0, $"link-record 存在记录 (count={realRecs.Count})");

            // 相对→绝对 转换检查（baseRoot 有效时）
            if (realRecs.Count > 0)
            {
                var first = realRecs[0];
                var absProj = svc.ToAbsPath(first.Project);
                var absLib = svc.ToAbsPath(first.Lib);
                var relProj = svc.ToRelPath(absProj);
                var round = Path.GetFullPath(Path.Combine(baseRoot, relProj));
                Check(string.Equals(Path.GetFullPath(absProj), round, StringComparison.OrdinalIgnoreCase),
                    $"相对/绝对互转一致: {first.Project}");
            }

            // Upsert 一条不存在记录 → +1；Remove → 回原数
            var before = svc.Load().Count;
            var fake = Path.Combine(baseRoot, "_selfcheck__fake_project__");
            svc.Upsert(fake, Path.Combine(baseRoot, "_selfcheck__fake_lib__"), "自检", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            Check(svc.Load().Count == before + 1, "Upsert 新增 +1");
            Check(svc.Exists(fake), "Exists 命中新增");
            svc.Remove(fake);
            Check(svc.Load().Count == before, "Remove +Upsert 后数量还原");
            Check(!svc.Exists(fake), "移除后 Exists 为假");

            Line($"   最终临时记录条数: {svc.Load().Count}");
        }
        else
        {
            Check(true, "link-record 缺失，跳过记录测试");
        }

        // ---- 2.5 数据安全回归（A3/A4）：读失败必须中止写路径，绝不基于空数据覆盖旧文件 ----
        Line("\n== 数据安全 (A3/A4) ==");
        var safeRoot = outDir;   // 仅作相对化基准，无需真实存在
        var corruptRec = Path.Combine(outDir, "_corrupt-link-record.json");
        File.WriteAllText(corruptRec, "{ this is not valid json at all !!!");
        try
        {
            var corruptSvc = new LinkRecordService(safeRoot, corruptRec);
            Check(corruptSvc.LoadStrict() == null, "A3: LoadStrict 对彻底损坏文件返回 null（区别于不存在）");
            var upsertThrew = false;
            try
            {
                corruptSvc.Upsert(Path.Combine(safeRoot, "_selfcheck__p__"),
                    Path.Combine(safeRoot, "_selfcheck__g__"), "自检", "");
            }
            catch (Exception) { upsertThrew = true; }
            Check(upsertThrew, "A3: 账本损坏时 Upsert 抛错中止（不静默清空旧账本）");
            var removeThrew = false;
            try { corruptSvc.Remove(Path.Combine(safeRoot, "_selfcheck__p__")); }
            catch (Exception) { removeThrew = true; }
            Check(removeThrew, "A3: 账本损坏时 Remove 同样中止");
            Check(!File.Exists(corruptRec + ".tmp"), "A3: 中止后无半截 .tmp 残留");
            Check(corruptSvc.Load().Count == 0, "A3: 宽松 Load 仍按空列表兜底（纯展示调用不受阻）");
        }
        catch (Exception ex)
        {
            Check(false, "A3: 自检过程异常: " + ex.Message);
        }

        try
        {
            var corruptCfgPath = Path.Combine(outDir, "_corrupt-config.json");
            File.WriteAllText(corruptCfgPath, "{{{ broken config");
            var corruptCfgSvc = new ConfigService(corruptCfgPath);
            var fallback = corruptCfgSvc.LoadConfig();
            Check(fallback.ProjectTabs.Count > 0 && fallback.GroupTabs.Count > 0,
                "A4: config 损坏时按默认配置兜底启动");
            Check(corruptCfgSvc.LastLoadWarning != null, "A4: 损坏告警已写入 LastLoadWarning");
            var baks = Directory.GetFiles(outDir, "_corrupt-config.json.corrupt-*.bak");
            Check(baks.Length >= 1,   // outDir 复用时可能残留历史 bak，验证"至少生成一份现场备份"即可
                $"A4: 原文件已备份 .corrupt-*.bak ({Path.GetFileName(baks.FirstOrDefault() ?? "")})");
        }
        catch (Exception ex)
        {
            Check(false, "A4: 自检过程异常: " + ex.Message);
        }

        // ---- 3. UI 数据流：卡片/页签构建、单选互斥、切页签清选中、链接标记（只读原数据构造 VM，不写磁盘）----
        Line("\n== UI 数据流 ==");
        var uiBase = cfg.LastLib is not null && Directory.Exists(cfg.LastLib)
            ? cfg.LastLib
            : (File.Exists(recordPath) ? new FileInfo(recordPath).Directory!.FullName : Path.GetTempPath());
        var icons = new IconService();
        var uiRecSvc = new LinkRecordService(uiBase, recordPath);
        var vm = new MainViewModel(cfg, new ConfigService(Path.Combine(outDir, "_vm-config.json")), uiRecSvc, icons, outDir);

        Check(vm.ProjectTabs.Count == cfg.ProjectTabs.Count, $"ProjectTabs 页签数一致 ({vm.ProjectTabs.Count})");
        Check(vm.GroupTabs.Count == cfg.GroupTabs.Count, $"GroupTabs 页签数一致 ({vm.GroupTabs.Count})");
        var pc = vm.ProjectTabs.Sum(t => t.Items.Count);
        var gc = vm.GroupTabs.Sum(t => t.Items.Count);
        Check(pc + gc > 0, $"卡片构建总数: 项目 {pc} / 项目组 {gc}");
        Line($"   项目页签徽章: {string.Join(", ", vm.ProjectTabs.Select(t => $"{t.Name}={t.Count}"))}");
        Line($"   组页签徽章: {string.Join(", ", vm.GroupTabs.Select(t => $"{t.Name}={t.Count}"))}");

        var sample = vm.GroupTabs.SelectMany(t => t.Items).FirstOrDefault();
        if (sample != null)
            Line($"   示例卡 Kind={sample.Kind} Name={sample.DisplayName} Exists={sample.Exists} IsGrayed={sample.IsGrayed}");

        // 单选互斥（样本：任一页签中的首个非空收藏路径）
        var sampleGroupPath = cfg.GroupTabs.SelectMany(t => t.Groups).FirstOrDefault();
        var sampleProjectPath = cfg.ProjectTabs.SelectMany(t => t.Projects).FirstOrDefault();
        var g = sampleGroupPath != null ? vm.Find("group", sampleGroupPath) : null;
        var p = sampleProjectPath != null ? vm.Find("project", sampleProjectPath) : null;
        Check(sampleGroupPath == null || g != null, "Find 命中项目组卡");
        Check(sampleProjectPath == null || p != null, "Find 命中项目卡");
        if (g != null && p != null)
        {
            vm.SelectCard("group", g.FullPath);
            Check(g.IsSelected && ReferenceEquals(vm.SelectedCard, g) && vm.SelectedKind == "group",
                "选中项目组：自身高亮 + Selected 归一");
            Check(!p.IsSelected, "选中项目组后项目卡不高亮（互斥）");
            vm.SelectCard("project", p.FullPath);
            Check(p.IsSelected && !g.IsSelected && ReferenceEquals(vm.SelectedCard, p),
                "切选项目卡：前一组取消、仅项目选中");
        }

        // 切页签清选中
        if (g != null)
        {
            vm.SelectCard("group", g.FullPath);
            if (vm.GroupTabs.Count > 1)
            {
                vm.SwitchGroupTab(1);
                Check(!g.IsSelected && vm.SelectedCard == null, "切组页签后清除选中");
                if (p != null)
                {
                    vm.SelectCard("project", p.FullPath);
                    vm.SwitchProjectTab(Math.Min(1, vm.ProjectTabs.Count - 1));
                    Check(!p.IsSelected && vm.SelectedCard == null, "切项目页签后清除选中");
                }
            }
            else Check(true, "仅一个组页签，跳过切页签清选中");
        }

        // 链接标记：由真实 junction 状态实时推导（只读 .opencode 重解析点，不读写 link-record）
        var linkProjects = vm.ProjectTabs.SelectMany(t => t.Items).Count(c => c.HasLink);
        var linkGroups = vm.GroupTabs.SelectMany(t => t.Items).Count(c => c.HasLink);
        Line($"   带链接标记: 项目卡 {linkProjects} / 项目组卡 {linkGroups}");
        // 真实校验：VM 构建后 Load 可正常执行且不抛异常（只读不写原文件）
        try
        {
            var recCount = uiRecSvc.Load().Count;
            Line($"   LinkRecordService.Load 只读成功: count={recCount}");
            Check(true, "LinkRecordService.Load 可正常读取（只读不写原文件）");
        }
        catch (Exception ex)
        {
            Check(false, "LinkRecordService.Load 抛出异常: " + ex.Message);
        }

        // ---- 4. 交互命令（保守子集：仅写 tmp config，不建真 junction、不碰原目录）----
        Line("\n== 交互命令 ==");
        var tmpCfgPath = Path.Combine(outDir, "_vm-config.json");
        var lockSamplePath = cfg.GroupTabs.SelectMany(t => t.Groups).FirstOrDefault()
            ?? cfg.ProjectTabs.SelectMany(t => t.Projects).FirstOrDefault();
        var gcard = lockSamplePath != null ? (vm.Find("group", lockSamplePath) ?? vm.Find("project", lockSamplePath)) : null;
        if (gcard != null)
        {
            vm.SelectCard(gcard.Kind, gcard.FullPath);
            // LockToggle 现为弹窗交互入口，自检改测其核心落盘逻辑 ApplyAcl/RemoveAllProtection：
            // 仅固定档（denyDelete=false）对真实目录只做幂等清扫，无破坏性；config 写入走 tmp。
            var e1 = vm.ApplyAcl(gcard, denyDelete: false, denyWrite: false, watchAlerts: true);
            Check(e1 == null, "ApplyAcl(仅固定) 执行成功" + (e1 == null ? "" : ": " + e1));
            var lc1 = new ConfigService(tmpCfgPath).LoadConfig();
            Check(lc1.Locked.Any(x => EqP(x, gcard.FullPath)),
                "ApplyAcl 将选中文件夹加入 config.Locked（账面固定强制联动）");
            Check(lc1.FolderLock?.Items.Any(i => EqP(i.TargetPath, gcard.FullPath)) == true,
                "ApplyAcl 在 folderLock.items 登记");
            var e2 = vm.RemoveAllProtection(gcard.FullPath, gcard);
            Check(e2 == null, "RemoveAllProtection 执行成功" + (e2 == null ? "" : ": " + e2));
            var lc2 = new ConfigService(tmpCfgPath).LoadConfig();
            Check(!lc2.Locked.Any(x => EqP(x, gcard.FullPath)),
                "RemoveAllProtection 从 config.Locked 移除并清理 items");
        }
        else Check(lockSamplePath == null, "无任何收藏路径样本，跳过 ACL 自检");

        // ACL 系统级往返（TEMP 探针目录，不碰用户数据）：Protect → 拒删 → WithUnlock 可删且恢复 → Unprotect
        try
        {
            var aclDir = Path.Combine(outDir, "_acl-probe");
            Directory.CreateDirectory(aclDir);
            FolderLockService.Protect(aclDir, denyDelete: true, denyWrite: false);
            var st1 = FolderLockService.GetState(aclDir);
            Check(st1.DenyDelete && !st1.DenyWrite, "ACL Protect(denyDelete) 后 GetState 读回一致");

            var probeFile = Path.Combine(aclDir, "probe.txt");
            File.WriteAllText(probeFile, "x");
            var delDenied = false;
            try { File.Delete(probeFile); }
            catch (UnauthorizedAccessException) { delDenied = true; }
            catch (IOException) { delDenied = true; }
            Check(delDenied, "防删除档下删除子文件被系统拒绝");

            var unlockedDel = FolderLockService.WithUnlock(aclDir, () =>
            {
                File.Delete(probeFile);
                return !File.Exists(probeFile);
            });
            Check(unlockedDel, "WithUnlock 解锁窗口内可正常删除");
            Check(FolderLockService.GetState(aclDir).DenyDelete, "WithUnlock 结束后保护自动恢复");

            // P0-1 回归：嵌套 WithUnlock 内层抛异常 → 深度计数必须对称回落，
            // 否则后续外层窗口退化为透传、工具被自己的锁拦截
            var nestedThrew = false;
            try
            {
                FolderLockService.WithUnlock(aclDir, () =>
                    FolderLockService.WithUnlock(aclDir, () => { throw new InvalidOperationException("probe"); }));
            }
            catch (InvalidOperationException) { nestedThrew = true; }
            Check(nestedThrew, "嵌套 WithUnlock 异常按预期向上传播");
            File.WriteAllText(probeFile, "y");
            var afterNested = FolderLockService.WithUnlock(aclDir, () =>
            {
                File.Delete(probeFile);
                return !File.Exists(probeFile);
            });
            Check(afterNested, "嵌套异常后解锁窗口未失效（深度计数无泄漏）");

            // 防写入档回归：denyWrite 下外部写入被拒，WithUnlock 窗口内可写且锁恢复
            FolderLockService.Protect(aclDir, denyDelete: false, denyWrite: true);
            var writeDenied = false;
            try { File.WriteAllText(Path.Combine(aclDir, "w.txt"), "x"); }
            catch (UnauthorizedAccessException) { writeDenied = true; }
            catch (IOException) { writeDenied = true; }
            Check(writeDenied, "防写入档下新建文件被系统拒绝");
            var wroteInWindow = FolderLockService.WithUnlock(aclDir, () =>
            {
                File.WriteAllText(Path.Combine(aclDir, "w.txt"), "x");
                return File.Exists(Path.Combine(aclDir, "w.txt"));
            });
            Check(wroteInWindow, "防写入档下 WithUnlock 窗口内可正常写入");
            var stW = FolderLockService.GetState(aclDir);
            Check(stW.DenyWrite && !stW.DenyDelete, "防写入档写入窗口结束后保护自动恢复");

            FolderLockService.Unprotect(aclDir);
            Directory.Delete(aclDir, true);
            Check(true, "ACL Unprotect 后探针目录可整体清除");
        }
        catch (Exception ex)
        {
            // ACL 需要对目录持有写 DAC 权限；极端受限环境降级为提示而非失败
            Check(false, "ACL 往返异常: " + ex.Message);
        }

        // AddFavorite：把一个真实、但通常不在项目收藏的项目组路径加入活动项目页签
        var addPath = lockSamplePath;
        var dup = addPath != null && cfg.ProjectTabs.Any(t => t.Projects.Any(p => EqP(p, addPath)));
        if (addPath != null && !dup)
        {
            vm.TargetPath = addPath;
            vm.AddFavorite("project");
            var pa = vm.ActiveProjectTabIndex;   // 自检已切过页签，取当前活动的项目页签
            var ac = new ConfigService(tmpCfgPath).LoadConfig();
            Check(ac.ProjectTabs[pa].Projects.Any(p => EqP(p, addPath)),
                "AddFavorite('project') 将 TargetPath 加入活动项目页签并落盘(tmp)");
            if (pa != 0) Line($"   校验基于活动页签索引 {pa}（此前切页签自检已生效）");
        }
        else Line("   跳过 AddFavorite 校验（该路径已在项目收藏）");

        Line($"\n== 结果: {(pass ? "全部通过" : "存在失败")} ==");
        var resultFile = Path.Combine(outDir, "_data-selfcheck-result.txt");
        File.WriteAllText(resultFile, sb.ToString(), new UTF8Encoding(false));
        return pass;
    }
}