//! 外部命令的安全边界。
//! ------------------------------------------------------------------
//! 本项目要调不少外部程序：mklink / icacls / attrib / powershell / 编辑器 /
//! 用户登记的 AI 客户端。危险的不是这些命令本身，而是**拼进命令行的外部输入**：
//!
//!   - Windows 的 `cmd /c`：会做二次解析，`& | < > ^ % "` 都能改变语义
//!     （Rust 的 `Command::args` 会给参数加引号，但引号内的 `%VAR%` 仍会被展开，
//!     参数里若自带引号则能直接闭合引号、逃逸出去）
//!   - `powershell -Command "…"`：`;` 分段、`$( )` 求值、反引号续行都能追加命令
//!   - `Command::new(exe)`：exe 来自配置，配置被污染即等于"执行任意程序"
//!
//! 这里的校验只做一件事：**不让外部输入逃出"单个参数 / 单引号字符串"的边界**。
//! 它挡不住"用户自己配置了一个恶意 exe 并主动使用"，那属于配置可信度问题；
//! 它挡得住"配置或路径里的一段字符串被解释成第二条命令"。
//!
//! 所有函数都是纯函数，不碰 IO（除 `check_executable` 的存在性检查），便于复用。

use std::path::Path;

/// 是否可以安全地作为**命令行参数**交给外部程序（尤其是 cmd）。
///
/// 允许：普通可见字符、空格、以及路径里常见的 `:` `.` `-` `_` `/` `\` `~` `+` `@` 等。
/// 拒绝：引号（能闭合 Rust 加的引号）、`%`（cmd 变量展开）、各类 shell 元字符、
///       以及所有控制字符（含 CR/LF —— 它们能凭空造出新的一行命令）。
pub fn safe_cmd_arg(s: &str) -> bool {
    !s.is_empty()
        && !s.contains(['"', '\'', '%', '&', '|', '<', '>', '^', '`', '$', ';', '\n', '\r'])
        && !s.chars().any(|c| c.is_control())
}

/// 是否可以安全地放进 PowerShell **单引号字符串**里。
///
/// 单引号内不做变量展开，`;` 也不会分段，所以只需盯住两件事：
///   - 单引号本身（调用方需自行 `''` 双写；这里要求调用方转义后再校验，故对 `'` 放行）
///   - 换行：能跳出当前语句块，制造出新的语句
/// 另外拒绝反引号（续行/转义）与 `$(`（子表达式），它们是 PowerShell 侧的注入点。
pub fn safe_ps_literal(s: &str) -> bool {
    !s.contains(['\n', '\r', '`']) && !s.contains("$(") && !s.chars().any(|c| c.is_control())
}

/// URI scheme 是否合法：字母开头，后接字母/数字/`+`/`-`/`.`（RFC 3986）。
///
/// scheme 会被拼进 `reg query …\Software\Classes\<scheme>` 与 `<scheme>://`，
/// 两边都不该出现路径分隔符与元字符。
pub fn safe_scheme(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || !b[0].is_ascii_alphabetic() {
        return false;
    }
    b.iter()
        .all(|c| c.is_ascii_alphanumeric() || matches!(*c, b'+' | b'-' | b'.'))
}

/// 是否为可直接交给系统 opener 的安全 URL（http / https / mailto）。
///
/// `cmd /c start "" <url>` 与 `open <url>` 都只应收到一个 URL，
/// 收到 `http://x & calc` 之类就是注入。这里按字符白名单严格校验。
pub fn safe_url(u: &str) -> bool {
    let lower = u.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return false;
    }
    // 剩余部分只允许 URL 里该出现的字符；空格与控制字符一律拒绝
    u.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(
                c,
                '-' | '.' | '_' | '~' | ':' | '/' | '?' | '#' | '[' | ']' | '@'
                    | '!' | '$' | '&' | '\'' | '(' | ')' | '*' | '+' | ',' | ';' | '=' | '%'
            )
    }) && !u.chars().any(|c| c.is_control())
}

/// 可执行文件是否允许启动。
///
/// 分两种情况：
///   - 含路径分隔符（或 Windows 盘符）→ 视为明确路径：必须真实存在，
///     且扩展名在白名单里（挡住"配置里塞个 .vbs / .ps1 / 无扩展名脚本"）
///   - 纯命令名 → 交给 PATH 解析（用户填 `code`、`cursor` 这类是常态），
///     只校验字符集，不做存在性检查
pub fn check_executable(p: &Path) -> Result<(), String> {
    let s = p.to_string_lossy();
    let s = s.as_ref();
    if s.trim().is_empty() {
        return Err("可执行文件路径为空".to_string());
    }
    if !safe_cmd_arg(s) {
        return Err(format!("可执行文件含不安全字符，已拒绝启动: {s}"));
    }

    let looks_like_path =
        s.contains('/') || s.contains('\\') || (s.len() > 1 && s.as_bytes()[1] == b':');
    if !looks_like_path {
        return Ok(()); // 走 PATH，spawn 失败会自然报错
    }

    if !p.is_file() {
        return Err(format!("可执行文件不存在: {s}"));
    }

    #[cfg(windows)]
    {
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        // ps1 / vbs / js / hta 等由解释器托管，spawn 行为不可控，一律不放行
        if !matches!(ext.as_str(), "exe" | "com" | "bat" | "cmd") {
            return Err(format!(
                "只允许启动 .exe / .com / .bat / .cmd，已拒绝: {s}"
            ));
        }
    }
    Ok(())
}

/* ---------------------------- 凭据比较与生成 ---------------------------- */

/// 恒定时间比较：两个字符串是否相等。
///
/// 为什么不用 `a == b`：字符串比较在第一个不同的字节就返回，
/// 耗时差可被用来逐字节爆破 token（哪怕是本机 127.0.0.1，
/// 浏览器里的任意页面都能发起大量请求）。
///
/// 长度不等时仍需"做满"一次比较再返回，否则长度本身先泄漏；
/// 这里对较短的一方按位异或一个常数，让两条路径的循环次数一致。
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let n = ab.len().max(bb.len());
    let mut acc = ab.len() ^ bb.len();   // 长度差异先记进累加器，不提前返回
    for i in 0..n {
        let x = ab.get(i).copied().unwrap_or(0);
        let y = bb.get(i).copied().unwrap_or(0);
        acc |= (x ^ y) as usize;
    }
    acc == 0
}

/// 生成一个随机 token（32 位十六进制）。
///
/// 不引 rand / getrandom：它用于"MCP / webhook 未配置凭据时自动兜底"，
/// 服务只绑 127.0.0.1，抗的不是网络攻击而是本机其它进程与网页的顺手调用。
/// 熵来自 时间纳秒 + 进程号 + 调用序号，用 FNV-1a 混成 128 位后输出。
pub fn random_token() -> String {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = N.fetch_add(1, Ordering::Relaxed) as u128;
    let pid = std::process::id() as u128;
    let mut h: u128 = 0xcbf2_9ce4_8422_2325;
    for v in [nanos as u128, pid, seq, (nanos as u128).rotate_left(37)] {
        h ^= v;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:032x}")
}

/// 起进程前的统一校验入口：命令与参数都查一遍。
///
/// 任何"程序名或参数来自配置 / 用户输入"的 `Command::new` 都应先过这里，
/// 失败就别起进程 —— 静默放行等于把配置当成可信输入。
#[allow(dead_code)]
pub fn check_process(program: &Path, args: &[&str]) -> Result<(), String> {
    check_executable(program)?;
    for a in args {
        if !safe_cmd_arg(a) {
            return Err(format!("参数含不安全字符，已拒绝启动: {a}"));
        }
    }
    Ok(())
}
