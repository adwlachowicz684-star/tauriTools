using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using System.Windows.Media;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>
/// 附属面板 VM 宿主：把中列「Agent/Skill 内容浏览区」组合进主 VM，
/// 供 MainWindow.xaml 以 {Binding Content} 注入对应 UserControl。
/// </summary>
public sealed partial class MainViewModel
{
    /// <summary>中列「Agent/Skill 内容浏览区」VM（对应 PS 版 Update-ContentPanel）。构造期惰性创建，永不为 null。</summary>
    public AgentSkillViewModel Content { get; private set; } = null!;

    /// <summary>初始化附属面板 VM（幂等：已初始化则跳过，避免重复创建丢失 PreviewHandler 等挂接）。</summary>
    public void InitBrokerPanels()
    {
        if (Content != null) return;
        Content = new AgentSkillViewModel(_icons, editToolPathProvider: () => _config.EditToolPath ?? "");
        Raise(nameof(Content));
    }

    // ---------------- 预览区「打开编辑」编辑器设置绑定（改动即时保存） ----------------

    /// <summary>预览区「打开编辑」所用编辑器程序路径；空串 = 跟随系统默认关联程序。</summary>
    public string EditToolText
    {
        get => _config.EditToolPath ?? "";
        set
        {
            var v = (value ?? "").Trim();
            if (_config.EditToolPath == v) return;
            _config.EditToolPath = v;
            Raise(nameof(EditToolText));
            _configSvc.SaveConfig(_config);
        }
    }

    // ---------------- 预览区「打开编辑」：程序选择区（跟随系统 / 搜索 / 浏览手动添加） ----------------

    private ObservableCollection<EditorCandidateViewModel>? _editorCandidates;

    /// <summary>选择区候选：「跟随系统」置顶 + 搜索枚举的程序 + 浏览手动添加的项。</summary>
    public ObservableCollection<EditorCandidateViewModel> EditorCandidates =>
        _editorCandidates ??= BuildInitialCandidates();

    private EditorCandidateViewModel? _selectedEditor;

    /// <summary>是否正在重建候选列表（抑制 SelectedItem 清空联动误写配置）。</summary>
    private bool _suppressSelectionSync;

    /// <summary>选择区当前选中项；选中即写 editToolPath 落盘（「跟随系统」= 空串）。</summary>
    public EditorCandidateViewModel? SelectedEditor
    {
        get => _selectedEditor;
        set
        {
            if (!Set(ref _selectedEditor, value)) return;
            if (_suppressSelectionSync) return;
            EditToolText = value?.ExePath ?? "";
        }
    }

    /// <summary>初始候选：「跟随系统」+ 已配置自定义编辑器 + 上次搜索缓存（免搜索直接展示；搜索=手动刷新）。</summary>
    private ObservableCollection<EditorCandidateViewModel> BuildInitialCandidates()
    {
        var list = new ObservableCollection<EditorCandidateViewModel> { EditorCandidateViewModel.SystemFollow() };
        AppendConfiguredCustom(list);
        foreach (var c in _config.EditorPickCache ?? new List<EditorPickCacheItem>())
        {
            if (c.Exe.Length == 0 || !File.Exists(c.Exe)) continue;
            if (list.Any(x => string.Equals(x.ExePath, c.Exe, StringComparison.OrdinalIgnoreCase))) continue;
            list.Add(EditorCandidateViewModel.Create(c.Name, c.Exe,
                IconService.LoadCustomIcon(c.IconPath, c.IconIndex), c.IconPath, c.IconIndex));
        }
        return list;
    }

    /// <summary>当前配置的编辑器不在候选中时（浏览手动加过），补一条自定义项保持可见。</summary>
    private void AppendConfiguredCustom(ObservableCollection<EditorCandidateViewModel> list)
    {
        var cur = (_config.EditToolPath ?? "").Trim();
        if (cur.Length == 0 || !File.Exists(cur)) return;
        if (list.Any(c => string.Equals(c.ExePath, cur, StringComparison.OrdinalIgnoreCase))) return;
        list.Add(EditorCandidateViewModel.Create(
            Path.GetFileNameWithoutExtension(cur), cur, IconService.LoadCustomIcon(cur, 0)));
    }

    private bool _editorSearchBusy;

    private ICommand? _searchEditorsCommand;

    /// <summary>「搜索」：后台枚举系统「打开方式」程序清单（纯数据 DTO），回 UI 线程重建选择区并预选当前配置项。</summary>
    public ICommand SearchEditorsCommand => _searchEditorsCommand ??= new RelayCommand(_ => SearchEditorsAsync());

    private async void SearchEditorsAsync()
    {
        if (_editorSearchBusy) return;
        _editorSearchBusy = true;
        try
        {
            var items = await Task.Run(EditorPickService.Enumerate);
            _suppressSelectionSync = true;
            try
            {
                var list = EditorCandidates;
                list.Clear();
                list.Add(EditorCandidateViewModel.SystemFollow());
                foreach (var c in items)
                    list.Add(EditorCandidateViewModel.Create(c.Name, c.ExePath, c.Icon, c.IconPath, c.IconIndex));
                AppendConfiguredCustom(list);
                // 持久化本次搜索结果：下次启动免搜索直接展示（搜索按钮=手动刷新）
                _config.EditorPickCache = items.Select(c => new EditorPickCacheItem
                {
                    Name = c.Name,
                    Exe = c.ExePath,
                    IconPath = c.IconPath,
                    IconIndex = c.IconIndex,
                }).ToList();
                _configSvc.SaveConfig(_config);
                var cur = (_config.EditToolPath ?? "").Trim();
                SelectedEditor = cur.Length == 0
                    ? list[0]
                    : list.FirstOrDefault(c => c.ExePath.Length > 0
                        && string.Equals(c.ExePath, cur, StringComparison.OrdinalIgnoreCase));
            }
            finally { _suppressSelectionSync = false; }
        }
        catch (Exception ex)
        {
            Log("搜索可打开 .md 的程序失败: " + ex.Message, true);
        }
        finally { _editorSearchBusy = false; }
    }

    /// <summary>「浏览…」手动添加的编辑器：去重后加入选择区并选中（写配置落盘）。</summary>
    public void AddCustomEditor(string exePath)
    {
        var v = (exePath ?? "").Trim();
        if (v.Length == 0) return;
        var list = EditorCandidates;
        var exist = list.FirstOrDefault(c => string.Equals(c.ExePath, v, StringComparison.OrdinalIgnoreCase));
        if (exist != null) { SelectedEditor = exist; return; }
        var item = EditorCandidateViewModel.Create(
            Path.GetFileNameWithoutExtension(v), v, IconService.LoadCustomIcon(v, 0));
        list.Add(item);
        SelectedEditor = item;
    }
}

/// <summary>编辑器候选单项 VM（纯展示；图标为后台线程预生成的冻结 ImageSource，缺失时以 Glyph 字形兜底）。选中逻辑在宿主 SelectedEditor。</summary>
public sealed class EditorCandidateViewModel : ViewModelBase
{
    private EditorCandidateViewModel(string name, string exePath, ImageSource? icon,
        string glyph, string iconPath, int iconIndex)
    {
        Name = name;
        ExePath = exePath;
        Icon = icon;
        Glyph = glyph;
        IconPath = iconPath;
        IconIndex = iconIndex;
    }

    /// <summary>普通程序项。</summary>
    internal static EditorCandidateViewModel Create(string name, string exePath, ImageSource? icon,
        string iconPath = "", int iconIndex = 0)
    {
        // 图标缺失兜底字形：跟随系统=齿轮；普通程序=通用页面
        var glyph = exePath.Length == 0 ? "\uE713" : icon == null ? "\uE7C3" : "";
        return new EditorCandidateViewModel(name, exePath, icon, glyph, iconPath, iconIndex);
    }

    /// <summary>「跟随系统」选项：ExePath 为空串，选中即清空 editToolPath。</summary>
    public static EditorCandidateViewModel SystemFollow() => Create("跟随系统", "", null);

    /// <summary>显示名（软件名称 / 自定义项为 exe 主名）。</summary>
    public string Name { get; }

    /// <summary>主程序完整路径（「跟随系统」为空串）。</summary>
    public string ExePath { get; }

    /// <summary>程序图标（可能为 null → 用 Glyph 字形兜底展示）。</summary>
    public ImageSource? Icon { get; }

    /// <summary>图标缺失时的 MDL2 兜底字形（空串 = 有位图图标，不显示字形）。</summary>
    public string Glyph { get; }

    /// <summary>图标来源路径（搜索缓存持久化用）。</summary>
    public string IconPath { get; }

    /// <summary>图标来源索引。</summary>
    public int IconIndex { get; }
}
