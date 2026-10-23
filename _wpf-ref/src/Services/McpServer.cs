using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using FenPeiXiangMuZu.Models;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 内嵌 MCP server（stdio JSON-RPC）。让 AI 客户端通过标准 MCP 工具调用本工具的能力：
/// 读取项目组/项目、选择文件夹并读 agent/skill 列表、创建/删除 agent 链接、部署 skill。
/// 直接复用 GUI 同一套数据服务（ConfigService / LinkRecordService / JunctionService / AgentSkillService），
/// 因此与界面共享同一份迁移版 数据/，读写完全一致。
/// 启动方式：<exe> --mcp （此时不开窗口，仅服务 stdin/stdout）。
/// 注意：stdout 只允许输出 JSON-RPC 响应，否则会污染协议流。
/// </summary>
public sealed class McpServer
{
    /// <summary>GUI 退出时通知 MCP 进程退出的命名事件（GUI 与 MCP 进程共享；须与 MainWindow 引用一致）。</summary>
    public const string CloseEventName = @"Local\FenPeiXiangMuZu_CloseMcp";

    // stdio 协议要求每条消息单行（newline-delimited JSON）；WriteIndented 会产出多行缩进，破坏客户端 ReadLine 分帧
    private static readonly JsonSerializerOptions IoJson = new()
    {
        WriteIndented = false,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _configPath;
    private readonly string _recordPath;
    private readonly ConfigService _configSvc;
    private readonly LinkRecordService _recSvc;
    private readonly HashSet<string> _enabledTools;
    private (string Path, string Kind)? _selection;

    public McpServer(string configPath, string recordPath)
    {
        _configPath = configPath;
        _recordPath = recordPath;
        _configSvc = new ConfigService(configPath);
        var cfg = LoadConfig();
        // config 损坏告警走 stderr（stdout 是协议流不可污染），让客户端/终端可见
        if (_configSvc.LastLoadWarning != null)
        {
            try { Console.Error.WriteLine("[fenpei-mcp] " + _configSvc.LastLoadWarning); } catch { }
        }
        var baseRoot = ResolveBaseRoot(cfg);
        _recSvc = new LinkRecordService(baseRoot, recordPath);
        // 总开关：config.mcpEnabled 为 false 时整体停用，不暴露任何工具
        if (!cfg.McpEnabled)
        {
            _enabledTools = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        }
        else
        {
            // 工具开关：config.mcpTools 中显式 false 的工具不暴露；缺失视为开启（默认全开，兼容旧配置）
            _enabledTools = new HashSet<string>(
                McpToolCatalog.All.Select(t => t.Name)
                    .Where(n => cfg.McpTools.TryGetValue(n, out var on) ? on : true),
                StringComparer.OrdinalIgnoreCase);
        }
    }

    /// <summary>工具是否已启用（未在 MCP 设置中关闭）。</summary>
    private bool IsEnabled(string name) => _enabledTools.Contains(name);

    private string ResolveBaseRoot(AppConfig cfg)
        => cfg.LastLib is not null && Directory.Exists(cfg.LastLib) ? cfg.LastLib : AppContext.BaseDirectory;

    /// <summary>运行主循环：逐行读 stdin → 处理 JSON-RPC → 写响应到 stdout，直到 stdin 关闭。
    /// stdout 写失败（客户端断开管道）时优雅退出，不让进程带异常崩溃。</summary>
    public async Task RunAsync(TextReader input, TextWriter output)
    {
        string? line;
        while ((line = await input.ReadLineAsync().ConfigureAwait(false)) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            string? response;
            try { response = HandleLine(line); }
            catch (Exception ex)
            {
                // HandleLine 自身已兜底；此处防御序列化等意外，保证主循环不中断
                System.Diagnostics.Debug.WriteLine(ex);
                continue;
            }
            if (response == null) continue; // notification / 空
            try
            {
                await output.WriteLineAsync(response).ConfigureAwait(false);
                await output.FlushAsync().ConfigureAwait(false);
            }
            catch (Exception)
            {
                break; // stdout 断裂：客户端已关闭，正常退出服务循环
            }
        }
    }

    /// <summary>处理一行 JSON-RPC，返回待写出的响应字符串；通知/异常已吞则返回 null。</summary>
    private string? HandleLine(string line)
    {
        JsonDocument? doc = null;
        try { doc = JsonDocument.Parse(line); }
        catch { return Error(null, -32700, "Parse error"); }

        using (doc)
        {
            var root = doc.RootElement;
            // JSON-RPC id 必须按原始类型回传（数字→数字、字符串→字符串），严格客户端校验类型一致性。
            // 数字用 Clone() 脱离文档作用域，序列化时由 System.Text.Json 原样输出为数字（不带引号）。
            object? id = null;
            var hasId = false;
            if (root.TryGetProperty("id", out var idEl)
                && (idEl.ValueKind == JsonValueKind.Number || idEl.ValueKind == JsonValueKind.String))
            {
                hasId = true;
                id = idEl.ValueKind == JsonValueKind.Number ? (object)idEl.Clone() : (object)idEl.GetString()!;
            }

            var method = root.TryGetProperty("method", out var m) ? m.GetString() : null;
            var isRequest = hasId;

            try
            {
                if (!isRequest)
                {
                    // notification：只处理 initialized/ping，不回包
                    return null;
                }

                switch (method)
                {
                    case "initialize":
                        return Result(id, new
                        {
                            protocolVersion = "2024-11-05",
                            capabilities = new { tools = new { } },
                            serverInfo = new { name = "fenpei-xiangmuzu-mcp", version = "0.1.1" },
                        });
                    case "ping":
                        return Result(id, new { });
                    case "tools/list":
                        return Result(id, new { tools = BuildTools() });
                    case "tools/call":
                        var name = root.TryGetProperty("params", out var prms)
                                   && prms.TryGetProperty("name", out var pn) ? pn.GetString() : null;
                        var args = default(JsonElement);
                        if (root.TryGetProperty("params", out var pr2)
                            && pr2.TryGetProperty("arguments", out var pa)) args = pa;
                        try
                        {
                            var callResult = CallTool(name, args);
                            return Result(id, new
                            {
                                content = new object[] { new { type = "text", text = Json(callResult) } },
                            });
                        }
                        catch (Exception ex)
                        {
                            // MCP 规范：工具级业务错误（参数缺失/路径不存在等）以 isError 结果返回，
                            // 让客户端把错误文本交给模型；-32603 协议错误仅留给真正的内部故障。
                            return Result(id, new
                            {
                                content = new object[] { new { type = "text", text = "Error: " + ex.Message } },
                                isError = true,
                            });
                        }
                    default:
                        return Error(id, -32601, "Method not found: " + method);
                }
            }
            catch (Exception ex)
            {
                return Error(id, -32603, "Internal error: " + ex.Message);
            }
        }
    }

    private object CallTool(string? name, JsonElement args)
    {
        if (string.IsNullOrEmpty(name)) throw new InvalidOperationException("缺少工具名");
        if (!IsEnabled(name)) throw new InvalidOperationException($"工具已在 MCP 设置中禁用: {name}");
        switch (name)
        {
            case "get_manual": return GetManual();
            case "get_status": return GetStatus();
            case "list_groups": return new { groups = ListGroups() };
            case "list_projects": return new { projects = ListProjects() };
            case "select_folder": return SelectFolder(Str(args, "path")!);
            case "get_selection": return GetSelection();
            case "create_project": return CreateProject(args);
            case "create_group": return CreateGroup(args);
            case "list_agents": return ListContent(args, "agents");
            case "list_skills": return ListContent(args, "skills");
            case "refresh_content": return RefreshContent(args);
            case "create_link": return CreateLink(Str(args, "project")!, Str(args, "group")!);
            case "remove_link": return RemoveLink(Str(args, "project")!);
            case "list_links": return ListLinks();
            case "deploy_skill": return DeploySkill(args);
            case "folder_icon_set": return FolderIconSet(args);
            case "folder_icon_set_dll": return FolderIconSetDll(args);
            case "folder_icon_restore": return FolderIconRestore(args);
            case "folder_icon_get": return FolderIconGet(args);
            case "capture_screen": return CaptureScreen(args);
            case "capture_window": return CaptureWindow(args);
            case "list_windows": return ListWindows(args);
            case "pick_screen_color": return PickScreenColor(args);
            case "backup_now": return BackupNow();
            case "lock_status": return LockStatus();
            case "lock_set": return LockSet(args);
            default: throw new InvalidOperationException("未知工具: " + name);
        }
    }

    private AppConfig LoadConfig() => _configSvc.LoadConfig();

    // ---------------- 工具实现 ----------------

    private object GetManual()
    {
        var rows = new StringBuilder();
        foreach (var t in BuildTools())
        {
            var props = t.TryGetProperty("inputSchema", out var s) && s.TryGetProperty("properties", out var p)
                ? string.Join(", ", p.EnumerateObject().Select(x => x.Name)) : "";
            var req = t.TryGetProperty("inputSchema", out var s2) && s2.TryGetProperty("required", out var r)
                ? string.Join(", ", r.EnumerateArray().Select(x => x.GetString())) : "-";
            var desc = (t.TryGetProperty("description", out var d) ? d.GetString() : "")?.Replace("|", "\\|") ?? "";
            rows.Append("| ").Append(t.GetProperty("name").GetString()).Append(" | ").Append(desc)
                .Append(" | ").Append(props.Length == 0 ? "无" : props).Append(" | ").Append(req).Append(" |\n");
        }
        var manual = "本 MCP 服务「分配项目组」工具能力总览（stdin/stdout JSON-RPC）：\n"
            + "| 工具 | 说明 | 参数 | 必填 |\n|---|---|---|---|\n" + rows.ToString();
        return new { configPath = _configPath, recordPath = _recordPath, manual };
    }

    private object GetStatus()
    {
        var cfg = LoadConfig();
        return new
        {
            configPath = _configPath,
            recordPath = _recordPath,
            config = new
            {
                groups = ListGroups().Select(g => g["path"]),
                projects = ListProjects().Select(p => p["path"]),
                aiAgentCmd = cfg.AiAgentCmd,
                lastLib = cfg.LastLib,
            },
            linkCount = _recSvc.Load().Count,
            // 显式展开为 {path,kind}：命名元组直出会被 STJ 序列化成 {Item1,Item2}，与其他工具返回结构不一致
            selection = _selection == null ? null : new { path = _selection.Value.Path, kind = _selection.Value.Kind },
        };
    }

    /// <summary>backup_now：按当前 config 的备份设置立即执行一次全量增量备份，返回两份统计。</summary>
    private object BackupNow()
    {
        var cfg = LoadConfig();
        var appendOnly = cfg.BackupAppendOnly;
        var projTarget = BackupService.ResolveDir(cfg.BackupProjectDir, BackupService.DefaultProjectDir);
        var grpTarget = BackupService.ResolveDir(cfg.BackupGroupDir, BackupService.DefaultGroupDir);

        var projPaths = BackupService.CollectProjectPaths(cfg);
        var grpPaths = BackupService.CollectGroupPaths(cfg);
        if (projPaths.Count == 0 && grpPaths.Count == 0)
            throw new InvalidOperationException("没有可备份的项目/项目组（config 中未登记任何文件夹）。");

        var proj = new BackupResult();
        BackupService.BackupAll(projPaths, projTarget, appendOnly, proj);
        var grp = new BackupResult();
        BackupService.BackupAll(grpPaths, grpTarget, appendOnly, grp);

        return new
        {
            mode = appendOnly ? "appendOnly(只增不删)" : "mirror(镜像同步)",
            project = BackupPayload(projTarget, proj),
            group = BackupPayload(grpTarget, grp),
        };
    }

    /// <summary>备份结果 → MCP 返回载荷。</summary>
    private static object BackupPayload(string target, BackupResult r) => new
    {
        target,
        summary = r.Summary,
        sources = r.Sources,
        missingSources = r.MissingSources,
        newFiles = r.NewFiles,
        updatedFiles = r.UpdatedFiles,
        deletedFiles = r.DeletedFiles,
        skippedLinks = r.SkippedLinks,
        errors = r.Errors,
    };

    // ---------------- 保护（ACL 文件夹锁） ----------------

    /// <summary>lock_status：保护清单 + 每条 ACL 实际生效状态与配置一致性。</summary>
    private object LockStatus()
    {
        var cfg = LoadConfig();
        var items = cfg.FolderLock?.Items ?? new List<FolderLockItem>();
        return new
        {
            watchAlerts = cfg.FolderLock?.WatchAlerts ?? true,
            items = items.Select(i =>
            {
                var exists = Directory.Exists(i.TargetPath);
                FolderLockState live;
                string? err = null;
                try { live = exists ? FolderLockService.GetState(i.TargetPath) : new FolderLockState(false, false); }
                catch (Exception ex) { live = new FolderLockState(false, false); err = ex.Message; }
                return new
                {
                    path = i.TargetPath,
                    configured = new { denyDelete = i.DenyDelete, denyWrite = i.DenyWrite },
                    aclLive = new { delete = live.DenyDelete, write = live.DenyWrite },
                    exists,
                    consistent = err == null && exists && live.DenyDelete == i.DenyDelete && live.DenyWrite == i.DenyWrite,
                    error = err,
                };
            }).ToList(),
            note = "受保护目录中的删除/改名会被系统拒绝（拒绝访问）；如需删除请请示用户在 GUI「ACL 锁定」弹窗中临时解除",
        };
    }

    /// <summary>lock_set：设置/解除某文件夹 ACL 保护并落盘 config。</summary>
    private object LockSet(JsonElement args)
    {
        var p = Str(args, "path");
        if (string.IsNullOrWhiteSpace(p)) throw new InvalidOperationException("缺少参数 path（受保护的文件夹绝对路径）");
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));
        if (!Directory.Exists(full)) throw new InvalidOperationException("文件夹不存在: " + full);

        var remove = Bool(args, "remove", false);
        var cfg = LoadConfig();
        var lockCfg = cfg.FolderLock ??= new FolderLockConfig();

        if (remove)
        {
            try { FolderLockService.Unprotect(full); }
            catch (Exception ex) { throw new InvalidOperationException("解除 ACL 失败: " + ex.Message); }
            lockCfg.Items.RemoveAll(i => string.Equals(
                Path.TrimEndingDirectorySeparator(i.TargetPath), full, StringComparison.OrdinalIgnoreCase));
            // 账面固定联动退出（与 GUI RemoveAllProtection 同语义）
            cfg.Locked.RemoveAll(l => string.Equals(
                Path.TrimEndingDirectorySeparator(l), full, StringComparison.OrdinalIgnoreCase));
            _configSvc.SaveConfig(cfg);
            return new { ok = true, path = full, protectedNow = false, note = "已解除全部 ACL 保护并退出账面固定" };
        }

        var dd = Bool(args, "deny_delete", false);
        var dw = Bool(args, "deny_write", false);
        if (!dd && !dw && !Bool(args, "account_only", false))
            throw new InvalidOperationException("至少需要 deny_delete/deny_write 之一，或 remove=true，或 account_only=true（仅账面固定）");

        try { FolderLockService.Protect(full, dd, dw); }
        catch (Exception ex)
        {
            try { FolderLockService.Unprotect(full); } catch { }
            throw new InvalidOperationException("ACL 设置失败（已回退清理）: " + ex.Message);
        }
        var item = lockCfg.Items.FirstOrDefault(i => string.Equals(
            Path.TrimEndingDirectorySeparator(i.TargetPath), full, StringComparison.OrdinalIgnoreCase));
        if (item == null) { item = new FolderLockItem { TargetPath = full }; lockCfg.Items.Add(item); }
        item.DenyDelete = dd;
        item.DenyWrite = dw;
        if (!cfg.Locked.Any(l => string.Equals(
                Path.TrimEndingDirectorySeparator(l), full, StringComparison.OrdinalIgnoreCase)))
            cfg.Locked.Add(full);   // 账面固定强制联动
        _configSvc.SaveConfig(cfg);
        var strength = (dd, dw) switch { (true, true) => "只读保护", (true, false) => "防删除", (false, true) => "防写入", _ => "仅固定" };
        return new
        {
            ok = true,
            path = full,
            strength,
            protectedNow = dd || dw,
            note = dd || dw
                ? $"ACL 已生效 [{strength}]：删除/改名被系统拒绝" + (dw ? "，目录只读" : "")
                : "仅账面固定（无系统级拦截），等价旧锁定",
            guiNote = "若 GUI 正在运行，需重启 GUI 或刷新后才能看到本变更",
        };
    }

    private List<Dictionary<string, object>> ListGroups()
    {
        var cfg = LoadConfig();
        return cfg.GroupTabs.SelectMany(t => t.Groups)
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(p => new Dictionary<string, object> { ["path"] = p, ["name"] = Path.GetFileName(p.TrimEnd('\\')) })
            .ToList();
    }

    private List<Dictionary<string, object>> ListProjects()
    {
        var cfg = LoadConfig();
        return cfg.ProjectTabs.SelectMany(t => t.Projects)
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(p => new Dictionary<string, object> { ["path"] = p, ["name"] = Path.GetFileName(p.TrimEnd('\\')) })
            .ToList();
    }

    private object SelectFolder(string path)
    {
        var target = (path ?? "").Trim();
        if (target.Length == 0) throw new InvalidOperationException("缺少参数 path");
        if (!Directory.Exists(target)) throw new InvalidOperationException("文件夹不存在: " + target);

        var cfg = LoadConfig();
        var groups = cfg.GroupTabs.SelectMany(t => t.Groups).Distinct(StringComparer.OrdinalIgnoreCase);
        var projects = cfg.ProjectTabs.SelectMany(t => t.Projects).Distinct(StringComparer.OrdinalIgnoreCase);
        var kind = groups.Any(g => Norm(g) == Norm(target)) ? "group"
            : projects.Any(p => Norm(p) == Norm(target)) ? "project" : "other";
        _selection = (target, kind);
        return new { selection = new { path = target, kind }, content = ScanContent(target) };
    }

    private object GetSelection()
    {
        if (_selection == null) return new { selection = (string?)null, agents = Array.Empty<object>(), skills = Array.Empty<object>() };
        return new { selection = new { path = _selection.Value.Path, kind = _selection.Value.Kind }, content = ScanContent(_selection.Value.Path) };
    }

    private string? ResolveTarget(JsonElement args, bool require)
    {
        var t = Str(args, "target");
        if (!string.IsNullOrWhiteSpace(t)) return t;
        if (_selection != null) return _selection.Value.Path;
        if (require) throw new InvalidOperationException("未选择文件夹，请先 select_folder 或传 target");
        return null;
    }

    private object ListContent(JsonElement args, string kind)
    {
        var target = ResolveTarget(args, false);
        if (target == null) throw new InvalidOperationException("未选择文件夹，请先 select_folder 或传 target");
        var content = ScanContent(target);
        return new { target, agents = content["agents"], skills = content["skills"] };
    }

    private object RefreshContent(JsonElement args)
    {
        var target = ResolveTarget(args, true) ?? "";
        var content = ScanContent(target);
        return new { target, agentCount = content["agents"].Count, skillCount = content["skills"].Count, agents = content["agents"], skills = content["skills"] };
    }

    private Dictionary<string, List<Dictionary<string, string>>> ScanContent(string target)
    {
        var agents = AgentSkillService.Enumerate(target, "agent")
            .Select(a => new Dictionary<string, string> { ["name"] = Name(a), ["path"] = a.SourcePath }).ToList();
        var skills = AgentSkillService.Enumerate(target, "skill")
            .Select(s => new Dictionary<string, string> { ["name"] = Name(s), ["path"] = s.SourcePath }).ToList();
        return new() { ["agents"] = agents, ["skills"] = skills };
    }

    private static string Name(AgentSkillItem item)
    {
        var n = item.RelPath;
        if (n.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) n = n[..^3];
        return n;
    }

    private object CreateLink(string project, string group)
    {
        if (string.IsNullOrWhiteSpace(project) || string.IsNullOrWhiteSpace(group))
            throw new InvalidOperationException("缺少参数 project/group");
        if (!Directory.Exists(project)) throw new InvalidOperationException("项目文件夹不存在: " + project);
        if (!Directory.Exists(group)) throw new InvalidOperationException("分组文件夹不存在: " + group);

        var names = LinkAgentCatalog.EnabledNames(LoadConfig());
        if (names.Count == 0) throw new InvalidOperationException("未启用任何 agent 链接名（请在 GUI 「设置」中开启）");

        // 冲突预检：任一启用名被普通目录/文件占用则整体拒绝（防误删内容，避免部分建成）
        foreach (var n in names)
        {
            var lp = JunctionService.LinkPath(project, n);
            if ((Directory.Exists(lp) || File.Exists(lp))
                && JunctionService.GetLinkState(project, n) == JunctionService.LinkState.Conflict)
                throw new InvalidOperationException($"{lp} 已存在且不是链接（普通目录/文件），请手动处理");
        }

        var links = names.Select(n => JunctionService.LinkPath(project, n)).ToList();
        // 逐个建链：中途失败时把已建成的部分写入账本再抛出，避免"链接已存在但记录缺失"
        var created = new List<string>();
        try
        {
            foreach (var n in names)
            {
                JunctionService.Create(JunctionService.LinkPath(project, n), group);
                created.Add(n);
            }
        }
        catch (Exception ex)
        {
            if (created.Count > 0)
            {
                var now = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
                _recSvc.Upsert(project, group, Path.GetFileName(group.TrimEnd('\\')), now, created);
            }
            throw new InvalidOperationException(
                $"已创建 {created.Count}/{names.Count} 个链接后失败（账本已记录成功部分）: {ex.Message}");
        }

        var now2 = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
        _recSvc.Upsert(project, group, Path.GetFileName(group.TrimEnd('\\')), now2, names);
        return new { ok = true, linkCount = links.Count, links, target = group, note = "重新打开项目后，各 agent 的 @ 菜单即可看到该组的 agent / skill" };
    }

    private object RemoveLink(string project)
    {
        if (string.IsNullOrWhiteSpace(project)) throw new InvalidOperationException("缺少参数 project");
        var rec = _recSvc.FindByProject(project);
        var names = rec?.GetLinkNames() ?? new List<string> { LinkRecord.DefaultLinkName };
        var links = names.Select(n => JunctionService.LinkPath(project, n)).ToList();
        var hadLink = links.Any(l => Directory.Exists(l) || File.Exists(l));
        foreach (var n in names)
            if (JunctionService.GetLinkState(project, n) == JunctionService.LinkState.Valid)
                JunctionService.RemoveLink(project, n); // 普通目录/文件则拒绝，避免误删
        if (rec != null || hadLink) _recSvc.Remove(project);
        return new { ok = true, links, removed = hadLink };
    }

    private object ListLinks()
    {
        var links = _recSvc.Load().Select(r =>
        {
            var projAbs = _recSvc.ToAbsPath(r.Project);
            var names = r.GetLinkNames();
            bool conflict = names.Any(n =>
                JunctionService.GetLinkState(projAbs, n) == JunctionService.LinkState.Conflict);
            bool valid = !conflict && names.All(n =>
                JunctionService.GetLinkState(projAbs, n) == JunctionService.LinkState.Valid);
            var detail = names.Select(n => new
            {
                name = n,
                path = JunctionService.LinkPath(projAbs, n),
                state = LinkStateText(JunctionService.GetLinkState(projAbs, n)),
            }).ToList();
            return new
            {
                project = projAbs,
                lib = r.Lib != null ? _recSvc.ToAbsPath(r.Lib) : null,
                group = r.Group,
                created = r.Created,
                names,
                state = conflict ? "冲突" : valid ? "有效" : "无链接",
                links = detail,
            };
        }).ToList();
        return new { links };
    }

    private static string LinkStateText(JunctionService.LinkState s) => s switch
    {
        JunctionService.LinkState.Valid => "有效",
        JunctionService.LinkState.Conflict => "冲突",
        _ => "无链接",
    };

    private object DeploySkill(JsonElement args)
    {
        var prompt = Str(args, "prompt") ?? "";
        prompt = prompt.Trim();
        if (prompt.Length == 0) throw new InvalidOperationException("缺少参数 prompt（skill 描述）");

        var explicitTarget = !string.IsNullOrWhiteSpace(Str(args, "target"));
        var target = ResolveTarget(args, false) as string;
        if (target == null) throw new InvalidOperationException("未指定目标文件夹，请先 select_folder 或传 target");

        var deployBase = target;
        var autoSkillDir = false;
        if (!explicitTarget && _selection is { Kind: "group" })
        {
            deployBase = AgentSkillService.SkillDir(_selection.Value.Path)
                         ?? Path.Combine(_selection.Value.Path, AgentSkillService.SkillDirName);
            autoSkillDir = true;
            var baseDir = deployBase;   // lambda 捕获局部副本（deployBase 后续不再变，防御性快照）
            // baseDir 可能是锁根（如项目组）的子孙目录，须用祖先探测定位锁根摘锁（对子级摘锁无法清继承 ACE）
            FolderLockService.WithUnlockForPath(baseDir, () =>
            {
                if (!Directory.Exists(baseDir)) Directory.CreateDirectory(baseDir);
                return true;
            });
        }

        var cfg = LoadConfig();
        var agentCmd = !string.IsNullOrWhiteSpace(Str(args, "agent_cmd"))
            ? Str(args, "agent_cmd")! : cfg.AiAgentCmd ?? "";

        if (!string.IsNullOrWhiteSpace(agentCmd))
        {
            var r = SpawnAgent(agentCmd, deployBase, prompt);
            return new { mode = "agent", autoSkillDir, deployBase, reqFile = r.Request, ok = r.Failed == null, error = r.Failed, pid = r.Pid, note = "已把请求样例写入部署目录；完成后打开 opencode 即可加载该 skill" };
        }

        var sc = LocalScaffold(deployBase, prompt);
        var avoided = !string.Equals(sc.Name, SanitizeName(prompt), StringComparison.Ordinal);
        return new
        {
            mode = "local",
            autoSkillDir,
            deployBase,
            name = sc.Name,
            skillDir = sc.Dir,
            skillFile = sc.File,
            renamed = avoided,
            note = avoided
                ? $"同名 skill 已存在，已自动避让为「{sc.Name}」（永不覆盖已有内容）。在 opencode 中重新打开该分组即可加载本 skill"
                : "在 opencode 中重新打开该分组即可加载本 skill",
        };
    }

    private (string Name, string Dir, string File) LocalScaffold(string target, string prompt)
        => FolderLockService.WithUnlockForPath(target, () => LocalScaffoldCore(target, prompt));

    private (string Name, string Dir, string File) LocalScaffoldCore(string target, string prompt)
    {
        var name = SanitizeName(prompt);
        // 自动避让：同名 skill 目录已存在时加序号，永不覆盖用户已有内容
        var finalName = name;
        for (var n = 2; Directory.Exists(Path.Combine(target, finalName)); n++)
            finalName = $"{name}{n}";
        var dir = Path.Combine(target, finalName);
        if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, AgentSkillService.SkillMarkdownName);
        var md = string.Join('\n', new[]
        {
            "---", $"name: {finalName}", $"description: {prompt}", "---", "",
            $"# {finalName}", "",
            "> 由「分配项目组」MCP server 本地脚手架生成。", "", "## 用途", prompt, "",
            "## 用法", "（在此补充该 skill 的具体步骤、命令或工具调用。）", "",
            "## 注意事项", "- 此文件由脚手架生成，内容需你完善。", ""
        });
        File.WriteAllText(file, md, new UTF8Encoding(false));
        return (finalName, dir, file);
    }

    private static string SanitizeName(string s)
    {
        s = new string(s.Where(c => !System.IO.Path.GetInvalidFileNameChars().Contains(c)).ToArray())
            .Trim();
        s = string.Join(' ', s.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        if (s.Length > 40) s = s[..40].Trim();
        return s.Length == 0 ? "new-skill" : s;
    }

    private static (string Request, int? Pid, string? Failed) SpawnAgent(string agentCmd, string target, string prompt)
        => FolderLockService.WithUnlockForPath(target, () => SpawnAgentCore(agentCmd, target, prompt));

    private static (string Request, int? Pid, string? Failed) SpawnAgentCore(string agentCmd, string target, string prompt)
    {
        var reqFile = Path.Combine(target, ".ai-deploy-request.json");
        File.WriteAllText(reqFile, Json(new
        {
            target,
            prompt,
            timestamp = DateTime.Now.ToString("O"),
        }), new UTF8Encoding(false));

        var parts = agentCmd.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return (reqFile, null, "agent_cmd 为空");
        var args = parts.Skip(1).Concat(new[] { "--target", target, "--prompt", prompt, "--request", reqFile }).ToList();
        Process? p = null;
        try
        {
            p = Process.Start(new ProcessStartInfo(parts[0])
            {
                Arguments = string.Join(' ', args.Select(AutoQuote)),
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            return (reqFile, p?.Id, null);
        }
        catch (Exception e)
        {
            return (reqFile, null, e.Message);
        }
        finally
        {
            // 进程句柄用完即释放（不等待退出，代理在后台继续运行）
            p?.Dispose();
        }
    }

    /// <summary>Windows 标准命令行引用：引号前按 CRT 解析规则翻倍反斜杠（2n+1 个 \ + " → n 个 \ + 字面引号），
    /// 避免以 \ 结尾的路径参数吞掉闭合引号破坏 argv 解析；空格/tab/引号/空串一律加引号。</summary>
    private static string AutoQuote(string a)
    {
        var needsQuote = a.Length == 0
            || a.IndexOf(' ') >= 0 || a.IndexOf('\t') >= 0 || a.IndexOf('"') >= 0;
        if (!needsQuote) return a;
        var sb = new StringBuilder(a.Length + 16);
        sb.Append('"');
        int slashes = 0;
        foreach (var ch in a)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"')
            {
                sb.Append('\\', slashes * 2 + 1);   // 引号前的反斜杠翻倍再补一个
                slashes = 0;
                sb.Append('"');
                continue;
            }
            sb.Append('\\', slashes);
            slashes = 0;
            sb.Append(ch);
        }
        sb.Append('\\', slashes * 2);               // 闭合引号前的反斜杠翻倍
        sb.Append('"');
        return sb.ToString();
    }

    // ---------------- 新建项目 / 项目组（复用 FolderCreateService 共享管线，E009） ----------------

    private object CreateProject(JsonElement args)
    {
        var name = Str(args, "name");
        var parent = Str(args, "parent_dir");
        if (string.IsNullOrWhiteSpace(name)) throw new InvalidOperationException("缺少参数 name（项目名称）");
        if (string.IsNullOrWhiteSpace(parent)) throw new InvalidOperationException("缺少参数 parent_dir（父目录绝对路径）");
        if (!Directory.Exists(parent)) throw new InvalidOperationException("父目录不存在: " + parent);

        var cfg = LoadConfig();
        var segment = SafeSegmentArg(args, cfg.CreatePathCarriesHierarchy);
        var tabIndex = Int(args, "tab_index", 0);
        var (err, full) = FolderCreateService.CreateProject(cfg, name, parent, segment, tabIndex);
        if (err != null) throw new InvalidOperationException(err);
        _configSvc.SaveConfig(cfg);
        return new { ok = true, kind = "project", path = full, tabIndex, note = "已新建项目文件夹并加入收藏（GUI 若在运行需刷新后可见）" };
    }

    private object CreateGroup(JsonElement args)
    {
        var name = Str(args, "name");
        var parent = Str(args, "parent_dir");
        if (string.IsNullOrWhiteSpace(name)) throw new InvalidOperationException("缺少参数 name（项目组名称）");
        if (string.IsNullOrWhiteSpace(parent)) throw new InvalidOperationException("缺少参数 parent_dir（父目录绝对路径）");
        if (!Directory.Exists(parent)) throw new InvalidOperationException("父目录不存在: " + parent);

        var cfg = LoadConfig();
        var segment = SafeSegmentArg(args, cfg.CreatePathCarriesHierarchy);
        var tabIndex = Int(args, "tab_index", 0);
        // 模板：显式 template_dir 优先；否则用 config.createGroupTemplateDir（不回落硬编码默认模板——那是 GUI 专属）
        var template = Str(args, "template_dir") ?? cfg.CreateGroupTemplateDir;
        var (err, full) = FolderCreateService.CreateGroup(cfg, name, parent, segment, tabIndex, template);
        if (err != null) throw new InvalidOperationException(err);
        _configSvc.SaveConfig(cfg);
        return new { ok = true, kind = "group", path = full, tabIndex, templateUsed = !string.IsNullOrEmpty(template) && Directory.Exists(template), note = "已新建项目组文件夹并加入收藏（GUI 若在运行需刷新后可见）" };
    }

    /// <summary>config 开启「路径携带层级」且本机存在持久化活动页签名时，取其作为层级片段；否则 null（MCP 无 GUI 活动页签概念，默认不带层级）。</summary>
    private string? SafeSegmentArg(JsonElement args, bool carryHierarchy)
    {
        var explicitSeg = Str(args, "hierarchy_segment");
        if (!string.IsNullOrWhiteSpace(explicitSeg)) return explicitSeg;
        if (!carryHierarchy) return null;
        var cfg = LoadConfig();
        var tabName = args.TryGetProperty("tab_index", out var ti) && ti.ValueKind == JsonValueKind.Number
            && ti.TryGetInt32(out var tidx) && tidx >= 0 && tidx < cfg.ProjectTabs.Count
            ? cfg.ProjectTabs[tidx].Name : cfg.ProjectTabs.Count > 0 ? cfg.ProjectTabs[0].Name : null;
        return FolderCreateService.SafeSegment(tabName);
    }

    // ---------------- 文件夹图标（与 GUI「修改图标」同语义，遵循 iconAffectExplorer 开关） ----------------

    private object FolderIconSet(JsonElement args)
    {
        var path = RequireDir(args);
        var icon = Str(args, "icon");
        if (string.IsNullOrWhiteSpace(icon)) throw new InvalidOperationException("缺少参数 icon（图标文件绝对路径）");
        if (!File.Exists(icon)) throw new InvalidOperationException("图标文件不存在: " + icon);

        var cfg = LoadConfig();
        if (cfg.IconAffectExplorer)
        {
            var ini = FolderIconService.SetCustomIcon(path, icon);
            if (ini == null) throw new InvalidOperationException("设置图标失败（权限或属性写入受限）");
            ClearGuiIconOverride(cfg, path);   // 清 GUI 覆盖，避免遮蔽 desktop.ini 新图
            MarkSystemAttrib(cfg, path);       // D3：+s 系本工具所加，恢复时才允许 -s
            _configSvc.SaveConfig(cfg);
            return new { ok = true, path, mode = "explorer", desktopIni = ini, note = "已写入 desktop.ini，资源管理器同步生效" };
        }

        var cached = FolderIconService.CopyToCache(icon);
        if (cached == null) throw new InvalidOperationException("图标复制失败");
        SetGuiIconOverride(cfg, path, cached);
        _configSvc.SaveConfig(cfg);
        return new { ok = true, path, mode = "gui-only", cached, note = "已记录界面图标映射（iconAffectExplorer=false，仅本工具 GUI 生效）" };
    }

    private object FolderIconSetDll(JsonElement args)
    {
        var path = RequireDir(args);
        var dll = Str(args, "dll");
        var idx = Int(args, "index", 0);
        if (string.IsNullOrWhiteSpace(dll)) throw new InvalidOperationException("缺少参数 dll（DLL/EXE 绝对路径）");
        if (!File.Exists(dll)) throw new InvalidOperationException("DLL/EXE 不存在: " + dll);
        if (idx < 0) idx = 0;

        var cfg = LoadConfig();
        if (cfg.IconAffectExplorer)
        {
            var ini = FolderIconService.SetCustomIconFromDll(path, dll, idx);
            if (ini == null) throw new InvalidOperationException("设置图标失败（权限或属性写入受限）");
            ClearGuiIconOverride(cfg, path);
            MarkSystemAttrib(cfg, path);
            _configSvc.SaveConfig(cfg);
            return new { ok = true, path, mode = "explorer", dll, index = idx, desktopIni = ini, note = "已写入 desktop.ini，资源管理器同步生效" };
        }

        SetGuiIconOverride(cfg, path, dll + "|" + idx);
        _configSvc.SaveConfig(cfg);
        return new { ok = true, path, mode = "gui-only", dll, index = idx, note = "已记录界面图标映射（仅本工具 GUI 生效）" };
    }

    private object FolderIconRestore(JsonElement args)
    {
        var path = RequireDir(args);
        var cfg = LoadConfig();
        var marked = cfg.SystemAttribByTool.Any(p => string.Equals(NormKey(p), NormKey(path), StringComparison.OrdinalIgnoreCase));
        var changed = FolderIconService.RestoreDefaultIcon(path, removeSystemAttrib: marked);
        if (changed && marked) ClearSystemAttrib(cfg, path);   // 恢复确认成功后才清标记（D3）
        var guiCleared = ClearGuiIconOverride(cfg, path);
        if (changed || guiCleared) _configSvc.SaveConfig(cfg);
        return new { ok = true, path, changed, guiCleared, note = (changed || guiCleared) ? "已恢复默认图标" : "原本就没有自定义图标（desktop.ini 与 GUI 映射均无）" };
    }

    private object FolderIconGet(JsonElement args)
    {
        var path = RequireDir(args);
        var cfg = LoadConfig();
        var key = NormKey(path);
        string? guiOnly = null;
        foreach (var kv in cfg.GuiFolderIcons)
            if (string.Equals(NormKey(kv.Key), key, StringComparison.OrdinalIgnoreCase)) { guiOnly = kv.Value; break; }
        var explorerRef = FolderIconService.GetCustomIconReference(path);
        var systemMarked = cfg.SystemAttribByTool.Any(p => string.Equals(NormKey(p), key, StringComparison.OrdinalIgnoreCase));
        return new
        {
            path,
            iconAffectExplorer = cfg.IconAffectExplorer,
            explorer = explorerRef is { } r ? new { source = r.Path, index = r.Index } : null,
            guiOnly,
            systemAttribMarked = systemMarked,
            hasCustomIcon = explorerRef != null || guiOnly != null,
        };
    }

    // ---------------- 屏幕取色 ----------------

    private object PickScreenColor(JsonElement args)
    {
        var x = Int(args, "x", int.MinValue);
        var y = Int(args, "y", int.MinValue);
        if (x == int.MinValue || y == int.MinValue)
        {
            var cur = ScreenColorService.CursorPosition();
            if (cur == null) throw new InvalidOperationException("无法读取光标位置，请显式传 x/y 坐标");
            x = cur.Value.X;
            y = cur.Value.Y;
        }
        var color = ScreenColorService.PixelAtPhysical(x, y);
        if (color == null) throw new InvalidOperationException($"坐标 ({x},{y}) 不在显示区域");
        var c = color.Value;
        return new
        {
            ok = true,
            x,
            y,
            color = $"#{c.R:X2}{c.G:X2}{c.B:X2}",
            r = c.R,
            g = c.G,
            b = c.B,
            note = "坐标为物理像素，与 GetCursorPos 同一坐标系",
        };
    }

    // ---------------- 文件夹图标 / config 变更的小工具（与 GUI MainViewModel 对应入口同语义） ----------------

    private string RequireDir(JsonElement args)
    {
        var p = Str(args, "path");
        if (string.IsNullOrWhiteSpace(p)) throw new InvalidOperationException("缺少参数 path（文件夹绝对路径）");
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));
        if (!Directory.Exists(full)) throw new InvalidOperationException("文件夹不存在: " + full);
        return full;
    }

    private static string NormKey(string p) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));

    /// <summary>写 GUI 专属图标映射（先按规范化路径清旧键再写入，键策略与 MainViewModel 一致）。</summary>
    private static void SetGuiIconOverride(AppConfig cfg, string path, string value)
    {
        var key = NormKey(path);
        ClearGuiIconOverride(cfg, path);
        cfg.GuiFolderIcons[key] = value;
    }

    /// <summary>清除某文件夹的 GUI 专属图标映射；返回是否发生变更。</summary>
    private static bool ClearGuiIconOverride(AppConfig cfg, string path)
    {
        var key = NormKey(path);
        string? foundKey = null;
        foreach (var k in cfg.GuiFolderIcons.Keys)
            if (string.Equals(NormKey(k), key, StringComparison.OrdinalIgnoreCase)) { foundKey = k; break; }
        if (foundKey == null) return false;
        cfg.GuiFolderIcons.Remove(foundKey);
        return true;
    }

    /// <summary>记录"本工具给该文件夹加过 +s"（恢复默认图标时才允许 -s）。</summary>
    private static void MarkSystemAttrib(AppConfig cfg, string path)
    {
        var key = NormKey(path);
        if (!cfg.SystemAttribByTool.Contains(key, StringComparer.OrdinalIgnoreCase))
            cfg.SystemAttribByTool.Add(key);
    }

    /// <summary>清除 +s 标记（恢复确认已 -s 后调用）。</summary>
    private static void ClearSystemAttrib(AppConfig cfg, string path)
    {
        var key = NormKey(path);
        cfg.SystemAttribByTool.RemoveAll(p => string.Equals(NormKey(p), key, StringComparison.OrdinalIgnoreCase));
    }

    // ---------------- 截图工具 ----------------

    private object CaptureScreen(JsonElement args)
    {
        var output = Str(args, "output");
        var region = Str(args, "region");
        var file = ScreenCaptureService.CaptureDesktop(output, region);
        return new { ok = true, file, note = "PNG 已保存，可用文件读取能力查看 " + file };
    }

    private object CaptureWindow(JsonElement args)
    {
        var title = Str(args, "title") ?? "";
        var output = Str(args, "output");
        var (file, winTitle, hwnd, w, h) = ScreenCaptureService.CaptureWindow(title, output);
        return new { ok = true, file, title = winTitle, hwnd, width = w, height = h, note = "PNG 已保存，可用文件读取能力查看 " + file };
    }

    private object ListWindows(JsonElement args)
    {
        var keyword = Str(args, "keyword") ?? "";
        var titles = ScreenCaptureService.FindWindowTitles(keyword);
        return new { count = titles.Count, titles };
    }

    // ---------------- JSON 装配 ----------------

    /// <summary>信封手工拼装：id 必须按 JSON-RPC 2.0 规范始终输出——数字原样、字符串带引号、无 id 时显式 null。
    /// （若走匿名对象 + WhenWritingNull 序列化，null id 字段会被省略，违反规范。）</summary>
    private static string Result(object? id, object result) =>
        "{\"jsonrpc\":\"2.0\",\"id\":" + IdRaw(id) + ",\"result\":" + Json(result) + "}";

    private static string Error(object? id, int code, string message) =>
        "{\"jsonrpc\":\"2.0\",\"id\":" + IdRaw(id) + ",\"error\":{\"code\":" + code
        + ",\"message\":" + JsonSerializer.Serialize(message) + "}}";

    private static string IdRaw(object? id) => id switch
    {
        null => "null",
        JsonElement e => e.GetRawText(),
        string s => JsonSerializer.Serialize(s),
        _ => "null",
    };

    private static string Json(object o) => JsonSerializer.Serialize(o, IoJson);

    private static string? Str(JsonElement args, string key)
    {
        if (args.ValueKind != JsonValueKind.Object) return null;
        return args.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    }

    private static bool Bool(JsonElement args, string key, bool def)
    {
        if (args.ValueKind != JsonValueKind.Object) return def;
        return args.TryGetProperty(key, out var v)
            && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False) ? v.GetBoolean() : def;
    }

    private static int Int(JsonElement args, string key, int def)
    {
        if (args.ValueKind != JsonValueKind.Object) return def;
        return args.TryGetProperty(key, out var v)
            && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : def;
    }

    private static string Norm(string p) => Path.TrimEndingDirectorySeparator(p);

    private static JsonElement JsonDoc(string s)
    {
        // Clone 脱离文档作用域，文档立即释放（避免每次 tools/list 泄漏一个 JsonDocument）
        using var doc = JsonDocument.Parse(s);
        return doc.RootElement.Clone();
    }

    // ---------------- 工具清单（对齐 server.cjs；名称/说明来自 McpToolCatalog，按开关过滤） ----------------

    private List<JsonElement> BuildTools()
    {
        var tools = new List<JsonElement>();
        foreach (var t in McpToolCatalog.All)
        {
            if (!IsEnabled(t.Name)) continue;
            tools.Add(T(t.Name, t.Description, SchemaFor(t.Name)));
        }
        return tools;
    }

    private static object SchemaFor(string name) => name switch
    {
        "select_folder" => new { type = "object", properties = new { path = new { type = "string", description = "项目组或项目的绝对路径" } }, required = new[] { "path" } },
        "create_project" => new { type = "object", properties = new { name = new { type = "string", description = "项目名称（将作为新文件夹名）" }, parent_dir = new { type = "string", description = "父目录绝对路径（须存在）" }, tab_index = new { type = "integer", description = "加入的收藏页签序号（可选，默认 0）" }, hierarchy_segment = new { type = "string", description = "路径层级片段（可选；显式传入时在 parent_dir 下再加一层）" } }, required = new[] { "name", "parent_dir" } },
        "create_group" => new { type = "object", properties = new { name = new { type = "string", description = "项目组名称（将作为新文件夹名）" }, parent_dir = new { type = "string", description = "父目录绝对路径（须存在）" }, tab_index = new { type = "integer", description = "加入的收藏页签序号（可选，默认 0）" }, hierarchy_segment = new { type = "string", description = "路径层级片段（可选；显式传入时在 parent_dir 下再加一层）" }, template_dir = new { type = "string", description = "模板文件夹绝对路径（可选；传入且存在则拷贝其内容，缺省用 config.createGroupTemplateDir，都为空建空文件夹）" } }, required = new[] { "name", "parent_dir" } },
        "list_agents" => new { type = "object", properties = new { target = new { type = "string", description = "文件夹绝对路径（可选，缺省用当前选中）" } } },
        "list_skills" => new { type = "object", properties = new { target = new { type = "string", description = "文件夹绝对路径（可选，缺省用当前选中）" } } },
        "refresh_content" => new { type = "object", properties = new { target = new { type = "string", description = "文件夹绝对路径（可选，缺省用当前选中）" } } },
        "create_link" => new { type = "object", properties = new { project = new { type = "string" }, group = new { type = "string" } }, required = new[] { "project", "group" } },
        "remove_link" => new { type = "object", properties = new { project = new { type = "string" } }, required = new[] { "project" } },
        "deploy_skill" => new { type = "object", properties = new { prompt = new { type = "string", description = "skill 的自然语言描述" }, target = new { type = "string", description = "目标文件夹绝对路径（可选；缺省且选中为项目组时自动用 <组>/skill/）" }, agent_cmd = new { type = "string", description = "外部代理命令（可选，缺省用 config.aiAgentCmd）" } }, required = new[] { "prompt" } },
        "capture_screen" => new { type = "object", properties = new { output = new { type = "string", description = "输出 PNG 绝对路径（可选，缺省保存到系统临时目录 fenpei-shot/）" }, region = new { type = "string", description = "截取区域 \"x,y,w,h\"（屏幕坐标，可选；缺省整个虚拟桌面）" } } },
        "capture_window" => new { type = "object", properties = new { title = new { type = "string", description = "窗口标题关键词（模糊匹配，忽略大小写）" }, output = new { type = "string", description = "输出 PNG 绝对路径（可选，缺省保存到系统临时目录 fenpei-shot/）" } }, required = new[] { "title" } },
        "list_windows" => new { type = "object", properties = new { keyword = new { type = "string", description = "标题过滤关键词（可选，空则列出全部）" } } },
        "lock_set" => new { type = "object", properties = new { path = new { type = "string", description = "文件夹绝对路径" }, deny_delete = new { type = "boolean", description = "防删除：拦截删除/改名，读写不受影响" }, deny_write = new { type = "boolean", description = "防写入：目录整体只读" }, remove = new { type = "boolean", description = "true=解除该路径全部保护" }, account_only = new { type = "boolean", description = "true=仅账面固定（无系统级拦截）" } }, required = new[] { "path" } },
        "folder_icon_set" => new { type = "object", properties = new { path = new { type = "string", description = "目标文件夹绝对路径" }, icon = new { type = "string", description = "图标文件绝对路径（.ico/.png/.jpg/.bmp/.gif）" } }, required = new[] { "path", "icon" } },
        "folder_icon_set_dll" => new { type = "object", properties = new { path = new { type = "string", description = "目标文件夹绝对路径" }, dll = new { type = "string", description = "DLL/EXE 绝对路径（如 C:\\Windows\\System32\\SHELL32.dll）" }, index = new { type = "integer", description = "DLL 内图标索引（可选，默认 0）" } }, required = new[] { "path", "dll" } },
        "folder_icon_restore" => new { type = "object", properties = new { path = new { type = "string", description = "目标文件夹绝对路径" } }, required = new[] { "path" } },
        "folder_icon_get" => new { type = "object", properties = new { path = new { type = "string", description = "目标文件夹绝对路径" } }, required = new[] { "path" } },
        "pick_screen_color" => new { type = "object", properties = new { x = new { type = "integer", description = "物理像素 X（可选；缺省用当前光标位置）" }, y = new { type = "integer", description = "物理像素 Y（可选；缺省用当前光标位置）" } } },
        // 无参工具也输出标准空对象 schema（裸 {} 虽是合法 JSON Schema，但部分严格客户端校验 type 字段）
        _ => new { type = "object", properties = new { } },
    };

    private static JsonElement T(string name, string description, object schema)
        => JsonDoc(Json(new { name, description, inputSchema = schema }));
}