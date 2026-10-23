using System.Diagnostics;
using System.IO;
using FenPeiXiangMuZu.Models;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// Junction（目录联接）操作。用系统 mklink /J，与旧 PS 版 New-Item -ItemType Junction
/// 语义一致：无需管理员权限、不要求开发者模式（区别于符号链接）。
/// </summary>
public static class JunctionService
{
    /// <summary>判断指定路径是否是一个 junction（重解析点）。</summary>
    public static bool IsJunction(string path)
    {
        try
        {
            var info = new DirectoryInfo(path);
            return info.Exists && (info.Attributes & FileAttributes.ReparsePoint) != 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>解析 junction 的目标路径（仅限重解析点；非链接或解析失败返回 null）。</summary>
    public static string? ResolveTarget(string linkPath)
    {
        try
        {
            var info = new DirectoryInfo(linkPath);
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) == 0) return null;
            return info.ResolveLinkTarget(returnFinalTarget: false)?.FullName;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>mklink 子进程超时（毫秒）：正常瞬间返回，超时视为卡死并杀掉。</summary>
    private const int MkLinkTimeoutMs = 15000;

    /// <summary>
    /// 在 linkPath 创建指向 target 的 junction。写点经解锁窗口包裹：project 受 ACL 只读/防删除
    /// 档保护时，建链（含替换旧链接的删除动作）须临时摘锁执行（E009b）。
    /// </summary>
    /// <exception cref="InvalidOperationException">创建失败时抛出，含目标不存在或 mklink 报错。</exception>
    public static void Create(string linkPath, string target)
        => FolderLockService.WithUnlockForPath(linkPath, () => CreateCore(linkPath, target));

    private static void CreateCore(string linkPath, string target)
    {
        if (!Directory.Exists(target))
            throw new InvalidOperationException($"目标文件夹不存在: {target}");

        if (Directory.Exists(linkPath))
        {
            // 已存在目录：若是 junction 则先删，若是普通目录则拒绝（避免误删内容）
            if (IsJunction(linkPath))
                Directory.Delete(linkPath, false);
            else
                throw new InvalidOperationException($"{linkPath} 已存在且不是链接（普通目录），为避免误删内容，请手动处理。");
        }

        // target 去尾斜杠：`mklink /J "link" "E:\lib\"` 中尾反斜杠会转义收尾引号导致解析失败
        var psi = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = $"/c mklink /J \"{linkPath}\" \"{target.TrimEnd('\\')}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        var p = Process.Start(psi);
        if (p == null)
            throw new InvalidOperationException("创建 junction 失败: 无法启动 mklink 子进程。");
        using (p)
        {
            // 先启动异步读任务再等退出：避免输出填满管道缓冲区造成经典死锁
            var outTask = p.StandardOutput.ReadToEndAsync();
            var errTask = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(MkLinkTimeoutMs))
            {
                try { p.Kill(); } catch { }
                throw new InvalidOperationException($"创建 junction 失败: mklink 超时（{MkLinkTimeoutMs}ms 无响应）。");
            }
            var msg = p.ExitCode == 0 ? "" : (errTask.Result + outTask.Result).Trim();
            if (p.ExitCode != 0)
                throw new InvalidOperationException($"创建 junction 失败: {msg}");
        }
    }

    /// <summary>链接状态三态，对应 PS Get-LinkState 的 有效/冲突/失效。</summary>
    public enum LinkState { Valid, Conflict, Broken }

    /// <summary>默认链接名（旧数据兼容：早期只建 .opencode）。</summary>
    public const string OpenCodeLinkName = LinkRecord.DefaultLinkName;

    /// <summary>某项目下指定链接名（junction）的完整路径。</summary>
    public static string LinkPath(string project, string name)
        => Path.Combine(project.TrimEnd('\\'), name);

    /// <summary>判定某项目下指定链接名的状态（Valid=junction；Conflict=普通目录/文件占位；Broken=不存在）。</summary>
    public static LinkState GetLinkState(string project, string name)
    {
        var lp = LinkPath(project, name);
        if (!Directory.Exists(lp) && !File.Exists(lp)) return LinkState.Broken;
        return IsJunction(lp) ? LinkState.Valid : LinkState.Conflict;
    }

    /// <summary>删除某项目下指定链接名的 junction（仅限 junction；非链接则拒绝，避免误删内容）。
    /// 写点经解锁窗口包裹：受防删除/只读档保护时删除动作须临时摘锁执行（E009b）。</summary>
    /// <exception cref="InvalidOperationException">目标是非链接的普通目录/文件时抛出。</exception>
    public static void RemoveLink(string project, string name)
        => FolderLockService.WithUnlockForPath(LinkPath(project, name), () => RemoveLinkCore(project, name));

    private static void RemoveLinkCore(string project, string name)
    {
        var lp = LinkPath(project, name);
        if (!Directory.Exists(lp) && !File.Exists(lp)) return; // 本就无链接，视为已清理
        if (IsJunction(lp))
        {
            Directory.Delete(lp, false);
            return;
        }
        throw new InvalidOperationException($"{lp} 存在但不是链接（普通目录/文件），为避免误删内容，请手动处理。");
    }
}