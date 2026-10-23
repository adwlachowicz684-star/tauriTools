using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Windows.Input;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.Services;
using FenPeiXiangMuZu.Views;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>
/// Agent 连锁分部：统一动作清单（config.chainActions）+ 发送管线。
/// 内置三项（审查/归并/部署）与用户自定义动作同表存储；侧栏按钮与卡片右键菜单按
/// ShowSidebar/ShowContextMenu 动态渲染；模板替换 → 确认弹窗（可编辑+本次不再提示）→ opencode 深链接。
/// </summary>
public sealed partial class MainViewModel
{
    // ---------------- 统一动作清单（惰性迁移） ----------------

    private bool _chainActionsLoaded;

    /// <summary>连锁动作有序清单：设置页页签、侧栏、右键菜单的统一数据源。构造期 EnsureChainActions 填充。</summary>
    public ObservableCollection<ChainActionItem> ChainActions { get; } = new();

    /// <summary>迁移/兜底生成 chainActions：内置 review/merge/deploy + 旧 Chain（或 opencodePromptTemplate）迁移为「opencode 连锁」置于最后。改动即时落盘。</summary>
    private void EnsureChainActions()
    {
        if (_chainActionsLoaded) return;
        _chainActionsLoaded = true;

        if (_config.ChainActions == null)
        {
            var ac = _config.AgentChain;
            var legacy = FirstNonEmpty(ac?.Chain?.Project, ac?.Chain?.Group, _config.OpencodePromptTemplate) ?? "";
            _config.ChainActions =
            [
                new() { Id = "review", Name = "一键审查", Builtin = "review", Icon = "\uE9D9",
                        Project = ac?.Review?.Project, Group = ac?.Review?.Group },
                new() { Id = "merge", Name = "快速归并", Builtin = "merge", Icon = "\uE8B5",
                        Project = ac?.Merge?.Project, Group = ac?.Merge?.Group },
                new() { Id = "deploy", Name = "快速部署", Builtin = "deploy", Icon = "\uE898",
                        Project = ac?.Deploy?.Project, Group = ac?.Deploy?.Group },
                new() { Id = "c-opencode", Name = "opencode 连锁", Icon = "\uE99A",
                        Project = legacy.Length > 0 ? legacy : null,
                        Group = legacy.Length > 0 ? legacy : null },
            ];
            _configSvc.SaveConfig(_config);
        }

        foreach (var it in _config.ChainActions) ChainActions.Add(it);
        Raise(nameof(SidebarActions));
        Raise(nameof(ContextActions));
        SyncChainRows();
    }

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

    /// <summary>侧栏动态按钮（勾选「加入侧边栏」的动作，按配置顺序）。结构变化后经 RefreshChainSurfaces 通知。</summary>
    public IEnumerable<ChainActionItem> SidebarActions => ChainActions.Where(a => a.ShowSidebar);

    /// <summary>卡片右键菜单项（勾选「加入右键菜单」的动作，按配置顺序）。</summary>
    public IEnumerable<ChainActionItem> ContextActions => ChainActions.Where(a => a.ShowContextMenu);

    /// <summary>结构或显隐变化后刷新两处动态渲染面；save=true 时同步落盘。</summary>
    internal void RefreshChainSurfaces(bool save)
    {
        Raise(nameof(SidebarActions));
        Raise(nameof(ContextActions));
        if (save) _configSvc.SaveConfig(_config);
    }

    private ChainActionItem? FindChainAction(string id) =>
        ChainActions.FirstOrDefault(a => string.Equals(a.Id, id, StringComparison.Ordinal));

    private int IndexOfChain(ChainActionItem it)
    {
        for (var i = 0; i < ChainActions.Count; i++)
            if (ReferenceEquals(ChainActions[i], it)) return i;
        return -1;
    }

    // ---------------- 模板读写（设置页 code-behind 调用；改动即时保存） ----------------

    /// <summary>读指定动作+对象类型的生效模板：自定义值 → 内置默认；自定义动作无内置默认时为空串。</summary>
    public string GetChainTemplate(string id, string kind)
    {
        var it = FindChainAction(id);
        if (it == null) return "";
        var custom = kind == "group" ? it.Group : it.Project;
        if (!string.IsNullOrWhiteSpace(custom)) return custom;
        return it.Builtin switch
        {
            "review" => kind == "group" ? AgentChainService.DefaultReviewGroup : AgentChainService.DefaultReviewProject,
            "merge" => AgentChainService.DefaultMerge,
            "deploy" => AgentChainService.DefaultDeploy,
            _ => "",
        };
    }

    /// <summary>写指定动作+对象类型的自定义模板；与内置默认一致时存 null 防膨胀；空白 = 恢复内置默认。</summary>
    public void SetChainTemplate(string id, string kind, string value)
    {
        var it = FindChainAction(id);
        if (it == null) return;
        var v = (value ?? "").Trim();
        var isDefault = it.Builtin switch
        {
            "review" => v == (kind == "group"
                ? AgentChainService.DefaultReviewGroup.Trim()
                : AgentChainService.DefaultReviewProject.Trim()),
            "merge" => v == AgentChainService.DefaultMerge.Trim(),
            "deploy" => v == AgentChainService.DefaultDeploy.Trim(),
            _ => false,
        };
        if (isDefault) v = "";
        if (kind == "group") { if ((it.Group ?? "") == v) return; it.Group = v.Length == 0 ? null : v; }
        else { if ((it.Project ?? "") == v) return; it.Project = v.Length == 0 ? null : v; }
        _configSvc.SaveConfig(_config);
    }

    // ---------------- 动作管理（设置页调用）：增 / 删 / 改名 / 排序 / 显隐 ----------------

    /// <summary>新增自定义动作（名称自动去重）；返回新项。已加入列表并落盘刷新。</summary>
    public ChainActionItem AddCustomChainAction(string name)
    {
        var n = (name ?? "").Trim();
        if (n.Length == 0) n = "新动作";
        var baseName = n;
        for (var i = 2; ChainActions.Any(a => string.Equals(a.Name, n, StringComparison.OrdinalIgnoreCase)); i++)
            n = $"{baseName}{i}";
        var item = new ChainActionItem
        {
            Id = "c" + Guid.NewGuid().ToString("N")[..8],
            Name = n,
            Icon = ChainIconCatalog.RandomUnused(ChainActions.Select(a => a.Icon)),
        };
        ChainActions.Add(item);
        _config.ChainActions = ChainActions.ToList();
        RefreshChainSurfaces(true);
        return item;
    }

    /// <summary>重命名动作；内置动作需开发者模式。成功返回 null，失败返回错误文本。</summary>
    public string? RenameChainAction(string id, string name)
    {
        var it = FindChainAction(id);
        if (it == null) return "动作不存在。";
        if (it.Builtin.Length > 0 && !_config.DevMode) return "内置动作需开启开发者模式后才能改名。";
        var n = (name ?? "").Trim();
        if (n.Length == 0) return "名称不能为空。";
        if (n.Length > 20) return "名称过长（不超过 20 字）。";
        if (ChainActions.Any(a => !ReferenceEquals(a, it)
                && string.Equals(a.Name, n, StringComparison.OrdinalIgnoreCase)))
            return "同名动作已存在。";
        if (it.Name == n) return null;
        it.Name = n;
        RefreshChainSurfaces(true);
        return null;
    }

    /// <summary>删除动作；内置动作需开发者模式。成功返回 null，失败返回错误文本。</summary>
    public string? RemoveChainAction(string id)
    {
        var it = FindChainAction(id);
        if (it == null) return "动作不存在。";
        if (it.Builtin.Length > 0 && !_config.DevMode) return "内置动作需开启开发者模式后才能删除。";
        ChainActions.Remove(it);
        _config.ChainActions = ChainActions.ToList();
        RefreshChainSurfaces(true);
        return null;
    }

    /// <summary>把自定义动作移动到目标绝对下标（自动夹取到自定义区段内）；内置不参与排序。</summary>
    public void MoveChainActionTo(string id, int absIndex)
    {
        var it = FindChainAction(id);
        if (it == null || it.Builtin.Length > 0) return;
        var i = IndexOfChain(it);
        var firstCustom = -1;
        for (var k = 0; k < ChainActions.Count; k++)
            if (ChainActions[k].Builtin.Length == 0) { firstCustom = k; break; }
        if (i < 0 || firstCustom < 0) return;
        var j = Math.Clamp(absIndex, firstCustom, ChainActions.Count - 1);
        if (j == i) return;
        ChainActions.Move(i, j);
        _config.ChainActions = ChainActions.ToList();
        RefreshChainSurfaces(true);
    }

    /// <summary>更新动作的侧栏/右键菜单显隐勾选（任传 null 表示该项不变）。即时保存并刷新渲染面。</summary>
    public void SetChainFlags(string id, bool? sidebar, bool? context)
    {
        var it = FindChainAction(id);
        if (it == null) return;
        var changed = false;
        if (sidebar.HasValue && it.ShowSidebar != sidebar.Value) { it.ShowSidebar = sidebar.Value; changed = true; }
        if (context.HasValue && it.ShowContextMenu != context.Value) { it.ShowContextMenu = context.Value; changed = true; }
        if (!changed) return;
        RefreshChainSurfaces(true);
    }

    // ---------------- 设置页选中态与开发者模式 ----------------

    /// <summary>开发者模式：开启后设置页允许删除/重命名内置连锁页签。</summary>
    public bool DevMode
    {
        get => _config.DevMode;
        set
        {
            if (_config.DevMode == value) return;
            _config.DevMode = value;
            Raise(nameof(DevMode));
            _configSvc.SaveConfig(_config);
        }
    }

    private ChainActionItem? _selectedChainAction;

    /// <summary>设置页当前选中的动作页签（ListBox TwoWay 绑定）。</summary>
    public ChainActionItem? SelectedChainAction
    {
        get => _selectedChainAction;
        set
        {
            if (!Set(ref _selectedChainAction, value)) return;
            Raise(nameof(SelectedIsBuiltin));
        }
    }

    /// <summary>当前选中动作是否为内置（页签右键菜单据此隐藏改名/删除，开发者模式除外）。</summary>
    public bool SelectedIsBuiltin => _selectedChainAction?.Builtin.Length > 0;

    // ---------------- 发送客户端（opencode/trae/cursor/vscode…） ----------------

    private List<ChainClientDef>? _chainClients;
    private List<ChainClientChoice>? _chainClientChoices;
    private List<ChainClientCard>? _chainClientCards;
    private ChainClientCard? _selectedChainClientCard;

    /// <summary>已检测到的可发送桌面客户端（内置目录，仅本机已安装）。</summary>
    public IReadOnlyList<ChainClientDef> ChainClients => _chainClients ??= ChainClientCatalog.DetectInstalled();

    /// <summary>用户手动添加的连锁客户端（强制显示，不入自动检测）。</summary>
    private List<CustomChainClientConfig> CustomChainClients =>
        _config.CustomChainClients ??= new List<CustomChainClientConfig>();

    /// <summary>全局「默认客户端」卡片列表：内置已安装 + 用户手动添加。</summary>
    public IReadOnlyList<ChainClientCard> ChainClientCards => _chainClientCards ??= BuildChainClientCards();

    private List<ChainClientCard> BuildChainClientCards()
    {
        var list = new List<ChainClientCard>();
        foreach (var c in ChainClients) list.Add(ChainClientCard.Regular(c.Id, c.DisplayName));
        foreach (var c in CustomChainClients)
        {
            if (list.Any(x => x.Id == c.Id)) continue;
            list.Add(ChainClientCard.Custom(c));
        }
        return list;
    }

    /// <summary>发送客户端选择下拉（含「默认（跟随全局）」首项）。用于动作级下拉数据源。</summary>
    public IReadOnlyList<ChainClientChoice> ChainClientChoices => _chainClientChoices ??= BuildChainClientChoices();

    private List<ChainClientChoice> BuildChainClientChoices()
    {
        // 首项 Value = "" 表示「跟随全局默认」（SetChainClient 会把空串写入 null）
        var list = new List<ChainClientChoice> { new("", "默认（跟随全局）") };
        foreach (var c in ChainClientCards) list.Add(new ChainClientChoice(c.Id, c.DisplayName));
        return list;
    }

    /// <summary>全局「默认客户端」卡片当前选中项（双向）；选中即写 config.DefaultChainClient。</summary>
    public ChainClientCard? SelectedChainClientCard
    {
        get
        {
            if (_selectedChainClientCard != null && ChainClientCards.Contains(_selectedChainClientCard))
                return _selectedChainClientCard;
            _selectedChainClientCard = ChainClientCards.FirstOrDefault(c => c.Id == DefaultChainClient)
                ?? ChainClientCards.FirstOrDefault();
            return _selectedChainClientCard;
        }
        set
        {
            if (_selectedChainClientCard is not null && ReferenceEquals(_selectedChainClientCard, value)) return;
            _selectedChainClientCard = value;
            Raise(nameof(SelectedChainClientCard));
            if (value != null) SetDefaultChainClient(value.Id);
        }
    }

    /// <summary>重新扫描本机已安装客户端并刷新列表（设置页「刷新检测」按钮）。</summary>
    public void RefreshChainClients()
    {
        _chainClients = ChainClientCatalog.DetectInstalled();
        _chainClientChoices = null;
        _chainClientCards = null;
        _selectedChainClientCard = null;
        Raise(nameof(ChainClients));
        Raise(nameof(ChainClientChoices));
        Raise(nameof(ChainClientCards));
        Raise(nameof(DefaultChainClient));
    }

    /// <summary>全局默认发送客户端 Id；config 未设时回退 opencode（卡片当前选中值）。</summary>
    public string DefaultChainClient => _config.DefaultChainClient ?? "opencode";

    /// <summary>设置全局默认发送客户端 Id（null/空 = 回退 opencode）。改动即时落盘。</summary>
    public void SetDefaultChainClient(string? id)
    {
        var v = string.IsNullOrWhiteSpace(id) ? null : id;
        var target = v != null && IsKnownChainClientId(v) ? v : null;
        if (_config.DefaultChainClient == target) return;
        _config.DefaultChainClient = target;
        Raise(nameof(DefaultChainClient));
        Raise(nameof(SelectedChainClientCard));
        _configSvc.SaveConfig(_config);
    }

    /// <summary>手动添加客户端：按 exe 去重后加入（或改名）并选中该卡，改动即时落盘。</summary>
    public void AddCustomChainClient(string name, string exe)
    {
        var n = (name ?? "").Trim();
        var e = (exe ?? "").Trim();
        if (n.Length == 0 || e.Length == 0) return;
        var list = CustomChainClients;
        var exist = list.FirstOrDefault(c => string.Equals(c.Exe, e, StringComparison.OrdinalIgnoreCase));
        string id;
        if (exist != null)
        {
            if (exist.Name == n) { SelectChainClientCard(exist.Id); return; }
            exist.Name = n;
            id = exist.Id;
        }
        else
        {
            id = "custom:" + Guid.NewGuid().ToString("N")[..10];
            list.Add(new CustomChainClientConfig { Id = id, Name = n, Exe = e });
        }
        _configSvc.SaveConfig(_config);
        RebuildChainClientLists();
        SelectChainClientCard(id);
    }

    /// <summary>动作生效发送客户端 Id：动作专属 → 全局默认 → opencode。</summary>
    public string ResolveChainClientId(string actionId)
    {
        var it = FindChainAction(actionId);
        if (it != null && !string.IsNullOrWhiteSpace(it.Client) && IsKnownChainClientId(it.Client))
            return it.Client!;
        return DefaultChainClient;
    }

    /// <summary>动作下拉当前值（其专属 Client；null = 跟随全局）。</summary>
    public string? GetChainClientValue(string actionId) => FindChainAction(actionId)?.Client ?? "";

    /// <summary>设置动作专属发送客户端；value 为 null/空 = 跟随全局默认。改动即时落盘。</summary>
    public void SetChainClient(string actionId, string? value)
    {
        var it = FindChainAction(actionId);
        if (it == null) return;
        var v = string.IsNullOrWhiteSpace(value) ? null : value;
        if (it.Client == v) return;
        it.Client = v;
        _configSvc.SaveConfig(_config);
    }

    private bool IsKnownChainClientId(string id) =>
        ChainClientCatalog.ById(id) != null || CustomChainClients.Any(c => c.Id == id);

    private void RebuildChainClientLists()
    {
        _chainClientChoices = null;
        _chainClientCards = null;
        _selectedChainClientCard = null;
        Raise(nameof(ChainClientChoices));
        Raise(nameof(ChainClientCards));
    }

    private void SelectChainClientCard(string id) => SelectedChainClientCard =
        ChainClientCards.FirstOrDefault(c => c.Id == id);

    // ---------------- 图标与快捷键 ----------------

    /// <summary>连锁快捷键变更后请求主窗口重新应用 KeyBinding（设置页快捷键面板经 Shortcuts.Changed 联动）。</summary>
    public event EventHandler? ChainShortcutsChanged;

    /// <summary>设置动作图标（页签与侧栏即时刷新）。即时落盘。</summary>
    public void SaveChainIcon(string id, string glyph)
    {
        var it = FindChainAction(id);
        if (it == null || it.Icon == glyph) return;
        it.Icon = glyph;
        RefreshChainSurfaces(true);
    }

    /// <summary>设置动作自定义快捷键（规范串；空串=清除）。成功返回 null，失败返回错误文本。
    /// 落盘后同步快捷键面板行并通知主窗口重绑。</summary>
    public string? SaveChainShortcut(string id, string gesture)
    {
        var it = FindChainAction(id);
        if (it == null) return "动作不存在。";
        var g = (gesture ?? "").Trim();
        if (g.Length > 0)
        {
            try { _ = new System.Windows.Input.KeyGestureConverter().ConvertFromString(g); }
            catch { return "键位格式无法识别。"; }
            var conflictPreset = _config.Shortcuts.Values.Any(v => string.Equals(v, g, StringComparison.OrdinalIgnoreCase));
            var conflictChain = ChainActions.Any(a => !ReferenceEquals(a, it)
                && string.Equals(a.Shortcut, g, StringComparison.OrdinalIgnoreCase));
            if (conflictPreset || conflictChain) return "该键位已被其他动作占用。";
        }
        if (it.Shortcut == g) return null;
        it.Shortcut = g;
        _configSvc.SaveConfig(_config);
        SyncChainRows();
        ChainShortcutsChanged?.Invoke(this, EventArgs.Empty);
        return null;
    }

    /// <summary>把动作快捷键同步到 设置→快捷键 面板的自定义区（顺序即动作顺序）。</summary>
    internal void SyncChainRows() =>
        Shortcuts.SyncChainItems(ChainActions.Select(a => (a.Id, a.Name, a.Shortcut)));

    // ---------------- 发送命令与统一管线 ----------------

    private ICommand? _chainActionSendCommand;

    /// <summary>侧栏动态按钮发送命令（参数=动作 Id，作用于当前选中卡片）。</summary>
    public ICommand ChainActionSendCommand => _chainActionSendCommand ??= new RelayCommand(o => SendAgentChain(o as string ?? ""));

    /// <summary>会话级「不再提示」记忆（按动作 Id；重启即复位）。</summary>
    private readonly HashSet<string> _chainSkipConfirm = new(StringComparer.Ordinal);

    /// <summary>
    /// 统一发送管线：id 定位动作 → 模板占位符替换 → 确认弹窗（可编辑 + 本次客户端期间不再提示）
    /// → opencode 深链接新建会话。card 缺省使用当前选中卡片（右键菜单场景显式传入被点卡片）。
    /// </summary>
    private DateTime _lastChainTriggerTime = DateTime.MinValue;
    private string? _lastChainTriggerId;

    public void SendAgentChain(string id, FolderCardViewModel? card = null)
    {
        // 防抖：同一动作 400ms 内的重复触发忽略（浮层关闭瞬间落下的手抖双击等）
        var now = DateTime.Now;
        if (id == _lastChainTriggerId && (now - _lastChainTriggerTime).TotalMilliseconds < 400) return;
        (_lastChainTriggerId, _lastChainTriggerTime) = (id, now);

        card ??= SelectedCard;
        var action = FindChainAction(id);
        if (action == null) { Log("连锁动作不存在或已被删除。", true); return; }
        if (card == null) { Log("请先选中一个项目组或项目。", true); return; }
        if (!Directory.Exists(card.FullPath)) { Log($"文件夹不存在: {card.FullPath}", true); return; }

        Log($"[连锁触发] 动作={action.Name} 目标={(card.Kind == "group" ? "项目组" : "项目")}:{card.DisplayName}");

        var title = action.Name;
        var prompt = AgentChainService.ReplacePlaceholders(GetChainTemplate(id, card.Kind), card.DisplayName, card.FullPath);

        if (!_chainSkipConfirm.Contains(id))
        {
            var isGroup = card.Kind == "group";
            var linkedName = isGroup
                ? ""
                : (string.IsNullOrEmpty(card.LinkedGroupPath) ? "" : card.LinkedGroup);
            var result = AgentChainConfirmDialog.Show(
                title,
                isGroup ? "项目组" : "项目",
                card.DisplayName,
                card.FullPath,
                linkedName,
                prompt,
                skip: false);
            if (result == null) { Log($"已取消{title}任务。"); return; }

            if (result.SkipForSession) _chainSkipConfirm.Add(id);
            prompt = result.Prompt;
        }

        if (string.IsNullOrWhiteSpace(prompt))
        {
            Log($"{title}：指令内容为空，未发送。可在 设置→Agent 连锁 中填写模板。", true);
            return;
        }

        var clientId = ResolveChainClientId(id);
        var customCard = ChainClientCards.FirstOrDefault(c => c.IsCustom && c.Id == clientId);
        var sendResult = customCard != null
            ? ChainClientCatalog.SendCustom(customCard.DisplayName, customCard.Exe, customCard.Scheme, card.FullPath, prompt)
            : ChainClientCatalog.Send(clientId, card.FullPath, prompt);
        if (!sendResult.Ok)
        {
            Log($"[{title}] 发送失败：{sendResult.Message}", true);
            return;
        }

        Log($"[{title}] {sendResult.Message}");
        if (sendResult.NeedsPaste)
            Dialog.Service.Alert($"{title}：{sendResult.Message}", "请手动粘贴指令");
    }
}

/// <summary>连锁客户端卡片项（全局「默认客户端」选择区展示与动作级下拉共用；自定义项强制显示）。</summary>
public sealed class ChainClientCard
{
    private ChainClientCard(string id, string displayName, bool isCustom, string? exe, string? scheme)
    {
        Id = id;
        DisplayName = displayName;
        IsCustom = isCustom;
        Exe = exe;
        Scheme = scheme;
    }

    /// <summary>内置已安装客户端。</summary>
    public static ChainClientCard Regular(string id, string name) => new(id, name, false, null, null);

    /// <summary>用户手动添加的客户端。</summary>
    public static ChainClientCard Custom(CustomChainClientConfig c) => new(c.Id, c.Name, true, c.Exe, c.Scheme);

    public string Id { get; }

    public string DisplayName { get; }

    /// <summary>是否为手动添加项（用于发送时走 SendCustom）。</summary>
    public bool IsCustom { get; }

    public string? Exe { get; }

    public string? Scheme { get; }

    /// <summary>头像占位字母（首字符大写）。</summary>
    public string Avatar => string.IsNullOrEmpty(DisplayName) ? "?" : DisplayName.Substring(0, 1).ToUpperInvariant();
}
