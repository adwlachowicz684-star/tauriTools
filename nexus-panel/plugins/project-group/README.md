# 项目组分配（Nexus Panel 插件）

把 `junction_link`（C# WPF「分配项目组」）里**除思维导图以外**的核心能力，
重新封装成 Nexus Panel 的一个插件：**React + TSX 沙箱挂载 + Rust 后端命令**。

不含：思维导图（kityminder）、MCP server、截图取色、备份、Agent 连锁发送。

---

## 一、跑起来

后端是新增的 Rust 代码，**必须先重新编译一次**：

```bash
cd nexus-panel
npm install
npm run tauri:dev      # 开发（Vite 热更新 + 编译 Rust）
npm run tauri:build    # 打包
```

侧边栏出现「项目组分配」即成功。它要求 Vite（`requiresBuild: true`），
所以在无构建模式（`cargo tauri dev`）下会自动隐藏。

## 二、功能

| 能力 | 说明 |
|---|---|
| **左操作栏 + 三栏主区 + 底部日志** | 与 C# 版布局一致：左侧竖排操作按钮（图标在上、文字在下，栏宽固定 72px），右侧主区上为三栏、下为日志行 |
| **项目 / 项目组双栏** | 项目栏多页签切换；**项目组栏所有分类纵向堆叠、各自可折叠**（与 C# 版 groupBoxes 一致，一次看全不用反复切页签）；卡片可拖拽排序、跨栏拖拽即分配 |
| **分配（建链）** | **只能跨栏拖拽**：把项目卡片拖到项目组卡片（或反向）即建链，在项目目录下为每个启用的 agent 链接名建指向项目组的链接，逐条记账。界面上没有「建链」按钮——拖放即所见即所得，按钮反而多一次「先选 A 再选 B」的心智负担 |
| **链接名管理** | 16 个预设（.opencode/.claude/.codex…）+ 自定义；开关存配置 |
| **链接记录** | 后台记账（项目 → 项目组、链接名、时间、四态）；界面不展示表格，卡片上的 🔗 徽标即状态，需要查明细就「打开数据目录」看 `config.json` 的 `links` |
| **卡片显示链接的项目组名** | 项目卡片上除「🔗 N」外还会显示「→ 项目组名」（对照 WPF 的 `LinkedGroupBtn`）；**点击它可在项目组栏里定位选中该项目组**。只在项目卡片上显示，项目组卡片自己就是组 |
| **agent / skill / rule 浏览** | 树形展示 + 文本预览 + 外部编辑 / 打开所在目录 |
| **新建项目 / 项目组** | 直接建文件夹并入页签（项目组可带模板目录、可挂页签层级） |
| **ACL 保护** | 防删除 / 防写入两档（Windows 走 icacls，其它平台退化为只读） |
| **内置图标库** | 随插件发布 122 个 .ico，按分组浏览选用（分组可增删改名）；选用时固化到数据目录，方可同步到资源管理器 |
| **图标与标签** | emoji / 图标文件 + 完整色盘（预设 24 色 / 自定义常用色可增删 / RGB·HEX 输入 / 吸管取色 / 恢复默认）；Windows 可写 desktop.ini 同步到资源管理器 |
| **颜色继承** | 项目组改色自动传播到链接它的项目卡片（界面标「继承」，改后转为自有颜色） |
| **内嵌目录选择器** | 面包屑 + 快速起点 + 手工粘贴路径 + 就地新建子目录（不依赖系统对话框） |
| **一键备份** | 增量同步到备份目录；可只新增更新或镜像同步；链接点不跟随，防循环 |
| **编辑器选择** | 自动枚举本机可打开 .md 的程序，设为「外部编辑」的默认程序 |
| **发送到 AI** | 内置四项连锁动作（自由任务 / 一键审查 / 快速归并 / 快速部署）+ 自定义；每个动作分别有项目与项目组两份模板，可指定专属客户端、可挂右键菜单。发给 opencode / Cursor / VSCode / Trae 等（部分客户端降级为复制+粘贴） |
| **截图** | 存到数据目录 `shots/`（Windows 直出，macOS/Linux 调系统命令） |
| **目录监听** | 受保护目录被外部改动时告警（轮询比对，见「注意」） |
| **MCP server** | 仅本机可访问；让外部 AI 工具调用本插件 24 个能力 |
| **链接名改名 / 厂商** | 每个预设链接名可改名（改实际建链目录名）、可覆盖厂商标注 |
| **链接名置顶** | 星标置顶，多个置顶项按点击顺序排前；改名后自动跟随新名 |
| **基础设置面板** | 拖入后自动选中、快速链接、新建路径带页签层级、图标同步资源管理器、只增备份、自动备份间隔、MCP 总开关与 24 个工具逐个开关 |
| **设置走外壳「⚙」** | 「基础设置」「Agent 链接名」「服务（MCP / 监听 / 截图）」三块都收进**外壳右上角的「⚙ 设置」**（重载按钮左侧），不占主界面工具栏。主界面只留日常操作（新建、备份、发送到 AI、刷新、清除无效项） |
| **自动备份** | 后台线程按间隔定时备份项目 + 项目组；改动在保存时生效，设为「关闭」即停 |
| **备份目录分开** | 项目与项目组可各指定一个备份目录，优先于统一根目录；留空则回退 |
| **跨类别换栏（含物理搬家）** | 卡片右键「转为项目 / 转为项目组」：换栏 + 按范围设置把文件夹搬到目标类别预设父目录；三档范围可选，搬家失败整体中止 |
| **自定义连锁客户端** | 自动检测扫不到时手动登记 exe / URL scheme，登记后强制出现在客户端列表 |
| **文件夹改名** | 右键「改名…」/ F2：物理 rename + 同步页签登记、链接记录、图标/标签色/ACL 锁里对应的路径 |
| **文件夹搬家** | 左栏「搬家」：把整个文件夹移到别的父目录，同步全部登记；**项目组搬家会重建指向它的链接**。只支持同盘（见「注意」） |
| **清除无效项** | 工具栏按钮 / F8：摘掉页签里已不存在的路径，并清理指向它们的链接记录 |
| **活动页签记忆** | 记住上次停留的项目/项目组页签，进插件自动恢复（序号越界时自动收敛）。存 `ctx.store`（localStorage）而非 `config.json`——这是 UI 会话状态，不该每切一次页签就写一次配置文件 |
| **卡片操作快捷键** | Ctrl/⌘+O 打开 / Ctrl/⌘+L 锁定 / F2 改名 / F3 搬家 / F4 改色 / F6 改图标 / Delete 移除；作用于「焦点栏」里当前选中的卡片，标题上标「焦点」的就是它 |
| **页签切换快捷键** | Ctrl/⌘+Tab、Ctrl/⌘+Shift+Tab（在项目组分类间跳，选中该分类第一张卡片）、Ctrl/⌘+PageDown/PageUp（翻项目页签）、Ctrl/⌘+←/→ 切焦点栏 |
| **界面快捷键** | F5 刷新、F8 清除无效项（与两个工具栏按钮上标的提示一致） |
| **备份目录直达** | 工具栏「打开项目备份目录」「打开项目组备份目录」，未单独配置时回退统一根目录 |
| **编辑器结果缓存** | 候选编辑器列表缓存进配置，打开即显示；点「重新搜索」才真扫 |
| **连锁动作快捷键** | 每个动作可设一个应用级快捷键（如 Ctrl+Shift+1），窗口前台时按下即对当前选中卡片执行；在设置框内直接按组合键即可录入 |
| **动作挂到左侧栏** | 动作可注入外壳侧边栏，点击即对当前选中卡片执行；插件卸载时自动移除 |
| **更换软件图标** | 在设置里把数据目录 `icons/` 下的图标设为软件窗口图标（任务栏 / 标题栏） |

## 三、数据放在哪

独立于原 C# 版，互不影响：

```
<appDataDir>/project-group/
├── config.json         # 页签、链接名开关/改名/厂商、保护、图标、颜色、备份与连锁设置…
├── link-record.json    # 链接账本
├── icons/              # 自定义图标（可从目录批量导入）
├── shots/              # 截图产物
└── backup/             # 备份默认位置（可在「备份」面板改到别处）
```

- Windows： `%APPDATA%\com.nexus.panel\project-group\`
- macOS：   `~/Library/Application Support/com.nexus.panel/project-group/`
- Linux：   `~/.local/share/com.nexus.panel/project-group/`

工具栏「打开数据目录」可直接跳过去。字段命名沿用 C# 版（camelCase），
以后想共用同一份数据只需改 `store.rs` 的目录解析。

## 四、目录结构

```
plugins/project-group/
├── index.html / main.tsx      # iframe 沙箱入口
├── App.tsx                    # 左操作栏 + 三栏主区 + 底部日志
├── Settings.tsx               # 外壳「⚙ 设置」面板（基础设置 / 链接名 / 服务）
├── types.ts                   # 与 Rust model.rs 一一对应的 DTO
├── api.ts                     # 所有 ctx.invoke 集中在这里
├── style.css                  # 只用外壳主题变量，随主题自动适配
├── hooks/useFpx.ts            # 状态中心：加载/增删改/统一错误处理
├── hooks/useCardHotkeys.ts    # 卡片与页签快捷键
└── components/
    ├── ui.tsx                 # Modal / ContextMenu / CheckLine（菜单走 portal 图层）
    ├── SideRail.tsx           # 左操作栏：图标在上、文字在下，栏宽固定
    ├── StackedGroups.tsx      # 项目组栏：分类纵向堆叠、各自可折叠
    ├── CardGrid.tsx           # 页签条 + 卡片网格（选中/右键/拖拽）
    ├── ContentPanel.tsx       # agent·skill·rule 树 + 预览
    ├── ColorPicker.tsx        # 色盘：预设 24 色 / 常用色 / RGB·HEX / 吸管
    ├── DirDialog.tsx          # 内嵌目录选择器
    ├── RenameDialog.tsx       # 文件夹改名
    ├── RenameContentDialog.tsx# 内容条目改名
    ├── LinkPanel.tsx          # 链接名开关（记录表已移除，数据仍在 config.json）
    └── dialogs.tsx            # 新建 / ACL 保护 / 图标与标签
```

```
src-tauri/src/fpx/
├── mod.rs         命令层（47 条 fpx_*）
├── model.rs       DTO
├── store.rs       配置 / 记录读写 + 卡片状态计算 + 事务与锁
├── junction.rs    链接操作 + agent 链接名名单
├── content.rs     agent / skill / rule 扫描
├── sys.rs         目录浏览 / 新建 / 打开 / ACL / desktop.ini
├── backup.rs      一键备份
├── chain.rs       Agent 连锁（发指令给桌面 AI 客户端）
├── mcp.rs         内置 MCP server（24 个工具）
├── watch.rs       受保护目录监听
├── screen.rs      屏幕截图
├── editor.rs      编辑器候选枚举
├── cli.rs         命令行模式（--self-check / --migrate-*）
├── fsutil.rs      跨平台文件原语（链接判定 / 递归遍历 / 跨设备回退 / 文件锁）
├── safety.rs      外部命令安全边界
└── base64.rs      极简 base64
```

## 五、与 C# 版的对应关系

| C#（junction_link） | 这里 |
|---|---|
| `Models/AppConfig.cs` | `fpx/model.rs` 的 `FpxConfig` |
| `Models/LinkRecord.cs` | `fpx/model.rs` 的 `LinkRecord` |
| `Services/JunctionService.cs` | `fpx/junction.rs` |
| `Services/LinkAgentCatalog.cs` | `fpx/junction.rs` 的 `PRESET_AGENTS` |
| `Services/AgentSkillService.cs` | `fpx/content.rs`（agent/skill/rule 三类的枚举规则一致） |
| `Services/FolderCreateService.cs` | `fpx/sys.rs::create_folder` |
| `Services/FolderLockService.cs` | `fpx/sys.rs::apply_lock`（icacls，非 Windows 退化） |
| `Services/FolderIconService.cs` | `fpx/sys.rs::apply_icon`（desktop.ini） |
| `Views/ColorPickDialog.cs` | `components/ColorPicker.tsx`（预设色值表一致，SV 面板换成 RGB/HEX 输入） |
| `Services/ScreenColorService.cs` | `fpx/sys.rs::pick_screen_color`（Windows GDI，其它平台自动隐藏吸管） |
| `ViewModels/AgentSkillViewModel.cs` | `components/ContentPanel.tsx` + `hooks/useFpx.ts` |

## 六、已补齐的能力（本轮新增）

| 能力 | 后端 | 前端 | 说明 |
|---|---|---|---|
| 一键备份 | `fpx/backup.rs` | 工具条「备份」 | 增量同步（大小+修改时间，2 秒容差）；链接点不跟随；源与备份目录嵌套时跳过；可选镜像模式 |
| 编辑器选择 | `fpx/editor.rs` | 「服务」→ 编辑器，或内容区「外部编辑」 | 扫描 PATH + 各平台固定安装位置；Windows 补 `reg query`；macOS 扫 `/Applications`（按关键词过滤） |
| Agent 连锁 | `fpx/chain.rs` | 工具条「发送到 AI」/ 卡片右键 | opencode、Cursor 走深链接；VSCode 走命令行；其余降级为「复制+唤起+提示粘贴」 |
| 截图 | `fpx/screen.rs` | 「服务」→ 截图 | Windows 走 PowerShell+System.Drawing；macOS 用 screencapture；Linux 需 import/gnome-screenshot/grim |
| 目录监听 | `fpx/watch.rs` | 「服务」→ 监听 | 轮询比对指纹（条目数+最大修改时间），改动经 `fpx_watch_poll` 拉取告警 |
| MCP server | `fpx/mcp.rs` | 「服务」→ MCP | 仅绑定 127.0.0.1；JSON-RPC 2.0，暴露 24 个工具 |
| 链接名改名 | `linkAgentRenames` | 链接名面板每行可改名 | 改的是实际建链目录名；**已存在的链接不会跟着改**，需撤销后重分配 |
| 厂商标注覆盖 | `linkAgentVendors` | 链接名面板「厂商」列 | 覆盖预设厂商，留空回退默认 |

## 七、还没搬过来的（后续可加）

原版功能已全部覆盖。以下三项**依赖窗口外壳**，已通过给宿主加接口的方式补上
（改动在 `js/host.js`、`js/plugin-sdk.js`、`js/shell.js`、`src/App.tsx`、`src/components/Sidebar.tsx` 与 `src-tauri/src/main.rs`），
不再是缺口：

1. **连锁动作快捷键** —— 应用级快捷键（窗口前台生效），宿主统一监听 keydown 后发总线事件。
   非操作系统全局热键：后者要引 `tauri-plugin-global-shortcut`，为免加依赖而没做。
2. **动作挂到左侧栏** —— 宿主新增 `addSidebarItem` / `removeSidebarItem`，插件卸载时自动清理。
   原生外壳与 React 外壳两侧都实现了渲染。
3. **软件自身图标** —— 新增 Rust 命令 `set_window_icon`（换窗口图标）。

以下属于**主窗口外壳**（nexus-panel 自身或已有 settings 插件），明确不在本插件范围：
窗口尺寸与栏宽、侧边栏、托盘与关闭行为、全屏任务栏、脑图相关、全局快捷键注册。

## 八、首次编译请注意

- **`set_window_icon` 需要 tauri 的 `image-ico` / `image-png` feature**（已在 `Cargo.toml` 打开）。
  它们会额外拉入 image 相关 crate，**首次构建需联网下载**。
  若不想换软件图标或构建时网络受限，删掉三处即可退回：
  ① `Cargo.toml` 里那两个 feature；② `src-tauri/src/main.rs` 的 `set_window_icon` 函数；
  ③ 同一文件 `invoke_handler!` 里的 `set_window_icon` 注册项。
- 本插件的 Rust 代码**在开发环境里从未真正编译过**（无 cargo 工具链），
  只做过结构核对、跨模块引用核对与逻辑复查。首次 `npm run tauri:dev` 请留意编译输出，
  重点看 `src-tauri/src/fpx/` 与新增的 `set_window_icon`。

## 九、注意

- 建链在 Windows 走 `mklink /J`，需要目标文件夹存在；同名位置若是**普通目录/文件**会整体拒绝，避免误删。
- 部分建链失败时，已成功的部分**仍会写入账本**，界面显示「部分」状态，不会留下"链接在、记录缺失"。
- ACL 保护开启后，建链 / 删链会自动临时摘锁再恢复（`LockGuard`），与 C# 版行为一致；其它外部程序操作受保护目录仍需先手动解除。
- 图标与标签色**必须一次保存**（`fpx_save_style`）：两者同写一份配置，分两次调用会因为各自基于旧草稿而互相覆盖。
- 吸管取色 / 截图在 Windows 走 **PowerShell + System.Drawing**（刻意不引 `windows-sys`：句柄类型在不同版本是 `isize` 或 `*mut c_void`，猜错就是硬编译错误）。代价是每次约 0.3~1 秒启动开销，已放到后台线程，不卡界面。
- 自定义常用色持久在 `config.customColors`，上限 24 个，去重保序。
- 「从页签移除」只动**当前页签**，不会连带清掉同一路径在别的页签里的登记。
- 内容树按 `kind + 相对路径` 建节点：agent 与 rule 存在同名文件时（如 `foo.md`）不会互相覆盖。
- 目录型 skill（含 `SKILL.md` 的目录）点击即读取内容；纯目录节点点击才是展开/折叠。
- **监听告警走拉取而非推送**：插件跑在 iframe 沙箱，宿主禁用了 `listenTauri`（见 `js/host.js`），Rust 侧 `app.emit` 到不了前端，所以事件堆在后端队列，由前端定时 `fpx_watch_poll` 取走。
- **链接名改名的键是预设原名**：后端 `display_name` 按原名查 `linkAgentRenames`；前端改名输入框写的是 `renames[原始名]`（界面上显示为「已改名」角标）。
- **内置图标走相对 URL，自定义图标走 data URI**：内置 .ico 随插件发布在 `preseticons/`，iframe 内 `./preseticons/<名>.ico` 可直接显示，不经后端；数据目录 `icons/` 里的图标是本地路径，沙箱访问不了，由 `fpx_icon_data` 转 data URI（按需加载 + 缓存）。
- **选用内置图标会固化一份到数据目录**：因为「同步到资源管理器」要写 desktop.ini，必须有真实文件；由前端 fetch 图标内容、后端 `fpx_save_icon_data` 落盘。
- 图标的 base64 编解码是手写的（`fpx/base64.rs`），带单元测试；曾与 Python 标准库逐长度对照（0~79 字节）确认一致。
- **「快速链接」默认关闭**：与原版一致。关闭时跨栏拖放会先弹确认——拖放比点按钮更容易误触，
  误建会在项目目录里凭空多出若干 junction。想直接建链就在「设置」里打开。
- **新建时是否带页签层级由设置项全局决定**，新建对话框里没有局部勾选：
  两处都控制会变成"都勾上才生效"的隐性双闸门，很难解释。对话框只显示当前会建在哪里。
- **保存设置时会等配置落盘再通知后端重算定时器**：自动备份线程是读磁盘上的配置，
  不等的话后端读到的是旧间隔，新设置要等下次保存才生效。
- **设置页与主视图是两个 iframe，改完必须通知**：设置面板由外壳以 `view='settings'`
  再开一份同样的页面，与主视图不共享内存。所以设置页保存后会 `emit('project-group:config-changed')`，
  主视图监听并重新 `bootstrap()`（连连锁动作清单一起重拉）。
  少了这一步就会出现"设置里改了、主界面还是旧数据"。
- **设置页保存前会重读一次配置再合并 patch**：与主视图相反（主视图用 `configRef`
  乐观推进是为了串起连续操作）。设置页是低频的，但主视图可能在这期间改过配置，
  拿自己加载时的旧 config 整份写回会把那些改动抹掉。
- **连锁快捷键是"应用级"而非系统全局**：窗口在前台时才响应，失焦不响应。
  设置框内直接按组合键即可录入（不用手打）。若与外壳自带的 ⌘/Ctrl+B（侧边栏）、
  ⌘/Ctrl+R（重载插件）冲突，会优先触发外壳的。
- **侧边栏动作作用于"当前选中的卡片"**：没选中任何卡片时会提示而非静默失败。
- **卡片快捷键走 `ctx.shortcut`，不自己挂 `window` 监听**：iframe 模式下 SDK 也是挂在插件自己的
  window 上（按焦点隔离），但它额外负责「插件卸载时注销」，自己写容易残留。`ctx.shortcut` 没写进
  `js/plugin-sdk.d.ts`，插件内补了最小签名，没去改宿主类型文件。
- **快捷键有两条让路规则**：焦点在 input / textarea / select 里时不触发（否则改名框里按 Delete
  会把卡片从页签里删掉）；有弹窗打开时整组不触发（避免改到看不见的卡片）。
- **"焦点栏"只决定卡片快捷键打在哪一栏**，与页签、选中项互不干涉：点哪一栏的卡片焦点就跟到哪一栏，
  也可用 Ctrl/⌘+←/→ 直接切。它不是持久状态，重进插件默认落在「项目」栏。
- **MCP 开关与进程启停是两件事**：「服务」面板管进程，「设置」里的总开关只管是否对外提供能力；
  关掉总开关后调用会被拒绝，改回即可恢复，无需重启进程。工具清单里关掉的工具**仍会列出**，
  否则一旦关掉就再也找不回来。
- **「转类别」（换栏）与「建链接」是两件事**：跨栏拖放卡片 = 建链接（分配），卡片仍留在原栏；
  右键「转为项目 / 转为项目组」= 换栏（对应原版 `MoveCardAcross`），此时才可能触发物理搬家。
- **物理搬家只用 `rename`**：跨卷时 rename 会失败，此时**整体中止换栏**，不做"复制+删除"——
  后者中途失败会留下两份残缺数据。宁可不动，也不要半完成。
  搬家的「默认根目录」就是新建预设父目录（`createProjectDir` / `createGroupDir`），
  两者都未设置时自动跳过物理搬家，只换卡片归属，不报错。
- **换栏若触发物理搬家，指向该文件夹的链接会断**：比如把某个项目组搬到别处，
  那些项目里指向它旧路径的 junction 就会失效（卡片上「未链接」徽标会亮起，
  完整状态见数据目录 `config.json` 的 `links`）。
  搬家前请在该项目卡片上右键「撤销链接」，搬完再重新拖放分配。
  带链接的卡片换栏后，链接记录本身也不会自动清理（原版同样如此）。
- **左栏「搬家」只支持同一磁盘分区**：与 C# 版 `Directory.Move` 语义一致，跨盘直接报错拒绝。
  这不是偷懒——项目目录里满是 junction（本插件的核心产物），
  递归"复制+删除"必然跳过链接点，搬完链接全丢且毫无提示。
  宁可明确拒绝，也不制造静默的数据损失。跨盘请自行复制后再在这里重新登记。
- **卡片上的项目组名来自「链接记录」，不是扫磁盘**：后端 `linked_group` 取的是
  `config.json` 里 `links` 的 `group` 字段。若记录缺失（手改过 config、从别处迁移、
  或链接是外部程序建的），卡片就显示不出组名 —— 即使磁盘上的 junction 其实是好的。
  此时点它会提示"链接记录里没有这一条"。
  WPF 原版对此有兜底：记录找不到时会扫磁盘上 junction 的真实目标反查组名
  （`ScanProjectCard` 里 `scanned.Target` 那段）。本版**尚未移植**这个兜底，
  需要时可在后端 `build_card` 里补（读 junction target → 取末级目录名）。
- **项目组搬家会自动重建链接，项目搬家不会**：项目组是所有链接的目标，
  它一挪，指向旧路径的 junction 全断，所以后端会按链接记录逐个 remove + create；
  失败的项目清单会打进日志（标红），不会静默吞掉。
  项目搬家则无需重建——junction 是它自己的子项，随目录一起挪走。
- **「改名」与「搬家」是两个入口，不要合并**：改名会拒绝带路径分隔符的名字，
  正是为了不让它悄悄退化成搬家。两者后端也是两条命令。

## 配置写入的并发保护

`config.json` 有多个写入者：前端命令、MCP server 线程、自动备份定时器。
它们都在**同一个进程内**，所以用进程内 `Mutex` 即可，**不需要 OS 文件锁（flock）**——
后者只在多进程写同一文件时才必要。

关键不是"加锁写文件"，而是把**整个 load-modify-save 放进一个临界区**（`store::with_config`）。
只在 save 时加锁挡不住过期快照覆盖：

```
A: cfg = load()          // 读到版本 1
B: load → 改 → save()    // 版本 2 落盘
A: 基于版本 1 改完 save()  // 版本 3 —— B 的改动被整份覆盖
```

约定：

- **纯配置修改** → 整体包进 `with_config`，闭包返回 `Err` 时不落盘
- **耗时操作（备份整树遍历、枚举编辑器）** → 一律放锁外；
  写配置时**重新 load** 而不是复用几秒前那份，且只改自己关心的字段
- **不要在 `with_config` 闭包内调用任何会写配置的函数** —— `Mutex` 非重入，会死锁

## MCP 工具（24 个）

分两类。**基础能力**：

| 工具 | 说明 |
|---|---|
| `list_projects` / `list_groups` | 列出项目 / 项目组页签与卡片 |
| `list_links` | 全部链接记录及状态（界面不展示表格，要查明细走这里或 `config.json`） |
| `create_link` / `remove_link` | 建立 / 撤销分配 |
| `scan_content` / `read_file` | 扫 agent / skill / rule、读文件 |
| `create_folder` / `add_card` | 新建文件夹、加入页签 |
| `set_lock` / `set_tag_color` | ACL 保护、卡片标签色 |
| `backup` | 一键备份 |

**与原版对齐的补全项**：

| 工具 | 说明 |
|---|---|
| `get_manual` | 工具能力总览（表格由 `tools()` 推导，与 `tools/list` 永远一致，不会脱节） |
| `get_status` | 数据目录、项目/项目组清单、链接数、当前选择 |
| `select_folder` | 指定当前操作对象；其后多数工具可省略 `target` |
| `get_selection` | 获取当前操作对象及其内容 |
| `deploy_skill` | 部署 skill：有 AI 命令则写请求文件并拉起，否则本地生成 `SKILL.md` 骨架（同名自动加序号，永不覆盖） |
| `lock_status` | 查询 ACL 保护状态 |
| `folder_icon_set` / `_get` / `_restore` | 文件夹图标的设置 / 查询 / 恢复 |
| `capture_screen` | 截全屏 |
| `list_windows` / `capture_window` | 列举可见窗口 / 按标题截单个窗口（仅 Windows，其它平台明确报不支持而非静默退化为全屏） |

## 命令行模式

`--self-check` / `--migrate-*` 由 `cli.rs` 在 Tauri 启动**之前**处理，不创建窗口：

```bash
nexus-panel --self-check <config> <record> <outDir>   # 数据层自检，报告写入 outDir
nexus-panel --migrate-hierarchy [config] [record]      # 项目搬到「新建项目父目录\页签名\名称」
nexus-panel --migrate-groups-hierarchy [config] [record]  # 项目组同上，搬完重建指向它的链接
```

`--mcp [port]` **不在这里**——它由 `main.rs` 在 Tauri `Builder` 的 `setup` 里处理
（关掉主窗口后再 `serve()`）。也就是说它仍然加载了完整的 Tauri 栈，
只是不显示窗口。若将来要加 stdio 模式，必须把它挪到 `main()` 最前面、
在 `Builder` 之前处理：Tauri 自己会往 stdout 打东西，
而 stdio 模式要求 stdout 只能输出 JSON-RPC。

自检全程只写输出目录，不碰真实数据，可随时跑；报告含 `[FAIL]` 时退出码为 1，便于脚本判断。

迁移要点：只在同一卷内 `rename`（跨卷会失败，硬搬可能留半截数据）；跳过已在目标位置与同名冲突的项；图标 / 标签色 / ACL 锁的键会跟着换；项目组搬走后逐个重建指向它的 junction。

> `--appicon-apply`（给 exe 文件本身换图标）未移植：它需要改写 PE 资源区并重启，风险与收益不成正比。运行时换窗口图标请用 `set_window_icon`。

## 三处后台线程：改之前请先读

`watch.rs`（目录监听）、`backup.rs`（自动备份）、`mcp.rs`（MCP server）都是常驻线程，
共用一套**「标志位 + 代次号」**约定，看着简单，但踩过坑：

- 只用一个 `AtomicBool` 标志**不够**：`stop()` 置标志后，线程要等本次 sleep / accept 走完才检查得到。
  那段窗口里如果又 `start()`，老线程醒来发现标志又是 true 就会继续跑 —— **两个线程同时干活**。
  所以每次 start 领一个新的代次号（`GEN` / `AUTO_GEN`），老线程发现代次变了自行退出。
- 反过来，若保留「已在运行就直接 return」，stop→start 快速切换时会**拒绝启动、彻底没人干活**。
  现在 start 一律领代次并起新线程，由代次去挤掉老的。
- 线程退出时只在**自己仍是最新代次**时才清标志，否则会把刚启动的新线程状态误清掉。
- MCP 另有一处：`TcpListener::incoming()` 是阻塞的，不换掉它线程永远卡在 accept、
  **旧端口一直被占**。已改成 `set_nonblocking(true)` + 100ms 轮询，stop 后 100ms 内释放端口。

## 字符串截断必须过 safe_truncate_at

`String::truncate(n)` 与 `&s[..n]` 在 n 不在 UTF-8 字符边界时**直接 panic**。
中文每字 3 字节，按字节数截断几乎必然命中（文件预览、`deploy_skill` 生成目录名都踩过）。
新增 `store::safe_truncate_at(s, max)` 会退到最近的合法边界，**任何按字节截断的地方都要先过它**。

## 复制文本走后端

插件跑在沙箱 iframe 里，外壳给的 sandbox 不含 `allow-clipboard-write`，
`navigator.clipboard` 会**静默失败**（点了完全没反应也不报错）。
所以新增 `fpx_copy_text` 走后端系统剪贴板；前端保留三级兜底：后端 → Clipboard API → `execCommand`。

