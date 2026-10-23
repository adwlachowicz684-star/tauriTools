using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>预设图标库中的单项：显示名 + 预览图。</summary>
public sealed class PresetIconItemViewModel : ViewModelBase
{
    private string _name;
    public PresetIconItemViewModel(string name, ImageSource? icon)
    {
        _name = name;
        Icon = icon;
    }

    /// <summary>显示名（文件名主干）。</summary>
    public string Name
    {
        get => _name;
        set => Set(ref _name, value);
    }

    private bool _isHovered;
    /// <summary>是否悬浮（供删除按钮 hover 显示，由面板事件维护）。</summary>
    public bool IsHovered
    {
        get => _isHovered;
        set => Set(ref _isHovered, value);
    }

    /// <summary>预览图像（.ico 内最大帧）。</summary>
    public ImageSource? Icon { get; }
}

/// <summary>图标分组视图模型：名称 + 组内图标列表 + 编辑/折叠状态。</summary>
public sealed class IconGroupViewModel : ViewModelBase
{
    private string _name;
    private bool _isEditing;
    private bool _isCollapsed;
    private bool _isHovered;

    public IconGroupViewModel(string name)
    {
        _name = name;
    }

    public string Name
    {
        get => _name;
        set => Set(ref _name, value);
    }

    public ObservableCollection<PresetIconItemViewModel> Items { get; } = new();

    public int Count => Items.Count;

    public bool IsEditing
    {
        get => _isEditing;
        set => Set(ref _isEditing, value);
    }

    public bool IsCollapsed
    {
        get => _isCollapsed;
        set => Set(ref _isCollapsed, value);
    }

    /// <summary>是否悬浮（供删除按钮 hover 显示，由面板事件维护）。</summary>
    public bool IsHovered
    {
        get => _isHovered;
        set => Set(ref _isHovered, value);
    }

    /// <summary>通知 Count 变化（拖拽等轻量同步后调用，避免整体 Reload）。</summary>
    internal void RefreshCount() => Raise(nameof(Count));
}

/// <summary>
/// 「设置」面板内的预设图标库视图模型：管理分组的展示与增删改。
/// 改动即时落盘；分组顺序即 config.iconGroups 顺序。
/// </summary>
public sealed class PresetIconViewModel : ViewModelBase
{
    private readonly AppConfig _config;
    private readonly PresetIconService _svc;
    private int _activeGroupIndex;

    public PresetIconViewModel(AppConfig config, ConfigService configSvc, string dataDir)
    {
        _config = config;
        _svc = new PresetIconService(config, configSvc, dataDir);
        Reload();
    }

    /// <summary>图标分组列表（设置面板绑定）。</summary>
    public ObservableCollection<IconGroupViewModel> Groups { get; } = new();

    /// <summary>当前活动分组索引（导入图标时默认进入此分组）。</summary>
    public int ActiveGroupIndex
    {
        get => _activeGroupIndex;
        set
        {
            if (Set(ref _activeGroupIndex, value))
                Raise(nameof(ActiveGroup));
        }
    }

    /// <summary>当前活动分组 VM。</summary>
    public IconGroupViewModel? ActiveGroup =>
        _activeGroupIndex >= 0 && _activeGroupIndex < Groups.Count
            ? Groups[_activeGroupIndex] : Groups.FirstOrDefault();

    /// <summary>预设图标目录绝对路径（供 UI 提示 / 文件对话框定位）。</summary>
    public string DirectoryPath => _svc.DirectoryPath;

    public int Count => Groups.Sum(g => g.Count);

    /// <summary>分组数。</summary>
    public int GroupCount => Groups.Count;

    private string? _error;
    /// <summary>最近一次导入的失败提示（全部成功或未操作时为 null）。</summary>
    public string? Error
    {
        get => _error;
        set { if (Set(ref _error, value)) Raise(nameof(HasError)); }
    }

    /// <summary>是否存在错误提示（决定红字提示行是否显示）。</summary>
    public bool HasError => !string.IsNullOrWhiteSpace(_error);

    /// <summary>重新加载：清理失效项后按 config 分组重建列表。</summary>
    public void Reload()
    {
        _svc.PruneMissing();
        Groups.Clear();
        foreach (var g in _config.IconGroups)
        {
            var vm = new IconGroupViewModel(g.Name);
            foreach (var n in g.Icons)
                vm.Items.Add(new PresetIconItemViewModel(n, _svc.LoadPreview(n)));
            Groups.Add(vm);
        }
        if (_activeGroupIndex >= Groups.Count)
            _activeGroupIndex = Groups.Count - 1;
        Raise(nameof(Count));
        Raise(nameof(GroupCount));
        Raise(nameof(ActiveGroup));
    }

    /// <summary>预设显示名快照（所有分组的图标平铺，供主窗口弹窗构建选项）。</summary>
    public IReadOnlyList<string> Names => _svc.AllIconNames;

    /// <summary>取某预设的完整文件路径（供应用图标时传给 FolderIconService）。</summary>
    public string FullPath(string name) => _svc.FullPath(name);

    /// <summary>所有分组的图标 + 预览图（供图标选择弹窗按分组展示）。</summary>
    public IReadOnlyList<(string GroupName, IReadOnlyList<(string Name, ImageSource? Icon)> Icons)> GroupedIcons =>
        Groups.Select(g => (g.Name, (IReadOnlyList<(string, ImageSource?)>)g.Items
            .Select(i => (i.Name, i.Icon)).ToList())).ToList();

    // ---- 分组管理 ----

    /// <summary>新增分组。</summary>
    public void AddGroup(string name = "新分组")
    {
        var unique = _svc.AddGroup(name);
        var vm = new IconGroupViewModel(unique);
        Groups.Add(vm);
        ActiveGroupIndex = Groups.Count - 1;
        Raise(nameof(GroupCount));
        Raise(nameof(ActiveGroup));
    }

    /// <summary>分组名校验。</summary>
    public string? ValidateGroupName(string? newName) => _svc.ValidateGroupName(newName);

    /// <summary>重命名分组。</summary>
    public bool RenameGroup(IconGroupViewModel group, string newName)
    {
        var idx = Groups.IndexOf(group);
        if (!_svc.RenameGroup(idx, newName)) return false;
        group.Name = newName.Trim();
        return true;
    }

    /// <summary>删除分组（至少保留一个）。</summary>
    public bool RemoveGroup(IconGroupViewModel group)
    {
        var idx = Groups.IndexOf(group);
        if (idx < 0) return false;
        if (Groups.Count <= 1) return false;
        if (!_svc.DeleteGroup(idx)) return false;
        Groups.RemoveAt(idx);
        if (_activeGroupIndex >= Groups.Count)
            _activeGroupIndex = Groups.Count - 1;
        Raise(nameof(Count));
        Raise(nameof(GroupCount));
        Raise(nameof(ActiveGroup));
        return true;
    }

    /// <summary>调整分组顺序。</summary>
    public void MoveGroup(int fromIdx, int toIdx)
    {
        _svc.MoveGroup(fromIdx, toIdx);
        Groups.Move(fromIdx, toIdx);
        if (_activeGroupIndex == fromIdx)
            _activeGroupIndex = toIdx;
        else if (fromIdx < _activeGroupIndex && toIdx >= _activeGroupIndex)
            _activeGroupIndex--;
        else if (fromIdx > _activeGroupIndex && toIdx <= _activeGroupIndex)
            _activeGroupIndex++;
        Raise(nameof(ActiveGroup));
    }

    // ---- 图标管理 ----

    /// <summary>批量导入 .ico 文件到指定分组（默认加到活动分组）；聚合错误提示并刷新列表。</summary>
    public void AddFiles(IEnumerable<string> files, out int added, out int failed)
        => AddFilesToGroup(ActiveGroup, files, out added, out failed);

    /// <summary>批量导入 .ico 文件到指定分组；聚合错误提示并刷新列表。</summary>
    public void AddFilesToGroup(IconGroupViewModel? group, IEnumerable<string> files, out int added, out int failed)
    {
        added = 0; failed = 0;
        var list = files?.Where(f => !string.IsNullOrWhiteSpace(f)).ToList() ?? new List<string>();
        if (list.Count == 0) return;
        var gi = group is null ? -1 : Groups.IndexOf(group);
        if (gi < 0 || gi >= _config.IconGroups.Count) gi = 0;
        var results = _svc.Import(list, gi);
        foreach (var (n, err) in results)
        {
            if (err == null) added++; else failed++;
        }
        var msg = new List<string>();
        if (added > 0) msg.Add($"已导入 {added} 个预设图标");
        if (failed > 0) msg.Add($"失败 {failed} 个（支持 ico；png/jpg 等会自动转为 ico）");
        foreach (var (_, err) in results)
            if (err != null) msg.Add(err);
        Error = string.Join("；", msg);
        Reload();
    }

    /// <summary>从剪贴板添加预设图标：优先取剪贴板图片，其次取已复制的图片文件。返回是否成功。</summary>
    public bool AddFromClipboard()
    {
        try
        {
            if (Clipboard.ContainsImage())
            {
                var img = Clipboard.GetImage();
                if (img == null) { Error = "剪贴板中没有可用的图片。"; return false; }
                var frozen = img.Clone();
                frozen.Freeze();
                var (name, err) = _svc.ImportClipboard(frozen, ActiveGroupIndex);
                if (err != null) { Error = err; return false; }
                Error = $"已从剪贴板添加预设图标「{name}」";
                Reload();
                return true;
            }
            if (Clipboard.ContainsFileDropList())
            {
                var files = Clipboard.GetFileDropList().Cast<string>()
                    .Where(f => PresetIconService.IsSupportedFile(f))
                    .ToList();
                if (files.Count > 0)
                {
                    AddFilesToGroup(ActiveGroup, files, out _, out _);
                    return true;
                }
            }
            Error = "剪贴板中没有可用的图片（请先复制图片或图片文件）。";
            return false;
        }
        catch (Exception ex)
        {
            Error = $"读取剪贴板失败：{ex.Message}";
            return false;
        }
    }

    /// <summary>把剪贴板位图加入指定分组最前面，返回生成的 .ico 文件路径（失败返回 null）。</summary>
    public string? AddClipboardToGroupFront(BitmapSource image, string groupName)
        => AddBitmapToGroupFront(image, groupName, "剪贴板");

    /// <summary>把位图加入指定分组最前面（baseName 为图标名主干），返回生成的 .ico 文件路径（失败返回 null）。</summary>
    public string? AddBitmapToGroupFront(BitmapSource image, string groupName, string baseName)
    {
        var gi = -1;
        for (int i = 0; i < Groups.Count; i++)
            if (string.Equals(Groups[i].Name, groupName, StringComparison.OrdinalIgnoreCase)) { gi = i; break; }
        if (gi < 0) gi = ActiveGroupIndex;
        var (name, err) = _svc.ImportBitmap(image, gi, baseName, insertFront: true);
        if (err != null) { Error = err; return null; }
        Error = $"已添加到分组「{groupName}」最前面：{name}";
        Reload();
        return _svc.FullPath(name);
    }

    /// <summary>重命名前校验（复用服务层校验；返回错误文案或 null）。</summary>
    public string? ValidateRename(string oldName, string newName) => _svc.ValidateNewName(oldName, newName);

    /// <summary>应用重命名：成功后同步列表项显示名。返回是否成功。</summary>
    public bool ApplyRename(PresetIconItemViewModel item, string newName)
    {
        if (!_svc.Rename(item.Name, newName)) return false;
        item.Name = newName;
        Raise(nameof(Count));
        return true;
    }

    /// <summary>删除预设（含确认提示与落盘）；返回是否删除。</summary>
    public bool Remove(PresetIconItemViewModel item)
    {
        if (!_svc.Delete(item.Name)) return false;
        foreach (var g in Groups)
            g.Items.Remove(item);
        Raise(nameof(Count));
        return true;
    }

    /// <summary>移动图标到目标分组的指定位置。</summary>
    public void MoveIcon(string iconName, int fromGroup, int toGroup, int toIndex)
    {
        _svc.MoveIcon(iconName, fromGroup, toGroup, toIndex);
        Reload();
    }

    /// <summary>组内轻量重排：config+Items 同步移动并落盘；不整体 Reload（保留分组折叠态）。</summary>
    public void ReorderIcon(IconGroupViewModel grp, int fromIdx, int toIdx)
    {
        int gi = Groups.IndexOf(grp);
        if (gi < 0 || gi >= _config.IconGroups.Count) return;
        if (fromIdx < 0 || fromIdx >= grp.Items.Count) return;
        _svc.MoveIcon(grp.Items[fromIdx].Name, gi, gi, toIdx);
        grp.Items.Move(fromIdx, Math.Clamp(toIdx, 0, grp.Items.Count - 1));
    }

    /// <summary>跨分组轻量移动：插入目标分组指定位置并落盘；不整体 Reload（保留分组折叠态）。</summary>
    public void MoveIconToGroup(PresetIconItemViewModel item, IconGroupViewModel dstGrp, int toIndex)
    {
        IconGroupViewModel? srcGrp = null;
        foreach (var g in Groups)
            if (g.Items.Contains(item)) { srcGrp = g; break; }
        if (srcGrp == null || ReferenceEquals(srcGrp, dstGrp)) return;
        int sgi = Groups.IndexOf(srcGrp);
        int dgi = Groups.IndexOf(dstGrp);
        if (sgi < 0 || dgi < 0 || dgi >= _config.IconGroups.Count) return;

        var si = srcGrp.Items.IndexOf(item);
        if (si < 0) return;
        _svc.MoveIcon(item.Name, sgi, dgi, toIndex);
        srcGrp.Items.RemoveAt(si);
        dstGrp.Items.Insert(Math.Clamp(toIndex, 0, dstGrp.Items.Count), item);
        srcGrp.RefreshCount();
        dstGrp.RefreshCount();
        Raise(nameof(Count));
    }
}
