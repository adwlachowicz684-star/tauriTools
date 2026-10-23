using System.Collections.ObjectModel;
using System.Windows.Input;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>单个可自定义快捷键项：动作显示名 / 当前键位（规范串）/ 是否默认。</summary>
public sealed class ShortcutItemViewModel : ViewModelBase
{
    private readonly Action<ShortcutItemViewModel> _onChanged;

    public ShortcutItemViewModel(string actionKey, string displayName, string defaultGesture, int group,
                                 Action<ShortcutItemViewModel> onChanged)
    {
        ActionKey = actionKey;
        DisplayName = displayName;
        DefaultGesture = defaultGesture;
        Group = group;
        _onChanged = onChanged;
        _gesture = defaultGesture;
    }

    /// <summary>动作键（配置键名，如 LockToggle）。</summary>
    public string ActionKey { get; }

    /// <summary>动作显示名（如 锁定 / 解锁）。</summary>
    public string DisplayName { get; }

    /// <summary>该动作的默认键位（规范串）。</summary>
    public string DefaultGesture { get; }

    /// <summary>面板分组（1=常规 / 2=项目操作 / 3=页签切换），路由到对应分组集合展示。</summary>
    public int Group { get; }

    private string _gesture;
    /// <summary>当前键位（规范串；空串 = 禁用该快捷键）。改动即落盘并通知主窗口重新应用。</summary>
    public string Gesture
    {
        get => _gesture;
        set
        {
            if (Set(ref _gesture, value))
            {
                Raise(nameof(IsDefault));
                Raise(nameof(CanReset));
                Raise(nameof(GestureDisplay));
                _onChanged(this);
            }
        }
    }

    /// <summary>当前键位是否为默认（含空串与默认一致的情况）。</summary>
    public bool IsDefault => string.Equals(Gesture, DefaultGesture, StringComparison.OrdinalIgnoreCase);

    /// <summary>是否可恢复默认（当前非默认时可用）。</summary>
    public bool CanReset => !IsDefault;

    /// <summary>友好显示的键位（如 Ctrl+1 / 未设置）。</summary>
    public string GestureDisplay => ShortcutGesture.Display(Gesture);
}

/// <summary>
/// 「设置」面板内的快捷键自定义列表：从 config.shortcuts 加载，改动即落盘；
/// 变更时触发 <see cref="Changed"/>，由主窗口据此重新应用 KeyBinding。
/// </summary>
public sealed class ShortcutSettingsViewModel : ViewModelBase
{
    private readonly AppConfig _config;
    private readonly ConfigService _configSvc;
    private readonly List<ShortcutItemViewModel> _all = new();
    private bool _bulk; // 批量（全部恢复默认）时跳过逐项落盘，最后统一保存一次

    public ShortcutSettingsViewModel(AppConfig config, ConfigService configSvc)
    {
        _config = config;
        _configSvc = configSvc;
        ReloadItems();
    }

    /// <summary>快捷键变更事件（主窗口据此重新应用 KeyBinding）。</summary>
    public event EventHandler? Changed;

    public ObservableCollection<ShortcutItemViewModel> Group1Items { get; } = new(); // 常规
    public ObservableCollection<ShortcutItemViewModel> Group2Items { get; } = new(); // 项目操作
    public ObservableCollection<ShortcutItemViewModel> Group3Items { get; } = new(); // 页签切换

    private void ReloadItems()
    {
        _all.Clear();
        Group1Items.Clear();
        Group2Items.Clear();
        Group3Items.Clear();
        // _bulk 抑制构造/重载期间的落盘与事件：加载快照不应触发保存
        _bulk = true;
        try
        {
            foreach (var def in ShortcutCatalog.All)
            {
                var gesture = _config.Shortcuts.TryGetValue(def.ActionKey, out var g) && !string.IsNullOrWhiteSpace(g)
                    ? g : def.DefaultGesture;
                var item = new ShortcutItemViewModel(def.ActionKey, def.DisplayName, def.DefaultGesture, def.Group, OnItemChanged);
                item.Gesture = gesture;
                _all.Add(item);
                switch (def.Group)
                {
                    case 2: Group2Items.Add(item); break;
                    case 3: Group3Items.Add(item); break;
                    default: Group1Items.Add(item); break;
                }
            }
        }
        finally { _bulk = false; }
    }

    private void OnItemChanged(ShortcutItemViewModel item)
    {
        if (_bulk) return;
        Save();
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private void Save()
    {
        foreach (var item in _all)
        {
            if (string.Equals(item.Gesture, item.DefaultGesture, StringComparison.OrdinalIgnoreCase))
                _config.Shortcuts.Remove(item.ActionKey);
            else
                _config.Shortcuts[item.ActionKey] = item.Gesture;
        }
        _configSvc.SaveConfig(_config);
    }

    private ICommand? _resetAllCommand;
    public ICommand ResetAllCommand => _resetAllCommand ??= new RelayCommand(_ => ResetAll());

    /// <summary>全部恢复默认键位。</summary>
    public void ResetAll()
    {
        _bulk = true;
        try { foreach (var item in _all) item.Gesture = item.DefaultGesture; }
        finally { _bulk = false; }
        Save();
        Changed?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>按动作键取当前键位（主窗口应用 KeyBinding 用；未知动作返回空串）。</summary>
    public string GetGesture(string actionKey)
        => _all.FirstOrDefault(i => i.ActionKey == actionKey)?.Gesture ?? "";

    // ---------------- 自定义连锁动作快捷键区（预设列表下方分隔展示） ----------------

    /// <summary>自定义连锁动作快捷键行（由主 VM 在动作清单变化时同步）。</summary>
    public ObservableCollection<ChainShortcutRow> ChainItems { get; } = new();

    /// <summary>整体重建自定义动作行（顺序即动作顺序）。</summary>
    public void SyncChainItems(IEnumerable<(string Id, string Name, string Gesture)> rows)
    {
        ChainItems.Clear();
        foreach (var r in rows) ChainItems.Add(new ChainShortcutRow(r.Id, r.Name, r.Gesture));
    }
}

/// <summary>快捷键面板·自定义连锁动作行：名称 + 当前键位（编辑经主 VM SaveChainShortcut 落盘并重绑）。</summary>
public sealed class ChainShortcutRow : ViewModelBase
{
    public ChainShortcutRow(string id, string name, string gesture)
    {
        Id = id;
        DisplayName = name;
        _gesture = gesture;
    }

    /// <summary>动作 Id（回写主 VM 用）。</summary>
    public string Id { get; }

    /// <summary>动作显示名。</summary>
    public string DisplayName { get; }

    private string _gesture;

    /// <summary>当前键位（规范串；空 = 未设置）。</summary>
    public string Gesture { get => _gesture; set { if (Set(ref _gesture, value)) { Raise(nameof(GestureDisplay)); Raise(nameof(HasGesture)); } } }

    /// <summary>是否已设置键位（控制「清除」按钮可用性）。</summary>
    public bool HasGesture => Gesture.Length > 0;

    /// <summary>友好显示串（未设置时显示占位文案）。</summary>
    public string GestureDisplay => string.IsNullOrEmpty(Gesture) ? "未设置" : ShortcutGesture.Display(Gesture);
}
