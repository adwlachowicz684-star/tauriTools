//! Junction / 符号链接操作
//! ------------------------------------------------------------------
//! Windows 用系统 mklink /J（无需管理员、不要求开发者模式，与原 C# 版语义一致）；
//! 其它平台退化为目录符号链接。

use std::fs;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;

use super::model::{FpxConfig, PresetAgent};
#[cfg(windows)]
use crate::fpx::safety::safe_cmd_arg;

/// 各家 AI agent 在项目根目录下默认存放 agent/skill 的目录名（与 C# 版 LinkAgentCatalog 对齐）。
pub const PRESET_AGENTS: &[(&str, &str)] = &[
    (".opencode", "OpenCode"),
    (".codex", "OpenAI Codex"),
    (".agents", "Agents"),
    (".claude", "Claude Code"),
    (".gemini", "Gemini"),
    (".cursor", "Cursor"),
    (".windsurf", "Windsurf"),
    (".github", "GitHub Copilot"),
    (".kiro", "Kiro"),
    (".aider", "Aider"),
    (".cline", "Cline"),
    (".roo", "Roo Code"),
    (".kilocode", "Kilo Code"),
    (".trae", "TRAE"),
    (".qwen", "Qwen Code"),
    (".agent", "Agent"),
];

/// 预设名 → 实际使用的链接目录名（应用 config.linkAgentRenames 覆盖；空值视为未改名）。
pub fn display_name(cfg: &FpxConfig, preset: &str) -> String {
    match cfg.link_agent_renames.get(preset) {
        Some(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ => preset.to_string(),
    }
}

/// 厂商标注：先看「改名后的新名」上的覆盖，再看「预设原名」上的覆盖，最后用预设默认值。
/// 两级都查是因为改名时厂商键理论上会迁移到新名，但旧配置可能还留着原名键。
pub fn vendor_of(cfg: &FpxConfig, preset: &str) -> String {
    let shown = display_name(cfg, preset);
    for k in [shown.as_str(), preset] {
        if let Some(v) = cfg.link_agent_vendors.get(k) {
            if !v.trim().is_empty() { return v.trim().to_string(); }
        }
    }
    PRESET_AGENTS
        .iter()
        .find(|(n, _)| *n == preset)
        .map(|(_, v)| (*v).to_string())
        .unwrap_or_default()
}

/// 置顶项的名次：在 config.linkAgentsPinned 里的下标；不在则返回 None。
/// 用位置而非布尔，才能让多个置顶项按用户设定的次序排列。
fn pin_rank(cfg: &FpxConfig, name: &str) -> Option<usize> {
    cfg.link_agents_pinned
        .iter()
        .position(|p| p == name)
}

/// 稳定排序：置顶项按 pinned 列表的次序排到最前，其余保持原有相对顺序。
/// 稳定是刻意的——没置顶的项不该因为别人置顶而乱序。
pub fn sort_pinned(cfg: &FpxConfig, names: &mut Vec<String>) {
    // 记录原始下标作为稳定排序的次级键（sort_by 本身稳定，这里用 enumerate 更直白）
    let mut indexed: Vec<(usize, String)> = std::mem::take(names).into_iter().enumerate().collect();
    indexed.sort_by(|(ia, a), (ib, b)| {
        match (pin_rank(cfg, a), pin_rank(cfg, b)) {
            (Some(pa), Some(pb)) => pa.cmp(&pb).then(ia.cmp(ib)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => ia.cmp(ib),
        }
    });
    *names = indexed.into_iter().map(|(_, n)| n).collect();
}

/// 预设列表（展示用）：name 已应用重命名，vendor 已应用覆盖，original 保留预设固有键；
/// 顺序上置顶项在前（按 config.linkAgentsPinned）。
pub fn preset_list_of(cfg: &FpxConfig) -> Vec<PresetAgent> {
    let mut out: Vec<PresetAgent> = PRESET_AGENTS
        .iter()
        .map(|(n, _)| PresetAgent {
            name: display_name(cfg, n),
            original: (*n).to_string(),
            vendor: vendor_of(cfg, n),
        })
        .collect();
    // 置顶键用的是「改名后的显示名」，与前端一致
    out.sort_by_key(|p| pin_rank(cfg, &p.name).unwrap_or(usize::MAX));
    // sort_by_key 稳定，未置顶的项保持预设原序；但置顶项之间也要按 pinned 次序，
    // 上面这行已用 pin_rank 覆盖，故无需再排一次
    out
}

/// 供前端用的「全部链接名（预设显示名 + 自定义）」，已按置顶排序。
pub fn all_names(cfg: &FpxConfig) -> Vec<String> {
    let mut names: Vec<String> = PRESET_AGENTS
        .iter()
        .map(|(n, _)| display_name(cfg, n))
        .collect();
    names.extend(custom_names(cfg));
    sort_pinned(cfg, &mut names);
    names
}

/// config 中启用的链接名（预设 + 自定义；缺失视为开启）。
/// 预设名会先经过 linkAgentRenames 映射——开关状态也以**改名后的名字**为键，
/// 与原 C# 版「改名后开关/备注/厂商键随新名迁移」一致。
pub fn enabled_names(cfg: &FpxConfig) -> Vec<String> {
    let custom = custom_names(cfg);
    let mut names: Vec<String> = PRESET_AGENTS
        .iter()
        .map(|(n, _)| display_name(cfg, n))
        .filter(|n| cfg.link_agents.get(n).copied().unwrap_or(true))
        .collect();
    for n in custom {
        if !cfg.link_agents.get(&n).copied().unwrap_or(true) { continue; }
        // 与已收录的名字（含改名后的预设显示名）大小写不敏感去重
        if names.iter().any(|x| x.eq_ignore_ascii_case(&n)) { continue; }
        names.push(n);
    }
    names
}

/// 用户自定义链接名（去重、剔除与预设重复项）。
pub fn custom_names(cfg: &FpxConfig) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in &cfg.custom_link_agents {
        let n = n.trim();
        if n.is_empty() { continue; }
        /* #91 都改成大小写不敏感：Windows 文件系统本身不敏感，
           `.OpenCode` 与 `.opencode` 是同一个目录。
           精确比较会放过前者，于是两个链接名指向同一个 junction，
           创建时后一个覆盖前一个，其中一个必然失效 ——
           且界面上两个名字都在、都显示"已启用"，没有任何报错。 */
        if PRESET_AGENTS.iter().any(|(p, _)| (*p).eq_ignore_ascii_case(n)) { continue; }
        if out.iter().any(|x| x.eq_ignore_ascii_case(n)) { continue; }
        out.push(n.to_string());
    }
    out
}

/// 校验 / 规范化用户输入的链接名：去空白、补前导点、剔除非法字符。非法返回 None。
pub fn normalize_name(raw: &str, prepend_dot: bool) -> Option<String> {
    let mut name = raw.trim().to_string();
    if name.is_empty() { return None; }
    if prepend_dot && !name.starts_with('.') { name.insert(0, '.'); }
    if !prepend_dot && name.starts_with('.') { name = name.trim_start_matches('.').to_string(); }
    if name.is_empty() || name.trim_start_matches('.').is_empty() { return None; }
    if name.contains('/') || name.contains('\\') { return None; }
    if name.chars().any(|c| matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')) { return None; }
    Some(name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Valid,
    Conflict,
    Broken,
}

/// 某项目下指定链接名的完整路径。
pub fn link_path(project: &str, name: &str) -> PathBuf {
    Path::new(project.trim_end_matches(|c| c == '\\' || c == '/')).join(name)
}

/// 是否为链接（junction / 目录符号链接）。
pub fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// 三态判定：
///   - 是链接且目标存在     → Valid
///   - 是链接但目标已丢失   → Broken（断链）
///   - 存在但不是链接       → Conflict（普通目录/文件占位）
///   - 完全没有             → Broken
pub fn link_state(project: &str, name: &str) -> LinkState {
    let lp = link_path(project, name);
    if is_link(&lp) {
        return if lp.exists() { LinkState::Valid } else { LinkState::Broken };
    }
    if lp.exists() {
        LinkState::Conflict
    } else {
        LinkState::Broken
    }
}

/// 链接指向的目标（非链接或解析失败返回 None）。
pub fn resolve_target(link: &Path) -> Option<String> {
    fs::read_link(link).ok().map(|p| p.to_string_lossy().to_string())
}

/// 在 project 下为每个 name 创建指向 group 的链接，返回实际创建的链接路径。
pub fn create(project: &str, group: &str, names: &[String]) -> Result<Vec<String>, String> {
    if !Path::new(project).is_dir() {
        return Err(format!("项目文件夹不存在: {project}"));
    }
    if !Path::new(group).is_dir() {
        return Err(format!("项目组文件夹不存在: {group}"));
    }
    if names.is_empty() {
        return Err("未启用任何 agent 链接名（请在「链接名」里勾选）".to_string());
    }

    // 冲突预检：任一启用名被普通目录/文件占用则整体拒绝，避免部分建成 + 误删内容
    for n in names {
        if link_state(project, n) == LinkState::Conflict {
            return Err(format!(
                "{} 已存在且不是链接（普通目录/文件），请手动处理",
                link_path(project, n).display()
            ));
        }
    }

    let mut created_paths: Vec<String> = Vec::new();
    for n in names {
        let lp = link_path(project, n);
        create_one(&lp, group).map_err(|e| {
            format!(
                "已创建 {}/{} 个链接后失败（成功部分已记录）: {e}",
                created_paths.len(),
                names.len()
            )
        })?;
        created_paths.push(lp.to_string_lossy().to_string());
    }
    Ok(created_paths)
}

fn create_one(link: &Path, target: &str) -> Result<(), String> {
    if is_link(link) {
        remove_one(link)?;
    } else if link.exists() {
        return Err(format!("{} 已存在且不是链接，为避免误删内容已中止", link.display()));
    }
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).ok();
    }

    #[cfg(windows)]
    {
        // 尾反斜杠会转义收尾引号导致 mklink 解析失败，必须去掉
        let t = target.trim_end_matches(|c| c == '\\' || c == '/');
        // 链接名与目标都来自配置/用户选择，且要经过 `cmd /c` 的二次解析：
        // 路径里若带引号、%、& 之类，会在 mklink 之外多出一条命令。
        // 挡住比"建成但可能被注入"重要 —— 这类路径本就不该出现在项目树里。
        let link_s = link.to_string_lossy().to_string();
        if !safe_cmd_arg(&link_s) {
            return Err(format!("链接路径含特殊字符，已拒绝创建: {link_s}"));
        }
        if !safe_cmd_arg(t) {
            return Err(format!("目标路径含特殊字符，已拒绝创建: {t}"));
        }
        let out = Command::new("cmd")
            .args(["/c", "mklink", "/J", &link_s, t])
            .output()
            .map_err(|e| format!("无法启动 mklink: {e}"))?;
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr);
            let msg = if msg.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { msg };
            return Err(format!("mklink 失败: {}", msg.trim()));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link)
            .map_err(|e| format!("创建符号链接失败: {e}"))
    }
}

/// 删除某项目下的链接（仅链接，普通目录/文件拒绝）。
///
/// 判定用 `is_link` 而非 `link_state == Valid`：
/// 后者会漏掉 **Broken（链接在、目标已丢失）** 的情况，而那恰恰是最需要清理的场景 ——
/// 项目组被移走或删掉后链接就断在那儿，用户点「撤销链接」却删不掉，
/// 残骸永远留在项目目录里。只要是链接就删；Conflict（普通目录/文件）仍然拒绝，避免误删内容。
pub fn remove(project: &str, names: &[String]) -> Result<Vec<String>, String> {
    let mut removed: Vec<String> = Vec::new();
    for n in names {
        let lp = link_path(project, n);
        if is_link(&lp) {
            remove_one(&lp)?;
            removed.push(lp.to_string_lossy().to_string());
        }
    }
    Ok(removed)
}

fn remove_one(link: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        if is_link(link) {
            fs::remove_dir(link).map_err(|e| format!("删除链接失败: {e}"))?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if is_link(link) {
            fs::remove_file(link).map_err(|e| format!("删除符号链接失败: {e}"))?;
        }
        Ok(())
    }
}
