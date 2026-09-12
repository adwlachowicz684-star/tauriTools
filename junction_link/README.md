# 分配项目组 · C# WPF (.NET 8)

一个原生 C# WPF (.NET 8) 桌面工具，多功能并列的组合工具，目前包含「分配项目组」与「思维导图」两大功能。

- **分配项目组**：项目组 / 项目 / AgentSkill 的组织与管理——页签与文件夹卡片管理、跨列拖拽重排、junction 链接、有效性校验、ACL 文件夹保护、文件夹图标自定义、内嵌 MCP server。
- **思维导图**：kityminder 插件，WebView2 承载本地离线包，支持安装/卸载/重装，导入/导出/刷新，自定义主题。

> 给接手任务窗口的一站式说明：本项目功能完整落地，非"骨架"状态。
> 想在别的窗口/AI 会话接手，先通读本 README + `.opencode/rules/rules.md`（项目规范）+ `.opencode/rules/AI_ERRATA.md`（踩坑清单）+ `.opencode/rules/美术标准.md`（视觉规范）。

---

## 一、一键上手

```powershell
# 编译 → 产出 dist\分配项目组.exe（取自 TEMP 中间目录拷贝回 dist）
powershell -ExecutionPolicy Bypass -File build.ps1

# 单文件自包含发布 → dist\single\分配项目组.exe（拷到别的电脑可脱离 .NET 运行）
powershell -ExecutionPolicy Bypass -File publish-single.ps1

# 运行成品
.\dist\分配项目组.exe
```

前置条件：本机已装 .NET 8 SDK（`C:\Users\Administrator\.dotnet\dotnet.exe`）。
改源码后**永远不要手改 dist 里的 exe**，先改 `src/`，再跑 `build.ps1`。

验证是否改好：编译 exit 0 = 通过；运行 5 秒不崩 = 启动正常（主窗口标题「分配项目组」）。

### MCP server 模式（供 AI 客户端调用）

同一个 exe 可作 **MCP server** 运行：`.\dist\分配项目组.exe --mcp`（不开窗口，通过 stdin/stdout 走 JSON-RPC）。
工具清单由 `Services/McpToolCatalog.cs` 单一维护，GUI「MCP 工具开关」面板与 `tools/list` 共用，两处保持一致：
`get_manual / get_status / list_groups / list_projects / select_folder /
get_selection / create_project / create_group / list_agents / list_skills / refresh_content /
create_link / remove_link / list_links / deploy_skill / folder_icon_set / folder_icon_set_dll /
folder_icon_restore / folder_icon_get / capture_screen / capture_window / list_windows /
pick_screen_color / backup_now / lock_status / lock_set`
（基础信息 / 目录与选择 / 目录与创建 / 内容读取 / 链接管理 / 部署 / 文件夹图标 / 截图 / 备份 / 保护，共 10 组）。
复用了 GUI 同源的 `ConfigService/LinkRecordService/JunctionService/AgentSkillService/FolderCreateService/FolderIconService/ScreenColorService`，操作 `数据/`，与界面共享同一份数据。

本项目已预置注册文件，客户端直接识别（无需再手写）：
- `.\mcp.json`（项目根）：opencode / Claude 等读取 `mcpServers` 的标准位置，`command` 用 `{env:FPX_ROOT}` 动态占位。
- `.\\.trae\mcp.json`（TRAE 项目级）：经 `.trae` junction 落在共享 rules 仓库，仅本项目生效；使用前在 TRAE **设置 → MCP → 打开「启用项目级 MCP」开关**，新会话即可调用。

**路径动态化**：软件根目录不写死，统一由 `FPX_ROOT` 用户环境变量承载（= 项目根，即 exe 的上级目录）。GUI 启动时自动注册（`Services/McpRegistrationService.cs`）：设置 `FPX_ROOT` → 维护项目根 `.mcp.json` 占位符 → 自愈 TRAE 全局 `mcp.json` 中已存在的「分配项目组」条目。因此整个目录可整体移动 / 改名 / 换盘符，无需改任何配置。

手动注册示例（TRAE「设置 → MCP → 添加 → 手动添加」粘贴，或任意 `.mcp.json`）：
```json
{
  "mcpServers": {
    "分配项目组": {
      "command": "{env:FPX_ROOT}\\dist\\分配项目组.exe",
      "args": ["--mcp"],
      "env": {
        "START_MCP_TIMEOUT_MS": "60000",
        "RUN_MCP_TIMEOUT_MS": "60000"
      }
    }
  }
}
```
> 若客户端不支持 `{env:VAR}` 插值（如 TRAE 全局配置），用实际 exe 绝对路径代替：`<软件根目录>\dist\分配项目组.exe`。
说明：
- MCP 用 UTF-8；实现用显式 UTF-8 流读原始 stdin 句柄，GBK 中文系统下中文 prompt/路径不会乱码。
- 退出信号：客户端关闭 stdin 后进程自动结束（Environment.Exit）。
- 单 exe 即服务，不依赖 Node.js。

---

## 二、目录总览

```
分配项目组迁移/
├── .opencode/          junction → E:\_project\AIProject_opencode\DIY工具创建（共享原目录，勿改名）
│   └── rules/          rules.md（项目规范）/ AI_ERRATA.md（错题集）/ 美术标准.md（视觉规范）
├── .trae/              junction → 同一共享原目录（TRAE 用）
├── src/                ← 全部源码，在此读写
│   ├── FenPeiXiangMuZu.csproj
│   ├── App/             入口 + 主窗口 + 全局新拟物主题资源
│   ├── Views/           UserControl 面板（AgentSkill/Mcp/Tips/Settings）与弹窗
│   ├── ViewModels/      MVVM 数据层（MainViewModel 拆多个 partial）
│   ├── Services/        底层能力：Junction/Config/Icon/Acrylic/自检 等
│   └── Models/          强类型 JSON 模型：AppConfig/LinkRecord/AgentSkillItem
├── dist/               编译输出 exe（勿手改）；dist/single/ 单文件成品
├── 数据/              运行时读写：link-record.json、分配项目组-config.json
├── build.ps1 / publish-single.ps1
└── README.md
```

依赖链：`App（壳）→ Views（界面）→ ViewModels（逻辑）→ Services（能力）→ Models（数据）`。

---

## 三、架构要点

- **MVVM**：界面 XAML 只做绑定，逻辑在 `ViewModels/`。`ObservableCollection<T>` 自动同步刷新。
- **代码分层**：
  - `App.xaml`：全局**深色新拟物主题**（色板 + `NeuBezel` 斜向描边 + `NeuShadow` 阴影 + `Card` 样式 + 全局 ToolTip 隐式样式）。新界面一律引用这些资源，不另造风格。
  - `MainWindow.xaml(.cs)`：三栏主区（项目组 / 项目 / AgentSkill）+ 侧边栏 + 日志 + 状态栏 + 浮层（设置 / MCP / TIPS）。命令绑定与拖拽事件在此。
  - `MainViewModel.*.cs`（partial 拆分）：数据组装、页签/卡片逻辑、拖拽排序数据流。
  - `Services/`：`JunctionService`（agent 链接）、`LinkRecordService`（记录）、`ConfigService`、`FolderIconService/IconService`（图标）、`AcrylicService`（P/Invoke 模糊）、`AgentSkillService`、`DataSelfCheck`。

---

## 四、已实现功能清单

- 项目 / 项目组页签（带计数徽章，可增删 / 重命名 / 拖拽排序）。
- 项目组 / 项目文件夹卡片：图标 + 名称 + 选中互斥 + 失效置灰 + 链接状态标记。
- **页签拖拽排序**：按住页签拖动，其他页签随鼠标插入位置实时让位。
- **文件夹跨列拖拽**：项目 ⇄ 项目组可互相拖动；拖到页签上页签实时切换。
- **跨类别移动同步搬家**（设置「基础设置」默认勾选）：把卡片在项目区与项目组区之间来回拖动时，同时把该文件夹物理搬到对应根目录（项目→「新建项目组父目录」、项目组→「新建项目父目录」），并同步更新链接记录、junction 与全部路径引用；「搬家范围」可在设置中三选一：默认根目录下（含嵌套层级路径也扁平化搬到目标根）/ 仅默认根目录下（嵌套保持原位）/ 任意位置；不在范围内、目标根未设置、目标同名已存在时仅移动卡片并日志提示。取消勾选则只移动卡片、文件夹保持原位。
- **插入位置竖条指示器**：拖拽时在目标插入点显示竖条。
- **面板外文件夹拖入**：拖到页签上实时切换并落入指定页签。
- **项目卡片**：右侧实时显示链接的项目组名；`🔗` 示有效链接、红色 `✕` 示链接破坏；无链接时为空。
- AgentSkill 面板：agents/skills 浏览、预览、打开目录、刷新、计数状态栏。
- 设置面板：基础设置/创建预设（快速链接、目录类资源 junction 部署、新建项目/项目组的预设父目录与模板，以及「新建项目/项目组时路径携带页签及集群层级」——开启后项目存放到父目录\当前项目页签名\名称、项目组存放到父目录\当前项目组集群名\名称）、链接名称（批量勾选 agent 链接名）、图标预设、快捷键。
- MCP「工具开关」面板：总开关 / 按组逐项启停（基础信息｜目录与选择｜内容读取｜链接管理｜部署｜截图），改动即时保存，下次连接仅暴露已勾选工具。
- TIPS「使用说明」面板：内嵌使用手册，覆盖基础功能、按钮功能、MCP 工具清单与 Agent-Skill 部署。
- **思维导图插件**（kityminder，`Views/MindMapPanel.cs` + `Services/PluginService.cs`）：WebView2 承载本地离线包，随时**安装 / 卸载 / 重装**。侧边栏「思维导图」入口常显；未安装时面板内提供「立即安装」（解压 `资源/kityminder.ui.zip` 到 `数据/plugins/kityminder`），已安装时直接打开编辑器。支持导入 / 导出 / 刷新，卸载将运行期目录回收（留离线包可重装）。运行依赖系统 WebView2 Runtime（Win11 自带）。
- **ACL 文件夹保护**（`Services/FolderLockService.cs` + `Views/AclLockDialog.cs`）：侧边栏「ACL 锁定」（Ctrl+L）对选中文件夹做系统级保护。账面固定（原锁定功能，强制勾选）+ 防删除（Deny Everyone Delete，拦截删除/改名）+ 防写入（整体只读）；档位一键设置；卡片暗金盾牌标记；FileSystemWatcher 监控外部改动写日志（防呆不防黑客，B 层兜底）。自救五层见 TIPS：fail-open 解锁窗口 / 启动自愈 / 一键全解 / 手动 `icacls "<目录>" /remove:d *S-1-1-0` / 永不触碰所有权。
- 自定义标题栏、托盘、ESC 快捷关闭浮层/弹窗。
- **内嵌 MCP server**（`Services/McpServer.cs` + `App.xaml.cs` 的 `--mcp` 分支）：单 exe 以 stdio JSON-RPC 对外开放工具，供 AI 客户端调用。
- **整体深色新拟物风格**：外凸（左上浅/右下深描边 + 右下深影）↔ 按压内凹；输入框为内凹。

---

## 五、重要约定与避坑（接手必读）

见 `.opencode/rules/rules.md` 与 `.opencode/rules/AI_ERRATA.md`，关键几条：

- `App.xaml` 必须有 `<ApplicationDefinition>`（否则无入口）。
- UserControl 用于绑定的属性必须是 `DependencyProperty`（普通属性不支持绑定）。
- **禁止把属性/字段命名为 `Path`**（遮蔽 `System.IO.Path`）；用到需显式 `using System.IO;`。
- 编译中间产物放**英文 TEMP 目录**再拷回，规避沙箱限制与中文路径 GBK 乱码（build.ps1 已内置）。
- `ToggleButton IsChecked="True"` 会在控件初始化前触发事件，处理器须对控件访问做 null 检查（否则双击 exe 崩溃）。
- 新拟物样式统一引用 `App.xaml` 全局资源（`NeuSurface/NeuInset/NeuBezel/NeuShadow*`），不得在面板内重造冲突风格。
- 主窗口标题栏边框结构被拖拽/双击最大化逻辑依赖（`root.Children[0]`），改动 XAML 勿破坏。

---

## 六、数据文件

- `数据\分配项目组-config.json`：分组 / 项目 / 页签 / 设置（`Models/AppConfig.cs` 读写）。
  - `folderLock.items[]`：ACL 保护清单（path / denyDelete / denyWrite）；`folderLock.watchAlerts`：监控告警开关。账面固定仍存顶层 `locked`。
- `数据\link-record.json`：链接记录（`Models/LinkRecord.cs`）。
- 格式与既有版本完全兼容。只改"分组/路径/设置"这类数据 → 直接改 JSON 即改即固，无需重新编译；改 UI/功能 → 动 `src/` 并重新编译。

---

## 七、常见开发流

1. **加一个功能**：在 `ViewModels/` 对应 partial 加属性/命令 → 在 `MainWindow.xaml` 或对应 `Views/*.xaml` 加绑定与控件 → `build.ps1` 编译 → 启动验证。
2. **改全局外观**：改 `App.xaml` 的全局资源 → `build.ps1`。
3. **改单个面板外观**：改 `src/Views/*.xaml` 的本地样式（引用全局新拟物资源）→ `build.ps1`。
4. **数据修正**：直接改 `数据/*.json`。
