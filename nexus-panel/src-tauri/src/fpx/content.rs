//! agent / skill / rule 内容浏览（与 C# 版 AgentSkillService 语义对齐）

use std::fs;
use std::path::{Path, PathBuf};

use super::model::ContentItem;

/// 各类资源的目录名（优先复数，其次单数）。
const AGENT_DIRS: [&str; 2] = ["agents", "agent"];
const SKILL_DIRS: [&str; 2] = ["skills", "skill"];
const RULE_DIRS: [&str; 2] = ["rules", "rule"];

fn pick_dir(root: &Path, names: &[&str; 2]) -> Option<PathBuf> {
    for n in names {
        let p = root.join(n);
        if p.is_dir() { return Some(p); }
    }
    None
}

fn rule_dirs(root: &Path) -> Vec<PathBuf> {
    RULE_DIRS.iter().map(|n| root.join(n)).filter(|p| p.is_dir()).collect()
}

fn rel(base: &Path, full: &Path) -> String {
    full.strip_prefix(base)
        .unwrap_or(full)
        .to_string_lossy()
        .replace('/', "\\")
}

/// 扫描某类资源。kind: agent | skill | rule | all
pub fn scan(root: &str, kind: &str) -> Vec<ContentItem> {
    let root = Path::new(root);
    if !root.is_dir() { return vec![]; }
    let mut out = Vec::new();
    let all = kind == "all" || kind.is_empty();
    if all || kind == "agent" { out.extend(scan_flat(root, "agent")); }
    if all || kind == "skill" { out.extend(scan_skills(root)); }
    if all || kind == "rule" { out.extend(scan_rules(root)); }
    out.sort_by(|a, b| a.rel_path.to_lowercase().cmp(&b.rel_path.to_lowercase()));
    out
}

/// agent：agent(s) 目录下递归所有 .md
fn scan_flat(root: &Path, kind: &str) -> Vec<ContentItem> {
    let mut out = Vec::new();
    let base = match pick_dir(root, if kind == "agent" { &AGENT_DIRS } else { &RULE_DIRS }) {
        Some(d) => d,
        None => return out,
    };
    collect_md(&base, &base, kind, "", &mut out);
    out
}

fn scan_rules(root: &Path) -> Vec<ContentItem> {
    let dirs = rule_dirs(root);
    let mut out = Vec::new();
    if dirs.is_empty() { return out; }
    let multi = dirs.len() > 1;
    for d in dirs {
        // rules 与 rule 并存时加目录名前缀，天然形成两个顶层分支
        let prefix = if multi {
            format!("{}\\", d.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default())
        } else {
            String::new()
        };
        collect_md(&d, &d, "rule", &prefix, &mut out);
    }
    out
}

fn collect_md(base: &Path, dir: &Path, kind: &str, prefix: &str, out: &mut Vec<ContentItem>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // 无权限等：静默跳过，避免整树失败
    };
    let mut sub: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            sub.push(p);
        } else if p.extension().map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false) {
            let rp = format!("{}{}", prefix, rel(base, &p));
            out.push(ContentItem {
                kind: kind.to_string(),
                name: strip_md(&rp),
                rel_path: rp,
                path: p.to_string_lossy().to_string(),
                is_dir: false,
            });
        }
    }
    for d in sub {
        collect_md(base, &d, kind, prefix, out);
    }
}

/// skill：根目录 .md（单文件 skill）+ 任意深度 SKILL.md 所在目录（目录型 skill）
fn scan_skills(root: &Path) -> Vec<ContentItem> {
    let mut out: Vec<ContentItem> = Vec::new();
    let base = match pick_dir(root, &SKILL_DIRS) {
        Some(d) => d,
        None => return out,
    };
    let mut seen: Vec<String> = Vec::new();

    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() { continue; }
            if !p.extension().map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false) { continue; }
            let rp = rel(&base, &p);
            if !seen.iter().any(|x| x.eq_ignore_ascii_case(&rp)) {
                seen.push(rp.clone());
                out.push(ContentItem {
                    kind: "skill".into(),
                    name: strip_md(&rp),
                    rel_path: rp,
                    path: p.to_string_lossy().to_string(),
                    is_dir: false,
                });
            }
        }
    }

    collect_skill_dirs(&base, &base, &mut seen, &mut out);
    out
}

fn collect_skill_dirs(base: &Path, dir: &Path, seen: &mut Vec<String>, out: &mut Vec<ContentItem>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut sub: Vec<PathBuf> = Vec::new();
    let mut has_skill_md = false;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            sub.push(p);
        } else if p.file_name().map(|n| n.eq_ignore_ascii_case("SKILL.md")).unwrap_or(false) {
            has_skill_md = true;
        }
    }
    if has_skill_md && dir != base {
        let rp = rel(base, dir);
        if !rp.is_empty() && !seen.iter().any(|x| x.eq_ignore_ascii_case(&rp)) {
            seen.push(rp.clone());
            out.push(ContentItem {
                kind: "skill".into(),
                name: rp.clone(),
                rel_path: rp,
                path: dir.to_string_lossy().to_string(),
                is_dir: true,
            });
        }
    }
    for d in sub {
        collect_skill_dirs(base, &d, seen, out);
    }
}

fn strip_md(rel: &str) -> String {
    if rel.to_lowercase().ends_with(".md") {
        rel[..rel.len() - 3].to_string()
    } else {
        rel.to_string()
    }
}

/// 读取文件文本（超长截断）。
pub fn read_preview(path: &str, max: usize) -> Result<String, String> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err(format!("不是文件或不存在: {path}"));
    }
    let mut text = fs::read_to_string(p).map_err(|e| format!("读取失败: {e}"))?;
    if text.len() > max {
        // 必须退到字符边界再截：String::truncate 在非边界上会 panic，
        // 中文文件按字节截断几乎必然命中。
        let end = super::store::safe_truncate_at(&text, max);
        text.truncate(end);
        text.push_str("\n\n…（内容过长，已截断）");
    }
    Ok(text)
}

/// 目录型 skill 的默认预览文件（SKILL.md）。
pub fn skill_md_of(dir: &str) -> Option<String> {
    let p = Path::new(dir).join("SKILL.md");
    if p.is_file() { Some(p.to_string_lossy().to_string()) } else { None }
}

/// 返回该目录下的 skill 存放位置（若存在 skill / skills 子目录或 SKILL.md 结构）。
/// 与原版 AgentSkillService.SkillDir 同义，供 MCP 的 deploy_skill 定位落点。
pub fn skill_dir_of(root: &str) -> Option<std::path::PathBuf> {
    let base = std::path::Path::new(root);
    if !base.is_dir() { return None; }
    for name in ["skill", "skills"] {
        let p = base.join(name);
        if p.is_dir() { return Some(p); }
    }
    None
}
