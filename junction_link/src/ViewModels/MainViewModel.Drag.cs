using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>
/// 「拖拽交互」的数据侧逻辑（同 partial，可访问 private 成员）。
/// 提供页签重排、卡片页签内重排、卡片跨页签移动的纯排序方法，
/// 只改 config + VM 侧集合 + 全量卡片池，不触碰 UI。
/// </summary>
public sealed partial class MainViewModel
{
    // ---------------- 页签重排（MoveTab） ----------------

    /// <summary>把某类页签从 fromIdx 移到 toIdx（kind: "group"/"project"）。</summary>
    public void MoveTab(string kind, int fromIdx, int toIdx)
    {
        if (kind == "group") MoveTabFor(_config.GroupTabs, GroupTabs, _activeGroupTabIndex, "ActiveGroupTabIndex", fromIdx, toIdx);
        else MoveTabFor(_config.ProjectTabs, ProjectTabs, _activeProjectTabIndex, "ActiveProjectTabIndex", fromIdx, toIdx);
    }

    private void MoveTabFor<T>(
        List<T> cfgTabs,
        ObservableCollection<TabViewModel> vmTabs,
        int oldActive,
        string activeProp,
        int fromIdx,
        int toIdx)
    {
        if (fromIdx < 0 || fromIdx >= cfgTabs.Count) return;
        toIdx = Math.Clamp(toIdx, 0, cfgTabs.Count - 1);
        if (fromIdx == toIdx) return;

        string tabName = vmTabs[fromIdx].Name;   // 移动前先取页签名，供日志使用

        // config 列表 + VM 页签集合同步搬移（保持同一批 TabViewModel 实例）
        var item = cfgTabs[fromIdx];
        cfgTabs.RemoveAt(fromIdx);
        cfgTabs.Insert(toIdx, item);

        // Move 而非 Remove+Insert：保留 ItemsControl 已生成的容器实例，
        // AnimatedStackPanel 才能追踪旧位置并播放 0.25s 让位滑动
        vmTabs.Move(fromIdx, toIdx);

        // 活动索引纠偏（以旧的 active 索引推算）
        int newActive = AdjustActiveIndex(fromIdx, toIdx, oldActive);
        if (activeProp == "ActiveGroupTabIndex") ActiveGroupTabIndex = newActive;
        else ActiveProjectTabIndex = newActive;
        if (activeProp == "ActiveGroupTabIndex") _config.ActiveGroupTabIndex = newActive;
        else _config.ActiveProjectTabIndex = newActive;

        // 页签位置已变 → 重设 Activate 回调（原回调捕获的是构造函数时的旧索引）与 IsActive
        RewireTabActivations(vmTabs, newActive);

        _configSvc.SaveConfig(_config);
        Log($"页签重排：{TabKindLabel(activeProp == "ActiveGroupTabIndex" ? "group" : "project")}「{tabName}」第 {fromIdx + 1} 位 → 第 {toIdx + 1} 位");
    }

    /// <summary>按当前已移动后的页签顺序重设每个页签的 Activate 回调（绑定当前索引）并刷新高亮。</summary>
    private void RewireTabActivations(ObservableCollection<TabViewModel> vmTabs, int activeIdx)
    {
        for (int i = 0; i < vmTabs.Count; i++)
        {
            int idx = i;
            if (ReferenceEquals(vmTabs, GroupTabs)) vmTabs[i].Activate = () => SwitchGroupTab(idx);
            else vmTabs[i].Activate = () => SwitchProjectTab(idx);
            vmTabs[i].IsActive = idx == activeIdx;
        }
    }

    /// <summary>元素从 fromIdx 移到 toIdx 后，旧的 active 索引对应到的新索引。</summary>
    private static int AdjustActiveIndex(int fromIdx, int toIdx, int oldActive)
    {
        if (oldActive == fromIdx) return toIdx;
        if (fromIdx < toIdx && oldActive > fromIdx && oldActive <= toIdx) return oldActive - 1;
        if (fromIdx > toIdx && oldActive >= toIdx && oldActive < fromIdx) return oldActive + 1;
        return oldActive;
    }

    /// <summary>页签类别显示名：项目组集群页签叫「集群」，项目页签叫「项目页签」。</summary>
    private static string TabKindLabel(string kind) => kind == "group" ? "集群" : "项目页签";

    // ---------------- 卡片：页签内重排 + 跨页签移动 ----------------

    /// <summary>页签内卡片重排：把 tabIdx 页签中 FullPath 匹配的卡片移到 toIndex 位置。</summary>
    public void ReorderCards(string kind, int tabIdx, string cardFullPath, int toIndex)
    {
        if (kind == "group")
            ReorderCardsFor(_config.GroupTabs, GroupTabs, _allGroupCards, t => t.Groups, tabIdx, cardFullPath, toIndex, "项目组");
        else
            ReorderCardsFor(_config.ProjectTabs, ProjectTabs, _allProjectCards, t => t.Projects, tabIdx, cardFullPath, toIndex, "项目");
    }

    private void ReorderCardsFor<T>(
        List<T> cfgTabs,
        ObservableCollection<TabViewModel> vmTabs,
        List<FolderCardViewModel> allCards,
        Func<T, List<string>> getter,
        int tabIdx,
        string cardFullPath,
        int toIndex,
        string label)
    {
        if (tabIdx < 0 || tabIdx >= cfgTabs.Count) return;
        var list = getter(cfgTabs[tabIdx]);
        string key = TrimEnd(cardFullPath);
        int fromIdx = list.FindIndex(p => string.Equals(TrimEnd(p), key, StringComparison.OrdinalIgnoreCase));
        if (fromIdx < 0 || fromIdx == toIndex) return;
        int len = list.Count;
        toIndex = Math.Clamp(toIndex, 0, len);   // 允许 0..len（len 表示追加到末尾）

        string path = list[fromIdx];
        list.RemoveAt(fromIdx);
        // 先移除再插入：目标位在源位之后时，移除后该位置左移一位，需减 1 才能落到指示条所示位置
        int insertAt = fromIdx < toIndex ? toIndex - 1 : toIndex;
        int finalIdx = Math.Min(insertAt, len - 1);
        list.Insert(finalIdx, path);

        var items = vmTabs[tabIdx].Items;
        var card = items.FirstOrDefault(c => string.Equals(TrimEnd(c.FullPath), key, StringComparison.OrdinalIgnoreCase));
        if (card != null)
        {
            int vmFrom = items.IndexOf(card);
            items.RemoveAt(vmFrom);
            int vmInsert = vmFrom < toIndex ? toIndex - 1 : toIndex;
            items.Insert(Math.Clamp(vmInsert, 0, items.Count), card);
        }

        // 全量卡片池索引纠偏：仅移动当前实例（同路径多页签时按路径 RemoveAll 会误删其他页签的同路径卡）
        if (card != null)
        {
            allCards.Remove(card);
            allCards.Insert(Math.Clamp(insertAt, 0, allCards.Count), card);
        }

        _configSvc.SaveConfig(_config);
        Log($"{label}「{Path.GetFileName(TrimEnd(path))}」重排：第 {fromIdx + 1} 位 → 第 {finalIdx + 1} 位（{TabKindLabel(vmTabs[tabIdx].Kind)}「{vmTabs[tabIdx].Name}」）");
    }

    /// <summary>把某收藏卡片从 fromTabIdx 页签移动到 toTabIdx 页签的 toIndex 位置（config + VM + 全量池同步，存盘）。</summary>
    public void MoveCardToTab(string kind, int fromTabIdx, int toTabIdx, string cardFullPath, int toIndex)
    {
        if (kind == "group")
            MoveCardToTabFor(_config.GroupTabs, GroupTabs, _allGroupCards, t => t.Groups, fromTabIdx, toTabIdx, cardFullPath, toIndex, "项目组");
        else
            MoveCardToTabFor(_config.ProjectTabs, ProjectTabs, _allProjectCards, t => t.Projects, fromTabIdx, toTabIdx, cardFullPath, toIndex, "项目");
    }

    private void MoveCardToTabFor<T>(
        List<T> cfgTabs,
        ObservableCollection<TabViewModel> vmTabs,
        List<FolderCardViewModel> allCards,
        Func<T, List<string>> getter,
        int fromTabIdx,
        int toTabIdx,
        string cardFullPath,
        int toIndex,
        string label)
    {
        if (fromTabIdx < 0 || fromTabIdx >= cfgTabs.Count) return;
        if (toTabIdx < 0 || toTabIdx >= cfgTabs.Count) return;
        string key = TrimEnd(cardFullPath);

        // config：源页签移除，目标页签按 toIndex 插入
        var srcList = getter(cfgTabs[fromTabIdx]);
        int cfgIdx = srcList.FindIndex(p => string.Equals(TrimEnd(p), key, StringComparison.OrdinalIgnoreCase));
        if (cfgIdx < 0) return;
        string path = srcList[cfgIdx];
        srcList.RemoveAt(cfgIdx);

        var dstList = getter(cfgTabs[toTabIdx]);
        toIndex = Math.Clamp(toIndex, 0, dstList.Count);
        dstList.Insert(toIndex, path);

        // VM：源页签 Items 移除，目标页签 Items 插入；若同页签则等价于页签内重排
        var srcItems = vmTabs[fromTabIdx].Items;
        var card = srcItems.FirstOrDefault(c => string.Equals(TrimEnd(c.FullPath), key, StringComparison.OrdinalIgnoreCase));
        if (card != null)
        {
            srcItems.Remove(card);
            var dstItems = vmTabs[toTabIdx].Items;
            dstItems.Insert(Math.Clamp(toIndex, 0, dstItems.Count), card);
        }

        // 全量卡片池索引纠偏：仅移动当前实例（同路径多页签时按路径 RemoveAll 会误删其他页签的同路径卡）
        if (card != null)
        {
            allCards.Remove(card);
            allCards.Insert(Math.Clamp(toIndex, 0, allCards.Count), card);
        }

        _configSvc.SaveConfig(_config);
        Log($"{label}「{Path.GetFileName(TrimEnd(path))}」：{TabKindLabel(vmTabs[fromTabIdx].Kind)}「{vmTabs[fromTabIdx].Name}」→ {TabKindLabel(vmTabs[toTabIdx].Kind)}「{vmTabs[toTabIdx].Name}」");
    }

    /// <summary>跨类别移动收藏卡片：从 fromKind 的某分框移到 dstKind 的 dstTabIdx 页签（项目组⇄项目 互相拖动）。
    /// 开启「移动文件夹」设置时先按目标根目录物理搬家（失败中止整个移动），config+VM+全量池同步，存盘。</summary>
    public void MoveCardAcross(string fromKind, string cardFullPath, string dstKind, int dstTabIdx, int toIndex)
    {
        string key = TrimEnd(cardFullPath);

        // 新增：跨类别移动前先把文件夹物理搬到目标根目录（项目→项目组根、项目组→项目根）
        if (_config.MoveFolderOnCrossMove)
        {
            var err = TryRelocateCrossMove(fromKind, key, dstKind, out var relocated);
            if (err != null)
            {
                Message = "跨类别移动失败：" + err;
                Log("跨类别移动失败：" + err, true);
                return;
            }
            key = relocated;
        }

        string srcTabName;

        if (fromKind == "group")
        {
            // project 组分框全部可见且活动页签与卡片所在分框无关——按路径定位实际源分框
            int srcIdx = FindTabIndex(_config.GroupTabs, t => t.Groups, key);
            if (srcIdx < 0) return;
            srcTabName = GroupTabs[srcIdx].Name;
            RemoveCardFromTab(_config.GroupTabs[srcIdx].Groups, GroupTabs[srcIdx].Items, _allGroupCards, key);
        }
        else
        {
            int srcIdx = FindTabIndex(_config.ProjectTabs, t => t.Projects, key);
            if (srcIdx < 0) return;
            srcTabName = ProjectTabs[srcIdx].Name;
            RemoveCardFromTab(_config.ProjectTabs[srcIdx].Projects, ProjectTabs[srcIdx].Items, _allProjectCards, key);
        }

        string dstTabName;
        if (dstKind == "group")
        {
            if (dstTabIdx < 0 || dstTabIdx >= GroupTabs.Count) return;
            dstTabName = GroupTabs[dstTabIdx].Name;
        }
        else
        {
            if (dstTabIdx < 0 || dstTabIdx >= ProjectTabs.Count) return;
            dstTabName = ProjectTabs[dstTabIdx].Name;
        }
        if (dstKind == "group")
            InsertCardInto(_config.GroupTabs[dstTabIdx].Groups, GroupTabs[dstTabIdx].Items, _allGroupCards, "group", key, toIndex);
        else
            InsertCardInto(_config.ProjectTabs[dstTabIdx].Projects, ProjectTabs[dstTabIdx].Items, _allProjectCards, "project", key, toIndex);

        _configSvc.SaveConfig(_config);
        Log($"{(fromKind == "group" ? "项目组" : "项目")}「{Path.GetFileName(key)}」：{TabKindLabel(fromKind)}「{srcTabName}」→ {TabKindLabel(dstKind)}「{dstTabName}」");
    }

    /// <summary>
    /// 跨类别移动时的物理搬家：项目→项目组搬到「新建项目组父目录」、项目组→项目搬到「新建项目父目录」。
    /// 返回 null 表示成功（out newPath 为搬家后的路径，未搬家时等于原路径）；返回错误文案表示中止整个移动。
    /// 根目录未配置/不存在/文件夹已在目标根内/目标同名已存在等"无需搬"情形跳过物理移动（仅转类别）并以日志提示。
    /// </summary>
    private string? TryRelocateCrossMove(string fromKind, string oldPath, string dstKind, out string newPath)
    {
        newPath = oldPath;
        var kindLabel = dstKind == "group" ? "项目组" : "项目";
        var root = dstKind == "group" ? _config.CreateGroupDir : _config.CreateProjectDir;
        if (string.IsNullOrWhiteSpace(root))
        {
            Log($"[搬家] 「{kindLabel}」根目录未设置，跳过物理移动（仅移动卡片）", true);
            return null;
        }
        if (!Directory.Exists(root))
        {
            Log($"[搬家] 「{kindLabel}」根目录不存在，跳过物理移动（仅移动卡片）: {root}", true);
            return null;
        }

        var oldNorm = RelocKey(oldPath);
        var name = Path.GetFileName(oldNorm);
        if (string.IsNullOrEmpty(name)) return null;
        if (!Directory.Exists(oldNorm))
        {
            Log($"[搬家] 源文件夹不存在，跳过物理移动（仅移动卡片）: {oldNorm}", true);
            return null;
        }

        var newNorm = RelocKey(Path.Combine(Path.GetFullPath(root), name));
        if (string.Equals(oldNorm, newNorm, StringComparison.OrdinalIgnoreCase)) return null;   // 已就位

        // 搬家范围（设置「基础设置→搬家范围」）：
        // defaultRoots        = 仅默认根目录（项目/项目组根）下的卡片才搬；已在目标根内嵌套的保持原位
        // defaultRootsFlatten = 仅默认根目录下的卡片才搬；嵌套在默认根内的层级路径也扁平化搬到目标根
        // anywhere            = 任意位置的卡片都搬（嵌套在目标根内的也扁平化）
        bool underAnyDefaultRoot = IsUnderAnyDefaultRoot(oldNorm);
        bool underTargetRoot = IsUnder(root, oldNorm);
        switch (_config.MoveFolderScope)
        {
            case "defaultRoots":
                if (!underAnyDefaultRoot)
                {
                    Log($"[搬家] 卡片不在默认根目录（项目/项目组根）下，按「搬家范围」设置跳过物理移动（仅移动卡片）: {oldNorm}", true);
                    return null;
                }
                if (underTargetRoot)
                {
                    Log($"[搬家] 文件夹已在「{kindLabel}」根目录内，按「搬家范围」设置保持原位（仅移动卡片）: {oldNorm}", true);
                    return null;
                }
                break;
            case "defaultRootsFlatten":
                if (!underAnyDefaultRoot)
                {
                    Log($"[搬家] 卡片不在默认根目录（项目/项目组根）下，按「搬家范围」设置跳过物理移动（仅移动卡片）: {oldNorm}", true);
                    return null;
                }
                break;
            default:   // anywhere
                break;
        }

        if (Directory.Exists(newNorm) || File.Exists(newNorm))
        {
            Log($"[搬家] 目标位置已存在同名文件夹，跳过物理移动（仅移动卡片）: {newNorm}", true);
            return null;
        }

        var card = FindCardByPath(fromKind, oldNorm);
        if (card == null) return $"未找到卡片实例: {oldNorm}";
        var err = RelocateCard(card, oldNorm, newNorm, folderNameChanged: false);
        if (err != null) return err;
        newPath = newNorm;
        return null;
    }

    /// <summary>按完整路径在对应类别的全量卡片池中定位卡片实例；找不到返回 null。</summary>
    private FolderCardViewModel? FindCardByPath(string kind, string path)
    {
        var pool = kind == "group" ? _allGroupCards : _allProjectCards;
        var key = RelocKey(path);
        return pool.FirstOrDefault(c => string.Equals(RelocKey(c.FullPath), key, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>路径是否位于项目/项目组默认根目录之下（任一为真即符合；某根未配置则跳过该根判断）。</summary>
    private bool IsUnderAnyDefaultRoot(string path)
    {
        var c = RelocKey(path);
        var proj = _config.CreateProjectDir;
        var grp = _config.CreateGroupDir;
        return (!string.IsNullOrWhiteSpace(proj) && IsUnder(proj, c))
            || (!string.IsNullOrWhiteSpace(grp) && IsUnder(grp, c));
    }

    /// <summary>判断 child 是否位于 parent 目录之下（含直接子级；不把 parent 本身算入）。</summary>
    private static bool IsUnder(string parent, string child)
    {
        var p = RelocKey(parent);
        var c = RelocKey(child);
        return c.StartsWith(p + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>在页签列表中定位含指定路径卡片的页签索引；找不到返回 -1。</summary>
    private static int FindTabIndex<T>(List<T> cfgTabs, Func<T, List<string>> getter, string key)
    {
        for (int i = 0; i < cfgTabs.Count; i++)
            if (getter(cfgTabs[i]).Any(p => string.Equals(TrimEnd(p), key, StringComparison.OrdinalIgnoreCase)))
                return i;
        return -1;
    }

    private void RemoveCardFromTab(
        List<string> cfgList,
        ObservableCollection<FolderCardViewModel> vmItems,
        List<FolderCardViewModel> allPool,
        string key)
    {
        int cfgIdx = cfgList.FindIndex(p => string.Equals(TrimEnd(p), key, StringComparison.OrdinalIgnoreCase));
        if (cfgIdx >= 0) cfgList.RemoveAt(cfgIdx);
        var card = vmItems.FirstOrDefault(c => string.Equals(TrimEnd(c.FullPath), key, StringComparison.OrdinalIgnoreCase));
        if (card != null)
        {
            vmItems.Remove(card);
            allPool.Remove(card);
        }
    }

    private void InsertCardInto(
        List<string> cfgList,
        ObservableCollection<FolderCardViewModel> vmItems,
        List<FolderCardViewModel> allPool,
        string cardKind,
        string key,
        int toIndex)
    {
        toIndex = Math.Clamp(toIndex, 0, cfgList.Count);
        cfgList.Insert(toIndex, key);
        var card = MakeCard(cardKind, key);
        RefreshCardValidity(card);   // 新建卡立即补齐存在性/链接徽章
        vmItems.Insert(Math.Clamp(toIndex, 0, vmItems.Count), card);
        allPool.Insert(Math.Clamp(toIndex, 0, allPool.Count), card);
    }
}