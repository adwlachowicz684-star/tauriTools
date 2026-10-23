using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Windows.Input;
using FenPeiXiangMuZu.Models;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>
/// 浏览区展示节点（agent / skill 条目）。可能是目录（skill 目录型，IsFolder=true）
/// 或叶子文件。IsSelected 用于行内选中后显示「预览/打开」操作。
/// </summary>
public sealed class AgentSkillNode : ViewModelBase
{
    private string _kind;
    private string _relPath;
    private string _sourcePath;
    private bool _isFolder;
    private bool _isSelected;
    private int _depth;
    private bool _isDirEntry;
    private bool _canRename = true;

    public AgentSkillNode(string kind, string relPath, string sourcePath, bool isFolder)
    {
        _kind = kind;
        _relPath = relPath;
        _sourcePath = sourcePath;
        _isFolder = isFolder;
    }

    /// <summary>树层级深度（根层=1，逐级累加）；用于分级色带随深度递进。</summary>
    public int Depth { get => _depth; set => Set(ref _depth, value); }

    /// <summary>类别：agent / skill / rule。</summary>
    public string Kind { get => _kind; set => Set(ref _kind, value); }

    /// <summary>相对源目录（agent/ 或 skill/）的路径；反斜杠分隔。</summary>
    public string RelPath { get => _relPath; set => Set(ref _relPath, value); }

    /// <summary>源绝对路径（文件或目录）。</summary>
    public string SourcePath { get => _sourcePath; set => Set(ref _sourcePath, value); }

    /// <summary>是否为目录类节点（skill 目录型 / 单文件 skill 为 false）。</summary>
    public bool IsFolder { get => _isFolder; set => Set(ref _isFolder, value); }

    /// <summary>叶子条目是否指向物理目录（如 skill 目录型）。构建时一次性判定，供右键菜单显隐。</summary>
    public bool IsDirEntry { get => _isDirEntry; set => Set(ref _isDirEntry, value); }

    /// <summary>是否允许重命名（rules+rule 并存时的顶层包装分支为 false——改名会脱离工具识别）。</summary>
    public bool CanRename { get => _canRename; set => Set(ref _canRename, value); }

    /// <summary>右键「打开文件」可见性：普通文件叶子（非目录型条目、非文件夹）。</summary>
    public bool ShowOpenFile => !IsFolder && !IsDirEntry;

    /// <summary>右键「打开 SKILL.md」可见性：仅 skill 目录型条目。</summary>
    public bool CanOpenSkillMd => IsDirEntry;

    /// <summary>右键「打开所在文件夹」可见性：全部文件夹 + 目录型条目。</summary>
    public bool ShowOpenContaining => IsFolder || IsDirEntry;

    /// <summary>是否选中（行内高亮 + 「预览/打开」取用）。</summary>
    public bool IsSelected { get => _isSelected; set => Set(ref _isSelected, value); }

    /// <summary>目录节点是否展开（默认展开，直观显示层级）。</summary>
    private bool _isExpanded = true;
    public bool IsExpanded { get => _isExpanded; set => Set(ref _isExpanded, value); }

    /// <summary>显示名：叶子去 .md；目录取末级。</summary>
    public string DisplayName
    {
        get
        {
            if (!IsFolder) return Path.GetFileNameWithoutExtension(RelPath);
            var r = RelPath.TrimEnd('\\', '/');
            return string.IsNullOrEmpty(r) ? Kind : Path.GetFileName(r);
        }
    }

    public ObservableCollection<AgentSkillNode> Children { get; } = new();
}

/// <summary>
/// 「Agent/Skill 内容浏览区」ViewModel：按项目组根目录列出 agents / skills / rules 三棵树，
/// 支持刷新、打开 agent/skill/rule 目录、预览文件内容。
/// 协调者通过 <see cref="ShowGroup"/> 注入当前选中的项目组路径。
/// </summary>
public sealed class AgentSkillViewModel : ViewModelBase
{
    private readonly IconService _icons;
    /// <summary>取当前配置的编辑器程序路径（宿主注入；null/空串 = 跟随系统默认）。</summary>
    private readonly Func<string>? _editToolPathProvider;
    private string? _lastPreviewFile;
    /// <summary>当前预览区所展示的 md 文件绝对路径；无预览时为 null（供内置 MD 编辑器默认打开）。</summary>
    public string? LastPreviewFile => _lastPreviewFile;
    private string _groupPath;
    private string? _message;
    private int _agentCount;
    private int _skillCount;
    private int _ruleCount;

    public AgentSkillViewModel(IconService icons, string groupPath = "", Func<string>? editToolPathProvider = null)
    {
        _icons = icons;
        _editToolPathProvider = editToolPathProvider;
        _groupPath = groupPath ?? "";
        Agents.CollectionChanged += (s, e) => Raise(nameof(AgentDirCount));
        Skills.CollectionChanged += (s, e) => Raise(nameof(SkillDirCount));
        Rules.CollectionChanged += (s, e) => Raise(nameof(RuleDirCount));
    }

    /// <summary>当前项目组根目录；set 触发刷新。</summary>
    public string GroupPath
    {
        get => _groupPath;
        set
        {
            if (Set(ref _groupPath, value ?? ""))
                Refresh();
        }
    }

    /// <summary>agents 分节节点集合。</summary>
    public ObservableCollection<AgentSkillNode> Agents { get; } = new();

    /// <summary>skills 分节节点集合。</summary>
    public ObservableCollection<AgentSkillNode> Skills { get; } = new();

    /// <summary>rules 分节节点集合（rules/rule 并存时顶层为两个目录分支）。</summary>
    public ObservableCollection<AgentSkillNode> Rules { get; } = new();

    public int AgentCount { get => _agentCount; set => Set(ref _agentCount, value); }
    public int SkillCount { get => _skillCount; set => Set(ref _skillCount, value); }
    public int RuleCount { get => _ruleCount; set => Set(ref _ruleCount, value); }

    /// <summary>agents 树最上层节点数（标题「目录」）。</summary>
    public int AgentDirCount => Agents.Count;

    /// <summary>skills 树最上层节点数（标题「目录」）。</summary>
    public int SkillDirCount => Skills.Count;

    /// <summary>rules 树最上层节点数（标题「目录」；rules+rule 并存时为 2）。</summary>
    public int RuleDirCount => Rules.Count;

    /// <summary>状态/错误提示文本。</summary>
    public string? Message { get => _message; private set => Set(ref _message, value); }

    /// <summary>预览输出回调：宿主(主窗口)注入后，预览内容写入其内嵌区域，而不弹独立窗口。</summary>
    public Action<string>? PreviewHandler { get; set; }

    // ---------------- 命令 ----------------

    private ICommand? _refreshCommand;
    public ICommand RefreshCommand => _refreshCommand ??= new RelayCommand(_ => Refresh());
    private ICommand? _openAgentDirCommand;
    public ICommand OpenAgentDirCommand => _openAgentDirCommand ??= new RelayCommand(_ => OpenAgentDir());
    private ICommand? _openSkillDirCommand;
    public ICommand OpenSkillDirCommand => _openSkillDirCommand ??= new RelayCommand(_ => OpenSkillDir());
    private ICommand? _openRuleDirCommand;
    public ICommand OpenRuleDirCommand => _openRuleDirCommand ??= new RelayCommand(_ => OpenRuleDir());
    /// <summary>选中一个节点：目录节点切换展开/折叠；叶子节点行内高亮并直接预览内容。</summary>
    private ICommand? _selectCommand;
    public ICommand SelectCommand => _selectCommand ??= new RelayCommand(o =>
    {
        if (o is not AgentSkillNode n) return;
        if (n.IsFolder) { ClearSelection(); n.IsExpanded = !n.IsExpanded; return; }
        ClearSelection();
        n.IsSelected = true;
        Preview(n);
    });

    /// <summary>预览区「打开编辑」：按设置用指定编辑器（未配置则跟随系统默认程序）打开当前预览的源文件。</summary>
    private ICommand? _openEditCommand;
    public ICommand OpenEditCommand => _openEditCommand ??= new RelayCommand(_ =>
    {
        var f = _lastPreviewFile;
        if (string.IsNullOrEmpty(f)) return;
        AgentSkillService.OpenWithEditor(_editToolPathProvider?.Invoke() ?? "", f);
    });

    // ---------------- 右键菜单命令 ----------------

    /// <summary>右键：仅高亮节点（不触发展开切换/预览副作用）。</summary>
    private ICommand? _rightClickCommand;
    public ICommand RightClickCommand => _rightClickCommand ??= new RelayCommand(o =>
    {
        if (o is not AgentSkillNode n) return;
        ClearSelection();
        n.IsSelected = true;
    });

    private ICommand? _copyNameCommand;
    public ICommand CopyNameCommand => _copyNameCommand ??= new RelayCommand(o =>
    {
        if (o is AgentSkillNode n) Dialog.Service.SetClipboard(n.DisplayName);
    });

    private ICommand? _copyFileNameCommand;
    public ICommand CopyFileNameCommand => _copyFileNameCommand ??= new RelayCommand(o =>
    {
        if (o is not AgentSkillNode n) return;
        var phys = ResolvePhysical(n);
        // 叶子=文件名(含扩展名)/目录名；skill 虚拟层无物理定位时退回显示名
        Dialog.Service.SetClipboard(phys != null ? Path.GetFileName(phys.TrimEnd('\\')) : n.DisplayName);
    });

    private ICommand? _copyPathCommand;
    public ICommand CopyPathCommand => _copyPathCommand ??= new RelayCommand(o =>
    {
        if (o is not AgentSkillNode n) return;
        var phys = ResolvePhysical(n);
        // 完整绝对物理路径；skill 虚拟层无物理定位时退回显示名
        Dialog.Service.SetClipboard(phys != null ? phys.TrimEnd('\\') : n.DisplayName);
    });

    private ICommand? _openFileCommand;
    public ICommand OpenFileCommand => _openFileCommand ??= new RelayCommand(o =>
    {
        if (o is AgentSkillNode { IsFolder: false, IsDirEntry: false } n)
            AgentSkillService.OpenFile(n.SourcePath);
    });

    private ICommand? _openSkillMdCommand;
    public ICommand OpenSkillMdCommand => _openSkillMdCommand ??= new RelayCommand(o =>
    {
        if (o is AgentSkillNode { IsDirEntry: true } n)
            AgentSkillService.OpenFile(Path.Combine(n.SourcePath, AgentSkillService.SkillMarkdownName));
    });

    private ICommand? _openContainingCommand;
    public ICommand OpenContainingCommand => _openContainingCommand ??= new RelayCommand(o =>
    {
        if (o is not AgentSkillNode n) return;
        // 文件夹：物理目录直接打开，skill 虚拟层取首个后代叶子所在目录；叶子定位高亮
        var target = n.IsFolder ? ResolvePhysical(n) : n.SourcePath;
        if (!string.IsNullOrEmpty(target)) AgentSkillService.OpenFolderOf(target);
    });

    private ICommand? _renameCommand;
    public ICommand RenameCommand => _renameCommand ??= new RelayCommand(o =>
    {
        if (o is AgentSkillNode n) RenameNode(n);
    });

    /// <summary>清除所有节点（agent/skill/rule 三棵树）的选中态，保证同时仅一个高亮。</summary>
    private void ClearSelection()
    {
        foreach (var n in Agents) ClearSel(n);
        foreach (var n in Skills) ClearSel(n);
        foreach (var n in Rules) ClearSel(n);
    }

    private static void ClearSel(AgentSkillNode n)
    {
        n.IsSelected = false;
        foreach (var c in n.Children) ClearSel(c);
    }

    // ---------------- 命令实现 ----------------

    private void Log(string text, bool isError = false)
    {
        Message = (isError ? "[错误] " : "") + text;
        System.Diagnostics.Debug.WriteLine(text);
    }

    private void OpenAgentDir()
    {
        var root = (_groupPath ?? "").Trim();
        var dir = root.Length > 0 ? AgentSkillService.AgentDir(root) : null;
        AgentSkillService.OpenDir(dir ?? "");
    }

    private void OpenSkillDir()
    {
        var root = (_groupPath ?? "").Trim();
        var dir = root.Length > 0 ? AgentSkillService.SkillDir(root) : null;
        AgentSkillService.OpenDir(dir ?? "");
    }

    private void OpenRuleDir()
    {
        var root = (_groupPath ?? "").Trim();
        if (root.Length == 0) return;
        var dirs = AgentSkillService.RuleDirs(root);
        // 双目录并存时打开项目组根目录，两个规则文件夹均可见；单目录直接打开
        AgentSkillService.OpenDir(dirs.Count == 1 ? dirs[0] : (dirs.Count == 0 ? "" : root));
    }

    // ---------------- 重命名 ----------------

    private static readonly char[] InvalidNameChars = { '\\', '/', ':', '*', '?', '"', '<', '>', '|' };

    /// <summary>文件系统名称校验：非空、不含非法字符、不以点结尾。</summary>
    private static string? ValidateFsName(string? raw)
    {
        var t = (raw ?? "").Trim();
        if (t.Length == 0) return "名称不能为空。";
        if (t.IndexOfAny(InvalidNameChars) >= 0) return "名称不能包含 \\ / : * ? \" < > | 字符。";
        if (t.EndsWith(".")) return "名称不能以点结尾。";
        return null;
    }

    /// <summary>skill 层级段名校验：在文件系统名基础上禁止下划线（会破坏层级拆分）。</summary>
    private static string? ValidateSegmentName(string? raw)
    {
        var err = ValidateFsName(raw);
        if (err != null) return err;
        return (raw ?? "").Trim().Contains('_') ? "层级名不能包含下划线 _（会破坏层级拆分）。" : null;
    }

    /// <summary>
    /// 重命名分派：
    ///   skill 虚拟层文件夹 → 批量替换子树条目物理名中的对应 "_" 段；
    ///   skill 目录型 → 改目录整名；其余叶子 → 改文件名（保留扩展名）；
    ///   agent/rule 文件夹 → 改物理目录名。
    /// </summary>
    private void RenameNode(AgentSkillNode n)
    {
        if (!n.CanRename) return;
        if (string.Equals(n.Kind, "skill", StringComparison.OrdinalIgnoreCase))
        {
            if (n.IsFolder) RenameSkillSegment(n);
            else if (n.IsDirEntry) RenameEntry(n, keepExtension: false, isDir: true);
            else RenameEntry(n, keepExtension: true, isDir: false);
            return;
        }
        if (n.IsFolder) RenameEntry(n, keepExtension: false, isDir: true);
        else RenameEntry(n, keepExtension: true, isDir: false);
    }

    /// <summary>单个物理条目重命名；成功后刷新三棵树并重新选中新节点（叶子顺带预览）。</summary>
    private void RenameEntry(AgentSkillNode n, bool keepExtension, bool isDir)
    {
        var src = n.SourcePath;
        var exists = isDir ? Directory.Exists(src) : File.Exists(src);
        if (string.IsNullOrEmpty(src) || !exists)
        {
            Dialog.Service.Alert("源路径不存在，请刷新后重试。");
            return;
        }

        var oldName = Path.GetFileName(src.TrimEnd('\\'));
        var ext = keepExtension ? Path.GetExtension(src) : "";
        var newName = Dialog.Service.Prompt("重命名",
            isDir ? "新名称：" : "新名称（不含扩展名）：", oldName, ValidateFsName);
        if (newName == null || newName == oldName) return;

        var target = Path.Combine(Path.GetDirectoryName(src)!, newName + ext);
        if (!EnsureTargetFree(target)) return;
        try
        {
            // 浏览区条目可能位于受 ACL 只读/防删除保护的项目组内：经祖先探测摘锁后执行（E009b）
            FolderLockService.WithUnlockForPath(src, () =>
            {
                if (isDir) Directory.Move(src, target);
                else File.Move(src, target);
            });
        }
        catch (Exception ex)
        {
            Dialog.Service.Alert("重命名失败：" + ex.Message);
            return;
        }

        RefreshAndSelect(n.Kind, ReplaceLastSegment(n.RelPath, newName, n.Kind));
    }

    /// <summary>skill 虚拟层重命名：批量替换子树所有条目物理名中对应 "_" 段；先全量冲突检查再执行。</summary>
    private void RenameSkillSegment(AgentSkillNode folder)
    {
        var leaves = CollectLeaves(folder);
        if (leaves.Count == 0)
        {
            Dialog.Service.Alert("该层级下没有可改名的条目。");
            return;
        }

        var oldSeg = folder.DisplayName;   // 当前段名（RelPath 末级）
        var segIndex = folder.Depth - 1;   // 物理名 Split('_') 后的段下标
        var newName = Dialog.Service.Prompt("重命名层级",
            $"批量替换「{oldSeg}」层下 {leaves.Count} 个条目的对应段。新层级名：", oldSeg, ValidateSegmentName);
        if (newName == null || newName == oldSeg) return;

        var moves = new List<(string From, string To, bool IsDir)>();
        foreach (var leaf in leaves)
        {
            var src = leaf.SourcePath;
            var isDir = leaf.IsDirEntry;
            var exists = isDir ? Directory.Exists(src) : File.Exists(src);
            if (string.IsNullOrEmpty(src) || !exists) continue;

            var namePart = isDir ? Path.GetFileName(src.TrimEnd('\\')) : Path.GetFileNameWithoutExtension(src);
            var segs = namePart.Split('_');
            if (segIndex >= segs.Length || segs[segIndex] != oldSeg) continue;

            segs[segIndex] = newName;
            var dirPart = Path.GetDirectoryName(src)!;
            var to = isDir
                ? Path.Combine(dirPart, string.Join('_', segs))
                : Path.Combine(dirPart, string.Join('_', segs) + Path.GetExtension(src));
            moves.Add((src, to, isDir));
        }
        if (moves.Count == 0)
        {
            Dialog.Service.Alert("没有匹配的条目可改名，请刷新后重试。");
            return;
        }
        foreach (var m in moves)
        {
            if (!EnsureTargetFree(m.To)) return;   // 任一冲突即整体取消，不做半截改动
        }

        try
        {
            foreach (var m in moves)
            {
                // 同 E009b：逐条目经祖先探测摘锁执行（同子树通常同锁根，嵌套可重入无额外开销）
                FolderLockService.WithUnlockForPath(m.From, () =>
                {
                    if (m.IsDir) Directory.Move(m.From, m.To);
                    else File.Move(m.From, m.To);
                });
            }
        }
        catch (Exception ex)
        {
            Dialog.Service.Alert("批量重命名中断：" + ex.Message);
            Refresh();
            return;
        }

        RefreshAndSelect(folder.Kind, ReplaceLastSegment(folder.RelPath, newName, folder.Kind));
    }

    /// <summary>目标路径空闲检查；已存在时弹窗提示并返回 false。</summary>
    private static bool EnsureTargetFree(string target)
    {
        if (!Directory.Exists(target) && !File.Exists(target)) return true;
        Dialog.Service.Alert("目标名称已存在，请换一个名字：\n" + target);
        return false;
    }

    /// <summary>RelPath 末级段替换；skill 按约定把新段中的 '_' 虚拟化为 '\'。</summary>
    private static string ReplaceLastSegment(string relPath, string lastSeg, string kind)
    {
        var idx = relPath.LastIndexOf('\\');
        var head = idx >= 0 ? relPath[..(idx + 1)] : "";
        var leafSeg = string.Equals(kind, "skill", StringComparison.OrdinalIgnoreCase)
            ? lastSeg.Replace('_', '\\')
            : lastSeg;
        return head + leafSeg;
    }

    /// <summary>刷新三棵树并按 Kind+RelPath 重新选中节点（叶子顺带预览内容）。</summary>
    private void RefreshAndSelect(string kind, string relPath)
    {
        Refresh();
        var node = FindNode(kind, relPath);
        if (node == null) return;
        ClearSelection();
        node.IsSelected = true;
        node.IsExpanded = true;
        if (!node.IsFolder) Preview(node);
    }

    private void Preview(AgentSkillNode? node)
    {
        if (node == null) { Log("请选择要预览的条目。", true); return; }
        if (node.IsFolder) { Log("目录条目不支持直接预览，请在列表中打开。", true); return; }
        var path = node.SourcePath;
        if (Directory.Exists(path)) path = Path.Combine(path, AgentSkillService.SkillMarkdownName);
        _lastPreviewFile = path;   // 供预览区「打开编辑」按钮定位源文件
        var content = AgentSkillService.ReadPreview(path);
        // 空 md / 读取失败均清空预览区（显示为空白），不报错
        PreviewHandler?.Invoke(content);
        if (content.Length == 0) Message = "（文件为空）";
    }

    // ---------------- 协调/刷新 ----------------

    /// <summary>协调者选中项目组时调用：设置 GroupPath 并刷新浏览区。</summary>
    public void ShowGroup(string groupPath)
    {
        GroupPath = groupPath;
    }

    /// <summary>重扫当前 GroupPath 下的 agent / skill / rule，重建三棵树。任何枚举异常只记提示，不崩界面。</summary>
    public void Refresh()
    {
        try
        {
            RefreshCore();
        }
        catch (Exception ex)
        {
            AgentCount = SkillCount = RuleCount = 0;
            Log("刷新内容失败: " + ex.Message, true);
        }
    }

    private void RefreshCore()
    {
        Agents.Clear();
        Skills.Clear();
        Rules.Clear();

        var root = (_groupPath ?? "").Trim();
        if (root.Length == 0 || !Directory.Exists(root))
        {
            Log("请先选择左侧项目组", true);
            AgentCount = SkillCount = RuleCount = 0;
            return;
        }

        var agents = AgentSkillService.Enumerate(root, "agent");
        foreach (var node in BuildTree(agents, "agent")) Agents.Add(node);

        var skillItems = AgentSkillService.Enumerate(root, "skill");
        // skill 名称按 "_" 拆分层级（与 agent 的路径层级一致），目录型本身即叶子。
        var skillNodes = skillItems.Select(s => new AgentSkillItem(s.Kind, s.RelPath.Replace('_', '\\'), s.SourcePath));
        foreach (var node in BuildTree(skillNodes, "skill")) Skills.Add(node);

        var ruleItems = AgentSkillService.Enumerate(root, "rule");
        foreach (var node in BuildTree(ruleItems, "rule")) Rules.Add(node);

        // 树后处理：agent/rule 文件夹回填物理路径；叶子判定目录型条目；rules+rule 并存时顶层分支禁用重命名
        PrepareTree(Agents);
        PrepareTree(Skills);
        PrepareTree(Rules);
        if (AgentSkillService.RuleDirs(root).Count > 1)
            foreach (var top in Rules)
                top.CanRename = false;

        AgentCount = agents.Count;
        SkillCount = skillItems.Count;
        RuleCount = ruleItems.Count;
        Log($"已加载 {Path.GetFileName(root.TrimEnd('\\'))}: agent {agents.Count} 个, skill {skillItems.Count} 个, rule {ruleItems.Count} 个");
    }

    /// <summary>把扁平的相对路径条目组装成目录层级树（文件夹为中间节点，文件为叶子）。</summary>
    private static IList<AgentSkillNode> BuildTree(IEnumerable<AgentSkillItem> items, string kind)
    {
        var roots = new List<AgentSkillNode>();
        var folderMap = new Dictionary<string, AgentSkillNode>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in items)
        {
            var segs = item.RelPath.Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
            AgentSkillNode? parent = null;
            var cur = "";
            for (int i = 0; i < segs.Length - 1; i++)
            {
                cur = cur.Length == 0 ? segs[i] : cur + "\\" + segs[i];
                if (!folderMap.TryGetValue(cur, out var folder))
                {
                    folder = new AgentSkillNode(kind, cur, "", isFolder: false) { Depth = i + 1 };
                    folderMap[cur] = folder;
                    (parent?.Children ?? (IList<AgentSkillNode>)roots).Add(folder);
                }
                parent = folder;
            }
            var leaf = new AgentSkillNode(kind, item.RelPath, item.SourcePath, isFolder: false) { Depth = segs.Length - 1 };
            (parent?.Children ?? (IList<AgentSkillNode>)roots).Add(leaf);
        }
        // 是否为「文件夹」由是否有子节点决定（而非物理目录）；skill 目录型因此显示为叶子。
        SetFolderFlags(roots);
        SortTree(roots);
        return roots;
    }

    /// <summary>递归设置 IsFolder = 是否有子节点。</summary>
    private static void SetFolderFlags(IList<AgentSkillNode> nodes)
    {
        foreach (var n in nodes)
        {
            SetFolderFlags(n.Children);
            n.IsFolder = n.Children.Count > 0;
        }
    }

    /// <summary>递归排序：目录在前、文件在后，再按名称（不区分大小写）。</summary>
    private static void SortTree(IList<AgentSkillNode> nodes)
    {
        foreach (var n in nodes) SortTree(n.Children);
        var ordered = nodes
            .OrderBy(n => n.IsFolder ? 0 : 1)
            .ThenBy(n => n.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToList();
        nodes.Clear();
        foreach (var n in ordered) nodes.Add(n);
    }

    // ---------------- 右键菜单支持（树后处理 / 物理路径推导） ----------------

    /// <summary>
    /// 树后处理：
    ///   ① agent/rule 的文件夹节点回填真实物理路径——叶子 RelPath 与绝对路径尾部严格对应，由后代首个叶子截断推导；
    ///   ② 叶子判定 IsDirEntry（SourcePath 指向物理目录，如 skill 目录型）。
    /// </summary>
    private static void PrepareTree(System.Collections.IEnumerable nodes)
    {
        foreach (var obj in nodes)
        {
            if (obj is not AgentSkillNode n) continue;
            if (n.IsFolder)
            {
                if (!string.Equals(n.Kind, "skill", StringComparison.OrdinalIgnoreCase))
                {
                    var leaf = FindFirstLeaf(n);
                    if (leaf != null)
                    {
                        var p = leaf.SourcePath;
                        var rel = leaf.RelPath;
                        if (p.Length > rel.Length && p.EndsWith("\\" + rel, StringComparison.OrdinalIgnoreCase))
                            n.SourcePath = p[..(p.Length - rel.Length - 1)] + "\\" + n.RelPath;
                    }
                }
            }
            else if (!string.IsNullOrEmpty(n.SourcePath))
            {
                n.IsDirEntry = Directory.Exists(n.SourcePath);
            }
            PrepareTree(n.Children);
        }
    }

    /// <summary>深度优先找节点下第一个叶子。</summary>
    private static AgentSkillNode? FindFirstLeaf(AgentSkillNode n)
    {
        if (n.Children.Count == 0) return n.IsFolder ? null : n;
        foreach (var c in n.Children)
        {
            var leaf = FindFirstLeaf(c);
            if (leaf != null) return leaf;
        }
        return null;
    }

    /// <summary>递归收集子树全部叶子。</summary>
    private static List<AgentSkillNode> CollectLeaves(AgentSkillNode n)
    {
        var list = new List<AgentSkillNode>();
        if (n.Children.Count == 0) { if (!n.IsFolder) list.Add(n); return list; }
        foreach (var c in n.Children) list.AddRange(CollectLeaves(c));
        return list;
    }

    /// <summary>节点的物理定位目标：叶子/物理目录用 SourcePath；skill 虚拟层取首个后代叶子的父目录；无则 null。</summary>
    private static string? ResolvePhysical(AgentSkillNode n)
    {
        if (!string.IsNullOrEmpty(n.SourcePath)) return n.SourcePath;
        if (!n.IsFolder) return null;
        var leaf = FindFirstLeaf(n);
        var p = leaf?.SourcePath;
        return string.IsNullOrEmpty(p) ? null : Path.GetDirectoryName(p);
    }

    /// <summary>按 Kind+RelPath 在三棵树中递归查找节点（重命名刷新后重新选中）。</summary>
    private AgentSkillNode? FindNode(string kind, string relPath)
    {
        foreach (var root in Agents.Concat(Skills).Concat(Rules))
        {
            var hit = FindNode(root, kind, relPath);
            if (hit != null) return hit;
        }
        return null;
    }

    private static AgentSkillNode? FindNode(AgentSkillNode n, string kind, string relPath)
    {
        if (string.Equals(n.Kind, kind, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(n.RelPath, relPath, StringComparison.OrdinalIgnoreCase)) return n;
        foreach (var c in n.Children)
        {
            var hit = FindNode(c, kind, relPath);
            if (hit != null) return hit;
        }
        return null;
    }
}