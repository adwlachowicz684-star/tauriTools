using System;
using System.IO;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>
/// MainViewModel 的脑图设置 partial：设置面板「脑图」页签的备份间隔/份数/目录绑定（改动即时保存），
/// 以及「修改」按钮的备份目录迁移。MindMapPanel 通过监听本类属性变更重启其每分钟备份定时器。
/// </summary>
public sealed partial class MainViewModel
{
    /// <summary>脑图自动备份间隔（分钟）；0=关闭。变更即时保存并通知 MindMapPanel 重启定时器。</summary>
    public int MindMapBackupMinutes
    {
        get => _config.MindMapBackupMinutes;
        set
        {
            var v = value < 0 ? 0 : value;
            if (_config.MindMapBackupMinutes == v) return;
            _config.MindMapBackupMinutes = v;
            Raise(nameof(MindMapBackupMinutes));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>同一份脑图最多保留的备份份数（1..99）。变更即时保存并通知 MindMapPanel。</summary>
    public int MindMapBackupMax
    {
        get => _config.MindMapBackupMax;
        set
        {
            var v = Math.Clamp(value, 1, 99);
            if (_config.MindMapBackupMax == v) return;
            _config.MindMapBackupMax = v;
            Raise(nameof(MindMapBackupMax));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>脑图备份目录（完整路径）；空 = 使用默认 数据目录\mindmap-backups。改动即时保存。</summary>
    public string MindMapBackupDirText
    {
        get => _config.MindMapBackupDir ?? "";
        set
        {
            var v = (value ?? "").Trim();
            if (_config.MindMapBackupDir == v) return;
            _config.MindMapBackupDir = v;
            Raise(nameof(MindMapBackupDirText));
            Raise(nameof(ResolvedMindMapBackupDir));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>解析后的脑图备份目录（自定义配置或默认 数据目录\mindmap-backups）。</summary>
    public string ResolvedMindMapBackupDir =>
        string.IsNullOrWhiteSpace(_config.MindMapBackupDir)
            ? MindMapBackupStore.DefaultDir
            : _config.MindMapBackupDir.Trim();

    /// <summary>脑图布局过渡动画开关（设置面板「脑图」勾选）：true=保留打开画布/展开收起分支时的扩散动画；false=直接显示。改动即落盘，下次打开脑图生效。</summary>
    public bool MindMapLayoutAnimation
    {
        get => _config.MindMapLayoutAnimation;
        set
        {
            if (_config.MindMapLayoutAnimation == value) return;
            _config.MindMapLayoutAnimation = value;
            Raise(nameof(MindMapLayoutAnimation));
            _configSvc.SaveConfig(_config);
        }
    }

    /// <summary>「修改」备份目录：把现有备份文件整体迁移到新路径后更新配置。失败则不改配置并记日志。</summary>
    public void MoveMindMapBackupDir(string newDir)
    {
        if (string.IsNullOrWhiteSpace(newDir)) return;
        newDir = Path.GetFullPath(newDir.Trim());
        var oldDir = ResolvedMindMapBackupDir;
        if (string.Equals(oldDir, newDir, StringComparison.OrdinalIgnoreCase))
        {
            Log("脑图备份目录未变化：" + newDir);
            return;
        }
        try
        {
            MindMapBackupStore.MoveBackups(oldDir, newDir);
            _config.MindMapBackupDir = newDir;
            _configSvc.SaveConfig(_config);
            Raise(nameof(MindMapBackupDirText));
            Raise(nameof(ResolvedMindMapBackupDir));
            Log($"脑图备份目录已修改并迁移：{oldDir} → {newDir}");
        }
        catch (Exception ex)
        {
            Log("脑图备份目录迁移失败：" + ex.Message, true);
        }
    }
}
