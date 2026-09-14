//! 文件系统通用小工具（跨平台，纯 std）。
//! ------------------------------------------------------------------
//! 抽出这三件事，是因为它们此前在各处被重复实现、且每一处都实现得不完全：
//!
//!   1. **链接点判定**：统一用 `symlink_metadata`，绝不跟随链接。
//!      `path.is_dir()` 会跟随符号链接，于是"是不是目录"这个问题的答案
//!      取决于链接指向哪儿；本项目大量使用 junction / symlink（项目组链接），
//!      跟随判定既会重复拷贝，也可能顺着自指软链无限递归。
//!
//!   2. **递归遍历**：跳过链接点，并用 dev+ino（Windows 退化为规范化路径的哈希）
//!      记录已访问节点。光"跳过链接"不够：两个互为硬链接的普通目录、
//!      或绑定挂载同样能构成环，必须记录已访问集合。
//!
//!   3. **rename**：跨设备（跨卷 / 跨挂载点）时回退到"复制 + 删除"，
//!      而不是直接把失败抛给用户。
//!
//! 注意：这里只提供原语，不做任何授权判断 —— 授权是调用方（fs_op 的根目录白名单、
//! 卡片路径归属）的事，别把两类约束混在一起。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/* ---------------------------- 链接点判定 ---------------------------- */

/// 是否为链接点（Unix symlink / Windows junction 与 symlink）。
///
/// `symlink_metadata` 不跟随链接，因此链接指向的目标不存在也能正确识别
/// —— 断链恰恰是最需要识别出来的场景。
pub fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// 是否为"真实目录"（不跟随符号链接）。
pub fn is_real_dir(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false)
}

/// 是否为"真实文件"（不跟随符号链接）。
#[allow(dead_code)]
pub fn is_real_file(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_file())
        .unwrap_or(false)
}

/* ---------------------------- 递归遍历的环路保护 ---------------------------- */

/// Unix：设备号 + inode 唯一标识一个目录节点。
#[cfg(unix)]
fn node_id(p: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::symlink_metadata(p).ok()?;
    Some((m.dev(), m.ino()))
}

/// 非 Unix：拿不到稳定的 inode 号，退化为规范化路径的 FNV-1a 哈希。
/// 规范化会解析链接与 `..`，同一目录的不同写法会落到同一个 key。
#[cfg(not(unix))]
fn node_id(p: &Path) -> Option<(u64, u64)> {
    let c = p.canonicalize().ok()?;
    let s = c.to_string_lossy().to_lowercase();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    Some((0, h))
}

/// 递归遍历时的"已访问"记录。
///
/// 用法：进入每个目录前先 `visit`，返回 false 说明这个节点已经走过，应当跳过。
/// 每次新的遍历都要新建一个实例 —— 它是单次遍历的状态，不是全局缓存。
pub struct WalkGuard {
    seen: HashSet<(u64, u64)>,
}

impl WalkGuard {
    pub fn new() -> Self {
        Self { seen: HashSet::new() }
    }

    /// 记录并判断是否首次访问。拿不到节点号时放行（总比漏掉内容好）。
    pub fn visit(&mut self, p: &Path) -> bool {
        match node_id(p) {
            Some(id) => self.seen.insert(id),
            None => true,
        }
    }

    /// 底层集合大小（诊断 / 测试用）。
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.seen.len()
    }

    /// 在外部持有的集合上标记并判断是否首次访问。
    ///
    /// 给那些把"已访问集合"作为参数在递归里传递的调用方用（如 backup 的
    /// collect_source）—— 它们没法把整个遍历装进一个 WalkGuard 实例。
    pub fn mark(seen: &mut HashSet<(u64, u64)>, p: &Path) -> bool {
        match node_id(p) {
            Some(id) => seen.insert(id),
            None => true,
        }
    }
}

impl Default for WalkGuard {
    fn default() -> Self {
        Self::new()
    }
}

/* ---------------------------- 递归拷贝 ---------------------------- */

/// 递归拷贝目录树：跳过链接点、带环路保护。
///
/// 链接点一律不复制也不深入 —— 与备份策略一致：本项目用链接把项目组挂到项目下，
/// 复制链接内容既会重复占用空间，也可能绕回自身。
pub fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    let mut guard = WalkGuard::new();
    copy_tree_inner(src, dst, &mut guard)
}

fn copy_tree_inner(src: &Path, dst: &Path, guard: &mut WalkGuard) -> Result<(), String> {
    if !guard.visit(src) {
        return Ok(()); // 环：这个节点已经在本次遍历里处理过
    }
    if is_real_dir(src) {
        fs::create_dir_all(dst)
            .map_err(|e| format!("创建目录失败 {}: {e}", dst.display()))?;
        let rd = fs::read_dir(src).map_err(|e| format!("读取目录失败 {}: {e}", src.display()))?;
        for entry in rd.flatten() {
            let s = entry.path();
            if is_link(&s) {
                continue;
            }
            copy_tree_inner(&s, &dst.join(entry.file_name()), guard)?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("创建父目录失败 {}: {e}", parent.display()))?;
            }
        }
        fs::copy(src, dst)
            .map_err(|e| format!("复制失败 {} → {}: {e}", src.display(), dst.display()))?;
        Ok(())
    }
}

/// 递归删除目录树（链接点不深入，只删链接自身；带环路保护）。
#[allow(dead_code)]
pub fn remove_tree(path: &Path) -> Result<(), String> {
    if is_link(path) || !is_real_dir(path) {
        return fs::remove_file(path).map_err(|e| format!("删除失败 {}: {e}", path.display()));
    }
    let mut guard = WalkGuard::new();
    remove_tree_inner(path, &mut guard)
}

#[allow(dead_code)]
fn remove_tree_inner(path: &Path, guard: &mut WalkGuard) -> Result<(), String> {
    if !guard.visit(path) {
        return Ok(());
    }
    if is_link(path) || !is_real_dir(path) {
        return fs::remove_file(path).map_err(|e| format!("删除失败 {}: {e}", path.display()));
    }
    let rd = fs::read_dir(path).map_err(|e| format!("读取目录失败 {}: {e}", path.display()))?;
    for entry in rd.flatten() {
        let p = entry.path();
        if is_real_dir(&p) && !is_link(&p) {
            remove_tree_inner(&p, guard)?;
        } else {
            let _ = fs::remove_file(&p);
        }
    }
    fs::remove_dir(path).map_err(|e| format!("删除目录失败 {}: {e}", path.display()))
}

/* ---------------------------- rename 与跨设备回退 ---------------------------- */

/// EXDEV（Unix 跨挂载点）
#[cfg(not(windows))]
const CROSS_DEVICE_OS_ERROR: i32 = 18;
/// ERROR_NOT_SAME_DEVICE（Windows 跨卷）
#[cfg(windows)]
const CROSS_DEVICE_OS_ERROR: i32 = 17;

/// 失败原因是否为"跨设备"。
///
/// 不用 `ErrorKind::CrossesDevices`：它在 Rust 1.83 才稳定，
/// 而本项目 `rust-version = 1.77.2`，用了就是硬编译错误。
/// errno 数字在两类平台上都是几十年不变的稳定值，直接比对即可。
fn is_cross_device(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(CROSS_DEVICE_OS_ERROR)
}

/// 移动（重命名）文件或目录；跨设备时自动回退到"复制 + 删除"。
///
/// **失败语义很重要**：复制没成功之前绝不删源 —— 宁可原地不动，也不冒搬丢的风险。
/// 复制成功但删源失败时返回 Err，此时两份数据都在，交由用户手动清理
/// （错误信息里写明具体路径，不说"请自行处理"这种废话）。
pub fn rename_with_fallback(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            if let Some(parent) = dst.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent)
                        .map_err(|pe| format!("创建目标父目录失败 {}: {pe}", parent.display()))?;
                }
            }
            if is_real_dir(src) {
                copy_tree(src, dst).map_err(|ce| {
                    format!("跨设备复制未完成，源目录保持原样（{}）: {ce}", src.display())
                })?;
                fs::remove_dir_all(src).map_err(|de| {
                    format!(
                        "已复制到 {}，但删除源目录失败，请手动删除 {}: {de}",
                        dst.display(),
                        src.display()
                    )
                })?;
            } else {
                fs::copy(src, dst).map_err(|ce| {
                    format!("跨设备复制未完成，源文件保持原样（{}）: {ce}", src.display())
                })?;
                fs::remove_file(src).map_err(|de| {
                    format!(
                        "已复制到 {}，但删除源文件失败，请手动删除 {}: {de}",
                        dst.display(),
                        src.display()
                    )
                })?;
            }
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// 用文件覆盖目标（临时文件落盘的最后一跳）。
///
/// 与 `rename_with_fallback` 的区别：这里的目标是"覆盖"，源是临时文件，
/// 删不掉也无所谓（留在目录里只是垃圾，不影响正确性），所以删源失败不报错。
/// 用移动语义的函数反而会在"其实已经成功"的情况下误报失败。
pub fn replace_file(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            if let Some(parent) = dst.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent)
                        .map_err(|pe| format!("创建父目录失败 {}: {pe}", parent.display()))?;
                }
            }
            fs::copy(src, dst).map_err(|ce| {
                format!("复制 {} → {} 失败: {ce}", src.display(), dst.display())
            })?;
            let _ = fs::remove_file(src);
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// 是否为"根"（文件系统根或盘符根）。授权/删除类判断里通常要排除。
#[allow(dead_code)]
pub fn is_root(p: &Path) -> bool {
    p.parent().is_none()
}

/// 便于调用方打印：把路径统一成正斜杠形式。
#[allow(dead_code)]
pub fn display_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// 拼接两个路径段（保留 PathBuf 语义，避免手写 format! 拼出重复分隔符）。
#[allow(dead_code)]
pub fn join(base: &Path, name: &str) -> PathBuf {
    base.join(name)
}
