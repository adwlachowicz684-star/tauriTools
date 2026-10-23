using System.IO;
using System.Windows.Input;
using System.Windows.Threading;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>
/// MainViewModel 的一键备份 partial：侧边栏「一键备份」命令、设置面板备份目录/只增模式/自动备份绑定、
/// 自动备份定时器。执行走 Services.BackupService（GUI 与 MCP 同源），后台线程运行不冻结界面。
/// </summary>
public sealed partial class MainViewModel
{
    // ---------------- 命令（侧边栏「一键备份」按钮） ----------------

    private ICommand? _backupNowCommand;
    public ICommand BackupNowCommand => _backupNowCommand ??= new RelayCommand(_ => RunBackupFromUiAsync());

    private bool _backupBusy;

    /// <summary>UI 入口：取配置快照 → 后台执行两份备份 → 日志汇报。防重入（含自动定时触发共用）。</summary>
    public async void RunBackupFromUiAsync()
    {
        if (_backupBusy) return;
        _backupBusy = true;
        try
        {
            var snap = BuildBackupSnapshot();
            if (snap.ProjectPaths.Count == 0 && snap.GroupPaths.Count == 0)
            {
                Log("一键备份：没有可备份的项目/项目组。");
                return;
            }
            Log($"开始备份：项目 {snap.ProjectPaths.Count} 个 → {snap.ProjectTarget}；项目组 {snap.GroupPaths.Count} 个 → {snap.GroupTarget}");
            var (proj, grp) = await Task.Run(() => ExecuteBackup(snap));
            Log($"备份完成 · 项目：{proj.Summary}", proj.HasError);
            foreach (var e in proj.Errors.Take(ShowErrorLimit)) Log("  " + e, true);
            Log($"备份完成 · 项目组：{grp.Summary}", grp.HasError);
            foreach (var e in grp.Errors.Take(ShowErrorLimit)) Log("  " + e, true);
        }
        catch (Exception ex)
        {
            Log("一键备份失败: " + ex.Message, true);
        }
        finally { _backupBusy = false; }
    }

    /// <summary>单次汇报最多逐条展开的错误行数（防止大量失败刷爆日志区）。</summary>
    private const int ShowErrorLimit = 20;

    /// <summary>备份参数不可变快照（UI 线程一次性取齐，后台不再触碰 config/UI 对象）。</summary>
    internal sealed record BackupSnapshot(string ProjectTarget, string GroupTarget, bool AppendOnly,
        List<string> ProjectPaths, List<string> GroupPaths);

    private BackupSnapshot BuildBackupSnapshot() => new(
        BackupService.ResolveDir(_config.BackupProjectDir, BackupService.DefaultProjectDir),
        BackupService.ResolveDir(_config.BackupGroupDir, BackupService.DefaultGroupDir),
        _config.BackupAppendOnly,
        BackupService.CollectProjectPaths(_config),
        BackupService.CollectGroupPaths(_config));

    /// <summary>同步执行两份备份（供 Task.Run 调用；MCP 工具也复用此纯函数路径）。</summary>
    internal static (BackupResult Project, BackupResult Group) ExecuteBackup(BackupSnapshot s)
    {
        var proj = new BackupResult();
        BackupService.BackupAll(s.ProjectPaths, s.ProjectTarget, s.AppendOnly, proj);
        var grp = new BackupResult();
        BackupService.BackupAll(s.GroupPaths, s.GroupTarget, s.AppendOnly, grp);
        return (proj, grp);
    }

    // ---------------- 设置面板绑定（改动即时保存，风格对齐 AutoSelect/IconsAffectExplorer） ----------------

    /// <summary>数据目录（config/link-record/预设图标库所在文件夹）；只读展示用。</summary>
    public string DataDir => _dataDir;

    /// <summary>解析后的项目备份目标目录（空配置回退默认）。</summary>
    public string ResolvedBackupProjectDir =>
        BackupService.ResolveDir(_config.BackupProjectDir, BackupService.DefaultProjectDir);

    /// <summary>解析后的项目组备份目标目录（空配置回退默认）。</summary>
    public string ResolvedBackupGroupDir =>
        BackupService.ResolveDir(_config.BackupGroupDir, BackupService.DefaultGroupDir);

    /// <summary>项目备份目标目录；空串 = exe 所在目录\backkup_项目备份。</summary>
    public string BackupProjectDirText
    {
        get => _config.BackupProjectDir ?? "";
        set
        {
            var v = (value ?? "").Trim();
            if (_config.BackupProjectDir == v) return;
            _config.BackupProjectDir = v;
            Raise(nameof(BackupProjectDirText));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>项目组备份目标目录；空串 = exe 所在目录\backkup_项目组备份。</summary>
    public string BackupGroupDirText
    {
        get => _config.BackupGroupDir ?? "";
        set
        {
            var v = (value ?? "").Trim();
            if (_config.BackupGroupDir == v) return;
            _config.BackupGroupDir = v;
            Raise(nameof(BackupGroupDirText));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>只增模式：true=仅新增与更新（源中删除的文件在备份中保留）；false=镜像同步。</summary>
    public bool BackupAppendOnly
    {
        get => _config.BackupAppendOnly;
        set
        {
            if (_config.BackupAppendOnly == value) return;
            _config.BackupAppendOnly = value;
            Raise(nameof(BackupAppendOnly));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>自动备份间隔分钟数（0=关闭）；下拉选项见设置面板。变更即时保存并重启定时器。</summary>
    public int BackupAutoMinutes
    {
        get => _config.BackupAutoMinutes;
        set
        {
            var v = value < 0 ? 0 : value;
            if (_config.BackupAutoMinutes == v) return;
            _config.BackupAutoMinutes = v;
            Raise(nameof(BackupAutoMinutes));
            _configSvc.SaveConfig(_config);
            RestartAutoBackupTimer();
        }
    }

    // ---------------- 自动备份定时器（仅 GUI 模式；MCP 短会话不做自动触发） ----------------

    private DispatcherTimer? _autoBackupTimer;

    /// <summary>按当前 BackupAutoMinutes 重置自动备份定时器（0 或负值 = 停止）。</summary>
    public void RestartAutoBackupTimer()
    {
        StopAutoBackupTimer();
        if (_config.BackupAutoMinutes <= 0) return;
        _autoBackupTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(_config.BackupAutoMinutes) };
        _autoBackupTimer.Tick += (_, _) => RunBackupFromUiAsync();
        _autoBackupTimer.Start();
    }

    private void StopAutoBackupTimer()
    {
        if (_autoBackupTimer is null) return;
        _autoBackupTimer.Stop();
        _autoBackupTimer = null;
    }
}
