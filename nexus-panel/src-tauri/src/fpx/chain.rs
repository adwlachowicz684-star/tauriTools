//! Agent 连锁：把指令发给桌面 AI 客户端。
//! ------------------------------------------------------------------
//! 对齐 junction_link 的 Services/ChainClientCatalog.cs：
//!   - opencode / cursor 走深链接自动预填
//!   - vscode 走 `code <dir>` + `code chat <prompt>`
//!   - 其余（Trae 等无可靠外部预填路径）降级为「复制指令 + 唤起客户端 + 提示粘贴」
//! 只用 std::process + 系统剪贴板命令，无第三方依赖。

use std::path::PathBuf;
use std::process::Command;

use super::model::{ChainActionItem, CustomChainClient, FpxConfig};

/* ---------------------------- 内置连锁动作 ---------------------------- */
/*
 * 与 C# 版 AgentChainService 的默认模板对齐，占位符同时支持两套写法：
 *   {path} / {name}          —— 本插件的写法
 *   {项目路径} / {项目名称}   —— 原版写法，方便直接粘贴旧模板过来
 *   {工具根目录} / {工具路径} —— 原版指向 exe 所在目录；本插件是寄生在外壳里的，
 *                               语义上等价为数据目录（归档的 rules/ 就落在那儿）
 *   {工具文件名}
 */

/// 内置动作（id, 显示名, 图标）。
pub const BUILTIN: &[(&str, &str, &str)] = &[
    ("chain", "自由任务", "💬"),
    ("review", "一键审查", "🔍"),
    ("merge", "快速归并", "🗜"),
    ("deploy", "快速部署", "🚀"),
];

pub fn builtin_id(builtin: &str) -> bool {
    BUILTIN.iter().any(|(i, _, _)| *i == builtin)
}

/// 内置动作项目侧默认模板。
pub fn default_project(builtin: &str) -> &'static str {
    match builtin {
        "review" => DEFAULT_REVIEW_PROJECT,
        "merge" => DEFAULT_MERGE,
        "deploy" => DEFAULT_DEPLOY,
        _ => DEFAULT_CHAIN,
    }
}

/// 内置动作项目组侧默认模板（审查有专门的组结构版，其余与项目共用）。
pub fn default_group(builtin: &str) -> &'static str {
    match builtin {
        "review" => DEFAULT_REVIEW_GROUP,
        "merge" => DEFAULT_MERGE,
        "deploy" => DEFAULT_DEPLOY,
        _ => DEFAULT_CHAIN,
    }
}

const DEFAULT_CHAIN: &str = "请阅读并处理当前项目：{path}";

const DEFAULT_MERGE: &str = r#"【AI 快速归并任务】

你是一位文件系统与项目组织专家。请对下方指定对象执行冗余内容归并整理：

一、对象
- 名称：{项目名称}
- 路径：{项目路径}

二、工作流程
1. 通读目录结构，识别可归并的内容：重复文档、临时产物、历史版本残留、散落的同类文件；
2. 输出归并方案清单（合并项、目标位置、风险说明），等待用户确认后再动手；
3. 经确认后执行移动/合并，保持引用与链接有效；
4. 输出归并结果清单（移动了什么、到哪里、剩余建议）。

三、纪律约束
- 只处理明确冗余的内容；不确定项一律列入"待确认"区，禁止擅自删除任何文件；
- 移动前核对目标位置无同名冲突。

请现在开始，全程使用中文。
"#;

const DEFAULT_DEPLOY: &str = r#"【AI 快速部署任务】

你是一位构建与发布工程师。请对下方指定对象执行构建与部署验证：

一、对象
- 名称：{项目名称}
- 路径：{项目路径}

二、工作流程
1. 识别项目类型与构建体系（构建脚本/工程文件/依赖清单）；
2. 校验环境与依赖完整性，缺失项明确列出并给出补装命令；
3. 优先使用仓库自带脚本执行构建；失败时定位原因并给出具体修复建议；
4. 验证产物完整性与输出位置，汇报部署结果（产物路径、大小、校验方式）。

三、纪律约束
- 构建产物只写入项目约定的输出目录；
- 禁止修改任何源码；发现问题以报告形式输出，由用户决定是否修复。

请现在开始，全程使用中文。
"#;

const DEFAULT_REVIEW_PROJECT: &str = r#"【AI 全面代码审查任务】

你是一位资深软件架构师与代码审查专家。请对下方指定项目执行一次全面、深入、基于实际代码的审查。所有结论必须有据可查，禁止臆测；每个问题都必须附具体文件路径与行号作为证据。

一、审查对象
- 项目名称：{项目名称}
- 项目根目录：{项目路径}

二、工作流程（严格依次执行，缺一不可）
1. 通读项目整体结构：目录组织、程序入口、配置文件、依赖清单、样式与资源文件，建立全局认知；
2. 按模块逐一精读核心代码：追踪数据流、控制流与状态管理，标记可疑点；
3. 对每个可疑点回读上下文核实，排除误报；
4. 汇总全部发现，按第四节的统一格式输出报告；
5. 按第七节清单执行自我核查，修正报告后再定稿；
6. 定稿后按第八节要求将结果归档合并至 rules\代码审查.md，最后向用户同时呈现审查报告与归档结果。

三、审查范围（分六大组共 21 项，逐项检查不得跳过；不适用项须注明原因）

【A 组：架构与设计质量】
1. 架构分层与职责边界：分层是否清晰、模块职责是否单一、有无上帝类/超长方法、公共接口设计合理性；
2. 模块解耦与依赖治理：UI 层与业务逻辑是否严格分离；模块间是面向接口还是直接实例化具体实现；全局静态类/单例持有可变状态形成的隐式耦合；跨模块通信方式选用是否恰当；实测改动扩散度——指出哪些"改一处须动多处"的牵连点；
3. 可维护性：命名不规范、魔法数字、大段重复代码、注释与实现不符、圈复杂度过高、死代码残留；
4. 测试性：核心业务逻辑是否与 IO/UI 解耦而可单测、现有测试覆盖缺口、因强耦合导致无法测试的设计坏味道；
5. 扩展性与复用性：新增一类数据/一种操作需要改动多少处；可复用组件是否被复制粘贴式滥用；是否为未来扩展预留了合理的接缝而非过度设计。

【B 组：运行时正确性与健壮性】
6. 正确性与逻辑缺陷：边界条件、空引用、索引越界、类型转换溢出、浮点精度、分支遗漏、恒真恒假判断、状态机死锁或漏转移、幂等性破坏；
7. 异常处理：吞异常、catch 后状态未恢复、异常信息丢失原始上下文、该抛不抛导致的静默失败；
8. 资源管理：事件订阅未解绑、静态引用长期持有大对象等内存泄漏；句柄/流/连接等非托管资源未释放；IDisposable 实现是否符合标准模式；
9. 并发与线程安全：共享状态无保护访问、锁粒度不当与死锁风险、async void 误用、同步阻塞死锁、UI 元素被后台线程访问、定时器重入；
10. 数据完整性与持久化：写入是否原子（防崩溃/断电产生半截文件）、多实例或多进程并发写同一文件的冲突处理、损坏数据的检测能力与降级恢复方案、数据格式版本升级迁移；
11. 生命周期健壮性：单实例互斥与重复启动处理、启动时数据加载失败的降级路径、退出前状态保存与未完成任务的提示、崩溃后的自动恢复能力（备份/草稿）、系统休眠唤醒与会话结束事件的响应。

【C 组：性能】
12. 性能：明显 O(n²) 及以上算法、循环内重复计算/重复 IO、大对象高频分配、启动耗时热点、主线程阻塞导致的 UI 卡顿、不必要的全量刷新。

【D 组：安全】
13. 安全性：路径拼接注入、外部输入未校验、硬编码密钥/口令、不安全反序列化、临时文件权限、越权目录访问。

【E 组：界面与体验】
14. 美术样式统一：颜色、字体、字号、图标尺寸、间距是否集中于统一的样式/资源文件并被引用——逐一清点散落的硬编码颜色值与内联样式；同类控件视觉规范一致性（圆角、描边、悬停/按下/禁用各状态）；明暗主题覆盖完整性，列出因写死颜色导致主题切换失效的具体位置；图像资源规格与图标风格统一性；动画时长与缓动曲线是否成体系；整体布局的对齐网格与留白节奏一致性；
15. 用户体验一致性：操作无反馈、报错信息用户不可读、界面显示状态与真实数据状态不同步、窗口关闭/最小化时的状态保存；
16. 国际化与本地化：硬编码文案清单、字符串拼接破坏语序、日期/数字/货币格式的区域差异处理；
17. 无障碍与易用性：控件缺少自动化标识、纯键盘无法完成的操作、焦点顺序混乱、文字与背景对比度不足、仅靠颜色传达关键信息。

【F 组：工程与生态】
18. 配置与依赖：依赖版本冲突或已知漏洞版本、配置缺省值兜底缺失、环境差异（开发/发布）处理；
19. 兼容性：目标运行时差异、字符编码、路径分隔符、超长路径、只读目录/权限不足场景；
20. 日志与可观测性：关键操作与失败路径是否有日志、日志级别使用是否恰当、仅凭日志能否定位一次故障；
21. 文档与许可合规：README/帮助文档与实际功能是否一致；第三方依赖的许可证类型与本项目分发方式是否冲突；内置素材的版权来源是否可靠。

四、单个问题的输出格式（每条均按此五段式）
- 【严重度】阻断 / 严重 / 一般 / 建议（四级）
- 【位置】文件路径 + 行号（或方法名/资源键名）
- 【问题】一句话描述缺陷本身
- 【影响】可能引发的后果：崩溃 / 数据丢失 / 数据错乱 / 性能劣化 / 安全风险 / 维护成本 / 视觉不一致
- 【建议】具体可执行的修复方案；关键修复须给出修改前后的代码片段对照

五、总结要求（报告末尾必附）
1. 问题统计表：四个严重度各自的数量与合计，并按 A~F 六组给出问题分布；
2. 项目健康度总评：百分制打分，并列出扣分主因；
3. 优先修复清单：按"先阻断后严重"排出 Top 5，每项注明预估工作量（小/中/大）与修复收益；
4. 结构性改进专区：解耦改造方案、样式资源统一抽取计划等超出单点修复的重构建议单独列出（含实施步骤与风险评估），不与普通缺陷混排。

六、纪律约束
- 只报告经你回读代码核实的问题；把握不足的单独归入"待确认"区，并写明验证方法；
- 聚焦真实风险，不为凑数罗列纯风格类的吹毛求疵；
- 第三节 A~F 六大组 21 项每一项在报告中都应有对应结论（发现问题 / 无问题 / 不适用），确保覆盖闭环。

七、自我核查（报告初稿完成后强制执行，逐项核对并在报告中附上核查结论）
1. 覆盖闭环核查：第三节 21 个审查范围逐一对表，确认每项都有明确结论，无遗漏项；
2. 证据真实性核查：抽查全部"阻断/严重"级问题的【位置】，确认文件与行号真实存在、代码内容确如描述；
3. 误报复核：对全部"阻断/严重"级结论逐一回读代码二次推演，站不住脚的降级或移入"待确认"区，并说明理由；
4. 漏检自查：针对程序入口、持久化读写、异常处理三类高危区域及样式/资源文件再做一轮快速定向扫描，确认没有明显问题被漏掉；
5. 一致性核查：统计表数量 = 正文问题条目数；六组分布与正文归属一致；Top 5 清单与严重度排序一致；健康度扣分主因与严重问题对应；
6. 可行性核查：每条【建议】均具体可执行，无"建议优化""建议重构"之类空泛表述。
核查结束后在报告末尾输出《自我核查清单》：上述 6 项逐项标注 通过 / 修正（注明修正了什么），未通过项必须先修正再定稿。

八、结果归档（自我核查通过后执行）
- 归档目标：{工具根目录}\rules\代码审查.md（文件不存在时自动创建，创建时初始化标题、说明与索引表头）；
- 合并策略：先读取现有文件内容，将本次审查结果以"追加合并"方式写入，严禁覆盖或清空历史记录；
- 去重规则：若历史记录中已存在同一文件同一位置的同类问题，不新增条目，仅在该条目上更新最近发现日期与状态；
- 条目格式：`| 发现日期 | 项目名 | 严重度 | 所属组别 | 位置 | 问题摘要 | 状态(待修复/已修复/已忽略) |`；
- 头部索引：文件顶部维护历次审查索引表——每次归档追加一行：审查日期、项目名称、健康度得分、四档问题计数；
- 写入安全：采用原子方式写入（先写同目录临时文件，成功后再替换原文件），防止中断导致既有档案损坏；
- 归档完成后向用户报告：本次新增/更新的条目数，以及归档文件的完整路径。

请现在开始，全程使用中文。
"#;

const DEFAULT_REVIEW_GROUP: &str = r#"【AI 项目组结构审查任务】

你是一位资深软件架构师。请对下方指定项目组执行组织结构与命名规范的审查，所有结论必须有据可查。

一、审查对象
- 项目组名称：{项目名称}
- 项目组根目录：{项目路径}

二、工作流程
1. 通读项目组目录，识别下属全部子项目及其用途；
2. 检查各子项目的组织关系、层级深度与命名一致性；
3. 检查项目组级公共资源（文档、脚本、配置）的存放位置是否合理；
4. 输出审查报告，每个发现按【严重度】【位置】【问题】【影响】【建议】五段式呈现，末尾附问题统计与健康度评分。

请现在开始，全程使用中文。
"#;

/// 可接收连锁指令的桌面 AI 客户端定义。
pub const CLIENTS: &[(&str, &str, &str)] = &[
    ("opencode", "opencode", "opencode"),
    ("trae", "Trae", "trae"),
    ("trae-cn", "Trae-CN", "trae-cn"),
    ("cursor", "Cursor", "cursor"),
    ("vscode", "Visual Studio Code", "vscode"),
    ("chatgpt", "ChatGPT", "codex"),
    ("claude", "Claude", "claude"),
    ("windsurf", "Windsurf", "windsurf"),
    ("kimi", "Kimi", "kimi"),
];

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainClient {
    pub id: String,
    pub name: String,
    pub installed: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainSendResult {
    pub ok: bool,
    pub client: String,
    /// true = 指令已复制，需用户手工粘贴
    pub needs_paste: bool,
    pub message: String,
}

fn find_command(name: &str) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|v| std::env::split_paths(&v).collect()).unwrap_or_default();
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").map(|v| v.split(';').map(|s| s.to_string()).collect()).unwrap_or_default()
    } else { vec![] };

    for dir in dirs {
        let direct = dir.join(name);
        if direct.is_file() { return Some(direct); }
        for ext in &exts {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() { return Some(p); }
        }
    }
    None
}

/// Windows：URL scheme 是否注册（HKCU/HKLM 的 Software\Classes\<scheme> 都查，
/// 商店应用与每用户安装只注册在 HKCU，只查 HKLM 会漏检）。
#[cfg(windows)]
fn has_scheme(scheme: &str) -> bool {
    if scheme.is_empty() { return false; }
    ["HKCU", "HKLM", "HKCR"].iter().any(|root| {
        std::process::Command::new("reg")
            .args(["query", &format!(r"{root}\Software\Classes\{scheme}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

#[cfg(target_os = "macos")]
fn has_scheme(scheme: &str) -> bool {
    // macOS 无注册表：用 LSGetApplicationForURL 等价的 `open -Ra` 探测能否处理该 scheme
    !scheme.is_empty() && std::process::Command::new("open")
        .args(["-Ra", &format!("{scheme}://")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn has_scheme(scheme: &str) -> bool {
    // Linux：xdg-settings 不可靠，退化为「命令存在即认为可用」
    !scheme.is_empty() && find_command(scheme).is_some()
}

fn vscode_exe() -> Option<PathBuf> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(local).join("Programs").join("Microsoft VS Code").join("Code.exe");
        if p.is_file() { return Some(p); }
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        let p = PathBuf::from(pf).join("Microsoft VS Code").join("Code.exe");
        if p.is_file() { return Some(p); }
    }
    find_command("code").or_else(|| find_command("code.cmd"))
}

pub fn installed(id: &str) -> bool {
    match id {
        "vscode" => vscode_exe().is_some(),
        other => CLIENTS.iter()
            .find(|(i, _, _)| *i == other)
            .map(|(_, _, s)| has_scheme(s))
            .unwrap_or(false),
    }
}

/// 检测已安装客户端，并附上用户手动添加的自定义客户端（后者强制显示）。
/// 一个都没检出时回退 opencode（原版同样处理）。
pub fn detect(custom: &[super::model::CustomChainClient]) -> Vec<ChainClient> {
    let mut list: Vec<ChainClient> = CLIENTS.iter().map(|(id, name, _)| ChainClient {
        id: (*id).to_string(),
        name: (*name).to_string(),
        installed: installed(id),
    }).filter(|c| c.installed).collect();

    // 自定义客户端绕过自动检测强制列出，否则用户手动加的项永远看不见
    for c in custom {
        let id = c.id.trim();
        if id.is_empty() { continue; }
        if list.iter().any(|x| x.id == id) { continue; }
        list.push(ChainClient {
            id: id.to_string(),
            name: if c.name.trim().is_empty() { id.to_string() } else { c.name.trim().to_string() },
            installed: true,
        });
    }

    if list.is_empty() {
        list.push(ChainClient { id: "opencode".into(), name: "opencode".into(), installed: false });
    }
    list
}

/// 自定义客户端的exe（存在才返回）。
fn custom_exe(c: &super::model::CustomChainClient) -> Option<PathBuf> {
    let p = c.exe.as_deref().map(str::trim).unwrap_or("");
    if p.is_empty() { return None; }
    let pb = PathBuf::from(p);
    if pb.is_file() { Some(pb) } else { None }
}

/// 自定义客户端的 scheme。
fn custom_scheme(c: &super::model::CustomChainClient) -> &str {
    c.scheme.as_deref().map(str::trim).unwrap_or("")
}

/// 唤起 URL（各平台各自的 opener）。
fn open_url(url: &str) -> bool {
    if cfg!(windows) {
        Command::new("cmd").args(["/c", "start", "", url]).spawn().is_ok()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn().is_ok()
    } else {
        Command::new("xdg-open").arg(url).spawn().is_ok()
    }
}

fn run(exe: &PathBuf, args: &[&str]) -> bool {
    Command::new(exe).args(args).spawn().is_ok()
}

/// 写系统剪贴板（各平台自带命令；失败不阻断流程，由调用方提示用户手工复制）。
fn set_clipboard(text: &str) -> bool {
    if cfg!(windows) {
        use std::io::Write;
        match Command::new("cmd").args(["/c", "clip"]).stdin(std::process::Stdio::piped()).spawn() {
            Ok(mut child) => {
                if let Some(sin) = child.stdin.as_mut() {
                    let _ = sin.write_all(text.as_bytes());
                    let _ = sin.flush();
                }
                drop(child.stdin.take());
                child.wait().map(|s| s.success()).unwrap_or(false)
            }
            Err(_) => false,
        }
    } else if cfg!(target_os = "macos") {
        use std::io::Write;
        match Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn() {
            Ok(mut child) => {
                if let Some(sin) = child.stdin.as_mut() {
                    let _ = sin.write_all(text.as_bytes());
                    let _ = sin.flush();
                }
                drop(child.stdin.take());
                child.wait().map(|s| s.success()).unwrap_or(false)
            }
            Err(_) => false,
        }
    } else {
        use std::io::Write;
        // 优先 Wayland 的 wl-copy，其次 X11 的 xclip
        for prog in ["wl-copy", "xclip"] {
            if let Ok(mut child) = Command::new(prog)
                .args(if prog == &"xclip" { vec!["-selection", "clipboard"] } else { vec![] })
                .stdin(std::process::Stdio::piped()).spawn()
            {
                if let Some(sin) = child.stdin.as_mut() {
                    let _ = sin.write_all(text.as_bytes());
                    let _ = sin.flush();
                }
                drop(child.stdin.take());
                if child.wait().map(|s| s.success()).unwrap_or(false) { return true; }
            }
        }
        false
    }
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 降级路径：复制指令 + 尽力唤起客户端，提示用户粘贴。
fn paste_and_open(def: (&str, &str, &str), directory: &str, prompt: &str) -> ChainSendResult {
    let copied = set_clipboard(prompt);
    let mut opened = false;
    if let Some(cli) = find_command(def.0) {
        opened = run(&cli, &[directory]);
    }
    if !opened && !def.2.is_empty() {
        opened = open_url(&format!("{}://", def.2));
    }
    let tip = match (opened, copied) {
        (true, true) => format!("已在 {} 中打开。指令已复制到剪贴板，请粘贴到其对话框。", def.1),
        (true, false) => format!("已在 {} 中打开。请手动复制指令并粘贴。", def.1),
        (false, true) => format!("指令已复制到剪贴板，请粘贴到 {} 的对话框（未能自动打开）。", def.1),
        (false, false) => format!("未能自动打开 {}，也未写入剪贴板，请手动复制指令。", def.1),
    };
    // 只要"能粘贴"或"客户端被唤起"任一成立，这次发送就对用户有意义
    ChainSendResult {
        ok: copied || opened,
        client: def.1.to_string(),
        needs_paste: true,
        message: tip,
    }
}

fn def_of(id: &str) -> (&'static str, &'static str, &'static str) {
    CLIENTS.iter().find(|(i, _, _)| *i == id)
        .map(|(i, n, s)| (*i, *n, *s))
        .unwrap_or(("opencode", "opencode", "opencode"))
}

/// 发送连锁指令。占位符 {path} / {name} 由调用方替换后再传入。
/// custom 为用户手动添加的客户端（内置 id 匹配不上时按它发送）。
/// 按**命令行**直接发送（MCP 的 deploy_skill 用）。
///
/// 与 send() 的区别：send() 收的是客户端 id，从内置目录 / 自定义清单里查；
/// 这里收的是一条可直接执行的命令（可能是 exe 路径，也可能是带参数的命令行），
/// 原版 agent_cmd 就是这个语义。
pub fn send_command(cmd: &str, directory: &str, prompt: &str) -> ChainSendResult {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return ChainSendResult {
            ok: false,
            client: String::new(),
            needs_paste: false,
            message: "AI 客户端命令为空".into(),
        };
    }
    // 命令里可能带自己的参数，这里只补上工作目录
    let exe = std::path::PathBuf::from(cmd);
    let ok = run(&exe, &[directory]);
    let copied = if ok { set_clipboard(prompt) } else { false };
    ChainSendResult {
        ok,
        client: cmd.to_string(),
        needs_paste: ok,
        message: if !ok {
            format!("无法启动命令：{cmd}")
        } else if copied {
            format!("已在 {cmd} 中打开，指令已复制到剪贴板，请粘贴。")
        } else {
            format!("已在 {cmd} 中打开，请手动复制指令并粘贴。")
        },
    }
}

pub fn send(id: &str, directory: &str, prompt: &str, custom: &[super::model::CustomChainClient]) -> ChainSendResult {
    // 先查自定义客户端：它的 id 可能与内置不重合，且由用户显式登记，优先级更高
    if let Some(c) = custom.iter().find(|c| c.id.trim() == id) {
        let name = if c.name.trim().is_empty() { id.to_string() } else { c.name.trim().to_string() };
        // 优先用 exe 打开目录；exe 不可用则试 scheme
        if let Some(exe) = custom_exe(c) {
            if run(&exe, &[directory]) {
                let copied = set_clipboard(prompt);
                return ChainSendResult {
                    ok: true,
                    client: name,
                    needs_paste: true,
                    message: if copied {
                        format!("已在 {name} 中打开，指令已复制到剪贴板，请粘贴。")
                    } else {
                        format!("已在 {name} 中打开，请手动复制指令并粘贴。")
                    },
                };
            }
        }
        let scheme = custom_scheme(c);
        if !scheme.is_empty() && open_url(&format!("{scheme}://")) {
            let copied = set_clipboard(prompt);
            return ChainSendResult {
                ok: true,
                client: name,
                needs_paste: true,
                message: if copied {
                    format!("已唤起 {name}，指令已复制到剪贴板，请粘贴。")
                } else {
                    format!("已唤起 {name}，请手动复制指令并粘贴。")
                },
            };
        }
        // exe 与 scheme 都不可用：至少把指令放进剪贴板
        let copied = set_clipboard(prompt);
        return ChainSendResult {
            ok: copied,
            client: name,
            needs_paste: true,
            message: if copied {
                format!("未能打开 {name}，指令已复制到剪贴板，请粘贴。")
            } else {
                format!("未能打开 {name}，也未写入剪贴板，请检查其 exe / scheme 配置。")
            },
        };
    }

    let def = def_of(id);
    match id {
        "opencode" => {
            let url = format!(
                "opencode://new-session?directory={}&prompt={}",
                url_encode(directory), url_encode(prompt)
            );
            if open_url(&url) {
                ChainSendResult { ok: true, client: def.1.into(), needs_paste: false,
                    message: format!("已发送到 {}", def.1) }
            } else {
                ChainSendResult { ok: true, client: def.1.into(), needs_paste: true,
                    message: format!("{} 无法自动打开，指令已复制。", def.1) }
            }
        }
        "cursor" => {
            let url = format!("cursor://anysphere.cursor-deeplink/prompt?text={}", url_encode(prompt));
            if open_url(&url) {
                ChainSendResult { ok: true, client: def.1.into(), needs_paste: false,
                    message: format!("已发送到 {}", def.1) }
            } else {
                ChainSendResult { ok: true, client: def.1.into(), needs_paste: true,
                    message: format!("{} 无法自动打开，指令已复制。", def.1) }
            }
        }
        "vscode" => match vscode_exe() {
            Some(exe) if run(&exe, &[directory]) && run(&exe, &["chat", prompt]) => {
                ChainSendResult { ok: true, client: def.1.into(), needs_paste: false,
                    message: format!("已发送到 {}", def.1) }
            }
            _ => paste_and_open(def, directory, prompt),
        },
        _ => paste_and_open(def, directory, prompt),
    }
}

/// 把模板里的 {path} / {name} 替换掉。
pub fn fill_template(tpl: &str, path: &str) -> String {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    tpl.replace("{path}", path).replace("{name}", &name)
}

/// 替换全部占位符（含原版那套中文写法，方便直接粘贴旧模板）。
/// data_dir 用于 {工具根目录} / {工具路径} —— 原版指 exe 所在目录，本插件等价为数据目录。
pub fn fill_all(tpl: &str, path: &str, data_dir: &str) -> String {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    tpl
        .replace("{path}", path)
        .replace("{name}", &name)
        .replace("{项目路径}", path)
        .replace("{项目名称}", &name)
        .replace("{工具根目录}", data_dir)
        .replace("{工具路径}", data_dir)
        .replace("{工具文件名}", "nexus-panel")
}

/// 生成一个内置动作项。
fn builtin_item((id, name, icon): &(&str, &str, &str)) -> ChainActionItem {
    ChainActionItem {
        id: (*id).to_string(),
        name: (*name).to_string(),
        builtin: (*id).to_string(),
        icon: (*icon).to_string(),
        show_context_menu: true,
        show_sidebar: false,
        shortcut: None,
        project: None,
        group: None,
        client: None,
    }
}

/// 取动作清单；为 None（尚未迁移）时生成内置四项，
/// 并把旧的 chainPrompt 填进「自由任务」——老配置不丢。
pub fn ensure_actions(cfg: &mut FpxConfig) -> Vec<ChainActionItem> {
    let mut list = match cfg.chain_actions.clone() {
        Some(l) if !l.is_empty() => l,
        _ => {
            let mut v: Vec<ChainActionItem> = BUILTIN.iter().map(builtin_item).collect();
            // 迁移旧的单模板：填到「自由任务」的项目与项目组两侧
            if let Some(tpl) = cfg.chain_prompt.as_deref().map(str::trim) {
                if !tpl.is_empty() {
                    for it in v.iter_mut() {
                        if it.builtin == "chain" {
                            it.project = Some(tpl.to_string());
                            it.group = Some(tpl.to_string());
                        }
                    }
                }
            }
            v
        }
    };

    // 补上本次新增的内置项：老配置里没有 upgrade/deploy 之类时不用手改配置
    for b in BUILTIN {
        if !list.iter().any(|x| x.builtin == b.0) {
            list.push(builtin_item(b));
        }
    }

    list.retain(|x| !x.id.trim().is_empty());
    cfg.chain_actions = Some(list.clone());
    list
}

/// 按 id 找动作（清单里没有则返回 None，由调用方决定兜底）。
pub fn find<'a>(list: &'a [ChainActionItem], id: &str) -> Option<&'a ChainActionItem> {
    list.iter().find(|x| x.id == id)
}

/// 解析最终要发送的指令文本：
/// 自定义模板优先，留空则回退内置默认；自定义动作若两侧都空，返回空串（前端提示补写）。
pub fn resolve_prompt(item: &ChainActionItem, kind: &str, path: &str, data_dir: &str) -> String {
    let custom = if kind == "group" { item.group.as_deref() } else { item.project.as_deref() };
    let custom = custom.unwrap_or("").trim();
    let tpl = if !custom.is_empty() {
        custom
    } else if !item.builtin.is_empty() {
        if kind == "group" { default_group(&item.builtin) } else { default_project(&item.builtin) }
    } else {
        // 自定义动作且两侧模板都空：没有可发的内容
        return String::new();
    };
    fill_all(tpl, path, data_dir)
}

/// 动作使用的客户端：自己的 client 优先，其次全局默认，最后 opencode。
pub fn resolve_client(cfg: &FpxConfig, item: &ChainActionItem) -> String {
    let own = item.client.as_deref().map(str::trim).unwrap_or("");
    if !own.is_empty() { return own.to_string(); }
    let global = cfg.chain_client.as_deref().map(str::trim).unwrap_or("");
    if !global.is_empty() { return global.to_string(); }
    "opencode".to_string()
}

/// 默认指令模板（「自由任务」用）。
pub fn default_prompt() -> &'static str {
    DEFAULT_CHAIN
}
