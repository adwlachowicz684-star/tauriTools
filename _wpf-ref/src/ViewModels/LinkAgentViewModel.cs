using System.Collections.ObjectModel;
using System.Windows.Input;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>单个 agent 链接名的开关状态（目录名 / 厂商标注 / 是否启用 / 是否预设 / 是否置顶 / 备注）。</summary>
public sealed class LinkAgentItemViewModel : ViewModelBase
{
    private readonly Action<LinkAgentItemViewModel> _onChanged;
    private readonly Action<LinkAgentItemViewModel>? _onRemove;
    private readonly Action<LinkAgentItemViewModel>? _onPinChanged;

    public LinkAgentItemViewModel(string name, string vendor, bool enabled,
                                  Action<LinkAgentItemViewModel> onChanged,
                                  Action<LinkAgentItemViewModel>? onRemove = null,
                                  Action<LinkAgentItemViewModel>? onPinChanged = null,
                                  bool pinned = false, string? remark = null,
                                  bool isPreset = false, string? originalName = null,
                                  string? presetOriginalVendor = null)
    {
        _name = name;
        _vendor = vendor;
        _isEnabled = enabled;
        _isPinned = pinned;
        _remark = remark ?? "";
        _onChanged = onChanged;
        _onRemove = onRemove;
        _onPinChanged = onPinChanged;
        _removeCommand = new RelayCommand(_ => _onRemove?.Invoke(this));
        _togglePinCommand = new RelayCommand(_ => IsPinned = !IsPinned);
        IsPreset = isPreset;
        OriginalName = originalName ?? name;
        PresetOriginalVendor = presetOriginalVendor;
    }

    /// <summary>是否预设项（预设不可删；自定义可删）。</summary>
    public bool IsPreset { get; }

    /// <summary>预设原名（目录名单中的原始名，重命名时用于写 linkAgentRenames；自定义项等于 Name）。</summary>
    public string OriginalName { get; }

    /// <summary>预设项的原始厂商标注（目录名单默认值；自定义项为 null，用于「恢复预设」）。</summary>
    public string? PresetOriginalVendor { get; }

    private string _name;
    /// <summary>当前链接名（文件夹名；可经编辑弹窗重命名）。</summary>
    public string Name
    {
        get => _name;
        set => Set(ref _name, value);
    }

    private string _vendor;
    /// <summary>厂商标注（如 OpenCode / 自定义；可经编辑弹窗覆盖）。</summary>
    public string Vendor
    {
        get => _vendor;
        set => Set(ref _vendor, value);
    }

    private string _remark;
    /// <summary>备注文本（预设/自定义均可带；编辑弹窗可改）。</summary>
    public string Remark
    {
        get => _remark;
        set { if (Set(ref _remark, value)) Raise(nameof(HasRemark)); }
    }

    /// <summary>是否有备注（决定备注行是否显示）。</summary>
    public bool HasRemark => !string.IsNullOrWhiteSpace(_remark);

    /// <summary>是否用户自定义项（自定义项可删除，预设项不可）。</summary>
    public bool IsCustom => !IsPreset;

    private readonly ICommand _removeCommand;
    public ICommand RemoveCommand => _removeCommand;

    private bool _isPinned;
    /// <summary>是否置顶（置顶项在列表中排最前）。</summary>
    public bool IsPinned
    {
        get => _isPinned;
        set { if (Set(ref _isPinned, value)) _onPinChanged?.Invoke(this); }
    }

    private readonly ICommand _togglePinCommand;
    public ICommand TogglePinCommand => _togglePinCommand;

    private bool _isHovered;
    /// <summary>鼠标是否悬浮在本项上（由面板 MouseEnter/Leave 事件维护，用于未置顶图钉的 hover 显示）。</summary>
    public bool IsHovered
    {
        get => _isHovered;
        set => Set(ref _isHovered, value);
    }

    private bool _isEnabled;
    public bool IsEnabled
    {
        get => _isEnabled;
        set { if (Set(ref _isEnabled, value)) _onChanged(this); }
    }
}

/// <summary>
/// 「设置」面板内的 Agent 链接名开关列表：预设名单 + 用户自定义名单，勾选即写入 config.linkAgents 并落盘。
/// 建链（拖拽或在 MCP 调用 create_link）时按此开关集一次性为项目创建对应 junction。
/// 预设/自定义项均可双击打开编辑弹窗：改文件夹名（重命名）、厂商标注、备注、置顶、点前缀。
/// </summary>
public sealed class LinkAgentViewModel : ViewModelBase
{
    private readonly AppConfig _config;
    private readonly ConfigService _configSvc;
    private readonly List<LinkAgentItemViewModel> _all = new();
    private bool _bulk; // 全选/全不选批量置位时跳过逐项落盘，最后统一保存一次

    public LinkAgentViewModel(AppConfig config, ConfigService configSvc)
    {
        _config = config;
        _configSvc = configSvc;
        ReloadItems();
    }

    /// <summary>置顶项（UI 顶部区域，与普通项用分隔线隔开）。</summary>
    public ObservableCollection<LinkAgentItemViewModel> PinnedItems { get; } = new();

    /// <summary>非置顶项（UI 底部区域）。</summary>
    public ObservableCollection<LinkAgentItemViewModel> NormalItems { get; } = new();

    /// <summary>是否存在置顶项（决定分隔线是否显示）。</summary>
    public bool HasPinned => PinnedItems.Count > 0;

    public int EnabledCount => _all.Count(i => i.IsEnabled);
    public int Total => _all.Count;

    /// <summary>最近一次添加失败的原因（供 UI 红字提示；成功或未操作时为 null）。</summary>
    public string? AddError { get; private set; }

    /// <summary>输入框内容（绑定 TextBox，PropertyChanged 实时同步）。</summary>
    private string _inputName = "";
    public string InputName
    {
        get => _inputName;
        set { if (Set(ref _inputName, value)) Raise(nameof(CanAdd)); }
    }

    /// <summary>厂商输入框内容（绑定 TextBox；添加自定义项时一并保存）。</summary>
    private string _inputVendor = "";
    public string InputVendor
    {
        get => _inputVendor;
        set => Set(ref _inputVendor, value);
    }

    /// <summary>备注输入框内容（绑定 TextBox；添加自定义项时一并保存）。</summary>
    private string _inputRemark = "";
    public string InputRemark
    {
        get => _inputRemark;
        set => Set(ref _inputRemark, value);
    }

    /// <summary>添加时是否直接置顶（绑定添加行复选框）。</summary>
    private bool _pinOnAdd;
    public bool PinOnAdd
    {
        get => _pinOnAdd;
        set => Set(ref _pinOnAdd, value);
    }

    /// <summary>添加时是否自动前置 '.'（绑定添加行复选框，默认勾选）。</summary>
    private bool _dotOnAdd = true;
    public bool DotOnAdd
    {
        get => _dotOnAdd;
        set => Set(ref _dotOnAdd, value);
    }

    public bool CanAdd => !string.IsNullOrWhiteSpace(_inputName);

    private ICommand? _addCustomCommand;
    public ICommand AddCustomCommand => _addCustomCommand ??= new RelayCommand(_ => AddCustom(InputName, InputVendor, InputRemark, PinOnAdd, DotOnAdd));
    private ICommand? _selectAllCommand;
    public ICommand SelectAllCommand => _selectAllCommand ??= new RelayCommand(_ => SetAll(true));
    private ICommand? _selectNoneCommand;
    public ICommand SelectNoneCommand => _selectNoneCommand ??= new RelayCommand(_ => SetAll(false));

    private void ReloadItems()
    {
        _all.Clear();
        var pinned = _config.LinkAgentsPinned;
        foreach (var a in LinkAgentCatalog.All)
        {
            var name = LinkAgentCatalog.CurrentName(_config, a.Name);
            var vendor = LinkAgentCatalog.Vendor(_config, name);
            _all.Add(new LinkAgentItemViewModel(name, vendor, IsEnabled(name),
                onChanged: i => Save(i), onPinChanged: i => OnPinChanged(i),
                pinned: pinned.Contains(name),
                remark: _config.LinkAgentRemarks.TryGetValue(name, out var r) ? r : null,
                isPreset: true, originalName: a.Name, presetOriginalVendor: a.Vendor));
        }
        foreach (var n in LinkAgentCatalog.CustomNames(_config))
        {
            var vendor = LinkAgentCatalog.Vendor(_config, n);
            _all.Add(new LinkAgentItemViewModel(n, vendor, IsEnabled(n),
                onChanged: i => Save(i), onRemove: i => RemoveCustom(i), onPinChanged: i => OnPinChanged(i),
                pinned: pinned.Contains(n),
                remark: _config.LinkAgentRemarks.TryGetValue(n, out var r) ? r : null,
                isPreset: false, originalName: n));
        }
        ReorderItems();
    }

    /// <summary>按置顶拆分：置顶项进 PinnedItems（顶部区域），其余进 NormalItems（底部区域）。</summary>
    private void ReorderItems()
    {
        PinnedItems.Clear();
        NormalItems.Clear();
        foreach (var it in _all)
        {
            if (it.IsPinned) PinnedItems.Add(it);
            else NormalItems.Add(it);
        }
        Raise(nameof(EnabledCount));
        Raise(nameof(Total));
        Raise(nameof(HasPinned));
    }

    private void OnPinChanged(LinkAgentItemViewModel it)
    {
        var pinned = _config.LinkAgentsPinned;
        if (it.IsPinned) { if (!pinned.Contains(it.Name, StringComparer.OrdinalIgnoreCase)) pinned.Add(it.Name); }
        else pinned.RemoveAll(n => string.Equals(n, it.Name, StringComparison.OrdinalIgnoreCase));
        _configSvc.SaveConfig(_config);
        ReorderItems();
    }

    /// <summary>全选/全不选：批量置位所有项的开关并同步字典，统一落盘一次。</summary>
    private void SetAll(bool on)
    {
        _bulk = true;
        try
        {
            foreach (var it in _all)
            {
                it.IsEnabled = on;
                _config.LinkAgents[it.Name] = on; // _bulk 下 Save 被跳过，须在此直接更新字典
            }
        }
        finally { _bulk = false; }
        _configSvc.SaveConfig(_config);
        Raise(nameof(EnabledCount));
        Raise(nameof(Total));
    }

    private bool IsEnabled(string name)
        => !_config.LinkAgents.TryGetValue(name, out var on) || on;

    private void Save(LinkAgentItemViewModel it)
    {
        if (_bulk) return;
        _config.LinkAgents[it.Name] = it.IsEnabled;
        _configSvc.SaveConfig(_config);
        Raise(nameof(EnabledCount));
        Raise(nameof(Total));
    }

    /// <summary>添加自定义链接名：规范化校验 → 去重 → 写入 config（含厂商/备注/置顶）并落盘 → 追加到列表。</summary>
    public void AddCustom(string? raw, string? vendor, string? remark = null, bool pinned = false, bool prependDot = true)
    {
        var name = LinkAgentCatalog.NormalizeName(raw, prependDot);
        if (name is null)
        {
            AddError = "名称无效：不能为空，且不能含 \\ / : * ? \" < > | 等字符";
            Raise(nameof(AddError));
            return;
        }
        // 大小写不敏感查重：Windows 目录名不区分大小写，".Opencode" 与 ".opencode" 物理上是同一个名字
        if (_all.Any(i => string.Equals(i.Name, name, StringComparison.OrdinalIgnoreCase)))
        {
            AddError = $"「{name}」已存在";
            Raise(nameof(AddError));
            return;
        }
        if (_config.CustomLinkAgents.Concat(LinkAgentCatalog.All.Select(a => LinkAgentCatalog.CurrentName(_config, a.Name)))
                .Any(n => string.Equals(n, name, StringComparison.OrdinalIgnoreCase)))
        {
            AddError = $"「{name}」已存在";
            Raise(nameof(AddError));
            return;
        }
        _config.CustomLinkAgents.Add(name);
        _config.LinkAgents[name] = true;
        if (!string.IsNullOrWhiteSpace(vendor)) _config.LinkAgentVendors[name] = vendor.Trim();
        if (!string.IsNullOrWhiteSpace(remark)) _config.LinkAgentRemarks[name] = remark.Trim();
        if (pinned && !_config.LinkAgentsPinned.Contains(name, StringComparer.OrdinalIgnoreCase)) _config.LinkAgentsPinned.Add(name);
        _configSvc.SaveConfig(_config);
        _all.Add(new LinkAgentItemViewModel(name, LinkAgentCatalog.Vendor(_config, name), true,
            onChanged: i => Save(i), onRemove: i => RemoveCustom(i), onPinChanged: i => OnPinChanged(i),
            pinned: pinned,
            remark: _config.LinkAgentRemarks.TryGetValue(name, out var r) ? r : null,
            isPreset: false, originalName: name));
        ReorderItems();
        InputName = "";
        InputVendor = "";
        InputRemark = "";
        PinOnAdd = false;
        DotOnAdd = true; // 添加后复位为默认勾选
        AddError = null;
        Raise(nameof(AddError));
    }

    /// <summary>编辑弹窗校验回调：规范化（含点前缀切换）+ 重名检查（大小写不敏感），返回错误文案或 null。</summary>
    public string? ValidateEditName(LinkAgentItemViewModel it, string? raw, bool prependDot)
    {
        var name = LinkAgentCatalog.NormalizeEdit(raw, prependDot);
        if (name is null)
            return "名称无效：不能为空，且不能含 \\ / : * ? \" < > | 等字符";
        if (_all.Any(i => i != it && string.Equals(i.Name, name, StringComparison.OrdinalIgnoreCase)))
            return $"「{name}」已存在";
        return null;
    }

    /// <summary>应用编辑弹窗结果：重命名（迁移 config 各键）+ 厂商覆盖 + 备注 + 置顶 + 点前缀。返回是否成功。
    /// 落盘恰好一次：pinned 有变化时由 IsPinned setter 触发 OnPinChanged 落盘，否则在此统一落盘。</summary>
    public bool ApplyEdit(LinkAgentItemViewModel it, string? rawName, string? vendor, string? remark, bool pinned, bool prependDot)
    {
        var name = LinkAgentCatalog.NormalizeEdit(rawName, prependDot);
        if (name is null || _all.Any(i => i != it && string.Equals(i.Name, name, StringComparison.OrdinalIgnoreCase))) return false;

        var oldName = it.Name;
        if (name != oldName)
        {
            RenameConfigKey(oldName, name);
            if (it.IsPreset)
            {
                // 恢复为预设原名时移除重命名覆盖，避免残留"改名成自己"的冗余条目
                if (name == it.OriginalName) _config.LinkAgentRenames.Remove(it.OriginalName);
                else _config.LinkAgentRenames[it.OriginalName] = name;
            }
            else
            {
                var idx = _config.CustomLinkAgents.IndexOf(oldName);
                if (idx >= 0) _config.CustomLinkAgents[idx] = name;
            }
        }
        if (string.IsNullOrWhiteSpace(vendor)) _config.LinkAgentVendors.Remove(name);
        else if (it.IsPreset && it.PresetOriginalVendor != null && vendor.Trim() == it.PresetOriginalVendor)
            _config.LinkAgentVendors.Remove(name); // 厂商恢复为预设默认时移除覆盖
        else _config.LinkAgentVendors[name] = vendor.Trim();
        if (string.IsNullOrWhiteSpace(remark)) _config.LinkAgentRemarks.Remove(name);
        else _config.LinkAgentRemarks[name] = remark.Trim();
        if (pinned) { if (!_config.LinkAgentsPinned.Contains(name, StringComparer.OrdinalIgnoreCase)) _config.LinkAgentsPinned.Add(name); }
        else _config.LinkAgentsPinned.RemoveAll(n => string.Equals(n, name, StringComparison.OrdinalIgnoreCase));

        it.Name = name;
        it.Vendor = string.IsNullOrWhiteSpace(vendor) ? LinkAgentCatalog.Vendor(_config, name) : vendor.Trim();
        it.Remark = remark?.Trim() ?? "";
        if (it.IsPinned != pinned)
            it.IsPinned = pinned;   // setter 触发 OnPinChanged：落盘 + 重排（唯一一次落盘）
        else
        {
            _configSvc.SaveConfig(_config);
            ReorderItems();
        }
        return true;
    }

    /// <summary>重命名时迁移 config 中按链接名索引的键（开关/置顶/备注/厂商），旧键 → 新键。</summary>
    private void RenameConfigKey(string oldName, string newName)
    {
        if (_config.LinkAgents.TryGetValue(oldName, out var on))
        {
            _config.LinkAgents.Remove(oldName);
            _config.LinkAgents[newName] = on;
        }
        var pi = _config.LinkAgentsPinned.FindIndex(n => string.Equals(n, oldName, StringComparison.OrdinalIgnoreCase));
        if (pi >= 0) _config.LinkAgentsPinned[pi] = newName;
        if (_config.LinkAgentRemarks.TryGetValue(oldName, out var r))
        {
            _config.LinkAgentRemarks.Remove(oldName);
            _config.LinkAgentRemarks[newName] = r;
        }
        if (_config.LinkAgentVendors.TryGetValue(oldName, out var v))
        {
            _config.LinkAgentVendors.Remove(oldName);
            _config.LinkAgentVendors[newName] = v;
        }
    }

    /// <summary>删除自定义链接名：从 config 各字段移除并落盘，同时从列表移除。</summary>
    public void RemoveCustom(LinkAgentItemViewModel it)
    {
        var name = it.Name;
        _config.CustomLinkAgents.Remove(name);
        _config.LinkAgents.Remove(name);
        // OrdinalIgnoreCase 与全库一致：置顶名与自定义名大小写不一致时也能删净，避免 pinned 残留死条目
        _config.LinkAgentsPinned.RemoveAll(n => string.Equals(n, name, StringComparison.OrdinalIgnoreCase));
        _config.LinkAgentRemarks.Remove(name);
        _config.LinkAgentVendors.Remove(name);
        _configSvc.SaveConfig(_config);
        _all.Remove(it);
        PinnedItems.Remove(it);
        NormalItems.Remove(it);
        Raise(nameof(EnabledCount));
        Raise(nameof(Total));
        Raise(nameof(HasPinned));
    }
}
