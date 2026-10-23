using System.IO;
using System.Windows;
using System.Windows.Input;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>
/// 页签管理模块（parallel partial）：新增/重命名/删除页签 + 快速链接开关。
/// 不改动主文件状态，仅负责把 _config 的 GroupTabs/ProjectTabs 同步到 VM 页签集合，
/// 并在改动后保存。所有会改动页签集合的操作都走 RebuildTabs（全量重建）以保持
/// VM <-> config 一致，且复用 Switch-*Tab / SyncActiveTabs / ClearAllSelection 的
/// 单选与切换清选中语义，不破坏 Init 逻辑。
/// </summary>
public sealed partial class MainViewModel
{
    // ---------------- 快速链接开关（对应 config.quickLink） ----------------

    /// <summary>快速链接开关；写入即存盘并通知绑定（UI 开关/CheckBox 绑定入口）。</summary>
    public bool QuickLink
    {
        get => _config.QuickLink;
        set
        {
            if (_config.QuickLink == value) return;
            _config.QuickLink = value;
            Raise(nameof(QuickLink));
            _configSvc.SaveConfig(_config);
        }
    }

    private ICommand? _quickLinkCommand;
    public ICommand QuickLinkCommand => _quickLinkCommand ??= new RelayCommand(_ => QuickLink = !QuickLink);

    // ---------------- 页签新增 ----------------

    /// <summary>新增一个项目组集群，并切换到新页签。</summary>
    public void AddGroupTab()
    {
        var name = UniqueTabName(_config.GroupTabs.Select(t => t.Name), "新项目组集群");
        _config.GroupTabs.Add(new GroupTab { Name = name });
        RebuildTabs("group");
        ActiveGroupTabIndex = _config.GroupTabs.Count - 1; // 切到新页签
        _config.ActiveGroupTabIndex = ActiveGroupTabIndex;   // 同步 config 活动索引：顶层冗余快照按它取页签（N1）
        SyncActiveTabs();
        _configSvc.SaveConfig(_config);
        Log($"已新增项目组集群: {name}");
    }

    /// <summary>新增一个项目页签，并切换到新页签。</summary>
    public void AddProjectTab()
    {
        var name = UniqueTabName(_config.ProjectTabs.Select(t => t.Name), "新页签");
        _config.ProjectTabs.Add(new ProjectTab { Name = name });
        RebuildTabs("project");
        ActiveProjectTabIndex = _config.ProjectTabs.Count - 1; // 切到新页签
        _config.ActiveProjectTabIndex = ActiveProjectTabIndex;   // 同步 config 活动索引（N1）
        SyncActiveTabs();
        _configSvc.SaveConfig(_config);
        Log($"已新增项目页签: {name}");
    }

    // ---------------- 页签重命名 ----------------

    /// <summary>重命名指定索引的项目组集群；空名或同集合内重名返回 false 不保存。</summary>
    public bool RenameGroupTab(int index, string newName)
    {
        if (index < 0 || index >= _config.GroupTabs.Count) return false;
        var name = (newName ?? "").Trim();
        if (name.Length == 0) return false;
        for (int i = 0; i < _config.GroupTabs.Count; i++)
        {
            if (i != index && string.Equals(_config.GroupTabs[i].Name, name, StringComparison.InvariantCultureIgnoreCase))
                return false; // 同集合内重名
        }
        _config.GroupTabs[index].Name = name;
        RebuildTabs("group");
        _configSvc.SaveConfig(_config);
        Log($"已重命名项目组集群为: {name}");
        return true;
    }

    /// <summary>重命名指定索引的项目页签；空名或同集合内重名返回 false 不保存。</summary>
    public bool RenameProjectTab(int index, string newName)
    {
        if (index < 0 || index >= _config.ProjectTabs.Count) return false;
        var name = (newName ?? "").Trim();
        if (name.Length == 0) return false;
        for (int i = 0; i < _config.ProjectTabs.Count; i++)
        {
            if (i != index && string.Equals(_config.ProjectTabs[i].Name, name, StringComparison.InvariantCultureIgnoreCase))
                return false; // 同集合内重名
        }
        _config.ProjectTabs[index].Name = name;
        RebuildTabs("project");
        _configSvc.SaveConfig(_config);
        Log($"已重命名项目页签为: {name}");
        return true;
    }

    /// <summary>重命名当前活动项目组集群（更适合 UI 直接绑定的便捷入口）。</summary>
    public bool RenameActiveGroupTab(string newName) => RenameGroupTab(ActiveGroupTabIndex, newName);

    /// <summary>重命名当前活动项目页签（更适合 UI 直接绑定的便捷入口）。</summary>
    public bool RenameActiveProjectTab(string newName) => RenameProjectTab(ActiveProjectTabIndex, newName);

    // ---------------- 页签顺序调整 ----------------
    // 页签重排统一走 MainViewModel.Drag.MoveTab(kind, from, to)（单一逻辑源，含 config 活动索引双写、
    // 实例保留让位动画与 Activate 回调重接线）；编辑列表拖拽（MainWindow.OnEditListDrop）已改走同一路径。
    // 原本此处并行的 MoveProjectTab/MoveGroupTab 两套实现已删除（E009：第二份实现即缺陷信号）。

    // ---------------- 页签删除 ----------------

    /// <summary>删除指定索引的项目组集群；至少保留 1 个（只剩一个时拒绝返回 false）。含收藏时先弹窗确认；含锁定项时拒绝删除。</summary>
    public bool RemoveGroupTab(int index)
    {
        if (_config.GroupTabs.Count <= 1) return false;
        if (index < 0 || index >= _config.GroupTabs.Count) return false;
        var tab = _config.GroupTabs[index];
        var name = tab.Name;
        if (tab.Groups.Count > 0)
        {
            var locked = tab.Groups.Where(IsLockedPath).ToList();
            if (locked.Count > 0)
            {
                Dialog.Service.Alert(
                    $"集群「{name}」包含 {locked.Count} 个已锁定项目组，无法删除：\n{FormatItemList(locked)}",
                    "无法删除");
                return false;
            }
            if (!Dialog.Service.Confirm(
                    $"删除集群「{name}」？将移除 {tab.Groups.Count} 个项目组：\n{FormatItemList(tab.Groups)}\n磁盘文件不受影响。",
                    "删除确认"))
                return false;
        }
        _config.GroupTabs.RemoveAt(index);
        RebuildTabs("group"); // 内部会把 ActiveGroupTabIndex clamp 回合法区间
        _configSvc.SaveConfig(_config);
        Log($"已删除项目组集群: {name}");
        return true;
    }

    /// <summary>删除指定索引的项目页签；至少保留 1 个（只剩一个时拒绝返回 false）。含收藏时先弹窗确认；含锁定项时拒绝删除。</summary>
    public bool RemoveProjectTab(int index)
    {
        if (_config.ProjectTabs.Count <= 1) return false;
        if (index < 0 || index >= _config.ProjectTabs.Count) return false;
        var tab = _config.ProjectTabs[index];
        var name = tab.Name;
        if (tab.Projects.Count > 0)
        {
            var locked = tab.Projects.Where(IsLockedPath).ToList();
            if (locked.Count > 0)
            {
                Dialog.Service.Alert(
                    $"页签「{name}」包含 {locked.Count} 个已锁定项目，无法删除：\n{FormatItemList(locked)}",
                    "无法删除");
                return false;
            }
            if (!Dialog.Service.Confirm(
                    $"删除页签「{name}」？将移除 {tab.Projects.Count} 个项目：\n{FormatItemList(tab.Projects)}\n磁盘文件不受影响。",
                    "删除确认"))
                return false;
        }
        _config.ProjectTabs.RemoveAt(index);
        RebuildTabs("project"); // 内部会把 ActiveProjectTabIndex clamp 回合法区间
        _configSvc.SaveConfig(_config);
        Log($"已删除项目页签: {name}");
        return true;
    }

    /// <summary>把路径列表格式化为简洁名称列表（最多显示 5 条，超出显示「… 等 N 项」）。</summary>
    private static string FormatItemList(List<string> paths)
    {
        var names = paths.Select(p => Path.GetFileName(TrimEnd(p))).ToList();
        var sb = new System.Text.StringBuilder();
        for (int i = 0; i < names.Count && i < 5; i++)
            sb.AppendLine("· " + names[i]);
        if (names.Count > 5) sb.Append("… 等 " + names.Count + " 项");
        return sb.ToString().TrimEnd();
    }

    // ---------------- UI 命令（XAML 绑定入口；??= 首次访问创建并缓存实例） ----------------

    private ICommand? _addGroupTabCommand;
    public ICommand AddGroupTabCommand => _addGroupTabCommand ??= new RelayCommand(_ => AddGroupTab());
    private ICommand? _addProjectTabCommand;
    public ICommand AddProjectTabCommand => _addProjectTabCommand ??= new RelayCommand(_ => AddProjectTab());
    private ICommand? _removeGroupTabCommand;
    public ICommand RemoveGroupTabCommand => _removeGroupTabCommand ??= new RelayCommand(o => { if (o is int i) RemoveGroupTab(i); });
    private ICommand? _removeProjectTabCommand;
    public ICommand RemoveProjectTabCommand => _removeProjectTabCommand ??= new RelayCommand(o => { if (o is int i) RemoveProjectTab(i); });
    private ICommand? _renameActiveGroupTabCommand;
    public ICommand RenameActiveGroupTabCommand => _renameActiveGroupTabCommand ??= new RelayCommand(o => { if (o is string s) RenameActiveGroupTab(s); });
    private ICommand? _renameActiveProjectTabCommand;
    public ICommand RenameActiveProjectTabCommand => _renameActiveProjectTabCommand ??= new RelayCommand(o => { if (o is string s) RenameActiveProjectTab(s); });

    // ---------------- 内部辅助 ----------------

    /// <summary>生成不与现有同名页签冲突的页签名（前缀 + "_N"，N 从 1 递增）。</summary>
    private static string UniqueTabName(IEnumerable<string> existing, string prefix)
    {
        var set = new HashSet<string>(existing, StringComparer.InvariantCultureIgnoreCase);
        if (!set.Contains(prefix)) return prefix;
        int n = 1;
        while (set.Contains(prefix + "_" + n)) n++;
        return prefix + "_" + n;
    }

    /// <summary>
    /// 按 kind（'group'/'project'）全量重建 VM 页签集合及其卡片索引，
    /// 使其与 _config 保持一致（仿照构造函数构建方式）。
    /// 重建后 clamp Active*TabIndex 到合法区间，刷新高亮并清选中。
    /// </summary>
    private void RebuildTabs(string kind)
    {
        if (kind == "project")
        {
            _allProjectCards.Clear();
            ProjectTabs.Clear();
            for (int i = 0; i < _config.ProjectTabs.Count; i++)
            {
                var tab = new TabViewModel(_config.ProjectTabs[i].Name, "project",
                    _config.ProjectTabs[i].Projects.Select(p => MakeCard("project", p)));
                var idx = i;
                tab.Activate = () => SwitchProjectTab(idx);
                ProjectTabs.Add(tab);
                foreach (var c in tab.Items) _allProjectCards.Add(c);
            }
            if (ActiveProjectTabIndex >= ProjectTabs.Count)
            {
                ActiveProjectTabIndex = ProjectTabs.Count - 1;
                _config.ActiveProjectTabIndex = ActiveProjectTabIndex;   // N1：clamp 改变活动索引时同步 config
            }
        }
        else
        {
            _allGroupCards.Clear();
            GroupTabs.Clear();
            for (int i = 0; i < _config.GroupTabs.Count; i++)
            {
                var tab = new TabViewModel(_config.GroupTabs[i].Name, "group",
                    _config.GroupTabs[i].Groups.Select(g => MakeCard("group", g)));
                var idx = i;
                tab.Activate = () => SwitchGroupTab(idx);
                GroupTabs.Add(tab);
                foreach (var c in tab.Items) _allGroupCards.Add(c);
            }
            if (ActiveGroupTabIndex >= GroupTabs.Count)
            {
                ActiveGroupTabIndex = GroupTabs.Count - 1;
                _config.ActiveGroupTabIndex = ActiveGroupTabIndex;   // N1：clamp 改变活动索引时同步 config
            }
        }

        SyncActiveTabs();
        ClearAllSelection();
        // 重建后新卡片对象的存在性/链接徽章均为默认值，必须立即刷新，否则页签操作后徽章全失
        RefreshAllValidityAsync();
        Raise(nameof(GroupCount));
        Raise(nameof(ProjectCount));
        Raise(nameof(GroupClusterCount));
        Raise(nameof(CurrentProjectCount));
    }
}