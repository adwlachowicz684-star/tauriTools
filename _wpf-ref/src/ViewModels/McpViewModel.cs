using System.Collections.ObjectModel;
using System.Windows.Input;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>单个 MCP 工具的开关状态（名称 / 说明 / 是否启用）。</summary>
public sealed class McpToolItemViewModel : ViewModelBase
{
    public McpToolItemViewModel(string name, string description, bool isEnabled)
    {
        Name = name;
        Description = description;
        _isEnabled = isEnabled;
    }

    public string Name { get; }
    public string Description { get; }

    private bool _isEnabled;
    public bool IsEnabled { get => _isEnabled; set => Set(ref _isEnabled, value); }
}

/// <summary>一组 MCP 工具（按功能分组展示）。</summary>
public sealed class McpToolGroupViewModel : ViewModelBase
{
    public McpToolGroupViewModel(string name) => Name = name;

    public string Name { get; }
    public ObservableCollection<McpToolItemViewModel> Tools { get; } = new();

    public int EnabledCount => Tools.Count(t => t.IsEnabled);
}

/// <summary>
/// MCP 工具开关面板的 ViewModel：列出全部工具（分组），勾选即写入 config.mcpTools 并落盘。
/// McpServer 下次以 --mcp 启动时按该配置只暴露开启的工具，从而减少对 AI 客户端的占用。
/// </summary>
public sealed class McpViewModel : ViewModelBase
{
    private readonly AppConfig _config;
    private readonly ConfigService _configSvc;

    public McpViewModel(AppConfig config, ConfigService configSvc)
    {
        _config = config;
        _configSvc = configSvc;

        _isEnabled = config.McpEnabled;

        foreach (var group in McpToolCatalog.Groups)
        {
            var g = new McpToolGroupViewModel(group);
            foreach (var t in McpToolCatalog.All.Where(t => t.Group == group))
            {
                var enabled = !config.McpTools.TryGetValue(t.Name, out var on) || on;
                var item = new McpToolItemViewModel(t.Name, t.Description, enabled);
                item.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName == nameof(McpToolItemViewModel.IsEnabled))
                    {
                        Raise(nameof(EnabledCount));
                        Raise(nameof(Summary));
                        if (!_suppressAutoSave) Save();   // 勾选即时落盘（与面板「改动即时保存」文案一致）
                    }
                };
                g.Tools.Add(item);
            }
            Groups.Add(g);
            // 按索引奇偶拆分到左右两列，使每列独立连续堆叠、避免同行等高留白
            if (Groups.Count % 2 == 1) LeftGroups.Add(g);
            else RightGroups.Add(g);
        }
    }

    public ObservableCollection<McpToolGroupViewModel> Groups { get; } = new();

    /// <summary>左列分组（按索引奇偶拆分，与右列共同构成紧凑两列瀑布布局）。</summary>
    public ObservableCollection<McpToolGroupViewModel> LeftGroups { get; } = new();

    /// <summary>右列分组（按索引奇偶拆分）。</summary>
    public ObservableCollection<McpToolGroupViewModel> RightGroups { get; } = new();

    /// <summary>MCP 服务功能总开关：关闭后 AI 客户端无法调用任何本工具提供的 MCP 工具。</summary>
    private bool _isEnabled;
    private bool _suppressAutoSave;   // SetAll 批量置位期间抑制逐项落盘，结束时统一保存一次
    public bool IsEnabled
    {
        get => _isEnabled;
        set
        {
            if (Set(ref _isEnabled, value))
            {
                Raise(nameof(Summary));
                Save();   // 总开关即时落盘
            }
        }
    }

    public int EnabledCount => Groups.Sum(g => g.EnabledCount);
    public int TotalCount => Groups.Sum(g => g.Tools.Count);
    public string Summary => !_isEnabled
        ? "MCP 服务已停用（AI 客户端无法调用任何工具）"
        : $"已启用 {EnabledCount} / {TotalCount} 个工具";

    private ICommand? _selectAllCommand;
    public ICommand SelectAllCommand => _selectAllCommand ??= new RelayCommand(_ => SetAll(true));
    private ICommand? _selectNoneCommand;
    public ICommand SelectNoneCommand => _selectNoneCommand ??= new RelayCommand(_ => SetAll(false));

    private void SetAll(bool on)
    {
        _suppressAutoSave = true;
        try
        {
            foreach (var g in Groups)
                foreach (var t in g.Tools)
                    t.IsEnabled = on;
        }
        finally { _suppressAutoSave = false; }
        Save();   // 批量结束后统一落盘一次
        Raise(nameof(EnabledCount));
        Raise(nameof(Summary));
    }

    /// <summary>把当前勾选状态与总开关写入 config 并落盘。</summary>
    public void Save()
    {
        _config.McpEnabled = _isEnabled;
        foreach (var g in Groups)
            foreach (var t in g.Tools)
                _config.McpTools[t.Name] = t.IsEnabled;
        _configSvc.SaveConfig(_config);
    }
}
