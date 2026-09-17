//! 路径收口：所有「来自调用方的路径」统一过这一道。
//! ------------------------------------------------------------------
//! 两件事，缺一不可：
//!
//!   1. **白名单** [`must_be_under`] —— 路径必须落在用户登记过的范围内；
//!   2. **黑名单** [`forbidden_root`] —— 系统目录 / 整块盘 / UNC 共享根，
//!      再怎么授权也不接受。用户在"选择目录"对话框里挑了什么，
//!      白名单随后就会把它加进去，只有这张表拦得住。
//!
//! 为什么要单独成模块：审查清单里的 4 条 P0 与多条 P1，**根因是同一个** ——
//! 每个命令各写一套（或干脆不写）路径校验，迟早漏一个（`fpx_read_file` 与
//! `af_fs_tail` 就是这么漏出来的）。所以这里只留一个实现，其它地方一律调它。
//!
//! 判定方法与 `af_flow::resolve_within` 完全一致（它被验证过是对的）：
//!   1. 相对路径按当前工作目录补全；
//!   2. `canonicalize()` 解析符号链接与 `..`（**不靠字符串前缀比较**）；
//!   3. 目标不存在时退化为「父目录 canonicalize + 文件名」——
//!      否则"新建文件"这种合法场景会被判成越权；
//!   4. `PathBuf::starts_with` 是**组件级**比较，`allowed` 与 `allowed_evil`
//!      不会被当成同一个前缀。
//!
//! 纯函数、不碰配置与 IO（除 canonicalize），便于单测 —— 见本文件末尾的测试。

use std::path::{Path, PathBuf};

/// 解析路径并断言它落在 `roots` 之内。
///
/// `roots` 必须是**已 canonicalize 过**的绝对路径：
/// Windows 上 canonicalize 的结果是 `\\?\C:\...`，若 root 没走同一条路，
/// `starts_with` 会永远为 false（表现为"全都越权"）。调用方用
/// [`canonical_root`] 构造即可保证一致。
///
/// 返回 canonicalize 后的路径：调用方拿它做后续 IO，
/// 能顺带消掉 `canonicalize → IO` 之间的 TOCTOU 窗口。
pub fn must_be_under(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".to_string());
    }
    if roots.is_empty() {
        return Err(
            "尚未授权任何目录，已拒绝本次操作。请先把要操作的目录加入授权列表。".to_string(),
        );
    }

    let p = Path::new(trimmed);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("无法读取当前工作目录: {e}"))?
            .join(p)
    };

    let canon = canonical_or_with_parent(&abs, trimmed)?;

    if !is_within(&canon, roots) {
        let allowed = roots
            .iter()
            .map(|r| r.display().to_string())
            .collect::<Vec<_>>()
            .join("\n  · ");
        return Err(format!(
            "路径越权，已拒绝：{}\n允许的范围：\n  · {}\n请先把所在目录加入授权列表。",
            canon.display(),
            allowed
        ));
    }
    Ok(canon)
}

/// canonicalize；失败时退化为「父目录 canonicalize + 文件名」。
///
/// 目的：让**尚不存在**的目标（write 新建 / copy 到新文件 / 建目录）也能校验，
/// 否则"新建"会整类绕过白名单。
fn canonical_or_with_parent(abs: &Path, raw: &str) -> Result<PathBuf, String> {
    abs.canonicalize().or_else(|_| {
        let parent = abs
            .parent()
            .ok_or_else(|| format!("路径缺少父目录，无法校验: {raw}"))?;
        let name = abs
            .file_name()
            .ok_or_else(|| format!("路径缺少文件名，无法校验: {raw}"))?;
        parent
            .canonicalize()
            .map(|c| c.join(name))
            .map_err(|e| format!("路径不存在且父目录无法解析: {raw}（{e}）"))
    })
}

/// 已 canonicalize 的路径是否落在任一 root 内（root 自身也算在内）。
pub fn is_within(canon: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|r| canon.starts_with(r))
}

/// 把一个可能是相对 / 带 `..` 的目录字符串规范成可作为 root 的绝对路径。
/// 不存在或无法解析时返回 `None`（调用方直接丢弃即可）。
pub fn canonical_root(raw: &str) -> Option<PathBuf> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    Path::new(t).canonicalize().ok()
}

/* ---------------------------- 危险根黑名单 ---------------------------- */

/// 即便显式授权也拒绝的根：把整块盘或系统目录放进来等于没约束。
///
/// **为什么不能只写一张 POSIX 风格的表**（原实现的问题）：
/// Windows 上 `canonicalize()` 出来是 `\\?\C:\Windows`，把分隔符换成 `/` 后
/// 变成 `//?/C:/Windows`，跟表里的 `/Windows` 对不上 —— 黑名单在主力平台上
/// 整条失效（清单 P1-4）。所以改成「先剥掉平台前缀，再按**路径组件**比对」，
/// 并且 Windows 与 POSIX 各用一张表（混在一张里，盘符会吃掉第一段的语义）。
pub fn forbidden_root(p: &Path) -> bool {
    // 拆不出来（空路径等）按"未知即拒绝"
    let Some((parts, is_unc)) = path_components(p) else { return true };
    if parts.is_empty() {
        return true; // 文件系统根（/ 或 C:\）
    }

    // 家目录根本身不放行（~/projects 这类具体子目录可以）。
    // 两个变量都看：Windows 一般只有 USERPROFILE，只查 HOME 会漏。
    for key in ["HOME", "USERPROFILE"] {
        if let Ok(home) = std::env::var(key) {
            if let Some((h, _)) = path_components(Path::new(&home)) {
                if !h.is_empty() && h == parts {
                    return true;
                }
            }
        }
    }

    // UNC 共享根（\\server\share）等于把别人的整块共享放进来
    if is_unc && parts.len() <= 2 {
        return true;
    }

    if parts[0].ends_with(':') {
        // 盘符后必须还有内容：只有盘符 = 整块盘
        if parts.len() < 2 {
            return true;
        }
        const WIN_DENY: &[&str] = &[
            "Windows",
            "Program Files",
            "Program Files (x86)",
            "ProgramData",
            "System Volume Information",
            "$Recycle.Bin",
        ];
        return WIN_DENY
            .iter()
            .any(|d| parts[1].eq_ignore_ascii_case(d));
    }

    const POSIX_DENY: &[&str] = &[
        "etc", "usr", "bin", "sbin", "boot", "proc", "sys", "dev",
        "lib", "lib64", "var", "System", "Library", "private",
    ];
    POSIX_DENY.iter().any(|d| parts[0] == *d)
}

/// 把路径拆成组件：先剥掉 Windows 的 `\\?\` / `\\.\` 与 UNC 前缀，再按分隔符切开。
/// 返回 `None` 表示拿不到可用形式，调用方一律按"拒绝"处理。
fn path_components(p: &Path) -> Option<(Vec<String>, bool)> {
    let raw = p.to_string_lossy().replace('\\', "/");
    if raw.trim().is_empty() {
        return None;
    }
    let mut s = raw.as_str();
    let mut is_unc = false;
    for pref in ["//?/", "//./"] {
        if let Some(rest) = s.strip_prefix(pref) {
            s = rest;
            break;
        }
    }
    if let Some(rest) = s.strip_prefix("UNC/") {
        s = rest;
        is_unc = true;
    }
    // POSIX 语义下的 //server/share 也是 UNC
    if s.starts_with("//") {
        s = &s[1..];
        is_unc = true;
    }
    let parts: Vec<String> = s.split('/').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
    Some((parts, is_unc))
}

/// 校验一个（已解析的）目录不在危险根上，否则返回可直接抛给前端的错误。
///
/// 与 `must_be_under` 的分工：白名单管"允不允许"，这张表管"再怎么授权也不行" ——
/// 两者都要有。用户可能在对话框里把 `C:\Windows` 选成新建落点，
/// 白名单到时候已经把它加进去了，只有这张表拦得住。
pub fn reject_forbidden(p: &Path) -> Result<(), String> {
    if forbidden_root(p) {
        return Err(format!(
            "已拒绝：{} 是系统目录或整块盘，不能作为操作目标（换一个具体的工作目录）",
            p.display()
        ));
    }
    Ok(())
}

/// 同上，但接受尚未存在的路径：先尽力 canonicalize，失败就按原样判定。
pub fn reject_forbidden_raw(raw: &str) -> Result<(), String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let p = Path::new(t);
    match p.canonicalize() {
        Ok(c) => reject_forbidden(&c),
        // 不存在时用父目录判定（新建场景），父目录也不存在就按字符串判
        Err(_) => match p.parent().and_then(|q| q.canonicalize().ok()) {
            Some(c) => reject_forbidden(&c),
            None => reject_forbidden(p),
        },
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 建一个本次测试专用的临时目录（进程内唯一，测完即删）。
    fn tmpdir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!("nexus_guard_{tag}_{}_{}", std::process::id(), nanos));
        fs::create_dir_all(&p).expect("建临时目录失败");
        p
    }

    /// Windows 上 canonicalize 会带 `\\?\` 前缀，root 与被测路径必须**同源**，
    /// 所以两侧都过 canonical_root / canonicalize。
    fn roots_of(dirs: &[PathBuf]) -> Vec<PathBuf> {
        dirs.iter().filter_map(|d| canonical_root(&d.to_string_lossy())).collect()
    }

    #[test]
    fn allows_path_within_root() {
        let base = tmpdir("ok");
        let roots = roots_of(&[base.clone()]);
        let inner = base.join("sub");
        fs::create_dir_all(&inner).unwrap();
        let got = must_be_under(&inner.to_string_lossy(), &roots).unwrap();
        assert!(is_within(&got, &roots));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_prefix_lookalike_sibling() {
        // allowed_evil 与 allowed 只差后缀：字符串前缀比较会放行，组件级比较必须拒绝
        let base = tmpdir("evil");
        let allowed = base.join("allowed");
        let evil = base.join("allowed_evil");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&evil).unwrap();
        let roots = roots_of(&[allowed]);
        assert!(must_be_under(&evil.to_string_lossy(), &roots).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_parent_traversal() {
        let base = tmpdir("dot");
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let roots = roots_of(&[allowed]);
        let attack = format!("{}/../outside", allowed.to_string_lossy());
        let r = must_be_under(&attack, &roots);
        assert!(r.is_err(), ".. 穿越居然放行了: {r:?}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn allows_nonexistent_child_of_allowed_parent() {
        // write / copy 到新文件是合法场景，不能因为文件不存在就判越权
        let base = tmpdir("new");
        let roots = roots_of(&[base.clone()]);
        let target = base.join("brand-new-file.txt");
        assert!(!target.exists());
        let got = must_be_under(&target.to_string_lossy(), &roots).unwrap();
        assert!(is_within(&got, &roots));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_empty_path_and_empty_roots() {
        let base = tmpdir("empty");
        assert!(must_be_under("   ", &roots_of(&[base.clone()])).is_err());
        assert!(must_be_under(&base.to_string_lossy(), &[]).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn constant_time_eq_basics() {
        assert!(crate::fpx::safety::constant_time_eq("abc", "abc"));
        assert!(!crate::fpx::safety::constant_time_eq("abc", "abd"));
        assert!(!crate::fpx::safety::constant_time_eq("abc", "abcd"));
        assert!(!crate::fpx::safety::constant_time_eq("", "a"));
        assert!(crate::fpx::safety::constant_time_eq("", ""));
    }

    /* ---- 危险根黑名单 ----
       这几条锁的是清单 P1-4：原实现用一张 POSIX 风格的 DENY 表做字符串前缀
       比较，Windows 上 canonicalize 带 `\\?\` 前缀，整条黑名单匹配不上。 */

    #[test]
    fn forbids_posix_system_roots() {
        for d in ["/etc", "/usr", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev",
                  "/lib", "/lib64", "/var", "/System", "/Library", "/private"] {
            assert!(forbidden_root(Path::new(d)), "{d} 应当被拒绝");
        }
        // 子目录同样拒绝：组件比对天然覆盖
        assert!(forbidden_root(Path::new("/etc/nginx")));
    }

    #[test]
    fn forbids_windows_system_roots_with_verbatim_prefix() {
        // 关键回归：canonicalize 在 Windows 上的真实形态
        assert!(forbidden_root(Path::new(r"\\?\C:\Windows")));
        assert!(forbidden_root(Path::new(r"\\?\C:\Program Files")));
        assert!(forbidden_root(Path::new(r"\\?\C:\Program Files (x86)")));
        assert!(forbidden_root(Path::new(r"\\?\C:\ProgramData")));
        // 没有 \\?\ 前缀时也要拦住
        assert!(forbidden_root(Path::new(r"C:\Windows")));
        // 大小写不敏感：盘符与目录名都可能被写成任意形式
        assert!(forbidden_root(Path::new(r"\\?\c:\windows")));
    }

    #[test]
    fn forbids_volume_roots_and_unc_share_roots() {
        assert!(forbidden_root(Path::new("/")));
        assert!(forbidden_root(Path::new(r"\\?\C:\")));
        assert!(forbidden_root(Path::new(r"\\?\C:")));
        assert!(forbidden_root(Path::new(r"\\?\UNC\server\share")));
    }

    #[test]
    fn allows_concrete_project_dirs() {
        assert!(!forbidden_root(Path::new("/home/me/projects")));
        assert!(!forbidden_root(Path::new("/Users/me/projects")));
        assert!(!forbidden_root(Path::new(r"\\?\C:\Users\me\projects")));
        assert!(!forbidden_root(Path::new(r"\\?\D:\work\proj")));
        // 名字里带 "Program" 但不是 Program Files
        assert!(!forbidden_root(Path::new(r"\\?\C:\Programs")));
    }

    #[test]
    fn components_strip_verbatim_and_unc() {
        let (p, unc) = path_components(Path::new(r"\\?\C:\a\b")).unwrap();
        assert_eq!(p, vec!["C:", "a", "b"]);
        assert!(!unc);
        let (p, unc) = path_components(Path::new(r"\\?\UNC\srv\share\x")).unwrap();
        assert_eq!(p, vec!["srv", "share", "x"]);
        assert!(unc);
    }

    #[test]
    fn reject_forbidden_raw_handles_missing_paths() {
        // 目标不存在时退到父目录判定，不能因此就放行
        assert!(reject_forbidden_raw(r"C:\Windows\brand-new").is_err());
        // 具体工作目录下的新目录应当放行
        assert!(reject_forbidden_raw(r"C:\Users\me\projects\brand-new").is_ok());
        assert!(reject_forbidden_raw("").is_err());
    }
}
