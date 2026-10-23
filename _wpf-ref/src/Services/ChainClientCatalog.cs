using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.Win32;

namespace FenPeiXiangMuZu.Services;

/// <summary>可接收连锁指令的桌面 AI 客户端定义。</summary>
public sealed record ChainClientDef(
    string Id,
    string DisplayName,
    string? Scheme)
{
    public static ChainClientDef OpenCode = new("opencode", "opencode", "opencode");

    // 兜底展示：自定义 ComboBox 模板下模板未生成时按 ToString 呈现，避免默认记录格式漏出
    public override string ToString() => DisplayName;
}

/// <summary>一次连锁发送的结果：Ok=已发起；NeedsPaste=指令已复制待手工粘贴。</summary>
public sealed record ChainSendResult(bool Ok, string ClientName, bool NeedsPaste, string Message);

/// <summary>发送客户端下拉选项：Value=null 表示「跟随全局默认」。用于设置页动作级下拉。</summary>
public sealed record ChainClientChoice(string? Value, string Label)
{
    // 与 ChainClientDef 同因：兜底展示为避免默认记录格式漏出
    public override string ToString() => Label ?? "默认（跟随全局）";
}

/// <summary>
/// 可接收连锁指令的桌面 AI 客户端目录 + 检测 + 发送分派。
/// 检测：扫描注册表 URL scheme（HKCU/HKLM Software\Classes\&lt;scheme&gt;）。
/// 发送：opencode/Cursor 走深链接自动预填；VSCode 走 Code.exe/code 命令预填；
/// Trae/Trae-CN 无可靠外部预填路径，统一降级为「复制指令 + 打开客户端 + 提示粘贴」。
/// </summary>
public static class ChainClientCatalog
{
    public static readonly IReadOnlyList<ChainClientDef> All = new ChainClientDef[]
    {
        new("opencode", "opencode", "opencode"),
        new("trae", "Trae", "trae"),
        new("trae-cn", "Trae-CN", "trae-cn"),
        new("cursor", "Cursor", "cursor"),
        new("vscode", "Visual Studio Code", "vscode"),
        new("chatgpt", "ChatGPT", "codex"),        // 现代 ChatGPT 桌面版(内核 Codex)注册 codex: scheme
        new("workbuddy", "WorkBuddy", "workbuddy"),
        new("claude", "Claude", "claude"),          // Anthropic Claude 桌面端 claude:// 深链
        new("windsurf", "Windsurf", "windsurf"),    // Windsurf(现名 Devin Desktop)，协议仍为 windsurf://
        new("kimi", "Kimi", "kimi"),                // 月之暗面 Kimi 桌面端 kimi:// 深链
    };

    public static ChainClientDef? ById(string id) =>
        All.FirstOrDefault(c => string.Equals(c.Id, id, StringComparison.Ordinal));

    /// <summary>按自定义客户端（用户手动添加）发送：复制指令 + 打开客户端(exe 优先，其次 scheme) + 提示粘贴。</summary>
    public static ChainSendResult SendCustom(string name, string? exe, string? scheme,
        string directory, string prompt)
    {
        Dialog.Service.SetClipboard(prompt);
        var opened = false;
        try
        {
            var cli = !string.IsNullOrWhiteSpace(exe) ? exe : FindCommand(name);
            if (!string.IsNullOrWhiteSpace(cli))
            {
                Run(cli, directory);
                opened = true;
            }
            else if (!string.IsNullOrWhiteSpace(scheme))
            {
                Process.Start(new ProcessStartInfo(scheme + "://") { UseShellExecute = true });
                opened = true;
            }
        }
        catch { opened = false; }
        var tip = opened
            ? $"已在 {name} 中打开。指令已复制到剪贴板，请粘贴到其对话框。"
            : $"指令已复制到剪贴板，请粘贴到 {name} 的对话框（未能自动打开）。";
        return new ChainSendResult(true, name, true, tip);
    }

    /// <summary>当前已安装（scheme 已注册）的客户端列表；未注册 scheme 的 vscode 另查 Code.exe。</summary>
    public static List<ChainClientDef> DetectInstalled()
    {
        var list = All.Where(IsInstalled).ToList();
        if (list.Count == 0) list.Add(ChainClientDef.OpenCode); // 兜底：至少可回退 opencode
        return list;
    }

    public static void Rescan() { } // 占位：检测结果由调用方按需读取；无缓存

    private static bool IsInstalled(ChainClientDef c)
    {
        if (HasScheme(c.Scheme)) return true;
        if (c.Id == "vscode" && FindCodeExe() != null) return true;
        return false;
    }

    private static bool HasScheme(string? scheme)
    {
        if (string.IsNullOrEmpty(scheme)) return false;
        // Registry.ClassesRoot 在 .NET 只对应 HKLM\Software\Classes；
        // 每用户桌面应用与 MSIX 商店应用（如 ChatGPT/Codex）的协议注册在 HKCU\Software\Classes，
        // 两者须都查，否则漏检。
        return KeyExists(Registry.ClassesRoot, scheme)
            || KeyExists(Registry.CurrentUser, @"Software\Classes\" + scheme);
    }

    private static bool KeyExists(RegistryKey root, string subkey)
    {
        try { using var key = root.OpenSubKey(subkey); return key != null; }
        catch { /* 权限/异常视为未注册 */ }
        return false;
    }

    // ---------------- 发送分派 ----------------

    /// <summary>按客户端 id 发送连锁指令。directory 为对象完整路径，prompt 为已替换占位符的指令。</summary>
    public static ChainSendResult Send(string id, string directory, string prompt)
    {
        var def = ById(id) ?? ChainClientDef.OpenCode;
        switch (def.Id)
        {
            case "opencode":
                return OpenDeepLink(def, $"opencode://new-session?directory={Uri.EscapeDataString(directory)}&prompt={Uri.EscapeDataString(prompt)}",
                    directory, prompt, autoPaste: false);
            case "cursor":
                return OpenDeepLink(def, $"cursor://anysphere.cursor-deeplink/prompt?text={Uri.EscapeDataString(prompt)}",
                    directory, prompt, autoPaste: false);
            case "vscode":
                return SendVSCode(def, directory, prompt);
            default: // trae / trae-cn
                return SendViaClipboard(def, directory, prompt);
        }
    }

    private static ChainSendResult OpenDeepLink(ChainClientDef def, string url, string directory, string prompt, bool autoPaste)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            return new ChainSendResult(true, def.DisplayName, false, $"已发送到 {def.DisplayName}");
        }
        catch
        {
            if (autoPaste) return PasteAndOpen(def, directory, prompt);
            return new ChainSendResult(true, def.DisplayName, true, $"{def.DisplayName} 无法自动打开，指令已复制。");
        }
    }

    private static ChainSendResult SendVSCode(ChainClientDef def, string directory, string prompt)
    {
        var code = FindCodeExe();
        if (code == null) return PasteAndOpen(def, directory, prompt);

        try
        {
            Run(code, directory);            // 打开目标目录
            Run(code, "chat", prompt);        // 预填 AI 对话框
            return new ChainSendResult(true, def.DisplayName, false, $"已发送到 {def.DisplayName}");
        }
        catch
        {
            return PasteAndOpen(def, directory, prompt);
        }
    }

    /// <summary>Trae 降级：复制指令到剪贴板 + 打开客户端/项目目录 + 提示粘贴。</summary>
    private static ChainSendResult SendViaClipboard(ChainClientDef def, string directory, string prompt)
        => PasteAndOpen(def, directory, prompt);

    private static ChainSendResult PasteAndOpen(ChainClientDef def, string directory, string prompt)
    {
        Dialog.Service.SetClipboard(prompt);

        // 尽力打开客户端（有 CLI 用 CLI 打开目录；否则用 scheme 唤起）。
        var opened = false;
        try
        {
            var cli = FindCommand(def.Id); // trae / trae-cn
            if (cli != null)
            {
                Run(cli, directory);
                opened = true;
            }
            else if (def.Scheme != null)
            {
                Process.Start(new ProcessStartInfo(def.Scheme + "://") { UseShellExecute = true });
                opened = true;
            }
        }
        catch { opened = false; }

        var tip = opened
            ? $"已在 {def.DisplayName} 中打开目录。指令已复制到剪贴板，请粘贴到其对话框。"
            : $"指令已复制到剪贴板，请粘贴到 {def.DisplayName} 的对话框（未能自动打开）。";
        return new ChainSendResult(true, def.DisplayName, true, tip);
    }

    // ---------------- 命令定位与执行 ----------------

    private static void Run(string exe, params string[] args)
    {
        var psi = new ProcessStartInfo(exe) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        Process.Start(psi);
    }

    private static string? FindCodeExe()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "Microsoft VS Code", "Code.exe"),
#if NET
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Microsoft VS Code", "Code.exe"),
#endif
        };
        foreach (var p in candidates) if (File.Exists(p)) return p;
        return FindCommand("code.cmd") ?? FindCommand("code");
    }

    private static string? FindCommand(string name)
    {
        var psext = Environment.GetEnvironmentVariable("PATHEXT")?.Split(';');
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(';'))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            var dirPath = dir.Trim().Trim('"');
            if (!Directory.Exists(dirPath)) continue;
            var direct = Path.Combine(dirPath, name);
            if (File.Exists(direct)) return direct;
            if (psext != null)
                foreach (var ext in psext)
                {
                    if (string.IsNullOrWhiteSpace(ext)) continue;
                    var f = direct + ext;
                    if (File.Exists(f)) return f;
                }
        }
        return null;
    }
}