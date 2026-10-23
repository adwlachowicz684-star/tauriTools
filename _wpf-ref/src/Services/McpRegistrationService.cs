using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// MCP 自动注册：把「分配项目组」注册到各 MCP 客户端配置，路径一律动态推导（不写死）。
/// 1) FPX_ROOT 用户环境变量 = 项目根（供 {env:FPX_ROOT} 占位符 / 脚本使用）
/// 2) 项目根 .mcp.json（opencode 等）：command 用 {env:FPX_ROOT} 占位符
/// 3) TRAE 全局 mcp.json（不支持环境变量插值）：写入实际 exe 路径（自愈；仅当条目已存在时更新）
/// </summary>
public static class McpRegistrationService
{
    private const string ServerName = "分配项目组";

    /// <summary>执行注册，返回人类可读的变更摘要（无变更时返回空串）。</summary>
    public static string RegisterAll(string cfgPath)
    {
        var sb = new StringBuilder();
        try
        {
            var root = ResolveRoot(cfgPath);
            var exePath = Path.Combine(AppContext.BaseDirectory, "分配项目组.exe");

            // 1) FPX_ROOT 用户环境变量（幂等：值一致则不动）
            var current = Environment.GetEnvironmentVariable("FPX_ROOT", EnvironmentVariableTarget.User);
            if (!string.Equals(current, root, StringComparison.OrdinalIgnoreCase))
            {
                Environment.SetEnvironmentVariable("FPX_ROOT", root, EnvironmentVariableTarget.User);
                sb.AppendLine($"FPX_ROOT 已设为：{root}");
            }

            // 2) 项目根 .mcp.json（opencode 等客户端）：command 用 {env:FPX_ROOT} 占位符
            var relExe = Path.GetRelativePath(root, exePath);
            var command = relExe.StartsWith("..")
                ? exePath   // exe 不在 root 下（异常布局），退回实际路径
                : "{env:FPX_ROOT}\\" + relExe.Replace('/', '\\');
            EnsureProjectMcpJson(Path.Combine(root, ".mcp.json"), command, sb);

            // 3) TRAE 全局 mcp.json：不支持环境变量插值，写入实际 exe 路径（自愈）
            UpdateTraeGlobalMcpJson(exePath, sb);

            if (sb.Length == 0) sb.AppendLine("MCP 注册已是最新状态。");
        }
        catch (Exception ex)
        {
            sb.AppendLine("MCP 自动注册失败：" + ex.Message);
        }
        return sb.ToString().TrimEnd();
    }

    /// <summary>项目根 = 数据目录的父目录（cfgPath 为 &lt;root&gt;\数据\分配项目组-config.json）。</summary>
    private static string ResolveRoot(string cfgPath)
    {
        var dataDir = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(cfgPath));
        return Path.GetDirectoryName(dataDir) ?? AppContext.BaseDirectory;
    }

    /// <summary>确保项目根 .mcp.json 含「分配项目组」条目（command=占位符 / args=--mcp），保留其他条目。</summary>
    private static void EnsureProjectMcpJson(string path, string command, StringBuilder sb)
    {
        JsonObject? root = null;
        if (File.Exists(path))
        {
            try { root = JsonNode.Parse(File.ReadAllText(path)) as JsonObject; }
            catch { root = null; }
        }
        root ??= new JsonObject();
        var servers = root["mcpServers"] as JsonObject ?? new JsonObject();
        root["mcpServers"] = servers;
        var entry = servers[ServerName] as JsonObject ?? new JsonObject();
        servers[ServerName] = entry;

        var changed = false;
        if (entry["command"]?.GetValue<string>() != command)
        {
            entry["command"] = command;
            changed = true;
        }
        if (entry["args"] is not JsonArray args || args.Count == 0 || args[0]?.GetValue<string>() != "--mcp")
        {
            entry["args"] = new JsonArray("--mcp");
            changed = true;
        }
        if (changed)
        {
            WriteJsonAtomic(path, root);
            sb.AppendLine($"已更新项目 MCP 配置：{path}");
        }
    }

    /// <summary>更新 TRAE 全局 mcp.json 中已存在的「分配项目组」条目（不主动创建，避免越权改动用户全局配置）。</summary>
    private static void UpdateTraeGlobalMcpJson(string exePath, StringBuilder sb)
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var candidates = new[]
        {
            Path.Combine(appData, "TRAE SOLO CN", "User", "mcp.json"),
            Path.Combine(appData, "Trae CN", "User", "mcp.json"),
        };
        foreach (var path in candidates)
        {
            if (!File.Exists(path)) continue;
            JsonObject? root;
            try { root = JsonNode.Parse(File.ReadAllText(path)) as JsonObject; }
            catch { continue; }
            if (root?["mcpServers"] is not JsonObject servers) continue;
            if (servers[ServerName] is not JsonObject entry) continue;

            var changed = false;
            if (entry["command"]?.GetValue<string>() != exePath)
            {
                entry["command"] = exePath;
                changed = true;
            }
            if (entry["args"] is not JsonArray args || args.Count == 0 || args[0]?.GetValue<string>() != "--mcp")
            {
                entry["args"] = new JsonArray("--mcp");
                changed = true;
            }
            if (changed)
            {
                WriteJsonAtomic(path, root);
                sb.AppendLine($"已更新 TRAE 全局 MCP 配置：{path}");
            }
        }
    }

    /// <summary>原子写 JSON：先写 .tmp 再 Move 覆盖，进程中断不残留半截文件。</summary>
    private static void WriteJsonAtomic(string path, JsonObject root)
    {
        var json = root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, json, new UTF8Encoding(false));
        File.Move(tmp, path, overwrite: true);
    }
}
